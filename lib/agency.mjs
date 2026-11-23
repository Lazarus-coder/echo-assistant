import { createHash } from 'node:crypto'
import { readJSON, nowIso, clip } from './util.mjs'
import { P } from './config.mjs'
import { mutateState, getConversation } from './store.mjs'
import { record } from './metrics.mjs'
import { log } from './log.mjs'
import { preparationTrigger, recordTimingFeedback } from './attention.mjs'

/**
 * 决策层：把"要不要开口、聊什么类型、跟哪件事"从模型自由发挥
 * 变成一个有反馈回路的策略。
 *
 *  - 内容排序只读取明确评价，按类型和话题调整本地优先级
 *  - 对同一条提醒改票覆盖前一次选择
 *  - 沉默保持 unknown；时机反馈与内容价值分开
 */

export const KINDS = ['follow_up', 'suggest', 'guide', 'ask', 'brief']
const PRIOR = { a: 1.6, b: 1.6 } // 弱先验：不预设哪种类型更好
const SETTLE_AFTER_HOURS = 6
const LEARNING_VERSION = 2

export function optionalReminderTopic(message) {
  if (message?.role !== 'assistant') return null
  if (message.companion?.bubbleId) return message.companion.selection ?? null
  if (!message.proactive || message.timingTrigger === 'requested_goal' || (message.preparationId && !message.timingTrigger)) return null
  return message.selection ?? null
}

export async function setTopicMute(topicKey, selection) {
  await mutateState((s) => {
    s.agency ??= {}
    const mutes = s.agency.mutedTopics ??= {}
    if (!selection) delete mutes[topicKey]
    else if (!mutes[topicKey]) {
      // Only store built-in cue labels. Resolve personal topic names from currently permitted sources.
      mutes[topicKey] = { addedAt: nowIso(), ...(topicKey.startsWith('companion:') ? { label: selection.label } : {}) }
    }
  })
}

function explicitLearning(state) {
  const agency = state.agency ?? {}
  return agency.learningVersion === LEARNING_VERSION ? agency : {
    ...agency, learningVersion: LEARNING_VERSION, legacyKinds: agency.kinds ?? {}, kinds: {},
  }
}

export function contentTopicKey(channel, topic) {
  const normalized = String(topic ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 300)
  return normalized ? channel + ':' + createHash('sha256').update(normalized).digest('hex').slice(0, 24) : null
}

/** Count each current utility vote once; timing corrections and silence have no content weight. */
export function contentFeedbackIndex(state, { channel = 'proactive', now = Date.now() } = {}) {
  const agency = explicitLearning(state)
  const kinds = new Map(), topics = new Map(), anchors = new Map(), pairs = new Map()
  const knownKinds = new Set()
  const history = new Map()
  for (const row of state.proactive?.history ?? []) {
    if (row.messageId) history.set(row.messageId, row)
    if (row.preparationId) history.set(row.preparationId, row)
  }
  function count(map, key, vote, at) {
    if (!key) return
    const value = map.get(key) ?? { votes: 0, sum: 0, at: -Infinity }
    value.votes++
    value.sum += vote.reward * 2 - 1
    if (at >= value.at) { value.reward = vote.reward; value.at = at }
    map.set(key, value)
  }
  for (const vote of Object.values(agency.outcomes ?? {})) {
    if (!vote || (vote.channel ?? 'proactive') !== channel || ![0, 1].includes(vote.reward)) continue
    knownKinds.add(vote.kind)
    const at = Date.parse(vote.utilityAt ?? vote.updatedAt)
    if (!Number.isFinite(at) || at > now || now - at > 90 * 86400000) continue
    const old = history.get(vote.messageId) ?? history.get(vote.preparationId)
    const anchor = vote.anchorId ?? old?.anchorId ?? vote.commitmentId
    const topic = vote.topicKey ?? old?.selection?.topicKey
    count(kinds, vote.kind, vote, at)
    count(topics, topic, vote, at)
    count(anchors, anchor, vote, at)
    if (topic && anchor) count(pairs, topic + '/' + anchor, vote, at)
  }
  if (channel === 'proactive') for (const [kind, tally] of Object.entries(agency.kinds ?? {})) {
    if (knownKinds.has(kind) || !tally) continue
    const good = Math.max(0, Number(tally.a) - PRIOR.a), bad = Math.max(0, Number(tally.b) - PRIOR.b)
    if (Number.isFinite(good + bad)) kinds.set(kind, { votes: good + bad, sum: good - bad })
  }
  return { kinds, topics, anchors, pairs }
}

