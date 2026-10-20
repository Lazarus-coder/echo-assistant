import { webSearch, webFetch, searchWithFallback } from './search.mjs'
import { nativeSearch } from './native.mjs'
import { retrieve, appendObservation, listObservations, readObservations } from './memory.mjs'
import { queryGraph } from './graph.mjs'
import { generateImage } from './media.mjs'
import { record } from './metrics.mjs'
import { clip } from './util.mjs'
import { log } from './log.mjs'
import { WORKSPACE_TOOLS, executeWorkspaceTool } from './workspace.mjs'
import { currentWorkspacePermission } from './harness.mjs'

const HOUR = 3600000

/**
 * Search has two backends. `bing` is a direct scrape (~1-2s, measured);
 * `native` uses the gateway's hosted Responses web_search (28-37s but no scraping).
 * `auto` = bing first, native as fallback when parsing fails.
 */
async function runSearch(query, { cfg, count, signal }) {
  try {
    const r = await searchWithFallback({ query, cfg, count, nativeSearch, signal })
    record({ kind: 'search', engine: r.provider, ms: r.ms, ok: true, results: r.results?.length ?? 0, attempts: r.attempts })
    return r
  } catch (err) {
    record({ kind: 'search', engine: 'all', ms: null, ok: false, error: err.message, attempts: err.attempts })
    throw err
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname
  } catch {
    return u
  }
}

function formatSearch(res, { readTop }) {
  const lines = [`检索词：${res.query}`, `时间：${new Date().toISOString()}`, `来源引擎：${res.provider}`]
  if (res.answer) lines.push('', `引擎给出的结论：${res.answer}`)
  lines.push('', '结果：')
  res.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || hostOf(r.url)}  — ${hostOf(r.url)}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
  })
  return lines.join('\n')
}

