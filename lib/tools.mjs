import { domainText } from './domain-language.mjs'
import { languageText } from './language.mjs'
import { webSearch, webFetch, searchWithFallback } from './search.mjs'
import { nativeSearch } from './native.mjs'
import { retrieve, appendObservation, listObservations, readObservations } from './memory.mjs'
import { queryGraph } from './graph.mjs'
import { generateImage } from './media.mjs'
import { record } from './metrics.mjs'
import { assertId, clip } from './util.mjs'
import { loadConfig } from './config.mjs'
import { log } from './log.mjs'
import { WORKSPACE_TOOLS, executeWorkspaceTool } from './workspace.mjs'
import { currentWorkspacePermission } from './harness.mjs'
import { createCommitment, updateCommitment, listCommitments, completeCommitmentFromMessage, canDeliverPreparation, pendingPreparations } from './commitments.mjs'
import { getConversation } from './store.mjs'

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
  const lines = [domainText('tools.searchQuery', res.query), domainText('tools.searchTime', new Date().toISOString()), domainText('tools.searchProvider', res.provider)]
  if (res.answer) lines.push('', domainText('tools.searchAnswer', res.answer))
  lines.push('', domainText('tools.searchResults'))
  res.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || hostOf(r.url)}  — ${hostOf(r.url)}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
  })
  return lines.join('\n')
}

const planningTools = new Set(['workspace_list', 'workspace_read', 'workspace_search', 'read_output', 'web_search', 'web_fetch', 'memory_search', 'entity_lookup', 'follow_up_list', 'local_time'])