export function contentFeedback(state, { kind, topicKey, anchorId, channel = 'proactive', now = Date.now() }, index) {
  index ??= contentFeedbackIndex(state, { channel, now })
  const kindData = index.kinds.get(kind)
  const topic = index.topics.get(topicKey), anchor = index.anchors.get(anchorId), both = index.pairs.get(topicKey + '/' + anchorId)
  const topicVotes = (topic?.votes ?? 0) + (anchor?.votes ?? 0) - (both?.votes ?? 0)
  const topicSum = (topic?.sum ?? 0) + (anchor?.sum ?? 0) - (both?.sum ?? 0)
  return {
    kindAdjustment: 0.16 * (kindData?.sum ?? 0) / (2 + (kindData?.votes ?? 0)), topicAdjustment: 0.24 * topicSum / (2 + topicVotes),
    kindVotes: kindData?.votes ?? 0, topicVotes, dismissed: Boolean(anchor?.reward === 0 && now - anchor.at < 14 * 86400000),
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

function interventionKey({ bubbleId, preparationId, conversationId, messageId }) {
  if (bubbleId) return `bubble:${bubbleId}`
  if (preparationId) return `preparation:${preparationId}`
  return conversationId && messageId ? `message:${conversationId}:${messageId}` : null
}

// All surfaces use the same saved outcome. Older conversations can also carry a vote on the message itself.
export function messageWithFeedback(message, conversationId, outcomes) {
  if (!outcomes || !message?.id || (!message.proactive && !message.companion)) return message
  const key = interventionKey({ bubbleId: message.companion?.bubbleId, preparationId: message.preparationId, conversationId, messageId: message.id })
  const current = outcomes[key]
  const old = outcomes[`message:${conversationId}:${message.id}`]
  if (!current && !old) return message
  const { feedback, feedbackTiming, ...rest } = message
  const oldTiming = feedback === 'good_time' || feedback === 'wrong_time'
  const timing = current?.timing ?? old?.timing ?? feedbackTiming ?? (oldTiming ? feedback : null)
  const utility = current?.utility ?? old?.utility ?? (oldTiming ? null : feedback)
  return { ...rest, ...(utility ? { feedback: utility } : {}), ...(timing ? { feedbackTiming: timing } : {}) }
}

/** Explicit outcomes belong to one intervention; correcting a vote replaces it. */
export async function applyFeedback({ kind, signal, conversationId, messageId, commitmentId, preparationId, bubble } = {}) {
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
  const timing = signal === 'wrong_time' || signal === 'good_time'
  if (!timing && !['accepted', 'completed', 'irrelevant', 'incorrect', 'good', 'bad'].includes(signal)) {
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
  const bubbleId = bubble?.id ?? message?.companion?.bubbleId
  if (bubbleId && !bubble && (!message?.companion?.selection || (timing && !message?.companion?.deliveredAt))) {
    const { getBubble } = await import('./companion.mjs')
    bubble = await getBubble(bubbleId)
  }
  const key = interventionKey({ bubbleId, preparationId, conversationId, messageId })
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
    const h = (s.proactive?.history ?? []).find((item) => (messageId && item.messageId === messageId && item.conversationId === conversationId) || (preparationId && item.preparationId === preparationId))
    const linkedConversationId = conv?.id ?? preparation?.delivery?.conversationId ?? h?.conversationId ?? bubble?.conversationId
    const linkedMessageId = message?.id ?? preparation?.delivery?.messageId ?? h?.messageId ?? (bubble?.conversationId ? `m_${bubble.id}` : null)
    const oldKey = interventionKey({ conversationId: linkedConversationId, messageId: linkedMessageId })
    // Older votes were keyed by chat message. Correct a vote from any surface under one ID.
    const previous = { ...(outcomes[oldKey] ?? {}), ...(outcomes[key] ?? {}) }
    if (oldKey && oldKey !== key && outcomes[oldKey]) {
      delete outcomes[oldKey]
      previous.id = key
      outcomes[key] = previous
      s.agency = { ...agency, outcomes }
    }
    if (timing ? previous.timing === signal : previous.utility === signal) {
      const pausedUntil = Date.parse(s.attention?.pausedUntil) > Date.now() ? s.attention.pausedUntil : null
      result = { ...result, duplicate: true, outcome: previous, ...(timing ? { pausedUntil } : {}) }
      return s
    }
    const at = nowIso()
    const reward = ['accepted', 'completed', 'good'].includes(signal) ? 1 : 0
    const selection = bubble?.selection ?? message?.companion?.selection ?? message?.selection ?? h?.selection
    const goal = preparation && (s.commitments ?? []).find((entry) => entry.id === preparation.commitmentId)
    const channel = bubbleId ? 'companion' : 'proactive'
    kind = selection?.kind ?? (bubbleId ? bubble?.scenario ?? message?.companion?.scenario :
      message?.kind ?? h?.kind ?? (preparation ? 'brief' : null))
    const next = {
      ...previous, id: key, conversationId: linkedConversationId ?? previous.conversationId ?? null,
      messageId: linkedMessageId ?? previous.messageId ?? null, commitmentId: commitmentId ?? null,
      preparationId: preparationId ?? null, kind: (bubbleId || KINDS.includes(kind)) ? kind ?? null : previous.kind ?? null,
      channel, anchorId: selection?.anchorId ?? message?.anchorId ?? h?.anchorId ?? commitmentId ?? previous.anchorId ?? null,
      topicKey: selection?.topicKey ?? previous.topicKey ?? contentTopicKey(channel, goal?.title),
      signals: [...new Set([...(previous.signals ?? []), signal])], updatedAt: at,
      ...(timing ? { timing: signal } : { utility: signal, reward, utilityAt: at }),
    }
    const kinds = { ...(agency.kinds ?? {}) }
    if (!timing && channel === 'proactive' && next.kind) {
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
    if (timing) {
      if (!next.utilityAt && previous.utility && previous.updatedAt) next.utilityAt = previous.updatedAt
      if (!next.firstWrongTimeAt && previous.timing === 'wrong_time' && Number.isFinite(Date.parse(previous.updatedAt))) next.firstWrongTimeAt = previous.updatedAt
      if (signal === 'wrong_time' && !Number.isFinite(Date.parse(next.firstWrongTimeAt))) next.firstWrongTimeAt = at
      recordTimingFeedback(s, {
        id: key, signal, previousSignal: previous.timing, firstWrongTimeAt: next.firstWrongTimeAt,
        trigger: bubbleId ? 'companion' : message?.timingTrigger ?? h?.timingTrigger ?? preparation?.delivery?.timingTrigger ?? preparationTrigger(goal, preparation),
        deliveredAt: bubble?.ts ?? message?.companion?.deliveredAt ?? h?.at ?? preparation?.delivery?.deliveredAt ?? (message?.proactive ? message.createdAt : null),
        timeZone: bubble?.deliveryTimeZone ?? message?.deliveryTimeZone ?? h?.deliveryTimeZone ?? preparation?.delivery?.timeZone,
      })
    }
    if (preparation) {
      preparation.outcome = { signal: next.utility ?? 'unknown', timing: next.timing ?? null, at }
      if (!timing && preparation.delivery?.status === 'pending') {
        preparation.delivery = { ...preparation.delivery, status: 'reviewed', reviewedAt: at }
      }
    }
    if (h) h.outcome = { signal: next.utility ?? 'unknown', timing: next.timing ?? null, at }
    result = { ...result, outcome: next, ...(timing ? { pausedUntil: s.attention?.pausedUntil ?? null } : {}) }
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
  const outcomes = Object.fromEntries(['accepted', 'completed', 'wrong_time', 'good_time', 'irrelevant', 'incorrect', 'good', 'bad'].map((k) => [k, 0]))
  for (const outcome of Object.values(state.agency?.outcomes ?? {})) {
    if (outcome.utility in outcomes) outcomes[outcome.utility]++
    if (outcome.timing === 'wrong_time') outcomes.wrong_time++
    if (outcome.timing === 'good_time') outcomes.good_time++
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
    timing: { wrongTime: outcomes.wrong_time, goodTime: outcomes.good_time },
    note: clip('均值只来自明确的有用/无用反馈；完成和采纳属于同一次成功。时机不对单独记录，沉默为未知。', 200),
  }
}
