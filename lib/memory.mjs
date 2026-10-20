import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { P, ROOT, loadConfig } from './config.mjs'
import { readJSON, writeJSON, clip, stripTags, tokenize } from './util.mjs'
import { jsonTask } from './native.mjs'
import { entitiesInQuery } from './graph.mjs'
import { log } from './log.mjs'

export const KINDS = ['user', 'project', 'feedback', 'reference', 'fact']
const HALF_LIFE_DAYS = 14

const CORE_SEED = `# Echo 核心记忆

> 这份文件会注入每一次对话。人工也可以直接改，改完保存即可生效。

## 关于你

## 正在跟进

## 偏好与约定

## 待办与提醒
`

let writeChain = Promise.resolve()
function locked(fn) {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(() => {}, () => {})
  return run
}

/* ------------------------------- core memory ------------------------------- */

export async function ensureCore() {
  await fs.mkdir(P.memoryBackups, { recursive: true })
  await fs.mkdir(P.dreams, { recursive: true })
  try {
    await fs.access(P.memoryCore)
  } catch {
    await fs.writeFile(P.memoryCore, CORE_SEED)
  }
  return loadCore()
}

export function loadCore() {
  return fs.readFile(P.memoryCore, 'utf8').catch(() => CORE_SEED)
}

export async function saveCore(text, { backup = true } = {}) {
  return locked(async () => {
    if (backup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try {
        const prev = await fs.readFile(P.memoryCore, 'utf8')
        if (prev !== text) await fs.writeFile(path.join(P.memoryBackups, `MEMORY-${stamp}.md`), prev)
      } catch {}
    }
    await fs.writeFile(P.memoryCore, text)
    return text
  })
}

/* ----------------------------- observations ------------------------------- */

const obsId = () => `o_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`

async function readObservations() {
  let raw = ''
  try {
    raw = await fs.readFile(P.memoryObs, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o?.id && o.text) out.push(o)
    } catch {}
  }
  return out
}

async function writeObservations(list) {
  const body = list.map((o) => JSON.stringify(o)).join('\n')
  await fs.mkdir(path.dirname(P.memoryObs), { recursive: true })
  const tmp = `${P.memoryObs}.tmp`
  await fs.writeFile(tmp, `${body}\n`)
  await fs.rename(tmp, P.memoryObs)
}

export async function appendObservation({ text, kind = 'fact', importance = 2, source = 'manual', tags = [] }) {
  const clean = stripTags(String(text ?? '')).replace(/\s+/g, ' ').trim().slice(0, 400)
  if (clean.length < 4) return null
  return locked(async () => {
    const list = await readObservations()
    const dup = list.find((o) => o.status !== 'deleted' && similarity(o.text, clean) > 0.92)
    if (dup) {
      dup.last_seen = new Date().toISOString()
      dup.hits = (dup.hits ?? 1) + 1
      await writeObservations(list)
      return { ...dup, deduped: true }
    }
    const obs = {
      id: obsId(),
      text: clean,
      kind: KINDS.includes(kind) ? kind : 'fact',
      importance: Math.max(1, Math.min(5, Number(importance) || 2)),
      source,
      tags,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      hits: 1,
      status: 'active',
    }
    list.push(obs)
    await writeObservations(list)
    return obs
  })
}

export async function listObservations({ limit = 200, includeInactive = false, kind } = {}) {
  const list = await readObservations()
  const filtered = list.filter((o) => (includeInactive || o.status === 'active') && (!kind || o.kind === kind))
  return filtered.slice(-limit).reverse()
}

