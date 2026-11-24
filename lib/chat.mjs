import { domainText } from './domain-language.mjs'
import { languageText } from './language.mjs'
import { loadConfig, upstreamCreds } from './config.mjs'
import { isDeepStrictEqual } from 'node:util'
import { getConversation, mutateConversation, readState, MAIN_ID } from './store.mjs'
import { startRun, interruptedRunContext } from './harness.mjs'
import { buildRelationshipContext, relationshipGuidance } from './relationships.mjs'
import { createHmac } from 'node:crypto'
import { isDeepSeek, streamChat, thinkingOptions } from './upstream.mjs'
import { buildToolRegistry, labelFor } from './tools.mjs'
import { buildMemoryContext } from './memory.mjs'
import { assembleContext } from './context.mjs'
import { workingContext } from './screen.mjs'
import { recordUserEngagement } from './attention.mjs'
import { buildImageParts } from './media.mjs'
import { record } from './metrics.mjs'
import { newId, nowIso, clip, MODEL_TOOL_TEXT_LIMIT } from './util.mjs'
import { log } from './log.mjs'

export function localTimeLine() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const d = new Date()
  const stamp = d.toLocaleString(languageText('zh-CN', 'en'), { timeZone: tz, hour12: false })
  const weekday = d.toLocaleDateString(languageText('zh-CN', 'en'), { weekday: 'long', timeZone: tz })
  return domainText('chat.localTime', stamp, weekday, tz)
}

function searchInstruction(mode, cfg) {
  if (!cfg.search.enabled || mode === 'off') return domainText('chat.searchUnavailable')
  const provider = cfg.search.provider === 'auto' ? domainText('chat.fastSearch') : cfg.search.provider
  if (mode === 'on') return domainText('chat.searchRequired', provider)
  return domainText('chat.searchPolicy', provider)
}

export function buildSystemPrompt({ cfg, conv, memoryText, searchMode, screenText }) {
  const parts = [cfg.systemPrompt, localTimeLine()]
  if (conv?.isMain || conv?.id === MAIN_ID) {
    parts.push(
      domainText('chat.mainChat'),
    )
  }
  if (memoryText) parts.push(domainText('chat.memoryContext', memoryText))
  if (screenText) {
    parts.push(
      domainText('chat.screenContext', screenText),
    )
  }
  parts.push(domainText('chat.searchPolicyHeading', searchInstruction(searchMode, cfg)))
  parts.push(
    [
      domainText('chat.outputHeading'),
      domainText('chat.replyLanguage'),
      domainText('chat.codeFormatting'),
      domainText('chat.citeSources'),
      conv?.workspaceMode !== 'read_only' && domainText('chat.writeMemory'),
      conv?.workspaceMode !== 'read_only' && domainText('chat.images'),
    ].filter(Boolean).join('\n'),
  )
  if (conv?.system) parts.push(domainText('chat.chatSettings', conv.system))
  return parts.filter(Boolean).join('\n\n')
}

function completeToolHistory(history) {
  const out = []
  let pending = new Set()
  const closeBatch = () => {
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: domainText('chat.actionStopped') })
    pending = new Set()
  }
  for (const message of history) {
    if (message.role !== 'tool') closeBatch()
    out.push(message)
    if (message.tool_calls) pending = new Set(message.tool_calls.map((call) => call.id))
    if (message.role === 'tool') pending.delete(message.tool_call_id)
  }
  closeBatch()
  return out
}

function sameToolRequest(previous, next) {
  return previous.name === next.name && isDeepStrictEqual(previous.args ?? {}, next.args ?? {})
}

