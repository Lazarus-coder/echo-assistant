import path from 'node:path'
import { promises as fs } from 'node:fs'
import { P, loadConfig } from './config.mjs'
import { readJSON, clip, stripTags } from './util.mjs'
import { listConversations, getConversation, mutateState } from './store.mjs'
import { jsonTask } from './native.mjs'
import {
  loadCore,
  saveCore,
  readObservations,
  applyOps,
  appendObservation,
  strengthOf,
  forgetById,
  setProtected,
  forgetScan,
  recallForgetting,
} from './memory.mjs'
import { workingContext } from './screen.mjs'
import { buildGraph } from './graph.mjs'
import { log } from './log.mjs'

const DREAM_SYSTEM = `你是这个私人助手的"做梦"进程（离线记忆巩固，类似 sleep-time compute / reflection）。
现在没有用户在跟你对话，你的任务是把散落的观察提炼成稳定的长期记忆，并整理出值得之后主动跟进的事项。

核心原则：我们不是我们记住的东西，而是我们忘记的东西。
记忆的质量来自丢弃而不是堆积——你的第一职责是判断什么已经不再有下一轮价值，然后明确地忘掉它，并写清理由。宁少勿滥，不要为了输出而输出。

要求：
0. 只巩固用户明确提供且稳定的事实、偏好、约束与任务；保留条目来源、用户转述归属和不确定性。临时情绪、一次争执、语气或沉默不升级为长期性格、心理状态、第三方动机或关系质量。屏幕/OCR 与助手猜测不能成为这类结论的依据。
1. core_memory_md：重写核心记忆文件。保留原有小节结构（关于你 / 正在跟进 / 偏好与约定 / 待办与提醒），把重复的合并、过期的删掉、矛盾的用更近的观测覆盖。每节用短句要点，总长不超过 350 行字符上限。禁止编造没有依据的内容。已经不需要的条目要果断删掉——这正是你会被信任的原因。
2. facts：对观察清单做 ADD/UPDATE/DELETE 调和（引用已有 id）。
3. forgot：对"淡出候选"和清单里明显过期的条目，明确列出 id 与为什么可以忘。判断标准：一次性信息、任务已完成、期限已过、与用户长期目标无关、被更近的观测取代。不要把"想不起来为什么要记"当作忘记的理由。
4. revived：淡出候选里如果其实仍然重要（在推进的项目、长期偏好、待办依赖），列出 id 与理由，让它复活并受保护。
5. open_loops：用户明确目标或具体任务中值得后续跟进的事。字段 topic / why / due(YYYY-MM-DD，可空) / status(open|waiting_user|done) / confidence(0-1)。不能仅因情绪、关系猜测或未回复而创建跟进；用户明确要求的具体沟通任务可以保留。最多 8 条。
6. nudge_topics：已有事实支持的具体任务或信息线索，字段 topic / angle(怎么切入) / urgency(1-5) / why。情绪或关系猜测不能成为开口、关怀提醒或提高紧迫度的依据。宁少勿滥，最多 5 条；没有合适话题就给空数组。
7. insights：一两句话总结用户明确目标与可观察的进展，不做情绪、性格或人际关系画像。没有稳定依据就留空。`

let running = null

export function dreamRunning() {
  return Boolean(running)
}

