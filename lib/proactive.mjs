import { domainText } from './domain-language.mjs'
import { languageText } from './language.mjs'
import { P, loadConfig } from './config.mjs'
import { clip, readJSON, nowIso, newId, stripTags } from './util.mjs'
import { jsonTask } from './native.mjs'
import { readObservations } from './memory.mjs'
import { createConversation, getConversation, mutateConversation, MAIN_ID, mutateState } from './store.mjs'
import { macNotify } from './notify.mjs'
import { record } from './metrics.mjs'
import { contentFeedback, settlePending } from './agency.mjs'
import { matchesBlocklist, workingContext } from './screen.mjs'
import { checkAttention, reserveAttention, finishAttention, interventionKeys, localDate, preparationTrigger, effectiveInterruptionPolicy } from './attention.mjs'
import { dreamEvidenceExcerpt, evidenceAgeDays, rankProactiveContent } from './proactive-content.mjs'
import { canDeliverPreparation, pendingPreparations, markPreparationDelivered } from './commitments.mjs'
import { LOOP_FRESH_DAYS, loopAgeDays } from './dream.mjs'
import { getRelationships, relationshipGuidance } from './relationships.mjs'
import { log } from './log.mjs'

export { recordUserEngagement } from './attention.mjs'

const composePrompt = () => domainText('proactive.wordingPrompt')

const QUEUE_TTL_MS = 60 * 60000
let ticking = false

/** Dream 发现的待跟进线索 → 一键接管所需的跟进提案（与候选消息一起送达）。 */
export function followUpProposal(loop) {
  if (!loop?.id || !loop.topic) return null
  const topic = stripTags(loop.topic)
  const why = stripTags(loop.why ?? '')
  const ageDays = loopAgeDays(loop)
  const stale = ageDays !== null && ageDays > LOOP_FRESH_DAYS
  return {
    title: clip(topic, 120),
    // 隔了日子的线索必须把"多久没看过"写在最前面，否则用户会在一条旧推测上按下接管
    successCriteria: clip(domainText('proactive.followUpProposal', stale ? domainText('proactive.staleLead', ageDays) : '', topic, why ? domainText('proactive.background', why) : ''), 400),
    ...(loop.due ? { deadline: loop.due } : {}),
    candidateLoopId: loop.id,
    ...(ageDays === null ? {} : { ageDays }),
    ...(stale ? { stale: true } : {}),
  }
}

function clockLabel() {
  return new Date().toLocaleString(languageText('zh-CN', 'en'), { hour12: false })
}

async function rankAvailable(cfg, state, queue, { allowRequested = true, preview = false } = {}) {
  const [screen, facts, conv] = await Promise.all([
    workingContext(), cfg.memory?.enabled && cfg.memory?.inject !== false ? readObservations() : [], getConversation(MAIN_ID),
  ])
  const recent = (conv?.messages ?? []).filter((message) => message.role === 'user' && Date.parse(message.createdAt) > Date.now() - 14 * 86400000)
    .slice(-3).map((message) => String(message.content ?? '').slice(0, 500)).join(' ')
  const minScore = effectiveInterruptionPolicy(cfg, state, { trigger: 'suggestion' }).effective.minScore
  return rankProactiveContent({ cfg, state, screen, facts, userTopics: recent, minScore, queue, allowRequested, preview })
}

async function planNext(cfg, state, queue, busyConversations, { requireMaterial = true } = {}) {
  const priority = queue.some((item) => item.trigger === 'requested_goal')
  let attention = await checkAttention({ busyConversations, trigger: priority ? 'requested_goal' : 'suggestion' })
  const allowRequested = attention.allow
  if (priority && attention.reason === 'repeated_wrong_time') {
    const other = await checkAttention({ busyConversations, trigger: 'suggestion' })
    if (other.allow) attention = other
  }
  let ranked
  if (attention.allow && requireMaterial) {
    ranked = await rankAvailable(cfg, state, queue, { allowRequested })
    if (priority && !ranked.chosen?.requested && attention.timing.trigger === 'requested_goal' && ranked.chosen) {
      attention = await checkAttention({ busyConversations, trigger: 'suggestion' })
    }
    if (priority && !allowRequested && !ranked.chosen) attention = await checkAttention({ busyConversations, trigger: 'requested_goal' })
  }
  const usedToday = state.proactive?.daily?.date === localDate() ? state.proactive.daily.count ?? 0 : 0
  const gate = { ...attention, usedToday, budget: cfg.proactive.dailyBudget ?? 5, now: { date: localDate(), label: clockLabel() } }
  if (ranked && attention.allow) Object.assign(gate, { allow: Boolean(ranked.chosen), reason: ranked.reason,
    material: ranked.count, selection: ranked.selection })
  return { gate, attention, ranked }
}

