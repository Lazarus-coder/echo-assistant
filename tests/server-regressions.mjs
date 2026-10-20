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
    memory: { enabled: false }, screen: { enabled: false }, companion: { enabled: false },
    search: { enabled: false }, mcpServers: {},
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
    await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)})
  `], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', ECHO_DATA_DIR: sandbox, ECHO_CONFIG: config,
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
} finally {
  if (app && app.exitCode === null && !app.signalCode) {
    const exited = new Promise((resolve) => app.once('exit', resolve))
    app.kill('SIGTERM')
    const timer = setTimeout(() => app.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  await fs.rm(sandbox, { recursive: true, force: true })
}
