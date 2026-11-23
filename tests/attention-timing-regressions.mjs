import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-timing-'))
process.env.ECHO_DATA_DIR = dir
process.env.ECHO_CONFIG = path.join(dir, 'config.json')
process.env.OPENAI_API_KEY = 'fixture'
process.env.OPENAI_BASE_URL = 'https://timing.invalid/v1'
process.env.TZ = 'America/New_York'
const at = (local) => new Date(local).getTime()
mock.timers.enable({ apis: ['Date'], now: at('2026-10-31T22:15:00') })
const clock = (local) => mock.timers.setTime(at(local))
const fetchBefore = globalThis.fetch
let calls = 0
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://timing.invalid/v1/chat/completions')
  calls++
  if (JSON.parse(options.body).stream) {
    return new Response('data: {"choices":[{"delta":{"content":"Fixture."}}]}\n\ndata: [DONE]\n\n')
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify({
    speak: true, scenario: 'work', topic: 'Fixture', bubble: 'Review this meeting agenda.', why: 'The screen shows an agenda.',
  }) } }] })
}

try {
  const { saveConfig } = await import('../lib/config.mjs')
  const { readState, writeState, mutateState, createConversation, appendMessage } = await import('../lib/store.mjs')
  const { checkAttention, preparationTrigger } = await import('../lib/attention.mjs')
  const { applyFeedback } = await import('../lib/agency.mjs')
  const { ingestFrame, pendingBubbles, dismissBubble, openBubble } = await import('../lib/companion.mjs')
  const { proactiveTick, proactiveStatus } = await import('../lib/proactive.mjs')
  const { runTurn } = await import('../lib/chat.mjs')
  const style = (style) => saveConfig({ attention: { style } })
  const timing = async (local, trigger = 'suggestion') => {
    const now = at(local)
    return checkAttention({ now, trigger, channel: trigger === 'companion' ? 'companion' : 'proactive' })
  }
  await saveConfig({
    upstream: { defaultModel: 'fixture' }, memory: { enabled: false }, search: { enabled: false }, screen: { enabled: false },
    proactive: { enabled: true, notify: false, quietHours: { start: '00:00', end: '00:00' } },
    companion: { enabled: true, minTextChars: 10, scenarios: ['work'] },
  })
  await createConversation({ isMain: true })
  const chat = async (args) => { for await (const _ of runTurn({ conversationId: 'main', searchMode: 'off', ...args })) {} }
  await chat({ userText: '   ' })
  assert.equal((await readState()).lastUserMessageAt, undefined)
  await chat({ userText: 'Fixture.' })
  await chat({ userText: 'Another message in the same band.' })
  clock('2026-11-01T12:05:00')
  await chat({ regenerate: true })
  assert.equal((await readState()).attention.timingSamples.chat.length, 1, 'regeneration and repeated chat do not manufacture a new habit')
  for (const day of ['2026-11-01', '2026-11-02']) {
    clock(day + 'T22:15:00')
    await chat({ userText: 'Fixture.' })
  }
  assert.equal((await timing('2026-11-03T20:00:00')).timing.reason, 'sparse_history')
  clock('2026-11-03T22:15:00')
  await chat({ userText: 'Fixture.' })
  clock('2026-11-04T20:00:00')
  const learned = await checkAttention()
  assert.equal(learned.reason, 'waiting_for_usual_window')
  assert.deepEqual(learned.timing.usualStartHours, [21])
  assert.equal(learned.timing.observedDays, 4)
  assert.equal(learned.timing.nextEligibleAt, '2026-11-05T02:00:00.000Z', 'the local window survives midnight UTC and the DST transition')
  assert.equal((await timing('2026-11-04T16:00:00')).allow, true)
  assert.equal((await timing('2026-11-04T21:00:00')).timing.reason, 'usual_chat_window')
  assert.equal((await timing('2026-11-20T20:00:00')).timing.observedDays, 0)
  await style('quiet')
  assert.equal((await timing('2026-11-04T16:00:00')).reason, 'waiting_for_usual_window')
  await style('engaged')
  assert.equal((await checkAttention()).allow, true)
  await style('balanced')
  const frame = { text: 'Fixture screen showing a useful meeting agenda.', app: 'Editor', title: 'Meeting notes' }
  const beforeHeld = calls
  await mutateState((s) => { s.dream = { loops: [{ id: 'loop_one', status: 'open', topic: 'Agenda' }] } })
  assert.equal((await proactiveTick()).skipped, 'waiting_for_usual_window')
  assert.equal((await ingestFrame(frame)).skipped, 'waiting_for_usual_window')
  assert.equal(calls, beforeHeld, 'neither channel calls a model while the timing gate holds')

  // Only the current saved goal/artifact establish priority, including old queue entries.
  const goal = { id: 'goal_user', status: 'active', origin: 'user', revision: 1, preparation: {} }
  const inferred = { ...goal, id: 'goal_inferred', origin: 'discovered', discovery: { adopted: false, expiresAt: '2026-11-10T12:00:00Z' } }
  const prep = (goal, trigger) => ({
    id: 'prep_' + goal.id, title: goal.id, commitmentId: goal.id, revision: 1, trigger,
    createdAt: new Date().toISOString(), content: 'A verified draft.', evidence: [], verification: { passed: true },
    delivery: { status: 'pending', expiresAt: '2026-11-11T12:00:00Z' },
  })
  const speculative = prep(inferred, 'answered')
  const requested = prep(goal, 'answered')
  for (const reason of ['accepted', 'requested', 'answered', 'deadline_approaching']) {
    assert.equal(preparationTrigger(goal, prep(goal, reason)), 'requested_goal')
    assert.equal(preparationTrigger(inferred, prep(inferred, reason)), 'suggestion')
  }
  assert.equal(preparationTrigger({ ...inferred, discovery: { adopted: true } }, prep(inferred, 'adopted')), 'requested_goal')
  assert.equal(preparationTrigger(goal, prep(goal, 'source_changed')), 'suggestion')
  await mutateState((s) => {
    s.commitments = [inferred, goal]
    s.preparations = [speculative, requested]
    s.proactive.queue = [{ id: 'legacy', preparationId: speculative.id, messageId: 'm_legacy', trigger: 'requested_goal',
      expiresAt: speculative.delivery.expiresAt, content: 'Unadopted goal', evidence: [] }]
  })
  assert.equal((await proactiveStatus()).attention.timing.trigger, 'requested_goal')
  assert.equal((await proactiveStatus({ busyConversations: new Set(['main']) })).nextGate.reason, 'user_active')
  const delivered = await proactiveTick()
  assert.equal(delivered.message.preparationId, requested.id)
  assert.equal(delivered.message.timingTrigger, 'requested_goal')
  assert.equal((await readState()).proactive.queue[0].trigger, 'suggestion')
  assert.equal((await readState()).preparations[0].delivery.status, 'pending')
  assert.equal(calls, beforeHeld, 'priority and delivery of a saved draft require no model')
  clock('2026-11-04T21:00:00')
  await style('quiet')
  assert.equal((await checkAttention()).reason, 'quiet_style_gap')
  assert.equal((await checkAttention({ trigger: 'requested_goal' })).allow, true)
  await style('balanced')
  assert.equal((await proactiveTick()).message.id, 'm_legacy', 'the deferred draft is still delivered in its window')
  assert.equal(calls, beforeHeld)
  await saveConfig({ proactive: { quietHours: { start: '20:00', end: '22:00' } } })
  assert.equal((await checkAttention({ trigger: 'requested_goal' })).reason, 'quiet_hours')
  await saveConfig({ proactive: { quietHours: { start: '00:00', end: '00:00' } } })

  await writeState({})
  const wrong = async (id, local) => {
    await appendMessage('main', { id, role: 'assistant', proactive: true, kind: 'ask', createdAt: new Date(at(local)).toISOString(), timingTrigger: 'suggestion', deliveryTimeZone: 'America/New_York' })
    return applyFeedback({ signal: 'wrong_time', conversationId: 'main', messageId: id })
  }
  await wrong('m_a', '2026-11-01T12:10:00')
  await wrong('m_b', '2026-11-01T13:30:00')
  await wrong('m_c', '2026-11-02T12:30:00')
  await wrong('m_old', '2026-10-01T12:00:00')
  assert.equal((await checkAttention({ trigger: 'requested_goal' })).reason, 'wrong_time_pause')
  clock('2026-11-05T12:00:00')
  await style('engaged')
  const explicit = await checkAttention()
  assert.equal(explicit.reason, 'repeated_wrong_time')
  assert.equal(explicit.timing.wrongTimeDays, 2)
  assert.equal((await checkAttention({ trigger: 'requested_goal' })).allow, true)
  assert.equal((await checkAttention({ channel: 'companion' })).allow, true)
  const beforeExplicitHold = calls
  await mutateState((s) => { s.dream = { loops: [{ id: 'loop_again', status: 'open', topic: 'A different agenda' }] } })
  assert.equal((await proactiveTick()).skipped, 'repeated_wrong_time')
  assert.equal(calls, beforeExplicitHold)
  assert.equal((await timing('2026-11-05T15:00:00')).allow, true, 'timing feedback does not cause an all-day lockout')
  assert.equal((await timing('2026-11-20T12:00:00')).allow, true, 'stale timing feedback no longer holds a window')
  process.env.TZ = 'Asia/Shanghai'
  assert.equal((await timing('2026-11-05T12:00:00')).timing.wrongTimeDays, 0, 'a different local zone does not inherit old clock windows')
  process.env.TZ = 'America/New_York'
  await writeState({})
  await style('quiet')
  const bubble = (await ingestFrame(frame)).bubble
  assert.ok(bubble)
  assert.deepEqual((await pendingBubbles()).map((item) => item.id), [bubble.id], 'a pending bubble does not count its own delivery twice')
  assert.deepEqual(await pendingBubbles({ busyConversations: new Set(['main']) }), [])
  assert.equal((await pendingBubbles())[0].id, bubble.id, 'a transient presentation hold preserves the bubble')
  const mini = await openBubble(bubble.id)
  clock('2026-11-05T21:00:00')
  await applyFeedback({ signal: 'wrong_time', conversationId: mini.conversationId, messageId: 'm_' + bubble.id })
  const pausedUntil = (await readState()).attention.pausedUntil
  clock('2026-11-05T21:15:00')
  const dismissed = await dismissBubble(bubble.id, { reason: 'wrong_time' })
  const duplicate = await dismissBubble(bubble.id, { reason: 'wrong_time' })
  assert.equal(duplicate.dismissedAt, dismissed.dismissedAt)
  assert.equal((await readState()).attention.pausedUntil, pausedUntil, 'duplicate native/mini votes do not extend the pause')
  assert.deepEqual((await readState()).attention.timingSamples.companion, ['2026-11-05T12'])

  await writeState({ attention: { timingSamples: {
    zone: 'America/New_York', chat: ['broken', null, 9, '2026-11-04T21', '2026-11-04T21'], suggestion: 'old-format',
  } } })
  const repaired = await checkAttention({ trigger: 'unrecognized-legacy-value' })
  assert.equal(repaired.timing.observedDays, 1)
  assert.equal(repaired.timing.trigger, 'suggestion')
  await appendMessage('main', { id: 'm_legacy_timing', role: 'assistant', proactive: true, timingTrigger: 'other', createdAt: new Date().toISOString() })
  await applyFeedback({ signal: 'wrong_time', conversationId: 'main', messageId: 'm_legacy_timing' })
  assert.equal((await checkAttention()).reason, 'wrong_time_pause', 'unclassified historical votes still respect the immediate pause')
  await writeState({})
  await saveConfig({ proactive: { enabled: false }, companion: { enabled: false } })
  await chat({ userText: 'Explicit chat while both background channels are off.' })
  assert.equal((await readState()).attention?.timingSamples, undefined)
  console.log('Timing regressions passed: distinct local days, DST, styles, trigger priority, feedback attribution, free deferrals, resume and overlay recheck.')
} finally {
  mock.timers.reset()
  globalThis.fetch = fetchBefore
  await fs.rm(dir, { recursive: true, force: true })
}