async function buildOne(m, cfg, reasoningConnection) {
  if (m.role === 'user') {
    const imageParts = m.images?.length ? await buildImageParts(m.images, cfg) : []
    if (!imageParts.length) return [{ role: 'user', content: String(m.content ?? '') }]
    return [{ role: 'user', content: [{ type: 'text', text: String(m.content ?? domainText('chat.imageOnly')) }, ...imageParts] }]
  }
  if (m.role === 'assistant') {
    let out = []
    if (Array.isArray(m.toolMessages) && m.toolMessages.length) {
      out = [...completeToolHistory(m.toolMessages), { role: 'assistant', content: m.finalContent ?? m.content ?? '' }]
    } else {
      const hasTools = Array.isArray(m.tools) && m.tools.length
      out.push({
        role: 'assistant',
        content: m.content ?? '',
        ...(hasTools ? { tool_calls: m.tools.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) } : {}),
      })
      if (hasTools) for (const t of m.tools) out.push({ role: 'tool', tool_call_id: t.id, content: clip(t.result ?? domainText('chat.emptyResult'), 6000) })
    }
    if (!reasoningConnection) return out
    const ends = m.reasoningReplay?.connection === reasoningConnection ? m.reasoningReplay.ends : []
    let round = 0, start = 0
    return out.map((message) => {
      if (message.role !== 'assistant') return message
      const end = ends?.[round++] ?? start
      const text = m.reasoning?.slice(start, end) ?? ''
      start = end
      return { ...message, reasoning_content: text }
    })
  }
  return []
}

/**
 * Streaming agent turn. Yields UI events; persists the assistant message at the end.
 */
