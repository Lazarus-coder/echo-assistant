import { readJSON, nowIso, clip } from './util.mjs'
import { P } from './config.mjs'
import { mutateState } from './store.mjs'
import { record } from './metrics.mjs'
import { log } from './log.mjs'

/**
 * 决策层：把"要不要开口、聊什么类型、跟哪件事"从模型自由发挥
 * 变成一个有反馈回路的策略。
 *
 *  - 类型选择：Thompson 采样（Beta 后验），奖励 = 用户是否接住
 *  - 门槛自适应：不被接住的类型需要更高的置信度才开口
 *  - 台账排序：确定性 EV 排序挑跟进事项（临近截止 + 高置信 - 已提过次数 - 放置过久）
 *  - 结算：久未回应的主动消息按 0 奖励结算，形成闭环
 */

export const KINDS = ['follow_up', 'suggest', 'guide', 'ask', 'brief']
const PRIOR = { a: 1.6, b: 1.6 } // 弱先验：不预设哪种类型更好
const SETTLE_AFTER_HOURS = 6

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
  const kinds = {}
  for (const k of KINDS) kinds[k] = { ...(s?.agency?.kinds?.[k] ?? PRIOR) }
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
    const kinds = { ...(s.agency?.kinds ?? {}) }
    const cur = kinds[kind] ?? { ...PRIOR }
    kinds[kind] = { a: Number((cur.a + r).toFixed(3)), b: Number((cur.b + (1 - r)).toFixed(3)) }
    s.agency = { ...(s.agency ?? {}), kinds, updatedAt: nowIso() }
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

/** 用户反馈：好/不好 → 直接进 bandit；多了/少了 → 调全局节流。 */
export async function applyFeedback({ kind, signal }) {
  const good = signal === 'good' || signal === 'up'
  const bad = signal === 'bad' || signal === 'down'
  if ((good || bad) && kind) await updateKind(kind, good ? 1 : 0, { note: `feedback:${signal}` })
  if (signal === 'less' || signal === 'more') {
    const { loadConfig, saveConfig } = await import('./config.mjs')
    const cfg = await loadConfig()
    const step = signal === 'less' ? 1 : -1
    const minGap = Math.max(15, Math.min(360, (cfg.proactive.minGapMinutes ?? 45) + step * 15))
    const budget = Math.max(1, Math.min(12, (cfg.proactive.dailyBudget ?? 5) - step))
    const threshold = Math.max(0.4, Math.min(0.9, (cfg.proactive.confidenceThreshold ?? 0.62) + step * 0.04))
    await saveConfig({ proactive: { minGapMinutes: minGap, dailyBudget: budget, confidenceThreshold: Number(threshold.toFixed(3)) } })
    record({ kind: 'bandit_update', arm: 'global', reward: signal === 'less' ? 1 : 0, note: `throttle:${signal}` })
    return { adjusted: { minGapMinutes: minGap, dailyBudget: budget, confidenceThreshold: Number(threshold.toFixed(3)) } }
  }
  return { adjusted: null }
}

/** 结算：开口超过 6 小时没被接住 → 记 0 奖励（闭环的关键） */
export async function settlePending({ force = false } = {}) {
  const state = await readJSON(P.state, {})
  const history = state?.proactive?.history ?? []
  const last = history.at(-1)
  if (!last || last.replied || last.settled) return { settled: 0 }
  const ageHours = (Date.now() - Date.parse(last.at ?? 0)) / 3600000
  if (!force && ageHours < SETTLE_AFTER_HOURS) return { settled: 0, ageHours: Number(ageHours.toFixed(1)) }
  await updateKind(last.kind ?? 'follow_up', 0, { note: 'settled:no_reply' })
  await mutateState((s) => {
    const h = s?.proactive?.history ?? []
    if (h.length) h[h.length - 1].settled = true
    s.proactive = { ...(s.proactive ?? {}), history: h, settled: (s.proactive?.settled ?? 0) + 1 }
    return s
  })
  return { settled: 1, kind: last.kind, ageHours: Number(ageHours.toFixed(1)) }
}

export async function agencyStats() {
  const { kinds, updatedAt, settled } = await posteriors()
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
    note: clip('均值来自 Beta 后验；开口会被计入，被接住记为 1，6 小时未回应按 0 结算。', 200),
  }
}