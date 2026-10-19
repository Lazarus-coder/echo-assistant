import path from 'node:path'
import { promises as fs } from 'node:fs'
import { P, ROOT } from './config.mjs'
import { readJSON, writeJSON, newId, nowIso, assertId } from './util.mjs'

export const MAIN_ID = 'main'

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

export async function saveConversation(conv) {
  conv.updatedAt = nowIso()
  await writeJSON(P.conv(conv.id), conv)
  return conv
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
  await fs.rm(P.conv(assertId(id)), { force: true })
  return true
}

export async function appendMessage(id, message) {
  const conv = await getConversation(id)
  if (!conv) return null
  conv.messages.push(message)
  return saveConversation(conv)
}

export async function patchConversation(id, patch) {
  const conv = await getConversation(id)
  if (!conv) return null
  for (const key of ['title', 'pinned', 'model', 'system', 'unread', 'searchMode', 'digest']) {
    if (patch[key] !== undefined) conv[key] = patch[key]
  }
  return saveConversation(conv)
}

/** Drop a message and everything after it (used by "edit and resend"). */
export async function truncateFrom(id, messageId) {
  const conv = await getConversation(id)
  if (!conv) return null
  const idx = conv.messages.findIndex((m) => m.id === messageId)
  if (idx >= 0) conv.messages = conv.messages.slice(0, idx)
  return saveConversation(conv)
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

export async function writeState(next) {
  await writeJSON(P.state, next)
  return next
}

export async function mutateState(fn) {
  const state = await readState()
  const next = fn(state) ?? state
  return writeState(next)
}

export function safeExportPath(id) {
  return path.join(ROOT, 'data', 'exports', `${assertId(id)}.md`)
}