export async function proactiveGate({ busyConversations, requireMaterial = true } = {}) {
  const [cfg, state] = await Promise.all([loadConfig(), readJSON(P.state, {})])
  const queue = queueFor(state, await pendingPreparations(state))
  return (await planNext(cfg, state, queue, busyConversations, { requireMaterial })).gate
}

/** On-demand simulation: read the same material and timing rules without reserving, drafting, or delivering. */
export async function proactivePreview({ busyConversations } = {}) {
  const [cfg, state] = await Promise.all([loadConfig(), readJSON(P.state, {})])
  const options = []
  if (cfg.proactive.enabled) {
    const queue = queueFor(state, await pendingPreparations(state))
    const [ranked, suggestion, requested] = await Promise.all([
      rankAvailable(cfg, state, queue, { preview: true }), checkAttention({ busyConversations }),
      queue.some((item) => item.trigger === 'requested_goal') ? checkAttention({ trigger: 'requested_goal', busyConversations }) : null,
    ])
    for (const item of ranked.options) {
      const timing = item.requested ? requested : suggestion
      const reason = item.reason === 'ok' && timing && !timing.allow ? timing.reason : item.reason
      const { topicKey, label, score, reasons, source } = item.selection
      options.push({ topicKey, label, score, reasons, source, reason, requested: item.requested, contentEligible: item.reason === 'ok' })
    }
    options.sort((a, b) => Number(b.reason === 'ok') - Number(a.reason === 'ok') || Number(b.contentEligible) - Number(a.contentEligible))
  }
  const labels = new Map(options.map((item) => [item.topicKey, item.label]))
  const muted = Object.entries(state.agency?.mutedTopics ?? {}).map(([topicKey, entry]) => ({
    topicKey, addedAt: entry.addedAt, label: labels.get(topicKey) ?? entry.label ?? domainText('proactive.sourceMissing'),
  }))
  return { enabled: cfg.proactive.enabled, items: options.slice(0, 3), muted }
}

const HOLD_TEXT = {
  get topic_muted() { return domainText('proactive.topicMuted') },
  get below_threshold() { return domainText('proactive.belowThreshold') }, get feedback_suppressed() { return domainText('proactive.unhelpful') },
  get unchanged_evidence() { return domainText('proactive.unchangedEvidence') }, get unchanged_context() { return domainText('proactive.unchangedContext') },
  get no_material() { return domainText('proactive.noMaterial') }, get composer_abstained() { return domainText('proactive.noWording') },
  get empty_message() { return domainText('proactive.invalidWording') }, get composer_error() { return domainText('proactive.wordingFailed') },
  get duplicate() { return domainText('proactive.delivered') },
  get unsupported_evidence() { return domainText('proactive.unsupportedQuote') },
}

async function noteSelection({ selection, act, reason, code, wording = null, cooldown = false }) {
  await mutateState((state) => {
    const proactive = state.proactive ??= {}
    proactive.lastCheckAt = nowIso()
    proactive.lastDecision = { policy: 'local', act, reason, code, selection, wording }
    if (cooldown && selection?.materialKey) {
      const now = Date.now()
      const kept = (proactive.composerAttempts ?? []).filter((entry) => Date.parse(entry.until) > now && entry.key !== selection.materialKey)
      proactive.composerAttempts = [...kept.slice(-23), { key: selection.materialKey, until: new Date(now + (wording === 'error' ? 5 : 180) * 60000).toISOString() }]
    }
  })
}

