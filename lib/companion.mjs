import { languageText } from './language.mjs'
import { domainText } from './domain-language.mjs'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import { DATA, loadConfig } from './config.mjs'
import { readJSON, stripTags, nowIso, tokenize } from './util.mjs'
import { jsonTask } from './native.mjs'
import { record } from './metrics.mjs'
import { log } from './log.mjs'
import { checkAttention, effectiveInterruptionPolicy, reserveAttention, finishAttention, interventionKeys, localDate, presentableBubbles } from './attention.mjs'
import { applyFeedback, contentFeedback, contentFeedbackIndex, contentTopicKey } from './agency.mjs'
import { getRelationships, relationshipGuidance } from './relationships.mjs'
import { matchesBlocklist } from './screen.mjs'
import { appendMessage, createConversation, mutateState } from './store.mjs'

/**
 * 伴随模式：用户显式打开后，截图频率大幅提高，agent 跟着用户一起看屏幕，
 * 用不打扰的"气泡"给出理解 / 建议 / 讲解；点开气泡进入一个小对话窗聚焦那个话题。
 *
 * 三条纪律（否则就是个烦人的弹窗广告）：
 *  1. 屏幕没变就不调模型（变化检测先挡掉大部分帧）——省 token，也避免重复念叨
 *  2. 有预算、有间隔、连续被主动收起后暂时安静（和主动服务同一套克制）
 *  3. 只冒泡、不抢焦点；点开才展开细节
 */

const FILE = path.join(DATA, 'companion.jsonl')
const MAX_ROWS = 500
const FRAME_TTL_MS = 60000
const WORDING_RETRY_MS = 5 * 60000
const QUIET_CUE_MS = 3 * 3600000
let frameRunning = false
let bubbleWrites = Promise.resolve()

const SCENARIOS = {
  chat: { get label() { return domainText('companion.chat') }, gapMul: 1, get hint() { return domainText('companion.chatGuidance') } },
  video: { get label() { return domainText('companion.video') }, gapMul: 1.6, get hint() { return domainText('companion.videoGuidance') } },
  work: { get label() { return domainText('companion.work') }, gapMul: 1, get hint() { return domainText('companion.workGuidance') } },
  code: { get label() { return domainText('companion.coding') }, gapMul: 1.2, get hint() { return domainText('companion.codeGuidance') } },
  browse: { get label() { return domainText('companion.browse') }, gapMul: 1.2, get hint() { return domainText('companion.browseGuidance') } },
  other: { get label() { return domainText('companion.other') }, gapMul: 1.4, get hint() { return domainText('companion.otherGuidance') } },
}

const systemPrompt = () => domainText('companion.systemPrompt')

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** 帧变化检测：屏幕没变就别调模型（这是省钱与不重复念叨的关键） */
function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / Math.sqrt(A.size * B.size)
}

// A recognized app can strengthen a visible cue. The app name alone never starts a request.
const SCREEN_CUES = [
  { id: 'code_error', kind: 'code', get label() { return domainText('companion.errorCue') }, weight: 0.84, cue: /\b(?:typeerror|syntaxerror|referenceerror|traceback|cannot find module|error TS\d+|exit (?:code )?[1-9]\d*)\b|编译失败|类型错误|找不到模块/i },
  { id: 'code_test', kind: 'code', get label() { return domainText('companion.testCue') }, weight: 0.81, cue: /\b(?:tests? (?:failed|failing)|failing tests?|assertionerror)\b|测试(?:失败|未通过)|断言失败/i },
  { id: 'chat_draft', kind: 'chat', get label() { return domainText('companion.draftCue') }, weight: 0.77, cue: /\b(?:draft(?:ing)? .{0,50}(?:reply|response)|reply draft|compose (?:an? )?(?:email|reply))\b|回复草稿|起草.{0,12}(?:邮件|回复)|待发送的回复/i },
  { id: 'work_deadline', kind: 'work', get label() { return domainText('companion.dueCue') }, weight: 0.72, cue: /\b(?:deadlines?|due dates?|due (?:by|on|tomorrow|today))\b|截止(?:时间|日期|日|到)?|交付日期/i },
  { id: 'work_tasks', kind: 'work', get label() { return domainText('companion.taskCue') }, weight: 0.65, cue: /\b(?:checklists?|action items?|meeting agenda|next steps?)\b|待办清单|行动项|会议议程|下一步安排/i },
  { id: 'work_budget', kind: 'work', get label() { return domainText('companion.budgetCue') }, weight: 0.69, cue: /\b(?:budget (?:variance|breakdown|sheet)|expense report)\b|预算表|费用明细|预算差异/i },
  { id: 'browse_compare', kind: 'browse', get label() { return domainText('companion.compareCue') }, weight: 0.62, cue: /\b(?:comparison (?:table|chart)|side.by.side comparison|compare specifications)\b|配置对比|对比表|参数比较/i },
  { id: 'browse_source', kind: 'browse', get label() { return domainText('companion.sourceCue') }, weight: 0.62, cue: /\b(?:source citation|original source|primary source|citation needed)\b|原始出处|原始来源|参考文献|引用来源/i },
  { id: 'video_caption', kind: 'video', get label() { return domainText('companion.subtitleCue') }, weight: 0.55, cue: /\b(?:captions?|subtitles?)\s*[:：]|字幕(?:显示|写着|[：:])/i },
  { id: 'other_steps', kind: 'other', get label() { return domainText('companion.stepsCue') }, weight: 0.61, cue: /\b(?:installation steps|setup instructions|step \d+ of \d+)\b|安装步骤|操作步骤|第\s*\d+\s*步/i },
]

