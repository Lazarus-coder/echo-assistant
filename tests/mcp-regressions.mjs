import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { McpClient, McpHub } from '../lib/mcp.mjs'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-mcp-'))
const fixture = path.join(sandbox, 'server.mjs')
const callsFile = path.join(sandbox, 'calls.jsonl')
const oldSecret = process.env.ECHO_MCP_PRIVATE_TEST
process.env.ECHO_MCP_PRIVATE_TEST = 'should-not-be-inherited'
const clients = new Set()
const track = (client) => { clients.add(client); return client }
const cfg = { command: process.execPath, args: [fixture, callsFile], env: { ECHO_MCP_PUBLIC_TEST: 'explicit-test-value' } }
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }

await fs.writeFile(fixture, `
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const schema = ${JSON.stringify(schema)}
const line = readline.createInterface({ input: process.stdin })
const record = (m) => appendFileSync(process.argv[2], JSON.stringify(m) + '\\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
line.on('line', (text) => {
  const m = JSON.parse(text)
  record(m)
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1' } })
  if (m.method === 'tools/list') return reply(m.id, m.params.cursor ? { tools: [{ name: 'other', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: schema, annotations: { readOnlyHint: true } }], nextCursor: 'second' })
  if (m.method !== 'tools/call') return
  const name = m.params.name
  if (name === 'crash') return process.exit(7)
  if (name === 'wait') return
  if (name === 'error') return reply(m.id, { content: [{ type: 'text', text: 'fixture tool failed' }], isError: true })
  if (name === 'large') return reply(m.id, { content: [{ type: 'text', text: 'x'.repeat(20000) }] })
  if (name === 'environment') return reply(m.id, { content: [{ type: 'text', text: JSON.stringify({ private: process.env.ECHO_MCP_PRIVATE_TEST ?? null, explicit: process.env.ECHO_MCP_PUBLIC_TEST }) }] })
  reply(m.id, { content: [{ type: 'text', text: m.params.arguments.value ?? 'ok' }] })
})
`)

const recordedCalls = async () => (await fs.readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('fixture condition did not arrive')
}

