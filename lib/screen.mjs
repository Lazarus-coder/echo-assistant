import { languageText } from './language.mjs'
import { domainText } from './domain-language.mjs'
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

const extractionPrompt = () => domainText('screen.analysisPrompt')

/* ------------------------------ working set -------------------------------- */

function maskSensitiveEvent(event) {
  if (!event?.sensitive) return event
  return { id: event.id, ts: event.ts, sensitive: true, app: '', title: domainText('screen.redacted'),
    activity: domainText('screen.sensitive'), topic: '', focus: 'normal', progress: '', note: '' }
}

async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => {
      try {
        const row = JSON.parse(l)
        return file === WORKING ? maskSensitiveEvent(row) : row
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

export function matchesBlocklist(cfg, { app, title, text }) {
  const list = Array.isArray(cfg.screen?.blocklist) ? cfg.screen.blocklist : []
  const hay = `${app ?? ''} ${title ?? ''}`.toLowerCase()
  for (const entry of list) {
    if (!entry) continue
    if (hay.includes(String(entry).toLowerCase())) return `blocklist:${entry}`
  }
  const patterns = Array.isArray(cfg.screen?.excludeTitlePatterns) ? cfg.screen.excludeTitlePatterns : []
  for (const pat of patterns) {
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

export async function ingestScreenEvent({ text, imageDataUrl, app, title, ts, hidIdleSeconds }) {
  const cfg = await loadConfig()
  if (cfg.screen?.enabled === false) return { skipped: 'disabled' }
  const cleanText = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 12000)
  // 只接受真正的图片 data URL；任意 mime 或普通字符串不能直接转发给视觉端点
  const imageUrl = typeof imageDataUrl === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(imageDataUrl) ? imageDataUrl : ''
  const blocked = matchesBlocklist(cfg, { app, title, text: cleanText })
  if (blocked) {
    log.info(domainText('screen.skipped', blocked.split(':')[0]))
    return { skipped: blocked }
  }
  if (!cleanText && !imageUrl) return { skipped: 'empty' }

  let extracted = null
  let error = null
  try {
    if (imageUrl && cfg.screen?.mode === 'image') {
      extracted = await upstreamChatWithImage({
        model: cfg.screen.visionModel || cfg.upstream.utilityModel,
        system: extractionPrompt(),
        prompt: domainText('screen.screenshotInput', app ?? domainText('screen.unknown'), title ?? domainText('screen.unknown'), nowIso()),
        imageDataUrl: imageUrl,
      })
    } else if (cleanText) {
      const out = await jsonTask({
        system: extractionPrompt(),
        user: domainText('screen.ocrInput', app ?? domainText('screen.unknown'), title ?? domainText('screen.unknown'), nowIso(), clip(cleanText, 8000)),
        model: cfg.upstream.utilityModel,
        maxTokens: 700,
        schemaHint: '{"activity":"","topic":"","app":"","focus":"","progress":"","signals":[],"sensitive":false,"note":""}',
      })
      extracted = out.json
    }
  } catch (err) {
    error = err.message
    log.warn(domainText('screen.analysisFailed'), err.message)
  }

  const sensitive = Boolean(extracted?.sensitive)
  const event = maskSensitiveEvent({
    id: `s_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    ts: ts ?? nowIso(),
    app: stripTags(app ?? extracted?.app ?? '').slice(0, 60),
    title: stripTags(title ?? '').slice(0, 90),
    activity: stripTags(extracted?.activity ?? '').slice(0, 120),
    topic: stripTags(extracted?.topic ?? '').slice(0, 90),
    focus: ['deep', 'normal', 'idle', 'meeting', 'entertainment'].includes(extracted?.focus) ? extracted.focus : 'normal',
    progress: stripTags(extracted?.progress ?? '').slice(0, 40),
    note: stripTags(extracted?.note ?? '').slice(0, 160),
    sensitive,
    hidIdleSeconds: typeof hidIdleSeconds === 'number' ? hidIdleSeconds : null,
    ocrChars: cleanText.length,
    mode: imageUrl && cfg.screen?.mode === 'image' ? 'image' : 'ocr',
  })
  if (sensitive) extracted = { sensitive: true, activity: event.activity, signals: [] }

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
  log.info(domainText('screen.recorded', event.id, written.length))
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
    const key = r.app || domainText('screen.unknown')
    byApp[key] ??= { app: key, count: 0, topics: new Set(), activities: new Set() }
    byApp[key].count++
    if (r.topic) byApp[key].topics.add(r.topic)
    if (r.activity) byApp[key].activities.add(r.activity)
  }
  const lines = Object.values(byApp)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((v) => domainText('screen.eventGroup', v.app, v.count, [...v.activities].slice(0, 3).join(languageText('；', '; ')), v.topics.size ? domainText('screen.topics', [...v.topics].slice(0, 4).join(languageText('、', ', '))) : ''))
  const from = recent[0].ts
  const to = recent[recent.length - 1].ts
  let summary = null
  try {
    const out = await jsonTask({
      system: domainText('screen.summaryPrompt'),
      user: domainText('screen.timeWindow', from, to, lines.join('\n')),
      model: cfg.upstream.utilityModel,
      maxTokens: 200,
      schemaHint: '{"summary":""}',
    })
    summary = out.json?.summary
  } catch (err) {
    log.warn(domainText('screen.summaryFailed'), err.message)
  }
  if (!summary) summary = domainText('screen.appActivity', recent[0].app)
  const session = { id: `ss_${Date.now().toString(36)}`, from, to, count: recent.length, summary: stripTags(summary).slice(0, 160), apps: Object.keys(byApp).slice(0, 6), ts: nowIso() }
  const sessions = await readJsonl(SESSIONS)
  sessions.push(session)
  await writeJsonl(SESSIONS, sessions.slice(-500))
  await appendObservation({ text: domainText('screen.activity', session.summary), kind: 'project', importance: 2, source: 'screen:digest', tags: ['screen'] })
  const markIds = new Set(recent.map((r) => r.id))
  await writeJsonl(WORKING, rows.map((r) => (markIds.has(r.id) ? { ...r, digested: true } : r)))
  log.info(domainText('screen.session', session.id, session.count))
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
      domainText('screen.recentScreen'),
      ...lines,
      `${fresh ? domainText('screen.recent') : domainText('screen.historical')}：${last.app || '?'}｜${last.activity || last.topic}（${last.focus}）`,
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
      id: r.id, label: r.app || domainText('screen.screenActivity'), source: `screen:${r.app || 'unknown'}`,
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
  const requested = cfg.screen?.enabled === true && state?.screen?.captureRequested === true
  const requestFresh = Date.parse(state?.screen?.requestedAt) > Date.now() - 120000
  return {
    enabled: cfg.screen?.enabled !== false && cfg.screen?.enabled === true,
    mode: cfg.screen?.mode ?? 'ocr',
    intervalMinutes: cfg.screen?.intervalMinutes ?? 5,
    retentionDays: cfg.screen?.retentionDays ?? 7,
    keepImages: false,
    blocklist: cfg.screen?.blocklist ?? [],
    lastAt: state?.screen?.lastAt ?? last?.ts ?? null,
    lastOk: state?.screen?.lastOk ?? null,
    permissionMissing: state?.screen?.lastError === 'screen_permission_required',
    captureRequested: requested && requestFresh,
    captureExpired: requested && !requestFresh,
    captureReason: state?.screen?.captureReason ?? null,
    todayCount: rows.filter((r) => String(r.ts).slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    workingCount: rows.length,
    sessions: sessions.slice(-6).reverse(),
    events: rows.slice(-includeEvents).reverse(),
  }
}

export async function setScreenConfig(patch) {
  const { saveConfig } = await import('./config.mjs')
  const clean = { ...patch }
  if ('blocklist' in clean) clean.blocklist = Array.isArray(clean.blocklist) ? clean.blocklist.filter((v) => typeof v === 'string').slice(0, 50) : []
  if ('excludeTitlePatterns' in clean) clean.excludeTitlePatterns = Array.isArray(clean.excludeTitlePatterns) ? clean.excludeTitlePatterns.filter((v) => typeof v === 'string').slice(0, 50) : []
  const cfg = await saveConfig({ screen: clean })
  return cfg.screen
}

export async function requestCapture(reason = 'manual') {
  if (!(await loadConfig()).screen?.enabled) return { requested: false, skipped: 'disabled' }
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
