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
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-relationship-api-'))
const configPath = path.join(sandbox, 'config.json')
const requests = []
let modelPlan = null
const mock = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer relationship-fixture-key')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture conversation' } }] }))
    }
    requests.push(body)
    const delta = await modelPlan?.(body) ?? { content: 'Here is a clear, considerate reply.' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const reservation = http.createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
await fs.writeFile(configPath, JSON.stringify({
  bind: 'local', requirePassword: false, onboarding: { completed: true },
  upstream: {
    apiKeyEnv: 'ECHO_RELATIONSHIP_TEST_KEY', baseUrlEnv: 'ECHO_RELATIONSHIP_TEST_URL',
    defaultModel: 'fixture', utilityModel: 'fixture', models: [{ id: 'fixture', label: 'Fixture' }],
  },
  memory: { enabled: true, inject: true, extract: false, digestEvery: 100 },
  search: { enabled: false }, screen: { enabled: false }, companion: { enabled: false },
  dream: { enabled: false }, proactive: { enabled: false, notify: false }, mcpServers: {},
}))

let app
let logs = ''
let cookie = ''
async function startApp() {
  logs = ''
  app = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ECHO_DATA_DIR: sandbox, ECHO_CONFIG: configPath, ECHO_BIND: 'local', ECHO_PORT: String(port),
      ECHO_RELATIONSHIP_TEST_KEY: 'relationship-fixture-key',
      ECHO_RELATIONSHIP_TEST_URL: `http://127.0.0.1:${mock.address().port}/v1`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-12000) })
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if (app.exitCode !== null) throw new Error(`Fixture exited: ${logs}`)
    if (await fetch(`${base}/api/health`).then((res) => res.ok).catch(() => false)) return
    await delay(40)
  }
  throw new Error(`Fixture did not start: ${logs}`)
}
async function stopApp() {
  if (!app || app.exitCode !== null || app.signalCode) return
  const child = app
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(timer) }
}
async function api(route, { method = 'GET', body, csrf = true, auth = true } = {}) {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: {
      ...(csrf ? { 'x-echo-request': 'echo' } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth && cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
  return { status: response.status, body: await response.json(), headers: response.headers }
}
async function chat(text, conversationId) {
  if (!conversationId) conversationId = (await api('conversations', { method: 'POST', body: { title: 'Relationship fixture' } })).body.id
  const before = requests.length
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'x-echo-request': 'echo', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ conversationId, userText: text }),
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, 200)
  const wire = await response.text()
  assert.match(wire, /event: done/)
  assert.doesNotMatch(wire, /event: error/)
  return { conversationId, requests: requests.slice(before), wire }
}
const system = (body) => body.messages.find((message) => message.role === 'system').content
const personInput = {
  name: 'Alex Chen', aliases: ['Alex'], relationship: 'colleague',
  context: 'ALEX_CONTEXT_SENTINEL: prefers a concise written proposal before meetings.',
  boundaries: 'ALEX_BOUNDARY_SENTINEL: keep family details out of work messages.',
}
let alex
let bo

