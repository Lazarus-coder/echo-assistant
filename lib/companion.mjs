import path from 'node:path'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import { DATA, loadConfig } from './config.mjs'
import { readJSON, writeJSON, clip, stripTags, nowIso, tokenize } from './util.mjs'
import { jsonTask } from './native.mjs'
import { loadCore, retrieve } from './memory.mjs'
import { record } from './metrics.mjs'
import { log } from './log.mjs'
import { checkAttention, reserveAttention, finishAttention, interventionKeys } from './attention.mjs'

/**
 * 伴随模式：用户显式打开后，截图频率大幅提高，agent 跟着用户一起看屏幕，
 * 用不打扰的"气泡"给出理解 / 建议 / 讲解；点开气泡进入一个小对话窗聚焦那个话题。
 *
 * 三条纪律（否则就是个烦人的弹窗广告）：
 *  1. 屏幕没变就不调模型（变化检测先挡掉大部分帧）——省 token，也避免重复念叨
 *  2. 有预算、有间隔、被连续忽视就退避（和主动服务同一套克制）
 *  3. 只冒泡、不抢焦点；点开才展开细节
 */

const FILE = path.join(DATA, 'companion.jsonl')
const MAX_ROWS = 500
let frameRunning = false
let bubbleWrites = Promise.resolve()

const SCENARIOS = {
  chat: { label: '聊天', gapMul: 1, hint: '他大概率在跟人聊天：帮他判断关系与语气，或者给一条可直接复制的回复；短，别抢戏。' },
  video: { label: '看片', gapMul: 1.6, hint: '他在看视频/影视：当个一起看的同伴——一句感受、一个背景掌故、一句吐槽都行，别提问、别指导。' },
  work: { label: '办公', gapMul: 1, hint: '他在处理工作文档/表格：给一条具体可执行的建议或提醒（下一步、易错点、口径），不要泛泛鼓励。' },
  code: { label: '写代码', gapMul: 1.2, hint: '他在写代码：只在真能帮忙时开口——一个 API 用法、一个边界条件、一个更省事的做法；一行以内说清。' },
  browse: { label: '逛网页', gapMul: 1.2, hint: '他在浏览信息：补一条背景或对比，帮他省下点开一堆链接的时间。' },
  other: { label: '其他', gapMul: 1.4, hint: '看不出具体场景时宁可不说；真要说就说一句最相关的事实或提醒。' },
}

const SYSTEM = `你在"伴随模式"里：用户开着这个模式，等于允许你跟着他一起看他屏幕，用**气泡**偶尔说一句。
你在看的是本地 OCR 出来的文字（可能有错字），不是截图。

判断标准（不打扰优先）：
- 只有当"此刻这一句真的有用或真的有趣"时才开口；没把握就不说（speak=false）。
- 气泡一句话，最多 40 字，像朋友凑过来小声说，不要"我注意到您正在…"这种客服腔。
- 不要复述屏幕上已有的内容；不要提问（气泡不方便回答）；不要客套；不要 markdown。
- 涉及隐私/密码/转账/私聊八卦 → speak=false。
- scenario 从 chat / video / work / code / browse / other 里选一个。
- topic 用 2–8 个字概括这个话题（点开后小窗标题用它）。
- why 一句话，说明你为什么觉得这条值得说（给自己留证据，用户点开能看到）。

只输出 JSON：{"speak":true|false,"scenario":"","topic":"","bubble":"","why":""}`

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
    framesToday: c.framesToday ?? 0,
    dismissStreak: c.dismissStreak ?? 0,
    stats: {
      total: rows.length,
      pending: rows.filter((b) => b.status === 'pending').length,
      opened: rows.filter((b) => b.status === 'opened').length,
      dismissed: rows.filter((b) => b.status === 'dismissed').length,
      expired: rows.filter((b) => b.status === 'expired').length,
      lastAt: rows.at(-1)?.ts ?? null,
    },
    recent: rows.slice(-includeBubbles).reverse(),
  }
}

