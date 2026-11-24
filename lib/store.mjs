import { languageText } from './language.mjs'
import { runtimeText } from './runtime-language.mjs'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { P, ROOT } from './config.mjs'
import { readJSON, writeJSON, newId, nowIso, assertId } from './util.mjs'

export const MAIN_ID = 'main'
const conversationWrites = new Map()
let stateWrites = Promise.resolve()

function queueConversation(id, operation) {
  const result = (conversationWrites.get(id) ?? Promise.resolve()).then(operation)
  const pending = result.catch(() => {})
  conversationWrites.set(id, pending)
  pending.finally(() => {
    if (conversationWrites.get(id) === pending) conversationWrites.delete(id)
  })
  return result
}

const stockTitles = { main: ['主对话', 'Main conversation'], other: ['新对话', 'New conversation'] }

export function hasDefaultTitle(conv) {
  const names = conv.id === MAIN_ID ? stockTitles.main : stockTitles.other
  return conv.defaultTitle ?? (!conv.title || names.includes(conv.title))
}

export function conversationTitle(conv) {
  if (!hasDefaultTitle(conv)) return conv.title
  return languageText(...(conv.id === MAIN_ID ? stockTitles.main : stockTitles.other))
}

async function listConversationFiles() {
  await fs.mkdir(P.convDir, { recursive: true })
  const names = await fs.readdir(P.convDir)
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
}

export async function listConversations() {
  const ids = await listConversationFiles()
  const metas = []
  for (const id of ids) {
    const conv = await readJSON(P.conv(id), null)
    if (!conv) continue
    const last = conv.messages?.at(-1)
    metas.push({
      id: conv.id,
      title: conversationTitle(conv),
      pinned: Boolean(conv.pinned),
      isMain: conv.id === MAIN_ID,
      model: conv.model,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt ?? conv.createdAt,
      messageCount: conv.messages?.length ?? 0,
      unread: conv.unread ?? 0,
      preview: last ? String(last.content ?? '').replace(/\s+/g, ' ').slice(0, 60) : '',
    })
  }
  metas.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })
  return metas
}

export async function getConversation(id, { afterWrites = false } = {}) {
  if (afterWrites) await conversationWrites.get(id)
  return readJSON(P.conv(assertId(id)), null)
}

async function persistConversation(conv) {
  if (conv.digest) {
    const ids = new Set(conv.messages.map((m) => m.id))
    if (conv.digest.uptoIndex > conv.messages.length || (conv.digest.covers ?? []).some((id) => !ids.has(id))) conv.digest = null
  }
  conv.updatedAt = nowIso()
  await writeJSON(P.conv(conv.id), conv)
  return conv
}

export function saveConversation(conv) {
  return queueConversation(conv.id, () => persistConversation(conv))
}

export function mutateConversation(id, fn) {
  assertId(id)
  return queueConversation(id, async () => {
    const conv = await getConversation(id)
    if (!conv) return null
    const next = (await fn(conv)) ?? conv
    return persistConversation(next)
  })
}

export async function createConversation({ title, model, system, isMain = false, id: requestedId } = {}) {
  const id = isMain ? MAIN_ID : requestedId ?? newId('c')
  const saved = await getConversation(id)
  if (saved) return saved
  return queueConversation(id, async () => {
    const existing = await getConversation(id)
    return existing ?? persistConversation({
      id, title: title ?? conversationTitle({ id }), defaultTitle: title == null, pinned: isMain, isMain, model: model ?? null, system: system ?? null,
      createdAt: nowIso(), unread: 0, messages: [],
    })
  })
}

export async function deleteConversation(id) {
  if (id === MAIN_ID) return false
  await queueConversation(id, () => fs.rm(P.conv(assertId(id)), { force: true }))
  return true
}

export async function appendMessage(id, message) {
  return mutateConversation(id, (conv) => {
    if (!conv.messages.some((m) => m.id === message.id)) conv.messages.push(message)
  })
}

export async function patchConversation(id, patch) {
  if ('workspaceMode' in patch && !['read_only', 'work'].includes(patch.workspaceMode)) {
    throw Object.assign(new Error(runtimeText('store.invalidWorkspaceMode')), { status: 400 })
  }
  return mutateConversation(id, (conv) => {
    if (patch.title !== undefined) conv.defaultTitle = false
    if (patch.model !== undefined) conv.modelSelectedAt = nowIso()
    for (const key of ['title', 'pinned', 'model', 'system', 'unread', 'searchMode', 'digest', 'workspaceMode']) {
      if (patch[key] !== undefined) conv[key] = patch[key]
    }
  })
}

/** Drop a message and everything after it (used by "edit and resend"). */
export async function truncateFrom(id, messageId) {
  return mutateConversation(id, (conv) => {
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx >= 0) conv.messages = conv.messages.slice(0, idx)
  })
}

export function exportMarkdown(conv) {
  const lines = [`# ${conversationTitle(conv)}`, '', runtimeText('store.createdAt', conv.createdAt), runtimeText('store.messageCount', conv.messages?.length ?? 0), '']
  for (const m of conv.messages ?? []) {
    lines.push(`### ${m.role === 'user' ? runtimeText('store.me') : m.role === 'assistant' ? 'Echo' : m.role}`)
    if (m.proactive) lines.push(runtimeText('store.proactiveSource'))
    lines.push('', String(m.content ?? '').trim(), '')
    for (const t of m.tools ?? []) {
      lines.push(runtimeText('store.toolTrace', t.name, JSON.stringify(t.args ?? {}), String(t.result ?? '').replace(/\s+/g, ' ').slice(0, 200)), '')
    }
  }
  return lines.join('\n')
}

export async function readState() {
  return readJSON(P.state, { proactive: {}, dream: {}, memory: {}, counters: {} })
}

export function writeState(next) {
  const result = stateWrites.then(async () => {
    await writeJSON(P.state, next)
    return next
  })
  stateWrites = result.catch(() => {})
  return result
}

export function mutateState(fn) {
  const result = stateWrites.then(async () => {
    const state = await readState()
    const next = (await fn(state)) ?? state
    await writeJSON(P.state, next)
    return next
  })
  stateWrites = result.catch(() => {})
  return result
}

export function safeExportPath(id) {
  return path.join(ROOT, 'data', 'exports', `${assertId(id)}.md`)
}