try {
  await startApp()
  await test('relationship APIs validate manual inputs and require existing write protection', async () => {
    const initial = await api('relationships')
    assert.equal(initial.body.profile.tone, 'subtle')
    assert.equal(initial.body.profile.support, 'balanced')
    assert.deepEqual(initial.body.people, [])
    assert.equal((await api('relationships/profile', { method: 'PATCH', body: { tone: 'warm' }, csrf: false })).status, 403)
    for (const body of [null, [], { tone: 'clingy' }, { support: 'therapy' }, { harness: { allowShell: true } }, { boundaries: 'x'.repeat(601) }]) {
      assert.equal((await api('relationships/profile', { method: 'PATCH', body })).status, 400)
    }
    for (const body of [{ name: '' }, { name: 'Alex', source: 'model' }, { name: 'Alex', aliases: ['A'] }, { name: 'Alex', context: 'x'.repeat(1201) }]) {
      assert.equal((await api('relationships/people', { method: 'POST', body })).status, 400)
    }
    assert.equal(requests.length, 0, 'managing preferences makes no model request')
    assert.equal((await api('settings')).body.config.harness.enabled, false)
  })

  await test('profile and people are explicit, editable, duplicate-safe and persisted', async () => {
    const profile = await api('relationships/profile', { method: 'PATCH', body: {
      tone: 'subtle', support: 'listen', preferredName: 'NAME_SENTINEL', boundaries: 'PROFILE_BOUNDARY_SENTINEL: no pet names.',
    } })
    assert.equal(profile.status, 200)
    assert.equal(profile.body.profile.support, 'listen')
    alex = (await api('relationships/people', { method: 'POST', body: personInput })).body.person
    bo = (await api('relationships/people', { method: 'POST', body: { name: 'Bo Lin', context: 'BO_CONTEXT_SENTINEL' } })).body.person
    assert.equal(alex.source, 'user')
    assert.equal((await api('relationships/people', { method: 'POST', body: { name: 'Someone Else', aliases: ['alex'] } })).status, 409)
    assert.equal((await api(`relationships/people/${alex.id}`, { method: 'PATCH', body: { relationship: 'project colleague' } })).status, 200)
    const saved = JSON.parse(await fs.readFile(path.join(sandbox, 'state.json'), 'utf8')).relationship
    assert.equal(saved.people.length, 2)
    assert.equal(saved.profile.preferredName, 'NAME_SENTINEL')
    assert.equal(requests.length, 0)
  })

  await test('real chat requests use only relevant people and conservatively resolve a short follow-up', async () => {
    const first = await chat('Help me draft a reply to Alex.')
    assert.equal(first.requests.length, 1, 'relationship support adds no model pass')
    assert.match(system(first.requests[0]), /ALEX_CONTEXT_SENTINEL/)
    assert.match(system(first.requests[0]), /NAME_SENTINEL/)
    assert.doesNotMatch(system(first.requests[0]), /BO_CONTEXT_SENTINEL/)
    assert.match(system(first.requests[0]), /明确要求解决问题或执行任务时照常完成/)
    const followup = await chat('Make it shorter.', first.conversationId)
    assert.match(system(followup.requests[0]), /ALEX_CONTEXT_SENTINEL/)
    const unrelated = await chat('Explain binary search.', first.conversationId)
    assert.doesNotMatch(system(unrelated.requests[0]), /ALEX_CONTEXT_SENTINEL|BO_CONTEXT_SENTINEL/)
    assert.ok(!unrelated.requests[0].tools.some((tool) => /relationship|emotion/.test(tool.function.name)), 'the model cannot write relationship profiles')
  })

  await test('emotion stays conversational and does not create a stored mood or a person record', async () => {
    const before = (await api('relationships')).body
    const turn = await chat('I feel overwhelmed today. Please just listen for a moment.')
    assert.match(system(turn.requests[0]), /不建立情绪档案/)
    assert.match(system(turn.requests[0]), /不主动做情绪打卡/)
    assert.deepEqual((await api('relationships')).body, before)
    const state = JSON.parse(await fs.readFile(path.join(sandbox, 'state.json'), 'utf8'))
    assert.equal(state.relationship.mood, undefined)
    assert.equal(state.relationship.emotion, undefined)
  })

  await test('profile disable and both existing memory gates suppress saved personal context', async () => {
    await api('relationships/profile', { method: 'PATCH', body: { enabled: false } })
    let turn = await chat('Help me reply to Alex.')
    assert.doesNotMatch(system(turn.requests[0]), /ALEX_CONTEXT_SENTINEL|NAME_SENTINEL|PROFILE_BOUNDARY_SENTINEL/)
    assert.equal((await api('relationships')).body.people.length, 2, 'disable preserves user-managed records')
    await api('relationships/profile', { method: 'PATCH', body: { enabled: true } })
    for (const memory of [{ enabled: true, inject: false }, { enabled: false, inject: true }]) {
      await api('settings', { method: 'PATCH', body: { config: { memory } } })
      turn = await chat('Help me reply to Alex.')
      assert.doesNotMatch(system(turn.requests[0]), /ALEX_CONTEXT_SENTINEL|NAME_SENTINEL|PROFILE_BOUNDARY_SENTINEL/)
    }
    await api('settings', { method: 'PATCH', body: { config: { memory: { enabled: true, inject: true } } } })
  })

  await test('deleting background during a tool turn removes it from the next request without stopping work', async () => {
    let round = 0
    modelPlan = async (body) => {
      round++
      if (round === 1) {
        assert.match(system(body), /ALEX_CONTEXT_SENTINEL/)
        assert.equal((await api(`relationships/people/${alex.id}`, { method: 'DELETE' })).status, 200)
        return { tool_calls: [{ index: 0, id: 'time_after_context_removal', type: 'function', function: { name: 'local_time', arguments: '{}' } }] }
      }
      assert.doesNotMatch(system(body), /ALEX_CONTEXT_SENTINEL|ALEX_BOUNDARY_SENTINEL/)
      return { content: 'The requested task is complete.' }
    }
    try {
      const turn = await chat('Help me reply to Alex and check the current time.')
      assert.equal(turn.requests.length, 2)
      assert.match(turn.wire, /event: tool_result/)
      const conv = (await api(`conversations/${turn.conversationId}`)).body
      assert.equal(conv.messages.at(-1).tools[0].ok, true)
      assert.notEqual(conv.messages.at(-1).aborted, true)
    } finally { modelPlan = null }
    assert.equal((await api(`relationships/people/${alex.id}`, { method: 'DELETE' })).status, 404)
  })

  await test('restart and backup preserve only the chosen relationship data', async () => {
    const before = (await api('relationships')).body
    await stopApp()
    await startApp()
    assert.deepEqual((await api('relationships')).body, before)
    const backup = await api('backup')
    assert.deepEqual(backup.body.relationship, before)
    assert.equal(backup.body.relationship.people[0].id, bo.id)
    assert.doesNotMatch(JSON.stringify(backup.body.relationship), /relationship-fixture-key/)
  })

  await test('relationship data follows authentication and memory wipe removes profile and people', async () => {
    await api('password', { method: 'POST', body: { next: 'fixture-password-only' } })
    await api('auth', { method: 'PATCH', body: { required: true } })
    assert.equal((await api('relationships', { auth: false })).status, 401)
    const login = await api('login', { method: 'POST', body: { password: 'fixture-password-only' } })
    cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await api('relationships')).status, 200)
    assert.equal((await api('memory/wipe', { method: 'POST', body: { confirm: 'WIPE', scope: 'memory' } })).status, 200)
    const cleared = (await api('relationships')).body
    assert.deepEqual(cleared.people, [])
    assert.equal(cleared.profile.preferredName, '')
    assert.equal(cleared.profile.boundaries, '')
    const turn = await chat('Help me draft a note to Bo Lin.')
    assert.doesNotMatch(system(turn.requests[0]), /BO_CONTEXT_SENTINEL|NAME_SENTINEL|PROFILE_BOUNDARY_SENTINEL/)
  })
} finally {
  modelPlan = null
  await stopApp()
  mock.closeAllConnections()
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(sandbox, { recursive: true, force: true })
}