async function readBubbles() {
  try {
    const raw = await fs.readFile(FILE, 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

async function writeBubbles(rows) {
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await fs.writeFile(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  await fs.rename(tmp, FILE)
}

export async function pendingBubbles({ since } = {}) {
  const rows = await readBubbles()
  const sinceTs = since ? Date.parse(since) : 0
  return rows
    .filter((b) => b.status === 'pending' && (!sinceTs || Date.parse(b.ts) > sinceTs))
    .slice(-3)
}

async function updateBubble(id, patch) {
  return mutateBubbles((rows) => {
    const target = rows.find((b) => b.id === id)
    if (!target) return null
    Object.assign(target, patch)
    return target
  })
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

/** 被忽视/被点开 → 调整开口倾向：连续忽视会暂时闭嘴，被点开则放宽预算 */
async function bumpState(patch) {
  const { mutateState } = await import('./store.mjs')
  return mutateState((s) => {
    s.companion = { ...(s.companion ?? {}), ...patch }
    return s
  })
}

/**
 * 处理一帧：变化检测 → 节流 → 模型判断 → 落一个气泡。
 * 任何一步不满足都"静默跳过"（返回 skipped），绝不打扰。
 */
export async function ingestFrame({ text, app, title, ts, hidIdleSeconds }) {
  if (frameRunning) return { skipped: 'frame_in_progress' }
  frameRunning = true
  try {
    return await processFrame({ text, app, title, ts, hidIdleSeconds })
  } finally {
    frameRunning = false
  }
}

async function processFrame({ text, app, title, ts, hidIdleSeconds }) {
  const cfg = await loadConfig()
  const comp = cfg.companion ?? {}
  if (comp.enabled !== true) return { skipped: 'disabled' }

  const state = await readJSON(path.join(DATA, 'state.json'), {})
  const c = state?.companion ?? {}
  const now = Date.now()

  if (Date.parse(c.pausedUntil ?? 0) > now) return { skipped: 'paused', until: c.pausedUntil }
  if (hidIdleSeconds > (comp.idleSkipSeconds ?? 120)) return { skipped: 'idle' }

  const body = norm(text)
  if (body.length < (comp.minTextChars ?? 40)) return { skipped: 'too_little_text' }

  // 变化检测：和上一帧太像就不说话
  const sim = similarity(body, c.lastFrameText ?? '')
  if (sim > (comp.changeThreshold ?? 0.88)) {
    await bumpState({ lastFrameAt: nowIso() })
    return { skipped: 'unchanged', similarity: Number(sim.toFixed(3)) }
  }

  const hourKey = new Date().toISOString().slice(0, 13)
  const hourly = c.hourly?.key === hourKey ? c.hourly : { key: hourKey, count: 0 }
  // 注意：被预算/间隔挡下的帧**不能**更新比较基线，否则"同一屏内容"在间隔结束后
  // 会被判成 unchanged 而永远失去开口机会（实测踩过：聊天窗口一直开着就成了盲区）
  if (hourly.count >= (comp.hourlyBudget ?? 15)) {
    await bumpState({ framesToday: (c.framesToday ?? 0) + 1, lastFrameAt: nowIso(), hourly })
    return { skipped: 'hourly_budget', used: hourly.count }
  }
  const gap = (comp.minGapSeconds ?? 75) * 1000
  if (c.lastBubbleAt && now - Date.parse(c.lastBubbleAt) < gap) {
    await bumpState({ framesToday: (c.framesToday ?? 0) + 1, lastFrameAt: nowIso() })
    return { skipped: 'min_gap', waitMs: gap - (now - Date.parse(c.lastBubbleAt)) }
  }
  if ((c.dismissStreak ?? 0) >= (comp.dismissStreakLimit ?? 3)) {
    const until = new Date(now + (comp.backoffMinutes ?? 10) * 60000).toISOString()
    await bumpState({ pausedUntil: until, dismissStreak: 0, lastFrameAt: nowIso() })
    log.info(`伴随模式：连续被忽略 ${comp.dismissStreakLimit ?? 3} 次，自动安静到 ${until.slice(11, 16)}`)
    return { skipped: 'dismiss_backoff', until }
  }
  const attention = await checkAttention({ channel: 'companion' })
  if (!attention.allow) return { skipped: attention.reason }

  // 走到这里才调模型
  const facts = await retrieve(body, { topK: 3 }).catch(() => [])
  const core = await loadCore().catch(() => '')
  const recent = (await readBubbles()).slice(-3).map((b) => `[${SCENARIOS[b.scenario]?.label ?? b.scenario}] ${b.bubble}${b.status === 'dismissed' ? '（他忽略了）' : ''}`)
  const started = Date.now()
  let out
  try {
    out = await jsonTask({
      system: `${SYSTEM}\n\n场景提示：${(comp.scenarios ?? Object.keys(SCENARIOS)).map((k) => SCENARIOS[k]?.hint).filter(Boolean).join('\n')}`,
      user: [
        `应用：${app ?? '未知'}｜窗口：${title ?? '未知'}｜时间：${nowIso()}`,
        core ? `<关于用户>\n${clip(core, 500)}` : '',
        facts.length ? `<相关记忆>\n${facts.map((f) => `- ${f.text}`).join('\n')}` : '',
        recent.length ? `<刚才冒过的泡（别重复）>\n${recent.join('\n')}` : '',
        '',
        '<屏幕上的文字（本地 OCR，可能有错字）>',
        clip(body, 1600),
      ]
        .filter(Boolean)
        .join('\n'),
      model: comp.model || cfg.upstream.utilityModel || cfg.upstream.defaultModel,
      maxTokens: 260,
      temperature: 0.7,
      timeoutMs: 25000,
      schemaHint: '{"speak":true,"scenario":"","topic":"","bubble":"","why":""}',
    })
  } catch (err) {
    record({ kind: 'companion', ok: false, error: err.message.slice(0, 120) })
    return { skipped: 'model_error', error: err.message }
  }
  const ms = Date.now() - started
  const j = out.json ?? {}
  const scenario = SCENARIOS[j.scenario] ? j.scenario : 'other'
  const bubbleText = stripTags(String(j.bubble ?? '')).slice(0, 120)
  record({ kind: 'companion', ok: true, ms, scenario, spoke: Boolean(j.speak), chars: body.length, sim: Number(sim.toFixed(3)) })

  if (!j.speak || !bubbleText || !(comp.scenarios ?? Object.keys(SCENARIOS)).includes(scenario)) {
    await bumpState({ lastFrameText: body, lastFrameAt: nowIso(), framesToday: (c.framesToday ?? 0) + 1 })
    return { skipped: j.speak ? 'scenario_off' : 'decided_quiet', scenario, ms }
  }

  const freshCfg = await loadConfig()
  if (!freshCfg.companion?.enabled || !(freshCfg.companion.scenarios ?? Object.keys(SCENARIOS)).includes(scenario)) return { skipped: 'disabled' }
  const evidence = [{ id: `frame_${Date.now().toString(36)}`, label: app ?? '屏幕', source: `screen:${app ?? 'unknown'}`, observedAt: ts ?? nowIso(), excerpt: clip(body, 600) }]
  const reservation = await reserveAttention({
    channel: 'companion', expiresAt: new Date(started + 60000).toISOString(),
    ...interventionKeys({ content: bubbleText, anchorId: `screen:${app ?? ''}:${title ?? ''}`, evidence }),
  })
  // Do not advance the comparison baseline: retry after the attention state changes.
  if (!reservation.allow) return { skipped: reservation.reason }
  const bubble = {
    id: `b_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    ts: nowIso(),
    scenario,
    topic: stripTags(String(j.topic ?? '')).slice(0, 24) || SCENARIOS[scenario].label,
    bubble: bubbleText,
    why: stripTags(String(j.why ?? '')).slice(0, 200),
    status: 'pending',
    frame: { app: stripTags(app ?? '').slice(0, 40), title: stripTags(title ?? '').slice(0, 80) },
    excerpt: clip(body, 600),
    evidence,
    ms,
  }
  let written = false
  let blocked = null
  try {
    await mutateBubbles(async (rows) => {
      const gate = await checkAttention({ channel: 'companion', reservationToken: reservation.token, expiresAt: new Date(started + 60000).toISOString() })
      if (!gate.allow) blocked = gate.reason
      else rows.push(bubble)
    })
    if (blocked) {
      await finishAttention(reservation.token, { delivered: false })
      return { skipped: blocked }
    }
    written = true
    const { mutateState } = await import('./store.mjs')
    await mutateState((s) => {
      const prev = s.companion ?? {}
      const key = new Date().toISOString().slice(0, 13)
      const count = prev.hourly?.key === key ? prev.hourly.count ?? 0 : 0
      s.companion = {
        ...prev, lastBubbleAt: bubble.ts, lastFrameText: body, lastFrameAt: nowIso(),
        framesToday: (prev.framesToday ?? 0) + 1, hourly: { key, count: count + 1 },
      }
      return s
    })
    await finishAttention(reservation.token)
  } catch (err) {
    await finishAttention(reservation.token, { delivered: written })
    throw err
  }
  log.info(`伴随气泡 [${scenario}] ${bubbleText}`)
  return { bubble }
}

/** 悬浮窗自动淡出：标记过期，**不计入**退避（用户并没有拒绝，只是没看） */
export async function expireBubble(id, { reason = 'autohide' } = {}) {
  const b = await updateBubble(id, { status: 'expired', expiredAt: nowIso(), expireReason: reason })
  if (!b) return null
  record({ kind: 'companion_feedback', action: 'expire', scenario: b.scenario })
  return b
}

export async function dismissBubble(id, { reason } = {}) {
  const b = await updateBubble(id, { status: 'dismissed', dismissedAt: nowIso(), dismissReason: reason ?? null })
  if (!b) return null
  const state = await readJSON(path.join(DATA, 'state.json'), {})
  await bumpState({ dismissStreak: (state?.companion?.dismissStreak ?? 0) + 1 })
  record({ kind: 'companion_feedback', action: 'dismiss', scenario: b.scenario })
  return b
}

/** 点开气泡：为他建一个聚焦该话题的小会话（同一话题复用），并把上下文放进去 */
export async function openBubble(id) {
  const rows = await readBubbles()
  const b = rows.find((x) => x.id === id)
  if (!b) return null
  const { createConversation, getConversation, saveConversation } = await import('./store.mjs')
  let conv = b.conversationId ? await getConversation(b.conversationId) : null
  if (!conv) {
    conv = await createConversation({ title: `伴随 · ${b.topic}` })
    const scene = [b.frame.app, b.frame.title].filter(Boolean).join(' · ')
    conv.messages.push({
      id: `m_${b.id}`,
      role: 'assistant',
      content: `（伴随模式）我注意到：${scene ? `${scene}。` : ''}${b.bubble}\n\n原因：${b.why}\n\n想细聊就接着问——这轮对话独立保存，不会混进别的会话。`,
      companion: { bubbleId: b.id, scenario: b.scenario, excerpt: b.excerpt },
      createdAt: nowIso(),
      model: 'companion',
    })
    await saveConversation(conv)
    await updateBubble(id, { status: 'opened', openedAt: nowIso(), conversationId: conv.id })
    record({ kind: 'companion_feedback', action: 'open', scenario: b.scenario })
    await bumpState({ dismissStreak: 0 })
    return { bubble: { ...b, status: 'opened', conversationId: conv.id }, conversationId: conv.id, conversation: conv }
  }
  await updateBubble(id, { status: 'opened', openedAt: nowIso() })
  void rows
  return { bubble: b, conversationId: conv.id, conversation: conv }
}

/** 暂停/恢复（状态栏与设置页都用它） */
export async function setCompanion({ enabled, pauseMinutes, scenarios, hourlyBudget, minGapSeconds, intervalSeconds } = {}) {
  const { saveConfig } = await import('./config.mjs')
  const patch = {}
  if (enabled !== undefined) patch.enabled = Boolean(enabled)
  if (scenarios) patch.scenarios = scenarios.filter((s) => SCENARIOS[s])
  if (hourlyBudget !== undefined) patch.hourlyBudget = Math.max(1, Math.min(60, Number(hourlyBudget)))
  if (minGapSeconds !== undefined) patch.minGapSeconds = Math.max(20, Math.min(900, Number(minGapSeconds)))
  if (intervalSeconds !== undefined) patch.intervalSeconds = Math.max(5, Math.min(300, Number(intervalSeconds)))
  if (Object.keys(patch).length) await saveConfig({ companion: patch })
  if (pauseMinutes !== undefined) {
    const until = pauseMinutes > 0 ? new Date(Date.now() + pauseMinutes * 60000).toISOString() : null
    await bumpState({ pausedUntil: until, ...(pauseMinutes > 0 ? {} : { dismissStreak: 0 }) })
    log.info(pauseMinutes > 0 ? `伴随模式暂停 ${pauseMinutes} 分钟` : '伴随模式恢复')
  }
  return companionStatus()
}

export { SCENARIOS }