const SCENE_CONTEXT = {
  code: /xcode|code|terminal|终端|源码/i, chat: /mail|outlook|草稿|draft|邮件/i,
  work: /excel|word|numbers|sheets|文档|表格|项目|project|meeting notes|agenda/i,
  browse: /safari|chrome|firefox|edge|浏览器/i, video: /iina|vlc|player|\.mkv|\.mp4|播放器/i,
  other: /installer|setup|安装/i,
}

const PRIVATE_APP = /^(?:wechat|whatsapp|telegram|signal|messages|信息|微信|1password|keychain access)(?:\.app)?$|钥匙串|密码管理/i
const PRIVATE_FIELDS = /\b(?:password|passcode|verification code|one.time (?:code|password)|private (?:chat|message)|credit card|bank account|medical record|ssn|api[_ -]?key)\b|密码|验证码|身份证[号码]|银行卡号|信用卡号|私聊|病历|-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{16,})\b/i
const frameHash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)

function screenKeys(app, title, excerpt, content) {
  return interventionKeys({ content, anchorId: `screen:${app ?? ''}:${title ?? ''}`,
    evidence: [{ source: `screen:${app ?? 'unknown'}`, excerpt }] })
}

function holdWording(previous, anchorId, duration) {
  const now = Date.now()
  const retries = (previous.wordingRetries ?? []).filter((row) => row.retryAt > now && row.anchorId !== anchorId)
  return [...retries.slice(-63), { anchorId, retryAt: now + duration }]
}

