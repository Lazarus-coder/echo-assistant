import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-commitments-api-'))
const configPath = path.join(sandbox, 'config.json')
const modelRequests = []
const mock = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer local-api-test-key')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    modelRequests.push(body)
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Let us prepare the proposal.' } }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: 'Proposal preparation',
      content: '## Reviewable outline\n\n- Explain the audience and intended decision. [goal1]\n- Suggested next step: add the missing project detail.',
      evidenceIds: ['goal1'], assumptions: ['The audience is still to be confirmed.'], question: 'Who will review the proposal?',
    }) } }] }))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const reservation = http.createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const appPort = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const base = `http://127.0.0.1:${appPort}`
const modelBase = `http://127.0.0.1:${mock.address().port}/v1`
await fs.writeFile(configPath, JSON.stringify({
  bind: 'local', requirePassword: false, onboarding: { completed: true },
  upstream: {
    apiKeyEnv: 'ECHO_API_TEST_KEY', baseUrlEnv: 'ECHO_API_TEST_URL',
    defaultModel: 'local-test', utilityModel: 'local-test', models: [{ id: 'local-test', label: 'Local test' }],
  },
  memory: { enabled: false, extract: false, inject: false },
  search: { enabled: false }, screen: { enabled: false }, companion: { enabled: false },
  dream: { enabled: false }, proactive: { enabled: false, notify: false }, mcpServers: {},
}))

let app
let logs = ''
async function waitUntil(check, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await delay(40)
  }
  throw new Error(`Timed out waiting for ${label}.\n${logs.slice(-2000)}`)
}

async function startApp() {
  logs = ''
  app = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ECHO_DATA_DIR: sandbox, ECHO_CONFIG: configPath, ECHO_BIND: 'local', ECHO_PORT: String(appPort),
      ECHO_API_TEST_KEY: 'local-api-test-key', ECHO_API_TEST_URL: modelBase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000) })
  app.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000) })
  await waitUntil(async () => {
    if (app.exitCode !== null) throw new Error(`Test server exited: ${logs}`)
    return fetch(`${base}/api/health`).then((res) => res.ok).catch(() => false)
  }, 'test server startup')
}

async function stopApp() {
  if (!app || app.exitCode !== null || app.signalCode) return
  const child = app
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(timer) }
}

