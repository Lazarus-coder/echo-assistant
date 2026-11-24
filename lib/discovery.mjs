import { runtimeText } from './runtime-language.mjs'
import crypto from 'node:crypto'
import { loadConfig, upstreamCreds } from './config.mjs'
import { getConversation, listConversations, readState, mutateState } from './store.mjs'
import { discoverCommitment, completeCommitmentFromMessage, updateCommitment } from './commitments.mjs'
import { jsonTask } from './native.mjs'
import { nowIso } from './util.mjs'
import { record } from './metrics.mjs'

const DAY = 86400000
const MAX_CALLS = 20
let worker, controller


function ensure(state) {
  state.proactiveDiscovery ??= {}
  const d = state.proactiveDiscovery
  d.seen ??= {}
  d.runs ??= []
  d.stats ??= { scanned: 0, discovered: 0, completed: 0, deferred: 0, failed: 0 }
  return d
}

function messageKey(conversationId, message) {
  return `${conversationId}/${message.id}/${crypto.createHash('sha256').update(String(message.content ?? '')).digest('hex').slice(0, 16)}`
}

function policy(cfg) {
  return cfg.proactive?.research?.enabled === true && cfg.proactive.research.discoverChats !== false
}

export function validateResearchSettings(value, previous = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(runtimeText('discovery.invalidSettings')), { status: 400 })
  if (Object.keys(value).some((key) => !['enabled', 'discoverChats'].includes(key))) throw Object.assign(new Error(runtimeText('discovery.unknownSetting')), { status: 400 })
  for (const key of ['enabled', 'discoverChats']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Object.assign(new Error(runtimeText('discovery.invalidBoolean', key)), { status: 400 })
  }
  return {
    ...value,
    ...((value.enabled === true && previous.enabled !== true ||
      value.discoverChats === true && previous.discoverChats === false && (value.enabled ?? previous.enabled) === true) ? { enabledAt: nowIso() } : {}),
  }
}

async function current(epoch, signal) {
  signal.throwIfAborted()
  const cfg = await loadConfig()
  if (!policy(cfg) || cfg.proactive.research.enabledAt !== epoch) throw Object.assign(new Error(runtimeText('discovery.permissionsChanged')), { name: 'AbortError' })
}

// Only a verbatim span from an actual new user message can authorize a state update.
function witness(item, messages) {
  if (!item || typeof item !== 'object' || typeof item.quote !== 'string' || item.quote.trim().length < 4 || item.quote.length > 2400) return null
  const message = messages.find((m) => m.id === item.messageId)
  return message?.content.includes(item.quote) ? message : null
}

