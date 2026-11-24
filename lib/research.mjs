import { runtimeText } from './runtime-language.mjs'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { loadConfig, upstreamCreds } from './config.mjs'
import { readState } from './store.mjs'
import { startRun } from './harness.mjs'
import { streamChat, thinkingOptions } from './upstream.mjs'
import { searchWithFallback, webFetch } from './search.mjs'
import { nativeSearch } from './native.mjs'
import { citesReadResearchSource, getResearchDocument, listResearchFolder, readResearchFile } from './research-sources.mjs'
import { newId, nowIso } from './util.mjs'
import { record } from './metrics.mjs'

const active = new Map()
let draining
const MAX_TOOLS = 6
const MAX_ROUNDS = 4
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
const property = (description) => ({ type: 'string', description })
const tool = (name, description, properties, required) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
})
function researchTools() {
  const pageProperties = {
    page: { type: 'integer', minimum: 1, maximum: 80, description: runtimeText('research.pageNumber') },
    offset: { type: 'integer', minimum: 0, maximum: 120000, description: runtimeText('research.pageOffset') },
  }
  return [
    tool('web_search', runtimeText('research.searchTool'), { query: property(runtimeText('research.searchQuery')) }, ['query']),
    tool('web_fetch', runtimeText('research.fetchTool'), { url: property(runtimeText('research.fetchUrl')) }, ['url']),
    tool('document_read', runtimeText('research.documentTool'), { id: property(runtimeText('research.documentId')), ...pageProperties }, ['id']),
    tool('folder_list', runtimeText('research.folderTool'), { path: property(runtimeText('research.folderPath')) }, ['path']),
    tool('file_read', runtimeText('research.fileTool'), { path: property(runtimeText('research.filePath')), ...pageProperties }, ['path']),
  ]
}


function authority(goal, evidence) {
  try {
    const url = new URL(evidence.source)
    return evidence.fingerprint && evidence.observedAt && ['http:', 'https:'].includes(url.protocol) &&
      (goal.scope?.officialDomains ?? []).includes(url.hostname.toLowerCase()) ? 'official' : 'unverified'
  } catch { return 'unverified' }
}

function validateArguments(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 8000) throw failure(runtimeText('research.invalidArguments'))
  const schema = definition.function.parameters
  if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) throw failure(runtimeText('research.unknownArgument'))
  for (const key of schema.required) if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 2000) throw failure(runtimeText('research.invalidText', key))
  for (const key of ['page', 'offset']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < schema.properties[key].minimum || args[key] > schema.properties[key].maximum)) throw failure(runtimeText('research.invalidArgument', key))
}

function pageSlice(document, args) {
  const page = args.page ?? 1
  const selected = document.pages?.find((item) => item.page === page)
  if (!selected) throw failure(runtimeText('research.pageNotFound'))
  const offset = args.offset ?? 0
  const text = selected.text.slice(offset, offset + 16000)
  if (!text.trim()) throw failure(runtimeText('research.emptyPage'))
  return {
    excerpt: text, page, totalPages: document.totalPages,
    nextOffset: offset + text.length < selected.text.length ? offset + text.length : null,
    truncated: Boolean(document.truncated) || offset + text.length < selected.text.length,
  }
}

