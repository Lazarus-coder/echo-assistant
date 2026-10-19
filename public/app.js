/* Echo · 本地对话前端。零依赖，CSP 允许 'self' 脚本，所有交互走 data-action。 */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clamp = (n, a, b) => Math.max(a, Math.min(b, n))
const uid = () => Math.random().toString(36).slice(2, 10)

const KIND_LABEL = { follow_up: '跟进', suggest: '建议', guide: '指导', ask: '询问', brief: '日报' }

const prefs = {
  get model() { return localStorage.getItem('echo.model') },
  set model(v) { localStorage.setItem('echo.model', v) },
  get searchMode() { return localStorage.getItem('echo.search') ?? 'auto' },
  set searchMode(v) { localStorage.setItem('echo.search', v) },
  get thinking() { return localStorage.getItem('echo.thinking') === '1' },
  set thinking(v) { localStorage.setItem('echo.thinking', v ? '1' : '0') },
  get theme() { return localStorage.getItem('echo.theme') ?? 'auto' },
  set theme(v) { localStorage.setItem('echo.theme', v) },
}

const S = {
  boot: null,
  convs: [],
  current: null,
  conv: null,
  stream: null,
  filter: '',
  panel: 'memory',
  poll: null,
}

/* ---------------------------------- api ----------------------------------- */

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-echo-request': 'echo' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (res.status === 401) {
    let mode = 'again'
    try {
      const j = await res.clone().json()
      if (j.error === 'no_password') mode = 'first'
    } catch {}
    showGate(path === 'bootstrap' ? mode : mode)
    throw new Error('需要登录')
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg = (await res.json()).message ?? msg } catch {}
    throw new Error(msg)
  }
  return raw ? res : res.json()
}

/* ------------------------------- markdown ---------------------------------- */

const LANGS = {
  js: 'js jsx ts javascript typescript node vue',
  py: 'py python',
  sh: 'sh bash zsh shell console',
  json: 'json',
  html: 'html xml svg vue',
  css: 'css scss less',
  sql: 'sql',
  go: 'go golang',
  rs: 'rs rust',
  java: 'java kotlin swift c cpp cc',
  yml: 'yml yaml toml ini',
}
const KEYWORDS = {
  js: 'const let var function return if else for while do class extends new this import from export default async await try catch finally throw typeof instanceof in of delete void yield switch case break continue null undefined true false static get set super',
  py: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield pass break continue global nonlocal assert async await del',
  sh: 'if then else elif fi for while do done case esac function return export local set source echo cd exit true false',
  go: 'package import func return if else for range var const type struct interface map chan go defer select case default nil true false string int error',
  rs: 'fn let mut const struct enum impl trait use pub mod match if else for while loop return self Self true false Some None Ok Err async await where dyn',
  java: 'public private protected class interface extends implements new return if else for while switch case break continue static final void int long double boolean String null true false try catch finally throw throws package import this super',
  sql: 'select from where group by order having limit insert update delete create table drop alter join left right inner outer on as and or not null distinct count sum avg min max case when then else end union all',
  css: 'important media supports keyframes import',
  yml: 'true false null on off yes no',
  json: 'true false null',
  html: '',
}
function langKey(lang) {
  const l = String(lang || '').toLowerCase()
  return Object.entries(LANGS).find(([, list]) => list.split(' ').includes(l))?.[0] ?? (KEYWORDS[l] ? l : 'js')
}

function highlight(code, lang) {
  const key = langKey(lang)
  const kws = (KEYWORDS[key] ?? '').split(' ').filter(Boolean).sort((a, b) => b.length - a.length)
  const kwRe = kws.length ? `\\b(?:${kws.join('|')})\\b` : '(?!)'
  const re = new RegExp(
    [
      '(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|<!--[\\s\\S]*?-->)',
      '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
      '\\b(0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)\\b',
      kwRe,
      '\\b(?:[A-Za-z_$][\\w$]*)(?=\\s*\\()',
    ].join('|'),
    'g',
  )
  const cls = ['', 'tok-c', 'tok-s', 'tok-n', 'tok-k', 'tok-f']
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index))
    const groupIndex = m.findIndex((g, i) => i > 0 && g !== undefined)
    out += `<span class="${cls[groupIndex] ?? 'tok-f'}">${esc(m[0])}</span>`
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  return out + esc(code.slice(last))
}

const SAFE_SCHEME = /^(https?:|mailto:|#|\/)/i

function inline(text) {
  let s = esc(text)
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) =>
    /^(\/api\/uploads\/|data:image\/)/.test(u) ? `<img src="${u}" alt="${alt}" loading="lazy" />` : m,
  )
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (SAFE_SCHEME.test(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${t}</a>` : m))
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)》】]+[^\s<)》】.,;:!?])/g, (m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`)
  return s
}

function md(src) {
  const code = []
  let text = String(src ?? '').replace(/```(\w+)?[ \t]*\r?\n([\s\S]*?)```/g, (_, lang, body) => {
    code.push({ lang: lang ?? '', body: body.replace(/\n$/, '') })
    return `\n\u0000CODE${code.length - 1}\u0000\n`
  })
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  const isList = (l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const cm = /^\u0000CODE(\d+)\u0000$/.exec(line.trim())
    if (cm) {
      const { lang, body } = code[Number(cm[1])]
      out.push(
        `<pre class="code"><div class="code-head"><span>${esc(lang || 'text')}</span><button data-action="copy-code">复制</button></div><code>${highlight(body, lang)}</code></pre>`,
      )
      i++
      continue
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm) { out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); i++; continue }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr />'); i++; continue }
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l) => l.trim().replace(/^\||\|/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      )
      continue
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items = []
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (isList(lines[i])) items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
        else items[items.length - 1] += '\n' + lines[i].trim()
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((t) => `<li>${md(t)}</li>`).join('')}</${tag}>`)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !isList(lines[i]) && !/^(#{1,6}\s|\s*>|\s*\||\u0000CODE)/.test(lines[i]) && !/^\s*(?:-{3,}|\*{3,})\s*$/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`)
  }
  return out.join('\n')
}

/* --------------------------------- helpers -------------------------------- */

function fmtTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
function ago(iso) {
  const ms = Date.now() - Date.parse(iso ?? 0)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60000) return '刚刚'
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前`
  return `${Math.floor(ms / 86400000)} 天前`
}
function toast(msg, bad) {
  const el = document.createElement('div')
  el.className = `toast${bad ? ' bad' : ''}`
  el.textContent = msg
  $('#toasts').append(el)
  setTimeout(() => el.remove(), bad ? 5200 : 2600)
}

function applyTheme() {
  const want = prefs.theme
  const dark = want === 'dark' || (want === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const btn = $('#themeBtn')
  if (btn) btn.textContent = { auto: '自动', dark: '深色', light: '浅色' }[want]
}

/* ---------------------------------- gate ----------------------------------- */

let gateMode = 'first'
function showGate(mode) {
  gateMode = mode ?? 'again'
  $('#app').hidden = true
  $('#gate').hidden = false
  $('#gateTitle').textContent = gateMode === 'first' ? '设置访问口令' : 'Echo'
  $('#gateHint').textContent = gateMode === 'first' ? '这个窗口会被局域网访问，先定一个口令（≥6 位）' : '输入访问口令'
  $('#gateSubmit').textContent = gateMode === 'first' ? '创建并进入' : '进入'
  $('#gateInput').value = ''
  setTimeout(() => $('#gateInput').focus(), 60)
}

$('#gateForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const password = $('#gateInput').value
  $('#gateError').hidden = true
  try {
    await api(gateMode === 'first' ? 'password' : 'login', { method: 'POST', body: gateMode === 'first' ? { password } : { password } })
    await boot()
  } catch (err) {
    $('#gateError').textContent = err.message
    $('#gateError').hidden = false
  }
})

/* --------------------------------- sidebar --------------------------------- */

function renderConvs() {
  const list = $('#convList')
  const q = S.filter.trim().toLowerCase()
  const convs = S.convs.filter((c) => !q || `${c.title} ${c.preview}`.toLowerCase().includes(q))
  list.innerHTML = convs.length
    ? convs
        .map(
          (c) => `<li class="conv ${c.id === S.current ? 'active' : ''} ${c.isMain ? 'main' : ''}" data-action="select-conv" data-id="${esc(c.id)}" title="${esc(c.preview || c.title)}">
            <div class="col">
              <div class="name">${c.isMain ? '<span>主对话</span>' : esc(c.title)}${c.unread ? '<i class="dot" title="有新消息"></i>' : ''}${c.pinned && !c.isMain ? '<svg viewBox="0 0 24 24" width="11" height="11" style="fill:currentColor;stroke:none"><path d="M14 3l7 7-4 1-3 3-1 4-4-4-5 5 1-6-4-4 6-1 3-3z"/></svg>' : ''}</div>
              <div class="sub">${c.isMain ? '主动服务会出现在这里' : esc(c.preview || '空')} · ${ago(c.updatedAt)}</div>
            </div>
            <div class="tools">
              ${c.isMain ? '' : `<button data-action="pin-conv" data-id="${esc(c.id)}" title="${c.pinned ? '取消置顶' : '置顶'}"><svg viewBox="0 0 24 24"><path d="M9 4h6M12 4v9M8 20l4-7 4 7"/></svg></button>`}
              <button data-action="export-conv" data-id="${esc(c.id)}" title="导出 markdown"><svg viewBox="0 0 24 24"><path d="M12 4v10M8 10l4 4 4-4M5 19h14"/></svg></button>
              ${c.isMain ? '' : `<button data-action="del-conv" data-id="${esc(c.id)}" title="删除"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/></svg></button>`}
            </div>
          </li>`,
        )
        .join('')
    : '<li class="muted small" style="padding:10px">没有匹配的会话</li>'
  $('#memCount').textContent = S.boot?.memory?.observations ?? 0
  $('#proCount').textContent = S.boot?.proactive?.todayCount ?? 0
}

async function refreshList() {
  const r = await api('conversations')
  S.convs = r.conversations
  renderConvs()
}

/* --------------------------------- thread ---------------------------------- */

function messageNode(m) {
  const wrap = document.createElement('div')
  wrap.className = `msg ${m.role === 'user' ? 'user' : 'assistant'}${m.proactive ? ' proactive' : ''}`
  wrap.dataset.id = m.id ?? uid()
  if (m.role === 'user') {
    const imgs = (m.images ?? []).map((u) => (typeof u === 'string' ? { url: u } : u))
    wrap.innerHTML = `<div class="body"><div class="content">${esc(m.content)}</div>${imageGallery(imgs)}</div>`
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="msg-actions" style="align-self:flex-start"><button data-action="edit-user">编辑重发</button><button data-action="copy-msg">复制</button></div>`,
    )
    wrap.style.alignItems = 'flex-end'
    return wrap
  }
  const kindBadge = m.proactive ? `<span class="kind">${KIND_LABEL[m.kind] ?? '主动'} · 助手主动发起</span>` : ''
  wrap.innerHTML = `<div class="avatar">E</div><div class="body">
      <div class="meta"><span class="who">Echo</span><span>${fmtTime(m.createdAt)}</span>${kindBadge}
        <span class="msg-actions">
          <button data-action="copy-msg">复制</button>
          ${m.proactive ? '' : '<button data-action="regen">重新生成</button>'}
          <button data-action="fb" data-signal="good" data-kind="${esc(m.kind ?? 'chat')}" data-id="${esc(m.id)}" title="这条有用（会调高这类消息的开口倾向）">有用</button>
          <button data-action="fb" data-signal="bad" data-kind="${esc(m.kind ?? 'chat')}" data-id="${esc(m.id)}" title="这条没用（会调低）">没用</button>
        </span>
      </div>
      ${m.reasoning ? `<details class="fold reasoning"><summary>思考过程 · ${m.reasoning.length} 字</summary><div class="fold-body">${esc(m.reasoning)}</div></details>` : ''}
      ${(m.tools ?? []).length ? renderSteps(m.tools) : ''}
      <div class="content"></div>
      ${imageGallery(m.images)}
      <div class="tail"></div>
    </div>`
  $('.content', wrap).innerHTML = md(m.content ?? '')
  renderTail(wrap, m)
  return wrap
}

function renderSteps(tools) {
  const items = tools
    .map((t) => {
      const args = Object.values(t.args ?? {}).map(String).join(' · ').slice(0, 80)
      return `<div class="step ${t.ok === false ? 'bad' : ''}"><i class="st-dot"></i><span class="st-name">${esc(t.label ?? t.name)}</span><span class="st-arg">${esc(args)}</span><span class="st-ms">${t.ms ? `${t.ms}ms` : ''}</span></div>`
    })
    .join('')
  const detail = tools
    .map((t) => `<div class="st-out">${esc(String(t.result ?? '').slice(0, 3000))}</div>`)
    .join('<hr style="border:0;border-top:1px solid var(--border);margin:8px 0"/>')
  return `<details class="fold steps-fold"><summary>调用 ${tools.length} 次工具</summary><div class="fold-body"><div class="steps">${items}</div><div style="margin-top:8px">${detail}</div></div></details>`
}

function renderTail(node, m) {
  const tail = $('.tail', node)
  if (!tail) return
  const u = m.usage ?? {}
  const parts = []
  if (u.prompt_tokens || u.completion_tokens) {
    const cost = u.completion_tokens_details?.reasoning_tokens ? `（含思考 ${u.completion_tokens_details.reasoning_tokens}）` : ''
    parts.push(`${u.prompt_tokens} 入 / ${u.completion_tokens} 出${cost}`)
  }
  if (m.model) parts.push(m.model)
  if (m.searchMode && m.searchMode !== 'off') {
    const searched = (m.tools ?? []).some((t) => t.name === 'web_search' || t.name === 'web_fetch')
    parts.push(searched ? '已联网' : '未实际联网')
  }
  if (m.finishReason === 'length') parts.push('被长度截断，可说"继续"')
  if (m.aborted) parts.push('已停止')
  tail.innerHTML = `${parts.length ? `<div class="usage">${esc(parts.join(' · '))}</div>` : ''}${sourceHtml(m.sources)}`
}

function sourceHtml(sources) {
  const list = (sources ?? []).filter((s) => s?.url).slice(0, 8)
  if (!list.length) return ''
  return `<div class="sources">${list
    .map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(s.title || host(s.url))}</a>`)
    .join('')}</div>`
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

function modelOptionsHtml(models, selected) {
  const groups = {}
  for (const m of models) (groups[m.group ?? '其他'] ??= []).push(m)
  return Object.entries(groups)
    .map(
      ([g, list]) =>
        `<optgroup label="${esc(g)}">${list
          .map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)}${m.vision ? ' · 视觉' : ''}</option>`)
          .join('')}</optgroup>`,
    )
    .join('')
}

