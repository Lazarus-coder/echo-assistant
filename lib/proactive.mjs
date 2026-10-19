import { P, loadConfig } from './config.mjs'
import { clip, readJSON, nowIso } from './util.mjs'
import { jsonTask } from './native.mjs'
import { loadCore, retrieve } from './memory.mjs'
import { createConversation, getConversation, saveConversation, MAIN_ID, mutateState } from './store.mjs'
import { newId } from './util.mjs'
import { macNotify } from './notify.mjs'
import { record } from './metrics.mjs'
import { pickKind, thresholdFor, pickLoop, updateKind, settlePending } from './agency.mjs'
import { log } from './log.mjs'

const DECIDE_SYSTEM = `你是私人助手的主动服务（proactive agent）决策核心。此刻用户没有提问，你要判断"现在是否值得主动开口"。

判断原则（参考业界 proactive agent 的中断成本模型）：
- 只有当你能提供明确的当下价值才开口：跟进用户自己提过的项目/截止日期、提醒会过期的安排、就用户说要做但没做的事问一句进展、给出他此刻用得上的具体建议。
- 不要为了刷存在感发消息；不要重复刚说过的话；不要发通用鸡汤、天气播报、"有什么可以帮你"这类空话。
- 用户最近没回复你的主动消息 → 说明现在不合适，倾向 act=false。
- 深夜/清晨/工作时间要体谅：不合适就 act=false。
- 你能看到用户最近的屏幕活动（本地 OCR 摘要）。用它判断时机：正在深度专注（deep）编码/写作、或正在会议（meeting）时不要打扰，除非确实紧急；如果看到他正在查某件事、遇到问题、或刚做完一段工作，这时插话的价值最高。
- 不要说出"我看到你的屏幕"这类话，也不要复述他屏幕上的细节；自然地体现你懂他此刻在忙什么。
- message 用口语中文，1–3 句，最多一个问句，带上你判断的依据（比如"你周一说这周要交 X"）。不要客套开场，不要签名，不要用 markdown 标题。
- 若某个跟进事项或话题确实相关，把它的 id 放进 anchor_id。`

const DAYPART = (h) => (h < 5 ? '凌晨' : h < 11 ? '早上' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜')

function localParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]))
  const hour = Number(parts.hour === '24' ? '00' : parts.hour)
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour,
    minute: Number(parts.minute),
    label: `${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${String(hour).padStart(2, '0')}:${parts.minute}`,
    daypart: DAYPART(hour),
    minutes: hour * 60 + Number(parts.minute),
  }
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm ?? '00:00').split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

function inQuietHours(now, quiet) {
  if (!quiet?.start || !quiet?.end) return false
  const s = toMinutes(quiet.start)
  const e = toMinutes(quiet.end)
  return s <= e ? now.minutes >= s || now.minutes < e : now.minutes >= s || now.minutes < e
}

const isSameLocalDay = (iso, dateStr) => {
  if (!iso) return false
  return localParts(new Date(iso)).date === dateStr
}

export async function proactiveGate({ busyConversations = new Set() } = {}) {
  const cfg = await loadConfig()
  const state = await readJSON(P.state, {})
  const now = localParts()
  const p = state?.proactive ?? {}
  const pcfg = cfg.proactive ?? {}
  if (!pcfg.enabled) return { allow: false, reason: 'disabled' }
  if (inQuietHours(now, pcfg.quietHours)) return { allow: false, reason: 'quiet_hours' }
  if (busyConversations.size) return { allow: false, reason: 'user_active' }
  const usedToday = p.daily?.date === now.date ? p.daily.count ?? 0 : 0
  const budget = pcfg.dailyBudget ?? 5
  if (usedToday >= budget) return { allow: false, reason: 'daily_budget' }
  const gap = (pcfg.minGapMinutes ?? 45) * (p.consecutiveIgnores >= pcfg.ignoreDecay ? 2 : 1)
  if (p.lastAt && Date.now() - Date.parse(p.lastAt) < gap * 60000) return { allow: false, reason: 'min_gap' }
  const lastUser = state?.lastUserMessageAt
  const idleMinutes = lastUser ? (Date.now() - Date.parse(lastUser)) / 60000 : 60 * 24
  if (idleMinutes < (pcfg.idleToFirstNudgeMinutes ?? 25) && !p.lastAt) return { allow: false, reason: 'user_recently_active' }
  const material = await materialCount(cfg, state)
  if (!material) return { allow: false, reason: 'no_material' }
  return { allow: true, reason: 'ok', usedToday, budget, idleMinutes: Math.round(idleMinutes), now, material }
}

async function materialCount(cfg, state) {
  const loops = state?.dream?.loops ?? []
  const nudges = state?.dream?.nudges ?? []
  const facts = await retrieve('跟进 计划 截止 项目', { topK: 6 })
  return loops.length + nudges.length + Math.min(facts.length, 3)
}

