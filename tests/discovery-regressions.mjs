import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-discovery-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_DISCOVERY_TEST_KEY = 'isolated-test-key'
process.env.ECHO_DISCOVERY_TEST_URL = 'https://model.example.test/v1'
const { saveConfig } = await import('../lib/config.mjs')
const { createConversation, appendMessage, readState, mutateState } = await import('../lib/store.mjs')
const { discoverNeeds, cancelDiscovery, validateResearchSettings, researchStatus } = await import('../lib/discovery.mjs')
const { updateCommitment } = await import('../lib/commitments.mjs')
const { newId } = await import('../lib/util.mjs')
const originalFetch = globalThis.fetch
let response = { discover: [], updates: [], complete: [] }, requests = [], transport
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://model.example.test/v1/chat/completions')
  assert.equal(init.headers.authorization, 'Bearer isolated-test-key')
  const body = JSON.parse(init.body)
  requests.push(body)
  if (transport) return transport(init)
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 30, completion_tokens: 12 } }))
}
await saveConfig({
  upstream: { apiKeyEnv: 'ECHO_DISCOVERY_TEST_KEY', baseUrlEnv: 'ECHO_DISCOVERY_TEST_URL', defaultModel: 'fixture' },
  memory: { enabled: false, inject: false, extract: false },
  proactive: { enabled: false, research: { enabled: false, discoverChats: true } },
})
const conv = await createConversation({ title: 'Registration' })
async function say(content, at = new Date().toISOString()) {
  const message = { id: newId('m'), role: 'user', content, createdAt: at }
  await appendMessage(conv.id, message)
  return message
}
const empty = () => ({ discover: [], updates: [], complete: [] })
let goal
try {
  await test('research defaults to opt-in and settings reject injected activation timestamps', async () => {
    assert.equal((await discoverNeeds()).skipped, 'disabled')
    assert.equal(requests.length, 0)
    assert.throws(() => validateResearchSettings({ enabled: 'true' }), /布尔值/)
    assert.throws(() => validateResearchSettings({ enabledAt: '2000-01-01' }), /未知字段/)
    assert.ok(validateResearchSettings({ enabled: true }, { enabled: false }).enabledAt)
    assert.ok(validateResearchSettings({ discoverChats: true }, { enabled: true, discoverChats: false }).enabledAt)
  })
  await test('only new user messages after activation are scanned; delivery and memory switches do not gate research', async () => {
    await say('An old unrelated registration task.', new Date(Date.now() - 86400000).toISOString())
    await saveConfig({ proactive: { research: { enabled: true, enabledAt: new Date(Date.now() - 1000).toISOString() } } })
    const message = await say('I am stuck registering for Example University, 2027 MSc.');
    response = { ...empty(), discover: [{
      messageId: message.id, quote: message.content, confidence: 0.95,
      title: 'Complete Example University registration',
      successCriteria: 'Registration completed and confirmation received',
      nextAction: 'Check the registration deadline and required documents',
      blocker: 'Registration is blocked',
      situation: { institution: 'Example University', program: 'MSc', cycle: '2027', questions: ['Which applicant category?'] },
      scope: { memory: true, urls: ['https://attacker.test'], officialDomains: ['attacker.test'] },
    }] }
    const result = await discoverNeeds()
    assert.equal(result.discovered, 1)
    goal = (await readState()).commitments[0]
    assert.equal(goal.origin, 'discovered')
    assert.equal(goal.source.messageId, message.id)
    assert.equal(goal.scope.memory, false)
    assert.deepEqual(goal.scope.urls, [])
    assert.ok(!goal.scope.officialDomains?.length)
    assert.equal(goal.discovery.adopted, false)
    const input = JSON.parse(requests.at(-1).messages[1].content)
    assert.equal(input.current.length, 1)
    assert.equal(input.current[0].id, message.id)
    assert.deepEqual(input.context, [], 'pre-activation messages must not leak through contextual retrieval')
    assert.equal((await researchStatus()).stats.discovered, 1)
  })
  await test('a scan is idempotent and unseen model-invented evidence cannot create another case', async () => {
    const count = requests.length
    assert.equal((await discoverNeeds()).skipped, 'no_new_messages')
    assert.equal(requests.length, count)
    const message = await say('Today is a pleasant day.')
    response = { ...empty(), discover: [{
      messageId: message.id, quote: 'I need to apply to another school', confidence: 1,
      title: 'Invented need', successCriteria: 'Invented completion',
    }] }
    await discoverNeeds()
    assert.equal((await readState()).commitments.length, 1)
  })
  await test('clarification updates the same case with grounded identity and message provenance', async () => {
    const message = await say('My applicant category is international.');
    response = { ...empty(), updates: [{ id: goal.id, messageId: message.id, quote: message.content, situation: { category: 'international', stage: 'invented stage' } }] }
    await discoverNeeds()
    const goals = (await readState()).commitments
    assert.equal(goals.length, 1)
    assert.equal(goals[0].situation.category, 'international')
    assert.notEqual(goals[0].situation.stage, 'invented stage')
    assert.equal(goals[0].source.messageId, message.id)
  })
  await test('a model cannot turn a negated completion into done', async () => {
    const message = await say('I have not completed registration and have not received confirmation.')
    response = { ...empty(), complete: [{ id: goal.id, messageId: message.id, quote: message.content }] }
    await discoverNeeds()
    assert.equal((await readState()).commitments[0].status, 'active')
  })
  await test('two clarifications in one scan both survive optimistic revision checks', async () => {
    const first = await say('My registration stage is course enrollment.')
    const second = await say('The program is MSc Computer Science.')
    response = { ...empty(), updates: [
      { id: goal.id, messageId: first.id, quote: first.content, situation: { stage: 'course enrollment' } },
      { id: goal.id, messageId: second.id, quote: second.content, situation: { program: 'MSc Computer Science' } },
    ] }
    await discoverNeeds()
    const current = (await readState()).commitments[0]
    assert.equal(current.situation.stage, 'course enrollment')
    assert.equal(current.situation.program, 'MSc Computer Science')
    assert.equal(current.source.messageId, second.id)
  })
  await test('explicit task-specific completion stops reminders with a source reference', async () => {
    const message = await say('I completed registration and received confirmation.')
    response = { ...empty(), complete: [{ id: goal.id, messageId: message.id, quote: message.content }] }
    const result = await discoverNeeds()
    assert.equal(result.completed, 1)
    const completed = (await readState()).commitments[0]
    assert.equal(completed.status, 'done')
    assert.match(completed.completionEvidence, /completed registration/)
  })
  await test('failed discovery persists retry state without consuming the message', async () => {
    const message = await say('I am missing documents for another application.')
    transport = async () => new Response('temporary outage', { status: 503 })
    assert.equal((await discoverNeeds()).failed, true)
    const failed = await researchStatus()
    assert.match(failed.lastError, /503/)
    assert.ok(Date.parse(failed.nextRetryAt) > Date.now())
    const count = requests.length
    assert.equal((await discoverNeeds()).skipped, 'retry_wait')
    assert.equal(requests.length, count)
    await mutateState((s) => { s.proactiveDiscovery.nextRetryAt = null })
    transport = null
    response = empty()
    await discoverNeeds()
    const input = JSON.parse(requests.at(-1).messages[1].content)
    assert.ok(input.current.some((m) => m.id === message.id))
    assert.equal((await researchStatus()).lastError, null)
  })
  await test('revoking discovery cancels the pending model request and cannot create a late case', async () => {
    await say('I need to check my next registration.')
    let started
    const entered = new Promise((resolve) => { started = resolve })
    transport = (init) => new Promise((resolve, reject) => {
      started()
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
    const running = discoverNeeds()
    await entered
    await saveConfig({ proactive: { research: { enabled: false } } })
    await cancelDiscovery()
    assert.equal((await running).skipped, 'cancelled')
    assert.equal((await readState()).commitments.length, 1)
    transport = null
  })
  await test('rolling discovery budget prevents unbounded background model calls', async () => {
    await saveConfig({ proactive: { research: { enabled: true } } })
    await mutateState((s) => { s.proactiveDiscovery.runs = Array(20).fill(new Date().toISOString()) })
    const count = requests.length
    assert.equal((await discoverNeeds()).skipped, 'discovery_budget')
    assert.equal(requests.length, count)
  })
  await test('revision preconditions reject stale clarification instead of overwriting newer work', async () => {
    await assert.rejects(updateCommitment(goal.id, { expectedRevision: 1, situation: { institution: 'Wrong' } }), (e) => e.status === 409)
  })
} finally {
  await cancelDiscovery()
  globalThis.fetch = originalFetch
  // Metrics flush on a short timer; drain it before removing the test directory.
  await new Promise((resolve) => setTimeout(resolve, 1600))
  await fs.rm(sandbox, { recursive: true, force: true })
}