/** mem0-style reconciliation: ADD / UPDATE / DELETE / NOOP against existing ids. */
export async function applyOps(ops, { source = 'extract' } = {}) {
  const applied = []
  for (const op of ops ?? []) {
    if (!op || typeof op !== 'object') continue
    const kind = String(op.op ?? 'ADD').toUpperCase()
    if (kind === 'NOOP') continue
    if (kind === 'ADD') {
      const o = await appendObservation({ text: op.text, kind: op.kind, importance: op.importance, source })
      if (o) applied.push({ op: 'ADD', id: o.id, deduped: o.deduped })
      continue
    }
    if (kind === 'UPDATE' || kind === 'DELETE') {
      const id = String(op.id ?? '')
      if (!id) continue
      await locked(async () => {
        const list = await readObservations()
        const target = list.find((o) => o.id === id)
        if (!target) return
        if (kind === 'DELETE') target.status = 'deleted'
        else {
          target.text = stripTags(String(op.text ?? target.text)).slice(0, 400)
          if (op.kind) target.kind = KINDS.includes(op.kind) ? op.kind : target.kind
          if (op.importance) target.importance = Math.max(1, Math.min(5, Number(op.importance) || target.importance))
          target.last_seen = new Date().toISOString()
          target.sources = [...new Set([...(target.sources ?? []), target.source, source].filter(Boolean))].slice(-8)
          target.source = source
        }
        await writeObservations(list)
      })
      applied.push({ op: kind, id })
    }
  }
  return applied
}

export async function deleteObservation(id) {
  return locked(async () => {
    const list = await readObservations()
    const target = list.find((o) => o.id === id)
    if (!target) return false
    target.status = 'deleted'
    target.last_seen = new Date().toISOString()
    await writeObservations(list)
    return true
  })
}

export async function markSeen(ids) {  await locked(async () => {
    const list = await readObservations()
    let touched = false
    for (const o of list) {
      if (ids.includes(o.id)) {
        o.hits = (o.hits ?? 0) + 1
        o.last_seen = new Date().toISOString()
        touched = true
      }
    }
    if (touched) await writeObservations(list)
  })
}

/* -------------------------------- retrieval -------------------------------- */

export { tokenize }

function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / Math.sqrt(A.size * B.size)
}

function daysSince(iso) {
  const t = Date.parse(iso ?? '')
  if (Number.isNaN(t)) return 365
  return Math.max(0, (Date.now() - t) / 86400000)
}

export async function retrieve(query, { topK = 6, minScore = 0.06, includeFaded = false } = {}) {
  const list = (await readObservations()).filter((o) => (includeFaded ? o.status !== 'deleted' : o.status === 'active'))
  if (!list.length) return []
  const qTokens = [...new Set(tokenize(query))]
  const df = new Map()
  const docs = list.map((o) => {
    const set = new Set(tokenize(`${o.text} ${o.tags?.join(' ') ?? ''} ${o.kind}`))
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
    return set
  })
  const N = list.length
  const avgLen = docs.reduce((a, d) => a + d.size, 0) / N || 1
  const k1 = 1.2
  const b = 0.75
  // 实体加成：问句里出现已知实体（项目/人/工具）时，带上它的相关事实一起召回
  const entities = await entitiesInQuery(query).catch(() => [])
  const entityNames = entities.map((e) => e.name).filter((n) => n && n.length > 1)
  const entityIds = new Set(entities.flatMap((e) => e.obsIds ?? []))
  const scored = list.map((o, i) => {
    const doc = docs[i]
    let bm25 = 0
    for (const t of qTokens) {
      if (!doc.has(t)) continue
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
      const tf = 1
      bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.size / avgLen))))
    }
    const recency = Math.exp(-daysSince(o.last_seen ?? o.created_at) / HALF_LIFE_DAYS)
    const importance = 0.35 + (o.importance / 5) * 0.65
    const base = Number((bm25 * importance * 0.7 + recency * 0.3 * importance).toFixed(4))
    const entityBoost = (entityIds.has(o.id) ? 1.4 : 1) * (entityNames.some((n) => o.text.includes(n)) ? 1.25 : 1)
    return { ...o, score: base * (bm25 > 0 ? 1 : 0.35) * entityBoost, _bm25: bm25, _entityBoost: entityBoost }
  })
  return scored
    .filter((o) => o.score >= minScore || o.importance >= 4)
    .sort((x, y) => y.score - x.score)
    .slice(0, topK)
}

