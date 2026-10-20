/* 伴随模式的小对话窗：点开气泡后专注于那个话题。
   复用主站的样式与 /api/chat SSE，不引入构建步骤。 */
const $ = (s, r = document) => r.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const params = new URLSearchParams(location.search)
const bubbleId = params.get('b') ?? location.pathname.split('/').filter(Boolean)[1] ?? ''
const localHeaders = typeof globalThis.__echoLocalToken === 'string' ? { 'x-echo-local': globalThis.__echoLocalToken } : {}
delete globalThis.__echoLocalToken

let conversationId = null
let streaming = null

function updateComposer() {
  $('#send').disabled = !conversationId || Boolean(streaming) || !$('#input').value.trim()
  $('[data-act="open-main"]').disabled = !conversationId
  $('#send').textContent = streaming ? '回复中…' : '发送'
  $('#thread').setAttribute('aria-busy', String(Boolean(streaming)))
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { ...localHeaders, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-echo-request': 'echo' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    redirect: 'error',
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`)
  return res.json()
}

function renderMessage(m) {
  const el = document.createElement('div')
  el.className = `msg ${m.role === 'user' ? 'user' : 'assistant'}`
  if (m.role === 'user') {
    el.innerHTML = `<div class="body content">${esc(m.content)}</div>`
  } else {
    el.innerHTML = `<div class="avatar">E</div><div class="body"><div class="content"></div><div class="tail"></div></div>`
    $('.content', el).innerHTML = mdLite(m.content ?? '')
  }
  return el
}

/* 极简 markdown：小窗只需要代码、加粗、链接和换行 */
function mdLite(text) {
  let s = esc(text)
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, code) => `<pre class="code"><code>${code}</code></pre>`)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`)
  return s.replace(/\n/g, '<br />')
}

async function loadThread(id) {
  const conv = await api(`conversations/${id}`)
  $('#topic').textContent = conv.title ?? '伴随'
  $('#model').textContent = conv.model ?? ''
  const thread = $('#thread')
  thread.innerHTML = ''
  for (const m of conv.messages ?? []) {
    thread.append(renderMessage(m))
    if (m.companion) {
      $('#scenario').textContent = m.companion.scenario ?? '伴随'
      $('#hint').textContent = `来自气泡 · ${m.companion.bubbleId ?? ''}`
    }
  }
  thread.scrollTop = thread.scrollHeight
}

async function send(text) {
  const thread = $('#thread')
  thread.append(renderMessage({ role: 'user', content: text }))
  const node = renderMessage({ role: 'assistant', content: '', createdAt: new Date().toISOString() })
  thread.append(node)
  const contentEl = $('.content', node)
  contentEl.innerHTML = '<span class="cursor"></span>'
  thread.scrollTop = thread.scrollHeight

  streaming = new AbortController()
  updateComposer()
  let buffer = ''
  let rendered = ''
  let paintFrame = null
  let completed = false
  let error = ''
  const sources = []
  const paint = () => {
    if (paintFrame !== null) return
    paintFrame = requestAnimationFrame(() => {
      paintFrame = null
      if (rendered === buffer) return
      rendered = buffer
      contentEl.innerHTML = `${mdLite(buffer)}<span class="cursor"></span>`
      thread.scrollTop = thread.scrollHeight
    })
  }
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { ...localHeaders, 'content-type': 'application/json', 'x-echo-request': 'echo' },
      body: JSON.stringify({ conversationId, userText: text, searchMode: 'auto' }),
      credentials: 'same-origin',
      redirect: 'error',
      signal: streaming.signal,
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      throw new Error(detail.message ?? `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const name = /^event: (.+)$/m.exec(frame)?.[1]
        const data = /^data: (.+)$/m.exec(frame)?.[1]
        if (!name || !data) continue
        const d = JSON.parse(data)
        if (name === 'delta') {
          buffer += d.text
          paint()
        } else if (name === 'error') {
          throw new Error(d.message ?? '回复失败，请重试。')
        } else if (name === 'tool_call') {
          $('.tail', node).innerHTML = `<div class="notice">正在调用 ${esc(d.label ?? d.name)}…</div>`
        } else if (name === 'sources') {
          for (const s of d.items ?? []) if (!sources.some((x) => x.url === s.url)) sources.push(s)
        } else if (name === 'done') {
          buffer = d.message?.content ?? buffer
          completed = true
        }
      }
    }
    if (!completed) throw new Error('连接已中断，回复可能不完整。请重试。')
  } catch (err) {
    if (err.name !== 'AbortError') error = err.message
  } finally {
    if (paintFrame !== null) cancelAnimationFrame(paintFrame)
    contentEl.innerHTML = mdLite(buffer)
    $('.tail', node).innerHTML = sources.length
      ? `<div class="sources">${sources
          .slice(0, 6)
          .map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(s.title || s.url)}</a>`)
          .join('')}</div>`
      : ''
    if (error) $('.tail', node).innerHTML += `<div class="err" role="alert">${esc(error)}</div>`
    streaming = null
    updateComposer()
  }
}

async function init() {
  if (!bubbleId) {
    $('#thread').innerHTML = '<div class="mini-empty">没有指定气泡。从状态栏的气泡点进来，或带 ?b=&lt;气泡id&gt; 打开。</div>'
    return
  }
  try {
    const r = await api(`companion/${bubbleId}/open`, { method: 'POST', body: {} })
    await loadThread(r.conversationId)
    conversationId = r.conversationId
    updateComposer()
    $('#input').focus()
  } catch (err) {
    $('#thread').innerHTML = `<div class="mini-empty">打不开这个气泡：${esc(err.message)}</div>`
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = $('#input').value.trim()
  if (!text || streaming || !conversationId) return
  $('#input').value = ''
  $('#input').style.height = 'auto'
  send(text)
})
$('#input').addEventListener('input', (e) => {
  e.target.style.height = 'auto'
  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
  updateComposer()
})
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#composer').requestSubmit()
  }
})
document.addEventListener('click', (e) => {
  if (conversationId && e.target.closest('[data-act="open-main"]')) {
    window.open(`/?conv=${conversationId}`, '_blank')
  }
})

updateComposer()
init()
