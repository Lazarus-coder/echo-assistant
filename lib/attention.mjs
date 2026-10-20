import crypto from 'node:crypto'
import { P, loadConfig } from './config.mjs'
import { readJSON, newId } from './util.mjs'
import { mutateState } from './store.mjs'
import { workingContext } from './screen.mjs'

export function localDate(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function inQuietHours(now, quiet) {
  const parse = (v) => {
    if (!/^\d{2}:\d{2}$/.test(v ?? '')) return null
    const [h, m] = v.split(':').map(Number)
    return h < 24 && m < 60 ? h * 60 + m : null
  }
  const start = parse(quiet?.start)
  const end = parse(quiet?.end)
  if (start == null || end == null || start === end) return false
  const d = new Date(now)
  const minute = d.getHours() * 60 + d.getMinutes()
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)
const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, '').trim()

// A rewritten sentence is not new evidence for the same commitment.
export function interventionKeys({ content, anchorId, evidence = [] } = {}) {
  const proof = evidence.map((e) => `${e.source ?? ''}:${norm(e.excerpt ?? e.text ?? '')}`).sort().join('|')
  return {
    fingerprint: hash(norm(content)),
    anchorKey: anchorId ? hash(`${anchorId}:${proof}`) : null,
  }
}

function activeHistory(state, now) {
  return (state.attention?.history ?? []).filter((h) => h.status !== 'reserved' || now - Date.parse(h.at) < 60000)
}

function decide(cfg, state, { channel = 'proactive', now = Date.now(), screen = {}, busyConversations, fingerprint, anchorKey, expiresAt, reservationToken } = {}) {
  const a = state.attention ?? {}
  const history = activeHistory(state, now).filter((h) => h.id !== reservationToken)
  const todayCount = history.filter((h) => localDate(h.at) === localDate(now)).length
  const budget = cfg.attention?.dailyBudget ?? 20
  const minGapSeconds = cfg.attention?.minGapSeconds ?? 75
  const last = history.at(-1)
  const base = {
    todayCount, budget, minGapSeconds, lastAt: last?.at ?? null, lastChannel: last?.channel ?? null,
    focus: screen.freshness === 'fresh' ? screen.focus : null,
    observedAt: screen.observedAt ?? null, freshness: screen.freshness ?? 'unknown',
    pausedUntil: a.pausedUntil ?? null,
  }
  const deny = (reason) => ({ ...base, allow: false, reason })
  if (channel === 'proactive' && !cfg.proactive?.enabled) return deny('disabled')
  if (channel === 'companion' && !cfg.companion?.enabled) return deny('disabled')
  if (expiresAt && Date.parse(expiresAt) <= now) return deny('expired')
  if (inQuietHours(now, cfg.proactive?.quietHours)) return deny('quiet_hours')
  if (Date.parse(a.pausedUntil ?? '') > now) return deny('wrong_time_pause')
  const busy = typeof busyConversations === 'function' ? busyConversations() : busyConversations
  if (busy?.size) return deny('user_active')
  // This is chat activity, not a claim that the device is idle.
  if (state.lastUserMessageAt && now - Date.parse(state.lastUserMessageAt) < 60000) return deny('recent_chat_activity')
  if (screen.freshness === 'fresh' && ['meeting', 'deep'].includes(screen.focus)) return deny(`focus_${screen.focus}`)
  if (fingerprint && history.some((h) => h.fingerprint === fingerprint)) return deny('duplicate')
  if (anchorKey && history.some((h) => h.anchorKey === anchorKey)) return deny('unchanged_evidence')
  if (todayCount >= budget) return deny('shared_daily_budget')
  if (last && now - Date.parse(last.at) < minGapSeconds * 1000) return deny('shared_min_gap')
  if (history.some((h) => h.status === 'reserved')) return deny('delivery_in_progress')
  if (channel === 'proactive') {
    const p = state.proactive ?? {}
    const count = p.daily?.date === localDate(now) ? p.daily.count ?? 0 : 0
    if (count >= (cfg.proactive?.dailyBudget ?? 5)) return deny('daily_budget')
    if (p.lastAt && now - Date.parse(p.lastAt) < (cfg.proactive?.minGapMinutes ?? 45) * 60000) return deny('min_gap')
  } else if (channel === 'companion') {
    const c = state.companion ?? {}
    if (Date.parse(c.pausedUntil ?? '') > now) return deny('paused')
    const key = new Date(now).toISOString().slice(0, 13)
    if (c.hourly?.key === key && c.hourly.count >= (cfg.companion?.hourlyBudget ?? 15)) return deny('hourly_budget')
    if (c.lastBubbleAt && now - Date.parse(c.lastBubbleAt) < (cfg.companion?.minGapSeconds ?? 75) * 1000) return deny('min_gap')
  }
  return { ...base, allow: true, reason: 'ok' }
}

export async function checkAttention(options = {}) {
  const [cfg, state, screen] = await Promise.all([
    loadConfig(), readJSON(P.state, {}), workingContext().catch(() => ({ freshness: 'unknown' })),
  ])
  return decide(cfg, state, { ...options, screen })
}

/** Serialize the final check and budget reservation across both delivery paths. */
export async function reserveAttention(options = {}) {
  let result
  await mutateState(async (state) => {
    const [cfg, screen] = await Promise.all([loadConfig(), workingContext().catch(() => ({ freshness: 'unknown' }))])
    const now = Date.now()
    result = decide(cfg, state, { ...options, now, screen })
    if (!result.allow) return state
    const token = newId('attention')
    state.attention = {
      ...(state.attention ?? {}),
      history: [...activeHistory(state, now).slice(-199), {
        id: token, at: new Date(now).toISOString(), channel: options.channel ?? 'proactive', status: 'reserved',
        fingerprint: options.fingerprint ?? null, anchorKey: options.anchorKey ?? null,
      }],
    }
    result = { ...result, token }
    return state
  })
  return result
}

export async function finishAttention(token, { delivered = true } = {}) {
  await mutateState((s) => {
    const history = s.attention?.history ?? []
    if (delivered) {
      const h = history.find((item) => item.id === token)
      if (h) h.status = 'delivered'
    }
    s.attention = { ...(s.attention ?? {}), history: delivered ? history : history.filter((h) => h.id !== token) }
    return s
  })
}

export const attentionStatus = () => checkAttention()