function imageGallery(images) {
  const list = (images ?? []).filter((i) => i?.url)
  if (!list.length) return ''
  return `<div class="gallery">${list
    .map(
      (i) =>
        `<a href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(i.url)}" alt="${esc(i.prompt ?? '图片')}" loading="lazy" /></a>`,
    )
    .join('')}</div>`
}

function renderThread() {
  const thread = $('#thread')
  thread.innerHTML = ''
  const inner = document.createElement('div')
  inner.className = 'thread-inner'
  inner.id = 'threadInner'
  thread.append(inner)
  const msgs = S.conv?.messages ?? []
  if (!msgs.length) {
    inner.append(heroNode())
  } else {
    for (const m of msgs) inner.append(messageNode(m))
  }
  scrollBottom(false)
}

function heroNode() {
  const el = document.createElement('div')
  el.className = 'hero'
  const main = S.current === 'main'
  el.innerHTML = `<img src="/logo.svg" width="42" height="42" alt="" />
    <h3>${main ? '这是你的主对话' : '想问点什么？'}</h3>
    <p>${
      main
        ? '这里会长期保留，助手的主动跟进、建议和提醒都会出现在这个窗口。换模型不影响它的连续性。'
        : '本地跑的私人助手，回答会带着来源。你的记忆只存在这台机器的 data/memory/ 里。'
    }</p>
    <div class="suggestions">
      ${[main ? '帮我看看最近在跟进什么' : '今天有什么值得关注的新闻？', '美元兑人民币汇率', '帮我起草一条请假消息', '搜索最近一次 AI 模型发布']
        .map((t) => `<button class="sug" data-action="sug">${esc(t)}</button>`)
        .join('')}
    </div>`
  return el
}

function scrollBottom(force = true) {
  const t = $('#thread')
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 260
  if (force || nearBottom) t.scrollTop = t.scrollHeight
}

/* ------------------------------ attachments -------------------------------- */

S.att = []

function renderAttachments() {
  const strip = $('#attachStrip')
  strip.hidden = !S.att.length
  strip.innerHTML = S.att
    .map(
      (a, i) =>
        `<div class="thumb" title="${esc(a.name ?? '')}"><img src="${a.dataUrl}" alt="" /><button type="button" data-action="rm-att" data-i="${i}" title="移除">×</button><span>${Math.round(a.bytes / 1024)}KB</span></div>`,
    )
    .join('')
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('读取失败'))
    fr.readAsDataURL(file)
  })
}

async function shrinkImage(file, maxEdge) {
  if (file.size <= 900 * 1024) {
    const dataUrl = await readAsDataUrl(file)
    return { dataUrl, name: file.name, bytes: file.size }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(im.width, im.height))
      const w = Math.max(1, Math.round(im.width * scale))
      const h = Math.max(1, Math.round(im.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(im, 0, 0, w, h)
      URL.revokeObjectURL(url)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86)
      resolve({ dataUrl, name: file.name, bytes: Math.round(dataUrl.length * 0.75), w, h })
    }
    im.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法解析这张图'))
    }
    im.src = url
  })
}

async function addFiles(files) {
  const media = S.boot?.config?.media ?? {}
  const max = media.maxImagesPerMessage ?? 4
  const maxEdge = media.maxEdge ?? 1536
  for (const file of [...(files ?? [])]) {
    if (!/^image\//.test(file.type ?? '')) continue
    if (S.att.length >= max) {
      toast(`一条消息最多 ${max} 张图`, true)
      break
    }
    try {
      S.att.push(await shrinkImage(file, maxEdge))
    } catch (err) {
      toast(`图片处理失败：${err.message}`, true)
    }
  }
  renderAttachments()
  autogrow()
}

/* -------------------------------- streaming -------------------------------- */

async function startStream({ userText, regenerate = false, editId }) {
  if (S.stream) return toast('正在生成中…', true)
  const conversationId = S.current
  if (editId) {
    await api(`conversations/${conversationId}/truncate`, { method: 'POST', body: { messageId: editId } })
  }
  const inner = $('#threadInner')
  $('.hero', inner)?.remove()
  const outgoing = regenerate || editId ? [] : S.att.slice()
  if (outgoing.length) {
    S.att = []
    renderAttachments()
  }
  if (userText != null || outgoing.length) {
    const node = messageNode({ id: uid(), role: 'user', content: userText ?? '', images: outgoing.map((a) => ({ url: a.dataUrl })) })
    inner.append(node)
    scrollBottom()
  }
  if (regenerate) {
    const nodes = $$('.msg.assistant', inner)
    nodes.at(-1)?.remove()
  }

  const node = messageNode({ id: uid(), role: 'assistant', content: '', createdAt: new Date().toISOString(), model: $('#modelSelect').value })
  inner.append(node)
  const contentEl = $('.content', node)
  const stepsHost = { tools: [] }
  const st = { buffer: '', reasoning: '', ctrl: new AbortController(), node, contentEl, sources: [], notices: [] }
  S.stream = st
  setBusy(true)
  contentEl.innerHTML = '<span class="cursor"></span>'
  scrollBottom()

  let rendered = ''
  let pending = false
  const paint = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      if (rendered === st.buffer) return
      rendered = st.buffer
      contentEl.innerHTML = `${md(st.buffer)}<span class="cursor"></span>`
      scrollBottom(false)
    })
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-echo-request': 'echo' },
      body: JSON.stringify({
        conversationId,
        userText: regenerate ? undefined : userText,
        regenerate,
        images: outgoing.length ? outgoing.map((a) => a.dataUrl) : undefined,
        model: $('#modelSelect').value,
        searchMode: $('#searchSelect').value,
        enableThinking: prefs.thinking,
        temperature: S.boot?.config?.generation?.temperature,
      }),
      credentials: 'same-origin',
      signal: st.ctrl.signal,
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      throw new Error(e.message ?? `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let cut
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        const name = /^event: (.+)$/m.exec(frame)?.[1]
        const data = /^data: (.+)$/m.exec(frame)?.[1]
        if (!name || !data) continue
        try {
          handleEvent(name, JSON.parse(data))
        } catch (err) {
          console.error('事件渲染失败', name, err)
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      contentEl.innerHTML = `<div class="err">${esc(err.message)}</div>`
      toast(err.message, true)
    }
  } finally {
    finishStream(st, stepsHost)
  }

  function handleEvent(name, d) {
    if (S.stream !== st) return
    switch (name) {
      case 'meta':
        node.dataset.id = d.messageId
        if (d.memory?.length) {
          $('.meta', node).insertAdjacentHTML('beforeend', `<span title="注入了 ${d.memory.length} 条记忆">记忆×${d.memory.length}</span>`)
        }
        break
      case 'reasoning':
        st.reasoning += d.text
        openReasoning()
        break
      case 'delta':
        st.buffer += d.text
        paint()
        break
      case 'tool_call':
        stepsHost.tools.push({ id: d.id, name: d.name, label: d.label, args: d.args })
        renderStepsInto(stepsHost.tools)
        break
      case 'tool_result': {
        const t = stepsHost.tools.find((x) => x.id === d.id)
        if (t) {
          t.ok = d.ok
          t.ms = d.ms
          t.result = d.preview ?? d.error
        }
        renderStepsInto(stepsHost.tools)
        break
      }
      case 'sources':
        st.sources.push(...(d.items ?? []))
        break
      case 'images': {
        const gallery = node.querySelector('.gallery')
        const html = imageGallery(d.items ?? [])
        if (gallery) gallery.insertAdjacentHTML('beforeend', html.replace(/^<div class="gallery">|<\/div>$/g, ''))
        else $('.content', node).insertAdjacentHTML('afterend', html)
        scrollBottom(false)
        break
      }
      case 'notice':
        st.notices.push(d.text)
        $('.meta', node).insertAdjacentHTML('afterend', `<div class="notice">${esc(d.text)}</div>`)
        break
      case 'usage':
        break
      case 'done':
        st.done = d
        break
      case 'error':
        contentEl.innerHTML = `<div class="err">${esc(d.message)}</div>`
        break
    }
  }

  function openReasoning() {
    if ($('details.reasoning', node)) return
    const el = document.createElement('details')
    el.className = 'fold reasoning'
    el.open = true
    el.innerHTML = `<summary>思考中…</summary><div class="fold-body"></div>`
    node.querySelector('.meta').after(el)
  }

  function renderStepsInto(tools) {
    let fold = $('details.steps-fold', node)
    if (!fold) {
      fold = document.createElement('details')
      fold.className = 'fold steps-fold'
      fold.open = true
      const anchor = $('details.reasoning', node) ?? $('.meta', node)
      anchor.after(fold)
    }
    const rows = tools
      .map(
        (t) =>
          `<div class="step ${t.ok === false ? 'bad' : ''}"><i class="st-dot"></i><span class="st-name">${esc(t.label ?? t.name)}</span><span class="st-arg">${esc(
            Object.values(t.args ?? {}).map(String).join(' · ').slice(0, 90),
          )}</span><span class="st-ms">${t.ok === false ? '失败' : t.ms ? `${t.ms}ms` : '…'}</span></div>`,
      )
      .join('')
    fold.innerHTML = `<summary>调用 ${tools.length} 次工具</summary><div class="fold-body"><div class="steps">${rows}</div></div>`
    scrollBottom(false)
  }

  async function finishStream(st, host) {
    const d = st.done
    const finalText = d?.message?.content ?? st.buffer
    st.contentEl.innerHTML = md(finalText)
    if (!finalText.trim() && !$('.err', node)) st.contentEl.innerHTML = '<p class="muted">（没有内容）</p>'
    if (st.reasoning) {
      const el = $('details.reasoning', node)
      if (el) {
        el.open = false
        el.querySelector('summary').textContent = `思考过程 · ${st.reasoning.length} 字`
        $('.fold-body', el).textContent = st.reasoning
      }
    }
    const sources = d?.sources?.length ? d.sources : st.sources
    renderTail(node, { ...(d?.message ?? {}), usage: d?.usage, sources, searchMode: $('#searchSelect').value })
    setBusy(false)
    S.stream = null
    await refreshList()
    if (S.boot) {
      const c = S.convs.find((x) => x.id === S.current)
      if (c) $('#convTitle').textContent = c.title
    }
    scrollBottom(st.buffer.length > 40)
  }
}

function setBusy(busy) {
  $('#stopBtn').hidden = !busy
  $('#sendBtn').disabled = busy
  $('#sendBtn').textContent = busy ? '生成中' : '发送'
  document.body.classList.toggle('busy', busy)
}

/* --------------------------------- panels ---------------------------------- */

