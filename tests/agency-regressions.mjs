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
  const { proactiveTick, recordUserEngagement } = await import('../lib/proactive.mjs')
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

  const loop = { id: 'loop_test', topic: 'Project proposal', why: 'User mentioned a project deadline', status: 'open', confidence: 0.8 }
  const goodDecision = { act: true, confidence: 0.99, kind: 'follow_up', anchor_id: loop.id, evidence_ids: [loop.id], message: 'The proposal deadline is approaching; the checklist can help.', reason: 'User project evidence' }
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
  answer = async () => ({ ...goodDecision, evidence_ids: ['invented'] })
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
    return { speak: true, scenario: 'work', topic: 'Project', bubble: 'A concrete useful companion suggestion', why: 'Visible project data' }
  }
  const frame = { text: 'The project plan contains a deadline and a checklist of remaining work.', app: 'Editor', title: 'Project', hidIdleSeconds: 1 }
  assert.equal((await ingestFrame(frame)).skipped, 'focus_meeting', 'companion also rechecks focus after its model call')
  await screen('normal')
  answer = async () => ({ speak: true, scenario: 'work', topic: 'Project', bubble: 'A concrete useful companion suggestion', why: 'Visible project data' })
  assert.ok((await ingestFrame(frame)).bubble, 'deferred frame can be retried after focus changes')
  assert.equal((await checkAttention({ channel: 'proactive' })).reason, 'shared_min_gap')
  console.log('Agency regressions passed: explicit outcome attribution; shared atomic attention; fresh evidence; deferred and once-only delivery; no live requests.')
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