export function buildToolRegistry({ cfg, mcp, conversationId, searchMode = 'auto', run, allowLocalTools = false, readOnly = false }) {
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
        description: domainText('tools.searchDescription'),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: domainText('tools.searchKeywords') } },
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
          if (page.content) text += domainText('tools.fetchedFirstResult', page.title || hostOf(page.url), page.content)
        } catch (err) {
          signal?.throwIfAborted()
          text += domainText('tools.firstFetchFailed', err.message)
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
        description: domainText('tools.fetchDescription'),
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: domainText('tools.url') } },
          required: ['url'],
        },
      },
    })
    exec.web_fetch = async ({ url }, { signal } = {}) => {
      const key = `fetch:${url}`
      if (cache.has(key)) return cache.get(key)
      const page = await webFetch(url, { maxChars: 9000, signal })
      if (page.url && !sources.some((s) => s.url === page.url)) sources.push({ url: page.url, title: page.title || hostOf(page.url), snippet: '' })
      const out = { text: clip(page.content ?? page.note ?? domainText('tools.empty'), 9000), page: { url: page.url, title: page.title } }
      cache.set(key, out)
      return out
    }
  }

  if (cfg.memory?.enabled) {
    defs.push({
      type: 'function',
      function: {
        name: 'memory_search',
        description: domainText('tools.memorySearchDescription'),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number', description: domainText('tools.maxResults') } },
          required: ['query'],
        },
      },
    })
    exec.memory_search = async ({ query, limit }) => {
      const hits = await retrieve(query, { topK: Math.min(20, limit ?? 8) })
      if (!hits.length) return { text: domainText('tools.noMemory') }
      return { text: hits.map((h) => domainText('tools.memoryEntry', h.kind, h.importance, String(h.created_at).slice(0, 10), h.text)).join('\n'), hits: hits.map((h) => h.text) }
    }

    defs.push({
      type: 'function',
      function: {
        name: 'entity_lookup',
        description: domainText('tools.graphDescription'),
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: domainText('tools.entityName') } },
          required: ['name'],
        },
      },
    })
    exec.entity_lookup = async ({ name }) => {
      const r = await queryGraph(String(name ?? ''))
      if (!r) return { text: domainText('tools.entityMissing', name) }
      const lines = [domainText('tools.entitySummary', r.node.name, r.node.type, r.node.mentions)]
      if (r.neighbors.length) lines.push(domainText('tools.neighbors', r.neighbors.map((n) => `${n.name}(${n.mentions})`).join(languageText('、', ', '))))
      if (r.edges.length) lines.push(domainText('tools.relationships'), ...r.edges.slice(0, 8).map((e) => `- ${e.from} --${e.type}--> ${e.to}${e.evidence ? `（${e.evidence}）` : ''}`))
      const all = await readObservations()
      const facts = all.filter((o) => r.obsIds.includes(o.id) && o.status === 'active').slice(0, 10)
      if (facts.length) lines.push(domainText('tools.memories'), ...facts.map((f) => `- [${f.id}] ${f.text}`))
      return { text: lines.join('\n'), entity: r.node.name }
    }

    defs.push({
      type: 'function',
      function: {
        name: 'memory_write',
        description: domainText('tools.memoryWriteDescription'),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: domainText('tools.factSentence') },
            kind: { type: 'string', enum: ['user', 'project', 'feedback', 'reference', 'fact'] },
            importance: { type: 'number', description: domainText('tools.importance') },
          },
          required: ['text', 'kind'],
        },
      },
    })
    exec.memory_write = async ({ text, kind, importance }) => {
      const o = await appendObservation({ text, kind, importance, source: `tool:${conversationId}` })
      return { text: o ? domainText('tools.savedMemory', o.id) : domainText('tools.factTooShort') }
    }
  }

  defs.push({
    type: 'function',
    function: {
      name: 'local_time',
      description: domainText('tools.timeDescription'),
      parameters: { type: 'object', properties: {} },
    },
  })
  exec.local_time = async () => {
    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return {
      text: domainText('tools.localTime', now.toLocaleString(languageText('zh-CN', 'en'), { timeZone: tz, hour12: false }), now.toLocaleDateString(languageText('zh-CN', 'en'), { weekday: 'long', timeZone: tz }), tz, Math.floor(now.getTime() / 1000)),
    }
  }

  defs.push({
    type: 'function',
    function: {
      name: 'follow_up_create',
      description: domainText('tools.addFollowUpDescription'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: domainText('tools.followUpTitle') },
          successCriteria: { type: 'string', description: domainText('tools.completionCriterion') },
          deadline: { type: 'string', description: domainText('tools.optionalDue') },
          nextAction: { type: 'string', description: domainText('tools.nextAction') },
          urls: { type: 'array', items: { type: 'string' }, description: domainText('tools.watchedUrls') },
          research: { type: 'boolean', description: domainText('tools.researchPermission') },
          memory: { type: 'boolean', description: domainText('tools.memoryPermission') },
        },
        required: ['title', 'successCriteria'],
      },
    },
  })
  exec.follow_up_create = async ({ title, successCriteria, deadline, nextAction, urls, research, memory }) => {
    const cleanUrls = Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url)).slice(0, 3) : []
    if (research && !cfg.proactive?.research?.enabled) {
      throw new Error(domainText('tools.researchDisabled'))
    }
    const existing = (await listCommitments()).commitments.find((entry) => ['active', 'paused'].includes(entry.status) && entry.title.trim() === String(title ?? '').trim())
    if (existing) return { text: domainText('tools.duplicateItem', existing.id, existing.title, existing.status), commitmentId: existing.id, existed: true }
    const conv = await getConversation(conversationId)
    const lastUser = [...(conv?.messages ?? [])].reverse().find((message) => message.role === 'user')
    let watchType = deadline ? 'deadline' : 'manual'
    if (cleanUrls.length) watchType = deadline ? 'combined' : 'source_change'
    if (research) watchType = 'combined'
    const goal = await createCommitment({
      title,
      successCriteria,
      ...(deadline ? { deadline } : {}),
      ...(nextAction ? { nextAction } : {}),
      ...(lastUser ? { source: { conversationId, messageId: lastUser.id } } : {}),
      scope: { memory: Boolean(memory), urls: cleanUrls, research: Boolean(research) },
      watch: { type: watchType },
    })
    return {
      text: domainText('tools.followUpCreated', goal.id, goal.title, goal.successCriteria, goal.deadline ? domainText('tools.due', goal.deadline) : '', cfg.proactive?.enabled === false ? domainText('tools.proactiveOff') : domainText('tools.proactiveOn')),
      commitmentId: goal.id,
    }
  }

  defs.push({
    type: 'function',
    function: {
      name: 'follow_up_list',
      description: domainText('tools.listFollowUpsDescription'),
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: domainText('tools.requestedItem') },
        cursor: { type: 'string', description: domainText('tools.cursor') },
      }, additionalProperties: false },
    },
  })
  exec.follow_up_list = async ({ id, cursor }) => {
    if (cursor !== undefined && id === undefined) throw new Error(domainText('tools.missingItemForCursor'))
    if (id !== undefined) assertId(id)
    const { commitments, preparations } = await listCommitments()
    const labels = { idle: domainText('tools.notStarted'), queued: domainText('tools.queued'), running: domainText('tools.preparing'), ready: domainText('tools.ready'), failed: domainText('tools.failed') }
    if (id !== undefined) {
      const goal = commitments.find((entry) => entry.id === id)
      if (!goal) throw new Error(domainText('tools.itemMissing'))
      const state = goal.preparation?.state ?? 'idle'
      const summary = domainText('tools.draftHeader', id, goal.title, goal.status, goal.revision, labels[state] ?? state, goal.nextAction ? domainText('tools.nextStep', goal.nextAction) : '')
      const draft = preparations.find((item) => item.id === goal.preparation?.artifactId && item.commitmentId === id && item.revision === goal.revision)
      if (state !== 'ready' || !draft) {
        return { text: domainText('tools.noDraft', summary, goal.preparation?.error ?? '') }
      }
      if (draft.outcome?.signal === 'incorrect' || draft.outcome === 'incorrect') return { text: domainText('tools.rejectedDraft', summary) }
      if (!draft.verification?.passed || draft.delivery?.status === 'superseded' || !canDeliverPreparation(goal, draft, await loadConfig())) {
        return { text: domainText('tools.staleDraft', summary) }
      }
      const references = (draft.evidence ?? []).map((item) => `[${item.id}] ${item.label ?? ''} · ${item.source}${item.page ? domainText('tools.page', item.page) : ''}`)
      const body = [
        domainText('tools.savedAt', draft.title, draft.createdAt), draft.content,
        draft.assumptions?.length && domainText('tools.assumptions', draft.assumptions.join(languageText('；', '; '))),
        draft.question && domainText('tools.openQuestions', draft.question), ...references,
      ].filter(Boolean).join('\n\n')
      let offset = 0
      if (cursor !== undefined) {
        const match = typeof cursor === 'string' && /^([\w-]+):(\d{1,6})$/.exec(cursor)
        if (!match || match[1] !== draft.id || Number(match[2]) >= body.length) throw new Error(domainText('tools.invalidCursor'))
        offset = Number(match[2])
      }
      const end = offset + 6000
      const more = end < body.length ? domainText('tools.nextCursor', draft.id, end) : ''
      return {
        text: `${summary}\n\n${body.slice(offset, end)}${more}`,
        preparation: { commitmentId: goal.id, preparationId: draft.id, title: draft.title },
      }
    }
    const visible = commitments.filter((entry) => entry.status !== 'cancelled').slice(-12)
    if (!visible.length) return { text: domainText('tools.emptyList') }
    const pending = await pendingPreparations({ commitments, preparations })
    return {
      text: visible.map((entry) => {
        const prep = entry.preparation?.state ? labels[entry.preparation.state] ?? entry.preparation.state : domainText('tools.notStarted')
        const draft = pending.some((item) => item.commitmentId === entry.id)
        return domainText('tools.listItem', entry.id, entry.title, entry.status, entry.deadline ?? domainText('tools.noDue'), prep, draft ? domainText('tools.pendingDraft') : '', entry.nextAction ? domainText('tools.listNextStep', entry.nextAction) : '')
      }).join('\n'),
    }
  }

  defs.push({
    type: 'function',
    function: {
      name: 'follow_up_update',
      description: domainText('tools.updateFollowUpDescription'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: domainText('tools.itemIdWithExample') },
          status: { type: 'string', enum: ['active', 'paused', 'cancelled'], description: domainText('tools.status') },
          nextAction: { type: 'string' },
          blocker: { type: 'string' },
          deadline: { type: 'string', description: domainText('tools.dateOrClear') },
          watch: { type: 'string', enum: ['manual', 'deadline', 'source_change', 'combined'], description: domainText('tools.monitoringMode') },
        },
        required: ['id'],
      },
    },
  })
  exec.follow_up_update = async ({ id, status, nextAction, blocker, deadline, watch }) => {
    if (status === 'done') throw new Error(domainText('tools.completeWithEvidence'))
    const patch = {}
    if (status !== undefined) patch.status = status
    if (nextAction !== undefined) patch.nextAction = nextAction
    if (blocker !== undefined) patch.blocker = blocker
    if (deadline !== undefined) patch.deadline = deadline === '' ? null : deadline
    if (watch !== undefined) patch.watch = { type: watch }
    if (!Object.keys(patch).length) throw new Error(domainText('tools.noChanges'))
    const goal = await updateCommitment(String(id ?? ''), patch)
    return { text: domainText('tools.updatedItem', goal.id, goal.title, goal.status, goal.deadline ? domainText('tools.listDue', goal.deadline) : '') }
  }

  defs.push({
    type: 'function',
    function: {
      name: 'follow_up_complete',
      description: domainText('tools.completeDescription'),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: domainText('tools.itemId') },
          quote: { type: 'string', description: domainText('tools.userQuote') },
        },
        required: ['id', 'quote'],
      },
    },
  })
  exec.follow_up_complete = async ({ id, quote }) => {
    const conv = await getConversation(conversationId)
    const lastUser = [...(conv?.messages ?? [])].reverse().find((message) => message.role === 'user')
    const evidence = String(quote ?? '').trim()
    if (!lastUser || !evidence || !String(lastUser.content ?? '').includes(evidence)) {
      throw new Error(domainText('tools.invalidQuote'))
    }
    const goal = await completeCommitmentFromMessage(String(id ?? ''), { conversationId, messageId: lastUser.id, quote: evidence })
    return { text: domainText('tools.completedItem', goal.id, goal.title, evidence) }
  }

  if (cfg.media?.imageOutput !== false && (cfg.upstream.imageModels ?? []).length) {
    const imageModels = (cfg.upstream.imageModels ?? []).map((m) => m.id)
    defs.push({
      type: 'function',
      function: {
        name: 'image_gen',
        description: domainText('tools.imageDescription'),
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: domainText('tools.imagePrompt') },
            model: { type: 'string', enum: imageModels, description: domainText('tools.imageModel', cfg.upstream.defaultImageModel) },
          },
          required: ['prompt'],
        },
      },
    })
    exec.image_gen = async ({ prompt, model }, { signal } = {}) => {
      const r = await generateImage({ prompt, model: model ?? cfg.upstream.defaultImageModel, conversationId, signal })
      const alt = String(prompt).replace(/[[\]()]/g, '').slice(0, 60)
      return {
        text: domainText('tools.imageSaved', r.path, r.model, Math.round(r.bytes / 1024), (r.ms / 1000).toFixed(1)),
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
        description: domainText('tools.readOutputDescription'),
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
  for (const tool of allowLocalTools && !readOnly ? mcp?.tools?.() ?? [] : []) {
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

  if (readOnly) {
    for (const name of Object.keys(exec)) if (!planningTools.has(name)) delete exec[name]
  }
  return {
    defs: readOnly ? defs.filter((tool) => Object.hasOwn(exec, tool.function.name)) : defs,
    sources,
    async call(name, args, { callId } = {}) {
      const fn = Object.hasOwn(exec, name) ? exec[name] : undefined
      if (!fn) {
        const err = new Error(domainText('tools.unknownTool', name))
        err.known = Object.keys(exec)
        throw err
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) || '_raw' in args) throw new Error(domainText('tools.invalidArguments'))
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
  get web_search() { return domainText('tools.search') },
  get web_fetch() { return domainText('tools.readWebPage') },
  get memory_search() { return domainText('tools.searchMemory') },
  get memory_write() { return domainText('tools.saveMemory') },
  get local_time() { return domainText('tools.checkTime') },
  get follow_up_create() { return domainText('tools.addFollowUp') },
  get follow_up_list() { return domainText('tools.readFollowUps') },
  get follow_up_update() { return domainText('tools.updateFollowUp') },
  get follow_up_complete() { return domainText('tools.completeFollowUp') },
  get workspace_list() { return domainText('tools.browseFiles') },
  get workspace_read() { return domainText('tools.readFile') },
  get workspace_search() { return domainText('tools.searchWorkspace') },
  get workspace_write() { return domainText('tools.writeFile') },
  get workspace_edit() { return domainText('tools.editFile') },
  get shell_exec() { return domainText('tools.runCommand') },
  get read_output() { return domainText('tools.readOutput') },
}

export function labelFor(name) {
  if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name]
  if (name.includes('__')) return `MCP · ${name.split('__')[1]}`
  return name
}
