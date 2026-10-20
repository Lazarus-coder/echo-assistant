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
  if (typeof id !== 'string' || !/^document_[a-zA-Z0-9_-]{6,70}$/.test(id)) throw failure('文档 ID 无效')
  return id
}
const metadata = ({ id, name, createdAt, bytes, fingerprint, totalPages, truncated }) => ({ id, name, createdAt, bytes, fingerprint, totalPages, truncated })

async function extract(name, bytes, signal) {
  signal?.throwIfAborted()
  if (!supported(name)) throw failure('只支持 PDF、TXT、Markdown、CSV、JSON 或 EML 文档')
  if (!bytes.length || bytes.length > MAX_BYTES) throw failure('文档须小于 5 MiB')
  if (path.extname(name).toLowerCase() === '.pdf') return extractPdf(bytes, { signal })
  if (bytes.includes(0)) throw failure('文本文档不能包含二进制内容')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw failure('文本文档须使用 UTF-8 编码') }
  if (!text.trim()) throw failure('文档没有可读取的文字')
  return { text: text.slice(0, 120000), pages: [{ page: 1, text: text.slice(0, 120000) }], totalPages: 1, truncated: text.length > 120000 }
}

export async function getResearchDocument(id) {
  const handle = await fs.open(path.join(DOCUMENTS, `${documentId(id)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (error.code === 'ENOENT') throw failure('文档不存在', 404)
    throw error
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw failure('文档记录无效')
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
  if (clearing) return Promise.reject(failure('正在清空文档，请稍后重试', 409))
  const controller = new AbortController()
  const version = generation
  const operation = (async () => {
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || path.basename(name) !== name || /[\0\r\n\\]/.test(name)) throw failure('文档名称无效')
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 + 128) throw failure('文档须小于 5 MiB')
    const base64 = data.replace(/^data:[\w.+/-]+;base64,/, '')
    if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw failure('文档须为有效的 base64 数据')
    const bytes = Buffer.from(base64, 'base64')
    const parsed = await extract(name, bytes, controller.signal)
    const row = { id: newId('document'), name, createdAt: nowIso(), bytes: bytes.length, fingerprint: digest(bytes), ...parsed }
    const write = uploadChain.then(async () => {
      controller.signal.throwIfAborted()
      if (version !== generation) throw new DOMException('文档上传已取消', 'AbortError')
      if ((await listResearchDocuments()).length >= 50) throw failure('最多保留 50 个共享文档')
      await writeJSON(path.join(DOCUMENTS, `${row.id}.json`), row)
      controller.signal.throwIfAborted()
      if (version !== generation) throw new DOMException('文档上传已取消', 'AbortError')
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
  for (const controller of uploads.values()) controller.abort(new DOMException('共享文档已清空', 'AbortError'))
  clearing = (async () => {
    await Promise.allSettled([...uploads.keys()])
    await fs.rm(path.join(DATA, 'research'), { recursive: true, force: true })
  })().finally(() => { clearing = null })
  return clearing
}

function scopedPath(goal, requested) {
  if (typeof requested !== 'string' || !requested || requested.length > 2048 || path.isAbsolute(requested) || requested.includes('\\') || requested.includes('\0') || requested.split('/').includes('..')) throw failure('文件路径须相对于已选择的工作区')
  const normalized = path.posix.normalize(requested)
  if (normalized.split('/').some((part) => part.startsWith('.') && part !== '.')) throw failure('后台研究不读取隐藏文件', 403)
  const folders = goal.scope?.folders ?? []
  if (!folders.some((folder) => folder === '.' || normalized === folder || normalized.startsWith(`${folder}/`))) throw failure('文件不在此目标允许的文件夹内', 403)
  return normalized
}

export async function listResearchFolder(goal, requested, { cfg, signal } = {}) {
  if (!cfg.harness?.enabled) throw failure('工作区读取已关闭', 403)
  if (goal.scope?.workspaceRoot && cfg.harness.workspaceRoot !== goal.scope.workspaceRoot) throw failure('目标的工作区读取权限已变更', 403)
  const relative = scopedPath(goal, requested)
  const result = await executeWorkspaceTool('workspace_list', { path: relative, limit: 100 }, { workspaceRoot: cfg.harness.workspaceRoot, signal })
  const listing = JSON.parse(result.text)
  listing.entries = listing.entries.filter((entry) => !entry.name.startsWith('.') && (entry.type === 'directory' || entry.type === 'file' && supported(entry.name)))
  return listing
}

export async function readResearchFile(goal, requested, { cfg, signal } = {}) {
  if (!cfg.harness?.enabled) throw failure('工作区读取已关闭', 403)
  if (goal.scope?.workspaceRoot && cfg.harness.workspaceRoot !== goal.scope.workspaceRoot) throw failure('目标的工作区读取权限已变更', 403)
  const relative = scopedPath(goal, requested)
  if (!supported(relative)) throw failure('只读取 PDF 或支持的文本文档')
  const bytes = await readWorkspaceBuffer(relative, { workspaceRoot: cfg.harness.workspaceRoot, signal })
  const parsed = await extract(relative, bytes, signal)
  return { name: relative, source: `workspace:${relative}`, observedAt: nowIso(), fingerprint: digest(bytes), ...parsed }
}
