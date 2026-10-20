import { readJSON, nowIso, clip } from './util.mjs'
import { P } from './config.mjs'
import { mutateState, getConversation } from './store.mjs'
import { record } from './metrics.mjs'
import { log } from './log.mjs'

/**
 * 决策层：把"要不要开口、聊什么类型、跟哪件事"从模型自由发挥
 * 变成一个有反馈回路的策略。
 *
 *  - 类型选择：Thompson 采样（Beta 后验），奖励来自明确的有用/无用反馈
 *  - 门槛自适应：用户明确认为无用的类型需要更高的置信度才开口
 *  - 台账排序：确定性 EV 排序挑跟进事项（临近截止 + 高置信 - 已提过次数 - 放置过久）
 *  - 沉默保持 unknown；时机反馈与内容价值分开
 */

export const KINDS = ['follow_up', 'suggest', 'guide', 'ask', 'brief']
const PRIOR = { a: 1.6, b: 1.6 } // 弱先验：不预设哪种类型更好
const SETTLE_AFTER_HOURS = 6
const LEARNING_VERSION = 2

function explicitLearning(state) {
  const agency = state.agency ?? {}
  return agency.learningVersion === LEARNING_VERSION ? agency : {
    ...agency, learningVersion: LEARNING_VERSION, legacyKinds: agency.kinds ?? {}, kinds: {},
  }
}

const mean = (p) => (p.a ?? 0) / Math.max(1e-9, (p.a ?? 0) + (p.b ?? 0))

function gauss() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Beta(a,b) 采样：用正态近似，避免引入依赖（a,b ≥ 1 时够用）。 */
export function sampleBeta(p) {
  const a = Math.max(0.2, p.a ?? PRIOR.a)
  const b = Math.max(0.2, p.b ?? PRIOR.b)
  const m = a / (a + b)
  const v = (a * b) / ((a + b) ** 2 * (a + b + 1))
  return Math.min(0.999, Math.max(0.001, m + gauss() * Math.sqrt(v)))
}

export async function posteriors() {
  const s = await readJSON(P.state, {})
  const agency = explicitLearning(s)
  const kinds = {}
  for (const k of KINDS) kinds[k] = { ...(agency.kinds?.[k] ?? PRIOR) }
  return { kinds, updatedAt: s?.agency?.updatedAt ?? null, settled: s?.agency?.settled ?? 0 }
}

/** Thompson 采样挑一个类型；返回 {kind, sample, mean, explore} */
export async function pickKind({ candidates = KINDS } = {}) {
  const { kinds } = await posteriors()
  let best = null
  for (const k of candidates) {
    const p = kinds[k] ?? PRIOR
    const s = sampleBeta(p)
    const m = mean(p)
    const draws = (p.a - PRIOR.a) + (p.b - PRIOR.b)
    if (!best || s > best.sample) best = { kind: k, sample: Number(s.toFixed(3)), mean: Number(m.toFixed(3)), draws }
  }
  return best ?? { kind: candidates[0], sample: 0.5, mean: 0.5, draws: 0 }
}

/** 按类型的历史表现调整开口门槛：老是不被接住的类型要更谨慎。 */
export async function thresholdFor(kind, base) {
  const { kinds } = await posteriors()
  const p = kinds[kind]
  if (!p) return base
  const draws = (p.a - PRIOR.a) + (p.b - PRIOR.b)
  if (draws < 2) return base // 样本太少不做惩罚
  const m = mean(p)
  const penalty = (1 - m) * 0.25
  return Math.min(0.9, Math.max(0.4, Number((base + penalty).toFixed(3))))
}

export async function updateKind(kind, reward, { note } = {}) {
  const r = Math.max(0, Math.min(1, reward))
  await mutateState((s) => {
    const agency = explicitLearning(s)
    const kinds = { ...(agency.kinds ?? {}) }
    const cur = kinds[kind] ?? { ...PRIOR }
    kinds[kind] = { a: Number((cur.a + r).toFixed(3)), b: Number((cur.b + (1 - r)).toFixed(3)) }
    s.agency = { ...agency, kinds, updatedAt: nowIso() }
    return s
  })
  record({ kind: 'bandit_update', arm: kind, reward: r, note: note ?? null })
  log.info(`bandit 更新 ${kind} ← 奖励 ${r}`)
}

