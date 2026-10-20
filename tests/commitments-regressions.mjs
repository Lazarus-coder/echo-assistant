import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-commitments-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_COMMITMENT_TEST_KEY = 'local-test-only'
let requests = []
let modelReply
const validOutput = () => ({
  title: 'Proposal checklist',
  content: '## Draft checklist\n\n- Define the proposal audience and expected decision. [goal1]\n- Suggested next step: review this draft.',
  evidenceIds: ['goal1'], assumptions: ['The audience still needs confirmation.'], question: null,
})
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const output = await modelReply(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  } catch (error) {
    res.writeHead(500)
    res.end(error.message)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env.ECHO_COMMITMENT_TEST_URL = `http://127.0.0.1:${server.address().port}/v1`
await fs.writeFile(process.env.ECHO_CONFIG, JSON.stringify({
  upstream: { apiKeyEnv: 'ECHO_COMMITMENT_TEST_KEY', baseUrlEnv: 'ECHO_COMMITMENT_TEST_URL', defaultModel: 'test', utilityModel: 'test' },
  memory: { enabled: false }, search: { enabled: false }, screen: { enabled: false },
}))

const { loadConfig } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const engine = await import('../lib/commitments.mjs')
const { appendObservation } = await import('../lib/memory.mjs')
await loadConfig()
const originalFetch = globalThis.fetch
const input = (extra = {}) => ({ title: 'Finish the proposal', successCriteria: 'A reviewable proposal with an audience and next action', ...extra })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function reset() {
  await store.writeState({ unrelated: { keep: true } })
  requests = []
  modelReply = validOutput
  globalThis.fetch = originalFetch
}

async function dueWatch(id) {
  await store.mutateState((state) => {
    state.commitments.find((g) => g.id === id).watch.nextCheckAt = '2000-01-01T00:00:00Z'
  })
}

try {
  await test('accepted commitments are durable and remain separate from inferred Dream loops', async () => {
    await reset()
    await store.mutateState((s) => { s.dream = { loops: [{ id: 'loop_one', topic: 'proposal' }] } })
    const goal = await engine.createCommitment(input({ candidateLoopId: 'loop_one' }))
    assert.equal(goal.preparation.state, 'queued')
    assert.equal(goal.candidateLoopId, 'loop_one')
    await assert.rejects(engine.createCommitment(input({ candidateLoopId: 'loop_one' })), { status: 409 })
    await store.mutateState((s) => { s.dream = { loops: [] } })
    assert.equal((await engine.listCommitments()).commitments[0].id, goal.id)
    assert.equal((await store.readState()).unrelated.keep, true)
    await assert.rejects(engine.createCommitment(input({ candidateLoopId: 'loop_missing' })), { status: 400 })
  })

  await test('validation rejects invalid scopes, dates, oversized fields, provenance and incomplete completion', async () => {
    await reset()
    for (const extra of [
      { title: ' ' }, { title: 'x'.repeat(161) }, { deadline: '2026-02-30' }, { deadline: '2026-99-01' },
      { scope: { memory: 'yes' } }, { scope: { urls: ['file:///etc/passwd'] } },
      { scope: { urls: ['https://user:secret@example.com'] } }, { scope: { urls: Array(4).fill('https://example.com') } },
      { watch: { type: 'source_change' } }, { watch: { type: 'deadline' } },
      { source: { conversationId: 'missing_conversation', messageId: 'missing_message' } },
      { status: 'done' },
    ]) await assert.rejects(engine.createCommitment(input(extra)), { status: 400 })
    await assert.rejects(engine.updateCommitment('goal_missing', { status: 'paused' }), { status: 404 })
    const goal = await engine.createCommitment(input())
    await assert.rejects(engine.updateCommitment(goal.id, { status: 'done' }), { status: 400 })
    const completed = await engine.updateCommitment(goal.id, { status: 'done', completionEvidence: 'Reviewed and approved the final draft.' })
    assert.equal(completed.completionEvidence, 'Reviewed and approved the final draft.')
    await assert.rejects(engine.requestPreparation(goal.id), { status: 409 })
  })

  await test('parallel state updates keep all accepted commitments', async () => {
    await reset()
    const goals = await Promise.all(Array.from({ length: 8 }, (_, index) => engine.createCommitment(input({ title: `Goal ${index}` }))))
    assert.equal((await engine.listCommitments()).commitments.length, goals.length)
  })

  await test('one preparation persists a concrete artifact with verified source identifiers and bounded model settings', async () => {
    await reset()
    const conv = await store.createConversation({ title: 'Source' })
    await store.appendMessage(conv.id, { id: 'user_request', role: 'user', content: 'Please help finish this proposal.' })
    const goal = await engine.createCommitment(input({ source: { conversationId: conv.id, messageId: 'user_request', excerpt: 'FORGED' } }))
    const result = await engine.prepareDueCommitments()
    assert.equal(result.prepared.length, 1)
    const [artifact] = await engine.pendingPreparations()
    assert.equal(artifact.commitmentId, goal.id)
    assert.equal(artifact.verification.passed, true)
    assert.equal(artifact.verification.factualAccuracy, 'not_independently_verified')
    assert.equal(artifact.evidence[0].source, `commitment:${goal.id}`)
    assert.ok(artifact.content.includes('[goal1]'))
    assert.equal(requests[0].max_tokens, 1800)
    const prompt = JSON.parse(requests[0].messages[1].content)
    assert.equal(prompt.evidence.find((e) => e.id === 'message1').excerpt, 'Please help finish this proposal.')
    assert.ok(!JSON.stringify(prompt).includes('FORGED'))
    const disk = JSON.parse(await fs.readFile(path.join(sandbox, 'state.json'), 'utf8'))
    assert.equal(disk.preparations[0].content, artifact.content)
    assert.equal(disk.commitments[0].status, 'active')
  })

  await test('concurrent worker calls share one run and do not repeat unchanged manual work', async () => {
    await reset()
    await engine.createCommitment(input())
    const results = await Promise.all([engine.prepareDueCommitments(), engine.prepareDueCommitments(), engine.prepareDueCommitments()])
    assert.equal(requests.length, 1)
    assert.deepEqual(results[0], results[1])
    await engine.prepareDueCommitments()
    assert.equal(requests.length, 1)
  })

  await test('remembered material is only included with explicit per-goal permission', async () => {
    await reset()
    await appendObservation({ text: 'Proposal audience is the internal research team.', importance: 5, kind: 'project' })
    await engine.createCommitment(input())
    await engine.prepareDueCommitments()
    assert.equal(JSON.parse(requests[0].messages[1].content).evidence.some((e) => e.id.startsWith('memory')), false)
    const goal = await engine.createCommitment(input({ scope: { memory: true, urls: [] } }))
    await engine.prepareDueCommitments()
    const prompt = JSON.parse(requests[1].messages[1].content)
    assert.ok(prompt.evidence.some((e) => e.source.startsWith('memory:') && e.observedAt))
    assert.equal((await engine.listCommitments()).commitments.find((g) => g.id === goal.id).scope.memory, true)
  })

  await test('pausing or changing the goal during the model call discards stale output', async () => {
    for (const patch of [{ status: 'paused' }, { successCriteria: 'A different outcome', scope: { memory: false, urls: [] } }]) {
      await reset()
      const entered = deferred()
      const release = deferred()
      modelReply = async () => { entered.resolve(); await release.promise; return validOutput() }
      const goal = await engine.createCommitment(input())
      const run = engine.prepareDueCommitments()
      await entered.promise
      await engine.updateCommitment(goal.id, patch)
      release.resolve()
      const result = await run
      assert.equal(result.discarded, 1)
      assert.equal((await engine.listCommitments()).preparations.length, 0)
      assert.equal((await engine.pendingPreparations()).length, 0)
    }
  })

  await test('invalid or fabricated source references fail visibly instead of publishing', async () => {
    for (const output of [
      { ...validOutput(), evidenceIds: ['web99'] },
      { ...validOutput(), content: 'An unsupported assertion. [web99]' },
      { ...validOutput(), content: 'An assertion without a source.' },
    ]) {
      await reset()
      modelReply = () => output
      const goal = await engine.createCommitment(input())
      const result = await engine.prepareDueCommitments()
      assert.equal(result.failed.length, 1)
      assert.equal((await engine.pendingPreparations()).length, 0)
      assert.equal((await engine.listCommitments()).commitments.find((g) => g.id === goal.id).preparation.state, 'failed')
    }
  })

  await test('interrupted work resumes once after restart while preserving its spent budget', async () => {
    await reset()
    const goal = await engine.createCommitment(input())
    await store.mutateState((state) => {
      state.commitments[0].preparation = { state: 'running', workerId: 'previous_process', runId: 'old_run' }
      state.commitmentWork.runs.push({ id: 'old_run', commitmentId: goal.id, at: new Date().toISOString() })
    })
    await engine.prepareDueCommitments()
    await engine.prepareDueCommitments()
    assert.equal(requests.length, 1)
    assert.equal((await store.readState()).commitmentWork.runs.length, 2)
    assert.equal((await engine.pendingPreparations()).length, 1)
  })

  await test('per-goal and global rolling budgets defer work without losing the queue', async () => {
    await reset()
    const goal = await engine.createCommitment(input())
    await engine.prepareDueCommitments()
    await engine.requestPreparation(goal.id)
    await engine.prepareDueCommitments()
    await engine.requestPreparation(goal.id)
    const held = await engine.prepareDueCommitments()
    assert.equal(held.budgetDeferred, 1)
    assert.equal(requests.length, 2)
    assert.equal((await engine.listCommitments()).commitments[0].preparation.state, 'queued')
    await store.mutateState((state) => { state.commitmentWork.runs.forEach((run) => { run.at = '2000-01-01T00:00:00Z' }) })
    await engine.prepareDueCommitments()
    assert.equal(requests.length, 3)
    await reset()
    for (let i = 0; i < 6; i++) await engine.createCommitment(input({ title: `Goal ${i}` }))
    const limited = await engine.prepareDueCommitments()
    assert.equal(limited.prepared.length, 5)
    assert.equal(limited.budgetDeferred, 1)
    assert.equal(requests.length, 5)
  })

  await test('delivery only consumes current unexpired artifacts and is idempotent', async () => {
    await reset()
    const goal = await engine.createCommitment(input())
    await engine.prepareDueCommitments()
    const [artifact] = await engine.pendingPreparations()
    const delivered = await engine.markPreparationDelivered(artifact.id, { conversationId: 'main', messageId: 'message_delivery' })
    assert.equal(delivered.delivery.status, 'delivered')
    assert.equal(await engine.markPreparationDelivered(artifact.id, { conversationId: 'main', messageId: 'message_duplicate' }), null)
    assert.equal((await engine.pendingPreparations()).length, 0)
    await engine.requestPreparation(goal.id)
    await engine.prepareDueCommitments()
    const [next] = await engine.pendingPreparations()
    await engine.updateCommitment(goal.id, { status: 'paused' })
    assert.equal(await engine.markPreparationDelivered(next.id, { conversationId: 'main', messageId: 'message_stale' }), null)
    assert.equal((await engine.pendingPreparations()).length, 0)
  })

  await test('source watches wait at least an hour and prepare again only after a real source change', async () => {
    await reset()
    let pageText = 'Submission requires a title and an abstract.'
    let pageReads = 0
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://8.8.8.8/')) {
        pageReads++
        return new Response(`<h1>Submission</h1><p>${pageText}</p>`, { headers: { 'content-type': 'text/html' } })
      }
      return originalFetch(url, options)
    }
    const goal = await engine.createCommitment(input({ scope: { memory: false, urls: ['https://8.8.8.8/requirements'] }, watch: { type: 'source_change' } }))
    await engine.prepareDueCommitments()
    await engine.prepareDueCommitments()
    assert.equal(pageReads, 1)
    await dueWatch(goal.id)
    await engine.prepareDueCommitments()
    assert.equal(pageReads, 2)
    assert.equal(requests.length, 1)
    pageText += ' A data statement is now required.'
    await dueWatch(goal.id)
    await engine.prepareDueCommitments()
    assert.equal(pageReads, 3)
    assert.equal(requests.length, 2)
    assert.equal((await engine.pendingPreparations())[0].trigger, 'source_changed')
  })

  await test('source watching detects changes beyond the prompt excerpt without widening the model input', async () => {
    await reset()
    let ending = 'The final rule is alpha.'
    let reads = 0
    const prefix = 'Background material for the submission. '.repeat(220)
    assert.ok(prefix.length > 6500)
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://8.8.8.8/')) {
        reads++
        return new Response(`<p>${prefix}</p><p>${ending}</p>`, { headers: { 'content-type': 'text/html' } })
      }
      return originalFetch(url, options)
    }
    const goal = await engine.createCommitment(input({ scope: { urls: ['https://8.8.8.8/long-page'] }, watch: { type: 'source_change' } }))
    await engine.prepareDueCommitments()
    const first = JSON.parse(requests[0].messages[1].content).evidence.find((e) => e.id === 'web1')
    assert.equal(first.truncated, true)
    assert.ok(first.excerpt.length < 6600)
    assert.ok(!first.excerpt.includes(ending))
    ending = 'The final rule is omega.'
    await dueWatch(goal.id)
    await engine.prepareDueCommitments()
    assert.equal(requests.length, 2)
    assert.equal(reads, 2, 'watching reuses its existing page read for preparation')
    const second = JSON.parse(requests[1].messages[1].content).evidence.find((e) => e.id === 'web1')
    assert.equal(second.excerpt, first.excerpt)
    assert.notEqual(second.fingerprint, first.fingerprint)
    assert.equal((await engine.pendingPreparations())[0].trigger, 'source_changed')
  })

  await test('deadline preparation is not repeatedly triggered for an unchanged deadline', async () => {
    await reset()
    const date = new Date().toISOString().slice(0, 10)
    const goal = await engine.createCommitment(input({ deadline: date, watch: { type: 'deadline' } }))
    await engine.prepareDueCommitments()
    await dueWatch(goal.id)
    await engine.prepareDueCommitments()
    assert.equal(requests.length, 1)
    assert.equal((await engine.listCommitments()).commitments[0].watch.deadlineTriggered, date)
  })

  await test('failed watch reads preserve prior evidence and retry the changed source on recovery', async () => {
    await reset()
    let unavailable = false
    let pageText = 'Original requirements.'
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://8.8.8.8/')) {
        if (unavailable) return new Response('Unavailable', { status: 503 })
        return new Response(`<p>${pageText}</p>`, { headers: { 'content-type': 'text/html' } })
      }
      return originalFetch(url, options)
    }
    const goal = await engine.createCommitment(input({ scope: { urls: ['https://8.8.8.8/requirements'] }, watch: { type: 'source_change' } }))
    await engine.prepareDueCommitments()
    const before = (await engine.listCommitments()).commitments[0].watch.fingerprints
    unavailable = true
    pageText = 'Updated requirements with a new section.'
    await dueWatch(goal.id)
    await engine.prepareDueCommitments()
    const failed = (await engine.listCommitments()).commitments[0]
    assert.deepEqual(failed.watch.fingerprints, before)
    assert.match(failed.watch.lastError, /503/)
    assert.equal(requests.length, 1)
    unavailable = false
    await dueWatch(goal.id)
    await engine.prepareDueCommitments()
    assert.equal(requests.length, 2)
    assert.equal((await engine.listCommitments()).commitments[0].watch.lastError, null)
  })

  await test('revoking source scope while a read is in flight prevents sending its result to the model', async () => {
    await reset()
    const entered = deferred()
    const release = deferred()
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://8.8.8.8/')) {
        entered.resolve()
        await release.promise
        return new Response('<p>Previously approved material.</p>', { headers: { 'content-type': 'text/html' } })
      }
      return originalFetch(url, options)
    }
    const goal = await engine.createCommitment(input({ scope: { urls: ['https://8.8.8.8/requirements'] } }))
    const run = engine.prepareDueCommitments()
    await entered.promise
    await engine.updateCommitment(goal.id, { scope: { memory: false, urls: [] } })
    release.resolve()
    assert.equal((await run).discarded, 1)
    assert.equal(requests.length, 0)
    assert.equal((await engine.pendingPreparations()).length, 0)
  })

  await test('expired preparations remain reviewable but are not delivered as new initiatives', async () => {
    await reset()
    await engine.createCommitment(input())
    await engine.prepareDueCommitments()
    const [artifact] = await engine.pendingPreparations()
    await store.mutateState((state) => { state.preparations[0].delivery.expiresAt = '2000-01-01T00:00:00Z' })
    assert.equal((await engine.pendingPreparations()).length, 0)
    assert.equal(await engine.markPreparationDelivered(artifact.id, { conversationId: 'main', messageId: 'expired_message' }), null)
    assert.equal((await engine.listCommitments()).preparations[0].content, artifact.content)
  })

  await test('scoped readers reject internal URLs and never follow redirects outside the approved source', async () => {
    await reset()
    const externalReads = []
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith(process.env.ECHO_COMMITMENT_TEST_URL)) {
        externalReads.push(String(url))
        return new Response(null, { status: 302, headers: { location: 'https://9.9.9.9/unapproved' } })
      }
      return originalFetch(url, options)
    }
    const goal = await engine.createCommitment(input({ scope: { urls: ['http://127.0.0.1/private', 'https://8.8.8.8/approved'] } }))
    const result = await engine.prepareDueCommitments()
    assert.deepEqual(externalReads, ['https://8.8.8.8/approved'])
    assert.equal(result.failed.length, 1)
    assert.equal(requests.length, 0)
    assert.equal((await engine.pendingPreparations()).length, 0)
    assert.match((await engine.listCommitments()).commitments.find((g) => g.id === goal.id).preparation.error, /无法读取授权来源/)
  })
} finally {
  globalThis.fetch = originalFetch
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(sandbox, { recursive: true, force: true })
}