async function scan(signal) {
  const cfg = await loadConfig()
  if (!policy(cfg)) return { skipped: 'disabled' }
  if (!upstreamCreds(cfg).configured) return { skipped: 'unconfigured' }
  const epoch = cfg.proactive.research.enabledAt
  if (!Number.isFinite(Date.parse(epoch))) return { skipped: 'activation_required' }
  const since = Math.max(Date.parse(epoch), Date.now() - 7 * DAY)
  const state = await readState()
  const d = ensure(state)
  if (Date.parse(d.nextRetryAt) > Date.now()) return { skipped: 'retry_wait' }
  const runs = d.runs.filter((at) => Date.parse(at) > Date.now() - DAY)
  if (runs.length >= MAX_CALLS) return { skipped: 'discovery_budget' }
  const metas = (await listConversations()).filter((c) => Date.parse(c.updatedAt) >= since).slice(0, 40)
  let selected
  for (const meta of metas) {
    await current(epoch, signal)
    const conv = await getConversation(meta.id)
    const messages = (conv?.messages ?? []).filter((m) =>
      m.role === 'user' && typeof m.content === 'string' && m.content.trim().length >= 4 &&
      Date.parse(m.createdAt) >= since && !d.seen[messageKey(meta.id, m)]).slice(0, 8)
    if (messages.length) { selected = { conv, messages }; break }
  }
  await mutateState((s) => { ensure(s).lastScanAt = nowIso() })
  if (!selected) return { skipped: 'no_new_messages' }
  const { conv, messages } = selected
  // Keep a whole, bounded message. Cutting a completion sentence can change its meaning.
  const batch = messages.filter((m) => m.content.length <= 12000).slice(0, 4)
  const existing = (state.commitments ?? []).filter((g) => g.status === 'active').slice(0, 30)
    .map((g) => ({
      id: g.id, revision: g.revision, status: g.status, title: g.title, successCriteria: g.successCriteria,
      situation: g.situation, source: g.source ? { conversationId: g.source.conversationId, messageId: g.source.messageId } : null,
    }))
  const context = (conv.messages ?? []).filter((m) => m.role === 'user' && Date.parse(m.createdAt) >= since && !messages.some((n) => n.id === m.id)).slice(-3)
    .map((m) => ({ id: m.id, content: String(m.content).slice(0, 1200) }))
  await mutateState((s) => {
    const latest = ensure(s)
    latest.runs = [...latest.runs.filter((at) => Date.parse(at) > Date.now() - DAY), nowIso()]
  })
  const startedAt = Date.now()
  try {
    const out = batch.length ? await jsonTask({
      system: runtimeText('discovery.systemPrompt'),
      user: JSON.stringify({ current: batch.map((m) => ({ id: m.id, content: m.content })), context, existing }),
      model: cfg.upstream.utilityModel || cfg.upstream.defaultModel,
      maxTokens: 1800, temperature: 0.1, timeoutMs: 35000, signal,
    }) : { json: { discover: [], updates: [], complete: [] } }
    if (!out.json || ['discover', 'updates', 'complete'].some((key) => !Array.isArray(out.json[key]))) throw new Error(runtimeText('discovery.invalidResult'))
    await current(epoch, signal)
    // Editing or deleting a chat while the model runs invalidates its evidence.
    const fresh = await getConversation(conv.id)
    const valid = batch.filter((m) => fresh?.messages.some((n) => n.id === m.id && n.role === 'user' && n.content === m.content))
    let discovered = 0, completed = 0
    const retryMessages = new Set()
    for (const item of out.json.complete.slice(0, 4)) {
      const message = witness(item, valid)
      const goal = existing.find((g) => g.id === item.id)
      if (!message || !goal || goal.status !== 'active') continue
      await current(epoch, signal)
      try {
        const updated = await completeCommitmentFromMessage(goal.id, { conversationId: conv.id, messageId: message.id, quote: item.quote, expectedRevision: goal.revision })
        Object.assign(goal, { revision: updated.revision, status: updated.status })
        completed++
        record({ kind: 'commitment_completed', commitmentId: goal.id, source: 'chat' })
      } catch (error) {
        if (error.status === 409) retryMessages.add(message.id)
        else if (![400, 404].includes(error.status)) throw error
      }
    }
    for (const item of out.json.updates.slice(0, 3)) {
      const message = witness(item, valid)
      const goal = existing.find((g) => g.id === item.id)
      if (!message || !goal || goal.status !== 'active' || !item.situation || typeof item.situation !== 'object') continue
      const fields = Object.fromEntries(['institution', 'program', 'cycle', 'category', 'stage']
        .filter((key) => typeof item.situation[key] === 'string' && item.situation[key].trim() && item.quote.includes(item.situation[key]))
        .map((key) => [key, item.situation[key]]))
      if (!Object.keys(fields).length) continue
      await current(epoch, signal)
      try {
        const updated = await updateCommitment(goal.id, { situation: { ...goal.situation, ...fields }, source: { conversationId: conv.id, messageId: message.id }, expectedRevision: goal.revision })
        Object.assign(goal, { revision: updated.revision, status: updated.status, situation: updated.situation })
      } catch (error) {
        if (error.status === 409) retryMessages.add(message.id)
        else if (![400, 404].includes(error.status)) throw error
      }
    }
    for (const item of out.json.discover.slice(0, 1)) {
      const message = witness(item, valid)
      if (!message || !Number.isFinite(item.confidence) || item.confidence < 0.85 || item.confidence > 1) continue
      await current(epoch, signal)
      try {
        const before = (await readState()).commitments ?? []
        const goal = await discoverCommitment(item, { source: { conversationId: conv.id, messageId: message.id }, confidence: item.confidence, quote: item.quote })
        if (goal && !before.some((g) => g.id === goal.id)) discovered++
      } catch (error) { if (![400, 404, 409].includes(error.status)) throw error }
    }
    await current(epoch, signal)
    await mutateState((s) => {
      const latest = ensure(s)
      for (const message of [...batch, ...messages.filter((m) => m.content.length > 12000)]) {
        if (!retryMessages.has(message.id)) latest.seen[messageKey(conv.id, message)] = nowIso()
      }
      latest.seen = Object.fromEntries(Object.entries(latest.seen).filter(([, at]) => Date.parse(at) > Date.now() - 30 * DAY).slice(-2000))
      latest.lastSuccessAt = nowIso()
      latest.lastError = null
      latest.nextRetryAt = null
      latest.failureCount = 0
      latest.stats.scanned += batch.length
      latest.stats.discovered += discovered
      latest.stats.completed += completed
      latest.stats.deferred += messages.filter((m) => m.content.length > 12000).length
    })
    record({ kind: 'proactive_discovery', scanned: batch.length, discovered, completed, ms: Date.now() - startedAt, usage: out.usage ?? null })
    return { scanned: batch.length, discovered, completed }
  } catch (error) {
    if (signal.aborted || error.name === 'AbortError') return { skipped: 'cancelled' }
    await mutateState((s) => {
      const latest = ensure(s)
      latest.failureCount = (latest.failureCount ?? 0) + 1
      latest.lastError = String(error.message).slice(0, 300)
      latest.nextRetryAt = new Date(Date.now() + Math.min(60, 2 ** latest.failureCount) * 60000).toISOString()
      latest.stats.failed++
    })
    record({ kind: 'proactive_discovery', failed: true, ms: Date.now() - startedAt })
    return { failed: true }
  }
}

