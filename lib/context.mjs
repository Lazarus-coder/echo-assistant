import { loadConfig, upstreamCreds } from './config.mjs'
import { getConversation, saveConversation } from './store.mjs'
import { complete } from './upstream.mjs'
import { clip, nowIso } from './util.mjs'
import { log } from './log.mjs'

/**
 * 上下文装配：像 MemGPT 那样把有限的上下文窗口当成预算来分配，
 * 而不是把历史一路塞进去。超出的部分靠滚动摘要（digest）承载。
 */

export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) cjk++
  const rest = s.length - cjk
  return Math.round(cjk * 1 + rest / 4)
}

const est = (m) => estimateTokens(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')) + 8

export async function assembleContext({ cfg, conv, memoryText, screenText, systemText }) {
  const budgetChars = cfg.upstream?.contextChars ?? 120000
  const budgetTokens = estimateTokens('x'.repeat(budgetChars)) // 上限的 token 估算
  const systemTokens = estimateTokens(systemText) + estimateTokens(memoryText) + estimateTokens(screenText)
  const digestTokens = estimateTokens(conv?.digest?.text ?? '')
  const reserve = systemTokens + digestTokens + 1200 // 给工具结果和回复留余量
  const historyBudget = Math.max(2000, budgetTokens - reserve)

  const messages = conv?.messages ?? []
  const coveredIds = new Set(conv?.digest?.covers ?? [])
  const wire = []
  let used = 0
  let cutoff = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const size = est(m) + (m.tools?.length ? m.tools.reduce((a, t) => a + estimateTokens(t.result ?? ''), 0) : 0)
    if (used + size > historyBudget && wire.length >= 2) break
    used += size
    cutoff = i
    wire.unshift(m)
  }

  // 摘要必须覆盖到"没有原文"的那一段，否则会丢中间的历史
  const firstKeptCovered = coveredIds.has(messages[cutoff]?.id)
  const uncoveredBefore = messages.slice(0, cutoff).filter((m) => !coveredIds.has(m.id))
  const pressure = {
    budgetTokens,
    usedTokens: used + reserve,
    historyTokens: used,
    keepFrom: cutoff,
    uncovered: uncoveredBefore.length,
    ratio: Number(((used + reserve) / budgetTokens).toFixed(3)),
  }

  return {
    slice: wire,
    coverage: { startIndex: cutoff, toId: messages[cutoff]?.id ?? null, firstKeptCovered },
    digest: conv?.digest?.text ?? '',
    pressure,
    shouldSummarize: uncoveredBefore.length >= (cfg.memory?.digestEvery ?? 12) || pressure.ratio > 0.85,
  }
}

/** 把已经滑出上下文的那段历史压成摘要，追加到 conv.digest。 */
export async function updateDigest({ conv, cfg, force = false }) {
  const messages = conv?.messages ?? []
  const covers = new Set(conv?.digest?.covers ?? [])
  const cutoff = conv?.digest?.uptoIndex ?? 0
  const pending = messages.slice(cutoff).filter((m) => !covers.has(m.id))
  if (!force && pending.length < (cfg.memory?.digestEvery ?? 12)) return { updated: false, pending: pending.length }
  if (!pending.length) return { updated: false, pending: 0 }

  const { apiKey, baseUrl } = upstreamCreds()
  if (!apiKey) return { updated: false, error: 'no key' }
  const transcript = pending
    .map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'}${m.proactive ? '[主动]' : ''}: ${clip(String(m.content ?? '').replace(/\s+/g, ' '), 260)}`)
    .join('\n')
  const prior = conv?.digest?.text ?? '(无)'
  try {
    const out = await complete({
      baseUrl,
      apiKey,
      body: {
        model: cfg.upstream.utilityModel,
        max_tokens: 700,
        temperature: 0.2,
        enable_thinking: false,
        messages: [
          {
            role: 'system',
            content:
              '你在为一段长期对话维护摘要。把"已有摘要"和"新增对话"合并成一份新的摘要：保留结论、决定、未完成的事项、用户的偏好与上下文；丢掉寒暄和重复；不要添加原文没有的内容。用简洁中文，不超过 400 字，分点写。',
          },
          { role: 'user', content: `已有摘要：\n${prior}\n\n新增对话：\n${transcript}` },
        ],
      },
    })
    const text = clip(String(out.content ?? '').trim(), cfg.memory?.digestMaxChars ?? 1800)
    if (!text) return { updated: false, error: 'empty' }
    const next = {
      text,
      covers: [...covers, ...pending.map((m) => m.id)].slice(-400),
      uptoIndex: messages.length,
      at: nowIso(),
      messagesCovered: (conv?.digest?.messagesCovered ?? 0) + pending.length,
    }
    await saveConversation({ ...conv, digest: next })
    log.info(`对话摘要已更新（覆盖 ${next.messagesCovered} 条消息，${text.length} 字）`)
    return { updated: true, digest: next, tokens: out.usage ?? null }
  } catch (err) {
    log.warn('摘要生成失败:', err.message)
    return { updated: false, error: err.message }
  }
}

export async function maybeDigest(conversationId, cfg) {
  const conv = await getConversation(conversationId)
  if (!conv) return { updated: false }
  const covers = new Set(conv.digest?.covers ?? [])
  const pending = (conv.messages ?? []).filter((m) => !covers.has(m.id))
  if (pending.length < (cfg.memory?.digestEvery ?? 12)) return { updated: false, pending: pending.length }
  const keepRecent = 10
  if (pending.length <= keepRecent) return { updated: false, pending: pending.length }
  return updateDigest({ conv, cfg })
}