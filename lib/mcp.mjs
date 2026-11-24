import { domainText } from './domain-language.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { log } from './log.mjs'

const DEFAULT_TIMEOUT = 30000
const MAX_TEXT = 16000
const SAFE_NAME = /[^a-zA-Z0-9_-]/g

class McpError extends Error {}

function timeoutFor(value) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 300000) : DEFAULT_TIMEOUT
}

async function waitForConnection(promise, signal) {
  signal?.throwIfAborted()
  if (!signal) return promise
  let cancel
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        cancel = () => reject(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Protocol negotiation, framing, correlation, and cancellation belong to the SDK. */
export class McpClient {
  constructor(name, cfg) {
    this.name = name
    this.cfg = cfg
    this.tools = []
    this.state = 'idle'
    this.client = null
    this.transport = null
    this.connecting = null
    this.closed = false
    this.lifetime = new AbortController()
  }

  async connect({ signal } = {}) {
    signal?.throwIfAborted()
    if (this.closed) throw new McpError(domainText('mcp.closed'))
    if (this.state === 'ready') return this.tools
    if (!this.connecting) {
      this.connecting = this.#connect().finally(() => { this.connecting = null })
    }
    return waitForConnection(this.connecting, signal)
  }

  async #connect() {
    this.state = 'connecting'
    const client = new Client({ name: 'echo-chat', version: '1.0.0' }, { capabilities: {} })
    this.client = client
    client.onclose = () => {
      if (this.client === client) this.state = 'closed'
    }
    client.onerror = (err) => log.debug(`[mcp:${this.name}]`, String(err.message).slice(0, 300))
    const options = { signal: this.lifetime.signal, timeout: timeoutFor(this.cfg.timeoutMs) }
    try {
      if (this.cfg.type === 'http') {
        if (!this.cfg.url) throw new McpError(domainText('mcp.missingUrl'))
        const url = new URL(this.cfg.url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new McpError(domainText('mcp.invalidProtocol'))
        this.transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: this.cfg.headers ?? {} },
        })
      } else {
        if (!this.cfg.command) throw new McpError(domainText('mcp.missingCommand'))
        this.transport = new StdioClientTransport({
          command: this.cfg.command,
          args: this.cfg.args ?? [],
          // The SDK inherits only its safe environment list. Secrets require explicit configuration.
          env: this.cfg.env,
          cwd: this.cfg.cwd,
          stderr: 'pipe',
          maxBufferSize: 2 * 1024 * 1024,
        })
        this.transport.stderr?.on('data', (chunk) => log.debug(`[mcp:${this.name}] stderr:`, String(chunk).trim().slice(0, 400)))
      }
      await client.connect(this.transport, options)
      this.serverInfo = client.getServerVersion()
      const tools = []
      const cursors = new Set()
      let cursor
      do {
        const listed = await client.listTools(cursor ? { cursor } : {}, options)
        tools.push(...listed.tools)
        cursor = listed.nextCursor
        if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new McpError(domainText('mcp.invalidPagination'))
        if (cursor) cursors.add(cursor)
        if (tools.length > 1000) throw new McpError(domainText('mcp.tooManyTools'))
      } while (cursor)
      this.lifetime.signal.throwIfAborted()
      client.cacheToolMetadata(tools)
      this.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }))
      this.state = 'ready'
      log.info(domainText('mcp.connected', this.name, this.tools.length, this.serverInfo?.name ?? '?'))
      return this.tools
    } catch (err) {
      await client.close().catch(() => {})
      this.state = this.closed ? 'closed' : 'failed'
      throw err
    }
  }

  async callTool(toolName, args, timeoutMs, { signal } = {}) {
    signal?.throwIfAborted()
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) throw new McpError(domainText('mcp.invalidArguments'))
    if (this.state !== 'ready') await this.connect({ signal })
    const requestSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    requestSignal.throwIfAborted()
    // A disconnected call may already have changed external state. Never replay it.
    try {
      const result = await this.client.callTool({ name: toolName, arguments: args ?? {} }, undefined, {
        signal: requestSignal,
        timeout: timeoutFor(timeoutMs ?? this.cfg.timeoutMs),
      })
      return flattenContent(result)
    } catch (err) {
      requestSignal.throwIfAborted()
      throw err
    }
  }

  close() {
    this.closed = true
    this.state = 'closed'
    this.lifetime.abort(new DOMException(domainText('mcp.closed'), 'AbortError'))
    return this.client?.close().catch((err) => log.debug(domainText('mcp.closedLog', this.name), err.message)) ?? Promise.resolve()
  }
}

function flattenContent(result) {
  let text = ''
  let truncated = false
  const append = (value) => {
    if (!value) return
    const part = String(value)
    const room = Math.max(0, MAX_TEXT - text.length)
    const next = `${text ? '\n' : ''}${part}`
    text += next.slice(0, room)
    if (next.length > room) truncated = true
  }
  for (const part of result?.content ?? []) {
    if (part.type === 'text') append(part.text)
    else if (part.type === 'image') append(domainText('mcp.imageUnavailable'))
    else if (part.type === 'resource') append(part.resource?.text ?? '[resource]')
    else if (part.type === 'resource_link') append(`${part.name ?? domainText('mcp.resource')}：${part.uri}`)
    else if (typeof part.text === 'string') append(part.text)
  }
  if (result?.structuredContent) append(JSON.stringify(result.structuredContent))
  text = text.trim() || domainText('mcp.noOutput')
  if (truncated) text += domainText('mcp.truncated')
  if (result?.isError) throw new McpError(text)
  return { text, truncated }
}

/** Configured server names remain stable across the SDK migration. */
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
    const results = await Promise.allSettled([...this.clients.values()].map((client) => client.connect()))
    this.index.clear()
    const collisions = new Set()
    let i = 0
    for (const [name, client] of this.clients) {
      const result = results[i++]
      if (result.status === 'rejected') {
        log.warn(domainText('mcp.connectionFailed', name, result.reason?.message ?? result.reason))
        continue
      }
      for (const tool of client.tools) {
        const exposed = `${name}__${tool.name}`.replace(SAFE_NAME, '_').slice(0, 64)
        if (this.index.has(exposed) || collisions.has(exposed)) {
          this.index.delete(exposed)
          collisions.add(exposed)
          log.warn(domainText('mcp.duplicateTool', name, exposed))
          continue
        }
        this.index.set(exposed, { client, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })
      }
    }
    return this.status()
  }

  status() {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      state: client.state,
      tools: client.tools.length,
      error: client.state === 'failed' ? domainText('mcp.serverUnavailable') : undefined,
    }))
  }

  tools() {
    return [...this.index.entries()].map(([name, entry]) => ({
      name,
      description: entry.description || domainText('mcp.tool', entry.tool),
      inputSchema: entry.inputSchema,
      // Descriptive hints from the server; never authorization to execute a tool.
      annotations: entry.annotations,
    }))
  }

  async call(exposedName, args, timeoutMs, options) {
    const entry = this.index.get(exposedName)
    if (!entry) throw new McpError(domainText('mcp.unknownTool', exposedName))
    return entry.client.callTool(entry.tool, args, timeoutMs, options)
  }

  close() {
    return Promise.allSettled([...this.clients.values()].map((client) => client.close()))
  }
}
