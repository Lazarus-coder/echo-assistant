import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-research-api-'))
const config = path.join(sandbox, 'config.json')
await fs.writeFile(config, JSON.stringify({
  upstream: { baseUrl: '', models: [], defaultModel: '' },
  memory: { enabled: false, inject: false, extract: false }, search: { enabled: false },
  dream: { enabled: false }, proactive: { enabled: false, notify: false },
  onboarding: { completed: true }, screen: { enabled: false }, companion: { enabled: false },
}))
const portSocket = http.createServer()
await new Promise((resolve) => portSocket.listen(0, '127.0.0.1', resolve))
const port = portSocket.address().port
await new Promise((resolve) => portSocket.close(resolve))
const app = spawn(process.execPath, ['server.mjs'], {
  cwd: root, env: { PATH: process.env.PATH, ECHO_DATA_DIR: sandbox, ECHO_CONFIG: config, ECHO_BIND: 'local', ECHO_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
app.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-6000) })
app.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-6000) })
const base = `http://127.0.0.1:${port}`
async function api(route, { method = 'GET', body, csrf = true, headers = {} } = {}) {
  const res = await fetch(`${base}/api/${route}`, {
    method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-echo-request': 'echo' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
  return { status: res.status, body: await res.json() }
}
try {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(logs)
    if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  let document
  await test('research is off by default and opt-in fields have a narrow validated schema', async () => {
    assert.equal((await api('research')).body.enabled, false)
    assert.equal((await api('settings', { method: 'PATCH', body: { config: { proactive: { research: { enabled: 'yes' } } } } })).status, 400)
    assert.equal((await api('settings', { method: 'PATCH', body: { config: { proactive: { research: { enabledAt: '2000-01-01' } } } } })).status, 400)
    const enabled = await api('settings', { method: 'PATCH', body: { config: { proactive: { research: { enabled: true, discoverChats: true } } } } })
    assert.equal(enabled.status, 200)
    assert.ok(Date.parse(enabled.body.config.proactive.research.enabledAt) > Date.now() - 10000)
    assert.equal(enabled.body.config.proactive.enabled, false, 'research consent does not enable notifications')
  })
  await test('shared documents are explicit, metadata-only in listings, and protected against cross-site upload', async () => {
    const input = { name: 'registration.txt', data: Buffer.from('Example University registration checklist.').toString('base64') }
    assert.equal((await api('research/documents', { method: 'POST', csrf: false, body: input })).status, 403)
    assert.equal((await api('research/documents', { method: 'POST', body: { name: 'file.exe', data: input.data } })).status, 400)
    const uploaded = await api('research/documents', { method: 'POST', body: input })
    assert.equal(uploaded.status, 201)
    document = uploaded.body.document
    assert.ok(document.id)
    const listing = (await api('research')).body.documents
    assert.equal(listing.length, 1)
    assert.equal(listing[0].id, document.id)
    assert.equal(listing[0].text, undefined)
    assert.equal(listing[0].pages, undefined)
  })
  await test('combined watches and document research persist without granting shell or file writes', async () => {
    const result = await api('commitments', { method: 'POST', body: {
      title: 'Registration', successCriteria: 'Registration confirmed', status: 'paused',
      deadline: '2027-01-10', watch: { type: 'combined' },
      situation: { institution: 'Example University', cycle: '2027', questions: ['Which program?'] },
      scope: { research: true, memory: false, urls: [], documents: [document.id], folders: [], officialDomains: [] },
    } })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    assert.equal(result.body.commitment.watch.type, 'combined')
    assert.deepEqual(result.body.commitment.scope.documents, [document.id])
    const cfg = (await api('settings')).body.config
    assert.equal(cfg.harness.allowShell, false)
    assert.equal(cfg.harness.allowWrites, false)
    const backup = (await api('backup')).body
    assert.equal(backup.researchDocuments.length, 1)
    assert.match(JSON.stringify(backup.researchDocuments[0]), /registration checklist/)
  })
  await test('wake reconciliation is asynchronous and obeys existing background permissions', async () => {
    assert.equal((await api('research/reconcile', { method: 'POST', body: {} })).status, 202)
    assert.equal((await api('research/reconcile', { method: 'POST', csrf: false, body: {} })).status, 403)
    const disabled = await api('settings', { method: 'PATCH', body: { config: { proactive: { research: { enabled: false } } } } })
    assert.equal(disabled.status, 200)
    assert.equal((await api('research')).body.enabled, false)
  })
  await test('privacy reset removes research evidence and does not replay retained chats', async () => {
    await api('settings', { method: 'PATCH', body: { config: { proactive: { research: { enabled: true } } } } })
    const before = Date.now()
    const wipe = await api('memory/wipe', { method: 'POST', body: { confirm: 'WIPE', scope: 'memory' } })
    assert.equal(wipe.status, 200)
    const research = (await api('research')).body
    assert.deepEqual(research.documents, [])
    assert.equal(research.stats.discovered, 0)
    assert.ok(Date.parse(research.enabledAt) >= before)
    assert.deepEqual((await api('commitments')).body.commitments, [])
    assert.equal((await api('backup')).body.researchDocuments.length, 0)
  })
} finally {
  const exited = new Promise((resolve) => app.once('exit', resolve))
  if (app.exitCode === null && !app.signalCode) {
    app.kill('SIGTERM')
    const timer = setTimeout(() => app.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }
  await fs.rm(sandbox, { recursive: true, force: true })
}
