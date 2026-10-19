import { loadConfig, upstreamCreds } from './config.mjs'
import { getConversation, saveConversation, MAIN_ID } from './store.mjs'
import { streamChat } from './upstream.mjs'
import { buildToolRegistry, labelFor } from './tools.mjs'
import { buildMemoryContext } from './memory.mjs'
import { assembleContext } from './context.mjs'
import { workingContext } from './screen.mjs'
import { buildImageParts } from './media.mjs'
import { record } from './metrics.mjs'
import { newId, nowIso, clip } from './util.mjs'
import { log } from './log.mjs'

export function localTimeLine() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const d = new Date()
  const stamp = d.toLocaleString('zh-CN', { timeZone: tz, hour12: false })
  const weekday = d.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: tz })
  return `当前本机时间：${stamp} ${weekday}（时区 ${tz}）。所有相对日期（今天/明天/本周）以此为准，不要自己猜。`
}

function searchInstruction(mode, cfg) {
  if (!cfg.search.enabled || mode === 'off') return '联网工具本轮不可用；如果问题需要实时信息，直接说明你无法确认，不要编造。'
  const provider = cfg.search.provider === 'auto' ? '快速抓取引擎（可回退到阿里云托管搜索）' : cfg.search.provider
  if (mode === 'on') return `联网已强制开启（引擎：${provider}）。回答任何事实性问题前先 web_search，并在结论后列出来源域名；不要依赖记忆里的旧数据。`
  return `你可以调用 web_search / web_fetch（引擎：${provider}）。凡涉及实时信息、价格、汇率、天气、新闻、软件版本、用户机器之外的数据，先搜索再答，并在末尾给出来源。即使对话历史或长期记忆里出现过类似数字，也必须重新搜索核对——旧数据和记忆都不能当作来源。对纯代码/推理/闲聊不必搜索。`
}

export function buildSystemPrompt({ cfg, conv, memoryText, searchMode, screenText }) {
  const parts = [cfg.systemPrompt, localTimeLine()]
  if (conv?.isMain || conv?.id === MAIN_ID) {
    parts.push(
      '这里是「主对话」：一个长期存在的窗口，助手会不定时主动发消息跟进用户的事。你在这里的身份是持续陪伴的私人助理，可以延续之前话题，回复时保持上下文连贯，不要每次都重新自我介绍。',
    )
  }
  if (memoryText) parts.push(`本地长期记忆（可信度按时间衰减，与事实冲突时以搜索结果为准）：\n${memoryText}`)
  if (screenText) {
    parts.push(
      `${screenText}\n（这是本地屏幕感知的摘要，用来理解当下情境。自然地在回复中体现你了解他在忙什么，但不要逐条复述，也不要显得在监视。）`,
    )
  }
  parts.push(`搜索策略：${searchInstruction(searchMode, cfg)}`)
  parts.push(
    [
      '输出约定：',
      '- 默认用中文；简洁、具体、口语，先给结论再给理由。',
      '- 代码用 markdown 代码块并标注语言；不确定就说不确定。',
      '- 用了搜索就在结尾用一行列出来源（域名即可），不要重复粘贴大段原文。',
      '- 用户明确说"记住/以后都"时调用 memory_write。',
      '- 用户发来图片时直接看图回答，不要猜内容；需要画图/出图时调用 image_gen，把画面描述写具体。没有真正调用 image_gen 就不许说"画好了"。',
    ].join('\n'),
  )
  if (conv?.system) parts.push(`本对话额外设定：${conv.system}`)
  return parts.filter(Boolean).join('\n\n')
}

async function buildOne(m, cfg) {
  if (m.role === 'user') {
    const imageParts = m.images?.length ? await buildImageParts(m.images, cfg) : []
    if (!imageParts.length) return [{ role: 'user', content: String(m.content ?? '') }]
    return [{ role: 'user', content: [{ type: 'text', text: String(m.content ?? '（看图）') }, ...imageParts] }]
  }
  if (m.role === 'assistant') {
    const out = []
    const hasTools = Array.isArray(m.tools) && m.tools.length
    out.push({
      role: 'assistant',
      content: m.content ?? '',
      ...(hasTools ? { tool_calls: m.tools.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) } : {}),
    })
    if (hasTools) for (const t of m.tools) out.push({ role: 'tool', tool_call_id: t.id, content: clip(t.result ?? '(无结果)', 6000) })
    return out
  }
  return []
}

