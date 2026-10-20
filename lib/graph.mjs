import path from 'node:path'
import { promises as fs } from 'node:fs'
import { P, loadConfig } from './config.mjs'
import { readJSON, writeJSON, clip, stripTags, nowIso, tokenize } from './util.mjs'
import { jsonTask } from './native.mjs'
import { log } from './log.mjs'

/**
 * 轻量实体图：把记忆里的"人/项目/工具/话题"抽成节点，把关系抽成边。
 * 作用是在检索时做实体召回——问"Echo 这个项目"时，能把散落各处的相关事实一起捞出来。
 * 坐标：Zep/Graphiti 的时序知识图谱，这里是它的极简本地版（不含向量、无外部依赖）。
 */

const FILE = path.join(path.dirname(P.memoryObs), 'graph.json')
const TYPES = ['project', 'person', 'tool', 'topic', 'org', 'place', 'file']
const RELATION_TYPES = ['works_on', 'uses', 'prefers', 'depends_on', 'related', 'about']

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const nodeId = (name) => `e_${Buffer.from(norm(name)).toString('hex').slice(0, 20)}`

export async function loadGraph() {
  const g = await readJSON(FILE, null)
  return g ?? { nodes: [], edges: [], at: null, runs: 0 }
}

export async function graphStats() {
  const g = await loadGraph()
  return {
    nodes: g.nodes.length,
    edges: g.edges.length,
    updatedAt: g.at,
    runs: g.runs ?? 0,
    top: [...g.nodes].sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0)).slice(0, 8).map((n) => ({ name: n.name, type: n.type, mentions: n.mentions })),
  }
}

function mergeEntity(g, item, obsId) {
  const name = stripTags(item?.name ?? '').slice(0, 60)
  if (name.length < 2) return null
  const id = nodeId(name)
  let node = g.nodes.find((n) => n.id === id || n.aliases?.some((a) => norm(a) === norm(name)) || norm(n.name) === norm(name))
  if (!node) {
    node = {
      id,
      name,
      type: TYPES.includes(item.type) ? item.type : 'topic',
      aliases: Array.isArray(item.aliases) ? item.aliases.map((a) => stripTags(a).slice(0, 40)).filter(Boolean).slice(0, 4) : [],
      mentions: 0,
      obsIds: [],
      first_seen: nowIso(),
      last_seen: nowIso(),
    }
    g.nodes.push(node)
  }
  node.mentions = (node.mentions ?? 0) + 1
  node.last_seen = nowIso()
  if (item.type && TYPES.includes(item.type) && node.type === 'topic') node.type = item.type
  if (obsId && !node.obsIds.includes(obsId)) node.obsIds = [...node.obsIds, obsId].slice(-60)
  return node
}

function mergeEdge(g, rel, obsId, nodeIndex) {
  const from = nodeIndex.get(norm(rel?.from))
  const to = nodeIndex.get(norm(rel?.to))
  if (!from || !to || from.id === to.id) return null
  const type = stripTags(rel.type ?? 'related').slice(0, 24) || 'related'
  const key = `${from.id}|${to.id}|${type}`
  let edge = g.edges.find((e) => e.key === key)
  if (!edge) {
    edge = { key, id: `r_${from.id.slice(2, 8)}_${to.id.slice(2, 8)}`, from: from.id, to: to.id, type, evidence: [], obsIds: [], count: 0, first_seen: nowIso(), last_seen: nowIso() }
    g.edges.push(edge)
  }
  edge.count = (edge.count ?? 0) + 1
  edge.last_seen = nowIso()
  if (rel.evidence) edge.evidence = [...edge.evidence, clip(stripTags(rel.evidence), 120)].slice(-4)
  if (obsId && !edge.obsIds.includes(obsId)) edge.obsIds = [...edge.obsIds, obsId].slice(-60)
  return edge
}

