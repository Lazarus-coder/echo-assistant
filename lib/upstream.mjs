export function isDeepSeek(baseUrl) {
  return /^https:\/\/api\.deepseek\.com(?::443)?(?:\/(?:v1|beta))?\/?$/i.test(baseUrl)
}

export function thinkingOptions(baseUrl, enabled = false, api = 'chat') {
  if (isDeepSeek(baseUrl)) {
    return api === 'responses' ? { reasoning: { effort: enabled ? 'high' : 'none' } } : { thinking: { type: enabled ? 'enabled' : 'disabled' } }
  }
  return enabled || /\/compatible-mode\/v1\/?$/.test(baseUrl) ? { enable_thinking: enabled } : {}
}

/** Streaming chat/completions client: yields deltas, returns the assembled turn. */
export async function* streamChat({ body, signal, baseUrl, apiKey, onRetry }) {
  let attempt = 0
  while (true) {
    attempt++
    let res
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      if (attempt < 3) {
        onRetry?.(err, attempt)
        await backoff(attempt, signal)
        continue
      }
      throw err
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      const retryable = res.status === 429 || res.status >= 500
      if (retryable && attempt < 3) {
        onRetry?.(new Error(`HTTP ${res.status}`), attempt)
        await backoff(attempt, signal)
        continue
      }
      const e = new Error(`上游 HTTP ${res.status}: ${text.slice(0, 400)}`)
      e.status = res.status
      e.detail = text
      throw e
    }

    const acc = { content: '', reasoning: '', toolCalls: new Map(), finishReason: null, usage: null, model: body.model, id: null }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let gotAny = false
    let sawDone = false
    try {
      frames: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = /\r?\n\r?\n/.exec(buf))) {
          const frame = buf.slice(0, boundary.index)
          buf = buf.slice(boundary.index + boundary[0].length)
          const payload = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n').trim()
          if (!payload) continue
          if (payload === '[DONE]') { sawDone = true; break frames }
          let chunk
          try {
            chunk = JSON.parse(payload)
          } catch {
            throw new Error('上游数据帧不完整，请重试')
          }
          if (chunk.error) throw new Error(chunk.error.message ?? String(chunk.error))
          gotAny = true
          if (chunk.id) acc.id = chunk.id
          if (chunk.model) acc.model = chunk.model
          if (chunk.usage) acc.usage = chunk.usage
          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}
          if (delta.reasoning_content) {
            acc.reasoning += delta.reasoning_content
            yield { type: 'reasoning', text: delta.reasoning_content }
          }
          if (delta.content) {
            acc.content += delta.content
            yield { type: 'delta', text: delta.content }
          }
          for (const tc of delta.tool_calls ?? []) {
            const slot = acc.toolCalls.get(tc.index ?? 0) ?? { id: '', name: '', args: '' }
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name += tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
            acc.toolCalls.set(tc.index ?? 0, slot)
            if (tc.function?.name) yield { type: 'tool_pending', name: tc.function.name, tempId: slot.id }
          }
          if (choice.finish_reason) acc.finishReason = choice.finish_reason
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock?.()
    }

    if (!gotAny) {
      if (attempt < 3) {
        onRetry?.(new Error('空响应'), attempt)
        await backoff(attempt, signal)
        continue
      }
      throw new Error('上游返回空响应，请重试')
    }
    if (!sawDone && !acc.finishReason) throw new Error('上游连接在生成结束前中断')
    const toolCalls = []
    // A token cap or provider error can truncate even syntactically valid arguments.
    if (!acc.finishReason || acc.finishReason === 'tool_calls') {
      for (const t of acc.toolCalls.values()) {
        let args
        try { args = JSON.parse(t.args) } catch { throw new Error('工具参数不是完整的 JSON，请重试') }
        if (!t.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具调用缺少名称或参数对象')
        const id = t.id || `call_${Date.now()}_${toolCalls.length}`
        if (toolCalls.some((call) => call.id === id)) throw new Error('上游返回了重复的工具调用 ID')
        toolCalls.push({ id, name: t.name, args })
      }
      if (acc.finishReason === 'tool_calls' && !toolCalls.length) throw new Error('上游工具调用缺少内容')
    } else if (acc.toolCalls.size && acc.finishReason === 'stop') {
      throw new Error('上游结束原因与工具调用不一致')
    }
    return { content: acc.content, reasoning: acc.reasoning, toolCalls, finishReason: acc.finishReason, usage: acc.usage, model: acc.model }
  }
}

async function backoff(attempt, signal) {
  const ms = 600 * 2 ** (attempt - 1)
  await new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/** Non-streaming single call (used by title/digest generation). */
export async function complete({ body, baseUrl, apiKey, signal }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
  const data = await res.json()
  return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage ?? null }
}
