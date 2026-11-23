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
  await fs.writeFile(path.join(dataDir, 'echo.env'), '# User entry\nexport ECHO_OTHER_SERVICE="other-fixture"\nOPENAI_BASE_URL=https://model.invalid/v1\nECHO_SERVER_TEST_KEY=local-test-only\n', { mode: 0o600 })
  const config = path.join(install, 'config.json')
  await fs.writeFile(config, JSON.stringify({
    bind: 'all', requirePassword: false,
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
      if (!body.stream) {
        let selected
        try { selected = JSON.parse(body.messages.at(-1).content) } catch {}
        const wording = selected?.topic?.startsWith('Policy fixture ')
          ? { message: 'Review the next step for ' + selected.topic + '.', quote: selected.topic } : []
        return Response.json({ choices: [{ message: { content: JSON.stringify(wording) } }] })
      }
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

  await test('settings, permissions, CLI health and menu summary report the loopback override and live port', async () => {
    const runtime = { bind: 'local', address: '127.0.0.1', port, lanAddresses: [], lanUrl: null }
    const get = async (route) => (await fetch(base + '/api/' + route)).json()
    const { config } = await get('settings')
    assert.equal(config.bind, 'all', 'the saved LAN preference survives a loopback-only launch')
    assert.deepEqual(config.listener, runtime)
    assert.deepEqual((await get('summary')).listener, runtime)
    assert.deepEqual((await get('health')).listener, { address: '127.0.0.1', port })
    const permissions = await get('permissions')
    assert.match(permissions.bind, /127\.0\.0\.1/)
    assert.equal(permissions.port, port)
    assert.deepEqual(permissions.lanAddresses, [])
    assert.equal(permissions.lanUrl, null)
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
  await test('settings reject non-object JSON without updating the profile', async () => {
    const before = await fs.readFile(config, 'utf8')
    for (const value of [null, [], false, 'model']) {
      assert.equal((await patch('settings', value)).status, 400)
    }
    assert.equal(await fs.readFile(config, 'utf8'), before)
  })
  await test('a failed native capture resolves the pending request without creating an event or invoking a provider', async () => {
    const before = await jsonLines(requestsFile)
    const status = async () => (await (await fetch(`${base}/api/screen`)).json()).screen
    assert.equal((await (await post('screen/capture', { reason: 'fixture' })).json()).requested, false)
    await patch('screen', { enabled: true })
    try {
      assert.equal((await (await post('screen/capture', { reason: 'fixture' })).json()).requested, true)
      assert.equal((await status()).captureRequested, true)
      const stateFile = path.join(dataDir, 'state.json')
      const state = JSON.parse(await fs.readFile(stateFile))
      state.screen.requestedAt = new Date(Date.now() - 180000).toISOString()
      await fs.writeFile(stateFile, JSON.stringify(state))
      assert.equal((await status()).captureExpired, true)
      assert.equal((await status()).captureRequested, false)
      for (const issue of ['screen_permission_required', 'capture_failed']) {
        await post('screen/capture', { reason: 'fixture' })
        const failed = await (await post('screen', { fromCapture: true, captureFailed: true, captureIssue: issue })).json()
        assert.equal(failed.skipped, issue)
        const screen = await status()
        assert.equal(screen.captureRequested, false)
        assert.equal(screen.permissionMissing, issue === 'screen_permission_required')
        assert.equal(screen.lastOk, false)
        assert.equal(screen.workingCount, 0)
      }
      assert.deepEqual(await jsonLines(requestsFile), before)
    } finally {
      await patch('screen', { enabled: false })
    }
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
    const malformed = await post('onboarding/complete', { baseUrl: newBase, apiKey: 'new-fixture-key', defaultModel: 'manual-chat', models: [null] })
    assert.equal(malformed.status, 400)
    assert.equal((await (await fetch(base + '/api/providers')).json()).onboarding.baseUrl, oldBase)
    assert.deepEqual(await jsonLines(discoveryFile), [oldBase + '/models'])
    const connection = { baseUrl: newBase, apiKey: 'new-fixture-key', defaultModel: 'manual-chat', models: [] }
    const conversation = await (await post('conversations', { model: 'retired-model' })).json()
    assert.equal((await discover(connection)).ok, true)
    const saved = await (await post('onboarding/complete', connection)).json()
    assert.equal(saved.onboarding.baseUrl, newBase)
    assert.deepEqual(saved.config.models.map((model) => model.id), ['manual-chat'])
    await (await post('chat', { conversationId: conversation.id, userText: 'provider switched' })).text()
    assert.ok((await jsonLines(requestsFile)).some((req) => req.stream && req.endpoint === newBase + '/chat/completions' && req.model === 'manual-chat'))
    const env = await fs.readFile(path.join(dataDir, 'echo.env'), 'utf8')
    assert.ok(env.includes('OPENAI_BASE_URL=' + newBase + '\n') && env.includes('ECHO_SERVER_TEST_KEY=new-fixture-key\n'))
    assert.ok(env.includes('# User entry\nexport ECHO_OTHER_SERVICE="other-fixture"\n'))
  })

  await test('BYOK setup detects lost credentials and preserves custom choices on repair without probing a provider', async () => {
    const initial = (await (await fetch(base + '/api/bootstrap')).json()).config
    const discoveryCount = (await jsonLines(discoveryFile)).length
    await patch('settings', { env: { OPENAI_API_KEY: 'unrelated-fixture-key', ECHO_SERVER_TEST_KEY: '' } })
    const broken = (await (await fetch(base + '/api/providers')).json()).onboarding
    assert.equal(broken.completed, true)
    assert.equal(broken.hasKey, false, 'a named provider key must never borrow another credential')
    assert.equal(broken.needed, true)
    assert.equal((await post('onboarding/complete', { defaultModel: 'manual-chat' })).status, 400)
    const repaired = await (await post('onboarding/complete', { apiKey: 'new-fixture-key', profile: initial.memory.profile })).json()
    assert.equal(repaired.onboarding.usable, true)
    assert.equal(repaired.config.proactive.enabled, initial.proactive.enabled)
    assert.equal(repaired.config.memory.inject, initial.memory.inject)
    assert.equal((await jsonLines(discoveryFile)).length, discoveryCount)
    await patch('settings', { env: { OPENAI_API_KEY: '' } })
  })

  await test('settings pair model endpoint changes with provider keys and reject unrelated variables before saving', async () => {
    const file = path.join(dataDir, 'echo.env')
    const original = await fs.readFile(file, 'utf8')
    const before = (await (await fetch(base + '/api/settings')).json()).config
    const next = 'https://model.invalid/v1'
    for (const changes of [
      { config: { upstream: { baseUrl: next } } },
      { env: { OPENAI_BASE_URL: next } },
      { env: { ECHO_UNRELATED_TEST_OPTION: 'fixture' } },
      { config: { upstream: { apiKeyEnv: 'ECHO_UNRELATED_TEST_KEY' } } },
      { config: { search: { providers: { tavily: { endpoint: 'https://new-search.invalid/v1' } } } } },
      { config: { upstream: { models: [null] } }, env: { ECHO_SERVER_TEST_KEY: 'temporary-test-value' } },
    ]) {
      const response = await patch('settings', { ...changes, config: { ...changes.config, systemPrompt: 'partial fixture' } })
      assert.equal(response.status, 400)
      assert.equal(await fs.readFile(file, 'utf8'), original)
      assert.equal((await (await fetch(base + '/api/settings')).json()).config.systemPrompt, before.systemPrompt)
    }
    const saved = await patch('settings', { config: { upstream: { baseUrl: next } }, env: { ECHO_SERVER_TEST_KEY: 'local-test-only' } })
    assert.equal(saved.status, 200)
    assert.equal((await (await fetch(base + '/api/providers')).json()).onboarding.baseUrl, next)
    assert.equal((await saved.json()).config.defaultModel, '', 'an endpoint-only change drops the previous provider’s models')
    assert.equal((await (await post('onboarding/test', {})).json()).ok, true)
    await patch('settings', { config: { upstream: { defaultModel: before.defaultModel, models: before.models, utilityModel: before.utilityModel } },
      env: { OPENAI_BASE_URL: before.onboarding.baseUrl, ECHO_SERVER_TEST_KEY: 'new-fixture-key' } })
    const custom = (value) => patch('settings', { config: { search: { providers: { custom: value } } } })
    assert.equal((await custom({ endpoint: 'https://first-search.invalid', headers: { 'x-team': 'fixture' } })).status, 200)
    const moved = await (await custom({ endpoint: 'https://other-search.invalid' })).json()
    assert.equal(moved.config.search.providers.custom.headers, null)
    const binding = moved.config.search.providers.custom.credentialRevision
    assert.ok(binding && (await fs.readFile(file, 'utf8')).includes('ECHO_SEARCH_BINDING_CUSTOM=' + binding + '\n'))
    await custom({ endpoint: '' })
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
    const correction = await feedback('good_time')
    assert.equal(correction.outcome.timing, 'good_time')
    assert.equal(correction.outcome.utility, 'good')
    assert.equal((await feedback('good_time')).duplicate, true)
    const corrected = await (await fetch(`${base}/api/conversations/${conv.id}`)).json()
    assert.equal(corrected.messages[0].feedbackTiming, 'good_time')
    assert.equal(corrected.messages[0].feedback, 'good')
  })

  await test('preparation and chat votes always reload from the same saved outcome', async () => {
    const conv = await (await post('conversations', { title: 'Linked draft' })).json()
    const prep = { id: 'prep_cross', commitmentId: 'goal_cross', delivery: {
      status: 'delivered', conversationId: conv.id, messageId: 'msg_cross', deliveredAt: new Date().toISOString(),
    } }
    const msg = { id: prep.delivery.messageId, role: 'assistant', proactive: true, kind: 'brief', preparationId: prep.id,
      commitmentId: prep.commitmentId, content: 'Draft ready.', feedback: 'wrong_time' }
    const convFile = path.join(dataDir, 'conversations', conv.id + '.json')
    const stateFile = path.join(dataDir, 'state.json')
    const before = await fs.readFile(stateFile, 'utf8')
    const state = JSON.parse(before)
    await fs.writeFile(convFile, JSON.stringify({ ...conv, messages: [msg] }))
    state.preparations = [...(state.preparations ?? []), prep]
    await fs.writeFile(stateFile, JSON.stringify(state))
    const vote = async (identity, signal) => (await (await post('feedback', { ...identity, signal })).json())
    const card = { preparationId: prep.id }, chat = { conversationId: conv.id, messageId: msg.id }
    const read = async () => (await (await fetch(`${base}/api/conversations/${conv.id}`)).json()).messages[0]
    try {
      const first = await vote(card, 'good_time')
      assert.equal(first.outcome.messageId, msg.id)
      assert.equal((await read()).feedbackTiming, 'good_time')
      assert.equal((await read()).feedback, undefined, 'an old timing vote must not appear as utility')
      await Promise.all([vote(chat, 'wrong_time'), vote(card, 'accepted')])
      const projected = await read()
      assert.equal(projected.feedback, 'accepted')
      assert.equal(projected.feedbackTiming, 'wrong_time')
      await Promise.all([vote(card, 'good_time'), vote(chat, 'wrong_time')])
      const current = JSON.parse(await fs.readFile(stateFile, 'utf8')).agency.outcomes['preparation:' + prep.id]
      const renamed = await (await patch('conversations/' + conv.id, { title: 'Renamed draft' })).json()
      assert.equal(renamed.messages[0].feedbackTiming, current.timing)
      assert.equal(renamed.messages[0].feedback, current.utility)
      assert.equal(JSON.parse(await fs.readFile(convFile, 'utf8')).messages[0].feedbackTiming, undefined, 'votes have a single writable store')
    } finally { await fs.writeFile(stateFile, before) }
  })

  await test('native bubble timing and mini-chat utility share one outcome across reloads', async () => {
    const id = 'bubble_surface_test'
    const file = path.join(dataDir, 'companion.jsonl')
    const before = await fs.readFile(file, 'utf8').catch(() => '')
    const bubble = { id, topic: 'Meeting', scenario: 'work', bubble: 'Review the agenda.', why: 'Meeting soon.',
      frame: { app: 'Fixture', title: 'Agenda' }, status: 'pending', ts: new Date().toISOString() }
    try {
      await fs.writeFile(file, before + '\n' + JSON.stringify(bubble) + '\n')
      const { conversationId } = await (await post('companion/' + id + '/open', {})).json()
      assert.ok(conversationId)
      const route = 'conversations/' + conversationId
      const identity = { conversationId, messageId: 'm_' + id }
      const native = () => post('companion/' + id + '/dismiss', { reason: 'wrong_time' })
      const mini = (signal) => post('feedback', { ...identity, signal })
      const intro = async () => (await (await fetch(`${base}/api/${route}`)).json()).messages[0]
      await Promise.all([native(), mini('good')])
      assert.equal((await intro()).feedback, 'good')
      assert.equal((await intro()).feedbackTiming, 'wrong_time')
      await mini('good_time')
      assert.equal((await intro()).feedbackTiming, 'good_time')
      await native()
      assert.equal((await intro()).feedbackTiming, 'wrong_time')
      assert.equal((await intro()).feedback, 'good')
    } finally { await fs.writeFile(file, before) }
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

  await test('the same preset and evidence produce different selected topics after actual content feedback', async () => {
    const stateFile = path.join(dataDir, 'state.json')
    const conversationFile = path.join(dataDir, 'conversations', 'main.json')
    const originalState = await fs.readFile(stateFile, 'utf8')
    const originalChat = await fs.readFile(conversationFile, 'utf8')
    const cfg = (await (await fetch(`${base}/api/settings`)).json()).config
    const status = async () => (await (await fetch(`${base}/api/proactive`)).json()).nextGate
    const run = async () => (await (await post('proactive/run', {})).json()).result
    const modelRequests = async () => (await jsonLines(requestsFile)).filter((row) => !row.stream && JSON.stringify(row.messages).includes('Policy fixture '))
    const a = { id: 'loop_policy_a', topic: 'Policy fixture budget', why: 'A revision of the budget is due.', status: 'open', confidence: 0.98,
      touched_at: new Date().toISOString(), due: new Date().toLocaleDateString('en-CA') }
    const b = { ...a, id: 'loop_policy_b', topic: 'Policy fixture training', why: 'The workshop outline needs review.', confidence: 0.90, due: null }
    try {
      await fs.writeFile(stateFile, JSON.stringify({ dream: { loops: [a, b], nudges: [] } }))
      assert.equal((await patch('settings', { config: {
        attention: { style: 'balanced', minGapSeconds: 0 },
        proactive: { enabled: true, notify: false, minGapMinutes: 0, quietHours: { start: '00:00', end: '00:00' } },
      } })).status, 200)
      assert.equal((await status()).selection.anchorId, a.id)
      const first = await run()
      assert.equal(first.message.selection.anchorId, a.id)
      assert.equal((await (await post('feedback', { conversationId: 'main', messageId: first.message.id, signal: 'bad' })).json()).outcome.utility, 'bad')
      const learned = JSON.parse(await fs.readFile(stateFile, 'utf8'))
      learned.dream.loops[0].why = 'A new budget revision arrived today.'
      const neutral = { ...learned, agency: {} }
      await fs.writeFile(stateFile, JSON.stringify(neutral))
      assert.equal((await status()).selection.anchorId, a.id, 'fresh material for A would be selected without the user vote')
      await fs.writeFile(stateFile, JSON.stringify(learned))
      assert.equal((await status()).selection.anchorId, b.id, 'the same inputs and starting preset now select B')
      assert.equal((await run()).message.selection.anchorId, b.id)
      const requests = await modelRequests()
      assert.equal(requests.length, 2)
      assert.ok(!JSON.stringify(requests[0].messages).includes(b.topic))
      assert.ok(!JSON.stringify(requests[1].messages).includes(a.topic))
      assert.equal((await run()).acted, false)
      assert.equal((await modelRequests()).length, 2, 'suppressed or already delivered topics cost no composition requests')
    } finally {
      await patch('settings', { config: { proactive: cfg.proactive, attention: cfg.attention } })
      await fs.writeFile(stateFile, originalState)
      await fs.writeFile(conversationFile, originalChat)
    }
  })

  await test('preview and topic mutes steer actual delivery without generating or rating content', async () => {
    const stateFile = path.join(dataDir, 'state.json')
    const chatFile = path.join(dataDir, 'conversations', 'main.json')
    const originals = await Promise.all([fs.readFile(stateFile), fs.readFile(chatFile)])
    const cfg = (await (await fetch(base + '/api/settings')).json()).config
    const now = new Date().toISOString()
    const top = { id: 'loop_rent', topic: 'Policy fixture rent', why: 'Review two options.', status: 'open', confidence: 0.99, touched_at: now }
    const other = { ...top, id: 'loop_trip', topic: 'Policy fixture trip', confidence: 0.8 }
    const preview = async () => (await fetch(base + '/api/proactive/preview')).json()
    const change = (method, body) => fetch(base + '/api/proactive/topic-mutes', { method,
      headers: { 'content-type': 'application/json', 'x-echo-request': 'echo' }, body: JSON.stringify(body) })
    const calls = async () => (await jsonLines(requestsFile)).length
    const beforeCalls = await calls()
    try {
      await patch('settings', { config: { attention: { style: 'balanced', minGapSeconds: 0 },
        proactive: { enabled: true, notify: false, minGapMinutes: 0, quietHours: { start: '00:00', end: '00:00' } } } })
      const state = { lastUserMessageAt: now, dream: { loops: [top, other] } }
      await fs.writeFile(stateFile, JSON.stringify(state))
      const snapshot = await preview()
      assert.deepEqual(snapshot.items.map((item) => [item.label, item.reason]), [[top.topic, 'recent_chat_activity'], [other.topic, 'recent_chat_activity']])
      assert.equal(await fs.readFile(stateFile, 'utf8'), JSON.stringify(state))
      assert.deepEqual(await fs.readFile(chatFile), originals[1])
      const topicKey = snapshot.items[0].topicKey
      assert.equal((await change('PUT', { topicKey: 'proactive:' + '0'.repeat(24), label: 'arbitrary' })).status, 409)
      assert.equal((await change('PUT', null)).status, 400)
      for (let i = 0; i < 2; i++) assert.equal((await change('PUT', { topicKey })).status, 200)
      const muted = JSON.parse(await fs.readFile(stateFile, 'utf8'))
      assert.equal(muted.agency.outcomes, undefined)
      assert.doesNotMatch(JSON.stringify(muted.agency), /fixture rent/i)
      delete muted.lastUserMessageAt
      muted.dream.loops[0].id = 'loop_new_rent'
      muted.dream.loops[0].topic = 'POLICY fixture rent!'
      await fs.writeFile(stateFile, JSON.stringify(muted))
      const active = await preview()
      assert.deepEqual(active.items.map((i) => i.reason), ['ok', 'topic_muted'])
      assert.equal(active.muted.length, 1)
      assert.equal(await calls(), beforeCalls)
      const sent = (await (await post('proactive/run', {})).json()).result.message
      assert.equal(sent.selection.label, other.topic)
      const request = (await jsonLines(requestsFile)).at(-1)
      assert.ok(!JSON.stringify(request.messages).toLowerCase().includes('fixture rent'))
      const originalMessage = { topicKey: sent.selection.topicKey, conversationId: 'main', messageId: sent.id }
      assert.equal((await change('PUT', { ...originalMessage, topicKey: 'proactive:' + 'f'.repeat(24) })).status, 409)
      assert.equal((await change('PUT', originalMessage)).status, 200)
      const chat = await (await fetch(base + '/api/conversations/main')).json()
      assert.equal(chat.messages.find((m) => m.id === sent.id).topicMuted, true)
      assert.equal((await (await post('proactive/run', {})).json()).result.acted, false)
      assert.equal(await calls(), beforeCalls + 1)
      assert.equal((await change('DELETE', { topicKey })).status, 200)
      assert.equal((await preview()).items[0].topicKey, topicKey)
    } finally {
      await patch('settings', { config: { proactive: cfg.proactive, attention: cfg.attention } })
      await fs.writeFile(stateFile, originals[0])
      await fs.writeFile(chatFile, originals[1])
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
