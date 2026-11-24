import { runtimeText } from './runtime-language.mjs'
import path from 'node:path'
import { constants, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { DATA } from './config.mjs'
import { newId, nowIso, writeJSON } from './util.mjs'
import { extractPdf } from './pdf.mjs'
import { executeWorkspaceTool, readWorkspaceBuffer } from './workspace.mjs'

const DOCUMENTS = path.join(DATA, 'research', 'documents')
const MAX_BYTES = 5 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.eml'])
const supported = (name) => path.extname(name).toLowerCase() === '.pdf' || TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
const uploads = new Map()
let generation = 0
let clearing
let uploadChain = Promise.resolve()
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const documentId = (id) => {
  if (typeof id !== 'string' || !/^document_[a-zA-Z0-9_-]{6,70}$/.test(id)) throw failure(runtimeText('researchSources.invalidId'))
  return id
}
const metadata = ({ id, name, createdAt, bytes, fingerprint, totalPages, truncated }) => ({ id, name, createdAt, bytes, fingerprint, totalPages, truncated })

export function citesReadResearchSource(content, evidence) {
  return typeof content === 'string' && evidence.some((item) =>
    item && !item.error && item.fingerprint && item.observedAt && typeof item.excerpt === 'string' && item.excerpt.trim() &&
    /^(?:https?:\/\/|document:|workspace:)/.test(item.source) && content.includes(`[${item.id}]`))
}

async function extract(name, bytes, signal) {
  signal?.throwIfAborted()
  if (!supported(name)) throw failure(runtimeText('researchSources.unsupportedFormat'))
  if (!bytes.length || bytes.length > MAX_BYTES) throw failure(runtimeText('researchSources.tooLarge'))
  if (path.extname(name).toLowerCase() === '.pdf') return extractPdf(bytes, { signal })
  if (bytes.includes(0)) throw failure(runtimeText('researchSources.binaryText'))
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw failure(runtimeText('researchSources.invalidEncoding')) }
  if (!text.trim()) throw failure(runtimeText('researchSources.emptyDocument'))
  return { text: text.slice(0, 120000), pages: [{ page: 1, text: text.slice(0, 120000) }], totalPages: 1, truncated: text.length > 120000 }
}

export async function getResearchDocument(id) {
  const handle = await fs.open(path.join(DOCUMENTS, `${documentId(id)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (error.code === 'ENOENT') throw failure(runtimeText('researchSources.documentMissing'), 404)
    throw error
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw failure(runtimeText('researchSources.invalidRecord'))
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}

export async function listResearchDocuments() {
  const names = await fs.readdir(DOCUMENTS).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  const rows = []
  for (const name of names.slice(0, 100)) {
    if (!/^document_[a-zA-Z0-9_-]+\.json$/.test(name)) continue
    try { rows.push(metadata(await getResearchDocument(name.slice(0, -5)))) } catch {}
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function saveResearchDocument({ name, data } = {}) {
  if (clearing) return Promise.reject(failure(runtimeText('researchSources.clearing'), 409))
  const controller = new AbortController()
  const version = generation
  const operation = (async () => {
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || path.basename(name) !== name || /[\0\r\n\\]/.test(name)) throw failure(runtimeText('researchSources.invalidName'))
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 + 128) throw failure(runtimeText('researchSources.tooLarge'))
    const base64 = data.replace(/^data:[\w.+/-]+;base64,/, '')
    if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw failure(runtimeText('researchSources.invalidBase64'))
    const bytes = Buffer.from(base64, 'base64')
    const parsed = await extract(name, bytes, controller.signal)
    const row = { id: newId('document'), name, createdAt: nowIso(), bytes: bytes.length, fingerprint: digest(bytes), ...parsed }
    const write = uploadChain.then(async () => {
      controller.signal.throwIfAborted()
      if (version !== generation) throw new DOMException(runtimeText('researchSources.uploadCancelled'), 'AbortError')
      if ((await listResearchDocuments()).length >= 50) throw failure(runtimeText('researchSources.documentLimit'))
      await writeJSON(path.join(DOCUMENTS, `${row.id}.json`), row)
      controller.signal.throwIfAborted()
      if (version !== generation) throw new DOMException(runtimeText('researchSources.uploadCancelled'), 'AbortError')
      return metadata(row)
    })
    uploadChain = write.catch(() => {})
    return write
  })()
  uploads.set(operation, controller)
  operation.finally(() => uploads.delete(operation)).catch(() => {})
  return operation
}

/** Privacy wipe waits for parsers and in-flight writes before deleting their output. */
export function clearResearchDocuments() {
  if (clearing) return clearing
  generation++
  for (const controller of uploads.values()) controller.abort(new DOMException(runtimeText('researchSources.cleared'), 'AbortError'))
  clearing = (async () => {
    await Promise.allSettled([...uploads.keys()])
    await fs.rm(path.join(DATA, 'research'), { recursive: true, force: true })
  })().finally(() => { clearing = null })
  return clearing
}

function scopedPath(goal, requested) {
  if (typeof requested !== 'string' || !requested || requested.length > 2048 || path.isAbsolute(requested) || requested.includes('\\') || requested.includes('\0') || requested.split('/').includes('..')) throw failure(runtimeText('researchSources.relativePath'))
  const normalized = path.posix.normalize(requested)
  if (normalized.split('/').some((part) => part.startsWith('.') && part !== '.')) throw failure(runtimeText('researchSources.hiddenFile'), 403)
  const folders = goal.scope?.folders ?? []
  if (!folders.some((folder) => folder === '.' || normalized === folder || normalized.startsWith(`${folder}/`))) throw failure(runtimeText('researchSources.outsideFolder'), 403)
  return normalized
}

export async function listResearchFolder(goal, requested, { cfg, signal } = {}) {
  if (!cfg.harness?.enabled) throw failure(runtimeText('researchSources.readingOff'), 403)
  if (goal.scope?.workspaceRoot && cfg.harness.workspaceRoot !== goal.scope.workspaceRoot) throw failure(runtimeText('research.folderPermissionChanged'), 403)
  const relative = scopedPath(goal, requested)
  const result = await executeWorkspaceTool('workspace_list', { path: relative, limit: 100 }, { workspaceRoot: cfg.harness.workspaceRoot, signal })
  const listing = JSON.parse(result.text)
  listing.entries = listing.entries.filter((entry) => !entry.name.startsWith('.') && (entry.type === 'directory' || entry.type === 'file' && supported(entry.name)))
  return listing
}

export async function readResearchFile(goal, requested, { cfg, signal } = {}) {
  if (!cfg.harness?.enabled) throw failure(runtimeText('researchSources.readingOff'), 403)
  if (goal.scope?.workspaceRoot && cfg.harness.workspaceRoot !== goal.scope.workspaceRoot) throw failure(runtimeText('research.folderPermissionChanged'), 403)
  const relative = scopedPath(goal, requested)
  if (!supported(relative)) throw failure(runtimeText('researchSources.unsupportedFile'))
  const bytes = await readWorkspaceBuffer(relative, { workspaceRoot: cfg.harness.workspaceRoot, signal })
  const parsed = await extract(relative, bytes, signal)
  return { name: relative, source: `workspace:${relative}`, observedAt: nowIso(), fingerprint: digest(bytes), ...parsed }
}