async function buildDecisionContext(cfg, gate) {
  const state = await readJSON(P.state, {})
  const core = await loadCore()
  const conv = (await getConversation(MAIN_ID)) ?? (await createConversation({ isMain: true, title: '主对话' }))
  const tail = conv.messages.slice(-10).map((m) => `${m.role === 'user' ? '用户' : '助手'}${m.proactive ? '[主动]' : ''}: ${clip(String(m.content ?? '').replace(/\s+/g, ' '), 260)}`)
  const loops = (state?.dream?.loops ?? []).map((l) => ({ id: l.id, topic: l.topic, due: l.due, status: l.status, why: l.why, raised: l.raised ?? 0 }))
  const nudges = (state?.dream?.nudges ?? []).map((n) => ({ id: n.id, topic: n.topic, angle: n.angle, urgency: n.urgency }))
  const facts = (await retrieve(`${loops.map((l) => l.topic).join(' ')} ${nudges.map((n) => n.topic).join(' ')}`, { topK: 8 }))
    .map((f) => f.text)
  const recentProactive = (state?.proactive?.history ?? []).slice(-6)
  return [
    `现在：${gate.now.label}（${gate.now.daypart}），用户已空闲约 ${gate.idleMinutes} 分钟。今天已主动开口 ${gate.usedToday}/${gate.budget} 次。`,
    '',
    '核心记忆：',
    clip(core, 1800),
    '',
    '跟进事项（来自上次 Dream）：',
    loops.length ? JSON.stringify(loops, null, 0) : '(无)',
    '',
    '候选话题：',
    nudges.length ? JSON.stringify(nudges, null, 0) : '(无)',
    '',
    '相关记忆片段：',
    facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(无)',
    '',
    '主对话最近内容：',
    tail.length ? tail.join('\n') : '(还没有聊过)',
    '',
    '你最近的主动消息及是否有回应（replied=true 说明用户接住了）：',
    recentProactive.length
      ? recentProactive.map((h) => `- ${String(h.at).slice(5, 16)} [${h.kind}] replied=${h.replied ? 'yes' : 'no'} :: ${clip(h.message, 90)}`).join('\n')
      : '(还没有主动开过口)',
  ].join('\n')
}

/** Background tick: decide whether to speak, and if so write into the main session. */
export async function proactiveTick({ busyConversations } = {}) {
  const cfg = await loadConfig()
  await settlePending().catch(() => {}) // 先把上一轮"没人接"的账结掉
  const gate = await proactiveGate({ busyConversations: busyConversations ?? new Set() })
  if (!gate.allow) return { acted: false, skipped: gate.reason }
  const state = await readJSON(P.state, {})
  const p = state?.proactive ?? {}

  // 决策层：bandit 选类型 + 台账排序挑跟进事项，模型在这个先验下做最终判断
  const loopPick = pickLoop(state?.dream?.loops ?? [], {})
  const kindPick = await pickKind({ candidates: ['follow_up', 'suggest', 'guide', 'ask', 'brief'] })
  let threshold = await thresholdFor(kindPick.kind, cfg.proactive.confidenceThreshold ?? 0.62)
  if (p.consecutiveIgnores >= (cfg.proactive.ignoreDecay ?? 2)) threshold = Math.min(0.9, threshold + 0.1)

  const user = await buildDecisionContext(cfg, gate)
  const prior = [
    '',
    '策略先验（来自反馈统计，可推翻但要说明理由）：',
    `- 建议类型：${kindPick.kind}（该类型平均被接住率 ${kindPick.mean}，样本 ${kindPick.draws}）`,
    loopPick ? `- 建议跟进：${loopPick.topic}（EV ${loopPick._ev}${loopPick._dueDays != null ? `，${loopPick._daysToDue} 天后截止` : ''}${loopPick.raised ? `，已提过 ${loopPick.raised} 次` : ''}）` : '- 建议跟进：无',
    `- 开口门槛：${threshold.toFixed(2)}（低于它请 act=false）`,
  ].join('\n')
  let out
  try {
    out = await jsonTask({
      system: DECIDE_SYSTEM,
      user: `${user}${prior}\n\n输出 JSON：{"act":true|false,"confidence":0-1,"kind":"follow_up|suggest|guide|ask|brief","anchor_id":"可空","message":"...","reason":"一句话说明为什么现在值得开口"}`,
      model: cfg.upstream.defaultModel,
      maxTokens: 500,
      temperature: 0.7,
      timeoutMs: 60000,
    })
  } catch (err) {
    log.warn('主动服务决策失败:', err.message)
    return { acted: false, skipped: 'error', error: err.message }
  }
  const j = out.json
  if (!j || typeof j !== 'object') return { acted: false, skipped: 'bad_json' }
  const confidence = Number(j.confidence ?? 0)
  if (!j.act || confidence < threshold) {
    record({ kind: 'proactive', acted: false, skipped: 'below_threshold', confidence, reason: clip(String(j.reason ?? ''), 160) })
    await mutateState((s) => {
      s.proactive = { ...(s.proactive ?? {}), lastCheckAt: nowIso(), lastDecision: { act: Boolean(j.act), confidence, reason: clip(j.reason ?? '', 160) } }
      return s
    })
    return { acted: false, skipped: 'below_threshold', confidence, reason: j.reason }
  }
  const message = clip(String(j.message ?? '').trim(), 900)
  if (message.length < 6) return { acted: false, skipped: 'empty_message' }
  const conv = (await getConversation(MAIN_ID)) ?? (await createConversation({ isMain: true, title: '主对话' }))
  const msg = {
    id: newId('m'),
    role: 'assistant',
    content: message,
    proactive: true,
    kind: ['follow_up', 'suggest', 'guide', 'ask', 'brief'].includes(j.kind) ? j.kind : 'follow_up',
    anchorId: j.anchor_id ?? (loopPick?.id ?? null),
    confidence,
    reason: clip(String(j.reason ?? ''), 200),
    model: cfg.upstream.defaultModel,
    suggestedKind: kindPick.kind,
    createdAt: nowIso(),
    usage: out.usage ?? null,
  }
  conv.messages.push(msg)
  conv.unread = (conv.unread ?? 0) + 1
  conv.title = conv.title === '新对话' ? '主对话' : conv.title
  await saveConversation(conv)
  await mutateState((s) => {
    const prev = s.proactive ?? {}
    const daily = prev.daily?.date === gate.now.date ? { ...prev.daily } : { date: gate.now.date, count: 0 }
    daily.count = (daily.count ?? 0) + 1
    s.proactive = {
      ...prev,
      lastAt: nowIso(),
      daily: { date: gate.now.date, count: daily.count },
      consecutiveIgnores: prev.consecutiveIgnores ?? 0,
      history: [...(prev.history ?? []).slice(-19), { at: nowIso(), kind: msg.kind, anchorId: msg.anchorId, message, confidence }],
    }
    if (msg.anchorId) {
      const loop = (s.dream?.loops ?? []).find((l) => l.id === msg.anchorId)
      if (loop) loop.raised = (loop.raised ?? 0) + 1
    }
    return s
  })
  if (cfg.proactive.notify !== false) macNotify('Echo · 主动服务', message.replace(/\s+/g, ' ').slice(0, 120))
  record({ kind: 'proactive', acted: true, kindOf: msg.kind, confidence, anchorId: msg.anchorId, chars: message.length })
  log.info(`主动消息 [${msg.kind}] conf=${confidence.toFixed(2)}: ${clip(message, 70)}`)
  return { acted: true, message: msg, daily: daily.count }
}

