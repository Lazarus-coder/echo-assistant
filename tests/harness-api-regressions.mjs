import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-harness-api-'))
const data = path.join(sandbox, 'data')
const workspace = path.join(sandbox, 'workspace')
const configPath = path.join(sandbox, 'config.json')
const mcpFixture = path.join(sandbox, 'mcp-fixture.mjs')
await fs.mkdir(workspace)
await fs.writeFile(mcpFixture, `
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin })
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
lines.on('line', (raw) => {
  const message = JSON.parse(raw)
  if (message.method === 'initialize') return reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } })
  if (message.method === 'tools/list') return reply(message.id, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] })
  if (message.method === 'tools/call') return reply(message.id, { content: [{ type: 'text', text: 'fixture result' }] })
})
`)
const modelRequests = []
const streams = new Set()
const testProcesses = new Set()
const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`
const approvedArgs = { command: "printf 'approved output\\n'; printf 'approved file\\n' > approved.txt", cwd: '.', timeoutMs: 1000 }
const longArgs = { command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('worker pid=' + process.pid + '\\n'); setInterval(() => process.stdout.write('working\\n'), 30)")}`, cwd: '.', timeoutMs: 10000 }

function callsFor(scenario, toolMessages) {
  const count = toolMessages.length
  if (scenario === 'approve' && count === 1) {
    const output = JSON.parse(toolMessages[0].content.split('\n输出文件（可用 read_output 读取）：')[1])
    return [{ name: 'read_output', args: { stepId: output.stepId, name: 'stdout.txt', maxChars: 8 } }]
  }
  if (scenario === 'files') {
    const hash = count >= 2 ? JSON.parse(toolMessages[1].content.split('\n输出文件')[0]).hash : null
    return [
      { name: 'workspace_write', args: { path: 'notes.txt', content: 'Hello workspace\n' } },
      { name: 'workspace_read', args: { path: 'notes.txt' } },
      { name: 'workspace_edit', args: { path: 'notes.txt', oldText: 'Hello workspace', newText: 'Hello harness', expectedHash: hash } },
      { name: 'workspace_read', args: { path: 'notes.txt' } },
    ].slice(count, count + 1)
  }
  if (count) return []
  if (scenario === 'approve') return [{ name: 'shell_exec', args: approvedArgs }]
  if (scenario === 'boundary') return [{ name: 'shell_exec', args: { command: "printf 'forbidden' > boundary.txt", cwd: '.' } }]
  if (scenario === 'stop' || scenario === 'disable') return [{ name: 'shell_exec', args: longArgs }]
  if (scenario === 'deny') return [
    { name: 'shell_exec', args: { command: "printf 'should never run' > denied.txt", cwd: '.' } },
    { name: 'workspace_write', args: { path: 'after-denial.txt', content: 'should never run' } },
  ]
  if (scenario === 'traversal') return [{ name: 'workspace_write', args: { path: '../escaped.txt', content: 'must not escape' } }]
  return []
}

const mock = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer harness-local-test-key')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const lastUser = body.messages.findLastIndex((message) => message.role === 'user')
    const scenario = String(body.messages[lastUser]?.content ?? '').replace('HARNESS:', '')
    modelRequests.push({ scenario, body })
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture conversation' } }] }))
      return
    }
    const toolMessages = body.messages.slice(lastUser + 1).filter((message) => message.role === 'tool')
    const calls = callsFor(scenario, toolMessages)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (calls.length) {
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]
        const args = JSON.stringify(call.args)
        const middle = Math.floor(args.length / 2)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${scenario}_${toolMessages.length + index}`, type: 'function', function: { name: call.name, arguments: args.slice(0, middle) } }] } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(middle) } }] } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    } else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Finished local ${scenario} review.` }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
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
function fixtureFetch(url, options = {}) {
  if (!options.headers?.host) return fetch(url, options)
  // Fetch may overwrite Host; use HTTP directly to exercise DNS-rebinding defenses.
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method ?? 'GET', headers: options.headers, signal: options.signal,
    }, (response) => resolve(new Response(Readable.toWeb(response), {
      status: response.statusCode,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])),
    })))
    request.on('error', reject)
    request.end(options.body)
  })
}
await fs.writeFile(configPath, JSON.stringify({
  bind: 'local', requirePassword: false, onboarding: { completed: true },
  upstream: { apiKeyEnv: 'ECHO_HARNESS_TEST_KEY', baseUrlEnv: 'ECHO_HARNESS_TEST_URL', defaultModel: 'local-test', utilityModel: 'local-test', models: [{ id: 'local-test', label: 'Fixture' }] },
  memory: { enabled: false, extract: false, inject: false }, search: { enabled: false },
  screen: { enabled: false }, companion: { enabled: false }, dream: { enabled: false },
  proactive: { enabled: false, notify: false }, media: { imageOutput: false }, mcpServers: {},
}))