/** 台账排序：确定性 EV，便于测试与解释。 */
export function scoreLoops(loops, { now = Date.now(), raisedPenalty = 0.18, stalePenalty = 0.05 } = {}) {
  const ranked = (loops ?? [])
    .filter((l) => l.status !== 'done')
    .map((l) => {
      const due = l.due ? Date.parse(`${l.due}T23:59:59`) : null
      const daysToDue = due ? (due - now) / 86400000 : null
      let dueScore = 0.35
      if (daysToDue != null) {
        if (daysToDue < 0) dueScore = 0.55 // 已过期仍值得问一句，但不是最高
        else if (daysToDue <= 1) dueScore = 1
        else if (daysToDue <= 3) dueScore = 0.85
        else if (daysToDue <= 7) dueScore = 0.6
        else dueScore = 0.4
      }
      const ageDays = (now - Date.parse(`${l.opened_at ?? l.touched_at ?? new Date().toISOString().slice(0, 10)}T00:00:00`)) / 86400000
      const stale = Math.max(0, (Number.isFinite(ageDays) ? ageDays : 0) - 14) * stalePenalty
      const ev = dueScore * 0.5 + (l.confidence ?? 0.6) * 0.5 - (l.raised ?? 0) * raisedPenalty - stale
      return { ...l, _ev: Number(ev.toFixed(4)), _daysToDue: daysToDue == null ? null : Number(daysToDue.toFixed(2)) }
    })
    .sort((a, b) => b._ev - a._ev)
  return ranked
}

export function pickLoop(loops, opts) {
  const ranked = scoreLoops(loops, opts)
  return ranked[0] ?? null
}

/** Explicit outcomes belong to one intervention; correcting a vote replaces it. */
export async function applyFeedback({ kind, signal, conversationId, messageId, commitmentId, preparationId } = {}) {
  signal = ({ up: 'good', down: 'bad' })[signal] ?? signal
  if (signal === 'less' || signal === 'more') {
    const { loadConfig, saveConfig } = await import('./config.mjs')
    const cfg = await loadConfig()
    const step = signal === 'less' ? 1 : -1
    const minGap = Math.max(15, Math.min(360, (cfg.proactive.minGapMinutes ?? 45) + step * 15))
    const budget = Math.max(1, Math.min(12, (cfg.proactive.dailyBudget ?? 5) - step))
    const threshold = Math.max(0.4, Math.min(0.9, (cfg.proactive.confidenceThreshold ?? 0.62) + step * 0.04))
    const sharedGap = Math.max(20, Math.min(3600, (cfg.attention?.minGapSeconds ?? 75) + step * 30))
    const sharedBudget = Math.max(1, Math.min(100, (cfg.attention?.dailyBudget ?? 20) - step * 2))
    await saveConfig({
      proactive: { minGapMinutes: minGap, dailyBudget: budget, confidenceThreshold: Number(threshold.toFixed(3)) },
      attention: { minGapSeconds: sharedGap, dailyBudget: sharedBudget },
    })
    return { adjusted: { minGapMinutes: minGap, dailyBudget: budget, confidenceThreshold: Number(threshold.toFixed(3)), attention: { minGapSeconds: sharedGap, dailyBudget: sharedBudget } } }
  }
  if (!['accepted', 'completed', 'wrong_time', 'irrelevant', 'incorrect', 'good', 'bad'].includes(signal)) {
    return { adjusted: null, ignored: 'unknown_signal' }
  }
  const conv = conversationId && messageId ? await getConversation(conversationId) : null
  const message = conv?.messages?.find((m) => m.id === messageId)
  if (messageId && !message) return { adjusted: null, ignored: 'unknown_intervention' }
  if (message && !message.proactive && !message.companion) return { adjusted: null, ignored: 'not_an_intervention' }
  if (message && ((preparationId && preparationId !== message.preparationId) || (commitmentId && commitmentId !== message.commitmentId))) {
    return { adjusted: null, ignored: 'mismatched_intervention' }
  }
  preparationId = message?.preparationId ?? preparationId
  commitmentId = message?.commitmentId ?? commitmentId
  kind = message?.kind ?? kind
  const key = preparationId ? `preparation:${preparationId}` : message ? `message:${conversationId}:${messageId}` : null
  if (!key) return { adjusted: null, ignored: 'missing_intervention' }
  let result = { adjusted: null }
  await mutateState((s) => {
    const preparation = preparationId ? (s.preparations ?? []).find((p) => p.id === preparationId) : null
    if (preparationId && !preparation) {
      result.ignored = 'unknown_preparation'
      return s
    }
    if (preparation && commitmentId && preparation.commitmentId !== commitmentId) {
      result.ignored = 'mismatched_commitment'
      return s
    }
    if (preparation) {
      commitmentId = preparation.commitmentId
      kind = message?.kind ?? 'brief'
    }
    const agency = explicitLearning(s)
    const outcomes = { ...(agency.outcomes ?? {}) }
    const previous = outcomes[key] ?? {}
    if (signal === 'wrong_time' ? previous.timing === 'wrong_time' : previous.utility === signal) {
      result = { ...result, duplicate: true, outcome: previous }
      return s
    }
    const at = nowIso()
    const timing = signal === 'wrong_time'
    const reward = ['accepted', 'completed', 'good'].includes(signal) ? 1 : 0
    const next = {
      ...previous, id: key, conversationId: conversationId ?? previous.conversationId ?? null,
      messageId: messageId ?? previous.messageId ?? null, commitmentId: commitmentId ?? null,
      preparationId: preparationId ?? null, kind: KINDS.includes(kind) ? kind : previous.kind ?? null,
      signals: [...new Set([...(previous.signals ?? []), signal])], updatedAt: at,
      ...(timing ? { timing: 'wrong_time' } : { utility: signal, reward }),
    }
    const kinds = { ...(agency.kinds ?? {}) }
    if (!timing && next.kind) {
      // Remove the old vote before applying a corrected one; accepted→completed is one success.
      if (typeof previous.reward === 'number' && previous.kind) {
        const old = kinds[previous.kind] ?? { ...PRIOR }
        kinds[previous.kind] = { a: old.a - previous.reward, b: old.b - (1 - previous.reward) }
      }
      const cur = kinds[next.kind] ?? { ...PRIOR }
      kinds[next.kind] = { a: Number((cur.a + reward).toFixed(3)), b: Number((cur.b + 1 - reward).toFixed(3)) }
    }
    outcomes[key] = next
    s.agency = { ...agency, kinds, outcomes, updatedAt: at }
    if (timing) s.attention = { ...(s.attention ?? {}), pausedUntil: new Date(Date.now() + 30 * 60000).toISOString() }
    if (preparation) {
      preparation.outcome = { signal: next.utility ?? 'unknown', timing: next.timing ?? null, at }
      if (!timing && preparation.delivery?.status === 'pending') {
        preparation.delivery = { ...preparation.delivery, status: 'reviewed', reviewedAt: at }
      }
    }
    const h = (s.proactive?.history ?? []).find((item) => (messageId && item.messageId === messageId && item.conversationId === conversationId) || (preparationId && item.preparationId === preparationId))
    if (h) h.outcome = { signal: next.utility ?? 'unknown', timing: next.timing ?? null, at }
    result = { ...result, outcome: next }
    return s
  })
  if (!result.duplicate && !result.ignored) record({ kind: 'agency_outcome', signal, interventionId: key })
  return result
}