/**
 * Streaming agent turn. Yields UI events; persists the assistant message at the end.
 */
export async function* runTurn({ conversationId, userText, regenerate = false, searchMode, model, temperature, enableThinking, signal, mcp, images }) {
  const cfg = await loadConfig()
  const { apiKey, baseUrl } = upstreamCreds(cfg)
  if (!apiKey || !baseUrl) {
    yield {
      type: 'error',
      message: !apiKey
        ? '还没有配置模型 API Key。打开设置里的「引导」，或在 data/echo.env 里填 OPENAI_API_KEY。'
        : '还没有配置模型端点。打开设置里的「引导」填 Base URL，或在 data/echo.env 里填 OPENAI_BASE_URL。',
    }
    return
  }
  let conv = await getConversation(conversationId)
  if (!conv) {
    yield { type: 'error', message: '会话不存在' }
    return
  }

  if (regenerate) {
    while (conv.messages.length && conv.messages.at(-1).role === 'assistant') conv.messages.pop()
  } else if (userText != null) {
    const text = String(userText ?? '').trim()
    if (!text && !images?.length) {
      yield { type: 'error', message: '消息为空' }
      return
    }
    conv.messages.push({ id: newId('m'), role: 'user', content: text, images: images?.length ? images : undefined, createdAt: nowIso() })
  }
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    yield { type: 'error', message: '还没有用户消息' }
    return
  }

  const chosenModel = model ?? conv.model ?? cfg.upstream.defaultModel
  const mode = searchMode ?? conv.searchMode ?? (cfg.search.enabled ? 'auto' : 'off')
  conv.model = chosenModel
  conv.searchMode = mode
  await saveConversation(conv)

  const memory = await buildMemoryContext({ query: lastUser.content, cfg })
  const screen = await workingContext().catch(() => ({ text: '' }))
  const system = buildSystemPrompt({ cfg, conv, memoryText: memory.text, searchMode: mode, screenText: screen.text })
  const tools = buildToolRegistry({ cfg, mcp, conversationId, searchMode: mode })

  const assembly = await assembleContext({ cfg, conv, memoryText: memory.text, screenText: screen.text, systemText: system })
  const systemWithDigest = assembly.digest
    ? `${system}\n\n<较早对话的摘要>\n${assembly.digest}\n</较早对话的摘要>`
    : system
  const messages = (await Promise.all(assembly.slice.map((m) => buildOne(m, cfg)))).flat()

  const assistant = {
    id: newId('m'),
    role: 'assistant',
    content: '',
    reasoning: '',
    model: chosenModel,
    tools: [],
    createdAt: nowIso(),
    usage: null,
    searchMode: mode,
    recalled: memory.used,
  }

  yield { type: 'meta', conversationId, messageId: assistant.id, model: chosenModel, searchMode: mode, memory: memory.used, system }

  const maxRounds = Math.max(1, cfg.search.maxToolRounds ?? 8)
  let round = 0
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 }
  const addUsage = (u) => {
    if (!u) return
    totalUsage.prompt_tokens += u.prompt_tokens ?? 0
    totalUsage.completion_tokens += u.completion_tokens ?? 0
    totalUsage.reasoning_tokens += u.completion_tokens_details?.reasoning_tokens ?? 0
  }

  try {
    const chain = [chosenModel, ...(cfg.upstream.fallback ?? []).filter((m) => m && m !== chosenModel)]
    let modelIdx = 0
    while (round < maxRounds) {
      round++
      const useModel = chain[Math.min(modelIdx, chain.length - 1)]
      const body = {
        model: useModel,
        messages: [{ role: 'system', content: systemWithDigest }, ...messages],
        max_tokens: cfg.upstream.maxTokens ?? 8000,
        temperature: temperature ?? cfg.generation.temperature ?? 0.6,
        enable_thinking: enableThinking ?? cfg.generation.enableThinking ?? false,
      }
      const wantTools = tools.defs.length > 0
      if (wantTools) {
        body.tools = tools.defs
        body.tool_choice = 'auto'
      }

      const notices = []
      const gen = streamChat({
        body,
        baseUrl,
        apiKey,
        signal,
        onRetry: (err, attempt) => notices.push(`上游重试 ${attempt}/2：${String(err?.message ?? err).slice(0, 80)}`),
      })
      let result
      let emitted = false
      let roundText = ''
      try {
        while (true) {
          const step = await gen.next()
          if (step.done) {
            result = step.value
            break
          }
          const ev = step.value
          if (ev.type === 'reasoning') {
            emitted = true
            assistant.reasoning += ev.text
            yield { type: 'reasoning', text: ev.text, round }
          } else if (ev.type === 'delta') {
            emitted = true
            roundText += ev.text
            yield { type: 'delta', text: ev.text, round }
          }
        }
      } catch (err) {
        const recoverable = !emitted && modelIdx + 1 < chain.length && !signal?.aborted
        if (!recoverable) throw err
        modelIdx++
        record({ kind: 'error', where: `model:${useModel}`, message: err.message })
        log.warn(`模型 ${useModel} 失败，降级到 ${chain[modelIdx]}：${err.message.slice(0, 90)}`)
        yield { type: 'notice', text: `模型 ${useModel} 不可用（${String(err.message).slice(0, 60)}），已切到 ${chain[modelIdx]}` }
        assistant.fallbackFrom = assistant.fallbackFrom ?? useModel
        round--
        continue
      }
      if (useModel !== chosenModel) assistant.fallbackFrom = assistant.fallbackFrom ?? chosenModel
      assistant.servedModel = useModel
      addUsage(result?.usage)
      for (const text of notices) yield { type: 'notice', text }
      if (result?.content && !roundText) roundText = result.content
      if (result?.reasoning && assistant.reasoning.length < result.reasoning.length) assistant.reasoning = result.reasoning
      if (roundText.trim()) {
        assistant.content += (assistant.content.trim() ? '\n\n' : '') + roundText.trim()
      }
      const calls = result?.toolCalls ?? []
      if (!calls.length) {
        assistant.finishReason = result?.finishReason ?? null
        break
      }

      messages.push({ role: 'assistant', content: result?.content ?? '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) })
      for (const call of calls) {
        const entry = { id: call.id, name: call.name, label: labelFor(call.name), args: call.args ?? {}, startedAt: nowIso() }
        assistant.tools.push(entry)
        yield { type: 'tool_call', id: call.id, name: call.name, label: entry.label, args: call.args, round }
        try {
          const out = await tools.call(call.name, call.args)
          entry.ok = true
          entry.result = out.text
          entry.ms = out.ms
          record({ kind: 'tool', name: call.name, ok: true, ms: out.ms })
          entry.sources = out.sources ?? undefined
          if (out.sources?.length) yield { type: 'sources', items: out.sources }
          if (out.images?.length) {
            entry.images = out.images
            assistant.images = [...(assistant.images ?? []), ...out.images]
            yield { type: 'images', items: out.images }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: clip(out.text, 8000) })
          yield { type: 'tool_result', id: call.id, ok: true, preview: clip(out.text, 1400), ms: out.ms, round }
        } catch (err) {
          entry.ok = false
          entry.result = `工具失败：${err.message}`
          record({ kind: 'tool', name: call.name, ok: false, error: err.message })
          record({ kind: 'error', where: `tool:${call.name}`, message: err.message })
          messages.push({ role: 'tool', tool_call_id: call.id, content: entry.result })
          yield { type: 'tool_result', id: call.id, ok: false, error: err.message, round }
          log.warn(`工具 ${call.name} 失败:`, err.message)
        }
      }
    }
    assistant.usage = totalUsage
    assistant.toolsFinished = true
    assistant.context = assembly.pressure
    if (!assistant.images?.length && /画好了|已生成|已经画|生成完成|画完了|出图完成/.test(assistant.content ?? '')) {
      assistant.warning = 'claimed_image_without_tool'
      yield { type: 'notice', text: '这条回复说已经出图，但没有真正调用 image_gen。回一句"重新画一次"即可让它真的生成。' }
    }
    conv = await getConversation(conversationId)
    conv.messages.push(assistant)
    await saveConversation(conv)
    yield { type: 'done', message: assistant, usage: totalUsage, rounds: round, sources: tools.sources }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      assistant.aborted = true
      assistant.usage = totalUsage
      assistant.toolsFinished = true
      conv = await getConversation(conversationId)
      if (assistant.content || assistant.tools.length) conv.messages.push(assistant)
      await saveConversation(conv)
      yield { type: 'done', message: assistant, aborted: true, usage: totalUsage, rounds: round, sources: tools.sources }
      return
    }
    log.error('turn 失败:', err.message)
    yield { type: 'error', message: err.message ?? String(err), status: err.status }
  }
}