function dayString(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

async function gatherContext(cfg) {
  const core = await loadCore()
  const all = await readObservations()
  const obs = all.filter((o) => o.status === 'active').slice(-(cfg.dream.observationWindow ?? 120))
  const faded = all
    .filter((o) => o.status === 'faded')
    .slice(-24)
    .map((o) => ({ ...o, strength: strengthOf(o, cfg) }))
  const metas = await listConversations()
  const recent = []
  for (const m of metas.slice(0, 6)) {
    const conv = await getConversation(m.id)
    if (!conv?.messages?.length) continue
    const tail = conv.messages.slice(-14)
    recent.push({
      title: conv.title,
      at: conv.updatedAt,
      transcript: tail
        .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}${msg.proactive ? '(主动)' : ''} [${conv.id}:${msg.id}]: ${clip(String(msg.content ?? '').replace(/\s+/g, ' '), 300)}`)
        .join('\n'),
    })
  }
  const state = await readJSON(P.state, {})
  const screen = await workingContext({ minutes: 180 }).catch(() => ({ text: '' }))
  const forgetting = await recallForgetting({ limit: 12 }).catch(() => ({ items: [], log: [] }))
  return {
    core,
    obs,
    faded,
    recent,
    screen,
    forgetting,
    loops: state?.dream?.loops ?? [],
    digestPending: metas.filter((m) => !m.digest).length,
  }
}

function buildPrompt(ctx) {
  const parts = []
  parts.push(`当前时间：${new Date().toISOString()} (${dayString()})`)
  parts.push('\n===== 现有核心记忆 (MEMORY.md) =====')
  parts.push(ctx.core)
  parts.push('\n===== 观察清单（带 id，可做 UPDATE/DELETE） =====')
  parts.push(
    ctx.obs.length
      ? ctx.obs
          .map(
            (o) =>
              `- [${o.id}] (${o.kind}, 来源 ${(o.sources?.length ? o.sources : [o.source ?? '未知']).join('、')}, 重要度${o.importance}, 命中${o.hits ?? 1}次, 强度${strengthOf(o, { memory: { halfLifeDays: 14 } })}, 最近 ${String(o.last_seen).slice(0, 10)}) ${o.text}`,
          )
          .join('\n')
      : '(空)',
  )
  parts.push('\n===== 淡出候选（已经记不清的；决定 forgot 还是 revived） =====')
  parts.push(
    ctx.faded.length
      ? ctx.faded.map((o) => `- [${o.id}] (${o.kind}, 来源 ${(o.sources?.length ? o.sources : [o.source ?? '未知']).join('、')}, 重要度${o.importance}, 命中${o.hits ?? 1}次, 强度${o.strength}) ${o.text}`).join('\n')
      : '(空)',
  )
  if (ctx.screen?.text) {
    parts.push('\n===== 用户最近的屏幕活动（本地 OCR 摘要） =====')
    parts.push(ctx.screen.text)
  }
  parts.push('\n===== 已有的跟进事项（可更新状态或保留） =====')
  parts.push(ctx.loops.length ? JSON.stringify(ctx.loops, null, 0) : '(空)')
  parts.push('\n===== 最近的对话片段 =====')
  parts.push(ctx.recent.length ? ctx.recent.map((r) => `--- ${r.title} (${String(r.at).slice(0, 10)}) ---\n${r.transcript}`).join('\n') : '(空)')
  return parts.join('\n')
}

export async function runDream({ trigger = 'schedule' } = {}) {
  if (running) return running
  running = (async () => {
    const cfg = await loadConfig()
    const started = Date.now()
    const ctx = await gatherContext(cfg)
    let out
    try {
      out = await jsonTask({
        system: DREAM_SYSTEM,
        user: buildPrompt(ctx),
        model: cfg.upstream.utilityModel,
        maxTokens: 2600,
        temperature: 0.2,
        timeoutMs: 120000,
        schemaHint:
          '{"core_memory_md":"...","facts":[],"forgot":[{"id":"","why":""}],"revived":[{"id":"","why":""}],"open_loops":[{"topic":"","why":"","due":"","status":"open","confidence":0.8}],"nudge_topics":[{"topic":"","angle":"","urgency":3,"why":""}],"insights":"..."}',
      })
    } catch (err) {
      log.error('Dream 失败:', err.message)
      return { ok: false, error: err.message, trigger, at: new Date().toISOString() }
    }
    const j = out.json
    if (!j || typeof j !== 'object') return { ok: false, error: 'JSON 解析失败', raw: clip(out.raw, 400), trigger }

    const summary = []
    if (typeof j.core_memory_md === 'string' && j.core_memory_md.trim().length > 40) {
      const nextCore = clip(j.core_memory_md.trim(), cfg.memory.coreMaxChars ?? 3200)
      if (nextCore !== ctx.core.trim()) {
        await saveCore(nextCore, { backup: true })
        summary.push(`核心记忆重写 ${ctx.core.length} → ${nextCore.length} 字符`)
      } else summary.push('核心记忆无变化')
    }
    if (Array.isArray(j.facts) && j.facts.length) {
      const applied = await applyOps(j.facts, { source: `dream:${trigger}` })
      summary.push(`事实调和 ${applied.length}/${j.facts.length}`)
    }

    let forgotCount = 0
    for (const f of (Array.isArray(j.forgot) ? j.forgot : []).slice(0, 12)) {
      const id = String(f?.id ?? '')
      if (!id) continue
      const done = await forgetById(id, clip(String(f.why ?? 'Dream 判定已无下一轮价值'), 160))
      if (done) forgotCount++
    }
    if (forgotCount) summary.push(`明确遗忘 ${forgotCount} 条`)

    let revivedCount = 0
    for (const r of (Array.isArray(j.revived) ? j.revived : []).slice(0, 12)) {
      const id = String(r?.id ?? '')
      if (!id) continue
      const back = await setProtected(id, true)
      if (back) revivedCount++
    }
    if (revivedCount) summary.push(`复活并保护 ${revivedCount} 条`)

    const scan = await forgetScan({ trigger: `dream:${trigger}` })
    if (scan.faded.length) summary.push(`自动淡出 ${scan.faded.length} 条`)

    try {
      const g = await buildGraph({ observations: await readObservations(), cfg })
      if (g?.nodes) summary.push(`实体图 ${g.nodes} 节点/${g.edges} 边`)
    } catch (err) {
      log.warn('实体图更新失败:', err.message)
    }
    const loops = normalizeLoops(j.open_loops, ctx.loops)
    const nudges = normalizeNudges(j.nudge_topics)
    if (typeof j.insights === 'string' && j.insights.trim()) {
      await appendObservation({ text: `阶段判断：${stripTags(j.insights)}`.slice(0, 300), kind: 'project', importance: 3, source: `dream:${trigger}` })
    }
    const at = new Date().toISOString()
    await mutateState((s) => {
      s.dream = { at, trigger, loops, nudges, insights: j.insights ?? '', ms: Date.now() - started }
      return s
    })
    await writeAudit({ trigger, at, before: ctx, after: { core: await loadCore(), loops, nudges, insights: j.insights, forgot: forgotCount, revived: revivedCount, faded: scan.faded.length }, summary, usage: out.usage })
    log.info(`Dream 完成 (${trigger}) ${Date.now() - started}ms · 跟进${loops.length} 话题${nudges.length} 遗忘${forgotCount + scan.faded.length} 复活${revivedCount}`)
    const result = { ok: true, at, trigger, loops, nudges, summary, usage: out.usage, ms: Date.now() - started, forgetting: { forgot: forgotCount, revived: revivedCount, faded: scan.faded.length } }
    running = null
    return result
  })().catch((err) => {
    running = null
    log.error('Dream 异常', err)
    return { ok: false, error: err.message, trigger }
  })
  return running
}

function normalizeLoops(raw, previous) {
  const list = Array.isArray(raw) ? raw : []
  const prevByIdentity = new Map(previous.map((l) => [loopKey(l.topic), l]))
  const today = dayString()
  const out = []
  for (const item of list) {
    if (!item?.topic) continue
    const key = loopKey(item.topic)
    const old = prevByIdentity.get(key)
    const due = normalizeDate(item.due)
    out.push({
      id: old?.id ?? `L${Date.now().toString(36)}${out.length}`,
      topic: clip(stripTags(item.topic), 120),
      why: clip(stripTags(item.why ?? ''), 200),
      due,
      status: ['open', 'waiting_user', 'done'].includes(item.status) ? item.status : 'open',
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? old?.confidence ?? 0.7))),
      opened_at: old?.opened_at ?? today,
      touched_at: today,
      raised: (old?.raised ?? 0) + 0,
    })
    prevByIdentity.delete(key)
  }
  return out.filter((l) => l.status !== 'done').slice(0, 8)
}

function normalizeNudges(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const n of list) {
    if (!n?.topic) continue
    out.push({
      id: `N${Date.now().toString(36)}${out.length}`,
      topic: clip(stripTags(n.topic), 120),
      angle: clip(stripTags(n.angle ?? ''), 200),
      why: clip(stripTags(n.why ?? ''), 200),
      urgency: Math.max(1, Math.min(5, Number(n.urgency) || 3)),
      at: new Date().toISOString(),
    })
  }
  return out.slice(0, 5)
}

function loopKey(t) {
  return String(t ?? '').replace(/\s+/g, '').slice(0, 24).toLowerCase()
}

function normalizeDate(v) {
  const s = String(v ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

async function writeAudit({ trigger, at, before, after, summary, usage }) {
  const stamp = at.replace(/[:.]/g, '-').slice(0, 16)
  const file = path.join(P.dreams, `dream-${stamp}.md`)
  const body = [
    `# Dream ${at}`,
    '',
    `- 触发：${trigger}`,
    `- 输入：观察 ${before.obs.length} 条 / 会话 ${before.recent.length} 个 / 核心记忆 ${before.core.length} 字符`,
    `- 结果：${summary.join('；')}`,
    usage ? `- tokens：in ${usage.prompt_tokens ?? '?'} / out ${usage.completion_tokens ?? '?'}` : '',
    '',
    '## 新的跟进事项',
    ...(after.loops.length ? after.loops.map((l) => `- [${l.status}] ${l.topic}${l.due ? `（截止 ${l.due}）` : ''} — ${l.why}`) : ['- (无)']),
    '',
    '## 新的主动话题',
    ...(after.nudges.length ? after.nudges.map((n) => `- (急迫度${n.urgency}) ${n.topic} — ${n.angle}`) : ['- (无)']),
    '',
    '## 阶段判断',
    after.insights || '(无)',
    '',
    '## 遗忘',
    `- 明确遗忘 ${after.forgot ?? 0} 条 · 复活 ${after.revived ?? 0} 条 · 自动淡出 ${after.faded ?? 0} 条`,
    '- 明细见 memory/forgetting.md',
    '',
    '## 核心记忆 diff（前 → 后）',
    '```',
    summarizeDiff(before.core, after.core),
    '```',
  ]
    .filter(Boolean)
    .join('\n')
  await fs.writeFile(file, body)
  return file
}

function summarizeDiff(a, b) {
  const la = String(a).split('\n')
  const lb = String(b).split('\n')
  const setA = new Set(la.map((l) => l.trim()))
  const setB = new Set(lb.map((l) => l.trim()))
  const removed = la.filter((l) => l.trim() && !setB.has(l.trim())).map((l) => `- ${l.trim()}`)
  const added = lb.filter((l) => l.trim() && !setA.has(l.trim())).map((l) => `+ ${l.trim()}`)
  return [...removed, ...added].slice(0, 40).join('\n') || '（结构微调，内容基本一致）'
}

export async function dreamStatus() {
  const state = await readJSON(P.state, {})
  const files = await fs.readdir(P.dreams).catch(() => [])
  return {
    last: state?.dream?.at ?? null,
    running: dreamRunning(),
    loops: state?.dream?.loops ?? [],
    nudges: state?.dream?.nudges ?? [],
    insights: state?.dream?.insights ?? '',
    runs: files.length,
  }
}

export async function updateLoop({ id, status, raised }) {
  return mutateState((s) => {
    const loops = s?.dream?.loops ?? []
    const target = loops.find((l) => l.id === id)
    if (target) {
      if (status) target.status = status
      if (typeof raised === 'number') target.raised = raised
      target.touched_at = dayString()
    }
    s.dream = { ...(s.dream ?? {}), loops }
    return s
  })
}