export function buildToolRegistry({ cfg, mcp, conversationId, searchMode = 'auto', run, allowLocalTools = false }) {
  const cache = new Map()
  const sources = []
  const webEnabled = cfg.search.enabled && searchMode !== 'off' && !(cfg.search.order ?? []).includes('none') && (cfg.search.order ?? []).length > 0

  const defs = []
  const exec = Object.create(null)

  if (webEnabled) {
    defs.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索实时信息（新闻、价格、汇率、天气、版本发布、任何可能过期的事实）。返回标题、链接和摘要。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词，中文优先，可加 site: 或时间限定' } },
          required: ['query'],
        },
      },
    })
    exec.web_search = async ({ query }, { signal } = {}) => {
      const key = `search:${query}`
      if (cache.has(key)) return cache.get(key)
      const res = await runSearch(query, { cfg, count: cfg.search.maxResults ?? 6, signal })
      for (const r of res.results) if (r.url && !sources.some((s) => s.url === r.url)) sources.push({ url: r.url, title: r.title || hostOf(r.url), snippet: r.snippet ?? '' })
      let text = formatSearch(res, { readTop: false })
      if (cfg.search.readPages && res.results[0]?.url && !res.answer) {
        try {
          const page = await webFetch(res.results[0].url, { maxChars: 4000, signal })
          if (page.content) text += `\n\n--- 抓取首条结果正文（${page.title || hostOf(page.url)}）---\n${page.content}`
        } catch (err) {
          signal?.throwIfAborted()
          text += `\n\n（首条正文抓取失败：${err.message}）`
        }
      }
      const out = { text: clip(text, 9000), sources: res.results }
      cache.set(key, out)
      return out
    }

    defs.push({
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '读取指定网址的正文（去掉脚本和导航），用于查看搜索结果里的具体页面。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'http(s) 链接' } },
          required: ['url'],
        },
      },
    })
    exec.web_fetch = async ({ url }, { signal } = {}) => {
      const key = `fetch:${url}`
      if (cache.has(key)) return cache.get(key)
      const page = await webFetch(url, { maxChars: 9000, signal })
      if (page.url && !sources.some((s) => s.url === page.url)) sources.push({ url: page.url, title: page.title || hostOf(page.url), snippet: '' })
      const out = { text: clip(page.content ?? page.note ?? '(空)', 9000), page: { url: page.url, title: page.title } }
      cache.set(key, out)
      return out
    }
  }

  if (cfg.memory?.enabled) {
    defs.push({
      type: 'function',
      function: {
        name: 'memory_search',
        description: '检索本地长期记忆（核心记忆 + 观察清单）。当需要回忆用户说过的事、偏好、项目背景时使用。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number', description: '最多返回条数，默认 8' } },
          required: ['query'],
        },
      },
    })
    exec.memory_search = async ({ query, limit }) => {
      const hits = await retrieve(query, { topK: Math.min(20, limit ?? 8) })
      if (!hits.length) return { text: '记忆里没有相关条目。' }
      return { text: hits.map((h) => `- [${h.kind}|重要度${h.importance}|${String(h.created_at).slice(0, 10)}] ${h.text}`).join('\n'), hits: hits.map((h) => h.text) }
    }

    defs.push({
      type: 'function',
      function: {
        name: 'entity_lookup',
        description: '按实体（项目、工具、人、话题）查看知识图谱里的关联：它是什么、和什么有关、相关记忆条目有哪些。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '实体名，例如 Echo、MSCL、某项目名' } },
          required: ['name'],
        },
      },
    })
    exec.entity_lookup = async ({ name }) => {
      const r = await queryGraph(String(name ?? ''))
      if (!r) return { text: `图谱里还没有「${name}」这个实体。` }
      const lines = [`实体：${r.node.name}（${r.node.type}，被提到 ${r.node.mentions} 次）`]
      if (r.neighbors.length) lines.push(`相关：${r.neighbors.map((n) => `${n.name}(${n.mentions})`).join('、')}`)
      if (r.edges.length) lines.push('关系：', ...r.edges.slice(0, 8).map((e) => `- ${e.from} --${e.type}--> ${e.to}${e.evidence ? `（${e.evidence}）` : ''}`))
      const all = await readObservations()
      const facts = all.filter((o) => r.obsIds.includes(o.id) && o.status === 'active').slice(0, 10)
      if (facts.length) lines.push('相关记忆：', ...facts.map((f) => `- [${f.id}] ${f.text}`))
      return { text: lines.join('\n'), entity: r.node.name }
    }

    defs.push({
      type: 'function',
      function: {
        name: 'memory_write',
        description: '把一条值得长期记住的事实写进本地记忆。只在用户明确要求"记住"或出现稳定偏好/项目信息时使用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '一句独立陈述，不超过 60 字' },
            kind: { type: 'string', enum: ['user', 'project', 'feedback', 'reference', 'fact'] },
            importance: { type: 'number', description: '1-5，5 表示长期影响决策' },
          },
          required: ['text', 'kind'],
        },
      },
    })
    exec.memory_write = async ({ text, kind, importance }) => {
      const o = await appendObservation({ text, kind, importance, source: `tool:${conversationId}` })
      return { text: o ? `已记住（${o.id}）` : '内容太短，没有写入' }
    }
  }

  defs.push({
    type: 'function',
    function: {
      name: 'local_time',
      description: '获取本机当前日期、时间、星期。问"今天/本周/还有几天"时用它校准。',
      parameters: { type: 'object', properties: {} },
    },
  })
  exec.local_time = async () => {
    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return {
      text: `${now.toLocaleString('zh-CN', { timeZone: tz, hour12: false })} · ${now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: tz })} · 时区 ${tz} · Unix ${Math.floor(now.getTime() / 1000)}`,
    }
  }

  if (cfg.media?.imageOutput !== false && (cfg.upstream.imageModels ?? []).length) {
    const imageModels = (cfg.upstream.imageModels ?? []).map((m) => m.id)
    defs.push({
      type: 'function',
      function: {
        name: 'image_gen',
        description: '按描述生成图片（文生图）。用户要求画图、出图、做配图、生成插画时调用。把中文需求改写成具体的画面描述再传进来。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '画面描述，尽量具体：主体、风格、光线、构图、画幅' },
            model: { type: 'string', enum: imageModels, description: `出图模型，默认 ${cfg.upstream.defaultImageModel}` },
          },
          required: ['prompt'],
        },
      },
    })
    exec.image_gen = async ({ prompt, model }, { signal } = {}) => {
      const r = await generateImage({ prompt, model: model ?? cfg.upstream.defaultImageModel, conversationId, signal })
      const alt = String(prompt).replace(/[[\]()]/g, '').slice(0, 60)
      return {
        text: `图片已生成并保存到本地：${r.path}（模型 ${r.model}，${Math.round(r.bytes / 1024)}KB，耗时 ${(r.ms / 1000).toFixed(1)}s）`,
        images: [{ url: r.path, prompt: alt, model: r.model }],
      }
    }
  }

  if (allowLocalTools && cfg.harness?.enabled && run) {
    for (const tool of WORKSPACE_TOOLS) {
      const name = tool.function.name
      if (['workspace_write', 'workspace_edit'].includes(name) && !cfg.harness.allowWrites) continue
      if (name === 'shell_exec' && !cfg.harness.allowShell) continue
      defs.push(tool)
      exec[name] = async (args, context) => {
        const permissions = await currentWorkspacePermission(cfg.harness, name)
        return executeWorkspaceTool(name, args, {
          ...context, workspaceRoot: permissions.workspaceRoot,
          allowWrites: permissions.allowWrites, allowShell: permissions.allowShell,
          timeoutMs: permissions.shellTimeoutMs, maxOutputBytes: permissions.maxOutputBytes,
        })
      }
    }
  }
  if (allowLocalTools && run) {
    defs.push({
      type: 'function',
      function: {
        name: 'read_output',
        description: '分页读取本对话的工具输出文件。默认当前运行；恢复中断工作时可传旧 runId。使用结果中的 stepId 和 artifacts[].name。',
        parameters: {
          type: 'object', properties: {
            runId: { type: 'string' }, stepId: { type: 'string' }, name: { type: 'string' },
            offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 16000 },
          }, required: ['stepId', 'name'], additionalProperties: false,
        },
      },
    })
    exec.read_output = (args) => run.readOutput(args)
  }

  const mcpNames = new Set()
  for (const tool of allowLocalTools ? mcp?.tools?.() ?? [] : []) {
    const name = tool.name
    mcpNames.add(name)
    defs.push({
      type: 'function',
      function: {
        name,
        description: `[MCP] ${tool.description}`.slice(0, 900),
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    })
    exec[name] = async (args, context) => {
      const res = await mcp.call(name, args ?? {}, 60000, { signal: context?.signal })
      return { text: clip(res.text, 64000), truncated: res.truncated, via: 'mcp' }
    }
  }

  return {
    defs,
    sources,
    async call(name, args, { callId } = {}) {
      const fn = Object.hasOwn(exec, name) ? exec[name] : undefined
      if (!fn) {
        const err = new Error(`没有这个工具: ${name}`)
        err.known = Object.keys(exec)
        throw err
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) || '_raw' in args) throw new Error('工具参数必须是有效的 JSON 对象')
      run?.signal.throwIfAborted()
      const started = Date.now()
      const out = run ? await run.call({
        name, args, callId, needsApproval: name === 'shell_exec' || mcpNames.has(name), execute: fn,
      }) : await fn(args)
      return { ...out, ms: Date.now() - started }
    },
  }
}

export const TOOL_LABELS = {
  web_search: '搜索',
  web_fetch: '读取网页',
  memory_search: '查记忆',
  memory_write: '记下来',
  local_time: '看时间',
  workspace_list: '浏览文件',
  workspace_read: '读取文件',
  workspace_write: '写入文件',
  workspace_edit: '编辑文件',
  shell_exec: '运行命令',
  read_output: '读取输出',
}

export function labelFor(name) {
  if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name]
  if (name.includes('__')) return `MCP · ${name.split('__')[1]}`
  return name
}
