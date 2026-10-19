import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { log } from './log.mjs'

const JSONRPC = '2.0'
const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT = 30000

class McpError extends Error {}

/** Newline-delimited JSON-RPC over a child process (MCP stdio transport). */
class StdioTransport {
  constructor(cfg) {
    this.cfg = cfg
    this.buf = ''
    this.onMessage = null
    this.onClose = null
    this.proc = null
  }

  start() {
    if (!this.cfg.command) throw new McpError('stdio server 缺少 command')
    const env = { ...process.env, ...(this.cfg.env ?? {}) }
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env,
      cwd: this.cfg.cwd ?? undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        this.onMessage?.(msg)
      }
    })
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => log.debug(`[mcp:${this.cfg.name}] stderr:`, String(chunk).trim().slice(0, 400)))
    this.proc.on('close', (code) => {
      this.closed = true
      this.onClose?.(new McpError(`进程退出 code=${code}`))
    })
    this.proc.on('error', (err) => this.onClose?.(new McpError(`启动失败: ${err.message}`)))
  }

  send(payload) {
    if (!this.proc?.stdin.writable) throw new McpError('stdio 通道已关闭')
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  close() {
    try {
      this.proc?.kill('SIGTERM')
    } catch {}
  }
}

/** Streamable HTTP transport: POST JSON-RPC, accept JSON or SSE reply, session id header. */
class HttpTransport {
  constructor(cfg) {
    this.cfg = cfg
    this.sessionId = null
    this.onMessage = null
    this.onClose = null
    this.abort = new AbortController()
  }

  async start() {
    if (!this.cfg.url) throw new McpError('http server 缺少 url')
    await this.post({ jsonrpc: JSONRPC, method: 'ping', id: -1 }, { tolerateError: true })
  }

