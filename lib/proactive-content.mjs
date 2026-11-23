import { createHash } from 'node:crypto'
import { contentFeedback, contentFeedbackIndex, contentTopicKey } from './agency.mjs'
import { interventionKeys } from './attention.mjs'
import { LOOP_FRESH_DAYS } from './dream.mjs'
import { deadlineMilestone } from './deadlines.mjs'
import { matchesBlocklist } from './screen.mjs'
import { tokenize } from './util.mjs'

const DAY = 86400000
const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const scoreOf = (value) => Number(Math.min(1, Math.max(0, value)).toFixed(3))
const decreasingScore = (a, b) => b.selection.score - a.selection.score ||
  (a.selection.anchorId < b.selection.anchorId ? -1 : a.selection.anchorId > b.selection.anchorId ? 1 : 0)

export function evidenceAgeDays(value, now = Date.now()) {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00') : Date.parse(value)
  return Number.isFinite(at) && at <= now + 30000 ? Math.max(0, (now - at) / DAY) : Infinity
}

function usefulTokens(value) {
  return new Set(tokenize(value).filter((token) => token.length >= 2 && !['the', 'this', 'that', 'and', 'for', 'with', '之前', '一个', '可以', '需要'].includes(token)))
}

function overlaps(text, observed) {
  const tokens = usefulTokens(text)
  let matches = 0
  for (const token of tokens) if (observed.has(token)) matches++
  return matches >= Math.min(2, Math.max(1, tokens.size)) && matches / tokens.size >= 0.2
}

function scoreMaterial(state, { source, anchorId, kind, label, topic, base, reasons, now }, feedback) {
  const topicKey = contentTopicKey('proactive', topic ?? label)
  const preference = contentFeedback(state, { anchorId, topicKey, kind, now }, feedback)
  if (preference.kindAdjustment) reasons.push(preference.kindAdjustment > 0 ? '你曾肯定这类提醒' : '你曾认为这类提醒帮助有限')
  if (preference.topicAdjustment) reasons.push(preference.topicAdjustment > 0 ? '你曾肯定这个话题' : '你曾认为这个话题帮助有限')
  const selection = { source, anchorId, kind, topicKey, label: String(label).slice(0, 160),
    baseScore: base, score: scoreOf(base + preference.kindAdjustment + preference.topicAdjustment), reasons }
  return { selection, dismissed: preference.dismissed }
}

function preparationContent(state, goal, artifact, trigger, now, feedback) {
  const requested = trigger === 'requested_goal'
  const due = Boolean(artifact.milestone || artifact.trigger === 'deadline_approaching' || deadlineMilestone(goal, new Date(now)))
  const label = goal.title || artifact.title
  if (requested) return { dismissed: false, selection: {
    source: 'preparation', anchorId: goal.id, preparationId: artifact.id, topicKey: contentTopicKey('proactive', label),
    kind: 'brief', label, score: due ? 1 : 0.96, reasons: ['你要求准备或跟进此事', ...(due ? ['已到截止节点'] : [])],
  } }
  const result = scoreMaterial(state, { source: 'preparation', anchorId: goal.id, kind: 'brief', label,
    base: due ? 0.77 : 0.72, reasons: ['已有准备结果', ...(due ? ['已到截止节点'] : [])], now }, feedback)
  result.selection.preparationId = artifact.id
  return result
}

