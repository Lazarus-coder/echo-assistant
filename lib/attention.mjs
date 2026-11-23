import crypto from 'node:crypto'
import { P, loadConfig } from './config.mjs'
import { readJSON, newId } from './util.mjs'
import { mutateState } from './store.mjs'
import { matchesBlocklist, workingContext } from './screen.mjs'
import { deadlineMilestone } from './deadlines.mjs'

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

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const bandStart = (date) => Math.floor(date.getHours() / 3) * 3
const timingTriggers = ['suggestion', 'requested_goal', 'companion']
const dateBand = /^\d{4}-\d{2}-\d{2}T(?:00|03|06|09|12|15|18|21)$/

function firstTimingDate(now) {
  const first = new Date(now)
  first.setDate(first.getDate() - 13)
  return localDate(first)
}

export function preparationTrigger(goal, artifact) {
  if (!artifact || !goal || artifact.commitmentId !== goal.id) return 'suggestion'
  if ((goal.origin === 'discovered' || goal.discovery) && !goal.discovery?.adopted) return 'suggestion'
  return ['accepted', 'adopted', 'requested', 'answered', 'deadline_approaching'].includes(artifact.trigger) ||
    artifact.milestone || deadlineMilestone(goal) ? 'requested_goal' : 'suggestion'
}

// Keep one local date/band per signal, never conversation text or message counts.
function timingSamples(attention, now) {
  const zone = localZone()
  const history = attention.timingSamples?.zone === zone ? attention.timingSamples : {}
  const from = firstTimingDate(now)
  const today = localDate(now)
  const samples = { zone }
  for (const key of ['chat', ...timingTriggers]) {
    const bands = Array.isArray(history[key]) ? history[key] : []
    samples[key] = [...new Set(bands.filter((band) => typeof band === 'string' && dateBand.test(band) &&
      band.slice(0, 10) >= from && band.slice(0, 10) <= today))]
  }
  return samples
}

function addTimingSample(samples, key, at, now) {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime()) || date.getTime() > now) return
  if (localDate(date) < firstTimingDate(now)) return
  const bucket = `${localDate(date)}T${String(bandStart(date)).padStart(2, '0')}`
  if (!samples[key].includes(bucket)) samples[key].push(bucket)
}

export async function recordUserEngagement(conversationId, at = new Date().toISOString(), cfg) {
  cfg ??= await loadConfig()
  await mutateState((s) => {
    if (!s.lastUserMessageAt || at >= s.lastUserMessageAt) {
      s.lastUserMessageAt = at
      s.lastUserConversationId = conversationId
    }
    if (!cfg.proactive?.enabled && !cfg.companion?.enabled) return
    const now = Date.now()
    s.attention ??= {}
    const samples = timingSamples(s.attention, now)
    addTimingSample(samples, 'chat', at, now)
    s.attention.timingSamples = samples
  })
}

export function recordWrongTime(state, { deliveredAt, timeZone, trigger }, now = Date.now()) {
  state.attention ??= {}
  state.attention.pausedUntil = new Date(now + 30 * 60000).toISOString()
  const samples = timingSamples(state.attention, now)
  if (deliveredAt && timingTriggers.includes(trigger) && (!timeZone || timeZone === samples.zone)) addTimingSample(samples, trigger, deliveredAt, now)
  state.attention.timingSamples = samples
}