/** 用一批观察喂给模型抽实体/关系，再合并进图。 */
export async function buildGraph({ observations, cfg, maxObs = 40 } = {}) {
  const conf = cfg ?? (await loadConfig())
  const batch = (observations ?? []).slice(-maxObs).filter((o) => o.status === 'active' && !o.sensitive)
  if (!batch.length) return { skipped: 'no observations' }
  const listing = batch.map((o) => `[${o.id}] (${o.kind}, 来源 ${(o.sources?.length ? o.sources : [o.source ?? '未知']).join('、')}) ${clip(o.text, 160)}`).join('\n')
  let out
  try {
    out = await jsonTask({
      system: `从这些记忆条目里抽取实体和关系，构建个人知识图谱。只输出 JSON：
{"entities":[{"name":"规范名称","type":"project|person|tool|topic|org|place|file","aliases":["别名"]}],
 "relations":[{"from":"实体名","to":"实体名","type":"works_on|uses|prefers|depends_on|related|about","obs_id":"证据条目id","evidence":"来自该条目的原文短句"}],
 "mentions":[{"obs_id":"条目id","entity":"实体名"}]}
规则：实体名用最短的稳定写法（"Echo"而不是"这个 Echo 项目"）；只抽真正反复出现或重要的；人名一律用姓氏或首字母缩写，不要写全名；最多 8 个实体、10 条关系。
只保留用户明确提供的稳定事实与沟通约束，不从临时情绪、一次争执、语气、沉默、助手猜测或屏幕/OCR 推断性格、第三方动机、关系亲疏或关系质量。
每个实体必须有输入中真实的 mentions.obs_id；每条关系必须引用真实 obs_id 和该条目中的原文 evidence。保留来源和“用户描述”等归属，不能把转述变成客观事实；不支持的关系留空。`,
      user: listing,
      model: conf.upstream.utilityModel,
      maxTokens: 900,
      schemaHint: '{"entities":[],"relations":[],"mentions":[]}',
    })
  } catch (err) {
    log.warn('实体图抽取失败:', err.message)
    return { error: err.message }
  }
  const j = out.json
  if (!j) return { error: 'bad json' }
  const g = await loadGraph()
  const beforeNodes = g.nodes.length
  const index = new Map()
  const observationsById = new Map(batch.map((observation) => [observation.id, observation]))
  const mentions = (Array.isArray(j.mentions) ? j.mentions : []).filter((mention) => observationsById.has(mention?.obs_id))
  for (const e of (j.entities ?? []).slice(0, 12)) {
    const source = mentions.find((mention) => norm(mention.entity) === norm(e?.name))
    if (!source) continue
    const node = mergeEntity(g, e, source.obs_id)
    if (node) index.set(norm(node.name), node)
  }
  for (const n of g.nodes) index.set(norm(n.name), n)
  for (const m of mentions.slice(0, 60)) {
    const node = index.get(norm(m.entity))
    if (node && m.obs_id && !node.obsIds.includes(m.obs_id)) node.obsIds = [...node.obsIds, m.obs_id].slice(-60)
  }
  let edgeCount = 0
  for (const r of (j.relations ?? []).slice(0, 16)) {
    const evidence = String(r?.evidence ?? '').trim()
    const source = r?.obs_id ? observationsById.get(r.obs_id) : batch.find((observation) => evidence && norm(observation.text).includes(norm(evidence)))
    if (!source || !evidence || !RELATION_TYPES.includes(r.type) || !norm(source.text).includes(norm(evidence))) continue
    if (mergeEdge(g, r, source.id, index)) edgeCount++
  }
  g.at = nowIso()
  g.runs = (g.runs ?? 0) + 1
  // 容量：节点 400 / 边 800，按提及次数与新鲜度淘汰
  g.nodes = g.nodes.sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0)).slice(0, 400)
  const ids = new Set(g.nodes.map((n) => n.id))
  g.edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 800)
  await writeJSON(FILE, g)
  log.info(`实体图：+${g.nodes.length - beforeNodes} 节点 / +${edgeCount} 边（共 ${g.nodes.length} 节点 ${g.edges.length} 边）`)
  return { nodes: g.nodes.length, edges: g.edges.length, added: g.nodes.length - beforeNodes }
}

/** 找出查询里出现的实体（含别名），用于检索加权与实体召回。 */
export async function entitiesInQuery(query) {
  const g = await loadGraph()
  if (!g.nodes.length) return []
  const qTokens = new Set(tokenize(query))
  const q = norm(query)
  const hits = []
  for (const n of g.nodes) {
    const names = [n.name, ...(n.aliases ?? [])]
    for (const name of names) {
      const key = norm(name)
      if (key.length < 2) continue
      if (q.includes(key) || tokenize(name).some((t) => qTokens.has(t) && t.length > 2)) {
        hits.push(n)
        break
      }
    }
  }
  return hits.sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0)).slice(0, 5)
}

/** 实体视角的召回：节点 + 邻居 + 关联记忆条目 id。 */
export async function queryGraph(name) {
  const g = await loadGraph()
  const key = norm(name)
  const node = g.nodes.find((n) => norm(n.name) === key || n.aliases?.some((a) => norm(a) === key) || norm(n.name).includes(key))
  if (!node) return null
  const edges = g.edges.filter((e) => e.from === node.id || e.to === node.id)
  const neighborIds = edges.map((e) => (e.from === node.id ? e.to : e.from))
  const neighbors = g.nodes.filter((n) => neighborIds.includes(n.id))
  const obsIds = new Set(node.obsIds ?? [])
  for (const e of edges) for (const id of e.obsIds ?? []) obsIds.add(id)
  return {
    node,
    neighbors: neighbors.map((n) => ({ name: n.name, type: n.type, mentions: n.mentions })),
    edges: edges.map((e) => ({ type: e.type, from: g.nodes.find((n) => n.id === e.from)?.name, to: g.nodes.find((n) => n.id === e.to)?.name, evidence: e.evidence?.at(-1) ?? null, count: e.count })),
    obsIds: [...obsIds],
  }
}

export async function entitySummary() {
  const g = await loadGraph()
  return g.nodes
    .slice()
    .sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0))
    .slice(0, 12)
    .map((n) => ({ id: n.id, name: n.name, type: n.type, mentions: n.mentions, last_seen: n.last_seen, facts: (n.obsIds ?? []).length }))
}