let app
let logs = ''
async function waitUntil(check, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${label}.\n${logs.slice(-2000)}`)
}
async function startApp() {
  logs = ''
  app = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ECHO_DATA_DIR: data, ECHO_CONFIG: configPath, ECHO_BIND: 'local', ECHO_PORT: String(appPort),
      ECHO_HARNESS_TEST_KEY: 'harness-local-test-key', ECHO_HARNESS_TEST_URL: `http://127.0.0.1:${mock.address().port}/v1`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-16000) })
  app.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-16000) })
  await waitUntil(async () => {
    if (app.exitCode !== null) throw new Error(`Fixture app exited: ${logs}`)
    return fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)
  }, 'server startup')
}
async function stopApp() {
  if (!app || app.exitCode !== null || app.signalCode) return
  const child = app
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(timer) }
}
async function api(route, { method = 'GET', body, csrf = true, cookie, headers = {} } = {}) {
  const response = await fixtureFetch(`${base}/api/${route}`, {
    method,
    headers: { ...(csrf ? { 'x-echo-request': 'echo' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  })
  return { status: response.status, body: await response.json(), headers: response.headers }
}
const configure = (config, extra) => api('harness', { method: 'PATCH', body: { config }, ...extra })
const getRun = async (runId) => (await api(`runs/${runId}`)).body.run
const exists = (filename) => fs.stat(filename).then(() => true, () => false)

async function startChat(scenario, headers = {}) {
  const created = await api('conversations', { method: 'POST', body: { title: `Harness ${scenario}` } })
  assert.equal(created.status, 200)
  const conversationId = created.body.id
  const ctrl = new AbortController()
  const response = await fixtureFetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'x-echo-request': 'echo', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ conversationId, userText: `HARNESS:${scenario}` }), signal: ctrl.signal,
  })
  assert.equal(response.status, 200)
  const stream = { conversationId, ctrl, events: [], ended: false, error: null }
  streams.add(stream)
  stream.done = (async () => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        buffer += decoder.decode(part.value, { stream: true })
        let match
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          const event = frame.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim()
          const value = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (event && value) stream.events.push({ event, ...JSON.parse(value) })
        }
      }
      return stream.events
    } catch (error) { stream.error = error; throw error }
    finally { reader.releaseLock(); stream.ended = true; streams.delete(stream) }
  })()
  stream.done.catch(() => {})
  return stream
}
async function event(stream, type) {
  return waitUntil(() => {
    const found = stream.events.find((item) => item.event === type)
    if (found) return found
    if (stream.ended) throw new Error(`Stream ended before ${type}: ${JSON.stringify(stream.events)} ${stream.error ?? ''}`)
    return null
  }, type)
}
async function finish(stream) {
  await waitUntil(() => stream.ended, 'chat completion')
  await stream.done
  const done = stream.events.find((item) => item.event === 'done')
  assert.ok(done, `Expected done event: ${JSON.stringify(stream.events)}`)
  return done
}
async function approve(stream) {
  const pending = await event(stream, 'tool_approval')
  const result = await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, { method: 'POST', body: { decision: 'approve' } })
  assert.equal(result.status, 200)
  return pending
}
async function workerPid(stream) {
  const pid = await waitUntil(() => {
    const output = stream.events.filter((item) => item.event === 'tool_output').map((item) => item.text).join('')
    return Number(output.match(/worker pid=(\d+)/)?.[1]) || null
  }, 'worker output')
  testProcesses.add(pid)
  return pid
}
async function exited(pid) {
  await waitUntil(() => {
    try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }, 'shell process exit')
  testProcesses.delete(pid)
}

