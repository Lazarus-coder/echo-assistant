import path from 'node:path'
import { promises as fs } from 'node:fs'
import { DATA } from './config.mjs'
import { nowIso } from './util.mjs'

/** 自我测量的数据源：每次生成、每次工具调用、每次主动决策都落一条。 */
const FILE = path.join(DATA, 'metrics.jsonl')
const MAX_ROWS = 4000
let buf = []
let writing = false

export function record(event) {
  buf.push({ ts: nowIso(), ...event })
  if (!writing) {
    writing = true
    setTimeout(flush, 1500)
  }
}

async function flush() {
  writing = false
  if (!buf.length) return
  const rows = buf
  buf = []
  try {
    await fs.mkdir(DATA, { recursive: true })
    await fs.appendFile(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const st = await fs.stat(FILE).catch(() => null)
    if (st && st.size > 2_000_000) {
      const raw = await fs.readFile(FILE, 'utf8')
      const lines = raw.split('\n').filter(Boolean).slice(-MAX_ROWS)
      await fs.writeFile(FILE, lines.join('\n') + '\n')
    }
  } catch {}
}

export async function readMetrics({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 86400000
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
      .filter((r) => r && Date.parse(r.ts) >= cutoff)
  } catch {
    return []
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export async function metricsSummary({ days = 7 } = {}) {
  const rows = await readMetrics({ days })
  const turns = rows.filter((r) => r.kind === 'turn')
  const tools = rows.filter((r) => r.kind === 'tool')
  const searches = rows.filter((r) => r.kind === 'search')
  const proactive = rows.filter((r) => r.kind === 'proactive')
  const errors = rows.filter((r) => r.kind === 'error')
  const byEngine = {}
  for (const s of searches) {
    byEngine[s.engine ?? '?'] ??= { count: 0, ms: [], ok: 0 }
    byEngine[s.engine ?? '?'].count++
    if (s.ms) byEngine[s.engine ?? '?'].ms.push(s.ms)
    if (s.ok) byEngine[s.engine ?? '?'].ok++
  }
  const byTool = {}
  for (const t of tools) {
    byTool[t.name ?? '?'] ??= { count: 0, ok: 0, ms: [] }
    byTool[t.name ?? '?'].count++
    if (t.ok) byTool[t.name ?? '?'].ok++
    if (t.ms) byTool[t.name ?? '?'].ms.push(t.ms)
  }
  const acted = proactive.filter((p) => p.acted)
  const replied = rows.filter((r) => r.kind === 'proactive_reply')
  return {
    window: `${days} 天`,
    turns: {
      count: turns.length,
      ok: turns.filter((t) => t.ok).length,
      errorRate: turns.length ? Number((1 - turns.filter((t) => t.ok).length / turns.length).toFixed(3)) : 0,
      avgMs: turns.length ? Math.round(turns.reduce((a, t) => a + (t.ms ?? 0), 0) / turns.length) : 0,
      p95Ms: pct(turns.map((t) => t.ms ?? 0), 95),
      avgRounds: turns.length ? Number((turns.reduce((a, t) => a + (t.rounds ?? 1), 0) / turns.length).toFixed(2)) : 0,
      tokensIn: turns.reduce((a, t) => a + (t.usage?.prompt_tokens ?? 0), 0),
      tokensOut: turns.reduce((a, t) => a + (t.usage?.completion_tokens ?? 0), 0),
      models: turns.reduce((acc, t) => ({ ...acc, [t.model ?? '?']: (acc[t.model ?? '?'] ?? 0) + 1 }), {}),
    },
    tools: Object.fromEntries(
      Object.entries(byTool).map(([k, v]) => [k, { count: v.count, okRate: Number((v.ok / v.count).toFixed(2)), p50Ms: pct(v.ms, 50), p95Ms: pct(v.ms, 95) }]),
    ),
    search: Object.fromEntries(
      Object.entries(byEngine).map(([k, v]) => [k, { count: v.count, okRate: Number((v.ok / v.count).toFixed(2)), p50Ms: pct(v.ms, 50), p95Ms: pct(v.ms, 95) }]),
    ),
    proactive: {
      checks: proactive.length,
      acted: acted.length,
      replyRate: acted.length ? Number((replied.length / acted.length).toFixed(2)) : null,
      byKind: acted.reduce((acc, p) => ({ ...acc, [p.kind ?? '?']: (acc[p.kind ?? '?'] ?? 0) + 1 }), {}),
    },
    errors: {
      count: errors.length,
      top: Object.entries(errors.reduce((acc, e) => ({ ...acc, [e.where ?? '?']: (acc[e.where ?? '?'] ?? 0) + 1 }), {}))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    },
  }
}