function selectScreenCue({ text, app, title }, comp, state, minScore) {
  const lines = String(text ?? '').slice(0, 18000).split(/[\r\n]+|(?<=[。！？；])|(?<=[.!?;])\s+/u).map(norm).filter(Boolean)
  const context = norm([app, title].join(' '))
  const previous = state.companion ?? {}
  const allowed = new Set(comp.scenarios ?? Object.keys(SCENARIOS))
  const candidates = []
  const anchors = new Set()
  const delivered = new Set((state.attention?.history ?? []).filter((row) => row.channel === 'companion' && row.status === 'delivered').map((row) => row.anchorKey))
  const now = Date.now()
  const retryTimes = new Map((previous.wordingRetries ?? []).map((row) => [row.anchorId, row.retryAt]))
  let nextRetry = Infinity
  let feedback
  let hasCue = false
  let hasEnabledCue = false
  let dismissed = false
  let muted = false
  for (const rule of SCREEN_CUES) {
    for (const line of lines) {
      const match = rule.cue.exec(line)
      if (!match) continue
      hasCue = true
      if (!allowed.has(rule.kind)) continue
      hasEnabledCue = true
      const excerpt = line.slice(Math.max(0, match.index - 70), match.index + match[0].length + 110).trim()
      const anchorId = 'screen:' + frameHash(rule.id + '\n' + excerpt.toLowerCase())
      const topicKey = contentTopicKey('companion', rule.id)
      if (state.agency?.mutedTopics?.[topicKey]) { muted = true; continue }
      const retryAt = retryTimes.get(anchorId)
      if (retryAt > now) {
        nextRetry = Math.min(nextRetry, retryAt)
        continue
      }
      anchors.add(anchorId)
      if (previous.lastFrameAnchors?.includes(anchorId) || (!previous.lastFrameAnchors && previous.lastFrameText?.includes(excerpt))) continue
      if (delivered.size && delivered.has(screenKeys(app, title, excerpt).anchorKey)) continue
      feedback ??= contentFeedbackIndex(state, { channel: 'companion', now })
      const votes = contentFeedback(state, { channel: 'companion', kind: rule.kind, topicKey, anchorId, now }, feedback)
      if (votes.dismissed) { dismissed = true; continue }
      const contextMatches = SCENE_CONTEXT[rule.kind].test(context)
      const score = Math.max(0, Math.min(1, rule.weight + (contextMatches ? 0.08 : 0) + votes.kindAdjustment + votes.topicAdjustment))
      const reasons = [domainText('companion.newEvidence') + rule.label]
      if (contextMatches) reasons.push(domainText('companion.windowMatches'))
      if (votes.kindAdjustment || votes.topicAdjustment) reasons.push(domainText('companion.learnedFeedback'))
      candidates.push({ excerpt, selection: { source: 'screen', anchorId, kind: rule.kind, topicKey, label: rule.label, score: Number(score.toFixed(3)), reasons } })
    }
  }
  candidates.sort((a, b) => b.selection.score - a.selection.score)
  const best = candidates[0]
  if (!best && Number.isFinite(nextRetry)) return { skipped: 'wording_cooldown', retryAt: new Date(nextRetry).toISOString() }
  if (!best) return { skipped: muted ? 'topic_muted' : dismissed ? 'feedback_suppressed' : hasEnabledCue ? 'unchanged' : hasCue ? 'scenario_off' : 'no_screen_cue' }
  if (best.selection.score < minScore) return { skipped: 'below_threshold' }
  if (candidates.some((c) => c.selection.score === best.selection.score && c.selection.topicKey !== best.selection.topicKey)) return { skipped: 'ambiguous_screen' }
  return { ...best, anchors: [...anchors].slice(0, 160), hasRetry: Number.isFinite(nextRetry) }
}

function framesToday(companion, now = Date.now()) {
  return companion.lastFrameAt && localDate(companion.lastFrameAt) === localDate(now) ? companion.framesToday ?? 0 : 0
}

export async function companionStatus({ includeBubbles = 12 } = {}) {
  const cfg = await loadConfig()
  const state = await readJSON(path.join(DATA, 'state.json'), {})
  const c = state?.companion ?? {}
  const rows = await readBubbles()
  const now = Date.now()
  return {
    enabled: cfg.companion?.enabled === true,
    pausedUntil: c.pausedUntil ?? null,
    paused: Date.parse(c.pausedUntil ?? 0) > now,
    intervalSeconds: cfg.companion?.intervalSeconds ?? 20,
    hourlyBudget: cfg.companion?.hourlyBudget ?? 15,
    minGapSeconds: cfg.companion?.minGapSeconds ?? 75,
    scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.label])),
    enabledScenarios: cfg.companion?.scenarios ?? Object.keys(SCENARIOS),
    hourCount: c.hourly?.key === new Date().toISOString().slice(0, 13) ? c.hourly?.count ?? 0 : 0,
    framesToday: framesToday(c, now),
    dismissStreak: c.dismissStreak ?? 0,
    stats: {
      total: rows.length,
      pending: rows.filter((b) => b.status === 'pending').length,
      opened: rows.filter((b) => b.status === 'opened').length,
      dismissed: rows.filter((b) => b.status === 'dismissed').length,
      expired: rows.filter((b) => b.status === 'expired').length,
      lastAt: rows.at(-1)?.ts ?? null,
    },
    recent: Number.isFinite(includeBubbles) && includeBubbles >= 1 ? rows.slice(-Math.floor(includeBubbles)).reverse() : [],
  }
}