  async post(payload, { expectResponse = true, tolerateError = false } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    let res
    try {
      res = await fetch(this.cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT),
      })
    } catch (err) {
      if (tolerateError) return
      throw new McpError(`请求失败: ${err.message}`)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (!res.ok && !tolerateError) throw new McpError(`HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300))
    if (!expectResponse || payload.method?.startsWith('notifications/')) return
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (type.includes('event-stream')) {
      const text = await res.text()
      for (const frame of text.split('\n\n')) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const body = dataLine.slice(5).trim()
        if (!body) continue
        try {
          this.onMessage?.(JSON.parse(body))
        } catch {}
      }
      return
    }
    try {
      this.onMessage?.(await res.json())
    } catch {}
  }

  send(payload) {
    const isResponse = payload.id === undefined || payload.method || payload.result?.protocolVersion
    void this.post(payload, { expectResponse: !(payload.result !== undefined || payload.error), tolerateError: Boolean(payload.method) })
    void isResponse
  }

  close() {
    this.abort.abort()
  }
}

/** One MCP server connection with request/response correlation. */
export class McpClient {
  constructor(name, cfg) {
    this.name = name
    this.cfg = { ...cfg, name }
    this.pending = new Map()
    this.nextId = 1
    this.tools = []
    this.state = 'idle'
    this.emitter = new EventEmitter()
    this.transport = cfg.type === 'http' ? new HttpTransport(this.cfg) : new StdioTransport(this.cfg)
    this.transport.onMessage = (msg) => this.#handle(msg)
    this.transport.onClose = (err) => this.#failAll(err)
  }

  #handle(msg) {
    if (msg?.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(String(msg.id))
      if (!p) return
      this.pending.delete(String(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(new McpError(msg.error.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    if (msg?.method === 'logNotification' || msg?.method === 'notifications/message') {
      log.debug(`[mcp:${this.name}]`, JSON.stringify(msg.params).slice(0, 300))
    }
  }

  #failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err ?? new McpError('连接已关闭'))
    }
    this.pending.clear()
    this.state = 'closed'
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++
    const payload = { jsonrpc: JSONRPC, id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new McpError(`${method} 超时 ${timeoutMs}ms`))
      }, timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT)
      this.pending.set(String(id), { resolve, reject, timer })
      try {
        this.transport.send(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(String(id))
        reject(err)
      }
    })
  }

  notify(method, params) {
    try {
      this.transport.send({ jsonrpc: JSONRPC, method, params })
    } catch {}
  }

  async connect() {
    if (this.state === 'ready') return this.tools
    this.state = 'connecting'
    if (!(this.transport instanceof HttpTransport)) this.transport.start()
    else await this.transport.start()
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'echo-chat', version: '1.0.0' },
      capabilities: {},
    })
    this.serverInfo = init?.serverInfo
    this.notify('notifications/initialized', {})
    const listed = await this.request('tools/list', {})
    this.tools = (listed?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }))
    this.state = 'ready'
    log.info(`[mcp:${this.name}] 已连接，${this.tools.length} 个工具 (${this.serverInfo?.name ?? '?'})`)
    return this.tools
  }

  async callTool(toolName, args, timeoutMs) {
    if (this.state !== 'ready') await this.connect()
    try {
      const res = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs)
      return flattenContent(res)
    } catch (err) {
      if (this.cfg.type !== 'http' && /关闭|退出|closed/i.test(err.message)) {
        log.warn(`[mcp:${this.name}] 连接断开，尝试重连`)
        this.state = 'idle'
        await this.connect()
        const res = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs)
        return flattenContent(res)
      }
      throw err
    }
  }

  close() {
    this.transport.close()
    this.#failAll(new McpError('客户端已关闭'))
  }
}

function flattenContent(res) {
  const parts = res?.content ?? []
  const texts = []
  for (const part of parts) {
    if (part?.type === 'text') texts.push(part.text ?? '')
    else if (part?.type === 'image') texts.push('[图片，本客户端暂不渲染]')
    else if (part?.type === 'resource') texts.push(part?.resource?.text ?? '[resource]')
    else if (typeof part?.text === 'string') texts.push(part.text)
  }
  if (res?.structuredContent) texts.push(JSON.stringify(res.structuredContent))
  const text = texts.filter(Boolean).join('\n').trim()
  if (res?.isError) throw new McpError(text || '工具返回错误')
  return { text: text || '(无输出)' }
}

const SAFE_NAME = /[^a-zA-Z0-9_-]/g

/** Registry that keeps every configured MCP server alive and exposes a flat tool list. */
export class McpHub {
  constructor(servers = {}) {
    this.clients = new Map()
    this.index = new Map()
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || cfg.enabled === false) continue
      this.clients.set(name, new McpClient(name, cfg))
    }
  }

  async connectAll() {
    const results = await Promise.allSettled([...this.clients.values()].map((c) => c.connect()))
    let i = 0
    for (const [name, client] of this.clients) {
      const r = results[i++]
      if (r.status === 'rejected') {
        log.warn(`[mcp:${name}] 连接失败: ${r.reason?.message ?? r.reason}`)
        client.state = 'failed'
        continue
      }
      for (const tool of client.tools) {
        const exposed = `${name}__${tool.name}`.replace(SAFE_NAME, '_').slice(0, 64)
        this.index.set(exposed, { client, tool: tool.name, description: tool.description })
      }
    }
    return this.status()
  }

  status() {
    return [...this.clients.entries()].map(([name, c]) => ({
      name,
      state: c.state,
      tools: c.tools.length,
      error: c.state === 'failed' ? '连接失败，可查看服务日志' : undefined,
    }))
  }

  tools() {
    return [...this.index.entries()].map(([exposed, entry]) => ({
      name: exposed,
      description: entry.description || `MCP 工具 ${entry.tool}`,
      inputSchema: entry.toolSchema,
    }))
  }

  async call(exposedName, args, timeoutMs) {
    const entry = this.index.get(exposedName)
    if (!entry) throw new McpError(`未知工具 ${exposedName}`)
    return entry.client.callTool(entry.tool, args, timeoutMs)
  }

  close() {
    for (const c of this.clients.values()) c.close()
  }
}