/** Rank observed material locally. Only one selected passage can reach the wording model. */
export function rankProactiveContent({ cfg, state, facts = [], screen = {}, userTopics = '', queue = [], allowRequested = true, now = Date.now(), minScore = 0.62, preview = false }) {
  const items = []
  const feedback = contentFeedbackIndex(state, { now })
  const observed = usefulTokens(userTopics)
  const goals = state.commitments ?? []
  const tracked = new Set(goals.map((goal) => goal.candidateLoopId).filter(Boolean))
  const goalTopics = new Set(goals.map((goal) => normalize(goal.title)).filter(Boolean))
  function add({ source, anchorId, kind, label, base, reasons, evidence, loop }) {
    if (!anchorId || !label?.trim() || !evidence.excerpt?.trim() || goalTopics.has(normalize(label))) return
    if (overlaps(label, observed)) { base += 0.08; reasons.push('与你近期聊过的内容相关') }
    const result = scoreMaterial(state, { source, anchorId, kind, label, base, reasons, now }, feedback)
    const materialKey = createHash('sha256').update(result.selection.topicKey + ':' + normalize(evidence.excerpt)).digest('hex').slice(0, 24)
    result.selection.materialKey = materialKey
    items.push({ ...result, evidence: [evidence], loop, ...interventionKeys({ anchorId, evidence: [evidence] }) })
  }
  for (const loop of state.dream?.loops ?? []) {
    const observedAt = loop.touched_at ?? loop.opened_at ?? state.dream.at
    const age = evidenceAgeDays(observedAt, now)
    if (loop.status === 'done' || tracked.has(loop.id) || Math.floor(age) > LOOP_FRESH_DAYS || !loop.why?.trim()) continue
    const remaining = Date.parse(loop.due + 'T23:59:59') - now
    const near = remaining >= -DAY && remaining <= 3 * DAY
    const confidence = Number.isFinite(loop.confidence) ? Math.max(0, Math.min(1, loop.confidence)) : 0.6
    add({ source: 'loop', kind: loop.status === 'waiting_user' ? 'ask' : 'follow_up', anchorId: loop.id, label: loop.topic, loop,
      base: 0.53 + 0.17 * confidence + (age <= 2 ? 0.045 : 0) + (near ? 0.12 : 0) - Math.min(0.18, (loop.raised ?? 0) * 0.04),
      reasons: ['有依据的待确认事项', ...(near ? ['临近所列截止日期'] : [])],
      evidence: { id: loop.id, label: 'Dream 推测，尚未授权', source: 'dream:' + loop.id, observedAt, excerpt: loop.topic + '；' + loop.why + '；截止 ' + (loop.due ?? '未知') } })
  }
  for (const nudge of state.dream?.nudges ?? []) {
    const observedAt = nudge.at ?? state.dream.at
    if (evidenceAgeDays(observedAt, now) > 7 || !(nudge.why || nudge.angle)?.trim()) continue
    const urgency = Number.isFinite(nudge.urgency) ? Math.min(5, Math.max(1, nudge.urgency)) : 3
    add({ source: 'nudge', anchorId: nudge.id, kind: 'suggest', label: nudge.topic, base: 0.52 + urgency * 0.036,
      reasons: ['近期整理出的候选话题', ...(urgency >= 4 ? ['记录标为较紧迫'] : [])],
      evidence: { id: nudge.id, label: '候选话题', source: 'dream:' + nudge.id, observedAt, excerpt: nudge.topic + '；' + (nudge.why || nudge.angle) } })
  }
  if (cfg.memory?.enabled && cfg.memory?.inject !== false) for (const fact of facts) {
    const observedAt = fact.last_seen ?? fact.created_at
    if (fact.status !== 'active' || !['project', 'reference'].includes(fact.kind) || evidenceAgeDays(observedAt, now) > 30) continue
    if (fact.kind === 'reference' && !overlaps(fact.text, observed)) continue
    add({ source: 'memory', anchorId: fact.id, kind: fact.kind === 'project' ? 'follow_up' : 'guide', label: fact.text,
      base: 0.52 + Math.min(5, Math.max(0, Number(fact.importance) || 0)) * 0.032, reasons: ['近期的项目或参考资料'],
      evidence: { id: fact.id, origin: 'memory', label: '记忆', source: fact.source || 'memory:' + fact.id, observedAt, excerpt: fact.text } })
  }
  const frame = screen.evidence?.at(-1)
  if (cfg.screen?.enabled && screen.freshness === 'fresh' && frame &&
    !matchesBlocklist(cfg, { app: screen.app, text: frame.excerpt }) && /失败|报错|截止|遇到问题|\b(error|failed|blocked|deadline)\b/i.test(frame.excerpt)) {
    add({ source: 'screen', anchorId: frame.id, kind: 'guide', label: frame.excerpt, base: 0.64, reasons: ['当前屏幕记录有具体问题或截止提示'], evidence: frame })
  }

  const history = (state.attention?.history ?? []).filter((item) => item && (item.status !== 'reserved' || now - Date.parse(item.at) < 60000))
  const delivered = new Set(history.map((item) => item.anchorKey).filter(Boolean))
  const fingerprints = new Set(history.map((item) => item.fingerprint).filter(Boolean))
  const priorMaterial = new Set((state.proactive?.history ?? []).map((item) => item.selection?.materialKey))
  const abstained = new Set((state.proactive?.composerAttempts ?? []).filter((item) => Date.parse(item.until) > now).map((item) => item.key))
  // Reuse a saved draft only when its source still matches a current eligible item.
  const byAnchor = new Map(items.map((item) => [item.selection.anchorId, item]))
  const liveMaterial = new Set(items.map((item) => item.selection.materialKey))
  const staleQueueIds = []
  for (const candidate of queue) {
    if (candidate.preparationId) {
      if (candidate.trigger === 'requested_goal' && !allowRequested) continue
      const goal = goals.find((goal) => goal.id === candidate.commitmentId)
      const artifact = (state.preparations ?? []).find((prep) => prep.id === candidate.preparationId)
      if (!goal || !artifact) continue
      const result = preparationContent(state, goal, artifact, candidate.trigger, now, feedback)
      items.push({ ...result, candidate: { ...candidate, selection: result.selection, reason: result.selection.reasons.join('；') },
        anchorKey: candidate.anchorKey, requested: candidate.trigger === 'requested_goal' })
      continue
    }
    const live = byAnchor.get(candidate.anchorId)
    const key = interventionKeys({ anchorId: candidate.anchorId, evidence: candidate.evidence ?? [] }).anchorKey
    if (!live || key !== live.anchorKey || candidate.kind !== live.selection.kind ||
      (candidate.selection && candidate.selection.materialKey !== live.selection.materialKey)) { staleQueueIds.push(candidate.id); continue }
    live.candidate ??= { ...candidate, trigger: 'suggestion', ...interventionKeys({ content: candidate.content, anchorId: candidate.anchorId, evidence: live.evidence }),
      evidence: live.evidence, selection: live.selection, reason: live.selection.reasons.join('；') }
  }
  // Tie order does not depend on file order, wall-clock IDs generated for the queue, or a model.
  const ranked = items.sort((a, b) => Number(Boolean(b.requested)) - Number(Boolean(a.requested)) || decreasingScore(a, b) ||
    String(a.candidate?.preparationId ?? '').localeCompare(String(b.candidate?.preparationId ?? '')))
  let bestHeld, chosen
  const options = []
  for (const item of ranked) {
    let reason = null
    if (!item.requested && state.agency?.mutedTopics?.[item.selection.topicKey]) reason = 'topic_muted'
    else if (item.dismissed) reason = 'feedback_suppressed'
    else if (item.candidate?.fingerprint && fingerprints.has(item.candidate.fingerprint)) reason = 'duplicate'
    else if (delivered.has(item.anchorKey) || (item.selection.materialKey && priorMaterial.has(item.selection.materialKey))) reason = 'unchanged_evidence'
    else if (abstained.has(item.selection.materialKey)) reason = 'unchanged_context'
    else if (!item.requested && item.selection.score < minScore) reason = 'below_threshold'
    if (preview) options.push({ selection: item.selection, reason: reason ?? 'ok', requested: Boolean(item.requested) })
    if (!reason) {
      chosen ??= item
      if (!preview) break
    } else bestHeld ??= { reason, selection: item.selection }
  }
  const decision = chosen ? { reason: 'ok', selection: chosen.selection } : bestHeld ?? { reason: 'no_material', selection: null }
  return { chosen: chosen ?? null, liveMaterial, staleQueueIds, count: ranked.length, options, ...decision }
}
