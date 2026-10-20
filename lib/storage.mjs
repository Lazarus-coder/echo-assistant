import path from 'node:path'
import { promises as fs } from 'node:fs'
import { P, DATA } from './config.mjs'
import { log } from './log.mjs'

const SHOTS = path.join(DATA, 'screenshots')
const MB = 1024 * 1024

async function dirStats(dir) {
  let bytes = 0
  let files = []
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      try {
        const st = await fs.stat(full)
        if (!st.isFile()) continue
        bytes += st.size
        files.push({ file: name, size: st.size, mtime: st.mtimeMs })
      } catch {}
    }
  } catch {}
  files.sort((a, b) => a.mtime - b.mtime)
  return { bytes, files, count: files.length }
}

/** Files still referenced by conversations updated recently — never delete these. */
async function referencedUploads({ days = 45 } = {}) {
  const keep = new Set()
  const cutoff = Date.now() - days * 86400000
  try {
    for (const name of await fs.readdir(P.convDir)) {
      if (!name.endsWith('.json')) continue
      const full = path.join(P.convDir, name)
      try {
        const st = await fs.stat(full)
        if (st.mtimeMs < cutoff) continue
        const raw = await fs.readFile(full, 'utf8')
        for (const m of raw.matchAll(/\/api\/uploads\/([A-Za-z0-9._-]+)/g)) keep.add(m[1])
      } catch {}
    }
  } catch {}
  return keep
}

/**
 * Two-stage cleanup: age first, then size. Screenshots are deleted right after
 * analysis by default (keepImages=false), so this is the backstop that keeps
 * data/ from creeping up even if that path ever leaks.
 */
export async function pruneStorage({ force = false } = {}) {
  const { loadConfig } = await import('./config.mjs')
  const cfg = await loadConfig()
  const budgets = cfg.storage ?? {}
  const screenDays = budgets.screenRetentionDays ?? 3
  const uploadDays = budgets.uploadRetentionDays ?? 60
  const screenBudget = (budgets.screenImageBudgetMB ?? 200) * MB
  const uploadBudget = (budgets.uploadsBudgetMB ?? 300) * MB
  const report = { screen: {}, uploads: {}, freedMB: 0, at: new Date().toISOString() }

  const now = Date.now()
  const shots = await dirStats(SHOTS)
  let removedBytes = 0
  const survivors = []
  for (const f of shots.files) {
    const old = now - f.mtime > screenDays * 86400000
    if (old) {
      try {
        await fs.rm(path.join(SHOTS, f.file), { force: true })
        removedBytes += f.size
        continue
      } catch {}
    }
    survivors.push(f)
  }
  let keptBytes = survivors.reduce((a, f) => a + f.size, 0)
  let i = 0
  while (keptBytes > screenBudget * 0.8 && i < survivors.length) {
    const f = survivors[i++]
    try {
      await fs.rm(path.join(SHOTS, f.file), { force: true })
    } catch {
      continue
    }
    keptBytes -= f.size
    removedBytes += f.size
  }
  report.screenshots = { beforeMB: +(shots.bytes / MB).toFixed(1), count: shots.count, afterMB: +(keptBytes / MB).toFixed(1), budgetMB: budgets.screenImageBudgetMB ?? 200 }

  const uploads = await dirStats(P.uploads)
  const keep = await referencedUploads({})
  let uploadBytes = uploads.bytes
  for (const f of uploads.files) {
    const tooOld = now - f.mtime > uploadDays * 86400000
    if (!tooOld) continue
    if (keep.has(f.file)) continue
    try {
      await fs.rm(path.join(P.uploads, f.file), { force: true })
    } catch {
      continue
    }
    uploadBytes -= f.size
    removedBytes += f.size
  }
  if (uploadBytes > uploadBudget) {
    for (const f of uploads.files) {
      if (uploadBytes <= uploadBudget * 0.8) break
      if (keep.has(f.file)) continue
      const full = path.join(P.uploads, f.file)
      try {
        await fs.access(full)
        await fs.rm(full, { force: true })
      } catch {
        continue
      }
      uploadBytes -= f.size
      removedBytes += f.size
    }
  }
  report.uploads = { beforeMB: +(uploads.bytes / MB).toFixed(1), count: uploads.count, afterMB: +(uploadBytes / MB).toFixed(1), budgetMB: budgets.uploadsBudgetMB ?? 300, protected: keep.size }
  report.freedMB = +(removedBytes / MB).toFixed(2)
  if (removedBytes > 0) log.info(`存储清理：释放 ${report.freedMB}MB（截图 ${report.screenshots.afterMB}MB / 图片 ${report.uploads.afterMB}MB）`)
  return report
}

/** Sweep temp capture files the menubar app may have left behind. */
export async function sweepTempCaptures({ olderThanMinutes = 60 } = {}) {
  const dirs = [path.join(DATA, 'spool'), '/tmp/echo-capture']
  let removed = 0
  for (const dir of dirs) {
    try {
      for (const name of await fs.readdir(dir)) {
        const full = path.join(dir, name)
        const st = await fs.stat(full).catch(() => null)
        if (st?.isFile() && Date.now() - st.mtimeMs > olderThanMinutes * 60000) {
          await fs.rm(full, { force: true })
          removed++
        }
      }
    } catch {}
  }
  return removed
}

export async function storageStats() {
  const [{ bytes: shotBytes, count: shotCount }, { bytes: upBytes, count: upCount }] = [await dirStats(SHOTS), await dirStats(P.uploads)]
  let jsonBytes = 0
  for (const [dir, glob] of [[P.convDir, '.json'], [path.join(DATA, 'memory'), '']]) {
    try {
      for (const name of await fs.readdir(dir)) {
        if (glob && !name.endsWith(glob)) continue
        const st = await fs.stat(path.join(dir, name)).catch(() => null)
        if (st?.isFile()) jsonBytes += st.size
      }
    } catch {}
  }
  const { loadConfig } = await import('./config.mjs')
  const cfg = await loadConfig()
  return {
    screenshots: { mb: +(shotBytes / MB).toFixed(1), count: shotCount, budgetMB: cfg.storage?.screenImageBudgetMB ?? 200 },
    uploads: { mb: +(upBytes / MB).toFixed(1), count: upCount, budgetMB: cfg.storage?.uploadsBudgetMB ?? 300 },
    texts: { kb: +(jsonBytes / 1024).toFixed(1) },
    keepImages: Boolean(cfg.screen?.keepImages),
    at: new Date().toISOString(),
  }
}

export async function ensureStorageDirs() {
  await fs.mkdir(SHOTS, { recursive: true })
  await fs.mkdir(P.uploads, { recursive: true })
  await fs.mkdir(path.join(DATA, 'spool'), { recursive: true })
}