let fileRun
let shellRun
let stdoutArtifact
try {
  await startApp()
  await test('harness configuration is opt-in and rejects invalid paths and cross-site mutations', async () => {
    const initial = await api('harness')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.local, true)
    assert.equal(initial.body.config.enabled, false)
    assert.equal((await configure({ enabled: true, workspaceRoot: workspace }, { csrf: false })).status, 403)
    assert.equal((await configure({ enabled: true })).status, 400)
    assert.equal((await configure({ workspaceRoot: path.join(sandbox, 'missing') })).status, 400)
    assert.equal((await configure({ workspaceRoot: configPath })).status, 400)
    assert.equal((await configure({ workspaceRoot: path.parse(workspace).root })).status, 400)
    assert.equal((await configure({ workspaceRoot: data })).status, 403)
    const enabled = await configure({ enabled: true, workspaceRoot: workspace, allowWrites: true, allowShell: true, shellTimeoutMs: 10000, maxToolRounds: 8 })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.config.workspaceRoot, await fs.realpath(workspace))
  })

  await test('mocked model can write, read, hash-check edit, verify and persist review snapshots', async () => {
    const stream = await startChat('files')
    const done = await finish(stream)
    assert.match(done.message.content, /Finished local files/)
    assert.equal(await fs.readFile(path.join(workspace, 'notes.txt'), 'utf8'), 'Hello harness\n')
    fileRun = await getRun(done.message.runId)
    assert.equal(fileRun.status, 'completed')
    assert.deepEqual(fileRun.steps.map((step) => step.name), ['workspace_write', 'workspace_read', 'workspace_edit', 'workspace_read'])
    assert.ok(fileRun.steps.every((step) => step.status === 'completed'))
    assert.match(JSON.parse(fileRun.steps[3].result).content, /Hello harness/)
    const edit = fileRun.steps[2]
    assert.equal(edit.args.expectedHash, JSON.parse(fileRun.steps[1].result).hash)
    assert.equal(edit.changes[0].path, 'notes.txt')
    const before = edit.artifacts.find((artifact) => artifact.name.endsWith('.before.txt'))
    const after = edit.artifacts.find((artifact) => artifact.name.endsWith('.after.txt'))
    assert.ok(before && after, 'file review snapshots must remain downloadable')
    assert.equal(await (await fetch(`${base}${before.url}`)).text(), 'Hello workspace\n')
    assert.equal(await (await fetch(`${base}${after.url}`)).text(), 'Hello harness\n')
    assert.equal((await api(`runs?conversationId=${stream.conversationId}`)).body.runs[0].id, fileRun.id)
    const disk = JSON.parse(await fs.readFile(path.join(data, 'runs', fileRun.id, 'run.json'), 'utf8'))
    assert.deepEqual(disk.steps, fileRun.steps)
  })

  await test('shell waits for exact-argument approval and exposes captured output artifacts', async () => {
    const stream = await startChat('approve')
    const pending = await event(stream, 'tool_approval')
    assert.deepEqual(pending.approval.args, approvedArgs)
    const waiting = await getRun(pending.runId)
    assert.equal(waiting.status, 'awaiting_approval')
    assert.equal(waiting.steps[0].status, 'awaiting_approval')
    assert.equal(await exists(path.join(workspace, 'approved.txt')), false)
    assert.equal((await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, { method: 'POST', body: { decision: 'approve' }, csrf: false })).status, 403)
    const approved = await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, {
      method: 'POST', body: { decision: 'approve', args: { command: "printf 'tampered' > tampered.txt" } },
    })
    assert.equal(approved.status, 200)
    const done = await finish(stream)
    assert.equal(done.aborted, undefined)
    assert.equal(await fs.readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'approved file\n')
    assert.equal(await exists(path.join(workspace, 'tampered.txt')), false, 'approval payload cannot replace the reviewed command')
    shellRun = await getRun(pending.runId)
    assert.equal(shellRun.status, 'completed')
    assert.deepEqual(shellRun.steps[0].args, approvedArgs)
    assert.equal(shellRun.steps[0].approval.status, 'approved')
    assert.equal(shellRun.steps[0].exitCode, 0)
    assert.equal(shellRun.steps[1].name, 'read_output')
    assert.deepEqual(JSON.parse(shellRun.steps[1].result), { content: 'approved', nextOffset: 8, totalChars: 16 })
    stdoutArtifact = shellRun.steps[0].artifacts.find((artifact) => artifact.name === 'stdout.txt')
    assert.ok(stdoutArtifact, 'completed shell stdout must be attached to the saved run')
    const output = await fetch(`${base}${stdoutArtifact.url}`)
    assert.equal(output.status, 200)
    assert.match(output.headers.get('content-disposition'), /attachment/)
    assert.equal(await output.text(), 'approved output\n')
    assert.equal((await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, { method: 'POST', body: { decision: 'approve' } })).status, 409)
  })

  await test('denial ends the entire action batch without executing or asking the model to retry', async () => {
    const stream = await startChat('deny')
    const pending = await event(stream, 'tool_approval')
    assert.equal((await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, { method: 'POST', body: { decision: 'deny' } })).status, 200)
    const done = await finish(stream)
    assert.equal(done.aborted, true)
    assert.equal(await exists(path.join(workspace, 'denied.txt')), false)
    assert.equal(await exists(path.join(workspace, 'after-denial.txt')), false)
    const run = await getRun(pending.runId)
    assert.equal(run.status, 'cancelled')
    assert.equal(run.steps.length, 1)
    assert.equal(run.steps[0].approval.status, 'denied')
    assert.equal(modelRequests.filter((request) => request.scenario === 'deny' && request.body.stream).length, 1)
  })

  await test('Stop terminates the running process and preserves partial stdout in run history', async () => {
    const stream = await startChat('stop')
    const pending = await approve(stream)
    const pid = await workerPid(stream)
    assert.equal((await api('chat/stop', { method: 'POST', body: { conversationId: stream.conversationId } })).body.stopped, true)
    const done = await finish(stream)
    assert.equal(done.aborted, true)
    await exited(pid)
    const run = await getRun(pending.runId)
    assert.equal(run.status, 'cancelled')
    assert.equal(run.steps[0].status, 'cancelled')
    const artifact = run.steps[0].artifacts.find((item) => item.name === 'stdout.txt')
    assert.ok(artifact, 'cancelled shell stdout must remain attached to the saved run')
    assert.match(await (await fetch(`${base}${artifact.url}`)).text(), /worker pid=/)
    const saved = (await api(`conversations/${stream.conversationId}`)).body.messages.at(-1)
    assert.equal(saved.runId, run.id)
    assert.equal(saved.aborted, true)
  })

  await test('revoking workspace permission cancels an already running command', async () => {
    const stream = await startChat('disable')
    const pending = await approve(stream)
    const pid = await workerPid(stream)
    assert.equal((await configure({ enabled: false })).status, 200)
    assert.equal((await finish(stream)).aborted, true)
    await exited(pid)
    assert.equal((await getRun(pending.runId)).status, 'cancelled')
    assert.equal((await configure({ enabled: true })).status, 200)
  })

  await test('workspace escape attempts and forged artifact paths cannot read or write outside scope', async () => {
    const stream = await startChat('traversal')
    const done = await finish(stream)
    assert.equal(await exists(path.join(sandbox, 'escaped.txt')), false)
    const run = await getRun(done.message.runId)
    assert.equal(run.status, 'failed')
    assert.match(run.steps[0].error, /traversal|outside/i)
    const prefix = `/api/runs/${shellRun.id}/artifacts/${shellRun.steps[0].id}`
    for (const suffix of ['..%2Fconfig.json', '%2Fetc%2Fpasswd', 'not-registered.txt']) {
      const response = await fetch(`${base}${prefix}/${suffix}`)
      assert.ok(response.status === 400 || response.status === 404, `Unexpected status ${response.status} for ${suffix}`)
    }
  })

  await test('MCP configuration patches reload the registry without a separate restart flag', async () => {
    const configured = await api('settings', { method: 'PATCH', body: { config: {
      mcpServers: { fixture: { type: 'stdio', enabled: true, command: process.execPath, args: [mcpFixture] } },
    } } })
    assert.equal(configured.status, 200)
    assert.equal(configured.body.mcp.find((server) => server.name === 'fixture')?.state, 'ready')
    assert.ok((await api('mcp')).body.tools.some((tool) => tool.name === 'fixture__echo'))
    const disabled = await api('settings', { method: 'PATCH', body: { config: { mcpServers: { fixture: { enabled: false } } } } })
    assert.equal(disabled.status, 200)
    assert.equal((await api('mcp')).body.tools.some((tool) => tool.name === 'fixture__echo'), false)
    const enabled = await api('settings', { method: 'PATCH', body: { config: { mcpServers: { fixture: { enabled: true } } } } })
    assert.equal(enabled.status, 200)
    assert.ok((await api('mcp')).body.tools.some((tool) => tool.name === 'fixture__echo'))
  })

  await test('untrusted Host or Origin cannot configure, approve, download or receive local tools', async () => {
    const stream = await startChat('boundary')
    const pending = await event(stream, 'tool_approval')
    for (const [label, headers] of [
      ['host', { host: 'attacker.example' }],
      ['origin', { origin: 'https://attacker.example' }],
      ['opaque_origin', { origin: 'null' }],
    ]) {
      const exposed = await api('harness', { headers })
      assert.equal(exposed.status, 200)
      assert.equal(exposed.body.local, false)
      assert.equal(exposed.body.config.workspaceRoot, '')
      assert.equal((await configure({ enabled: false }, { headers })).status, 403)
      assert.equal((await api('settings', { method: 'PATCH', headers, body: { config: { harness: { enabled: false } } } })).status, 403)
      assert.equal((await api('settings', { method: 'PATCH', headers, body: { config: { mcpServers: { fixture: { enabled: false } } } } })).status, 403)
      assert.equal((await api('mcp/reload', { method: 'POST', headers, body: {} })).status, 403)
      assert.equal((await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, { method: 'POST', headers, body: { decision: 'approve' } })).status, 403)
      assert.equal((await fixtureFetch(`${base}${stdoutArtifact.url}`, { headers })).status, 403)
      assert.equal((await api(`runs/${shellRun.id}`, { headers })).status, 403)
      const untrusted = await startChat(`capabilities_${label}`, headers)
      await finish(untrusted)
      const request = modelRequests.find((item) => item.scenario === `capabilities_${label}` && item.body.stream).body
      assert.ok(!request.tools.some((tool) => /^(workspace_|shell_exec|read_output|fixture__)/.test(tool.function.name)), `${label} received local tool capabilities`)
    }
    assert.equal((await getRun(pending.runId)).status, 'awaiting_approval')
    assert.equal(await exists(path.join(workspace, 'boundary.txt')), false)
    assert.equal((await api(`runs/${pending.runId}/approvals/${pending.approval.id}`, { method: 'POST', body: { decision: 'deny' } })).status, 200)
    assert.equal((await finish(stream)).aborted, true)
    assert.equal((await api('settings', { method: 'PATCH', body: { config: { mcpServers: { fixture: { enabled: false } } } } })).status, 200)
  })

  await test('restart preserves completed history, expires interrupted approval and never replays work', async () => {
    await stopApp()
    const interruptedId = 'run_interrupted_fixture'
    const interruptedDir = path.join(data, 'runs', interruptedId)
    await fs.mkdir(interruptedDir, { recursive: true })
    await fs.writeFile(path.join(interruptedDir, 'run.json'), JSON.stringify({
      id: interruptedId, conversationId: fileRun.conversationId, workspaceRoot: workspace,
      status: 'awaiting_approval', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      steps: [{ id: 'step_interrupted_fixture', name: 'shell_exec', status: 'awaiting_approval', args: { command: "printf 'replayed' > replayed.txt" }, approval: { id: 'approval_interrupted_fixture', status: 'pending' } }],
    }))
    const callsBefore = modelRequests.length
    await startApp()
    assert.deepEqual((await getRun(shellRun.id)).steps, shellRun.steps)
    const interrupted = await getRun(interruptedId)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.steps[0].status, 'interrupted')
    assert.equal(interrupted.steps[0].approval.status, 'expired')
    assert.equal((await api(`runs/${interruptedId}/approvals/approval_interrupted_fixture`, { method: 'POST', body: { decision: 'approve' } })).status, 409)
    assert.equal(await exists(path.join(workspace, 'replayed.txt')), false)
    assert.equal(modelRequests.length, callsBefore)
    assert.equal(await (await fetch(`${base}${stdoutArtifact.url}`)).text(), 'approved output\n')
  })

  await test('artifact downloads and run history respect configured authentication', async () => {
    assert.equal((await api('password', { method: 'POST', body: { next: 'fixture-password-only' } })).status, 200)
    assert.equal((await api('auth', { method: 'PATCH', body: { required: true } })).status, 200)
    assert.equal((await fetch(`${base}${stdoutArtifact.url}`)).status, 401)
    assert.equal((await api(`runs/${shellRun.id}`)).status, 401)
    const login = await api('login', { method: 'POST', body: { password: 'fixture-password-only' } })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const authorized = await fetch(`${base}${stdoutArtifact.url}`, { headers: { cookie } })
    assert.equal(authorized.status, 200)
    assert.equal(await authorized.text(), 'approved output\n')
  })
} finally {
  for (const stream of streams) stream.ctrl.abort()
  await Promise.allSettled([...streams].map((stream) => stream.done))
  await stopApp()
  for (const pid of testProcesses) { try { process.kill(pid, 'SIGKILL') } catch {} }
  mock.closeAllConnections()
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(sandbox, { recursive: true, force: true })
}
