import path from 'node:path'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import { P, DATA, loadConfig } from './config.mjs'
import { readJSON, writeJSON, clip, stripTags, nowIso } from './util.mjs'
import { jsonTask, upstreamChatWithImage } from './native.mjs'
import { appendObservation } from './memory.mjs'
import { log } from './log.mjs'

const WORKING = path.join(DATA, 'memory', 'working.jsonl')
const SESSIONS = path.join(DATA, 'memory', 'screen-sessions.jsonl')

const EXTRACT_SYSTEM = `你在分析用户屏幕上的一段内容（可能来自本地 OCR 的文字，也可能是一张截图），用来让私人助手知道"此人此刻在做什么"。

只输出 JSON：
{"activity":"一句话概括正在做的事，20字内","topic":"涉及的具体对象/项目/文件/技术名词","app":"最可能的软件或场景","focus":"deep|normal|idle|meeting|entertainment","progress":"刚遇到问题|正在推进|查资料|收尾|闲聊|不确定","signals":[{"text":"值得长期记住的事实，一句中文陈述句，没有就留空数组","kind":"user|project|feedback|reference|fact","importance":1-5}],"sensitive":true|false,"note":"可空，给助手的判断提示"}

判断规则：
- 只在真的能看出"这人的项目/偏好/计划/进展"时才给 signals，宁缺毋滥；看不懂就给空数组并把 activity 写成"看不出具体内容"。
- 出现密码、验证码、身份证号、银行账号、私聊内容、医疗信息 → sensitive=true，activity 只写"处理敏感信息"，signals 必须为空。
- focus=deep 表示正在专注编码/写作/设计；meeting 表示会议或通话；entertainment 表示明显娱乐。
- 不要复述屏幕上的长文本，不要输出人名全名。`

function parseDataUrl(dataUrl) {
  const m = /^data:([\w./+-]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''))
  if (!m) return null
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }
}

/* ------------------------------ working set -------------------------------- */

async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  await fs.rename(tmp, file)
}

function matchesBlocklist(cfg, { app, title, text }) {
  const list = cfg.screen?.blocklist ?? []
  const hay = `${app ?? ''} ${title ?? ''}`.toLowerCase()
  for (const entry of list) {
    if (!entry) continue
    if (hay.includes(String(entry).toLowerCase())) return `blocklist:${entry}`
  }
  for (const pat of cfg.screen?.excludeTitlePatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(`${title ?? ''} ${text ?? ''}`)) return `pattern:${pat}`
    } catch {}
  }
  return null
}

export async function workingSet({ minutes } = {}) {
  const cfg = await loadConfig()
  const win = (minutes ?? cfg.screen?.workingMinutes ?? 90) * 60000
  const rows = await readJsonl(WORKING)
  return rows.filter((r) => Date.now() - Date.parse(r.ts) <= win)
}

/** Trim working set to TTL and screen sessions to retention. */
export async function pruneScreenData() {
  const cfg = await loadConfig()
  const win = (cfg.screen?.workingMinutes ?? 90) * 60000 * 3
  const cutoff = Date.now() - (cfg.screen?.retentionDays ?? 7) * 86400000
  const working = (await readJsonl(WORKING)).filter((r) => Date.now() - Date.parse(r.ts) <= win)
  await writeJsonl(WORKING, working)
  const sessions = (await readJsonl(SESSIONS)).filter((r) => Date.parse(r.from ?? r.ts) >= cutoff)
  await writeJsonl(SESSIONS, sessions)
  return { working: working.length, sessions: sessions.length }
}

/* --------------------------------- ingest ---------------------------------- */

