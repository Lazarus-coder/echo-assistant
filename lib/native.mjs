import { upstreamCreds } from './config.mjs'
import { log } from './log.mjs'

function host() {
  const { baseUrl } = upstreamCreds()
  const u = new URL(baseUrl)
  return u.origin
}

/**
 * The token-plan gateway also implements the OpenAI Responses API, which carries
 * Aliyun-hosted tools (web_search / web_extractor / code_interpreter / mcp).
 * We only use it as a search backend and for one-shot utility calls.
 */
async function responses({ model, input, tools = [], maxOutputTokens = 900, temperature = 0.3, timeoutMs = 60000, toolChoice, enableThinking }) {
  const { apiKey, baseUrl } = upstreamCreds()
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY')
  const url = `${host()}/compatible-mode/v1/responses`
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input,
      tools,
      max_output_tokens: maxOutputTokens,
      temperature,
      ...(enableThinking !== undefined ? { enable_thinking: enableThinking } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`responses HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  const texts = []
  for (const item of data.output ?? []) {
    if (item.type === 'message') for (const c of item.content ?? []) if (c.text) texts.push(c.text)
    else if (item.type === 'output_text' && item.text) texts.push(item.text)
  }
  return { data, text: texts.join('\n').trim(), searchCalls: (data.output ?? []).filter((o) => o.type === 'web_search_call') }
}

export async function nativeSearch(query, { model, timeoutMs = 60000 } = {}) {
  // 实测对比（同一台网关、同一个问题）：
  //   enable_thinking=false 且 tool_choice=auto   → 0.6s 但根本没搜，数字是编的
  //   enable_thinking=true                        → 23–44s，搜到了（2854 个思考 token 全花在"要不要搜"上）
  //   tool_choice=required 且 enable_thinking=false → 7.5s，18 个来源，数字与多源一致 ✅
  // 强制工具调用让它不必纠结，直接搜。
  const prompt = `只做一次联网检索，然后用最短篇幅汇报，不要客套、不要展开：\n查询：${query}\n输出格式：第一行给结论要点（带具体数字与日期），随后一行列出 2–4 个来源域名。`
  const { data, text, searchCalls } = await responses({
    model: model ?? 'qwen3.6-flash',
    input: prompt,
    tools: [{ type: 'web_search' }],
    toolChoice: 'required',
    maxOutputTokens: 700,
    enableThinking: false,
    timeoutMs,
  })
  const sources = []
  for (const call of searchCalls) {
    for (const s of call.action?.sources ?? []) if (s.url && !sources.some((x) => x.url === s.url)) sources.push({ url: s.url, title: '' })
  }
  if (!text && !sources.length) throw new Error('原生搜索没有返回内容')
  return { query, answer: text, sources, meta: { billing: data.usage?.x_tools ?? null } }
}

/** Aliyun-hosted MCP service passed straight through the Responses API. */
export async function hostedMcpCall({ serverUrl, serverLabel = 'aliyun', serverProtocol = 'sse', headers, toolInstruction, model }) {
  const { text } = await responses({
    model: model ?? 'qwen3.6-flash',
    input: toolInstruction,
    tools: [{ type: 'mcp', server_label: serverLabel, server_url: serverUrl, server_protocol: serverProtocol, headers: headers ?? {} }],
    maxOutputTokens: 1200,
  })
  return { text }
}

/** One-shot JSON call used by memory extraction / dream / proactive decisions. */
export async function jsonTask({ system, user, model, maxTokens = 900, temperature = 0.2, timeoutMs = 45000, schemaHint }) {
  const { apiKey, baseUrl } = upstreamCreds()
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY')
  const body = {
    model: model ?? 'qwen3.6-flash',
    messages: [
      { role: 'system', content: `${system}\n只输出 JSON，不要 markdown 代码块，不要解释。${schemaHint ? `结构：${schemaHint}` : ''}` },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    enable_thinking: false,
    response_format: { type: 'json_object' },
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`jsonTask HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content ?? ''
  const usage = data.usage ?? null
  return { json: parseJSON(raw), raw, usage }
}

/** Vision call: image (data URL or http) + instruction → parsed JSON. */
export async function upstreamChatWithImage({ model, system, prompt, imageDataUrl, maxTokens = 900, timeoutMs = 90000 }) {
  const { apiKey, baseUrl } = upstreamCreds()
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY')
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model ?? 'qwen3.6-flash',
      max_tokens: maxTokens,
      temperature: 0.2,
      enable_thinking: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageDataUrl } }] },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`视觉调用失败 HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content ?? ''
  return parseJSON(raw)
}

export function parseJSON(text) {
  const s = String(text ?? '').trim()
  const attempts = [s, s.replace(/^```(?:json)?/i, '').replace(/```$/m, '').trim()]
  const brace = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(s)
  if (brace) attempts.push(brace[0])
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {}
  }
  log.warn('json 解析失败:', s.slice(0, 160))
  return null
}