async function openPanel(name) {
  S.panel = name
  $('#drawer').hidden = false
  $('#scrim').hidden = false
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.panel === name)))
  ;['memory', 'proactive', 'settings'].forEach((p) => ($(`#panel${cap(p)}`).hidden = p !== name))
  if (name === 'memory') await renderMemoryPanel()
  if (name === 'proactive') await renderProactivePanel()
  if (name === 'settings') await renderSettingsPanel()
}
const cap = (s) => s[0].toUpperCase() + s.slice(1)
function closeDrawer() {
  $('#drawer').hidden = true
  $('#scrim').hidden = true
}

async function renderMemoryPanel() {
  const el = $('#panelMemory')
  const [mem, dream, forgetting, screen] = await Promise.all([api('memory'), api('dream'), api('memory/forgetting'), api('screen')])
  const f = mem.stats.forgetting ?? {}
  el.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${mem.stats.observations}</b><span>有效事实</span></div>
      <div class="stat"><b>${f.avgStrength ?? 0}</b><span>平均强度</span></div>
      <div class="stat"><b>${f.faded ?? 0}</b><span>已淡出</span></div>
      <div class="stat"><b>${f.fadingSoon ?? 0}</b><span>接近淡出</span></div>
    </div>
    <p class="muted small">记忆强度 = 重要度 × 使用增益 × 时间衰减。被用到会变牢，太久没用会淡出；淡出不是删除，随时可以复活。已经不需要的，Dream 会明确忘掉并写下理由。</p>

    ${screen.screen.enabled ? screenBlock(screen) : ''}

    <div class="sect">
      <h4>核心记忆 MEMORY.md <span class="muted">· 每次对话都会注入</span></h4>
      <textarea id="coreEdit" class="core-editor">${esc(mem.core)}</textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn small primary" data-action="save-core">保存</button>
        <button class="btn small" data-action="dream-now">立即 Dream（巩固 + 遗忘）</button>
        <span class="muted small">上次：${dream.last ? ago(dream.last) : '还没跑过'}</span>
      </div>
    </div>

    <div class="sect">
      <h4>跟进事项</h4>
      <div class="list">${
        dream.loops.length
          ? dream.loops
              .map(
                (l) => `<div class="loop"><div class="row"><b>${esc(l.topic)}</b>${l.due ? `<span class="due">截止 ${esc(l.due)}</span>` : ''}
                  <button class="btn small ghost right" data-action="loop-done" data-id="${esc(l.id)}">完成</button></div>
                  <div class="muted small">${esc(l.why ?? '')}${l.raised ? ` · 已提过 ${l.raised} 次` : ''}</div></div>`,
              )
              .join('')
          : '<div class="muted small">Dream 还没有整理出需要跟进的事。</div>'
      }</div>
    </div>

    <div class="sect">
      <h4>事实清单 <span class="muted small">· 用到它才会留下</span></h4>
      <div class="filter" style="margin-bottom:8px"><svg viewBox="0 0 24 24" class="i"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input id="memFilter" type="search" placeholder="过滤事实" /></div>
      <div class="list" id="memList">${mem.observations.map(obsHtml).join('') || '<div class="muted small">还没有记录。对话中说"记住…"或者直接手动添加。</div>'}</div>
      <div class="row" style="margin-top:10px">
        <input id="newMem" type="text" placeholder="手动记一条事实" style="flex:1;border:1px solid var(--border-strong);border-radius:9px;padding:8px 10px;background:var(--panel-2)" />
        <button class="btn small primary" data-action="add-mem">添加</button>
      </div>
    </div>

    <div class="sect">
      <h4>已忘记 / 已淡出（${(forgetting.items ?? []).length}）</h4>
      <p class="muted small">我们不是我们记住的东西，而是我们忘记的东西。这里是它丢掉的部分和原因。</p>
      <div class="list">${
        (forgetting.items ?? []).length
          ? forgetting.items
              .map(
                (o) => `<div class="mem-item ${o.status === 'deleted' ? 'gone' : ''}">
                  <div class="txt">${esc(o.text)}
                    <div class="muted small">${o.status === 'faded' ? '淡出' : '已忘'} · ${esc(o.reason)} · 重要度 ${o.importance} · 命中 ${o.hits} 次${o.strength != null ? ` · 强度 ${o.strength}` : ''}</div>
                  </div>
                  <button class="btn small ghost" data-action="revive" data-id="${esc(o.id)}">复活</button>
                </div>`,
              )
              .join('')
          : '<div class="muted small">还没有忘记任何东西。</div>'
      }</div>
      <details class="fold" style="margin-top:8px"><summary>遗忘日志（谁在什么时候被忘掉、为什么）</summary>
        <div class="fold-body">${(forgetting.log ?? []).map((b) => `<pre style="white-space:pre-wrap;font:11.5px/1.6 var(--mono)">${esc(b)}</pre>`).join('') || '<span class="muted">（空）</span>'}</div>
      </details>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="forget-scan">试跑一次遗忘扫描（不改动）</button></div>
    </div>`
  $('#memFilter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase()
    $$('#memList .mem-item').forEach((n) => (n.style.display = n.textContent.toLowerCase().includes(q) ? '' : 'none'))
  })
}

function screenBlock(screen) {
  const s = screen.screen
  const ev = (s.events ?? []).slice(0, 5)
  const st = screen.storage
  return `<div class="sect">
    <h4>此刻在做什么 <span class="muted small">· 本地 OCR，原始截图不保留</span></h4>
    ${s.lastAt ? `<div class="muted small">上次感知 ${ago(s.lastAt)} · 今天 ${s.todayCount} 次 · 工作记忆 ${s.workingCount} 条</div>` : '<div class="muted small">还没感知过。点下面的按钮试一次。</div>'}
    <div class="list" style="margin-top:8px">${ev
      .map(
        (e) => `<div class="mem-item"><div class="txt">${esc(e.activity || '(未识别)')}
          <div class="muted small">${String(e.ts).slice(11, 16)} · ${esc(e.app || '?')} · ${e.focus}${e.sensitive ? ' · 敏感已隐去' : ''}</div></div></div>`,
      )
      .join('')}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-action="look-now">现在看一眼</button>
      <button class="btn small" data-action="screen-digest">沉淀成记忆</button>
      <span class="muted small">磁盘：截图 ${st.screenshots.mb}MB / ${st.screenshots.budgetMB}MB · 图片 ${st.uploads.mb}MB / ${st.uploads.budgetMB}MB</span>
    </div>
  </div>`
}

function obsHtml(o) {
  const gone = o.status !== 'active'
  const strength = o.strength ?? null
  return `<div class="mem-item ${gone ? 'gone' : ''}" data-id="${esc(o.id)}">
    <div class="txt">${o.protected ? '📌 ' : ''}${esc(o.text)}
      <div class="muted small">${esc(o.kind)} · 重要度 ${o.importance}${strength != null ? ` · 强度 ${strength}` : ''} · 命中 ${o.hits ?? 1} 次 · ${String(o.created_at ?? '').slice(0, 10)}${o.source ? ` · ${esc(o.source)}` : ''}</div>
    </div>
    ${gone
      ? '<span class="tag">已淡出</span>'
      : `<button class="btn small ghost" data-action="protect-mem" data-id="${esc(o.id)}" data-on="${o.protected ? '0' : '1'}" title="保护后不再淡出">${o.protected ? '取消保护' : '保护'}</button>
         <button class="btn small ghost" data-action="forget-mem" data-id="${esc(o.id)}" title="让它从记忆里消失">忘掉</button>`}
  </div>`
}

async function renderProactivePanel() {
  const el = $('#panelProactive')
  const [p, dream, agency] = await Promise.all([api('proactive'), api('dream'), api('agency')])
  const nudgeHtml = (dream.nudges ?? [])
    .map((n) => `<div class="mem-item"><div class="txt">${esc(n.topic)}<div class="muted small">${esc(n.angle ?? '')} · 急迫度 ${n.urgency}</div></div></div>`)
    .join('')
  const kindRows = (agency.kinds ?? [])
    .map((k) => {
      const thr = (p.kindThresholds ?? {})[k.kind]
      return `<div class="mem-item"><div class="txt">${esc(KIND_LABEL[k.kind] ?? k.kind)}
        <div class="muted small">被接住率 ${k.mean} · 样本 ${k.trials} 次 · 后验 Beta(${k.a}, ${k.b})${thr ? ` · 当前门槛 ${thr}` : ''}</div>
      </div><div class="bar" style="width:56px"><i style="width:${Math.round(k.mean * 100)}%"></i></div></div>`
    })
    .join('')
  el.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${p.todayCount}/${p.budget}</b><span>今日主动开口</span></div>
      <div class="stat"><b>${(p.history ?? []).filter((h) => h.replied).length}</b><span>被你接住过</span></div>
      <div class="stat"><b>${p.consecutiveIgnores}</b><span>连续未回应</span></div>
    </div>
    <div class="switch"><span>启用主动服务</span><input type="checkbox" id="proEnabled" ${p.enabled ? 'checked' : ''} /></div>
    <div class="row">
      <button class="btn small primary" data-action="pro-run">现在就让它说一句</button>
      <span class="muted small">下次检查：${p.lastCheckAt ? ago(p.lastCheckAt) : '—'}｜上次开口：${p.lastAt ? ago(p.lastAt) : '从未'}</span>
    </div>
    <div class="sect">
      <h4>最近一次判断</h4>
      <div class="kv">
        <dt>是否开口</dt><dd>${p.lastDecision ? (p.lastDecision.act ? '是' : '否') : '—'}</dd>
        <dt>置信度</dt><dd>${p.lastDecision?.confidence != null ? p.lastDecision.confidence.toFixed(2) : '—'}</dd>
        <dt>理由</dt><dd style="text-align:left">${esc(p.lastDecision?.reason ?? '—')}</dd>
        <dt>静默时段</dt><dd>${esc(p.quietHours?.start ?? '—')} → ${esc(p.quietHours?.end ?? '—')}</dd>
        <dt>当前门禁</dt><dd>${esc(p.nextGate?.allow ? '可开口' : `拦截：${p.nextGate?.reason ?? '?'}`)}</dd>
      </div>
    </div>
    <div class="sect">
      <h4>反馈学习（哪种开口方式你更受用）</h4>
      <p class="muted small">每次开口都会被记一笔：你接住了就记为 1，6 小时没回应按 0 结算。表现好的类型更容易被选中，表现差的需要更高的把握才开口。</p>
      <div class="list">${kindRows || '<div class="muted small">还没有样本。</div>'}</div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-action="fb" data-signal="more" data-kind="global">多说一点</button>
        <button class="btn small" data-action="fb" data-signal="less" data-kind="global">少说一点</button>
      </div>
    </div>
    <div class="sect">
      <h4>候选话题（来自 Dream）</h4>
      <div class="list">${nudgeHtml || '<div class="muted small">还没有候选话题。</div>'}</div>
    </div>
    <div class="sect">
      <h4>最近的主动消息</h4>
      <div class="list">${
        (p.history ?? []).length
          ? [...p.history].reverse()
              .map(
                (h) => `<div class="mem-item"><div class="txt">${esc(h.message)}
                  <div class="muted small">${fmtTime(h.at)} · ${KIND_LABEL[h.kind] ?? h.kind} · ${h.replied ? '你回过' : '未回应'}</div></div></div>`,
              )
              .join('')
          : '<div class="muted small">还没有主动发过消息。</div>'
      }</div>
    </div>`
  $('#proEnabled').addEventListener('change', async (e) => {
    await api('proactive', { method: 'PATCH', body: { enabled: e.target.checked } })
    toast(e.target.checked ? '主动服务已开启' : '主动服务已暂停')
    await boot({ keep: true })
  })
}

