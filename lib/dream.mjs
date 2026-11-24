import { languageText } from './language.mjs'
import { domainText } from './domain-language.mjs'
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

const dreamPrompt = () => domainText('dream.systemPrompt')

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
        .map((msg) => `${msg.role === 'user' ? domainText('dream.user') : domainText('dream.assistant')}${msg.proactive ? domainText('dream.proactive') : ''} [${conv.id}:${msg.id}]: ${clip(String(msg.content ?? '').replace(/\s+/g, ' '), 300)}`)
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
  parts.push(domainText('dream.localTime', new Date().toISOString(), dayString()))
  parts.push(domainText('dream.coreSection'))
  parts.push(ctx.core)
  parts.push(domainText('dream.observationsSection'))
  parts.push(
    ctx.obs.length
      ? ctx.obs
          .map(
            (o) =>
              domainText('dream.observation', o.id, o.kind, (o.sources?.length ? o.sources : [o.source ?? domainText('dream.unknown')]).join(languageText('、', ', ')), o.importance, o.hits ?? 1, strengthOf(o, { memory: { halfLifeDays: 14 } }), String(o.last_seen).slice(0, 10), o.text),
          )
          .join('\n')
      : domainText('dream.empty'),
  )
  parts.push(domainText('dream.fadingSection'))
  parts.push(
    ctx.faded.length
      ? ctx.faded.map((o) => domainText('dream.fadingEntry', o.id, o.kind, (o.sources?.length ? o.sources : [o.source ?? domainText('dream.unknown')]).join(languageText('、', ', ')), o.importance, o.hits ?? 1, o.strength, o.text)).join('\n')
      : domainText('dream.empty'),
  )
  if (ctx.screen?.text) {
    parts.push(domainText('dream.screenSection'))
    parts.push(ctx.screen.text)
  }
  parts.push(domainText('dream.followUpsSection'))
  parts.push(ctx.loops.length ? JSON.stringify(ctx.loops, null, 0) : domainText('dream.empty'))
  parts.push(domainText('dream.chatSection'))
  parts.push(ctx.recent.length ? ctx.recent.map((r) => `--- ${r.title} (${String(r.at).slice(0, 10)}) ---\n${r.transcript}`).join('\n') : domainText('dream.empty'))
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
        system: dreamPrompt(),
        user: buildPrompt(ctx),
        model: cfg.upstream.utilityModel,
        maxTokens: 2600,
        temperature: 0.2,
        timeoutMs: 120000,
        schemaHint:
          '{"core_memory_md":"...","facts":[],"forgot":[{"id":"","why":""}],"revived":[{"id":"","why":""}],"open_loops":[{"topic":"","why":"","due":"","status":"open","confidence":0.8}],"nudge_topics":[{"topic":"","angle":"","urgency":3,"why":""}],"insights":"..."}',
      })
    } catch (err) {
      log.error(domainText('dream.failed'), err.message)
      return { ok: false, error: err.message, trigger, at: new Date().toISOString() }
    }
    const j = out.json
    if (!j || typeof j !== 'object') return { ok: false, error: domainText('dream.parseError'), raw: clip(out.raw, 400), trigger }

    const summary = []
    if (typeof j.core_memory_md === 'string' && j.core_memory_md.trim().length > 40) {
      const nextCore = clip(j.core_memory_md.trim(), cfg.memory.coreMaxChars ?? 3200)
      if (nextCore !== ctx.core.trim()) {
        await saveCore(nextCore, { backup: true })
        summary.push(domainText('dream.coreChanged', ctx.core.length, nextCore.length))
      } else summary.push(domainText('dream.coreUnchanged'))
    }
    if (Array.isArray(j.facts) && j.facts.length) {
      const applied = await applyOps(j.facts, { source: `dream:${trigger}` })
      summary.push(domainText('dream.factsReconciled', applied.length, j.facts.length))
    }

    let forgotCount = 0
    for (const f of (Array.isArray(j.forgot) ? j.forgot : []).slice(0, 12)) {
      const id = String(f?.id ?? '')
      if (!id) continue
      const done = await forgetById(id, clip(String(f.why ?? domainText('dream.forgottenReason')), 160))
      if (done) forgotCount++
    }
    if (forgotCount) summary.push(domainText('dream.forgottenCount', forgotCount))

    let revivedCount = 0
    for (const r of (Array.isArray(j.revived) ? j.revived : []).slice(0, 12)) {
      const id = String(r?.id ?? '')
      if (!id) continue
      const back = await setProtected(id, true)
      if (back) revivedCount++
    }
    if (revivedCount) summary.push(domainText('dream.revivedCount', revivedCount))

    const scan = await forgetScan({ trigger: `dream:${trigger}` })
    if (scan.faded.length) summary.push(domainText('dream.fadedCount', scan.faded.length))

    try {
      const g = await buildGraph({ observations: await readObservations(), cfg })
      if (g?.nodes) summary.push(domainText('dream.graphCounts', g.nodes, g.edges))
    } catch (err) {
      log.warn(domainText('dream.graphFailed'), err.message)
    }
    const loops = normalizeLoops(j.open_loops, ctx.loops)
    const nudges = normalizeNudges(j.nudge_topics)
    if (typeof j.insights === 'string' && j.insights.trim()) {
      await appendObservation({ text: domainText('dream.progress', stripTags(j.insights)).slice(0, 300), kind: 'project', importance: 3, source: `dream:${trigger}` })
    }
    const at = new Date().toISOString()
    await mutateState((s) => {
      s.dream = { at, trigger, loops, nudges, insights: j.insights ?? '', ms: Date.now() - started }
      return s
    })
    await writeAudit({ trigger, at, before: ctx, after: { core: await loadCore(), loops, nudges, insights: j.insights, forgot: forgotCount, revived: revivedCount, faded: scan.faded.length }, summary, usage: out.usage })
    log.info(domainText('dream.finished', trigger, Date.now() - started, loops.length, nudges.length, forgotCount + scan.faded.length, revivedCount))
    const result = { ok: true, at, trigger, loops, nudges, summary, usage: out.usage, ms: Date.now() - started, forgetting: { forgot: forgotCount, revived: revivedCount, faded: scan.faded.length } }
    running = null
    return result
  })().catch((err) => {
    running = null
    log.error(domainText('dream.error'), err)
    return { ok: false, error: err.message, trigger }
  })
  return running
}