async function api(route, { method = 'GET', body, csrf = true, raw } = {}) {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: { ...(csrf ? { 'x-echo-request': 'echo' } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
  return { status: response.status, body: await response.json() }
}

let conversationId
let userMessageId
let goal
let artifact
const request = (extra = {}) => ({
  title: 'Finish the proposal',
  successCriteria: 'A reviewable proposal with an audience, decision and next action',
  nextAction: 'Prepare a concrete outline',
  scope: { memory: false, urls: [] }, watch: { type: 'manual' }, ...extra,
})

try {
  await startApp()
  await test('commitment APIs reject cross-site writes, malformed input and nonexistent source references', async () => {
    assert.equal((await api('commitments', { method: 'POST', body: request(), csrf: false })).status, 403)
    assert.equal((await api('commitments', { method: 'POST', raw: '{broken' })).status, 400)
    assert.equal((await api('commitments', { method: 'POST', body: request({ title: '' }) })).status, 400)
    assert.equal((await api('commitments', { method: 'POST', body: request({ deadline: '2026-02-30' }) })).status, 400)
    assert.equal((await api('commitments', { method: 'POST', body: request({ source: { conversationId: 'missing_conversation', messageId: 'missing_message' } }) })).status, 400)
    assert.equal((await api('commitments/goal_missing', { method: 'PATCH', body: { status: 'paused' } })).status, 404)
    assert.equal((await api('commitments')).body.commitments.length, 0)
    assert.equal(modelRequests.length, 0)
  })

  await test('an actual user message can become a commitment with server-validated provenance', async () => {
    const created = await api('conversations', { method: 'POST', body: { title: 'Proposal source' } })
    assert.equal(created.status, 200)
    conversationId = created.body.id
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'x-echo-request': 'echo', 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, userText: 'Help me finish the proposal.' }),
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(chat.status, 200)
    assert.match(await chat.text(), /event: done/)
    const conversation = (await api(`conversations/${conversationId}`)).body
    userMessageId = conversation.messages.find((m) => m.role === 'user').id
    const accepted = await api('commitments', { method: 'POST', body: request({
      source: { conversationId, messageId: userMessageId, excerpt: 'FORGED CLIENT SOURCE' },
    }) })
    assert.equal(accepted.status, 201)
    goal = accepted.body.commitment
    assert.equal(goal.status, 'active')
    assert.equal(goal.source.excerpt, 'Help me finish the proposal.')
    assert.equal(goal.source.messageId, userMessageId)
  })

  await test('accepted work prepares automatically even when proactive interruptions are disabled', async () => {
    assert.equal((await api('settings')).body.config.proactive.enabled, false)
    artifact = await waitUntil(async () => {
      const state = (await api('commitments')).body
      const current = state.commitments.find((c) => c.id === goal.id)
      if (current?.preparation.state === 'failed') throw new Error(current.preparation.error)
      return state.preparations.find((p) => p.commitmentId === goal.id)
    }, 'automatic scoped preparation')
    assert.match(artifact.content, /\[goal1\]/)
    assert.equal(artifact.delivery.status, 'pending')
    assert.equal(artifact.verification.factualAccuracy, 'not_independently_verified')
    const calls = modelRequests.filter((r) => !r.stream)
    assert.equal(calls.length, 1)
    const evidence = JSON.parse(calls[0].messages[1].content).evidence
    assert.equal(evidence.find((e) => e.id === 'message1').excerpt, 'Help me finish the proposal.')
    assert.equal(evidence.some((e) => e.id.startsWith('memory') || e.id.startsWith('web')), false)
    const main = (await api('conversations/main')).body
    assert.equal(main.messages.length, 0, 'quiet preparation must not insert an interruption')
    const disk = JSON.parse(await fs.readFile(path.join(sandbox, 'state.json'), 'utf8'))
    assert.equal(disk.preparations.find((p) => p.id === artifact.id).content, artifact.content)
  })

  await test('outcome feedback requires matching identity and corrections replace the current vote', async () => {
    const mismatched = await api('feedback', { method: 'POST', body: { preparationId: artifact.id, commitmentId: 'goal_wrong', signal: 'accepted' } })
    assert.equal(mismatched.body.ignored, 'mismatched_commitment')
    const ordinary = await api('feedback', { method: 'POST', body: { conversationId, messageId: userMessageId, signal: 'accepted' } })
    assert.equal(ordinary.body.ignored, 'not_an_intervention')
    const vote = (signal) => api('feedback', { method: 'POST', body: { preparationId: artifact.id, commitmentId: goal.id, signal } })
    const accepted = await vote('accepted')
    assert.equal(accepted.body.outcome.commitmentId, goal.id)
    assert.equal(accepted.body.agency.outcomes.accepted, 1)
    assert.equal((await vote('accepted')).body.duplicate, true)
    assert.equal((await vote('incorrect')).body.agency.outcomes.incorrect, 1)
    const corrected = await vote('accepted')
    assert.equal(corrected.body.duplicate, undefined)
    assert.equal(corrected.body.agency.outcomes.accepted, 1)
    assert.equal(corrected.body.agency.outcomes.incorrect, 0)
    const timing = await vote('wrong_time')
    assert.equal(timing.body.agency.outcomes.accepted, 1, 'timing feedback preserves usefulness')
    assert.equal(timing.body.agency.outcomes.wrong_time, 1)
    const updated = (await api('commitments')).body
    assert.equal(updated.preparations.find((p) => p.id === artifact.id).outcome.signal, 'accepted')
    assert.equal(updated.commitments.find((c) => c.id === goal.id).status, 'active', 'accepted work does not silently finish the goal')
  })

  await test('pausing rejects more preparation and completing requires explicit completion evidence', async () => {
    const paused = await api(`commitments/${goal.id}`, { method: 'PATCH', body: { status: 'paused' } })
    assert.equal(paused.status, 200)
    assert.equal(paused.body.commitment.status, 'paused')
    assert.equal((await api(`commitments/${goal.id}/prepare`, { method: 'POST', body: {} })).status, 409)
    assert.equal((await api(`commitments/${goal.id}`, { method: 'PATCH', body: { status: 'done' } })).status, 400)
    const completed = await api(`commitments/${goal.id}`, { method: 'PATCH', body: {
      status: 'done', completionEvidence: 'The proposal was reviewed and approved.',
    } })
    assert.equal(completed.status, 200)
    assert.equal(completed.body.commitment.completionEvidence, 'The proposal was reviewed and approved.')
    assert.equal(modelRequests.filter((r) => !r.stream).length, 1)
  })

  await test('backup includes entrusted goals, artifacts and budget accounting without credentials', async () => {
    const backup = await api('backup')
    assert.equal(backup.status, 200)
    assert.equal(backup.body.commitments.find((c) => c.id === goal.id).status, 'done')
    assert.equal(backup.body.preparations.find((p) => p.id === artifact.id).content, artifact.content)
    assert.equal(backup.body.commitmentWork.runs.length, 1)
    assert.equal(backup.body.agencyOutcomes[`preparation:${artifact.id}`].utility, 'accepted')
    assert.equal(JSON.stringify(backup.body).includes('local-api-test-key'), false)
  })

  await test('server restart preserves goals, preparation contents and outcomes without duplicate work', async () => {
    const before = (await api('commitments')).body
    const callCount = modelRequests.length
    await stopApp()
    await startApp()
    const after = (await api('commitments')).body
    assert.deepEqual(after, before)
    assert.equal(modelRequests.length, callCount)
    assert.equal((await api('agency')).body.outcomes.accepted, 1)
  })

  await test('explicit memory wipe removes durable goals, artifacts, budgets and learned outcomes', async () => {
    assert.equal((await api('memory/wipe', { method: 'POST', body: { confirm: 'no' } })).status, 400)
    assert.equal((await api('commitments')).body.commitments.length, 1)
    const wiped = await api('memory/wipe', { method: 'POST', body: { confirm: 'WIPE', scope: 'memory' } })
    assert.equal(wiped.status, 200)
    assert.deepEqual((await api('commitments')).body, { commitments: [], preparations: [] })
    const backup = (await api('backup')).body
    assert.deepEqual(backup.commitmentWork.runs, [])
    assert.deepEqual(backup.agencyOutcomes, {})
    assert.equal((await api(`conversations/${conversationId}`)).body.messages.length, 2, 'memory-only wipe preserves conversation history')
  })
} finally {
  await stopApp()
  mock.closeAllConnections()
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(sandbox, { recursive: true, force: true })
}
