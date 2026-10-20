import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-server-'))
let app
let logs = ''
const requestsFile = path.join(sandbox, 'model-requests.jsonl')

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
  const config = path.join(sandbox, 'config.json')
  await fs.writeFile(config, JSON.stringify({
    requirePassword: false,
    dream: { enabled: false }, proactive: { enabled: false, research: { enabled: false } },
    memory: { enabled: true, inject: false, extract: true, extractMinChars: 1 },
    screen: { enabled: false }, companion: { enabled: false },
    search: { enabled: false, maxToolRounds: 1 }, mcpServers: {},
    upstream: { apiKeyEnv: 'ECHO_SERVER_TEST_KEY', baseUrl: 'https://model.invalid/v1', defaultModel: 'fixture', utilityModel: 'fixture' },
  }))
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
    globalThis.fetch = async (url, { body: raw, signal }) => {
      if (url !== 'https://model.invalid/v1/chat/completions') throw new Error('Unexpected network request: ' + url)
      const body = JSON.parse(raw)
      await fs.appendFile(${JSON.stringify(requestsFile)}, JSON.stringify(body) + '\\n')
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
    await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)})
  `], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', ECHO_DATA_DIR: sandbox, ECHO_CONFIG: config,
      ECHO_BIND: 'local', ECHO_PORT: String(port), ECHO_LOG_LEVEL: 'warn',
      ECHO_SERVER_TEST_KEY: 'local-test-only',
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
    assert.equal((await fetch(`${base}/`)).status, 200)
    assert.equal((await fetch(`${base}/missing`)).status, 404)
    assert.doesNotMatch(logs, /unhandledRejection|uncaughtException/)
  })

  const post = (route, body) => fetch(`${base}/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-echo-request': 'echo' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
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
      const saved = JSON.parse(await fs.readFile(path.join(sandbox, 'conversations', `${conversation.id}.json`), 'utf8'))
      assert.deepEqual(saved.messages.at(-1), assistant)
      const metric = await waitUntil(async () => (await jsonLines(path.join(sandbox, 'metrics.jsonl'))).find((event) => event.kind === 'turn' && event.conversationId === conversation.id))
      assert.equal(metric.ok, status === 'completed')
      if (status === 'failed' || status === 'cancelled') {
        assert.equal(assistant.content, '')
        const requests = (await jsonLines(requestsFile)).filter((body) => body.messages.some((message) => String(message.content).includes(marker)))
        assert.equal(requests.length, 1, 'empty failed/cancelled replies must not trigger title generation or memory extraction')
        assert.equal(requests[0].stream, true)
      }
    })
  }
} finally {
  if (app && app.exitCode === null && !app.signalCode) {
    const exited = new Promise((resolve) => app.once('exit', resolve))
    app.kill('SIGTERM')
    const timer = setTimeout(() => app.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  await fs.rm(sandbox, { recursive: true, force: true })
}