export async function ingestScreenEvent({ text, imageDataUrl, app, title, ts, hidIdleSeconds, imagePath }) {
  const cfg = await loadConfig()
  if (cfg.screen?.enabled === false) return { skipped: 'disabled' }
  const cleanText = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 12000)
  const blocked = matchesBlocklist(cfg, { app, title, text: cleanText })
  if (blocked) {
    log.info(`屏幕事件被跳过（${blocked}）`)
    return { skipped: blocked }
  }
  if (!cleanText && !imageDataUrl) return { skipped: 'empty' }

  let extracted = null
  let error = null
  try {
    if (imageDataUrl && cfg.screen?.mode === 'image') {
      extracted = await upstreamChatWithImage({
        model: cfg.screen.visionModel ?? cfg.upstream.utilityModel,
        system: EXTRACT_SYSTEM,
        prompt: `应用：${app ?? '未知'}｜窗口标题：${title ?? '未知'}｜时间：${nowIso()}\n请分析这张截图。`,
        imageDataUrl,
      })
    } else if (cleanText) {
      const out = await jsonTask({
        system: EXTRACT_SYSTEM,
        user: `应用：${app ?? '未知'}｜窗口标题：${title ?? '未知'}｜时间：${nowIso()}\n屏幕文字（本地 OCR，可能有错字）：\n${clip(cleanText, 8000)}`,
        model: cfg.screen?.visionModel ?? cfg.upstream.utilityModel,
        maxTokens: 700,
        schemaHint: '{"activity":"","topic":"","app":"","focus":"","progress":"","signals":[],"sensitive":false,"note":""}',
      })
      extracted = out.json
    }
  } catch (err) {
    error = err.message
    log.warn('屏幕理解失败:', err.message)
  }

  const sensitive = Boolean(extracted?.sensitive)
  const event = {
    id: `s_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    ts: ts ?? nowIso(),
    app: stripTags(app ?? extracted?.app ?? '').slice(0, 60),
    title: sensitive ? '（已隐去）' : stripTags(title ?? '').slice(0, 90),
    activity: stripTags(extracted?.activity ?? '').slice(0, 120),
    topic: sensitive ? '' : stripTags(extracted?.topic ?? '').slice(0, 90),
    focus: ['deep', 'normal', 'idle', 'meeting', 'entertainment'].includes(extracted?.focus) ? extracted.focus : 'normal',
    progress: stripTags(extracted?.progress ?? '').slice(0, 40),
    note: stripTags(extracted?.note ?? '').slice(0, 160),
    sensitive,
    hidIdleSeconds: typeof hidIdleSeconds === 'number' ? hidIdleSeconds : null,
    image: cfg.screen?.keepImages && imagePath ? path.basename(imagePath) : undefined,
    ocrChars: cleanText.length,
    mode: imageDataUrl && cfg.screen?.mode === 'image' ? 'image' : 'ocr',
  }

  const rows = await readJsonl(WORKING)
  rows.push(event)
  await writeJsonl(WORKING, rows.slice(-400))

  let written = []
  if (!sensitive && Array.isArray(extracted?.signals)) {
    for (const sig of extracted.signals.slice(0, 3)) {
      if (!sig?.text || String(sig.text).length < 6) continue
      const importance = Math.max(1, Math.min(5, Number(sig.importance) || 2))
      if (importance < 3) continue
      const o = await appendObservation({
        text: sig.text,
        kind: sig.kind ?? 'fact',
        importance,
        source: `screen:${event.app || 'unknown'}`,
        tags: ['screen', event.topic].filter(Boolean),
      })
      if (o) written.push({ id: o.id, text: o.text, deduped: o.deduped })
    }
  }
  if (event.image && imagePath) {
    try {
      await fs.rm(imagePath, { force: true })
      delete event.image
    } catch {}
  }
  log.info(`屏幕事件 ${event.app || '?'} · ${event.activity || '(未识别)'}${written.length ? ` · 沉淀 ${written.length} 条事实` : ''}`)
  return { event, extracted, written, error }
}

/* ------------------------------ session digest ----------------------------- */

/**
 * L0 → L1: fold the working set into one "这段时间在做什么" observation,
 * so Dream (L2) has something stable to consolidate from.
 */
export async function digestScreenSession({ force = false } = {}) {
  const cfg = await loadConfig()
  const windowMin = cfg.screen?.digestMinutes ?? 45
  const rows = await readJsonl(WORKING)
  const cutoff = Date.now() - windowMin * 60000
  const recent = rows.filter((r) => Date.parse(r.ts) >= cutoff && !r.digested && !r.sensitive)
  if (recent.length < (force ? 1 : 3)) return { skipped: 'not_enough', count: recent.length }
  const byApp = {}
  for (const r of recent) {
    const key = r.app || '未知'
    byApp[key] ??= { app: key, count: 0, topics: new Set(), activities: new Set() }
    byApp[key].count++
    if (r.topic) byApp[key].topics.add(r.topic)
    if (r.activity) byApp[key].activities.add(r.activity)
  }
  const lines = Object.values(byApp)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((v) => `- ${v.app}（${v.count} 次）：${[...v.activities].slice(0, 3).join('；')}${v.topics.size ? `｜涉及：${[...v.topics].slice(0, 4).join('、')}` : ''}`)
  const from = recent[0].ts
  const to = recent[recent.length - 1].ts
  let summary = null
  try {
    const out = await jsonTask({
      system: '把用户的屏幕活动压缩成一句中文陈述句（40 字内），描述他这段时间主要在做什么。只输出 {"summary":"..."}，不要复述细节，不要出现人名。',
      user: `时间窗：${from} → ${to}\n${lines.join('\n')}`,
      model: cfg.upstream.utilityModel,
      maxTokens: 200,
      schemaHint: '{"summary":""}',
    })
    summary = out.json?.summary
  } catch (err) {
    log.warn('屏幕摘要失败:', err.message)
  }
  if (!summary) summary = `${recent[0].app} 等应用间的活动`
  const session = { id: `ss_${Date.now().toString(36)}`, from, to, count: recent.length, summary: stripTags(summary).slice(0, 160), apps: Object.keys(byApp).slice(0, 6), ts: nowIso() }
  const sessions = await readJsonl(SESSIONS)
  sessions.push(session)
  await writeJsonl(SESSIONS, sessions.slice(-500))
  await appendObservation({ text: `屏幕活动：${session.summary}`, kind: 'project', importance: 2, source: 'screen:digest', tags: ['screen'] })
  const markIds = new Set(recent.map((r) => r.id))
  await writeJsonl(WORKING, rows.map((r) => (markIds.has(r.id) ? { ...r, digested: true } : r)))
  log.info(`屏幕会话沉淀：${session.summary}`)
  return { session }
}

/** Compact block injected into chat + proactive decisions. */
export async function workingContext({ minutes } = {}) {
  const cfg = await loadConfig()
  if (cfg.screen?.enabled === false) return { text: '', events: 0, observedAt: null, freshness: 'unavailable', evidence: [] }
  const rows = await workingSet({ minutes })
  const usable = rows.filter((r) => !r.sensitive && (r.activity || r.topic)).slice(-8)
  if (!usable.length) return { text: '', events: 0, observedAt: null, freshness: 'unavailable', evidence: [] }
  const lines = usable.map((r) => `[${r.id}] ${r.ts} ${r.app || '?'}｜${r.activity || r.topic}${r.focus !== 'normal' ? `｜${r.focus}` : ''}`)
  const last = usable[usable.length - 1]
  const ageMs = Date.now() - Date.parse(last.ts)
  const maxAgeMs = Math.min(10 * 60000, Math.max(120000, (cfg.screen?.intervalMinutes ?? 5) * 120000))
  const fresh = Number.isFinite(ageMs) && ageMs >= -30000 && ageMs <= maxAgeMs && rows.at(-1)?.id === last.id
  return {
    text: [
      '<screen_now>',
      `用户最近的屏幕活动（本地 OCR 摘要，仅供判断当下情境，不要逐条复述）：`,
      ...lines,
      `${fresh ? '最近观测' : '历史记录，不能推断此刻状态'}：${last.app || '?'}｜${last.activity || last.topic}（${last.focus}）`,
      '</screen_now>',
    ].join('\n'),
    events: usable.length,
    focus: fresh ? last.focus : null,
    activity: last.activity || last.topic,
    app: last.app,
    observedAt: last.ts,
    freshness: fresh ? 'fresh' : 'stale',
    ageSeconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    evidence: usable.map((r) => ({
      id: r.id, label: r.app || '屏幕活动', source: `screen:${r.app || 'unknown'}`,
      observedAt: r.ts, excerpt: `${r.activity || r.topic}${r.progress ? `；${r.progress}` : ''}`,
    })),
  }
}

export async function screenStatus({ includeEvents = 12 } = {}) {
  const cfg = await loadConfig()
  const rows = await readJsonl(WORKING)
  const sessions = await readJsonl(SESSIONS)
  const last = rows[rows.length - 1] ?? null
  const state = await readJSON(P.state, {})
  return {
    enabled: cfg.screen?.enabled !== false && cfg.screen?.enabled === true,
    mode: cfg.screen?.mode ?? 'ocr',
    intervalMinutes: cfg.screen?.intervalMinutes ?? 5,
    retentionDays: cfg.screen?.retentionDays ?? 7,
    keepImages: Boolean(cfg.screen?.keepImages),
    blocklist: cfg.screen?.blocklist ?? [],
    lastAt: state?.screen?.lastAt ?? last?.ts ?? null,
    captureRequested: Boolean(state?.screen?.captureRequested),
    captureReason: state?.screen?.captureReason ?? null,
    todayCount: rows.filter((r) => String(r.ts).slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    workingCount: rows.length,
    sessions: sessions.slice(-6).reverse(),
    events: rows.slice(-includeEvents).reverse(),
  }
}

export async function setScreenConfig(patch) {
  const { saveConfig } = await import('./config.mjs')
  const cfg = await saveConfig({ screen: patch })
  return cfg.screen
}

export async function requestCapture(reason = 'manual') {
  const { mutateState } = await import('./store.mjs')
  await mutateState((s) => {
    s.screen = { ...(s.screen ?? {}), captureRequested: true, captureReason: reason, requestedAt: nowIso() }
    return s
  })
  return { requested: true, reason }
}

export async function markCaptureHandled({ ok, error }) {
  const { mutateState } = await import('./store.mjs')
  await mutateState((s) => {
    s.screen = { ...(s.screen ?? {}), captureRequested: false, captureReason: null, lastAt: nowIso(), lastError: error ?? null, lastOk: Boolean(ok) }
    return s
  })
}
