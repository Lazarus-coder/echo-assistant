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
      title: conv.title ?? '新对话',
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

export async function getConversation(id) {
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

export async function createConversation({ title = '新对话', model, system, isMain = false } = {}) {
  const id = isMain ? MAIN_ID : newId('c')
  const existing = await getConversation(id)
  if (existing) return existing
  const conv = {
    id,
    title,
    pinned: isMain,
    isMain,
    model: model ?? null,
    system: system ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    unread: 0,
    messages: [],
  }
  return saveConversation(conv)
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
  return mutateConversation(id, (conv) => {
    for (const key of ['title', 'pinned', 'model', 'system', 'unread', 'searchMode', 'digest']) {
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
  const lines = [`# ${conv.title ?? '对话'}`, '', `- 时间：${conv.createdAt}`, `- 消息数：${conv.messages?.length ?? 0}`, '']
  for (const m of conv.messages ?? []) {
    lines.push(`### ${m.role === 'user' ? '我' : m.role === 'assistant' ? 'Echo' : m.role}`)
    if (m.proactive) lines.push('> 来自主动服务')
    lines.push('', String(m.content ?? '').trim(), '')
    for (const t of m.tools ?? []) {
      lines.push(`<sub>工具 ${t.name}(${JSON.stringify(t.args ?? {})}) → ${String(t.result ?? '').replace(/\s+/g, ' ').slice(0, 200)}</sub>`, '')
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