export async function* runTurn({ conversationId, userText, editMessageId, regenerate = false, searchMode, model, temperature, enableThinking, signal, mcp, images, allowLocalTools = false, onToolEvent = () => {} }) {
  const cfg = await loadConfig()
  const { apiKey, baseUrl, apiKeyEnv, baseUrlEnv } = upstreamCreds(cfg)
  if (!apiKey || !baseUrl) {
    yield {
      type: 'error',
      message: !apiKey
        ? domainText('chat.missingKey', apiKeyEnv)
        : domainText('chat.missingEndpoint', baseUrlEnv),
    }
    return
  }
  let conv = await getConversation(conversationId)
  if (!conv) {
    yield { type: 'error', message: domainText('chat.missingChat') }
    return
  }

  let userMessageId
  if (regenerate) {
    while (conv.messages.length && conv.messages.at(-1).role === 'assistant') conv.messages.pop()
  } else if (userText != null || images?.length) {
    const text = String(userText ?? '').trim()
    if (!text && !images?.length) {
      yield { type: 'error', message: domainText('chat.emptyMessage') }
      return
    }
    userMessageId = newId('m')
    conv.messages.push({ id: userMessageId, role: 'user', content: text, images: images?.length ? images : undefined, createdAt: nowIso() })
  }
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    yield { type: 'error', message: domainText('chat.noUserMessage') }
    return
  }

  const switchedProvider = cfg.upstream.providerChangedAt && (conv.modelSelectedAt || conv.createdAt || '') < cfg.upstream.providerChangedAt
  const rememberedModel = switchedProvider && !cfg.upstream.models.some((entry) => entry.id === conv.model) ? null : conv.model
  const chosenModel = model || rememberedModel || cfg.upstream.defaultModel
  if (!chosenModel) { yield { type: 'error', message: domainText('chat.missingModel') }; return }
  const mode = searchMode ?? conv.searchMode ?? (cfg.search.enabled ? 'auto' : 'off')
  const userMessage = userMessageId ? conv.messages.find((m) => m.id === userMessageId) : null
  conv = await mutateConversation(conversationId, (current) => {
    if (editMessageId) {
      const index = current.messages.findIndex((m) => m.id === editMessageId && m.role === 'user')
      if (index < 0 || !userMessage || regenerate) throw new Error(domainText('chat.editConflict'))
      current.messages = current.messages.slice(0, index)
    }
    if (regenerate) while (current.messages.length && current.messages.at(-1).role === 'assistant') current.messages.pop()
    if (userMessage) current.messages.push(userMessage)
    current.model = chosenModel
    current.modelSelectedAt = nowIso()
    current.searchMode = mode
  })
  if (!conv) { yield { type: 'error', message: domainText('chat.chatDeleted') }; return }
  if (userMessage) await recordUserEngagement(conversationId, userMessage.createdAt, cfg)
    .catch((err) => log.warn(domainText('chat.sessionRecordFailed'), err.message))
  const persistReply = (message) => mutateConversation(conversationId, (current) => {
    // A cleared or edited turn must not be restored by a late result or abort.
    if (current.messages.some((m) => m.id === lastUser.id && m.content === lastUser.content) &&
      !current.messages.some((m) => m.id === message.id)) current.messages.push(message)
  })

  const memory = await buildMemoryContext({ query: lastUser.content, cfg })
  const screen = await workingContext().catch(() => ({ text: '' }))
  const state = await readState()
  const commitments = (state.commitments ?? []).filter((goal) => goal.status === 'active').slice(0, 8)
    .map((goal) => ({
      id: goal.id, title: goal.title, successCriteria: goal.successCriteria,
      nextAction: goal.nextAction, blocker: goal.blocker, deadline: goal.deadline,
      preparation: goal.preparation,
      origin: goal.origin ?? 'explicit', situation: goal.situation,
      deadlineAssessment: goal.deadlineAssessment,
    }))
  const relationshipQuery = {
    query: lastUser.content,
    recentUserTexts: conv.messages.filter((message) => message.role === 'user' && message.id !== lastUser.id).slice(-1).map((message) => message.content),
  }
  const relationshipContext = async () => {
    const latest = await loadConfig()
    return latest.memory?.enabled !== false && latest.memory?.inject !== false
      ? buildRelationshipContext(relationshipQuery)
      : { text: relationshipGuidance({ enabled: false }), used: [] }
  }
  const readOnly = conv.workspaceMode === 'read_only'
  const baseSystem = [
    buildSystemPrompt({ cfg, conv, memoryText: memory.text, searchMode: mode, screenText: screen.text }),
    commitments.length ? domainText('chat.followUpStatus', JSON.stringify(commitments)) : '',
    allowLocalTools ? await interruptedRunContext(conversationId) : '',
    allowLocalTools && cfg.harness?.enabled
      ? domainText('chat.workspacePolicy', cfg.harness.workspaceRoot, !readOnly && cfg.harness.allowWrites ? domainText('chat.allowed') : domainText('chat.disabled'), !readOnly && cfg.harness.allowShell ? domainText('chat.approvalRequired') : domainText('chat.disabled'))
      : domainText('chat.workspaceDisabled'),
    readOnly ? domainText('chat.planningMode') : domainText('chat.followUpPolicy'),
  ].filter(Boolean).join('\n\n')
  const system = [baseSystem, (await relationshipContext()).text].filter(Boolean).join('\n\n')

  const thinking = enableThinking ?? cfg.generation.enableThinking ?? false
  const reasoningConnection = thinking && isDeepSeek(baseUrl) ? createHmac('sha256', apiKey).update(baseUrl).digest('hex') : null
  const assembly = await assembleContext({ cfg, conv, memoryText: memory.text, screenText: screen.text, systemText: system, reasoningConnection })
  const messages = (await Promise.all(assembly.slice.map((m) => buildOne(m, cfg, reasoningConnection)))).flat()

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
    toolMessages: [],
  }
  const run = await startRun({
    conversationId, messageId: assistant.id, userMessageId: lastUser.id,
    workspaceRoot: allowLocalTools && cfg.harness?.enabled ? cfg.harness.workspaceRoot : null,
    workspaceMode: readOnly ? 'read_only' : 'work',
    signal, onEvent: onToolEvent,
  })
  signal = run.signal
  assistant.runId = run.id
  let tools
  try {
    tools = buildToolRegistry({ cfg, mcp, conversationId, searchMode: mode, run, allowLocalTools, readOnly })
    yield { type: 'meta', conversationId, messageId: assistant.id, userMessageId, runId: run.id, model: chosenModel, searchMode: mode, memory: memory.used, system }
  } catch (err) {
    await run.finish('failed', { error: err?.message ?? String(err), rounds: 0 }).catch(() => {})
    throw err
  }

  const maxRounds = Math.max(1, Math.min(24, cfg.harness?.enabled ? cfg.harness.maxToolRounds ?? 12 : cfg.search.maxToolRounds ?? 8))
  let round = 0
  let toolCount = 0
  let toolLimitReached = false
  let failuresSinceProgress = []
  let unresolvedFailures = []
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 }
  const addUsage = (u) => {
    if (!u) return
    totalUsage.prompt_tokens += u.prompt_tokens ?? 0
    totalUsage.completion_tokens += u.completion_tokens ?? 0
    totalUsage.reasoning_tokens += u.completion_tokens_details?.reasoning_tokens ?? 0
  }
  let runFinished = false
  const finishReply = async (status, error) => {
    assistant.runStatus = status
    if (error !== undefined) assistant.runError = error
    assistant.usage = totalUsage
    assistant.toolsFinished = true
    assistant.context = assembly.pressure
    let persistError = null
    try {
      await persistReply(assistant)
    } catch (err) {
      persistError = err
      log.error(domainText('chat.replySaveFailed'), err.message)
    }
    // 运行记录必须收尾，否则会永远停在 running；保存失败也不能挡住它
    if (!runFinished) {
      runFinished = true
      try {
        await run.finish(status, { ...(error !== undefined ? { error } : {}), finishReason: assistant.finishReason, usage: totalUsage, rounds: round })
      } catch (err) {
        log.error(domainText('chat.runFinalizeFailed'), err.message)
      }
    }
    if (persistError) throw persistError
  }

  try {
    const chain = [chosenModel, ...(cfg.upstream.fallback ?? []).filter((m) => m && m !== chosenModel)]
    let modelIdx = 0
    while (round <= maxRounds) {
      signal?.throwIfAborted()
      round++
      const useModel = chain[Math.min(modelIdx, chain.length - 1)]
      // Revoked person context disappears on the next model request without stopping tools.
      const currentSystem = [baseSystem, (await relationshipContext()).text].filter(Boolean).join('\n\n')
      const systemWithDigest = assembly.digest
        ? domainText('chat.earlierSummary', currentSystem, assembly.digest)
        : currentSystem
      const body = {
        model: useModel,
        messages: [{ role: 'system', content: systemWithDigest }, ...messages],
        max_tokens: cfg.upstream.maxTokens ?? 8000,
        temperature: temperature ?? cfg.generation.temperature ?? 0.6,
        ...thinkingOptions(baseUrl, thinking),
      }
      const wantTools = round <= maxRounds && toolCount < 32 && tools.defs.length > 0
      if (reasoningConnection && !wantTools) body.messages = body.messages.map(({ reasoning_content, ...message }) => message)
      if (wantTools) {
        body.tools = tools.defs
        body.tool_choice = 'auto'
      } else if (toolCount) {
        body.messages = [...body.messages, { role: 'system', content: domainText('chat.toolBudgetInstruction') }]
      }

      const notices = []
      const gen = streamChat({
        body,
        baseUrl,
        apiKey,
        signal,
        onRetry: (err, attempt) => notices.push(domainText('chat.upstreamRetry', attempt, String(err?.message ?? err).slice(0, 80))),
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
            if (!roundText && assistant.content.trim()) assistant.content += '\n\n'
            roundText += ev.text
            assistant.content += ev.text
            yield { type: 'delta', text: ev.text, round }
          }
        }
      } catch (err) {
        const recoverable = !emitted && modelIdx + 1 < chain.length && !signal?.aborted
        if (!recoverable) throw err
        modelIdx++
        record({ kind: 'error', where: `model:${useModel}`, message: err.message })
        log.warn(domainText('chat.fallbackAttempt', useModel, chain[modelIdx], err.message.slice(0, 90)))
        yield { type: 'notice', text: domainText('chat.fallbackApplied', useModel, String(err.message).slice(0, 60), chain[modelIdx]) }
        assistant.fallbackFrom = assistant.fallbackFrom ?? useModel
        round--
        continue
      }
      if (useModel !== chosenModel) assistant.fallbackFrom = assistant.fallbackFrom ?? chosenModel
      assistant.servedModel = useModel
      addUsage(result?.usage)
      for (const text of notices) yield { type: 'notice', text }
      if (result?.content && !roundText) assistant.content += (assistant.content.trim() ? '\n\n' : '') + result.content
      if (result?.reasoning && assistant.reasoning.length < result.reasoning.length) assistant.reasoning = result.reasoning
      if (reasoningConnection) {
        // Keep only boundaries. The UI already stores the concatenated text for this turn.
        assistant.reasoningReplay ??= { connection: reasoningConnection, ends: [] }
        assistant.reasoningReplay.ends.push(assistant.reasoning.length)
      }
      assistant.content = assistant.content.trim()
      const requestedCalls = result?.toolCalls ?? []
      const finish = result?.finishReason
      if (finish === 'length') {
        assistant.finishReason = finish
        const note = domainText('chat.lengthLimit')
        assistant.finalContent = [result.content, note].filter(Boolean).join('\n\n')
        assistant.content = [assistant.content, note].filter(Boolean).join('\n\n')
        yield { type: 'notice', text: note }
        break
      }
      if ((finish && finish !== 'stop' && finish !== 'tool_calls') || (finish === 'tool_calls' && !requestedCalls.length)) {
        assistant.finishReason = finish
        throw new Error(domainText('chat.incompleteReply', finish))
      }
      const calls = wantTools ? requestedCalls.slice(0, Math.max(0, 32 - toolCount)) : []
      if (requestedCalls.length > calls.length) toolLimitReached = true
      if (!calls.length) {
        assistant.finishReason = result?.finishReason ?? null
        assistant.finalContent = result?.content ?? ''
        if (!toolLimitReached && !assistant.finalContent.trim() && !assistant.images?.length) {
          assistant.finishReason = 'empty_response'
          throw new Error(domainText('chat.missingFinalReply'))
        }
        if (toolLimitReached) {
          assistant.finishReason = 'tool_limit'
          const note = domainText('chat.toolBudgetReached')
          assistant.content += `${assistant.content ? '\n\n' : ''}${note}`
          assistant.finalContent += `${assistant.finalContent ? '\n\n' : ''}${note}`
          yield { type: 'notice', text: note }
        }
        break
      }

      const requestMessage = { role: 'assistant', content: result?.content ?? '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }
      messages.push(reasoningConnection ? { ...requestMessage, reasoning_content: result.reasoning } : requestMessage)
      assistant.toolMessages.push(requestMessage)
      for (const call of calls) {
        signal?.throwIfAborted()
        if (failuresSinceProgress.some((previous) => sameToolRequest(previous, call))) {
          assistant.finishReason = 'no_progress'
          throw new Error(domainText('chat.repeatedFailure', labelFor(call.name)))
        }
        toolCount++
        const entry = { id: call.id, name: call.name, label: labelFor(call.name), args: call.args ?? {}, startedAt: nowIso() }
        assistant.tools.push(entry)
        yield { type: 'tool_call', id: call.id, name: call.name, label: entry.label, args: call.args, round, runId: run.id }
        signal?.throwIfAborted()
        try {
          const out = await tools.call(call.name, call.args, { callId: call.id })
          entry.ok = out.ok !== false
          if (entry.ok && call.name === 'follow_up_list' && out.preparation) entry.preparation = out.preparation
          entry.result = clip(out.text ?? '', MODEL_TOOL_TEXT_LIMIT)
          entry.exitCode = out.exitCode ?? null
          entry.artifacts = out.artifacts ?? []
          entry.stepId = out.stepId
          entry.runId = run.id
          entry.ms = out.ms
          record({ kind: 'tool', name: call.name, ok: entry.ok, ms: out.ms })
          entry.sources = out.sources ?? undefined
          if (out.sources?.length) yield { type: 'sources', items: out.sources }
          if (out.images?.length) {
            entry.images = out.images
            assistant.images = [...(assistant.images ?? []), ...out.images]
            yield { type: 'images', items: out.images }
          }
          const hasPage = call.name === 'workspace_read' || call.name === 'read_output'
          const toolMessage = { role: 'tool', tool_call_id: call.id, content: `${entry.result}${!hasPage && entry.artifacts.length ? domainText('chat.outputFile', JSON.stringify({ stepId: out.stepId, artifacts: entry.artifacts })) : ''}` }
          messages.push(toolMessage)
          assistant.toolMessages.push(toolMessage)
          yield { type: 'tool_result', id: call.id, ok: entry.ok, preview: clip(out.text, 1400), ms: out.ms, round, runId: run.id, stepId: out.stepId, artifacts: entry.artifacts, exitCode: entry.exitCode }
        } catch (err) {
          entry.ok = false
          entry.status = signal.aborted || err?.name === 'AbortError' ? 'cancelled' : err.denied ? 'denied' : 'failed'
          entry.result = domainText('chat.toolFailed', err.message)
          entry.artifacts = err.artifacts ?? []
          entry.stepId = err.stepId
          entry.runId = run.id
          record({ kind: 'tool', name: call.name, ok: false, error: err.message })
          record({ kind: 'error', where: `tool:${call.name}`, message: err.message })
          const toolMessage = { role: 'tool', tool_call_id: call.id, content: entry.result }
          messages.push(toolMessage)
          assistant.toolMessages.push(toolMessage)
          yield { type: 'tool_result', id: call.id, ok: false, status: entry.status, error: err.message, round, runId: run.id, stepId: err.stepId, artifacts: entry.artifacts }
          if (signal.aborted || err?.name === 'AbortError' || err.denied) throw err
          log.warn(domainText('chat.toolLog', call.name), err.message)
        }
        if (entry.ok) {
          failuresSinceProgress = []
          if (entry.name === 'shell_exec' || entry.name.startsWith('workspace_')) {
            unresolvedFailures = unresolvedFailures.filter((failure) => !sameToolRequest(failure, entry))
          }
        } else {
          failuresSinceProgress.push(entry)
          unresolvedFailures.push(entry)
        }
      }
    }
    signal?.throwIfAborted()
    if (!assistant.images?.length && /画好了|已生成|已经画|生成完成|画完了|出图完成/.test(assistant.content ?? '')) {
      assistant.warning = 'claimed_image_without_tool'
      yield { type: 'notice', text: domainText('chat.imageMissing') }
    }
    const failedTool = unresolvedFailures[0]
    const reachedLimit = ['length', 'tool_limit'].includes(assistant.finishReason)
    const status = reachedLimit ? 'limit_reached' : failedTool ? 'failed' : 'completed'
    await finishReply(status, failedTool ? `${failedTool.label}${languageText('：', ': ')}${clip(failedTool.result || domainText('chat.toolExecutionFailed'), 800)}` : undefined)
    yield { type: 'done', message: assistant, usage: totalUsage, rounds: round, sources: tools.sources }
  } catch (err) {
    assistant.toolMessages = completeToolHistory(assistant.toolMessages)
    const error = err?.message ?? String(err)
    if (err?.name === 'AbortError' || signal?.aborted || err?.denied) {
      assistant.aborted = true
      if (err?.denied) assistant.content += `${assistant.content ? '\n\n' : ''}${err.status === 408 ? domainText('chat.approvalExpired') : domainText('chat.approvalDenied')}`
      assistant.finalContent = assistant.content
      await finishReply('cancelled', error)
      yield { type: 'done', message: assistant, aborted: true, usage: totalUsage, rounds: round, sources: tools.sources }
      return
    }
    log.error(domainText('chat.turnFailed'), error)
    assistant.finalContent = assistant.content
    await finishReply('failed', error)
    yield { type: 'error', message: error, status: err?.status, assistant }
  }
}