/** 一条线索"距今多少天"的唯一依据：Dream 每次整理会刷新 touched_at，所以它停了就说明 Echo 最近没看过这件事。 */
export function loopAgeDays(loop, nowMs = Date.now()) {
  const day = String(loop?.touched_at ?? loop?.opened_at ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const start = Date.parse(`${day}T00:00:00`)
  return Number.isFinite(start) ? Math.max(0, Math.floor((nowMs - start) / 86400000)) : null
}

export const LOOP_FRESH_DAYS = 7

export function isFreshLoop(loop, nowMs = Date.now()) {
  const age = loopAgeDays(loop, nowMs)
  return age !== null && age <= LOOP_FRESH_DAYS
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
    domainText('dream.trigger', trigger),
    domainText('dream.input', before.obs.length, before.recent.length, before.core.length),
    domainText('dream.result', summary.join(languageText('；', '; '))),
    usage ? `- tokens：in ${usage.prompt_tokens ?? '?'} / out ${usage.completion_tokens ?? '?'}` : '',
    '',
    domainText('dream.newFollowUps'),
    ...(after.loops.length ? after.loops.map((l) => `- [${l.status}] ${l.topic}${l.due ? domainText('dream.due', l.due) : ''} — ${l.why}`) : [domainText('dream.noEntries')]),
    '',
    domainText('dream.newTopics'),
    ...(after.nudges.length ? after.nudges.map((n) => domainText('dream.topic', n.urgency, n.topic, n.angle)) : [domainText('dream.noEntries')]),
    '',
    domainText('dream.assessment'),
    after.insights || domainText('dream.none'),
    '',
    domainText('dream.forgottenItems'),
    domainText('dream.forgottenSummary', after.forgot ?? 0, after.revived ?? 0, after.faded ?? 0),
    domainText('dream.logPath'),
    '',
    domainText('dream.coreChanges'),
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
  return [...removed, ...added].slice(0, 40).join('\n') || domainText('dream.minorChanges')
}

export async function dreamStatus() {
  const state = await readJSON(P.state, {})
  const files = await fs.readdir(P.dreams).catch(() => [])
  return {
    last: state?.dream?.at ?? null,
    running: dreamRunning(),
    loops: (state?.dream?.loops ?? []).map((loop) => ({ ...loop, ageDays: loopAgeDays(loop) })),
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