/** Called whenever the user sends a message, to record engagement + idle clock. */
export async function recordUserEngagement(conversationId) {
  await mutateState((s) => {
    s.lastUserMessageAt = nowIso()
    const p = s.proactive ?? {}
    const history = p.history ?? []
    const last = history.at(-1)
    if (last && !last.replied && conversationId === MAIN_ID) {
      last.replied = true
      last.repliedAt = nowIso()
      record({ kind: 'proactive_reply', kindOf: last.kind, anchorId: last.anchorId ?? null, latencyMs: Date.now() - Date.parse(last.at ?? nowIso()) })
      // 反馈回路：被接住 = 正奖励（bandit 的 reward 信号）
      updateKind(last.kind ?? 'follow_up', 1, { note: 'replied' }).catch(() => {})
    }
    const ignores = last && !last.replied && conversationId !== MAIN_ID ? (p.consecutiveIgnores ?? 0) + 1 : 0
    s.proactive = { ...p, consecutiveIgnores: conversationId === MAIN_ID ? 0 : ignores, history }
    return s
  })
}

export async function proactiveStatus() {
  const cfg = await loadConfig()
  const state = await readJSON(P.state, {})
  const p = state?.proactive ?? {}
  const gate = await proactiveGate({})
  const kindThresholds = {}
  for (const k of ['follow_up', 'suggest', 'guide', 'ask', 'brief']) {
    kindThresholds[k] = await thresholdFor(k, cfg.proactive.confidenceThreshold ?? 0.62)
  }
  return {
    enabled: cfg.proactive.enabled,
    lastAt: p.lastAt ?? null,
    lastCheckAt: p.lastCheckAt ?? null,
    lastDecision: p.lastDecision ?? null,
    todayCount: p.daily?.count ?? 0,
    budget: cfg.proactive.dailyBudget,
    minGapMinutes: cfg.proactive.minGapMinutes,
    consecutiveIgnores: p.consecutiveIgnores ?? 0,
    nextGate: gate,
    history: (p.history ?? []).slice(-8),
    quietHours: cfg.proactive.quietHours,
    kindThresholds,
  }
}

export async function setProactiveEnabled(enabled) {
  const { saveConfig } = await import('./config.mjs')
  await saveConfig({ proactive: { enabled: Boolean(enabled) } })
  return enabled
}