try {
  await test('stdio SDK preserves schemas, annotations, pagination and stable tool names', async () => {
    const hub = track(new McpHub({ fixture: cfg }))
    await hub.connectAll()
    assert.equal(hub.status()[0].state, 'ready')
    assert.deepEqual(hub.tools().map((tool) => tool.name), ['fixture__echo', 'fixture__other'])
    assert.deepEqual(hub.tools()[0].inputSchema, schema)
    assert.equal(hub.tools()[0].annotations.readOnlyHint, true)
    assert.equal((await hub.call('fixture__echo', { value: 'test result' }, 1000)).text, 'test result')
    await hub.close()
  })

  await test('subprocesses inherit SDK safe defaults and explicit env, not model secrets', async () => {
    const client = track(new McpClient('environment', cfg))
    const result = JSON.parse((await client.callTool('environment', {})).text)
    assert.equal(result.private, null)
    assert.equal(result.explicit, 'explicit-test-value')
    await client.close()
  })

  await test('concurrent connects start one transport and malformed arguments never reach the server', async () => {
    const client = track(new McpClient('concurrent', cfg))
    const before = (await recordedCalls()).filter((m) => m.method === 'initialize').length
    await Promise.all([client.connect(), client.connect(), client.connect()])
    assert.equal((await recordedCalls()).filter((m) => m.method === 'initialize').length, before + 1)
    const calls = (await recordedCalls()).filter((m) => m.method === 'tools/call').length
    await assert.rejects(client.callTool('echo', ['invalid']), /必须是对象/)
    assert.equal((await recordedCalls()).filter((m) => m.method === 'tools/call').length, calls)
    await client.close()
  })

  await test('an uncertain disconnected call is never replayed; a later new call can reconnect', async () => {
    const client = track(new McpClient('crash', cfg))
    await client.connect()
    await assert.rejects(client.callTool('crash', {}, 1000), /closed/i)
    assert.equal((await recordedCalls()).filter((m) => m.method === 'tools/call' && m.params.name === 'crash').length, 1)
    assert.equal((await client.callTool('echo', { value: 'new request' }, 1000)).text, 'new request')
    assert.equal((await recordedCalls()).filter((m) => m.method === 'tools/call' && m.params.name === 'crash').length, 1)
    await client.close()
  })

  await test('AbortSignal cancels pending calls and notifies the server without replay', async () => {
    const client = track(new McpClient('abort', cfg))
    await client.connect()
    const ctrl = new AbortController()
    const result = client.callTool('wait', { token: 'abort-test' }, 2000, { signal: ctrl.signal })
    const rejected = assert.rejects(result, { name: 'AbortError' })
    await waitUntil(async () => (await recordedCalls()).some((m) => m.params?.arguments?.token === 'abort-test'))
    ctrl.abort()
    await rejected
    await waitUntil(async () => (await recordedCalls()).some((m) => m.method === 'notifications/cancelled'))
    assert.equal((await client.callTool('echo', { value: 'still usable' })).text, 'still usable')
    await client.close()
  })

  await test('timeouts are bounded and close rejects pending work and future calls', async () => {
    const client = track(new McpClient('timeout', cfg))
    await client.connect()
    await assert.rejects(client.callTool('wait', {}, 30), /timed out/i)
    const pending = client.callTool('wait', { token: 'close-test' }, 2000)
    const rejected = assert.rejects(pending, /关闭|closed|aborted/i)
    await waitUntil(async () => (await recordedCalls()).some((m) => m.params?.arguments?.token === 'close-test'))
    await client.close()
    await rejected
    await assert.rejects(client.callTool('echo', {}), /关闭/)
  })

  await test('server errors stay errors and returned text is bounded', async () => {
    const client = track(new McpClient('output', cfg))
    await assert.rejects(client.callTool('error', {}), /fixture tool failed/)
    const result = await client.callTool('large', {})
    assert.equal(result.truncated, true)
    assert.ok(result.text.length < 16100)
    await client.close()
  })

  await test('sanitized tool-name collisions cannot route a call to the wrong server', async () => {
    const hub = track(new McpHub({ 'test.one': cfg, test_one: cfg }))
    await hub.connectAll()
    assert.equal(hub.tools().length, 0)
    await assert.rejects(hub.call('test_one__echo', {}), /未知工具/)
    await hub.close()
  })

  await test('HTTP SDK negotiates sessions and reads SSE without waiting for stream closure', { timeout: 3000 }, async () => {
    const requests = []
    const openResponses = new Set()
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      let body = ''
      for await (const chunk of req) body += chunk
      const message = JSON.parse(body)
      requests.push({ ...message, headers: req.headers })
      if (!message.id && message.id !== 0) { res.writeHead(202); res.end(); return }
      let result
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
      if (message.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: schema }] }
      if (message.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        openResponses.add(res)
        res.on('close', () => openResponses.delete(res))
        if (message.params.arguments.value === 'wait') return
        res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'http result' }] } })}\r\n\r\n`)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = track(new McpClient('http', { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { 'x-fixture': 'configured' } }))
    try {
      await client.connect()
      assert.equal((await client.callTool('echo', { value: 'respond' }, 500)).text, 'http result')
      assert.ok(openResponses.size > 0, 'result arrived while server SSE stream remains open')
      const call = requests.find((m) => m.method === 'tools/call')
      assert.equal(call.headers['mcp-session-id'], 'fixture-session')
      assert.equal(call.headers['x-fixture'], 'configured')
      assert.ok(call.headers['mcp-protocol-version'])
      const pending = client.callTool('echo', { value: 'wait' }, 1000)
      const rejected = assert.rejects(pending, /关闭|closed|aborted/i)
      await waitUntil(() => requests.some((m) => m.params?.arguments?.value === 'wait'))
      await client.close()
      await rejected
      await waitUntil(() => openResponses.size === 0)
    } finally {
      await client.close()
      for (const response of openResponses) response.end()
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
    }
  })
} finally {
  await Promise.allSettled([...clients].map((client) => client.close()))
  if (oldSecret === undefined) delete process.env.ECHO_MCP_PRIVATE_TEST
  else process.env.ECHO_MCP_PRIVATE_TEST = oldSecret
  await fs.rm(sandbox, { recursive: true, force: true })
}