export function discoverNeeds() {
  if (!worker) {
    controller = new AbortController()
    worker = scan(controller.signal).finally(() => { worker = null; controller = null })
  }
  return worker
}

export async function cancelDiscovery(reason = runtimeText('research.stopped')) {
  controller?.abort(new Error(reason))
  await worker?.catch(() => {})
}

export async function researchStatus() {
  const cfg = await loadConfig()
  const d = ensure(await readState())
  const runs = d.runs.filter((at) => Date.parse(at) > Date.now() - DAY).sort()
  const state = !cfg.proactive?.research?.enabled ? 'disabled' : !upstreamCreds(cfg).configured ? 'unconfigured' :
    runs.length >= MAX_CALLS ? 'budget_wait' : Date.parse(d.nextRetryAt) > Date.now() ? 'retry_wait' : 'idle'
  return {
    enabled: cfg.proactive?.research?.enabled === true,
    discoverChats: cfg.proactive?.research?.discoverChats !== false,
    enabledAt: cfg.proactive?.research?.enabledAt ?? null,
    lastScanAt: d.lastScanAt ?? null, lastSuccessAt: d.lastSuccessAt ?? null,
    lastError: d.lastError ?? null, nextRetryAt: d.nextRetryAt ?? null,
    state, budget: { used: runs.length, limit: MAX_CALLS, resetsAt: runs.length ? new Date(Date.parse(runs[0]) + DAY).toISOString() : null },
    coverage: { mode: 'new_chats', since: cfg.proactive?.research?.enabledAt ?? null, localOnly: true, note: runtimeText('discovery.wakeNotice') },
    stats: d.stats,
  }
}