async function executeResearch(goal, initialEvidence, parentSignal) {
  const started = Date.now()
  const initialCfg = await loadConfig()
  const workspaceRoot = initialCfg.harness?.workspaceRoot
  const check = async (signal) => {
    signal?.throwIfAborted()
    const cfg = await loadConfig()
    if (cfg.proactive?.research?.enabled !== true || goal.scope?.research !== true) throw failure(runtimeText('research.disabledOrUnauthorized'), 403)
    const current = (await readState()).commitments?.find((item) => item.id === goal.id)
    if (!current || current.status !== 'active' || current.revision !== goal.revision || current.scope?.research !== true) throw failure(runtimeText('research.goalChanged'), 409)
    if (current.discovery && !current.discovery.adopted && Date.parse(current.discovery.expiresAt) <= Date.now()) throw failure(runtimeText('research.leadExpired'), 409)
    if (goal.scope?.folders?.length && (!cfg.harness?.enabled || cfg.harness.workspaceRoot !== workspaceRoot || goal.scope.workspaceRoot && cfg.harness.workspaceRoot !== goal.scope.workspaceRoot)) throw failure(runtimeText('research.folderPermissionChanged'), 403)
    signal?.throwIfAborted()
    return cfg
  }
  await check(parentSignal)
  const run = await startRun({
    conversationId: goal.id, messageId: newId('research'), userMessageId: goal.source?.messageId ?? goal.id,
    workspaceRoot: goal.scope?.folders?.length ? workspaceRoot : null, signal: parentSignal,
  })
  const signal = run.signal
  const evidence = initialEvidence.slice(0, 20).map((item) => ({
    ...item, excerpt: String(item.excerpt ?? '').slice(0, 16000), authority: authority(goal, item),
  }))
  const addEvidence = (prefix, item) => {
    let index = 1
    while (evidence.some((entry) => entry.id === `${prefix}${index}`)) index++
    const row = { ...item, id: `${prefix}${index}`, authority: authority(goal, item) }
    evidence.push(row)
    return row
  }
  const allowed = researchTools().filter((definition) => {
    const name = definition.function.name
    return name.startsWith('web_') && initialCfg.search?.enabled && !(initialCfg.search.order ?? []).includes('none') ||
      name === 'document_read' && goal.scope?.documents?.length || ['folder_list', 'file_read'].includes(name) && goal.scope?.folders?.length
  })
  const definitions = new Map(allowed.map((definition) => [definition.function.name, definition]))
  const tools = {
    async web_search(args, cfg) {
      if (!cfg.search?.enabled || (cfg.search.order ?? []).includes('none')) throw failure(runtimeText('research.searchOff'), 403)
      const result = await searchWithFallback({ query: args.query, cfg, count: 5, nativeSearch, signal })
      const clues = (result.results ?? []).slice(0, 5).map((row) => ({ title: String(row.title ?? '').slice(0, 200), url: row.url, snippet: String(row.snippet ?? '').slice(0, 500) }))
      return { clues, note: runtimeText('research.searchSnippets') }
    },
    async web_fetch(args, cfg) {
      if (!cfg.search?.enabled || (cfg.search.order ?? []).includes('none')) throw failure(runtimeText('research.fetchOff'), 403)
      const page = await webFetch(args.url, { maxChars: 16000, maxBytes: 5 * 1024 * 1024, signal })
      if (page.skipped || !page.content?.trim()) throw failure(page.note || runtimeText('research.emptySource'))
      const row = addEvidence('web', {
        source: page.url, requestedUrl: args.url, label: page.title || page.url, title: page.title || '',
        observedAt: nowIso(), excerpt: page.content, fingerprint: page.contentHash,
        truncated: Boolean(page.truncated), totalPages: page.totalPages,
        pages: page.pages?.map(({ page }) => page), sourceType: 'web',
      })
      return { ...row, links: page.links ?? [] }
    },
    async document_read(args) {
      if (!(goal.scope?.documents ?? []).includes(args.id)) throw failure(runtimeText('research.documentDenied'), 403)
      const document = await getResearchDocument(args.id)
      return addEvidence('document', {
        source: `document:${document.id}`, label: document.name, title: document.name,
        observedAt: nowIso(), fingerprint: document.fingerprint, sourceType: 'document',
        ...pageSlice(document, args),
      })
    },
    async folder_list(args, cfg) {
      return listResearchFolder(goal, args.path, { cfg, signal })
    },
    async file_read(args, cfg) {
      const document = await readResearchFile(goal, args.path, { cfg, signal })
      return addEvidence('file', {
        source: document.source, label: document.name, title: document.name,
        observedAt: document.observedAt, fingerprint: document.fingerprint, sourceType: 'workspace',
        ...pageSlice(document, args),
      })
    },
  }
  const messages = [{
    role: 'user',
    content: JSON.stringify({
      goal: { title: goal.title, successCriteria: goal.successCriteria, nextAction: goal.nextAction, blocker: goal.blocker, deadline: goal.deadline, situation: goal.situation, origin: goal.origin, discovery: goal.discovery },
      scope: { urls: goal.scope.urls, documents: goal.scope.documents, folders: goal.scope.folders, officialDomains: goal.scope.officialDomains }, evidence,
      note: runtimeText('research.requireRead'),
    }),
  }]
  let toolCount = 0
  const usage = { prompt_tokens: 0, completion_tokens: 0 }
  try {
    let json
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const cfg = await check(signal)
      const { apiKey, baseUrl } = upstreamCreds(cfg)
      if (!apiKey || !baseUrl) throw failure(runtimeText('research.missingEndpoint'))
      const canUseTools = allowed.length > 0 && round < MAX_ROUNDS - 1 && toolCount < MAX_TOOLS
      const body = {
        model: cfg.upstream.utilityModel || cfg.upstream.defaultModel,
        messages: [{ role: 'system', content: runtimeText('research.systemPrompt') }, ...messages],
        max_tokens: 2200, temperature: 0.2, ...thinkingOptions(baseUrl),
        ...(canUseTools ? { tools: allowed, tool_choice: 'auto' } : {}),
      }
      if (!canUseTools) body.messages.push({ role: 'system', content: runtimeText('research.budgetInstruction') })
      const stream = streamChat({ body, apiKey, baseUrl, signal })
      let result
      let responseChars = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const next = await stream.next()
          if (next.done) { result = next.value; break }
          responseChars += String(next.value.text ?? '').length
          if (responseChars > 48000) throw failure(runtimeText('research.outputTooLarge'))
        }
      } finally { await stream.return() }
      await check(signal)
      usage.prompt_tokens += Number(result?.usage?.prompt_tokens) || 0
      usage.completion_tokens += Number(result?.usage?.completion_tokens) || 0
      const calls = result?.toolCalls ?? []
      if (!calls.length) {
        const content = String(result?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        try { json = JSON.parse(content) } catch { throw failure(runtimeText('research.invalidJson')) }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw failure(runtimeText('research.invalidResult'))
        break
      }
      if (!canUseTools || calls.length > 24) throw failure(runtimeText('research.noResult'))
      messages.push({ role: 'assistant', content: result.content || null, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) })
      for (const call of calls) {
        await check(signal)
        let output
        if (toolCount >= MAX_TOOLS) output = { error: runtimeText('research.toolBudgetExhausted') }
        else {
          toolCount++
          try {
            const result = await run.call({
              name: call.name, args: call.args, callId: call.id,
              execute: async (args) => {
                const cfg = await check(signal)
                const definition = definitions.get(call.name)
                if (!definition || !Object.hasOwn(tools, call.name)) throw failure(runtimeText('research.toolDenied'), 403)
                validateArguments(definition, args)
                const value = await tools[call.name](args, cfg)
                await check(signal)
                return { text: JSON.stringify(value) }
              },
            })
            output = JSON.parse(result.text)
          } catch (error) {
            signal.throwIfAborted()
            await check(signal)
            output = { error: String(error.message).slice(0, 500) }
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
      }
    }
    if (!json) throw failure(runtimeText('research.unfinished'))
    if (json.deadlineClaims === undefined) json.deadlineClaims = []
    if (!Array.isArray(json.deadlineClaims) || json.deadlineClaims.length > 8) throw failure(runtimeText('research.invalidDeadlineClaims'))
    if (!Array.isArray(json.evidenceIds) || json.evidenceIds.some((id) => !evidence.some((item) => item.id === id))) throw failure(runtimeText('research.unknownEvidence'))
    const declared = evidence.filter((item) => json.evidenceIds.includes(item.id))
    if (!citesReadResearchSource(json.content, declared)) {
      const goalEvidence = evidence.find((item) => item.source === `commitment:${goal.id}`)
      if (!goalEvidence || typeof json.question !== 'string' || !json.question.trim() || json.question.length > 600) {
        throw failure(runtimeText('research.missingCitation'))
      }
      // Only the question survives when the model has supplied no cited research source.
      json = { title: runtimeText('research.moreInfoNeeded'), content: runtimeText('research.noEvidence', goalEvidence.id),
        evidenceIds: [goalEvidence.id], assumptions: [], question: json.question.trim(), deadlineClaims: [], resultKind: 'clarification' }
    } else json.resultKind = 'findings'
    await check(signal)
    await run.call({
      name: 'research_result', args: { commitmentId: goal.id, revision: goal.revision },
      execute: async (_, { outputDir }) => {
        await check(signal)
        const file = path.join(outputDir, 'research.json')
        await fs.writeFile(file, JSON.stringify({ json, evidence }, null, 2), { signal, mode: 0o600 })
        await check(signal)
        return { text: JSON.stringify({ title: json.title, evidenceIds: json.evidenceIds, resultKind: json.resultKind, toolCount }), artifacts: [{ file }] }
      },
    })
    await run.finish('completed', { commitmentId: goal.id, toolCount })
    record({ kind: 'proactive_research', commitmentId: goal.id, runId: run.id, ms: Date.now() - started, ok: true, tools: toolCount, usage })
    return { json, evidence, runId: run.id }
  } catch (error) {
    await run.finish(signal.aborted ? 'cancelled' : 'failed', { error: error.message, commitmentId: goal.id })
    record({ kind: 'proactive_research', commitmentId: goal.id, runId: run.id, ms: Date.now() - started, ok: false, tools: toolCount, usage })
    error.runId = run.id
    throw error
  }
}

export function researchCommitment(goal, { evidence = [], signal } = {}) {
  if (draining) return Promise.reject(failure(runtimeText('research.stopping'), 409))
  if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !Number.isInteger(goal.revision) ||
    !Array.isArray(evidence) || evidence.length > 20 ||
    evidence.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
      ['id', 'source', 'excerpt'].some((key) => typeof item[key] !== 'string') || !item.id || !item.source) ||
    new Set(evidence.map((item) => item.id)).size !== evidence.length ||
    JSON.stringify(evidence).length > 400000) return Promise.reject(failure(runtimeText('research.invalidInput')))
  const controller = new AbortController()
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(90000), ...(signal ? [signal] : [])])
  const work = executeResearch(structuredClone(goal), structuredClone(evidence), combined)
  active.set(work, controller)
  work.finally(() => active.delete(work)).catch(() => {})
  return work
}

export function cancelAndDrainResearch(reason = runtimeText('research.stopped')) {
  if (draining) return draining
  for (const controller of active.values()) controller.abort(new DOMException(reason, 'AbortError'))
  draining = Promise.allSettled([...active.keys()]).finally(() => { draining = null })
  return draining
}
