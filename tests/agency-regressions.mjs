import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-agency-regressions-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.OPENAI_API_KEY = 'test-only-never-sent'
process.env.OPENAI_BASE_URL = 'https://model.invalid/v1'
const originalFetch = globalThis.fetch
let calls = 0
let answer = async () => { throw new Error('Unexpected model call') }
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://model.invalid/v1/chat/completions', 'tests never access a live provider')
  calls++
  const json = await answer(JSON.parse(options.body))
  return Response.json({ choices: [{ message: { content: JSON.stringify(json) } }] })
}

try {
  const { saveConfig, P } = await import('../lib/config.mjs')
  const { writeJSON, readJSON } = await import('../lib/util.mjs')
  const { mutateState, mutateConversation, createConversation, appendMessage, getConversation } = await import('../lib/store.mjs')
  const { inQuietHours, checkAttention, reserveAttention, finishAttention, interventionKeys } = await import('../lib/attention.mjs')
  const { applyFeedback, posteriors, settlePending, agencyStats } = await import('../lib/agency.mjs')
  const { proactiveTick, proactiveStatus, recordUserEngagement } = await import('../lib/proactive.mjs')
  const { createCommitment } = await import('../lib/commitments.mjs')
  const { ingestFrame } = await import('../lib/companion.mjs')
  const { workingContext } = await import('../lib/screen.mjs')
  const now = () => new Date().toISOString()
  const freshUntil = () => new Date(Date.now() + 3600000).toISOString()
  await saveConfig({
    upstream: { defaultModel: 'mock', utilityModel: 'mock' },
    attention: { dailyBudget: 20, minGapSeconds: 75 },
    proactive: { enabled: true, notify: false, quietHours: { start: '00:00', end: '00:00' } },
    companion: { enabled: true, minTextChars: 10, minGapSeconds: 20 },
    screen: { enabled: true },
  })
  const screenFile = path.join(sandbox, 'memory', 'working.jsonl')
  await fs.mkdir(path.dirname(screenFile), { recursive: true })
  const screen = async (focus, ageMinutes = 0) => {
    await fs.writeFile(screenFile, JSON.stringify({
      id: 'screen_test', ts: new Date(Date.now() - ageMinutes * 60000).toISOString(),
      app: 'Editor', activity: 'Preparing the project', topic: 'project', focus, sensitive: false,
    }) + '\n')
  }
  const reset = async (state = {}) => {
    await writeJSON(P.state, state)
    await fs.writeFile(screenFile, '')
  }
  const at = (hour, minute = 0) => new Date(2026, 0, 2, hour, minute).getTime()
  assert.equal(inQuietHours(at(13), { start: '12:00', end: '14:00' }), true)
  assert.equal(inQuietHours(at(9), { start: '12:00', end: '14:00' }), false)
  assert.equal(inQuietHours(at(15), { start: '12:00', end: '14:00' }), false)
  assert.equal(inQuietHours(at(23), { start: '22:00', end: '08:00' }), true)
  assert.equal(inQuietHours(at(7), { start: '22:00', end: '08:00' }), true)
  assert.equal(inQuietHours(at(12), { start: '22:00', end: '08:00' }), false)
  assert.equal(inQuietHours(at(12), { start: '12:00', end: '12:00' }), false)

  await reset()
  await screen('meeting')
  assert.equal((await checkAttention()).reason, 'focus_meeting')
  assert.equal((await workingContext()).freshness, 'fresh')
  await screen('deep', 25)
  assert.equal((await workingContext()).freshness, 'stale')
  assert.equal((await checkAttention()).allow, true, 'historical focus does not masquerade as current activity')
  await reset()
  const reservations = await Promise.all([
    reserveAttention({ channel: 'proactive', fingerprint: 'one' }),
    reserveAttention({ channel: 'companion', fingerprint: 'two' }),
  ])
  assert.equal(reservations.filter((r) => r.allow).length, 1, 'concurrent channels share one atomic reservation')
  await finishAttention(reservations.find((r) => r.allow).token)
  assert.equal((await checkAttention({ channel: 'companion' })).reason, 'shared_min_gap')
  await saveConfig({ attention: { dailyBudget: 1, minGapSeconds: 0 } })
  assert.equal((await checkAttention()).reason, 'shared_daily_budget')
  await saveConfig({ attention: { dailyBudget: 20, minGapSeconds: 75 } })

  await reset({ proactive: { history: [{ at: new Date(Date.now() - 7 * 3600000).toISOString(), kind: 'ask' }] } })
  const before = await posteriors()
  await recordUserEngagement('main')
  assert.deepEqual((await posteriors()).kinds, before.kinds, 'an unrelated main-chat message is not positive feedback')
  assert.equal((await readJSON(P.state)).proactive.history[0].replied, undefined)
  assert.equal((await settlePending()).settled, 1)
  assert.deepEqual((await posteriors()).kinds, before.kinds, 'silence never penalizes a kind')
  assert.equal((await readJSON(P.state)).proactive.history[0].outcome.signal, 'unknown')

  await createConversation({ isMain: true })
  await appendMessage('main', { id: 'm_feedback', proactive: true, role: 'assistant', kind: 'ask', content: 'A useful question' })
  const feedback = (signal, rest = {}) => applyFeedback({ signal, conversationId: 'main', messageId: 'm_feedback', ...rest })
  await feedback('good')
  const good = (await posteriors()).kinds.ask
  await feedback('good')
  assert.deepEqual((await posteriors()).kinds.ask, good, 'repeated feedback is idempotent')
  await feedback('bad')
  assert.equal((await posteriors()).kinds.ask.a, 1.6)
  await feedback('good')
  assert.deepEqual((await posteriors()).kinds.ask, good, 'users can correct good→bad→good')
  await feedback('wrong_time')
  assert.deepEqual((await posteriors()).kinds.ask, good, 'timing feedback does not punish utility')
  assert.equal((await checkAttention()).reason, 'wrong_time_pause')
  assert.equal((await agencyStats()).outcomes.wrong_time, 1)
  assert.equal((await applyFeedback({ signal: 'good', kind: 'ask' })).ignored, 'missing_intervention')
  await reset({ agency: { kinds: { ask: { a: 90, b: 12 } } } })
  assert.deepEqual((await posteriors()).kinds.ask, { a: 1.6, b: 1.6 }, 'legacy engagement rewards do not bias explicit utility learning')
  await feedback('good')
  const migrated = (await readJSON(P.state)).agency
  assert.equal(migrated.learningVersion, 2)
  assert.deepEqual(migrated.legacyKinds.ask, { a: 90, b: 12 }, 'legacy history is preserved separately')
  assert.deepEqual(migrated.kinds.ask, { a: 2.6, b: 1.6 })

  const goal = { id: 'goal_test', status: 'active', revision: 1, title: 'Prepare project', preparation: {} }
  const preparation = {
    id: 'prep_test', commitmentId: goal.id, revision: 1, title: 'Project checklist', content: 'Two grounded steps are ready.',
    evidence: [{ id: 'ev_test', label: 'User request', source: 'message:main:req', observedAt: now(), excerpt: 'Prepare the project checklist' }],
    verification: { passed: true, checks: [] }, createdAt: now(), delivery: { status: 'pending', expiresAt: freshUntil() },
  }
  await reset({ commitments: [goal], preparations: [preparation] })
  await screen('meeting')
  const queued = await proactiveTick()
  assert.equal(queued.skipped, 'focus_meeting')
  assert.equal((await readJSON(P.state)).proactive.queue[0].preparationId, preparation.id)
  assert.equal(calls, 0, 'verified preparations are delivered without asking another model')
  await screen('normal')
  const delivered = await proactiveTick()
  assert.equal(delivered.acted, true)
  assert.equal(delivered.daily, 1)
  assert.equal(delivered.message.preparationId, preparation.id)
  assert.equal(delivered.message.evidence[0].id, 'ev_test')
  assert.equal((await readJSON(P.state)).preparations[0].delivery.status, 'delivered')
  assert.equal((await readJSON(P.state)).commitments[0].status, 'active', 'delivering a preparation does not complete a goal')
  const count = (await getConversation('main')).messages.length
  await proactiveTick()
  assert.equal((await getConversation('main')).messages.length, count, 'a prepared artifact is delivered once')
  await applyFeedback({ signal: 'accepted', preparationId: preparation.id })
  const accepted = (await posteriors()).kinds.brief
  await applyFeedback({ signal: 'completed', preparationId: preparation.id })
  assert.deepEqual((await posteriors()).kinds.brief, accepted, 'accepted→completed contributes one success')
  assert.equal((await readJSON(P.state)).commitments[0].status, 'active')
  assert.equal((await applyFeedback({ signal: 'incorrect', preparationId: preparation.id, commitmentId: 'goal_wrong' })).ignored, 'mismatched_commitment')
  await reset({ commitments: [goal], preparations: [preparation] })
  await screen('meeting')
  await proactiveTick()
  await applyFeedback({ signal: 'wrong_time', preparationId: preparation.id })
  assert.equal((await readJSON(P.state)).preparations[0].delivery.status, 'pending', 'timing feedback only defers an unread artifact')
  await applyFeedback({ signal: 'accepted', preparationId: preparation.id })
  assert.equal((await readJSON(P.state)).preparations[0].delivery.status, 'reviewed')
  const beforeReviewedTick = (await getConversation('main')).messages.length
  await proactiveTick()
  assert.equal((await readJSON(P.state)).proactive.queue.length, 0, 'an artifact reviewed in the panel is removed from queued notifications')
  assert.equal((await getConversation('main')).messages.length, beforeReviewedTick)

  const loop = { id: 'loop_test', touched_at: new Date().toLocaleDateString('en-CA'), topic: 'Project proposal', why: 'User mentioned a project deadline', status: 'open', confidence: 0.8 }
  const goodDecision = { quote: 'proposal', act: true, confidence: 0.99, kind: 'follow_up', anchor_id: loop.id, evidence_ids: [loop.id], message: 'The proposal deadline is approaching; the checklist can help.', reason: 'User project evidence' }
  await reset({ dream: { loops: [loop] } })
  answer = async () => ({ message: null })
  const beforeQuiet = calls
  assert.equal((await proactiveTick()).skipped, 'composer_abstained')
  assert.equal((await proactiveTick()).skipped, 'unchanged_context')
  assert.equal(calls, beforeQuiet + 1, 'unchanged evidence after an abstention needs no wording call')
  await mutateState((s) => { s.dream.loops[0].due = '2026-12-01' })
  assert.equal((await proactiveTick()).skipped, 'composer_abstained')
  assert.equal(calls, beforeQuiet + 2, 'a changed deadline is new evidence')
  await reset({ dream: { loops: [loop] } })
  answer = async (body) => {
    const selected = JSON.parse(body.messages.at(-1).content)
    assert.equal(selected.kind, 'follow_up')
    assert.equal(selected.topic, loop.topic)
    return { ...goodDecision, act: false, kind: 'ask', confidence: 0, anchor_id: 'forged', evidence_ids: ['forged'] }
  }
  const forced = await proactiveTick()
  assert.equal(forced.message.kind, 'follow_up')
  assert.equal(forced.message.anchorId, loop.id)
  assert.equal(forced.message.evidence[0].id, loop.id)
  assert.ok(forced.message.selection.score > 0)
  assert.equal(forced.message.confidence, undefined)
  await reset({ dream: { loops: [loop] } })
  await screen('normal')
  answer = async () => { await screen('deep'); return goodDecision }
  const deferred = await proactiveTick()
  assert.equal(deferred.skipped, 'focus_deep', 'focus is rechecked after the model awaits')
  assert.equal((await readJSON(P.state)).proactive.queue.length, 1)
  const callsBeforeDelivery = calls
  await screen('normal')
  assert.equal((await proactiveTick()).acted, true)
  assert.equal(calls, callsBeforeDelivery, 'the queued candidate is reused after a focus transition')
  const keys = interventionKeys({ content: 'A reworded version', anchorId: loop.id, evidence: [{ source: `dream:${loop.id}`, excerpt: `${loop.topic}；${loop.why}；截止 未知` }] })
  assert.equal((await checkAttention({ ...keys })).reason, 'unchanged_evidence')
  await mutateState((s) => {
    s.proactive.queue = [{ id: 'expired', messageId: 'm_expired', expiresAt: new Date(Date.now() - 1).toISOString(), content: 'Stale advice' }]
  })
  await proactiveTick()
  assert.equal((await readJSON(P.state)).proactive.queue.length, 0, 'stale candidates expire')

  await reset({ dream: { loops: [loop] } })
  answer = async () => ({ ...goodDecision, quote: 'unavailable quotation' })
  assert.equal((await proactiveTick()).skipped, 'unsupported_evidence')
  const queuedEvidence = [{ id: loop.id, source: `dream:${loop.id}`, excerpt: `${loop.topic}；${loop.why}；截止 未知` }]
  const validQueued = {
    id: 'candidate_valid', messageId: 'm_valid_queued', kind: 'follow_up', content: 'A valid prepared follow-up with current evidence',
    evidence: queuedEvidence, anchorId: loop.id, createdAt: now(), expiresAt: freshUntil(),
    ...interventionKeys({ content: 'A valid prepared follow-up with current evidence', anchorId: loop.id, evidence: queuedEvidence }),
  }
  await reset({ dream: { loops: [loop] }, proactive: { queue: [
    { ...validQueued, id: 'candidate_stale', messageId: 'm_stale_queued', evidence: [{ source: 'missing', id: 'gone' }] },
    validQueued,
  ] } })
  assert.equal((await proactiveTick()).message?.id, 'm_valid_queued', 'an invalid first candidate cannot starve a valid queued result')
  await reset({ dream: { loops: [loop] } })
  answer = async () => {
    await mutateState((s) => { s.dream.loops[0].status = 'done' })
    return goodDecision
  }
  assert.equal((await proactiveTick()).skipped, 'stale_evidence', 'completed follow-ups cannot be delivered using a model snapshot')
  await reset({ dream: { loops: [loop] } })
  let releaseWrite
  let locked
  const writeStarted = new Promise((resolve) => { locked = resolve })
  const writeBlocked = new Promise((resolve) => { releaseWrite = resolve })
  const holdingWrite = mutateConversation('main', async () => { locked(); await writeBlocked })
  await writeStarted
  answer = async () => goodDecision
  const waitingDelivery = proactiveTick()
  try {
    for (let i = 0; i < 100; i++) {
      if ((await readJSON(P.state)).attention?.history?.some((h) => h.status === 'reserved')) break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.ok((await readJSON(P.state)).attention?.history?.some((h) => h.status === 'reserved'))
    await screen('meeting')
  } finally {
    releaseWrite()
  }
  await holdingWrite
  assert.equal((await waitingDelivery).skipped, 'focus_meeting', 'a queued conversation write checks attention again at commit')
  assert.equal((await readJSON(P.state)).attention.history.length, 0, 'cancelled delivery refunds its reservation')
  await reset({ dream: { loops: [loop] } })
  answer = async () => { await saveConfig({ proactive: { enabled: false } }); return goodDecision }
  assert.equal((await proactiveTick()).skipped, 'disabled', 'disabling during model work prevents delivery')
  await saveConfig({ proactive: { enabled: true } })

  await reset()
  answer = async () => {
    await screen('meeting')
    return { speak: true, quote: 'deadline', bubble: 'A concrete useful companion suggestion' }
  }
  const frame = { text: 'The project plan contains a deadline and a checklist of remaining work.', app: 'Editor', title: 'Project', hidIdleSeconds: 1 }
  assert.equal((await ingestFrame(frame)).skipped, 'focus_meeting', 'companion also rechecks focus after its model call')
  await screen('normal')
  answer = async () => ({ speak: true, quote: 'deadline', bubble: 'A concrete useful companion suggestion' })
  assert.ok((await ingestFrame(frame)).bubble, 'deferred frame can be retried after focus changes')
  assert.equal((await checkAttention({ channel: 'proactive' })).reason, 'shared_min_gap')

  // Dream 线索 → 主动消息携带一键接管提案；用户确认后才创建跟进
  await reset({ dream: { at: now(), loops: [{ id: 'loop_visa', topic: '签证预约', why: '注册受阻，等待确认', due: '2026-12-01', status: 'open', confidence: 0.8 }] } })
  answer = async () => ({
    act: true, confidence: 0.9, kind: 'follow_up', anchor_id: 'loop_visa', evidence_ids: ['loop_visa'],
    quote: '签证预约', message: '你提过签证预约还在等确认，要不要我接着盯？', reason: 'Dream 发现的待跟进线索',
  })
  const suggestion = await proactiveTick()
  assert.equal(suggestion.acted, true)
  assert.equal(suggestion.message.followUp.title, '签证预约')
  assert.equal(suggestion.message.followUp.deadline, '2026-12-01')
  assert.equal(suggestion.message.followUp.candidateLoopId, 'loop_visa')
  assert.match(suggestion.message.followUp.successCriteria, /签证预约/)
  assert.match(suggestion.message.content, /加入跟进/)
  const adopted = await createCommitment({
    title: suggestion.message.followUp.title,
    successCriteria: suggestion.message.followUp.successCriteria,
    deadline: suggestion.message.followUp.deadline,
    candidateLoopId: suggestion.message.followUp.candidateLoopId,
  })
  assert.equal(adopted.candidateLoopId, 'loop_visa')
  await assert.rejects(createCommitment({ title: 'duplicate', successCriteria: 'x', candidateLoopId: 'loop_visa' }), { status: 409 })
  const persisted = (await getConversation('main')).messages.find((message) => message.id === suggestion.message.id)
  assert.equal(persisted.followUp.candidateLoopId, 'loop_visa')

  const { contentFeedback, contentTopicKey, setTopicMute } = await import('../lib/agency.mjs')
  await reset({ dream: { at: now(), loops: [loop] } })
  const mutedKey = contentTopicKey('proactive', loop.topic)
  answer = async () => {
    await setTopicMute(mutedKey, { label: loop.topic })
    return goodDecision
  }
  assert.equal((await proactiveTick()).skipped, 'topic_muted', 'muting an in-flight topic prevents publication')
  assert.equal((await readJSON(P.state)).proactive.queue.length, 0)
  const requestedDraft = { ...preparation, trigger: 'requested' }
  await reset({ commitments: [{ ...goal, title: loop.topic }], preparations: [requestedDraft], agency: { mutedTopics: { [mutedKey]: {} } } })
  const callsBeforeDraft = calls
  assert.equal((await proactiveTick()).message?.preparationId, preparation.id, 'requested work on a muted topic still delivers')
  assert.equal(calls, callsBeforeDraft)
  const fixtureNow = Date.now()
  const oldVote = { reward: 0, kind: 'suggest', utilityAt: new Date(fixtureNow - 90 * 86400000).toISOString() }
  const aggregate = { agency: { learningVersion: 2, kinds: { suggest: { a: 1.6, b: 11.6 } }, outcomes: { oldVote } } }
  assert.equal(contentFeedback(aggregate, { kind: 'suggest', now: fixtureNow }).kindVotes, 1)
  assert.equal(contentFeedback(aggregate, { kind: 'suggest', now: fixtureNow + 1 }).kindVotes, 0,
    'an expired attributable vote cannot resurrect the lifetime aggregate')
  assert.equal(contentFeedback({ agency: { ...aggregate.agency, outcomes: {} } }, { kind: 'suggest', now: fixtureNow }).kindVotes, 10,
    'aggregate-only explicit feedback remains usable on older profiles')
  const { appendObservation } = await import('../lib/memory.mjs')
  const otherTopic = { id: 'nudge_watch', topic: 'Other grounded topic', why: 'An explicit project dependency', urgency: 5, at: now() }
  const setTopics = async () => reset({ dream: { at: now(), loops: [loop], nudges: [otherTopic] } })
  await setTopics()
  const preview = () => proactiveStatus().then((status) => status.nextGate)
  const startCalls = calls
  const initial = (await preview()).selection
  assert.equal(initial.anchorId, loop.id)
  assert.deepEqual((await preview()).selection, initial, 'the same inputs produce the same score and choice')
  const previous = { id: 'm_prior_topic', kind: 'follow_up', proactive: true, anchorId: loop.id, createdAt: now(),
    role: 'assistant', selection: initial, content: 'Older phrasing' }
  await appendMessage('main', previous)
  const vote = (signal) => applyFeedback({ signal, conversationId: 'main', messageId: previous.id, kind: 'forged' })
  await vote('bad')
  assert.equal((await preview()).selection.anchorId, otherTopic.id, 'a declined first topic yields to the next eligible topic')
  await vote('good')
  const corrected = (await preview()).selection
  assert.equal(corrected.anchorId, loop.id)
  assert.ok(corrected.score > initial.score)
  assert.equal(calls, startCalls)
  await mutateState((s) => {
    s.dream.loops[0].id = 'loop_reassigned'
    s.dream.loops[0].topic = 'PROJECT proposal!'
  })
  const regenerated = (await preview()).selection
  assert.equal(regenerated.anchorId, 'loop_reassigned')
  assert.equal(regenerated.topicKey, contentTopicKey('proactive', 'Project proposal'))
  assert.ok(regenerated.reasons.includes('你曾肯定这个话题'), 'topic preferences survive a regenerated source ID')
  answer = async (request) => {
    const payload = JSON.parse(request.messages.at(-1).content)
    assert.equal(payload.evidence.length, 1)
    assert.doesNotMatch(JSON.stringify(request), /Other grounded topic|Older phrasing/)
    return { message: 'PROJECT proposal! 可以继续核对。', quote: 'PROJECT', anchor_id: otherTopic.id, confidence: 1, kind: 'brief' }
  }
  const normal = await proactiveTick()
  assert.deepEqual(normal.message.selection, regenerated)
  assert.equal(normal.message.kind, 'follow_up')
  assert.equal(normal.message.evidence[0].id, regenerated.anchorId)
  await mutateState((s) => {
    s.attention.history[0].at = new Date(Date.now() - 3 * 3600000).toISOString()
    delete s.proactive.lastAt
    s.dream.nudges = []
    s.dream.loops[0].id = 'loop_reassigned_again'
  })
  const beforeDuplicate = calls
  assert.equal((await proactiveTick()).skipped, 'unchanged_evidence')
  assert.equal(calls, beforeDuplicate, 'unchanged material with a regenerated ID incurs zero requests')

  // A verified but speculative result may be too weak for this user. The draft remains readable.
  const lowGoal = { ...goal, title: 'Unadopted background draft', origin: 'discovered', discovery: { adopted: false, expiresAt: freshUntil() } }
  await reset({ commitments: [lowGoal], preparations: [preparation], dream: { at: now(), loops: [loop] },
    agency: { learningVersion: 2, kinds: { brief: { a: 1.6, b: 18.6 } } } })
  assert.equal((await preview()).selection.anchorId, loop.id)
  answer = async () => goodDecision
  assert.equal((await proactiveTick()).message.anchorId, loop.id)
  assert.equal((await readJSON(P.state)).preparations[0].delivery.status, 'pending')
  await reset({ commitments: [lowGoal], preparations: [preparation], agency: { learningVersion: 2, kinds: { brief: { a: 1.6, b: 18.6 } } } })
  const beforeFloor = calls
  assert.equal((await preview()).reason, 'below_threshold')
  assert.equal((await proactiveTick()).skipped, 'below_threshold')
  assert.equal(calls, beforeFloor)

  await reset({ dream: { at: now(), loops: [{ ...loop, touched_at: '2001-01-01' }] } })
  assert.equal((await proactiveTick()).skipped, 'no_material')
  assert.equal(calls, beforeFloor, 'stale source is filtered before composition')
  await reset()
  const fact = await appendObservation({ kind: 'project', importance: 5, source: 'fixture', text: 'Private Aurora migration project.' })
  await saveConfig({ memory: { enabled: true, inject: true } })
  assert.equal((await preview()).selection.anchorId, fact.id)
  answer = async () => { await saveConfig({ memory: { inject: false } }); return { message: 'Aurora still has a draft.', quote: 'Aurora' } }
  assert.equal((await proactiveTick()).skipped, 'stale_evidence', 'revoked memory cannot persist in a draft or proactive message')
  assert.equal((await readJSON(P.state)).proactive.queue.length, 0)
  const beforeRevoked = calls
  assert.equal((await proactiveTick()).skipped, 'no_material')
  assert.equal(calls, beforeRevoked)
  assert.doesNotMatch(JSON.stringify(await proactiveStatus()), /Aurora/)

  await saveConfig({ memory: { enabled: true, inject: true } })
  answer = async () => ({ message: 'Aurora has a migration draft.', quote: 'Aurora' })
  assert.equal((await proactiveTick()).message?.selection.anchorId, fact.id)
  await saveConfig({ memory: { inject: false } })
  assert.doesNotMatch(JSON.stringify(await proactiveStatus()), /Aurora/, 'revoked history and selection previews no longer expose source wording')

  await reset({ dream: { at: now(), loops: [loop], nudges: [otherTopic] } })
  const feedbackFrom = async (id, kind, label, signal) => {
    const selection = { source: 'nudge', kind, anchorId: id, topicKey: contentTopicKey('proactive', label), label }
    await appendMessage('main', { id, kind, selection, role: 'assistant', proactive: true, createdAt: now() })
    await applyFeedback({ signal, conversationId: 'main', messageId: id })
  }
  await feedbackFrom('m_other_followup', 'follow_up', 'Unrelated project', 'bad')
  await feedbackFrom('m_other_suggest', 'suggest', 'Another dependency', 'good')
  assert.equal((await preview()).selection.anchorId, otherTopic.id, 'explicit kind preferences transfer to unfamiliar topics')
  await feedbackFrom('m_earlier_topic', 'ask', loop.topic, 'good')
  await feedbackFrom('m_earlier_nudge', 'ask', otherTopic.topic, 'bad')
  assert.equal((await preview()).selection.anchorId, loop.id, 'opposing topic preferences transfer across kinds and source IDs')
  const old = new Date(Date.now() - 120000).toISOString()
  await reset({ dream: { at: now(), loops: [loop] }, attention: { history: [
    { id: 'old_reservation', status: 'reserved', at: old, anchorKey: keys.anchorKey },
  ] } })
  assert.equal((await preview()).selection.anchorId, loop.id, 'an abandoned reservation is refunded in both ranking and timing')
  await reset({ commitments: [goal], preparations: [preparation], dream: { at: now(), loops: [loop] } })
  await screen('meeting')
  await proactiveTick()
  const blockedPrep = (await readJSON(P.state)).proactive.queue[0]
  await mutateState((s) => { s.attention = { history: [{ id: 'previous', at: old, status: 'delivered', fingerprint: blockedPrep.fingerprint }] } })
  await screen('normal')
  assert.equal((await preview()).selection.anchorId, loop.id, 'an already sent draft cannot hide another actionable source')
  answer = async () => goodDecision
  assert.equal((await proactiveTick()).message?.anchorId, loop.id)
  await reset({ dream: { loops: [loop] } })
  answer = async () => { throw new Error('Fixture composer unavailable') }
  const failedAt = calls
  assert.equal((await proactiveTick()).skipped, 'composer_error')
  assert.equal((await proactiveStatus()).lastDecision.wording, 'error')
  assert.equal((await proactiveTick()).skipped, 'unchanged_context')
  assert.equal(calls, failedAt + 1, 'a composer failure observes bounded backoff')
  console.log('Agency regressions passed: explicit outcome attribution; shared atomic attention; fresh evidence; deferred and once-only delivery; loop suggestions adopt on confirm; no live requests.')
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
