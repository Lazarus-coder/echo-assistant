import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-commitment-research-'))
process.env.ECHO_DATA_DIR = path.join(sandbox, 'data')
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_RESEARCH_ENGINE_KEY = 'fixture-key'
const workspace = path.join(sandbox, 'workspace')
await fs.mkdir(workspace)
await fs.mkdir(path.join(workspace, 'allowed'))
await fs.symlink(os.tmpdir(), path.join(workspace, 'escape'))
const identity = { institution: 'Example University', program: 'MSc Computing', cycle: '2027', category: 'international', stage: 'registration' }
const quote = 'Example University MSc Computing 2027 international registration deadline is 2027-01-20.'
const pageUrl = 'https://8.8.8.8/registration'
const evidence = [{ id: 'web1', source: pageUrl, label: 'Example University', excerpt: quote, observedAt: new Date().toISOString(), fingerprint: 'fixture', authority: 'official' }]
const claim = { evidenceId: 'web1', quote, date: '2027-01-20', ...identity }
const modelOutput = () => ({ title: 'Registration checklist', content: 'Review the registration requirements. [goal1]', evidenceIds: ['goal1'], assumptions: [], question: null, deadlineClaims: [] })
let output = modelOutput
let streamTools = false
let requests = 0
let pageReads = 0
let pageText = quote
const mock = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests++
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output()) } }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (streamTools && !body.messages.some((message) => message.role === 'tool')) {
    const calls = [{ index: 0, id: 'call_source', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: pageUrl }) } }]
    if (streamTools === 'both') calls.push({ index: 1, id: 'call_file', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: 'allowed/notes.txt' }) } })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`)
  } else {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output()) } }] })}\n\n`)
  }
  res.end('data: [DONE]\n\n')
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
process.env.ECHO_RESEARCH_ENGINE_URL = `http://127.0.0.1:${mock.address().port}/v1`
await fs.writeFile(process.env.ECHO_CONFIG, JSON.stringify({
  upstream: { apiKeyEnv: 'ECHO_RESEARCH_ENGINE_KEY', baseUrlEnv: 'ECHO_RESEARCH_ENGINE_URL', defaultModel: 'fixture', utilityModel: 'fixture' },
  proactive: { research: { enabled: true } }, memory: { enabled: false }, screen: { enabled: false },
  harness: { enabled: true, workspaceRoot: await fs.realpath(workspace) }, search: { enabled: true, order: ['scrape'] },
}))
const store = await import('../lib/store.mjs')
const engine = await import('../lib/commitments.mjs')
const config = await import('../lib/config.mjs')
const deadlines = await import('../lib/deadlines.mjs')
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://8.8.8.8/')) {
    pageReads++
    return new Response(`<h1>Example University</h1><p>${pageText}</p>`, { headers: { 'content-type': 'text/html' } })
  }
  return originalFetch(url, options)
}
const goalInput = (extra = {}) => ({ title: 'Complete registration', successCriteria: 'Registration is completed and confirmation received', ...extra })
const scoped = (extra = {}) => goalInput({ situation: identity, scope: { research: true, urls: [pageUrl], officialDomains: ['8.8.8.8'] }, watch: { type: 'combined' }, ...extra })
async function reset() {
  await store.writeState({ unrelated: { preserve: true } })
  await config.saveConfig({ proactive: { research: { enabled: true } }, search: { enabled: true, order: ['scrape'] } })
  output = modelOutput
  streamTools = false
  requests = 0
  pageReads = 0
  pageText = quote
}
async function sourceMessage(content, role = 'user') {
  const conv = await store.createConversation()
  const message = { id: `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, role, content }
  await store.appendMessage(conv.id, message)
  return { conversationId: conv.id, messageId: message.id }
}
const caseGoal = () => ({ ...scoped(), deadline: null })

try {
  await test('date qualification requires actual official-source quote, full case identity, stage and calendar date', () => {
    const result = deadlines.assessDeadlineClaims([claim], evidence, caseGoal())
    assert.equal(result.status, 'verified')
    assert.equal(result.date, '2027-01-20')
    assert.equal(result.claims[0].time, undefined)
    for (const patch of [
      { quote: 'Invented date 2027-01-20' }, { date: '2027-02-30' }, { cycle: '2026' }, { program: 'MBA' },
      { stage: 'payment' }, { stage: '' }, { quote: '2027-01-20' }, { time: '23:59', timezone: 'UTC' },
    ]) assert.equal(deadlines.assessDeadlineClaims([{ ...claim, ...patch }], evidence, caseGoal()).status, 'unverified')
    assert.equal(deadlines.assessDeadlineClaims([claim], evidence, { ...caseGoal(), situation: { ...identity, stage: '' } }).status, 'unverified')
    assert.equal(deadlines.assessDeadlineClaims([claim], evidence.map((item) => ({ ...item, source: 'https://unapproved.example/registration' })), caseGoal()).status, 'unverified')
    assert.equal(deadlines.assessDeadlineClaims([claim], evidence.map((item) => ({ ...item, authority: 'unverified' })), caseGoal()).status, 'unverified')
  })

  await test('conflicting dates remain unresolved and never replace a user-set deadline', () => {
    const otherQuote = quote.replace('2027-01-20', '2027-01-21')
    const otherEvidence = { ...evidence[0], id: 'web2', excerpt: otherQuote }
    const otherClaim = { ...claim, evidenceId: 'web2', quote: otherQuote, date: '2027-01-21' }
    const conflict = deadlines.assessDeadlineClaims([claim, otherClaim], [...evidence, otherEvidence], caseGoal())
    assert.equal(conflict.status, 'conflicting')
    assert.equal(conflict.date, null)
    assert.ok(conflict.claims.every((item) => item.status === 'conflicting'))
    assert.equal(deadlines.assessDeadlineClaims([claim], evidence, { ...caseGoal(), deadline: '2027-01-19', deadlineOrigin: 'user' }).status, 'conflicting')
  })

  await test('verified clock times require explicit timezone and control milestone timing in that timezone', () => {
    const timedQuote = `${quote} Closes at 17:00 UTC+08:00.`
    const timedClaim = { ...claim, quote: timedQuote, time: '17:00', timezone: 'UTC+08:00' }
    const timedEvidence = [{ ...evidence[0], excerpt: timedQuote }]
    const assessment = deadlines.assessDeadlineClaims([timedClaim], timedEvidence, caseGoal())
    assert.equal(assessment.status, 'verified')
    const goal = { deadline: claim.date, deadlineOrigin: 'research', deadlineAssessment: assessment, deadlineVersion: assessment.version }
    assert.equal(deadlines.deadlineMilestone(goal, new Date('2027-01-20T08:59:00Z')).stage, 'today')
    assert.equal(deadlines.deadlineMilestone(goal, new Date('2027-01-20T09:00:00Z')).stage, 'overdue')
    const otherQuote = `${quote} Closes at 18:00 UTC+08:00.`
    const conflict = deadlines.assessDeadlineClaims([timedClaim, { ...timedClaim, quote: otherQuote, time: '18:00', evidenceId: 'web2' }], [...timedEvidence, { ...evidence[0], id: 'web2', excerpt: otherQuote }], caseGoal())
    assert.equal(conflict.status, 'conflicting')
    const revised = deadlines.assessDeadlineClaims([{ ...timedClaim, quote: otherQuote, time: '18:00' }], [{ ...evidence[0], excerpt: otherQuote }], caseGoal())
    assert.notEqual(assessment.version, revised.version)
  })

  await test('equivalent source identifiers do not create new deadline versions; footer changes do not create new facts', () => {
    const first = deadlines.assessDeadlineClaims([claim], evidence, caseGoal())
    const renumbered = deadlines.assessDeadlineClaims([{ ...claim, evidenceId: 'web7' }], [{ ...evidence[0], id: 'web7' }], caseGoal())
    assert.equal(first.version, renumbered.version)
    const one = deadlines.relevantSourceFingerprint(caseGoal(), { excerpt: `${quote}\nCopyright 2025\nPrivacy policy` })
    const two = deadlines.relevantSourceFingerprint(caseGoal(), { excerpt: `${quote}\nCopyright 2026\nPrivacy policy` })
    assert.equal(one, two)
    assert.notEqual(one, deadlines.relevantSourceFingerprint(caseGoal(), { excerpt: quote.replace('2027-01-20', '2027-01-21') }))
    assert.equal(deadlines.deadlineMilestone({ deadline: '2027-01-20' }, new Date(2027, 0, 18, 12)).stage, 'soon')
    assert.equal(deadlines.deadlineMilestone({ deadline: '2027-01-20' }, new Date(2027, 0, 20, 12)).stage, 'today')
    assert.equal(deadlines.deadlineMilestone({ deadline: '2027-01-20', deadlineOrigin: 'research', deadlineAssessment: { status: 'unverified' } }, new Date(2027, 0, 20)), null)
  })

  await test('scope paths are bounded and cannot escape or follow symlinks; unsupported background fields fail', async () => {
    await reset()
    const goal = await engine.createCommitment(scoped({ scope: { research: true, folders: ['allowed'], documents: ['document_one'], officialDomains: ['EXAMPLE.EDU'] } }))
    assert.deepEqual(goal.scope.folders, ['allowed'])
    assert.deepEqual(goal.scope.officialDomains, ['example.edu'])
    for (const scope of [
      { research: 'yes' }, { research: true, folders: ['../outside'] }, { research: true, folders: ['/tmp'] },
      { research: true, folders: ['escape'] }, { research: true, folders: Array(4).fill('allowed') },
      { research: true, documents: ['../secret'] }, { research: true, officialDomains: ['https://example.edu'] },
      { research: true, shell: true }, { folders: ['allowed'] },
    ]) await assert.rejects(engine.createCommitment(goalInput({ scope })))
  })

  await test('discovered cases dereference user evidence, retain provenance and dedupe terminal cases', async () => {
    await reset()
    const message = `I cannot finish ${identity.institution} ${identity.program} ${identity.cycle} ${identity.category} ${identity.stage}.`
    const source = await sourceMessage(message)
    const input = goalInput({ situation: identity, scope: { research: true, officialDomains: ['evil.example'], folders: ['allowed'] } })
    const discovered = await engine.discoverCommitment(input, { source, confidence: 0.9, quote: message })
    assert.equal(discovered.origin, 'discovered')
    assert.equal(discovered.discovery.adopted, false)
    assert.deepEqual(discovered.scope, { memory: false, urls: [], research: true })
    assert.deepEqual(discovered.discovery.source, source)
    await assert.rejects(engine.discoverCommitment(input, { source, confidence: 0.9, quote: 'Invented message' }), { status: 400 })
    await assert.rejects(engine.discoverCommitment(input, { source: await sourceMessage(message, 'assistant'), confidence: 0.9, quote: message }), { status: 400 })
    await engine.updateCommitment(discovered.id, { status: 'cancelled' })
    assert.equal((await engine.discoverCommitment(input, { source: await sourceMessage(message), confidence: 0.95, quote: message })).id, discovered.id)
    assert.equal((await engine.listCommitments()).commitments.length, 1)
    assert.equal((await store.readState()).unrelated.preserve, true)
    await config.saveConfig({ proactive: { research: { enabled: false } } })
    await assert.rejects(engine.discoverCommitment(input, { source, confidence: 0.9, quote: message }), { status: 403 })
  })

  await test('adoption and updates are revision-safe; unadopted cases expire without executing research', async () => {
    await reset()
    const message = 'I cannot finish registration.'
    const source = await sourceMessage(message)
    const discovered = await engine.discoverCommitment(goalInput(), { source, confidence: 0.9, quote: message })
    const adopted = await engine.updateCommitment(discovered.id, { adopt: true, expectedRevision: 1 })
    assert.equal(adopted.discovery.adopted, true)
    assert.equal(adopted.revision, 2)
    await assert.rejects(engine.updateCommitment(discovered.id, { blocker: 'changed', expectedRevision: 1 }), { status: 409 })
    await engine.updateCommitment(discovered.id, { status: 'paused' })
    const second = await engine.discoverCommitment(goalInput({ title: 'Different task' }), { source: await sourceMessage('Different task is blocked.'), confidence: 0.8, quote: 'Different task is blocked.' })
    await store.mutateState((state) => { state.commitments.find((item) => item.id === second.id).discovery.expiresAt = '2000-01-01T00:00:00Z' })
    await engine.prepareDueCommitments()
    assert.equal((await engine.listCommitments()).commitments.find((item) => item.id === second.id).status, 'cancelled')
    assert.equal(requests, 0)
  })

  await test('completion requires a grounded affirmative message and stops pending reminders', async () => {
    await reset()
    const source = await sourceMessage('Registration is blocked.')
    const goal = await engine.createCommitment(goalInput({ source }))
    for (const content of ['I have not completed registration.', 'I will finish registration tomorrow.', 'My friend said I completed registration.', 'I submitted the application; payment is still pending.', '我尚未完成报名。', '她说“已经完成报名”。', '我已经提交了申请，但还需缴费。']) {
      const reference = await sourceMessage(content)
      await assert.rejects(engine.completeCommitmentFromMessage(goal.id, { ...reference, quote: content, expectedRevision: goal.revision }), { status: 400 })
    }
    const content = 'I completed registration and received confirmation.'
    await store.appendMessage(source.conversationId, { id: 'message_done', role: 'user', content })
    await assert.rejects(engine.completeCommitmentFromMessage(goal.id, { conversationId: source.conversationId, messageId: 'message_done', quote: content, expectedRevision: 99 }), { status: 409 })
    const negatedContent = 'I completed registration? No, I have not.'
    await store.appendMessage(source.conversationId, { id: 'message_negative_context', role: 'user', content: negatedContent })
    await assert.rejects(engine.completeCommitmentFromMessage(goal.id, { conversationId: source.conversationId, messageId: 'message_negative_context', quote: 'I completed registration', expectedRevision: goal.revision }), { status: 400 })
    const done = await engine.completeCommitmentFromMessage(goal.id, { conversationId: source.conversationId, messageId: 'message_done', quote: content, expectedRevision: goal.revision })
    assert.equal(done.status, 'done')
    assert.equal(done.watch.nextCheckAt, null)
    assert.equal(done.completionSource.messageId, 'message_done')
    assert.deepEqual(await engine.pendingPreparations(), [])
  })

  await test('ambiguous completion cannot select one of multiple active goals in a conversation', async () => {
    await reset()
    const source = await sourceMessage('Registration and housing are blocked.')
    const goal = await engine.createCommitment(goalInput({ source }))
    await engine.createCommitment(goalInput({ title: 'Find housing', source }))
    await store.appendMessage(source.conversationId, { id: 'message_ambiguous_done', role: 'user', content: 'I am done.' })
    await assert.rejects(engine.completeCommitmentFromMessage(goal.id, { conversationId: source.conversationId, messageId: 'message_ambiguous_done', quote: 'I am done.', expectedRevision: goal.revision }), { status: 400 })
  })

  await test('failed deadline preparation retains its milestone and retries after bounded backoff', async () => {
    await reset()
    const date = new Date().toISOString().slice(0, 10)
    const goal = await engine.createCommitment(goalInput({ deadline: date, scope: { urls: [pageUrl] }, watch: { type: 'combined' } }))
    output = () => ({ ...modelOutput(), evidenceIds: ['web99'] })
    const failed = await engine.prepareDueCommitments()
    assert.equal(failed.failed.length, 1)
    let current = (await engine.listCommitments()).commitments[0]
    assert.equal(current.watch.deadlineTriggered, undefined)
    assert.equal(current.watch.fingerprints, undefined)
    assert.ok(Date.parse(current.preparation.retryAt) > Date.now())
    await engine.prepareDueCommitments()
    assert.equal(requests, 1)
    await store.mutateState((state) => {
      state.commitments[0].preparation.retryAt = '2000-01-01T00:00:00Z'
      state.commitments[0].watch.nextCheckAt = '2000-01-01T00:00:00Z'
    })
    output = modelOutput
    assert.equal((await engine.prepareDueCommitments()).prepared.length, 1)
    current = (await engine.listCommitments()).commitments.find((item) => item.id === goal.id)
    assert.equal(current.watch.deadlineTriggered, date)
    assert.ok(Object.keys(current.watch.deadlineMilestones).length)
    assert.ok(current.watch.fingerprints[pageUrl])
  })

  await test('research uses bounded tools, persists qualified date and holds stale or failed-watch delivery', async () => {
    await reset()
    streamTools = true
    output = () => ({ ...modelOutput(), content: `${quote} [web1]`, evidenceIds: ['web1'], deadlineClaims: [claim] })
    const goal = await engine.createCommitment(scoped())
    const result = await engine.prepareDueCommitments()
    assert.equal(result.failed.length, 0, JSON.stringify(result))
    assert.equal(result.prepared.length, 1)
    const current = (await engine.listCommitments()).commitments.find((item) => item.id === goal.id)
    assert.equal(current.deadline, '2027-01-20')
    assert.equal(current.deadlineOrigin, 'research')
    assert.equal(current.deadlineAssessment.status, 'verified')
    const [artifact] = await engine.pendingPreparations()
    assert.ok(artifact.runId)
    assert.ok(artifact.semanticFingerprint)
    await store.mutateState((state) => { state.commitments[0].watch.nextCheckAt = '2000-01-01T00:00:00Z' })
    assert.deepEqual(await engine.pendingPreparations(), [])
    assert.equal(await engine.markPreparationDelivered(artifact.id, { conversationId: 'main', messageId: 'message_stale' }), null)
    await engine.prepareDueCommitments()
    assert.equal((await engine.pendingPreparations()).length, 1)
    await store.mutateState((state) => { state.commitments[0].watch.lastError = 'offline' })
    assert.deepEqual(await engine.pendingPreparations(), [])
    const changed = await engine.updateCommitment(goal.id, { deadline: '2027-02-01' })
    assert.equal(changed.deadlineOrigin, 'user')
  })

  await test('known folder-file changes trigger combined watches even with an unchanged web source', async () => {
    await reset()
    await fs.writeFile(path.join(workspace, 'allowed', 'notes.txt'), 'Registration checklist version one.')
    streamTools = 'both'
    await engine.createCommitment(scoped({ scope: { research: true, urls: [pageUrl], folders: ['allowed'], officialDomains: ['8.8.8.8'] } }))
    assert.equal((await engine.prepareDueCommitments()).prepared.length, 1)
    let current = (await engine.listCommitments()).commitments[0]
    assert.deepEqual(current.watch.fileSources, ['workspace:allowed/notes.txt'])
    await fs.writeFile(path.join(workspace, 'allowed', 'notes.txt'), 'Registration checklist version two; transcript now required.')
    await store.mutateState((state) => { state.commitments[0].watch.nextCheckAt = '2000-01-01T00:00:00Z' })
    assert.equal((await engine.prepareDueCommitments()).prepared.length, 1)
    assert.equal((await engine.pendingPreparations())[0].trigger, 'source_changed')
    current = (await engine.listCommitments()).commitments[0]
    assert.equal(current.watch.lastError, null)
  })

  await test('manual research source freshness is rechecked and network disable blocks reads and delivery', async () => {
    await reset()
    streamTools = true
    await engine.createCommitment(scoped({ watch: { type: 'manual' } }))
    assert.equal((await engine.prepareDueCommitments()).prepared.length, 1)
    assert.equal((await engine.pendingPreparations()).length, 1)
    await store.mutateState((state) => { state.commitments[0].watch.nextCheckAt = '2000-01-01T00:00:00Z' })
    assert.deepEqual(await engine.pendingPreparations(), [])
    await config.saveConfig({ search: { enabled: false } })
    const readsBefore = pageReads
    const requestsBefore = requests
    await engine.prepareDueCommitments()
    assert.equal(pageReads, readsBefore)
    assert.equal(requests, requestsBefore)
    assert.match((await engine.listCommitments()).commitments[0].watch.lastError, /关闭/)
    assert.deepEqual(await engine.pendingPreparations(), [])
  })

  await test('an unresolved identity question waits for user clarification instead of repeated research', async () => {
    await reset()
    output = () => ({ ...modelOutput(), question: 'Which program and application cycle?' })
    const goal = await engine.createCommitment(goalInput({ scope: { research: true }, watch: { type: 'combined' } }))
    assert.equal((await engine.prepareDueCommitments()).prepared.length, 1)
    await store.mutateState((state) => { state.commitments[0].watch.nextCheckAt = '2000-01-01T00:00:00Z' })
    await engine.prepareDueCommitments()
    assert.equal(requests, 1)
    assert.equal((await engine.listCommitments()).commitments[0].watch.awaitingClarification, true)
    await engine.updateCommitment(goal.id, { situation: identity })
    assert.equal((await engine.prepareDueCommitments()).prepared.length, 1)
    assert.equal(requests, 2)
  })

  await test('requested work is prepared before older routine refreshes when the daily budget is limited', async () => {
    await reset()
    for (let i = 0; i < 5; i++) await engine.createCommitment(goalInput({ title: `Routine ${i}` }))
    await store.mutateState((state) => { for (const goal of state.commitments) goal.preparation.reason = 'research_refresh' })
    const requested = await engine.createCommitment(goalInput({ title: 'Requested now' }))
    await engine.requestPreparation(requested.id)
    const result = await engine.prepareDueCommitments()
    assert.equal(result.prepared.length, 5)
    assert.equal(result.budgetDeferred, 1)
    assert.equal((await engine.listCommitments()).preparations[0].commitmentId, requested.id)
  })
} finally {
  globalThis.fetch = originalFetch
  engine.cancelCommitmentWork()
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(sandbox, { recursive: true, force: true })
}