async function renderSettingsPanel() {
  const el = $('#panelSettings')
  const c = S.boot.config
  const [mcp, screen] = await Promise.all([api('mcp'), api('screen')])
  S.screen = screen
  el.innerHTML = `
    <div class="sect">
      <h4>对话</h4>
      <div class="field"><label>默认模型</label>
        <select id="setModel">${c.models.map((m) => `<option value="${esc(m.id)}" ${m.id === c.defaultModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
      <div class="field"><label>温度 <b>${c.generation.temperature}</b></label>
        <input type="range" id="setTemp" min="0" max="1.4" step="0.05" value="${c.generation.temperature}" /></div>
      <div class="field"><label>系统提示词</label><textarea id="setSystem">${esc(c.systemPrompt)}</textarea></div>
    </div>
    <div class="sect">
      <h4>联网</h4>
      <div class="switch"><span>允许联网搜索</span><input type="checkbox" id="setSearchOn" ${c.search.enabled ? 'checked' : ''} /></div>
      <div class="field"><label>搜索引擎</label>
        <select id="setProvider">
          <option value="auto" ${c.search.provider === 'auto' ? 'selected' : ''}>自动（360/Bing 抓取，失败回退阿里云托管）</option>
          <option value="fast" ${c.search.provider === 'fast' ? 'selected' : ''}>只用本地抓取（最快）</option>
          <option value="native" ${c.search.provider === 'native' ? 'selected' : ''}>只用阿里云托管 web_search（慢，约 30s）</option>
        </select></div>
      <div class="field"><label>搜索结果条数 <b>${c.search.maxResults}</b></label>
        <input type="range" id="setCount" min="3" max="10" step="1" value="${c.search.maxResults}" /></div>
      <div class="switch"><span>自动读取首条结果正文</span><input type="checkbox" id="setReadPages" ${c.search.readPages ? 'checked' : ''} /></div>
      <div class="field"><label>一轮回答最多调用工具次数 <b>${c.search.maxToolRounds}</b></label>
        <input type="range" id="setRounds" min="1" max="12" step="1" value="${c.search.maxToolRounds}" /></div>
    </div>
    <div class="sect">
      <h4>自我报告 <span class="muted small">· 来自本机 metrics.jsonl</span></h4>
      <div id="diagBox" class="list"><div class="muted small">加载中…</div></div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-action="load-diag">刷新自报告</button>
        <button class="btn small" data-action="backup">导出备份（JSON）</button>
      </div>
    </div>
    <div class="sect">
      <h4>隐私兜底</h4>
      <p class="muted small">「全部忘掉」会清空事实清单、工作记忆、实体图与核心记忆，并在遗忘日志里留一条记录。会话记录默认保留。</p>
      <div class="row">
        <button class="btn small" data-action="wipe" data-scope="memory">清空全部记忆</button>
        <button class="btn small" data-action="wipe" data-scope="all">连会话一起清空</button>
      </div>
    </div>
    <div class="sect">
      <h4>图片与多模态</h4>
      <div class="switch"><span>允许发图（视觉理解）</span><input type="checkbox" id="setImageIn" ${c.media?.imageInput !== false ? 'checked' : ''} /></div>
      <div class="switch"><span>允许出图（image_gen 工具）</span><input type="checkbox" id="setImageOut" ${c.media?.imageOutput !== false ? 'checked' : ''} /></div>
      <div class="field"><label>出图模型</label>
        <select id="setImageModel">${(c.imageModels ?? [])
          .map((m) => `<option value="${esc(m.id)}" ${m.id === c.defaultImageModel ? 'selected' : ''}>${esc(m.label)}${m.note ? ` · ${esc(m.note)}` : ''}</option>`)
          .join('')}</select></div>
      <div class="field"><label>发图前压缩最长边 <b>${c.media?.maxEdge ?? 1536}</b> px</label>
        <input type="range" id="setMaxEdge" min="768" max="2048" step="128" value="${c.media?.maxEdge ?? 1536}" /></div>
      <p class="muted small">实测这个网关开放的模态：文本/推理、视觉理解、图片生成。未开放：视频（wan3.0-video、happyhorse-1.1-* 返回 url error）、语音 ASR（空响应）、TTS（InternalError）、decision-model-preview（未路由）。</p>
    </div>
    <div class="sect">
      <h4>屏幕感知</h4>
      <div class="switch"><span>开启屏幕感知（状态栏 App 采集）</span><input type="checkbox" id="setScreenOn" ${c.screen?.enabled ? 'checked' : ''} /></div>
      <div class="field"><label>采集间隔 <b>${c.screen?.intervalMinutes ?? 5}</b> 分钟</label>
        <input type="range" id="setScreenGap" min="1" max="30" step="1" value="${c.screen?.intervalMinutes ?? 5}" /></div>
      <div class="field"><label>分析方式</label>
        <select id="setScreenMode">
          <option value="ocr" ${c.screen?.mode !== 'image' ? 'selected' : ''}>本地 OCR 文字（推荐：原始截图不出本机）</option>
          <option value="image" ${c.screen?.mode === 'image' ? 'selected' : ''}>连截图一起发给模型（更准，图片会离开本机）</option>
        </select></div>
      <div class="field"><label>原始截图</label>
        <select id="setKeepImages">
          <option value="0" ${!c.screen?.keepImages ? 'selected' : ''}>不保留（分析完立即删除）</option>
          <option value="1" ${c.screen?.keepImages ? 'selected' : ''}>保留（受磁盘预算约束，超了从最旧删）</option>
        </select></div>
      <div class="field"><label>截图保留天数 <b>${c.screen?.retentionDays ?? 3}</b></label>
        <input type="range" id="setScreenDays" min="0" max="14" step="1" value="${c.screen?.retentionDays ?? 3}" /></div>
      <div class="field"><label>黑名单应用（命中完全不采集，逗号分隔）</label>
        <input type="text" id="setBlocklist" value="${esc((c.screen?.blocklist ?? []).join('、'))}" /></div>
      <div class="field"><label>敏感关键词正则（命中跳过，逗号分隔）</label>
        <input type="text" id="setExcludes" value="${esc((c.screen?.excludeTitlePatterns ?? []).join(','))}" /></div>
      <p class="muted small">锁屏、键鼠空闲、黑名单应用都不会被采集。默认只把本地 OCR 出的文字发给模型；原始截图分析完即删，绝不进归档。</p>
    </div>
    <div class="sect">
      <h4>磁盘预算</h4>
      <div class="muted small">当前：截图 ${(S.screen?.storage?.screenshots?.mb ?? 0)}MB · 生成图片 ${(S.screen?.storage?.uploads?.mb ?? 0)}MB · 文本数据 ${(S.screen?.storage?.texts?.kb ?? 0)}KB</div>
      <div class="field"><label>截图目录上限 <b>${c.storage?.screenImageBudgetMB ?? 200}</b> MB</label>
        <input type="range" id="setShotBudget" min="20" max="1000" step="20" value="${c.storage?.screenImageBudgetMB ?? 200}" /></div>
      <div class="field"><label>生成图片上限 <b>${c.storage?.uploadsBudgetMB ?? 300}</b> MB</label>
        <input type="range" id="setUploadBudget" min="50" max="2000" step="50" value="${c.storage?.uploadsBudgetMB ?? 300}" /></div>
      <div class="row"><button class="btn small" data-action="storage-prune">立即清理</button>
        <span class="muted small">超过 80% 预算会自动从最旧的删；最近对话引用到的图片永不删。</span></div>
    </div>
    <div class="sect">
      <h4>记忆</h4>
      <div class="switch"><span>启用长期记忆</span><input type="checkbox" id="setMemOn" ${c.memory.enabled ? 'checked' : ''} /></div>
      <div class="switch"><span>对话后自动抽取事实</span><input type="checkbox" id="setExtract" ${c.memory.extract ? 'checked' : ''} /></div>
      <div class="switch"><span>把记忆注入提示词</span><input type="checkbox" id="setInject" ${c.memory.inject ? 'checked' : ''} /></div>
    </div>
    <div class="sect">
      <h4>Dream 与主动服务</h4>
      <div class="switch"><span>定期 Dream 提炼</span><input type="checkbox" id="setDreamOn" ${c.dream.enabled ? 'checked' : ''} /></div>
      <div class="field"><label>提炼间隔（小时）<b>${c.dream.intervalHours}</b></label>
        <input type="range" id="setDreamGap" min="1" max="24" step="1" value="${c.dream.intervalHours}" /></div>
      <div class="field"><label>每日主动消息上限 <b>${c.proactive.dailyBudget}</b></label>
        <input type="range" id="setBudget" min="0" max="12" step="1" value="${c.proactive.dailyBudget}" /></div>
      <div class="field"><label>最少间隔（分钟）<b>${c.proactive.minGapMinutes}</b></label>
        <input type="range" id="setMinGap" min="10" max="240" step="5" value="${c.proactive.minGapMinutes}" /></div>
      <div class="field"><label>开口置信度阈值 <b>${c.proactive.confidenceThreshold}</b></label>
        <input type="range" id="setThresh" min="0.3" max="0.95" step="0.01" value="${c.proactive.confidenceThreshold}" /></div>
      <div class="field"><label>静默时段（本地时间）</label>
        <div class="row"><input type="text" id="setQuietStart" value="${esc(c.proactive.quietHours.start)}" style="width:110px" />
        <span class="muted">→</span><input type="text" id="setQuietEnd" value="${esc(c.proactive.quietHours.end)}" style="width:110px" /></div></div>
      <div class="switch"><span>主动消息弹 macOS 通知</span><input type="checkbox" id="setNotify" ${c.proactive.notify ? 'checked' : ''} /></div>
    </div>
    <div class="sect">
      <h4>MCP 服务</h4>
      <div class="list">${
        mcp.servers.length
          ? mcp.servers.map((s) => `<div class="mem-item"><div class="txt">${esc(s.name)}<div class="muted small">${s.state} · ${s.tools} 个工具${s.error ? ` · ${esc(s.error)}` : ''}</div></div></div>`).join('')
          : '<div class="muted small">没有配置 MCP。在 config.json 的 mcpServers 里加 stdio 或 http 服务后点重新加载。</div>'
      }</div>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="mcp-reload">重新加载 MCP</button>
      <button class="btn small" data-action="search-test">测试搜索链路</button></div>
    </div>
    <div class="sect">
      <h4>服务</h4>
      <div class="kv"><dt>监听</dt><dd>${c.bind === 'all' ? '局域网 0.0.0.0' : '仅本机'}:${c.port}</dd>
      <dt>数据目录</dt><dd style="text-align:left;font:11px var(--mono)">data/</dd></div>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="change-passwd">改访问口令</button></div>
      <div class="row"><button class="btn small primary" data-action="save-settings">保存设置</button><span id="setSaved" class="muted small"></span></div>
    </div>`
}

async function saveSettings() {
  const body = {
    config: {
      upstream: { defaultModel: $('#setModel').value, defaultImageModel: $('#setImageModel').value },
      generation: { temperature: Number($('#setTemp').value) },
      media: { imageInput: $('#setImageIn').checked, imageOutput: $('#setImageOut').checked, maxEdge: Number($('#setMaxEdge').value) },
      systemPrompt: $('#setSystem').value,
      search: {
        enabled: $('#setSearchOn').checked,
        provider: $('#setProvider').value,
        maxResults: Number($('#setCount').value),
        readPages: $('#setReadPages').checked,
        maxToolRounds: Number($('#setRounds').value),
      },
      memory: { enabled: $('#setMemOn').checked, extract: $('#setExtract').checked, inject: $('#setInject').checked },
      screen: {
        enabled: $('#setScreenOn').checked,
        intervalMinutes: Number($('#setScreenGap').value),
        mode: $('#setScreenMode').value,
        keepImages: $('#setKeepImages').value === '1',
        retentionDays: Number($('#setScreenDays').value),
        blocklist: $('#setBlocklist').value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
        excludeTitlePatterns: $('#setExcludes').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      },
      storage: { screenImageBudgetMB: Number($('#setShotBudget').value), uploadsBudgetMB: Number($('#setUploadBudget').value) },
      dream: { enabled: $('#setDreamOn').checked, intervalHours: Number($('#setDreamGap').value) },
      proactive: {
        dailyBudget: Number($('#setBudget').value),
        minGapMinutes: Number($('#setMinGap').value),
        confidenceThreshold: Number($('#setThresh').value),
        notify: $('#setNotify').checked,
        quietHours: { start: $('#setQuietStart').value.trim(), end: $('#setQuietEnd').value.trim() },
      },
    },
  }
  await api('settings', { method: 'PATCH', body })
  $('#setSaved').textContent = '已保存，立即生效'
  toast('设置已保存')
  await boot({ keep: true })
}

/* ------------------------------- conversations ------------------------------ */

async function selectConv(id) {
  if (S.stream) return toast('正在生成，先停止', true)
  S.current = id
  S.conv = await api(`conversations/${id}`)
  if (S.conv.unread) await api(`conversations/${id}`, { method: 'PATCH', body: { unread: 0 } })
  $('#convTitle').textContent = S.conv.title ?? '对话'
  $('#modelSelect').value = S.conv.model ?? prefs.model ?? S.boot.config.defaultModel
  $('#searchSelect').value = S.conv.searchMode ?? prefs.searchMode
  renderConvs()
  renderThread()
  $('#input').value = localStorage.getItem(`echo.draft.${id}`) ?? ''
  autogrow()
}

async function newChat() {
  const conv = await api('conversations', { method: 'POST', body: { title: '新对话' } })
  await refreshList()
  await selectConv(conv.id)
  $('#input').focus()
}

/* ---------------------------------- boot ----------------------------------- */

async function boot({ keep = false } = {}) {
  const b = await api('bootstrap')
  S.boot = b
  S.convs = b.conversations
  $('#gate').hidden = true
  $('#app').hidden = false
  $('#app').dataset.sidebar = matchMedia('(min-width: 860px)').matches ? 'open' : 'closed'
  applyTheme()
  const sel = $('#modelSelect')
  const wantModel = prefs.model ?? b.config.defaultModel
  sel.innerHTML = modelOptionsHtml(b.config.models, wantModel)
  sel.value = wantModel
  $('#searchSelect').value = prefs.searchMode
  $('#thinkingBtn').setAttribute('aria-pressed', String(prefs.thinking))
  renderConvs()
  const target = keep && S.current ? S.current : b.main?.id ?? S.convs[0]?.id
  if (target) await selectConv(target)
  startPolling()
}

function startPolling() {
  clearInterval(S.poll)
  S.poll = setInterval(async () => {
    if (S.stream || document.hidden) return
    try {
      const b = await api('bootstrap')
      S.boot = b
      const before = S.convs.find((c) => c.id === S.current)?.messageCount ?? 0
      S.convs = b.conversations
      renderConvs()
      const cur = S.convs.find((c) => c.id === S.current)
      if (cur && cur.messageCount > before) {
        S.conv = await api(`conversations/${S.current}`)
        renderThread()
        if (S.current === 'main') toast('Echo 主动发了一条消息')
      }
    } catch {}
  }, 20000)
}

function autogrow() {
  const t = $('#input')
  t.style.height = 'auto'
  t.style.height = `${Math.min(t.scrollHeight, innerHeight * 0.4)}px`
  const model = $('#modelSelect').selectedOptions[0]?.textContent ?? ''
  const mode = $('#searchSelect').value
  $('#ctxChip').textContent = `${model} · ${mode === 'off' ? '不联网' : mode === 'on' ? '强制搜索' : '按需搜索'}${prefs.thinking ? ' · 思考开' : ''}`
}

/* --------------------------------- events ---------------------------------- */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const act = btn.dataset.action
  const id = btn.dataset.id

  if (act === 'copy-code') {
    const pre = btn.closest('pre')
    navigator.clipboard.writeText($('code', pre).textContent).then(() => toast('代码已复制'))
    return
  }
  if (act === 'copy-msg') {
    const msg = btn.closest('.msg')
    const text = (msg.classList.contains('user') ? $('.body', msg) : $('.content', msg))?.innerText ?? msg.innerText
    navigator.clipboard.writeText(text).then(() => toast('已复制'))
    return
  }
  if (act === 'edit-user') {
    const node = btn.closest('.msg')
    const current = node.querySelector('.body').innerText
    node.querySelector('.body').outerHTML = `<div class="body edit-box"><textarea>${esc(current)}</textarea>
      <div class="row"><button class="btn small" data-action="edit-cancel">取消</button><button class="btn small primary" data-action="edit-save">保存并重发</button></div></div>`
    return
  }
  if (act === 'edit-cancel') { await selectConv(S.current); return }
  if (act === 'edit-save') {
    const node = btn.closest('.msg')
    const text = $('textarea', node).value.trim()
    if (!text) return
    if (S.stream) return toast('正在生成', true)
    const editId = node.dataset.id
    node.remove()
    startStream({ userText: text, editId })
    return
  }
  if (act === 'regen') return startStream({ regenerate: true })
  if (act === 'stop') {
    await api('chat/stop', { method: 'POST', body: { conversationId: S.current } })
    S.stream?.ctrl.abort()
    return
  }
  if (act === 'fb') {
    const signal = btn.dataset.signal
    const r = await api('feedback', { method: 'POST', body: { signal, kind: btn.dataset.kind, conversationId: S.current, messageId: btn.dataset.id } })
    btn.parentElement.querySelectorAll('button[data-action="fb"]').forEach((b) => (b.style.color = ''))
    btn.style.color = signal === 'good' ? 'var(--accent)' : 'var(--danger)'
    toast(signal === 'good' ? '收到：这类消息会更多' : '收到：这类消息会更少')
    void r
    return
  }
  if (act === 'sug') { $('#input').value = btn.textContent; autogrow(); $('#composer').requestSubmit(); return }
  if (act === 'attach') { $('#fileInput').click(); return }
  if (act === 'rm-att') { S.att.splice(Number(btn.dataset.i), 1); renderAttachments(); autogrow(); return }
  if (act === 'draw') {
    const prompt = $('#input').value.trim() || window.prompt('要画什么？可以带上风格、构图、光线')
    if (!prompt) return
    toast('正在出图，大约 10–30 秒…')
    try {
      const r = await api('images', { method: 'POST', body: { prompt, model: S.boot.config.defaultImageModel, conversationId: S.current } })
      const inner = $('#threadInner')
      $('.hero', inner)?.remove()
      inner.append(
        messageNode(
          r.message ?? {
            id: uid(),
            role: 'assistant',
            content: `画好了：${prompt}`,
            images: [{ url: r.path, prompt }],
            createdAt: new Date().toISOString(),
            model: r.model,
          },
        ),
      )
      scrollBottom()
      await refreshList()
    } catch (err) {
      toast(`出图失败：${err.message}`, true)
    }
    return
  }
  if (act === 'toggle-sidebar') {
    const app = $('#app')
    app.dataset.sidebar = app.dataset.sidebar === 'open' ? 'closed' : 'open'
    return
  }
  if (act === 'new-chat') return newChat()
  if (act === 'select-conv') return selectConv(id)
  if (act === 'pin-conv') {
    const c = S.convs.find((x) => x.id === id)
    await api(`conversations/${id}`, { method: 'PATCH', body: { pinned: !c?.pinned } })
    return refreshList()
  }
  if (act === 'del-conv') {
    if (!confirm('删除这个会话？')) return
    await api(`conversations/${id}`, { method: 'DELETE' })
    if (S.current === id) { const m = S.convs.find((c) => c.isMain); await refreshList(); return selectConv(m.id) }
    return refreshList()
  }
  if (act === 'export-conv') { window.open(`/api/conversations/${id}/export`, '_blank'); return }
  if (act === 'open-panel' || act === 'tab') return openPanel(btn.dataset.panel)
  if (act === 'close-drawer') return closeDrawer()
  if (act === 'toggle-thinking') {
    prefs.thinking = !prefs.thinking
    $('#thinkingBtn').setAttribute('aria-pressed', String(prefs.thinking))
    autogrow()
    return
  }
  if (act === 'cycle-theme') {
    prefs.theme = { auto: 'light', light: 'dark', dark: 'auto' }[prefs.theme]
    applyTheme()
    return
  }
  if (act === 'dream-now') {
    toast('Dream 正在提炼…')
    const r = await api('dream', { method: 'POST', body: {} })
    toast(r.result?.ok ? `Dream 完成：${r.result.summary?.join('；') ?? ''}` : `Dream 失败：${r.result?.error ?? ''}`, !r.result?.ok)
    await boot({ keep: true })
    if (!$('#panelMemory').hidden) await renderMemoryPanel()
    return
  }
  if (act === 'save-core') {
    await api('memory/core', { method: 'PUT', body: { text: $('#coreEdit').value } })
    toast('核心记忆已保存')
    return renderMemoryPanel()
  }
  if (act === 'add-mem') {
    const text = $('#newMem').value.trim()
    if (!text) return
    await api('memory/observation', { method: 'POST', body: { text, kind: 'fact', importance: 3 } })
    $('#newMem').value = ''
    return renderMemoryPanel()
  }
  if (act === 'del-mem') {
    await api(`memory/observation/${id}`, { method: 'DELETE' })
    return renderMemoryPanel()
  }
  if (act === 'forget-mem') {
    const why = prompt('为什么要忘掉它？（会写进遗忘日志）', '用户要求忘记')
    if (why === null) return
    await api('memory/forget', { method: 'POST', body: { id, why } })
    toast('已忘掉，并记下了理由')
    return renderMemoryPanel()
  }
  if (act === 'protect-mem') {
    const on = btn.dataset.on === '1'
    await api('memory/protect', { method: 'POST', body: { id, on } })
    toast(on ? '已保护：不再自动淡出' : '已取消保护')
    return renderMemoryPanel()
  }
  if (act === 'revive') {
    await api('memory/protect', { method: 'POST', body: { id, on: true } })
    toast('已复活并保护')
    return renderMemoryPanel()
  }
  if (act === 'forget-scan') {
    const r = await api('memory/forget-scan', { method: 'POST', body: { dryRun: true } })
    const n = r.result.faded.length
    toast(n ? `扫描 ${r.result.scanned} 条，有 ${n} 条将淡出（未改动）` : `扫描 ${r.result.scanned} 条，暂时没有该淡出的`)
    return
  }
  if (act === 'look-now') {
    await api('screen/capture', { method: 'POST', body: { reason: 'ui' } })
    toast('已请求状态栏 App 立即感知一次（约 3–10 秒）')
    setTimeout(() => renderMemoryPanel().catch(() => {}), 9000)
    return
  }
  if (act === 'screen-digest') {
    const r = await api('screen/digest', { method: 'POST', body: {} })
    toast(r.session ? `已沉淀：${r.session.summary}` : `样本不足（${r.count ?? 0} 条）`, !r.session)
    return renderMemoryPanel()
  }
  if (act === 'storage-prune') {
    const r = await api('storage/prune', { method: 'POST', body: {} })
    toast(`清理完成，释放 ${r.report.freedMB}MB`)
    return renderSettingsPanel()
  }
  if (act === 'loop-done') {
    await api('dream/loop', { method: 'PATCH', body: { id, status: 'done' } })
    return renderMemoryPanel()
  }
  if (act === 'pro-run') {
    toast('正在判断该不该开口…')
    const r = await api('proactive/run', { method: 'POST', body: {} })
    if (r.result?.acted) { toast(`已发一条：${KIND_LABEL[r.result.message.kind] ?? ''}`); await selectConv('main') }
    else toast(`这次没开口（${r.result?.skipped}${r.result?.confidence ? ` / ${r.result.confidence.toFixed(2)}` : ''}）`)
    return renderProactivePanel()
  }
  if (act === 'load-diag') {
    const d = await api('diagnostics')
    const m = d.metrics ?? {}
    const t = m.turns ?? {}
    const toolRows = Object.entries(m.tools ?? {})
      .map(([k, v]) => `<div class="mem-item"><div class="txt">${esc(k)}<div class="muted small">${v.count} 次 · 成功率 ${(v.okRate * 100).toFixed(0)}% · P50 ${v.p50Ms}ms · P95 ${v.p95Ms}ms</div></div></div>`)
      .join('')
    const searchRows = Object.entries(m.search ?? {})
      .map(([k, v]) => `<div class="mem-item"><div class="txt">搜索 · ${esc(k)}<div class="muted small">${v.count} 次 · 成功率 ${(v.okRate * 100).toFixed(0)}% · P50 ${v.p50Ms}ms</div></div></div>`)
      .join('')
    $('#diagBox').innerHTML = `
      <div class="stat-row">
        <div class="stat"><b>${t.count ?? 0}</b><span>近 7 天生成</span></div>
        <div class="stat"><b>${((t.errorRate ?? 0) * 100).toFixed(0)}%</b><span>失败率</span></div>
        <div class="stat"><b>${t.p95Ms ?? 0}</b><span>P95 延迟(ms)</span></div>
        <div class="stat"><b>${m.proactive?.replyRate != null ? `${(m.proactive.replyRate * 100).toFixed(0)}%` : '—'}</b><span>主动被接住</span></div>
      </div>
      <div class="muted small">用量：入 ${t.tokensIn ?? 0} / 出 ${t.tokensOut ?? 0} tokens · 平均 ${t.avgRounds ?? 0} 轮工具调用 · 模型 ${JSON.stringify(t.models ?? {})}</div>
      ${toolRows}${searchRows}
      ${m.errors?.top?.length ? `<div class="muted small">错误 Top：${m.errors.top.map(([k, v]) => `${k}×${v}`).join('，')}</div>` : ''}
      <div class="muted small">存储：截图 ${d.storage?.screenshots?.mb}MB / 图片 ${d.storage?.uploads?.mb}MB · 记忆 ${d.memory?.observations} 条（淡出 ${d.memory?.forgetting?.faded}）· 图谱 ${d.graph?.nodes} 节点</div>`
    return
  }
  if (act === 'backup') {
    window.open('/api/backup', '_blank')
    return
  }
  if (act === 'wipe') {
    const scope = btn.dataset.scope
    const word = prompt(`这会清空${scope === 'all' ? '全部记忆和会话' : '全部记忆'}，不可撤销。输入 WIPE 确认：`)
    if (word !== 'WIPE') return
    const r = await api('memory/wipe', { method: 'POST', body: { confirm: 'WIPE', scope } })
    toast(`已清空：${r.before.observations} 条事实${scope === 'all' ? `、${r.wiped.conversations} 个会话` : ''}`)
    await boot({ keep: true })
    return renderSettingsPanel()
  }
  if (act === 'save-settings') return saveSettings()
  if (act === 'mcp-reload') {
    const r = await api('mcp/reload', { method: 'POST', body: {} })
    toast(`MCP：${r.servers.map((s) => `${s.name}=${s.state}`).join(' ') || '没有配置'}`)
    return renderSettingsPanel()
  }
  if (act === 'search-test') {
    toast('测试搜索链路…')
    const r = await api('search/test', { method: 'POST', body: { query: '今天 美元 人民币 汇率' } })
    toast(`${r.engine} · ${r.ms}ms · ${r.results.length} 条`)
    return
  }
  if (act === 'change-passwd') {
    const next = prompt('新口令（≥6 位，只能在 Mac 本机浏览器改）')
    if (!next) return
    await api('password', { method: 'POST', body: { next } })
    return toast('口令已更新')
  }
  if (act === 'logout') {
    await api('logout', { method: 'POST', body: {} })
    location.reload()
    return
  }
})

$('#convTitle').addEventListener('click', renameNow)
function renameNow() {
  const t = prompt('会话标题', $('#convTitle').textContent)
  if (t) {
    api(`conversations/${S.current}`, { method: 'PATCH', body: { title: t } }).then(async () => {
      $('#convTitle').textContent = t
      await refreshList()
    })
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = $('#input').value.trim()
  if ((!text && !S.att.length) || S.stream) return
  $('#input').value = ''
  localStorage.removeItem(`echo.draft.${S.current}`)
  autogrow()
  startStream({ userText: text })
})

$('#fileInput').addEventListener('change', async (e) => {
  await addFiles(e.target.files)
  e.target.value = ''
})
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^image\//.test(f.type ?? ''))
  if (files.length) {
    e.preventDefault()
    addFiles(files)
  }
})
const composerEl = $('.composer')
composerEl.addEventListener('dragover', (e) => {
  e.preventDefault()
  composerEl.classList.add('dragging')
})
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('dragging'))
composerEl.addEventListener('drop', async (e) => {
  e.preventDefault()
  composerEl.classList.remove('dragging')
  await addFiles(e.dataTransfer?.files)
})

$('#input').addEventListener('input', () => {
  autogrow()
  localStorage.setItem(`echo.draft.${S.current}`, $('#input').value)
})
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#composer').requestSubmit()
  }
})
$('#modelSelect').addEventListener('change', (e) => {
  prefs.model = e.target.value
  api(`conversations/${S.current}`, { method: 'PATCH', body: { model: e.target.value } })
  autogrow()
})
$('#searchSelect').addEventListener('change', (e) => {
  prefs.searchMode = e.target.value
  api(`conversations/${S.current}`, { method: 'PATCH', body: { searchMode: e.target.value } })
  autogrow()
})
$('#convFilter').addEventListener('input', (e) => {
  S.filter = e.target.value
  renderConvs()
})
$('#scrim').addEventListener('click', () => {
  closeDrawer()
  if (!matchMedia('(min-width: 860px)').matches) $('#app').dataset.sidebar = 'closed'
})
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat() }
  if (meta && e.key === '/') { e.preventDefault(); $('#app').dataset.sidebar = $('#app').dataset.sidebar === 'open' ? 'closed' : 'open' }
  if (e.key === 'Escape') { if (!$('#drawer').hidden) closeDrawer(); else if (S.stream) { api('chat/stop', { method: 'POST', body: { conversationId: S.current } }); S.stream.ctrl.abort() } }
  if (meta && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); document.querySelector('[data-action="dream-now"]')?.click() }
  if (meta && e.key.toLowerCase() === 'm') { e.preventDefault(); openPanel('memory') }
})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
addEventListener('resize', () => { if (matchMedia('(min-width: 860px)').matches) $('#app').dataset.sidebar = 'open' })

/* --------------------------------- start ----------------------------------- */
;(async () => {
  applyTheme()
  try {
    await boot()
  } catch (err) {
    showGate('first')
  }
})()