function queueFor(state, preparations, allocate = false) {
  const now = Date.now()
  const existing = (state.proactive?.queue ?? []).filter((item) => Date.parse(item.expiresAt) > now)
  const queue = existing.filter((item) => !item.preparationId).map((item) => ({ ...item, trigger: 'suggestion' }))
  for (const p of preparations) {
    if (!p.verification?.passed) continue
    const goal = (state.commitments ?? []).find((item) => item.id === p.commitmentId)
    if (!goal) continue
    const old = existing.find((item) => item.preparationId === p.id)
    const milestone = p.milestone ? `${languageText('（', ' (')}${String(p.milestone).endsWith(':today') ? domainText('proactive.dueToday') : String(p.milestone).endsWith(':overdue') ? domainText('proactive.overdue') : domainText('proactive.nearDue')}${languageText('）', ')')}` : ''
    const assessment = p.deadlineAssessment
    const uncertainty = assessment && !['verified', 'supported'].includes(assessment.status) ? domainText('proactive.unverified') : ''
    const source = (p.evidence ?? []).find((e) => /^https?:\/\//i.test(e.source ?? ''))
    const content = domainText('proactive.prepared', p.title, milestone, uncertainty, clip(p.content, 480), p.question ? domainText('proactive.openQuestions', clip(p.question, 240)) : '', source ? domainText('proactive.sources', source.source) : '')
    const anchorId = p.commitmentId
    queue.push({ id: old?.id ?? (allocate ? newId('candidate') : p.id), messageId: old?.messageId ?? (allocate ? newId('m') : null),
      kind: 'brief', content, anchorId, commitmentId: anchorId, preparationId: p.id, evidence: p.evidence ?? [],
      trigger: preparationTrigger(goal, p), createdAt: p.createdAt, expiresAt: p.delivery.expiresAt, deferredReason: old?.deferredReason,
      ...interventionKeys({ content, anchorId: `${anchorId}@${p.revision ?? 1}${p.milestone ? ':' + p.milestone : ''}`, evidence: p.evidence }),
    })
  }
  return queue
}

async function refreshQueue() {
  let queue
  const state = await mutateState(async (s) => {
    queue = queueFor(s, await pendingPreparations(s), true)
    s.proactive = { ...(s.proactive ?? {}), queue }
  })
  return { state, queue }
}

async function removeCandidate(id) {
  await mutateState((s) => {
    s.proactive = { ...(s.proactive ?? {}), queue: (s.proactive?.queue ?? []).filter((c) => c.id !== id) }
    return s
  })
}

async function deferCandidate(id, reason) {
  await mutateState((s) => {
    const candidate = (s.proactive?.queue ?? []).find((c) => c.id === id)
    if (candidate) candidate.deferredReason = reason
    return s
  })
  return { acted: false, skipped: reason, queued: true }
}

async function deliverCandidate(candidate, busyConversations) {
  const cfg = await loadConfig()
  if (!cfg.proactive?.enabled) return deferCandidate(candidate.id, 'disabled')
  if (Date.parse(candidate.expiresAt) <= Date.now()) {
    await removeCandidate(candidate.id)
    return { acted: false, skipped: 'expired' }
  }
  if (candidate.preparationId && !(await pendingPreparations()).some((p) => p.id === candidate.preparationId)) {
    await removeCandidate(candidate.id)
    return { acted: false, skipped: 'stale_preparation' }
  }
  const hold = await contentHold(candidate)
  if (hold) {
    if (hold !== 'stale_evidence') return deferCandidate(candidate.id, hold)
    await removeCandidate(candidate.id)
    return { acted: false, skipped: hold }
  }
  await createConversation({ isMain: true, title: domainText('proactive.mainChat') })
  const existing = (await getConversation(MAIN_ID))?.messages?.find((m) => m.id === candidate.messageId)
  if (existing) {
    if (candidate.preparationId) await markPreparationDelivered(candidate.preparationId, { conversationId: MAIN_ID,
      messageId: existing.id, deliveredAt: existing.createdAt, timingTrigger: existing.timingTrigger, deliveryTimeZone: existing.deliveryTimeZone })
    await removeCandidate(candidate.id)
    return { acted: false, skipped: 'already_delivered' }
  }
  // Model calls and queued waits can outlive a focus/permission change. Reserve at the last moment.
  const reservation = await reserveAttention({ channel: 'proactive', busyConversations, ...candidate })
  if (!reservation.allow) {
    if (['duplicate', 'unchanged_evidence', 'expired'].includes(reservation.reason)) {
      await removeCandidate(candidate.id)
      if (candidate.preparationId) await mutateState((s) => {
        const p = (s.preparations ?? []).find((item) => item.id === candidate.preparationId)
        if (p?.delivery?.status === 'pending') p.delivery = { ...p.delivery, status: 'superseded', reason: reservation.reason }
        return s
      })
    }
    else return deferCandidate(candidate.id, reservation.reason)
    return { acted: false, skipped: reservation.reason }
  }
  const followNote = candidate.followUp
    ? domainText('proactive.addFollowUp', candidate.followUp.stale ? domainText('proactive.staleProposal', candidate.followUp.ageDays) : '')
    : ''
  const msg = {
    id: candidate.messageId, role: 'assistant',
    content: candidate.followUp ? `${candidate.content}\n\n${followNote}` : candidate.content,
    proactive: true, timingTrigger: reservation.timing.trigger,
    kind: candidate.kind, anchorId: candidate.anchorId ?? null, commitmentId: candidate.commitmentId ?? null,
    preparationId: candidate.preparationId ?? null, evidence: candidate.evidence ?? [],
    selection: candidate.selection, confidence: candidate.selection ? undefined : candidate.confidence, reason: candidate.reason, model: candidate.model ?? 'prepared',
    usage: candidate.usage ?? null,
    ...(candidate.followUp ? { followUp: candidate.followUp } : {}),
  }
  let appended = false
  let blocked = null
  try {
    const conv = await mutateConversation(MAIN_ID, async (c) => {
      const finalGate = await checkAttention({ channel: 'proactive', busyConversations, ...candidate, reservationToken: reservation.token })
      if (!finalGate.allow) {
        blocked = finalGate.reason
        return c
      }
      blocked = await contentHold(candidate)
      if (blocked) return c
      if (!c.messages.some((m) => m.id === msg.id)) {
        msg.createdAt = nowIso()
        msg.deliveryTimeZone = finalGate.timing.timeZone
        c.messages.push(msg)
        c.unread = (c.unread ?? 0) + 1
        appended = true
      }
    })
    if (!conv) throw new Error(domainText('proactive.mainUnavailable'))
    if (blocked) {
      await finishAttention(reservation.token, { delivered: false })
      if (blocked === 'stale_evidence') {
        await removeCandidate(candidate.id)
        return { acted: false, skipped: blocked }
      }
      return deferCandidate(candidate.id, blocked)
    }
    if (candidate.preparationId) {
      const delivered = await markPreparationDelivered(candidate.preparationId, { conversationId: MAIN_ID,
        messageId: msg.id, deliveredAt: msg.createdAt, timingTrigger: msg.timingTrigger, deliveryTimeZone: msg.deliveryTimeZone })
      if (!delivered) {
        await mutateConversation(MAIN_ID, (c) => {
          c.messages = c.messages.filter((m) => m.id !== msg.id)
          c.unread = Math.max(0, (c.unread ?? 0) - Number(appended))
        })
        await finishAttention(reservation.token, { delivered: false })
        await removeCandidate(candidate.id)
        return { acted: false, skipped: 'stale_preparation' }
      }
    }
    let dailyCount = 0
    await mutateState((s) => {
      const p = s.proactive ?? {}
      const date = localDate()
      dailyCount = (p.daily?.date === date ? p.daily.count ?? 0 : 0) + 1
      s.proactive = {
        ...p, lastAt: msg.createdAt,
        ...(candidate.selection ? { lastCheckAt: msg.createdAt, lastDecision: { policy: 'local', act: true,
          selection: candidate.selection, reason: candidate.reason, wording: candidate.preparationId ? 'prepared' : 'drafted' } } : {}),
        daily: { date, count: dailyCount }, consecutiveIgnores: 0,
        queue: (p.queue ?? []).filter((c) => c.id !== candidate.id),
        history: [...(p.history ?? []).slice(-99), {
          at: msg.createdAt, messageId: msg.id, conversationId: MAIN_ID, kind: msg.kind, anchorId: msg.anchorId,
          timingTrigger: msg.timingTrigger, deliveryTimeZone: msg.deliveryTimeZone,
          commitmentId: msg.commitmentId, preparationId: msg.preparationId, message: msg.content,
          selection: msg.selection, confidence: msg.confidence, outcome: { signal: 'unknown' },
        }],
      }
      const loop = (s.dream?.loops ?? []).find((l) => l.id === msg.anchorId)
      if (loop) loop.raised = (loop.raised ?? 0) + 1
      return s
    })
    await finishAttention(reservation.token)
    if (cfg.proactive.notify !== false) macNotify(domainText('proactive.notification'), msg.content.replace(/\s+/g, ' ').slice(0, 120))
    record({ kind: 'proactive', acted: true, kindOf: msg.kind, confidence: msg.confidence, anchorId: msg.anchorId, chars: msg.content.length })
    return { acted: true, message: msg, daily: dailyCount }
  } catch (err) {
    // A committed message keeps its attention charge; recovery uses its stable message id.
    await finishAttention(reservation.token, { delivered: appended })
    throw err
  }
}

async function contentHold(candidate) {
  if (candidate.preparationId && candidate.trigger === 'requested_goal') return null
  const [cfg, state] = await Promise.all([loadConfig(), readJSON(P.state, {})])
  const selection = candidate.selection
  if (state.agency?.mutedTopics?.[selection?.topicKey]) return 'topic_muted'
  const pref = contentFeedback(state, selection ?? { kind: candidate.kind, anchorId: candidate.anchorId })
  if (pref.dismissed) return 'feedback_suppressed'
  const adjusted = selection?.baseScore + pref.kindAdjustment + pref.topicAdjustment
  if (Number.isFinite(adjusted) && Number(adjusted.toFixed(3)) < effectiveInterruptionPolicy(cfg, state).effective.minScore) return 'below_threshold'
  if (!candidate.preparationId && !(await evidenceStillCurrent(candidate.evidence ?? [], candidate, cfg, state))) return 'stale_evidence'
  return null
}

function matchesDreamEvidence(evidence, item, kind) {
  const canonical = dreamEvidenceExcerpt(item, kind, 'zh-CN')
  return evidence.excerpt === canonical || evidence.excerpt === dreamEvidenceExcerpt(item, kind, 'en')
}

async function evidenceStillCurrent(evidence, candidate, cfg, state) {
  if (!evidence.length) return false
  const usesMemory = evidence.some((e) => e.origin === 'memory')
  if (usesMemory && (!cfg.memory?.enabled || cfg.memory.inject === false)) return false
  const screen = evidence.some((e) => e.source?.startsWith('screen:') && e.origin !== 'memory') ? await workingContext() : {}
  const observations = usesMemory ? await readObservations() : []
  const goals = state.commitments ?? []
  return evidence.every((e) => {
    if (e.origin === 'memory') return observations.some((o) => o.id === e.id && o.status === 'active' &&
      ['project', 'reference'].includes(o.kind) && evidenceAgeDays(o.last_seen ?? o.created_at) <= 30 && o.text === e.excerpt)
    if (e.source?.startsWith('dream:')) {
      if (goals.some((goal) => goal.candidateLoopId === e.id)) return false
      const loop = (state.dream?.loops ?? []).find((l) => l.id === e.id && l.status !== 'done')
      if (loop) return (loop.status === 'waiting_user' ? 'ask' : 'follow_up') === (candidate.selection?.kind ?? candidate.kind) &&
        Math.floor(evidenceAgeDays(loop.touched_at ?? loop.opened_at ?? state.dream.at)) <= LOOP_FRESH_DAYS && matchesDreamEvidence(e, loop, 'loop')
      const nudge = (state.dream?.nudges ?? []).find((n) => n.id === e.id)
      return nudge && evidenceAgeDays(nudge.at ?? state.dream.at) <= 7 && matchesDreamEvidence(e, nudge, 'nudge')
    }
    if (e.source?.startsWith('screen:')) {
      const current = screen.evidence?.at(-1)
      return cfg.screen?.enabled && screen.freshness === 'fresh' && current?.id === e.id && current.excerpt === e.excerpt &&
        !matchesBlocklist(cfg, { app: screen.app, text: current.excerpt })
    }
    return false
  })
}

/** Prepare first, then independently check whether it is appropriate to deliver. */
export async function proactiveTick({ busyConversations = new Set() } = {}) {
  if (ticking) return { acted: false, skipped: 'tick_running' }
  ticking = true
  try {
    await settlePending()
    const { queue, state } = await refreshQueue()
    const cfg = await loadConfig()
    const { gate, ranked } = await planNext(cfg, state, queue, busyConversations)
    if (ranked?.staleQueueIds.length) await mutateState((s) => {
      s.proactive.queue = s.proactive.queue.filter((item) => !ranked.staleQueueIds.includes(item.id))
    })
    if (!gate.allow) {
      if (ranked && !ranked.chosen) await noteSelection({ selection: ranked.selection, act: false, reason: HOLD_TEXT[ranked.reason], code: ranked.reason })
      const held = ranked?.chosen?.candidate ?? queue.find((item) => !ranked?.staleQueueIds.includes(item.id))
      return held ? deferCandidate(held.id, gate.reason) : { acted: false, skipped: gate.reason }
    }
    const chosen = ranked.chosen
    if (chosen.candidate) return await deliverCandidate(chosen.candidate, busyConversations)
    const { selection, evidence } = chosen
    const latest = await loadConfig()
    const profile = latest.memory?.enabled && latest.memory?.inject !== false
      ? (await getRelationships()).profile : { enabled: false }
    const hold = await contentHold(chosen)
    if (hold) return { acted: false, skipped: hold }
    const preflight = await checkAttention({ channel: 'proactive', busyConversations, anchorKey: chosen.anchorKey })
    if (!preflight.allow) return { acted: false, skipped: preflight.reason }
    let out
    try {
      out = await jsonTask({
        system: composePrompt() + '\n\n' + relationshipGuidance(profile, { background: true }),
        user: JSON.stringify({ anchorId: selection.anchorId, source: selection.source, kind: selection.kind, topic: selection.label, evidence: evidence.map((e) => ({
          label: e.label, observedAt: e.observedAt, excerpt: String(e.excerpt).slice(0, 900),
        })) }),
        model: latest.upstream.defaultModel, maxTokens: 240, temperature: 0.4, timeoutMs: 60000,
      })
    } catch {
      const held = await contentHold(chosen)
      if (held) return { acted: false, skipped: held }
      await noteSelection({ selection, act: true, reason: HOLD_TEXT.composer_error, code: 'composer_error', wording: 'error', cooldown: true })
      record({ kind: 'proactive', acted: false, wording: 'error', skipped: 'composer_error' })
      return { acted: false, skipped: 'composer_error' }
    }
    const after = await contentHold(chosen)
    if (after === 'stale_evidence' || after === 'topic_muted') return { acted: false, skipped: after }
    const body = out.json
    const abstained = body?.message === null || body?.message === ''
    const content = typeof body?.message === 'string' ? stripTags(body.message).trim() : ''
    const quote = typeof body?.quote === 'string' ? body.quote.trim() : ''
    const supported = quote.length <= 100 && (/[\u3400-\u9fff]{2}/u.test(quote) || /[\p{L}\p{N}]{3}/u.test(quote)) &&
      (selection.source === 'screen' || content.includes(quote)) && evidence.some((item) => String(item.excerpt).slice(0, 900).includes(quote))
    if (abstained || content.length < 6 || content.length > 900 || !supported) {
      const skipped = abstained ? 'composer_abstained' : content.length < 6 || content.length > 900 ? 'empty_message' : 'unsupported_evidence'
      await noteSelection({ selection, act: true, reason: HOLD_TEXT[skipped], code: skipped, wording: abstained ? 'abstained' : 'unusable', cooldown: true })
      record({ kind: 'proactive', acted: false, wording: abstained ? 'abstained' : 'unusable', skipped, usage: out.usage ?? null })
      return { acted: false, skipped }
    }
    const reason = selection.reasons.join(languageText('；', '; '))
    await noteSelection({ selection, act: true, reason, wording: 'drafted' })
    const followUp = chosen.loop ? followUpProposal(chosen.loop) : null
    const candidate = {
      id: newId('candidate'), messageId: newId('m'), content, kind: selection.kind, selection,
      anchorId: selection.anchorId, evidence, reason, createdAt: nowIso(),
      expiresAt: new Date(Date.now() + (selection.source === 'screen' ? 5 * 60000 : QUEUE_TTL_MS)).toISOString(),
      model: latest.upstream.defaultModel, usage: out.usage ?? null, ...(followUp ? { followUp } : {}),
      ...interventionKeys({ content }), anchorKey: chosen.anchorKey,
    }
    await mutateState((s) => {
      s.proactive = { ...(s.proactive ?? {}), queue: [...(s.proactive?.queue ?? []), candidate].slice(-8) }
      return s
    })
    return await deliverCandidate(candidate, busyConversations)
  } catch (err) {
    log.warn(domainText('proactive.failed'), err.message)
    return { acted: false, skipped: 'error', error: err.message }
  } finally {
    ticking = false
  }
}

async function publicTimeline(cfg, state, liveMaterial) {
  const p = state.proactive ?? {}
  const history = (p.history ?? []).slice(-8)
  const selections = [p.lastDecision, ...history].map((row) => row?.selection).filter(Boolean)
  if (!liveMaterial && selections.some((entry) => entry.source !== 'preparation')) {
    const memoryIds = new Set(selections.filter((entry) => entry.source === 'memory').map((entry) => entry.anchorId))
    const [facts, screen] = await Promise.all([
      memoryIds.size && cfg.memory?.enabled && cfg.memory?.inject !== false ? readObservations() : [],
      selections.some((entry) => entry.source === 'screen') && cfg.screen?.enabled ? workingContext() : {},
    ])
    liveMaterial = rankProactiveContent({ cfg, state, facts: facts.filter((fact) => memoryIds.has(fact.id)), screen,
      userTopics: selections.filter((entry) => entry.source === 'memory').map((entry) => entry.label).join(' '),
    }).liveMaterial
  }
  const visible = (selection) => {
    if (!selection) return false
    if (selection.source !== 'preparation') return liveMaterial?.has(selection.materialKey)
    const artifact = state.preparations?.find((item) => item.id === selection.preparationId)
    const goal = state.commitments?.find((item) => item.id === selection.anchorId)
    return artifact && canDeliverPreparation(goal, artifact, cfg)
  }
  const redact = (selection) => selection && { ...selection, label: domainText('proactive.sourceUnavailable') }
  let lastDecision = p.lastDecision ?? null
  if (lastDecision?.selection && !visible(lastDecision.selection)) lastDecision = { ...lastDecision, selection: redact(lastDecision.selection) }
  return { lastDecision, history: history.map((row) => visible(row.selection) ? row : {
    ...row, selection: redact(row.selection), message: domainText('proactive.deliveredInChat'),
  }) }
}

export async function proactiveStatus({ busyConversations } = {}) {
  const cfg = await loadConfig()
  const state = await readJSON(P.state, {})
  const p = state.proactive ?? {}
  const queue = queueFor(state, await pendingPreparations(state))
  const { gate: nextGate, attention, ranked } = await planNext(cfg, state, queue, busyConversations)
  const timeline = await publicTimeline(cfg, state, ranked?.liveMaterial)
  return {
    enabled: cfg.proactive.enabled, lastAt: p.lastAt ?? null, lastCheckAt: p.lastCheckAt ?? null,
    ...timeline, todayCount: p.daily?.date === localDate() ? p.daily.count ?? 0 : 0,
    budget: cfg.proactive.dailyBudget, minGapMinutes: cfg.proactive.minGapMinutes, consecutiveIgnores: 0,
    nextGate, attention,
    queue: queue.filter((item) => !ranked?.staleQueueIds.includes(item.id)).map((item) => ({
      id: item.id, messageId: item.messageId, preparationId: item.preparationId, expiresAt: item.expiresAt, deferredReason: item.deferredReason,
    })),
    quietHours: cfg.proactive.quietHours,
  }
}

export async function setProactiveEnabled(enabled) {
  const { saveConfig } = await import('./config.mjs')
  await saveConfig({ proactive: { enabled: Boolean(enabled) } })
  return enabled
}
