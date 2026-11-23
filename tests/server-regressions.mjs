import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-server-'))
const install = path.join(sandbox, 'Library', 'Application Support', 'Echo')
const dataDir = path.join(install, 'data')
let app
let logs = ''
const requestsFile = path.join(sandbox, 'model-requests.jsonl')
const discoveryFile = path.join(sandbox, 'discovery-requests.jsonl')

async function jsonLines(file) {
  return (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function waitUntil(check) {
  for (let i = 0; i < 250; i++) {
    const found = await check()
    if (found) return found
    await delay(20)
  }
  throw new Error(`Fixture did not reach the expected state: ${logs}`)
}

function rawRequest(port, target, host) {
  return new Promise((resolve, reject) => {
    let response = ''
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    socket.setEncoding('utf8')
    socket.setTimeout(1000, () => socket.destroy())
    socket.on('data', (chunk) => { response += chunk })
    socket.on('error', reject)
    socket.on('close', () => resolve(response))
  })
}

try {
  await fs.mkdir(dataDir, { recursive: true })
  for (const entry of ['server.mjs', 'lib', 'public', 'package.json']) {
    await fs.cp(path.join(root, entry), path.join(install, entry), { recursive: true })
  }
  await fs.symlink(path.join(root, 'node_modules'), path.join(install, 'node_modules'), 'dir')
  await fs.writeFile(path.join(dataDir, 'echo.env'), 'OPENAI_BASE_URL=https://model.invalid/v1\nECHO_SERVER_TEST_KEY=local-test-only\n', { mode: 0o600 })
  const config = path.join(install, 'config.json')
  await fs.writeFile(config, JSON.stringify({
    requirePassword: false,
    dream: { enabled: false }, proactive: { enabled: false, research: { enabled: false } },
    memory: { enabled: true, inject: false, extract: true, extractMinChars: 1 },
    screen: { enabled: false }, companion: { enabled: false },
    search: { enabled: false, maxToolRounds: 1 }, mcpServers: {},
    upstream: { apiKeyEnv: 'ECHO_SERVER_TEST_KEY', baseUrl: 'https://model.invalid/v1', defaultModel: 'fixture', utilityModel: 'fixture' },
  }))
  await test('legacy records or access settings require an explicit profile choice before startup', async () => {
    const oldRoot = pathToFileURL(install).pathname
    const oldData = path.join(oldRoot, 'data')
    const oldConfig = path.join(oldRoot, 'config.json')
    await fs.mkdir(oldData, { recursive: true })
    await fs.writeFile(path.join(oldData, 'auth.json'), '{}')
    await fs.writeFile(oldConfig, JSON.stringify({ requirePassword: true }))
    const check = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', "import { checkLegacyProfile } from './lib/config.mjs'; checkLegacyProfile()"], {
      cwd: install, env, encoding: 'utf8', timeout: 5000,
    })
    for (const env of [{}, { ECHO_DATA_DIR: oldData }, { ECHO_CONFIG: oldConfig }]) {
      const result = check(env)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /docs\/getting-started\.md/)
    }
    assert.equal(check({ ECHO_CONFIG: oldConfig, ECHO_DATA_DIR: oldData }).status, 0)
    await fs.rename(oldRoot, path.join(sandbox, 'archived profile'))
    assert.equal(check({}).status, 0)
  })
  const reservation = http.createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`
  app = spawn(process.execPath, ['--input-type=module', '-e', `
    import { promises as fs } from 'node:fs'
    const readdir = fs.readdir
    // Startup cleanup must not inspect the running user's shared capture directory.
    fs.readdir = (dir, ...args) => dir === '/tmp/echo-capture' ? Promise.resolve([]) : readdir(dir, ...args)
    globalThis.fetch = async (url, { body: raw, headers, signal }) => {
      const expectedKey = new URL(url).hostname === 'model.invalid' ? 'local-test-only' : 'new-fixture-key'
      if (headers.authorization !== 'Bearer ' + expectedKey) throw new Error('Wrong fixture credential for endpoint')
      if (url.endsWith('/models')) {
        await fs.appendFile(${JSON.stringify(discoveryFile)}, JSON.stringify(url) + '\\n')
        return Response.json({ data: [{ id: 'manual-chat' }] })
      }
      if (!['https://model.invalid/v1/chat/completions', 'https://new-model.invalid/v1/chat/completions'].includes(url)) throw new Error('Unexpected request: ' + url)
      const body = JSON.parse(raw)
      await fs.appendFile(${JSON.stringify(requestsFile)}, JSON.stringify({ ...body, endpoint: url }) + '\\n')
      if (!body.stream) return Response.json({ choices: [{ message: { content: '[]' } }] })
      const scenario = body.messages.findLast((message) => message.role === 'user').content
      if (scenario === 'STATUS:cancelled') return new Response(new ReadableStream({
        start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }) },
      }))
      const chunk = scenario === 'STATUS:failed'
        ? { error: { message: 'Fixture model failure' } }
        : { choices: [{ delta: scenario === 'STATUS:limit_reached'
          ? { tool_calls: [{ index: 0, id: 'fixture_time', type: 'function', function: { name: 'local_time', arguments: '{}' } }] }
          : { content: 'Fixture completed.' }, finish_reason: scenario === 'STATUS:limit_reached' ? 'tool_calls' : 'stop' }] }
      return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n')
    }
    await import('./server.mjs')
  `], {
    cwd: install,
    env: {
      PATH: process.env.PATH ?? '',
      ECHO_BIND: 'local', ECHO_PORT: String(port), ECHO_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', (chunk) => { logs += chunk })
  app.stderr.on('data', (chunk) => { logs += chunk })
  async function healthy() {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    assert.equal(app.exitCode, null, logs)
  }
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error(`Fixture exited: ${logs}`)
    try { await healthy(); ready = true; break } catch {}
    await delay(30)
  }
  assert.ok(ready, `Fixture did not start: ${logs}`)

  await test('installed app serves chat and uses the credentials and data in Application Support', async () => {
    assert.equal((await fetch(`${base}/`)).status, 200)
    assert.equal((await fetch(`${base}/app.js`)).status, 200)
    const { config } = await (await fetch(`${base}/api/bootstrap`)).json()
    assert.equal(config.defaultModel, 'fixture')
    assert.ok(config.models.some((model) => model.id === 'fixture'), 'existing manual-model profiles are selectable')
    assert.equal(config.upstreamConfigured, true)
    assert.ok((await fs.stat(path.join(dataDir, 'conversations', 'main.json'))).isFile())
  })

  for (const host of ['[', 'localhost:invalid', 'bad%host']) {
    await test(`malformed Host ${host} returns 400 and leaves the server healthy`, async () => {
      const response = await rawRequest(port, '/api/health', host)
      await healthy()
      assert.match(response, /^HTTP\/1\.1 400 /, `Request must finish with 400; logs: ${logs}`)
    })
  }
  for (const target of ['http://[/', '//[']) {
    await test(`malformed request target ${target} returns 400 and leaves the server healthy`, async () => {
      const response = await rawRequest(port, target, `localhost:${port}`)
      await healthy()
      assert.match(response, /^HTTP\/1\.1 400 /, `Request must finish with 400; logs: ${logs}`)
    })
  }
  await test('valid host forms and normal API/static routes still work', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `192.0.2.1:${port}`]) {
      assert.match(await rawRequest(port, '/api/health?probe=1', host), /^HTTP\/1\.1 200 /)
    }
    assert.match(await rawRequest(port, `${base}/api/health`, `localhost:${port}`), /^HTTP\/1\.1 200 /)
    assert.equal((await fetch(`${base}/missing`)).status, 404)
    assert.doesNotMatch(logs, /unhandledRejection|uncaughtException/)
  })

  const post = (route, body) => fetch(`${base}/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-echo-request': 'echo' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  const patch = (route, body) => fetch(`${base}/api/${route}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'x-echo-request': 'echo' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  await test('reply memory inspection resolves only unchanged active facts without model calls or memory writes', async () => {
    const conv = await (await post('conversations', {})).json()
    const recorded = ['kept', 'changed', 'deleted', 'faded', 'missing'].map((label) => ({ id: 'fact_' + label, kind: 'fact', text: label + ' at retrieval' }))
    const file = path.join(dataDir, 'memory', 'observations.jsonl')
    const before = await fs.readFile(file, 'utf8').catch(() => '')
    const rows = [recorded[0], { ...recorded[1], text: 'changed since retrieval' }, recorded[2], recorded[3], { id: 'unrelated', text: 'other active fact' }]
      .map((row, i) => JSON.stringify({ ...row, hits: 3, status: ['active', 'active', 'deleted', 'faded', 'active'][i] }))
    const entries = before + '\n' + rows.join('\n') + '\n'
    const messageFile = path.join(dataDir, 'conversations', conv.id + '.json')
    const get = (id, convId = conv.id) => fetch(`${base}/api/conversations/${convId}/messages/${id}/recalled-facts`)
    const requestsBefore = (await jsonLines(requestsFile)).length
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, entries)
      await fs.writeFile(messageFile, JSON.stringify({ ...conv, messages: [
        { role: 'assistant', id: 'reply_aborted', runStatus: 'cancelled', recalled: recorded },
        { role: 'assistant', id: 'reply_legacy' }, { role: 'user', id: 'user_original' },
      ] }))
      const response = await get('reply_aborted')
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), { facts: [{ id: recorded[0].id, text: recorded[0].text }], unavailableCount: 4 })
      assert.deepEqual(await (await get('reply_legacy')).json(), { facts: [], unavailableCount: 0 })
      assert.equal((await get('user_original')).status, 404)
      assert.equal((await get('reply_aborted', 'main')).status, 404)
      const route = 'conversations/' + conv.id
      for (const res of [await fetch(`${base}/api/${route}`), await patch(route, { title: 'Renamed chat' })]) {
        assert.equal(res.status, 200)
        const chat = await res.json()
        assert.deepEqual(chat.messages[0].recalled, recorded.map(({ id }) => ({ id })))
        assert.equal(Object.hasOwn(chat.messages[1], 'recalled'), false)
        assert.doesNotMatch(JSON.stringify(chat), /at retrieval|since retrieval/)
      }
      const saved = JSON.parse(await fs.readFile(messageFile, 'utf8'))
      assert.equal(saved.title, 'Renamed chat')
      assert.deepEqual(saved.messages[0].recalled, recorded)
      assert.equal(await fs.readFile(file, 'utf8'), entries)
      await fs.writeFile(file, '')
      assert.deepEqual(await (await get('reply_aborted')).json(), { facts: [], unavailableCount: 5 })
      assert.equal((await jsonLines(requestsFile)).length, requestsBefore)
    } finally {
      await fs.writeFile(file, before)
    }
  })
  for (const status of ['completed', 'failed', 'cancelled', 'limit_reached']) {
    await test(`HTTP chat ${status} preserves the outcome in history and success metrics`, async () => {
      const conversation = await (await post('conversations', {})).json()
      const marker = `STATUS:${status}`
      const response = await post('chat', { conversationId: conversation.id, userText: marker })
      assert.equal(response.status, 200)
      if (status === 'cancelled') {
        await waitUntil(async () => (await jsonLines(requestsFile)).some((body) => body.messages.some((message) => message.content === marker)))
        assert.equal((await (await post('chat/stop', { conversationId: conversation.id })).json()).stopped, true)
      }
      const events = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]))
      const terminal = events.findLast((event) => event.type === 'done' || event.type === 'error')
      const assistant = terminal.type === 'error' ? terminal.assistant : terminal.message
      assert.equal(assistant.runStatus, status)
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'conversations', `${conversation.id}.json`), 'utf8'))
      assert.deepEqual(saved.messages.at(-1), assistant)
      const metric = await waitUntil(async () => (await jsonLines(path.join(dataDir, 'metrics.jsonl'))).find((event) => event.kind === 'turn' && event.conversationId === conversation.id))
      assert.equal(metric.ok, status === 'completed')
      if (status === 'failed' || status === 'cancelled') {
        assert.equal(assistant.content, '')
        const requests = (await jsonLines(requestsFile)).filter((body) => body.messages.some((message) => String(message.content).includes(marker)))
        assert.equal(requests.length, 1, 'empty failed/cancelled replies must not trigger title generation or memory extraction')
        assert.equal(requests[0].stream, true)
      }
    })
  }
  await test('chat streams expose only recall IDs in metadata, completed replies and failed replies', async () => {
    const file = path.join(dataDir, 'memory', 'observations.jsonl')
    const before = await fs.readFile(file, 'utf8').catch(() => '')
    const fact = { id: 'fact_orchid', text: 'Synthetic orchid recall text', kind: 'fact', importance: 5, status: 'active', last_seen: new Date().toISOString() }
    try {
      assert.equal((await patch('settings', { config: { memory: { inject: true, extract: false } } })).status, 200)
      await fs.writeFile(file, JSON.stringify(fact) + '\n')
      for (const prompt of ['Orchid fixture', 'STATUS:failed']) {
        const conv = await (await post('conversations', { title: 'Fixture' })).json()
        const response = await post('chat', { conversationId: conv.id, userText: prompt })
        assert.equal(response.status, 200)
        const stream = await response.text()
        assert.ok(!stream.includes(fact.text))
        const events = [...stream.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]))
        const meta = events.find((ev) => ev.type === 'meta')
        assert.equal(Object.hasOwn(meta, 'system'), false)
        assert.deepEqual(meta.memory, [{ id: fact.id }])
        const terminal = events.findLast((ev) => ['error', 'done'].includes(ev.type))
        assert.equal(terminal.type, prompt === 'STATUS:failed' ? 'error' : 'done')
        assert.deepEqual((terminal.assistant ?? terminal.message).recalled, [{ id: fact.id }])
        const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'conversations', conv.id + '.json'), 'utf8'))
        assert.equal(saved.messages.at(-1).recalled[0].text, fact.text)
      }
    } finally {
      await fs.writeFile(file, before)
      assert.equal((await patch('settings', { config: { memory: { inject: false, extract: true } } })).status, 200)
    }
  })
  await test('malformed foreign cookie values never 500 the API (issue #1)', async () => {
    const response = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-echo-request': 'echo', cookie: 'echo_s=abc; x=%; y=%zz' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    await healthy()
  })

  await test('malformed percent-encoding in URL paths never 500s (issue #1 family)', async () => {
    const response = await fetch(`${base}/api/graph/%zz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 404)
    await healthy()
  })

  await test('the return brief is read-only and never calls the model', async () => {
    const before = (await jsonLines(requestsFile)).length
    const response = await fetch(`${base}/api/brief?since=2000-01-01T00:00:00Z`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const brief = await response.json()
    assert.ok(Array.isArray(brief.items))
    assert.ok(brief.since)
    assert.equal((await jsonLines(requestsFile)).length, before, 'the brief must not trigger model requests')
    await healthy()
  })

  await test('onboarding saves an empty source selection as offline', async () => {
    const response = await post('onboarding/complete', { defaultModel: 'manual-chat', models: [], search: { order: [] } })
    assert.equal(response.status, 200)
    const saved = await response.json()
    assert.ok(saved.config.models.some((model) => model.id === 'manual-chat'))
    assert.equal(saved.onboarding.usable, true)
    assert.deepEqual(saved.config.search.order, ['none'])
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')).search.order, ['none'])
    const result = await (await post('search/test', { query: 'offline test' })).json()
    assert.deepEqual(result.attempts.map((attempt) => attempt.engine), ['none'])
  })

  await test('wizard password validation precedes saving other settings', async () => {
    const foreign = await fetch(`${base}/api/onboarding/complete`, {
      method: 'POST', headers: { 'x-echo-request': 'echo', 'content-type': 'application/json', origin: 'https://example.invalid' },
      body: JSON.stringify({ password: 'foreign origin', defaultModel: 'invalid-change' }),
    })
    assert.equal(foreign.status, 403)
    const response = await post('onboarding/complete', { password: 'short', defaultModel: 'invalid-change' })
    assert.equal(response.status, 400)
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json()
    assert.equal(bootstrap.config.defaultModel, 'manual-chat')
    assert.deepEqual(bootstrap.config.auth, { required: false, passwordSet: false })
  })

  await test('changing model endpoint pairs the new address with an explicitly supplied key', async () => {
    const oldBase = 'https://model.invalid/v1'
    const newBase = 'https://new-model.invalid/v1'
    const discover = async (body) => (await post('onboarding/test', body)).json()
    assert.equal((await discover({ baseUrl: oldBase })).ok, true)
    assert.equal((await discover({ baseUrl: newBase })).ok, false)
    assert.equal((await post('onboarding/complete', { baseUrl: newBase, defaultModel: 'manual-chat' })).status, 400)
    assert.deepEqual(await jsonLines(discoveryFile), [oldBase + '/models'])
    const connection = { baseUrl: newBase, apiKey: 'new-fixture-key', defaultModel: 'manual-chat', models: [] }
    assert.equal((await discover(connection)).ok, true)
    const saved = await (await post('onboarding/complete', connection)).json()
    assert.equal(saved.onboarding.baseUrl, newBase)
    assert.deepEqual(saved.config.models.map((model) => model.id), ['manual-chat'])
    const conversation = await (await post('conversations', {})).json()
    await (await post('chat', { conversationId: conversation.id, userText: 'provider switched' })).text()
    assert.ok((await jsonLines(requestsFile)).some((req) => req.stream && req.endpoint === newBase + '/chat/completions' && req.model === 'manual-chat'))
    const env = await fs.readFile(path.join(dataDir, 'echo.env'), 'utf8')
    assert.ok(env.includes('OPENAI_BASE_URL=' + newBase + '\n') && env.includes('ECHO_SERVER_TEST_KEY=new-fixture-key\n'))
  })

  await test('legacy settings default to balanced and a valid interruption style survives profile changes', async () => {
    const settings = async () => (await (await fetch(`${base}/api/settings`)).json()).config
    assert.equal((await settings()).attention.style, 'balanced')
    for (const style of ['quiet', 'balanced', 'engaged']) {
      const res = await patch('settings', { config: { attention: { style } } })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).config.attention.style, style)
      assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).attention.style, style)
    }
    for (const attention of [null, 'quiet', [], { style: '' }, { style: null }, { style: ['quiet'] }, { style: 'QUIET' }]) {
      const res = await patch('settings', { config: { attention, systemPrompt: 'invalid partial save' } })
      assert.equal(res.status, 400)
    }
    assert.notEqual((await settings()).systemPrompt, 'invalid partial save')
    await patch('settings', { config: { attention: { minGapSeconds: 95 }, memory: { profile: 'off' } } })
    const boot = await (await fetch(`${base}/api/bootstrap`)).json()
    assert.equal(boot.config.attention.minGapSeconds, 95)
    assert.equal(boot.config.attention.style, 'engaged')
    assert.equal(boot.config.memory.profile, 'off')
  })

  await test('feedback on a delivered message keeps utility and timing independent across reloads', async () => {
    const conv = await (await post('conversations', { title: 'Fixture' })).json()
    const msg = { id: 'test_nudge', role: 'assistant', proactive: true, kind: 'suggest', content: 'Fixture reminder.' }
    await fs.writeFile(path.join(dataDir, 'conversations', conv.id + '.json'), JSON.stringify({ ...conv, messages: [msg] }))
    const feedback = async (signal) => (await (await post('feedback', { signal, conversationId: conv.id, messageId: msg.id })).json())
    assert.equal((await feedback('good')).outcome.utility, 'good')
    assert.equal((await feedback('wrong_time')).outcome.timing, 'wrong_time')
    assert.equal((await feedback('wrong_time')).duplicate, true)
    const reloaded = await (await fetch(`${base}/api/conversations/${conv.id}`)).json()
    assert.equal(reloaded.messages[0].feedback, 'good')
    assert.equal(reloaded.messages[0].feedbackTiming, 'wrong_time')
  })

  await test('status and a manual check agree on a quiet-style delay before model evaluation', async () => {
    const stateFile = path.join(dataDir, 'state.json')
    const before = await fs.readFile(stateFile, 'utf8')
    const state = JSON.parse(before)
    const previousSettings = (await (await fetch(`${base}/api/settings`)).json()).config
    const requestsBefore = (await jsonLines(requestsFile)).length
    const lastAt = new Date(Date.now() - 60 * 60000)
    try {
      state.lastUserMessageAt = null
      state.attention = { history: [{ id: 'fixture_delivery', channel: 'companion', at: lastAt.toISOString(), status: 'delivered' }] }
      await fs.writeFile(stateFile, JSON.stringify(state))
      const configured = await patch('settings', { config: {
        attention: { style: 'quiet' }, proactive: { enabled: true, quietHours: { start: '00:00', end: '00:00' } },
      } })
      assert.equal(configured.status, 200)
      const status = await (await fetch(`${base}/api/proactive`)).json()
      assert.equal(status.nextGate.reason, 'quiet_style_gap')
      assert.equal(status.attention.timing.style, 'quiet')
      assert.equal(status.attention.timing.nextEligibleAt, new Date(lastAt.getTime() + 120 * 60000).toISOString())
      const checked = await (await post('proactive/run', {})).json()
      assert.equal(checked.result.skipped, status.nextGate.reason)
      assert.equal((await jsonLines(requestsFile)).length, requestsBefore)
    } finally {
      await patch('settings', { config: { attention: { style: previousSettings.attention.style }, proactive: {
        enabled: previousSettings.proactive.enabled, quietHours: previousSettings.proactive.quietHours,
      } } })
      await fs.writeFile(stateFile, before)
    }
  })

  await test('setting a wizard password enables login and keeps the current browser signed in with malformed foreign cookies', async () => {
    const setup = await post('onboarding/complete', { password: 'correct horse battery' })
    assert.equal(setup.status, 200)
    assert.deepEqual((await setup.json()).config.auth, { required: true, passwordSet: true })
    const session = /echo_s=([^;]+)/.exec(setup.headers.get('set-cookie') ?? '')?.[1]
    assert.ok(session, 'password setup must return a session cookie')
    const authed = await fetch(`${base}/api/bootstrap`, {
      headers: { cookie: `echo_s=${session}; x=%` },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(authed.status, 200)
    assert.ok((await authed.json()).version)
    const noSession = await fetch(`${base}/api/bootstrap`, {
      headers: { cookie: 'x=%' },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(noSession.status, 401, 'malformed cookies must not bypass auth')
    const repeat = await fetch(`${base}/api/onboarding/complete`, {
      method: 'POST', headers: { cookie: `echo_s=${session}`, 'x-echo-request': 'echo', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'replacement password' }),
    })
    assert.equal(repeat.status, 409, 'password changes use the existing password-management flow')
    assert.equal((await post('login', { password: 'correct horse battery' })).status, 200)
  })
} finally {
  if (app && app.exitCode === null && !app.signalCode) {
    const exited = new Promise((resolve) => app.once('exit', resolve))
    app.kill('SIGTERM')
    const timer = setTimeout(() => app.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  await fs.rm(sandbox, { recursive: true, force: true })
}