function timingPolicy(cfg, state, { now, lastDelivery, trigger }) {
  const style = ['quiet', 'engaged'].includes(cfg.attention?.style) ? cfg.attention.style : 'balanced'
  const date = new Date(now)
  const band = bandStart(date)
  const samples = timingSamples(state.attention ?? {}, now)
  const today = localDate(now)
  const prior = samples.chat.filter((sample) => sample.slice(0, 10) < today)
  const observedDays = new Set(prior.map((sample) => sample.slice(0, 10))).size
  const wrongTimeDays = samples[trigger].filter((sample) => Number(sample.slice(11)) === band).length
  const usualStartHours = []
  for (let hour = 0; observedDays >= 4 && hour < 24; hour += 3) {
    const count = prior.filter((sample) => Number(sample.slice(11)) === hour).length
    if (count >= 3 && count >= observedDays * 0.6) usualStartHours.push(hour)
  }
  const summary = { style, trigger, timeZone: samples.zone, localHour: date.getHours(), observedDays, usualStartHours, wrongTimeDays, nextEligibleAt: null }
  const result = (reason, next) => ({ ...summary, reason, nextEligibleAt: next ? new Date(next).toISOString() : null })
  if (wrongTimeDays >= 2) {
    const end = new Date(now)
    end.setHours(band + 3, 0, 0, 0)
    return result('repeated_wrong_time', end)
  }
  if (trigger === 'requested_goal') return result('requested_goal')
  const gapEnd = lastDelivery + 120 * 60000
  if (style === 'quiet' && now < gapEnd) return result('quiet_style_gap', gapEnd)
  if (!usualStartHours.length) return result('sparse_history')
  if (usualStartHours.includes(band)) return result('usual_chat_window')
  if (style !== 'engaged') {
    const limit = now + (style === 'quiet' ? 6 : 3) * 3600000
    for (let offset = 3; offset <= 9; offset += 3) {
      const start = new Date(now)
      start.setHours(band + offset, 0, 0, 0)
      if (start.getTime() > limit) break
      if (usualStartHours.includes(bandStart(start)) && !inQuietHours(start, cfg.proactive?.quietHours)) return result('waiting_for_usual_window', start)
    }
  }
  return result('outside_usual_window')
}

function decide(cfg, state, { channel = 'proactive', trigger = channel === 'companion' ? 'companion' : 'suggestion', now = Date.now(), screen = {}, busyConversations, fingerprint, anchorKey, expiresAt, reservationToken, chargedBubbleAt } = {}) {
  const a = state.attention ?? {}
  const history = activeHistory(state, now).filter((h) => h.id !== reservationToken)
  const todayCount = history.filter((h) => localDate(h.at) === localDate(now)).length
  const budget = cfg.attention?.dailyBudget ?? 20
  const minGapSeconds = cfg.attention?.minGapSeconds ?? 75
  const last = history.at(-1)
  trigger = channel === 'companion' ? 'companion' : trigger === 'requested_goal' ? 'requested_goal' : 'suggestion'
  const lastDelivery = Math.max(...[last?.at, state.proactive?.lastAt,
    state.companion?.lastBubbleAt !== chargedBubbleAt ? state.companion?.lastBubbleAt : null]
    .map((at) => Date.parse(at)).filter(Number.isFinite))
  const timing = timingPolicy(cfg, state, { now, lastDelivery, trigger })
  const base = {
    timing,
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
    const ownCharge = Number(chargedBubbleAt?.slice(0, 13) === key)
    if (c.hourly?.key === key && c.hourly.count - ownCharge >= (cfg.companion?.hourlyBudget ?? 15)) return deny('hourly_budget')
    if (c.lastBubbleAt && c.lastBubbleAt !== chargedBubbleAt && now - Date.parse(c.lastBubbleAt) < (cfg.companion?.minGapSeconds ?? 75) * 1000) return deny('min_gap')
  }
  if (timing.nextEligibleAt) return deny(timing.reason)
  return { ...base, allow: true, reason: 'ok' }
}

function attentionContext() {
  return Promise.all([
    loadConfig(), readJSON(P.state, {}), workingContext().catch(() => ({ freshness: 'unknown' })),
  ])
}

export async function checkAttention(options = {}) {
  const [cfg, state, screen] = await attentionContext()
  return decide(cfg, state, { ...options, screen })
}

// The native overlay polls asynchronously, after each bubble has already paid its delivery charge.
export async function presentableBubbles(bubbles, busyConversations) {
  if (!bubbles.length) return []
  const [cfg, state, screen] = await attentionContext()
  return bubbles.filter((bubble) => !matchesBlocklist(cfg, { ...bubble.frame, text: bubble.excerpt }) &&
    decide(cfg, state, { channel: 'companion', screen, busyConversations,
      reservationToken: bubble.attentionToken, chargedBubbleAt: bubble.ts }).allow)
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
