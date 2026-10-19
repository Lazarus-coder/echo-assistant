import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ID_RE = /^[a-zA-Z0-9_-]{3,80}$/

export function newId(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

export function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const e = new Error('invalid id')
    e.status = 400
    throw e
  }
  return id
}

export async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    if (err instanceof SyntaxError) return fallback
    throw err
  }
}

export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2))
  await fs.rename(tmp, file)
}

export const nowIso = () => new Date().toISOString()

export function clip(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export function decodeEntities(input) {
  if (!input) return ''
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', times: '×', trade: '™', bull: '•' }
  return input
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name.toLowerCase()] ?? m)
}

function cp(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim()
}

/** 中文用字符二元组、西文用词，凑合的轻量分词（不引依赖）。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const latin = s.match(/[a-z0-9_+.-]{2,}/g) ?? []
  const cjkRuns = s.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []
  const grams = []
  for (const run of cjkRuns) {
    if (run.length === 1) grams.push(run)
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2))
  }
  return [...latin, ...grams]
}
