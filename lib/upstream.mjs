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
          if (payload === '[DONE]') break frames
          let chunk
          try {
            chunk = JSON.parse(payload)
          } catch {
            continue
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

    const toolCalls = [...acc.toolCalls.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.id || `call_${Date.now()}_${i}`, name: t.name, args: safeArgs(t.args) }))
    if (!gotAny) {
      if (attempt < 3) {
        onRetry?.(new Error('空响应'), attempt)
        await backoff(attempt, signal)
        continue
      }
      throw new Error('上游返回空响应，请重试')
    }
    return { content: acc.content, reasoning: acc.reasoning, toolCalls, finishReason: acc.finishReason, usage: acc.usage, model: acc.model }
  }
}

function safeArgs(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return { _raw: raw }
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