/** Everything we inject into the system prompt: core md + recalled facts. */
export async function buildMemoryContext({ query, cfg }) {
  if (!cfg.memory?.enabled || !cfg.memory?.inject) return { text: '', used: [] }
  const core = await loadCore()
  const recalled = await retrieve(query, { topK: cfg.memory.retrieveTopK ?? 6 })
  const parts = []
  const trimmedCore = clip(String(core).replace(/<!--[\s\S]*?-->/g, '').trim(), cfg.memory.injectChars ?? 2600)
  if (trimmedCore && !/^# Echo 核心记忆\s*$/.test(trimmedCore)) parts.push(`<core_memory>\n${trimmedCore}\n</core_memory>`)
  if (recalled.length) {
    parts.push('<recalled_facts>')
    for (const o of recalled) parts.push(`- [${o.id}|${o.kind}|重要度${o.importance}] ${o.text}`)
    parts.push('</recalled_facts>')
    await markSeen(recalled.map((o) => o.id))
  }
  return { text: parts.join('\n\n'), used: recalled.map(({ id, text, kind, score }) => ({ id, text, kind, score })) }
}

/* -------------------------------- forgetting -------------------------------- */

/**
 * 记忆强度：重要度越高越难忘，被用得越多越牢，时间越久越淡。
 * 这是一条可解释的曲线——每一次淡出都能说清是"多久没用"还是"容量淘汰"。
 */
export function strengthOf(o, cfg) {
  const halfLife = (cfg?.memory?.halfLifeDays ?? 14) * (1 + 0.35 * ((o.importance ?? 2) - 1))
  const days = daysSince(o.last_seen ?? o.created_at)
  const usage = 1 + (cfg?.memory?.usageGain ?? 0.5) * Math.log2(1 + (o.hits ?? 1))
  const decay = Math.exp(-days / halfLife)
  return Number(((o.importance ?? 2) * usage * decay).toFixed(3))
}

const forgettingFile = () => path.join(path.dirname(P.memoryObs), 'forgetting.md')

/** 遗忘日志：写清楚忘了什么、为什么忘、依据哪个数字。 */
export async function logForgetting(entries, { trigger = 'manual', kind = 'faded', note } = {}) {
  if (!entries?.length) return null
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const lines = [`## ${stamp} · ${trigger} · ${kind}（${entries.length} 条）`]
  if (note) lines.push(`> ${note}`)
  for (const e of entries) {
    const meta = [e.kind, `重要度${e.importance ?? '?'}`, `命中${e.hits ?? 1}次`, e.days != null ? `${e.days} 天未用` : null, e.strength != null ? `强度${e.strength}` : null]
      .filter(Boolean)
      .join(' · ')
    lines.push(`- [${e.id}] (${meta}) ${clip(e.text ?? '', 160)}`)
    if (e.reason) lines.push(`  - 原因：${e.reason}`)
    if (e.why) lines.push(`  - 决策：${e.why}`)
  }
  lines.push('')
  const file = forgettingFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${lines.join('\n')}\n`)
  return file
}

export async function readForgettingLog({ limit = 60 } = {}) {
  try {
    const raw = await fs.readFile(forgettingFile(), 'utf8')
    const blocks = raw.split(/\n(?=## )/).filter(Boolean)
    return blocks.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 定期扫一遍：该淡的淡掉，超出容量就按强度淘汰。 */
export async function forgetScan({ trigger = 'schedule', dryRun = false } = {}) {
  const cfg = await loadConfig()
  const list = await readObservations()
  const minAge = cfg.memory?.fadeMinAgeDays ?? 21
  const threshold = cfg.memory?.fadeThreshold ?? 0.35
  const faded = []
  for (const o of list) {
    if (o.status !== 'active' || o.protected) continue
    const days = daysSince(o.last_seen ?? o.created_at)
    if (days < minAge) continue
    if ((o.importance ?? 2) >= 4 && days < 180) continue
    const s = strengthOf(o, cfg)
    if (s >= threshold) continue
    faded.push({
      id: o.id,
      text: o.text,
      kind: o.kind,
      importance: o.importance,
      hits: o.hits ?? 1,
      days: Math.round(days),
      strength: s,
      reason: `${Math.round(days)} 天没被用到，强度 ${s} < 阈值 ${threshold}`,
    })
    if (!dryRun) {
      o.status = 'faded'
      o.faded_at = new Date().toISOString()
      o.fade_reason = 'decay'
      o.faded_strength = s
    }
  }

  const active = list.filter((o) => o.status === 'active' && !o.protected)
  const max = cfg.memory?.maxActiveObservations ?? 1200
  if (active.length > max) {
    const ranked = active.map((o) => ({ o, s: strengthOf(o, cfg) })).sort((a, b) => a.s - b.s)
    for (let i = 0; i < active.length - max && i < ranked.length; i++) {
      const { o, s } = ranked[i]
      faded.push({
        id: o.id,
        text: o.text,
        kind: o.kind,
        importance: o.importance,
        hits: o.hits ?? 1,
        days: Math.round(daysSince(o.last_seen ?? o.created_at)),
        strength: s,
        reason: `超出容量上限 ${max} 条，按强度从最弱淘汰`,
      })
      if (!dryRun) {
        o.status = 'faded'
        o.faded_at = new Date().toISOString()
        o.fade_reason = 'capacity'
        o.faded_strength = s
      }
    }
  }

  if (faded.length && !dryRun) {
    await locked(async () => {
      const fresh = await readObservations()
      const byId = new Map(faded.map((f) => [f.id, f]))
      for (const o of fresh) {
        if (!byId.has(o.id)) continue
        const f = byId.get(o.id)
        o.status = 'faded'
        o.faded_at = new Date().toISOString()
        o.fade_reason = f.reason.includes('容量') ? 'capacity' : 'decay'
        o.faded_strength = f.strength
      }
      await writeObservations(fresh)
    })
    await logForgetting(faded, { trigger, kind: 'faded' })
    log.info(`遗忘扫描：淡出 ${faded.length} 条（扫描 ${list.length}）`)
  }
  return { faded, scanned: list.length, active: list.filter((o) => o.status === 'active').length }
}

export async function setProtected(id, on = true) {
  return locked(async () => {
    const list = await readObservations()
    const target = list.find((o) => o.id === id)
    if (!target) return null
    target.protected = Boolean(on)
    if (on && target.status === 'faded') {
      target.status = 'active'
      target.last_seen = new Date().toISOString()
      delete target.fade_reason
      target.hits = (target.hits ?? 1) + 1
    }
    await writeObservations(list)
    return target
  })
}

/** 用户主动说"忘掉这个"——立即生效，并留下理由。 */
export async function forgetById(id, why = '用户要求忘记') {
  return locked(async () => {
    const list = await readObservations()
    const target = list.find((o) => o.id === id)
    if (!target) return null
    target.status = 'deleted'
    target.faded_at = new Date().toISOString()
    target.fade_reason = 'user_request'
    await writeObservations(list)
    await logForgetting(
      [{ id: target.id, text: target.text, kind: target.kind, importance: target.importance, hits: target.hits, days: Math.round(daysSince(target.last_seen ?? target.created_at)) }],
      { trigger: 'user', kind: 'forgotten', note: why },
    )
    return target
  })
}

export async function recallForgetting({ limit = 40 } = {}) {
  const list = await readObservations()
  const gone = list
    .filter((o) => o.status !== 'active')
    .map((o) => ({
      id: o.id,
      text: o.text,
      kind: o.kind,
      status: o.status,
      importance: o.importance,
      hits: o.hits ?? 1,
      faded_at: o.faded_at ?? null,
      reason: o.fade_reason ?? 'unknown',
      strength: o.faded_strength ?? null,
    }))
    .reverse()
    .slice(0, limit)
  return { items: gone, log: await readForgettingLog({ limit: 20 }) }
}

/* ------------------------------- extraction -------------------------------- */

const EXTRACT_SYSTEM = `你在为私人助手维护长期记忆。任务：阅读一段新对话，只抽取「以后还用得上、且不会很快过期」的事实。
规则：
- 关于用户的身份/偏好/约束/正在推进的项目/明确说出的计划与截止日期 → 值得记
- 一次性问答、模型自己的推理、闲聊客套、已经能从上下文推断的 → 不记
- 临时情绪、一次争执、语气或沉默不写成长期性格、心理状态或关系结论；只有当下感受时返回 ops=[]。用户明确说出的稳定沟通偏好可以保留。
- 第三方信息只保留用户明确提供、以后仍有用的稳定事实与沟通约束；不推断动机、关系亲疏、信任度或情感倾向。助手的猜测与建议、屏幕/OCR 内容不算用户确认。
- 每条写成一句独立的中文陈述句，不超过 60 字；第三方的主观描述须保留“用户描述”归属，不把转述升级成客观事实
- 与已有事实重复 → NOOP；与已有事实冲突且新的更可信 → UPDATE 指定 id；用户明确否认 → DELETE 指定 id
- 最多 4 条，宁缺毋滥`

export async function extractMemory({ userText, assistantText, cfg, source }) {
  if (!cfg.memory?.enabled || !cfg.memory?.extract) return { ops: [], applied: [] }
  if (String(userText ?? '').length < (cfg.memory.extractMinChars ?? 24)) return { ops: [], applied: [] }
  const existing = await retrieve(userText, { topK: 12 })
  const schema = '{"ops":[{"op":"ADD|UPDATE|DELETE|NOOP","id":"已有事实id","text":"...","kind":"user|project|feedback|reference|fact","importance":1-5}],"reason":"一句话"}'
  let out
  try {
    out = await jsonTask({
      system: EXTRACT_SYSTEM,
      user: [
        '已有事实（用于查重/冲突判断）:',
        existing.length ? existing.map((o) => `- [${o.id}] (来源 ${(o.sources?.length ? o.sources : [o.source ?? '未知']).join('、')}，最近 ${o.last_seen ?? o.created_at ?? '未知'}) ${o.text}`).join('\n') : '(空)',
        '',
        `本轮来源：${source ?? 'chat'}（仅用户明确提供的内容可成为新事实）`,
        `用户: ${clip(userText, 3000)}`,
        `助手: ${clip(assistantText, 1500)}`,
      ].join('\n'),
      model: cfg.upstream.utilityModel,
      maxTokens: 700,
      schemaHint: schema,
    })
  } catch (err) {
    log.warn('记忆抽取失败:', err.message)
    return { ops: [], applied: [], error: err.message }
  }
  const ops = Array.isArray(out.json?.ops) ? out.json.ops : []
  const applied = await applyOps(ops, { source: source ?? 'chat' })
  if (applied.length) log.info(`记忆写入 ${applied.length} 条`)
  return { ops, applied, usage: out.usage }
}

export async function memoryStats() {
  const cfg = await loadConfig()
  const list = await readObservations()
  const active = list.filter((o) => o.status === 'active')
  const core = await loadCore()
  const state = await readJSON(P.state, null)
  const strengths = active.map((o) => strengthOf(o, cfg))
  return {
    observations: active.length,
    total: list.length,
    byKind: active.reduce((acc, o) => ({ ...acc, [o.kind]: (acc[o.kind] ?? 0) + 1 }), {}),
    coreChars: core.length,
    lastDream: state?.dream?.at ?? null,
    forgetting: {
      faded: list.filter((o) => o.status === 'faded').length,
      deleted: list.filter((o) => o.status === 'deleted').length,
      protected: list.filter((o) => o.protected).length,
      avgStrength: strengths.length ? Number((strengths.reduce((a, b) => a + b, 0) / strengths.length).toFixed(2)) : 0,
      weakest: strengths.length ? Math.min(...strengths) : 0,
      fadingSoon: active.filter((o) => strengthOf(o, cfg) < (cfg.memory?.fadeThreshold ?? 0.35) * 1.6 && !o.protected).length,
      logEntries: (await readForgettingLog({ limit: 200 })).length,
    },
  }
}

export { readObservations }
