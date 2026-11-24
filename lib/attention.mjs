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
  const samples = { zone, votes: {} }
  for (const key of ['chat', ...timingTriggers]) {
    const bands = Array.isArray(history[key]) ? history[key] : []
    samples[key] = [...new Set(bands.filter((band) => typeof band === 'string' && dateBand.test(band) &&
      band.slice(0, 10) >= from && band.slice(0, 10) <= today))]
  }
  for (const [id, vote] of Object.entries(history.votes ?? {})) {
    if (timingTriggers.includes(vote?.trigger) && ['good_time', 'wrong_time'].includes(vote.signal) &&
      typeof vote.band === 'string' && dateBand.test(vote.band) && vote.band.slice(0, 10) >= from && vote.band.slice(0, 10) <= today) samples.votes[id] = vote
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

export function recordTimingFeedback(state, { id, signal, previousSignal, firstWrongTimeAt, deliveredAt, timeZone, trigger }, now = Date.now()) {
  state.attention ??= {}
  const a = state.attention
  // A correction can release this intervention's pause while another intervention still holds its own.
  const pauses = a.timingPauses ?? (a.pausedUntil ? { legacy: a.pausedUntil } : {})
  delete pauses[id]
  if (signal === 'wrong_time') pauses[id] = new Date(Date.parse(firstWrongTimeAt) + 30 * 60000).toISOString()
  a.timingPauses = Object.fromEntries(Object.entries(pauses).filter(([, until]) => Date.parse(until) > now))
  a.pausedUntil = Object.values(a.timingPauses).sort().at(-1) ?? null
  const samples = timingSamples(a, now)
  const date = new Date(deliveredAt ?? NaN)
  if (timingTriggers.includes(trigger) && timeZone === samples.zone && date.getTime() <= now && localDate(date) >= firstTimingDate(now)) {
    const band = `${localDate(date)}T${String(bandStart(date)).padStart(2, '0')}`
    if (previousSignal === 'wrong_time' && !samples.votes[id] && samples[trigger].includes(band)) {
      // Before keyed votes, several interventions could share this bucket. Remove it only when attributable.
      const ambiguous = Object.entries(state.agency?.outcomes ?? {}).some(([key, outcome]) =>
        key !== id && outcome.timing === 'wrong_time' && !samples.votes[key] &&
        (trigger === 'companion') === (key.startsWith('bubble:') || outcome.channel === 'companion'))
      if (!ambiguous) samples[trigger] = samples[trigger].filter((entry) => entry !== band)
    }
    samples.votes[id] = { trigger, band, signal }
  } else if (samples.votes[id]) {
    samples.votes[id].signal = signal
  }
  a.timingSamples = samples
}

const interruptionPresets = {
  quiet: { minScore: 0.70, ambientGapMinutes: 120, habitWaitMinutes: 360 },
  balanced: { minScore: 0.62, ambientGapMinutes: 0, habitWaitMinutes: 180 },
  engaged: { minScore: 0.52, ambientGapMinutes: 0, habitWaitMinutes: 0 },
}

// Calendar dates avoid a 23- or 25-hour day distorting the weight of local observations.
function recentDayWeight(day, today) {
  const age = (Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000
  return Number.isFinite(age) ? 0.5 ** (Math.max(0, age) / 5) : 0
}

export function effectiveInterruptionPolicy(cfg, state, { now = Date.now(), trigger = 'suggestion' } = {}) {
  const style = Object.hasOwn(interruptionPresets, cfg.attention?.style) ? cfg.attention.style : 'balanced'
  if (!timingTriggers.includes(trigger)) trigger = 'suggestion'
  const base = { ...interruptionPresets[style] }
  const date = new Date(now)
  const band = bandStart(date)
  const samples = timingSamples(state.attention ?? {}, now)
  const today = localDate(now)
  const prior = samples.chat.filter((sample) => sample.slice(0, 10) < today)
  const observedDays = new Set(prior.map((sample) => sample.slice(0, 10))).size
  // Legacy negative samples have only a date and band. New votes retain their identity for corrections.
  const wrongBands = new Set(samples[trigger])
  const welcomeDates = new Set()
  for (const vote of Object.values(samples.votes)) {
    if (vote.trigger !== trigger) continue
    if (vote.signal === 'good_time') welcomeDates.add(vote.band.slice(0, 10))
    else wrongBands.add(vote.band)
  }
  const wrongTimeDays = [...wrongBands].filter((sample) => Number(sample.slice(11)) === band).length
  const feedbackDates = new Set([...wrongBands].map((sample) => sample.slice(0, 10)))
  const dayWeight = (dates) => dates.size < 2 ? 0 : [...dates].reduce((sum, day) => sum + recentDayWeight(day, today), 0)
  const wrongWeight = dayWeight(feedbackDates)
  const welcomeWeight = dayWeight(welcomeDates)
  const totalWeight = wrongWeight + welcomeWeight + 3
  const feedbackStrength = wrongWeight / totalWeight
  const welcomeStrength = welcomeWeight / totalWeight
  const timingAdjustment = feedbackStrength - welcomeStrength
  const usualStartHours = []
  let habitWeight = 0
  for (let hour = 0; observedDays >= 4 && hour < 24; hour += 3) {
    const matching = prior.filter((sample) => Number(sample.slice(11)) === hour)
    if (matching.length < 3 || matching.length < observedDays * 0.6) continue
    usualStartHours.push(hour)
    const weight = matching.reduce((sum, sample) => sum + recentDayWeight(sample.slice(0, 10), today), 0)
    habitWeight = Math.max(habitWeight, weight)
  }
  const habitStrength = habitWeight / (habitWeight + 4)
  const configured = cfg.proactive?.confidenceThreshold
  const calibrationOffset = Number.isFinite(configured) ? Math.max(0, Math.min(1, configured)) - interruptionPresets.balanced.minScore : 0
  const adaptedScore = Math.min(0.86, base.minScore + 0.20 * timingAdjustment)
  const calibratedScore = Math.max(0, Math.min(1, adaptedScore + calibrationOffset))
  const habitExtension = Math.min(1, base.habitWaitMinutes / 180) * 90 * habitStrength
  const effective = {
    minScore: Number(calibratedScore.toFixed(3)),
    ambientGapMinutes: Math.max(0, Math.min(180, base.ambientGapMinutes + Math.round(80 * timingAdjustment))),
    habitWaitMinutes: Math.max(0, Math.min(480, base.habitWaitMinutes + Math.round(habitExtension + 60 * timingAdjustment))),
  }
  const reasons = []
  if (feedbackStrength) reasons.push('timing_feedback')
  if (welcomeStrength) reasons.push('welcome_timing')
  if (habitExtension > 0) reasons.push('regular_chat_hours')
  if (calibrationOffset) reasons.push('score_calibration')
  return {
    style, trigger, base, effective, reasons, calibrationOffset: Number(calibrationOffset.toFixed(3)),
    feedbackDays: feedbackDates.size, feedbackStrength: Number(feedbackStrength.toFixed(3)),
    welcomeDays: welcomeDates.size, welcomeStrength: Number(welcomeStrength.toFixed(3)), timingAdjustment: Number(timingAdjustment.toFixed(3)),
    habitStrength: Number(habitStrength.toFixed(3)), timeZone: samples.zone, localHour: date.getHours(), observedDays, usualStartHours, wrongTimeDays,
  }
}

function timingPolicy(cfg, state, { now, lastDelivery, trigger }) {
  const { style, timeZone, localHour, observedDays, usualStartHours, wrongTimeDays, trigger: family, ...policy } = effectiveInterruptionPolicy(cfg, state, { now, trigger })
  const summary = { style, trigger: family, timeZone, localHour, observedDays, usualStartHours, wrongTimeDays, policy, nextEligibleAt: null }
  const result = (reason, next) => ({ ...summary, reason, nextEligibleAt: next ? new Date(next).toISOString() : null })
  const band = Math.floor(localHour / 3) * 3
  if (wrongTimeDays >= 2) {
    const end = new Date(now)
    end.setHours(band + 3, 0, 0, 0)
    return result('repeated_wrong_time', end)
  }
  if (trigger === 'requested_goal') return result('requested_goal')
  const gapEnd = lastDelivery + policy.effective.ambientGapMinutes * 60000
  if (policy.effective.ambientGapMinutes > 0 && now < gapEnd) {
    return result(policy.effective.ambientGapMinutes === policy.base.ambientGapMinutes ? 'quiet_style_gap' : 'learned_timing_gap', gapEnd)
  }
  if (!usualStartHours.length) return result('sparse_history')
  if (usualStartHours.includes(band)) return result('usual_chat_window')
  if (policy.effective.habitWaitMinutes > 0) {
    const limit = now + policy.effective.habitWaitMinutes * 60000
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
  return bubbles.filter((bubble) => (bubble.wordingLanguage ?? 'zh-CN') === cfg.language &&
    !state.agency?.mutedTopics?.[bubble.selection?.topicKey] &&
    (!bubble.scenario || !Array.isArray(cfg.companion?.scenarios) || cfg.companion.scenarios.includes(bubble.scenario)) &&
    !matchesBlocklist(cfg, { ...bubble.frame, text: bubble.excerpt }) &&
    decide(cfg, state, { channel: 'companion', screen, busyConversations, expiresAt: bubble.expiresAt,
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
