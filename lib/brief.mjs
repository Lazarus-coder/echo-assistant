import { readState, getConversation, MAIN_ID } from './store.mjs'
import { readObservations } from './memory.mjs'
import { deadlineMilestone } from './deadlines.mjs'
import { clip, nowIso } from './util.mjs'

/**
 * 回来简报：用户离开一段时间后，把"这期间发生了什么、现在需要什么"聚合成一张卡。
 * 纯确定性聚合，不调用模型、不产生任何状态变更——默认静默，只在用户打开页面时出现。
 */
export async function returnBrief({ since } = {}) {
  const sinceMs = Number.isFinite(Date.parse(since ?? '')) ? Date.parse(since) : 0
  const state = await readState()
  const main = await getConversation(MAIN_ID)
  const items = []

  const proactive = (main?.messages ?? []).filter((m) => m.proactive && Date.parse(m.createdAt ?? '') > sinceMs)
  if (proactive.length) {
    const latest = proactive.at(-1)
    items.push({ kind: 'proactive', count: proactive.length, latest: { id: latest.id, preview: clip(String(latest.content ?? ''), 80) } })
  }

  const goals = (state.commitments ?? []).filter((g) => g.status === 'active')
  const due = goals
    .map((goal) => ({ goal, milestone: deadlineMilestone(goal) }))
    .filter((entry) => entry.milestone)
    .map(({ goal, milestone }) => ({ id: goal.id, title: goal.title, deadline: goal.deadline, stage: milestone.stage }))
  if (due.length) items.push({ kind: 'due', count: due.length, goals: due })

  const drafts = (state.preparations ?? []).filter((artifact) => artifact.delivery?.status === 'pending')
  if (drafts.length) items.push({ kind: 'drafts', count: drafts.length, drafts: drafts.slice(-3).map((artifact) => ({ id: artifact.id, title: artifact.title, commitmentId: artifact.commitmentId })) })

  const failed = goals.filter((goal) => goal.preparation?.state === 'failed')
  if (failed.length) items.push({ kind: 'failed', count: failed.length, goals: failed.map((goal) => ({ id: goal.id, title: goal.title, retryAt: goal.preparation?.retryAt ?? null })) })

  const tracked = new Set((state.commitments ?? []).map((g) => g.candidateLoopId).filter(Boolean))
  const loops = (state.dream?.loops ?? []).filter((loop) => loop.status !== 'done' && !tracked.has(loop.id))
  if (loops.length) items.push({ kind: 'loops', count: loops.length })

  if (sinceMs) {
    const facts = (await readObservations()).filter((o) => o.status === 'active' && Date.parse(o.created_at ?? '') > sinceMs)
    if (facts.length) items.push({ kind: 'facts', count: facts.length })
  }

  return { at: nowIso(), since: sinceMs ? new Date(sinceMs).toISOString() : null, items }
}