async function readBubbles() {
  try {
    const raw = await fs.readFile(FILE, 'utf8')
    const now = Date.now()
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const b = JSON.parse(l)
          if (b?.status === 'pending') {
            const until = b.expiresAt ? Date.parse(b.expiresAt) : Date.parse(b.ts) + FRAME_TTL_MS
            if (Number.isFinite(until)) b.expiresAt = new Date(until).toISOString()
            if (!Number.isFinite(until) || until <= now) Object.assign(b, { status: 'expired', expiredAt: b.expiresAt ?? null, expireReason: 'stale_screen' })
          }
          return b
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export async function getBubble(id) {
  return (await readBubbles()).find((row) => row.id === id) ?? null
}

async function writeBubbles(rows) {
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await fs.writeFile(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  await fs.rename(tmp, FILE)
}

export async function pendingBubbles({ since, busyConversations } = {}) {
  const rows = await readBubbles()
  const sinceTs = since ? Date.parse(since) : 0
  const pending = rows
    .filter((b) => b.status === 'pending' && (!sinceTs || Date.parse(b.ts) > sinceTs))
  return (await presentableBubbles(pending, busyConversations)).slice(-3)
}

function mutateBubbles(fn) {
  const result = bubbleWrites.then(async () => {
    const rows = await readBubbles()
    const value = await fn(rows)
    await writeBubbles(rows.slice(-MAX_ROWS))
    return value
  })
  bubbleWrites = result.catch(() => {})
  return result
}

/** 主动收起/点开只调整打扰节奏，不推断情绪或关系。 */
async function bumpState(patch) {
  return mutateState((s) => {
    s.companion = { ...(s.companion ?? {}), ...patch }
    return s
  })
}

/**
 * 处理一帧：本机识别新线索、筛选话题与时机，再请求一句有依据的气泡文案。
 * 任何一步不满足都"静默跳过"（返回 skipped），绝不打扰。
 */
export async function ingestFrame({ text, app, title, ts, hidIdleSeconds }, { busyConversations } = {}) {
  if (frameRunning) return { skipped: 'frame_in_progress' }
  frameRunning = true
  try {
    return await processFrame({ text, app, title, ts, hidIdleSeconds }, busyConversations)
  } finally {
    frameRunning = false
  }
}

async function processFrame({ text, app, title, ts, hidIdleSeconds }, busyConversations) {
  const cfg = await loadConfig()
  const comp = cfg.companion ?? {}
  if (comp.enabled !== true) return { skipped: 'disabled' }
  const body = norm(text)
  const frame = { app, title, text }
  const normalizedFrame = { app, title, text: body }
  const frameExclusion = (config) => config.companion?.enabled !== true ? 'disabled' : matchesBlocklist(config, normalizedFrame)
  const exclusion = frameExclusion(cfg)
  if (exclusion) return { skipped: exclusion }
  if (PRIVATE_APP.test(String(app ?? '')) || PRIVATE_FIELDS.test(String(title ?? '') + '\n' + body)) return { skipped: 'sensitive_frame' }

  const state = await readJSON(path.join(DATA, 'state.json'), {})
  const c = state?.companion ?? {}
  const now = Date.now()
  const observedAt = ts ?? new Date(now).toISOString()
  const captureTime = Date.parse(observedAt)
  if (!Number.isFinite(captureTime) || captureTime > now + 30000 || now - captureTime >= FRAME_TTL_MS) return { skipped: 'expired' }
  const expiresAt = new Date(Math.min(captureTime, now) + FRAME_TTL_MS).toISOString()

  if (Date.parse(c.pausedUntil ?? 0) > now) return { skipped: 'paused', until: c.pausedUntil }
  if (hidIdleSeconds > (comp.idleSkipSeconds ?? 120)) return { skipped: 'idle' }

  if (body.length < (comp.minTextChars ?? 40)) return { skipped: 'too_little_text' }

  // 变化检测：和上一帧太像就不说话
  const hash = frameHash(body)
  if (hash === c.lastFrameHash || (!c.lastFrameAnchors && body === c.lastFrameText)) {
    await bumpState({ lastFrameAt: nowIso(), framesToday: framesToday(c, now) })
    return { skipped: 'unchanged', similarity: 1 }
  }

  const hourKey = new Date().toISOString().slice(0, 13)
  const hourly = c.hourly?.key === hourKey ? c.hourly : { key: hourKey, count: 0 }
  // 注意：被预算/间隔挡下的帧**不能**更新比较基线，否则"同一屏内容"在间隔结束后
  // 会被判成 unchanged 而永远失去开口机会（实测踩过：聊天窗口一直开着就成了盲区）
  if (hourly.count >= (comp.hourlyBudget ?? 15)) {
    await bumpState({ framesToday: framesToday(c, now) + 1, lastFrameAt: nowIso(), hourly })
    return { skipped: 'hourly_budget', used: hourly.count }
  }
  const gap = (comp.minGapSeconds ?? 75) * 1000
  if (c.lastBubbleAt && now - Date.parse(c.lastBubbleAt) < gap) {
    await bumpState({ framesToday: framesToday(c, now) + 1, lastFrameAt: nowIso() })
    return { skipped: 'min_gap', waitMs: gap - (now - Date.parse(c.lastBubbleAt)) }
  }
  if ((c.dismissStreak ?? 0) >= (comp.dismissStreakLimit ?? 3)) {
    const until = new Date(now + (comp.backoffMinutes ?? 10) * 60000).toISOString()
    await bumpState({ pausedUntil: until, dismissStreak: 0, lastFrameAt: nowIso(), framesToday: framesToday(c, now) })
    log.info(domainText('companion.quietAfterDismissals', comp.dismissStreakLimit ?? 3, until.slice(11, 16)))
    return { skipped: 'dismiss_backoff', until }
  }
  const attention = await checkAttention({ channel: 'companion', busyConversations })
  if (!attention.allow) return { skipped: attention.reason }

  const picked = selectScreenCue(frame, comp, state, attention.timing.policy.effective.minScore)
  if (picked.skipped) return picked
  const { selection, excerpt } = picked
  const scenario = selection.kind
  const sim = similarity(excerpt, c.lastFrameText ?? '')
  const numbers = (s) => (s?.match(/\d+/g) ?? []).join()
  if (c.lastFrameTopicKey === selection.topicKey && numbers(excerpt) === numbers(c.lastFrameText) && sim > (comp.changeThreshold ?? 0.88)) {
    return { skipped: 'unchanged', similarity: Number(sim.toFixed(3)) }
  }
  // If another cue failed, leave that cue eligible once its retry time arrives.
  const baseline = {
    lastFrameText: excerpt, lastFrameHash: picked.hasRetry ? null : hash,
    lastFrameTopicKey: selection.topicKey, lastFrameAnchors: picked.anchors,
    wordingRetries: (c.wordingRetries ?? []).filter((row) => row.retryAt > now),
  }
  const checkSelection = (current, config, minimum) => {
    const excluded = frameExclusion(config)
    if (excluded) return excluded
    if (Date.parse(current.companion?.pausedUntil) > Date.now()) return 'paused'
    const latest = selectScreenCue(frame, config.companion, current, minimum)
    return latest.skipped || (latest.selection.anchorId !== selection.anchorId ? 'selection_changed' : null)
  }
  const started = Date.now()
  let out
  let requestedWording = false
  try {
    const profile = cfg.memory?.enabled && cfg.memory?.inject !== false ? (await getRelationships()).profile : { enabled: false }
    const [beforeRender, latestCfg, latestState] = await Promise.all([
      checkAttention({ channel: 'companion', busyConversations, expiresAt }), loadConfig(), readJSON(path.join(DATA, 'state.json'), {}),
    ])
    const held = beforeRender.allow ? checkSelection(latestState, latestCfg, beforeRender.timing.policy.effective.minScore) : beforeRender.reason
    if (held) return { skipped: held }
    const style = latestCfg.memory?.enabled && latestCfg.memory?.inject !== false ? profile : { enabled: false }
    requestedWording = true
    out = await jsonTask({
      system: [systemPrompt(), relationshipGuidance(style, { background: true }), SCENARIOS[scenario].hint].join('\n\n'),
      user: JSON.stringify({ scenario, topic: selection.label, evidence: excerpt }),
      model: comp.model || cfg.upstream.utilityModel || cfg.upstream.defaultModel,
      maxTokens: 260,
      temperature: 0.7,
      timeoutMs: 25000,
      schemaHint: domainText('companion.bubbleSchema'),
    })
  } catch (err) {
    if (requestedWording) await mutateState(async (s) => {
      if (frameExclusion(await loadConfig())) return
      s.companion ??= {}
      s.companion.wordingRetries = holdWording(s.companion, selection.anchorId, WORDING_RETRY_MS)
    })
    record({ kind: 'companion', ok: false, error: err.message.slice(0, 120) })
    return { skipped: 'model_error', error: err.message }
  }
  const ms = Date.now() - started
  const j = out.json ?? {}
  const bubbleText = typeof j.bubble === 'string' ? stripTags(j.bubble).slice(0, 120) : ''
  const quote = typeof j.quote === 'string' ? j.quote.trim() : ''
  const grounded = quote.length <= 80 && /[\p{Script=Han}]{2}|[\p{L}\d]{3}/u.test(quote) && excerpt.includes(quote)
  const unusable = j.speak === true && (!bubbleText || !grounded || (j.scenario !== undefined && j.scenario !== scenario))
  const drafted = j.speak === true && !unusable
  record({ kind: 'companion', ok: true, ms, scenario, spoke: drafted, chars: body.length, sim: Number(sim.toFixed(3)) })

  if (!drafted) {
    let blocked
    await mutateState(async (s) => {
      const current = s.companion ?? {}
      const latestCfg = await loadConfig()
      blocked = checkSelection(s, latestCfg, effectiveInterruptionPolicy(latestCfg, s, { trigger: 'companion' }).effective.minScore)
      if (!blocked) s.companion = { ...current, ...baseline, wordingRetries: holdWording(current, selection.anchorId, QUIET_CUE_MS),
        lastFrameAt: nowIso(), framesToday: framesToday(current) + 1 }
    })
    return { skipped: blocked || (unusable ? 'unusable_wording' : 'decided_quiet'), scenario, ms }
  }

  const freshCfg = await loadConfig()
  const freshState = await readJSON(path.join(DATA, 'state.json'), {})
  const latestExclusion = checkSelection(freshState, freshCfg, effectiveInterruptionPolicy(freshCfg, freshState, { trigger: 'companion' }).effective.minScore)
  if (latestExclusion) return { skipped: latestExclusion }
  const evidence = [{ id: `frame_${Date.now().toString(36)}`, label: app ?? domainText('companion.screen'), source: `screen:${app ?? 'unknown'}`, observedAt, excerpt }]
  const reservation = await reserveAttention({
    channel: 'companion', busyConversations, expiresAt,
    ...screenKeys(app, title, excerpt, bubbleText),
  })
  // Do not advance the comparison baseline: retry after the attention state changes.
  if (!reservation.allow) {
    if (reservation.reason === 'duplicate') await mutateState((s) => {
      s.companion ??= {}
      s.companion.wordingRetries = holdWording(s.companion, selection.anchorId, QUIET_CUE_MS)
    })
    return { skipped: reservation.reason }
  }
  const bubble = {
    id: `b_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    attentionToken: reservation.token,
    scenario,
    topic: selection.label, selection,
    bubble: bubbleText,
    why: selection.reasons.join(languageText('；', '; ')),
    status: 'pending',
    expiresAt,
    frame: { app: stripTags(app ?? '').slice(0, 40), title: stripTags(title ?? '').slice(0, 80) },
    excerpt,
    evidence,
    ms,
  }
  let written = false
  let blocked = null
  try {
    await mutateBubbles(async (rows) => {
      const gate = await checkAttention({ channel: 'companion', busyConversations, reservationToken: reservation.token, expiresAt })
      blocked = gate.allow ? checkSelection(await readJSON(path.join(DATA, 'state.json'), {}), await loadConfig(), gate.timing.policy.effective.minScore) : gate.reason
      if (!blocked) {
        bubble.ts = nowIso()
        bubble.deliveryTimeZone = gate.timing.timeZone
        rows.push(bubble)
      }
    })
    if (blocked) {
      await finishAttention(reservation.token, { delivered: false })
      return { skipped: blocked }
    }
    written = true
    await mutateState(async (s) => {
      const prev = s.companion ?? {}
      const key = new Date().toISOString().slice(0, 13)
      const count = prev.hourly?.key === key ? prev.hourly.count ?? 0 : 0
      s.companion = {
        ...prev, lastBubbleAt: bubble.ts, lastFrameAt: nowIso(),
        framesToday: framesToday(prev) + 1, hourly: { key, count: count + 1 },
      }
      if (!frameExclusion(await loadConfig()) && !(Date.parse(prev.pausedUntil) > Date.now())) Object.assign(s.companion, baseline)
      return s
    })
    await finishAttention(reservation.token)
  } catch (err) {
    await finishAttention(reservation.token, { delivered: written })
    throw err
  }
  log.info(domainText('companion.bubbleLog', scenario, bubble.id))
  return { bubble }
}

/** 悬浮窗自动淡出：标记过期，**不计入**退避（用户并没有拒绝，只是没看） */
export async function expireBubble(id, { reason = 'autohide' } = {}) {
  return mutateBubbles((rows) => {
    const b = rows.find((row) => row.id === id)
    if (b?.status === 'pending') {
      Object.assign(b, { status: 'expired', expiredAt: nowIso(), expireReason: reason })
      record({ kind: 'companion_feedback', action: 'expire', scenario: b.scenario })
    }
    return b ?? null
  })
}

export async function dismissBubble(id, { reason } = {}) {
  const b = await mutateBubbles(async (rows) => {
    const item = rows.find((row) => row.id === id)
    if (!item) return null
    const at = nowIso()
    if (reason === 'wrong_time') item.wrongTimeAt ??= at
    if (item.status !== 'pending') return item
    Object.assign(item, { status: 'dismissed', dismissedAt: at, dismissReason: reason ?? null })
    if (reason !== 'wrong_time') await mutateState((s) => {
      s.companion ??= {}
      s.companion.dismissStreak = (s.companion.dismissStreak ?? 0) + 1
    })
    record({ kind: 'companion_feedback', action: 'dismiss', scenario: item.scenario })
    return item
  })
  if (b && reason === 'wrong_time') await applyFeedback({ signal: 'wrong_time', bubble: b })
  return b
}

/** 点开气泡：为他建一个聚焦该话题的小会话（同一话题复用），并把上下文放进去 */
export async function openBubble(id) {
  return mutateBubbles(async (rows) => {
    const b = rows.find((row) => row.id === id)
    if (!b) return null
    // The same chat can be recovered if Echo exits between writing it and linking the bubble.
    const conversationId = b.conversationId ?? 'c_bubble_' + frameHash(b.id)
    let conv = await createConversation({ id: conversationId, title: domainText('companion.chatTitle', b.topic) })
    if (conv.messages.length === 0) {
      const scene = [b.frame.app, b.frame.title].filter(Boolean).join(' · ')
      conv = await appendMessage(conversationId, {
        id: `m_${b.id}`,
        role: 'assistant',
        content: domainText('companion.chatIntroduction', scene ? `${scene}${languageText('。', '. ')}` : '', b.bubble, b.why),
        companion: { bubbleId: b.id, scenario: b.scenario, excerpt: b.excerpt, deliveredAt: b.ts, ...(b.selection ? { selection: b.selection } : {}) },
        deliveryTimeZone: b.deliveryTimeZone, createdAt: nowIso(), model: 'companion',
      })
    }
    if (b.status !== 'opened' || !b.conversationId) {
      Object.assign(b, { status: 'opened', openedAt: nowIso(), conversationId })
      record({ kind: 'companion_feedback', action: 'open', scenario: b.scenario })
      await bumpState({ dismissStreak: 0 })
    }
    return { bubble: b, conversationId, conversation: conv }
  })
}

/** 暂停/恢复（状态栏与设置页都用它） */
export async function setCompanion({ enabled, pauseMinutes, scenarios, hourlyBudget, minGapSeconds, intervalSeconds } = {}) {
  const { saveConfig } = await import('./config.mjs')
  const patch = {}
  if (enabled !== undefined) patch.enabled = Boolean(enabled)
  if (scenarios !== undefined) patch.scenarios = (Array.isArray(scenarios) ? scenarios : []).filter((s) => SCENARIOS[s])
  if (hourlyBudget !== undefined) patch.hourlyBudget = Math.max(1, Math.min(60, Number(hourlyBudget)))
  if (minGapSeconds !== undefined) patch.minGapSeconds = Math.max(20, Math.min(900, Number(minGapSeconds)))
  if (intervalSeconds !== undefined) patch.intervalSeconds = Math.max(5, Math.min(300, Number(intervalSeconds)))
  if (Object.keys(patch).length) await saveConfig({ companion: patch })
  if (pauseMinutes !== undefined) {
    const until = pauseMinutes > 0 ? new Date(Date.now() + pauseMinutes * 60000).toISOString() : null
    await bumpState({ pausedUntil: until, ...(pauseMinutes > 0 ? {} : { dismissStreak: 0 }) })
    log.info(pauseMinutes > 0 ? domainText('companion.paused', pauseMinutes) : domainText('companion.resumed'))
  }
  return companionStatus()
}

export { SCENARIOS }