/** Lack of a reply is unknown, never evidence that the intervention was useless. */
export async function settlePending({ force = false } = {}) {
  let settled = 0
  await mutateState((s) => {
    const h = s?.proactive?.history ?? []
    for (const item of h) {
      if (item.settled || item.outcome?.signal && item.outcome.signal !== 'unknown') continue
      if (!force && Date.now() - Date.parse(item.at ?? '') < SETTLE_AFTER_HOURS * 3600000) continue
      item.settled = true
      item.outcome = { ...(item.outcome ?? {}), signal: 'unknown', at: nowIso() }
      settled++
    }
    s.proactive = { ...(s.proactive ?? {}), history: h }
    s.agency = { ...(s.agency ?? {}), settled: (s.agency?.settled ?? 0) + settled }
    return s
  })
  return { settled }
}

export async function agencyStats() {
  const { kinds, updatedAt, settled } = await posteriors()
  const state = await readJSON(P.state, {})
  const outcomes = Object.fromEntries(['accepted', 'completed', 'wrong_time', 'irrelevant', 'incorrect', 'good', 'bad'].map((k) => [k, 0]))
  for (const outcome of Object.values(state.agency?.outcomes ?? {})) {
    if (outcome.utility in outcomes) outcomes[outcome.utility]++
    if (outcome.timing === 'wrong_time') outcomes.wrong_time++
  }
  outcomes.unknown = (state.proactive?.history ?? []).filter((h) => !h.outcome?.signal || h.outcome.signal === 'unknown').length
  const rows = Object.entries(kinds).map(([kind, p]) => ({
    kind,
    mean: Number(mean(p).toFixed(3)),
    a: Number((p.a ?? 0).toFixed(2)),
    b: Number((p.b ?? 0).toFixed(2)),
    trials: Number(((p.a ?? 0) + (p.b ?? 0) - (PRIOR.a + PRIOR.b)).toFixed(1)),
  }))
  const ranked = rows.sort((x, y) => y.mean - x.mean)
  return {
    kinds: ranked,
    best: ranked[0]?.kind ?? null,
    worst: ranked.at(-1)?.kind ?? null,
    updatedAt,
    settled,
    outcomes,
    timing: { wrongTime: outcomes.wrong_time },
    note: clip('均值只来自明确的有用/无用反馈；完成和采纳属于同一次成功。时机不对单独记录，沉默为未知。', 200),
  }
}
