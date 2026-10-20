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
  followOutput: true,
  attachmentDrafts: new Map(),
  uploading: 0,
  drawing: null,
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
    try { const error = await res.json(); msg = error.message ?? (typeof error.error === 'string' ? error.error : msg) } catch {}
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
    if (cm && code[Number(cm[1])]) {
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
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
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
    if (!para.length) para.push(lines[i++])
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
          (c) => `<li class="conv ${c.id === S.current ? 'active' : ''} ${c.isMain ? 'is-main' : ''}" tabindex="0" data-action="select-conv" data-id="${esc(c.id)}" title="${esc(c.preview || c.title)}">
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
      `<div class="msg-actions" style="align-self:flex-start"><button data-action="edit-user">编辑重发</button><button data-action="copy-msg">复制</button>${String(m.content ?? '').trim() ? '<button data-action="adopt-message">设为目标</button>' : ''}</div>`,
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
          ${m.proactive || m.companion ? `<button data-action="fb" data-signal="good" data-kind="${esc(m.kind ?? 'chat')}" data-id="${esc(m.id)}" title="明确反馈这条内容有帮助">有用</button>
          <button data-action="fb" data-signal="bad" data-kind="${esc(m.kind ?? 'chat')}" data-id="${esc(m.id)}" title="明确反馈这条内容没有帮助">没用</button>` : ''}
        </span>
      </div>
      ${m.reasoning ? `<details class="fold reasoning"><summary>思考过程 · ${m.reasoning.length} 字</summary><div class="fold-body">${esc(m.reasoning)}</div></details>` : ''}
      ${(m.tools ?? []).length ? renderSteps(m.tools) : ''}
      ${m.runId ? (m.tools?.length || m.aborted || m.runStatus && m.runStatus !== 'completed') ? runCardHtml(messageRun(m)) : `<button class="btn small run-link" data-action="view-run" data-id="${esc(m.runId)}">查看执行记录</button>` : ''}
      <div class="content"></div>
      ${m.preparationId || m.commitmentId ? `<button class="btn small result-link" data-action="view-preparation" data-preparation-id="${esc(m.preparationId ?? '')}" data-commitment-id="${esc(m.commitmentId ?? '')}">查看准备结果</button>` : ''}
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
      return `<div class="step ${t.ok === false ? 'bad' : ''}"><i class="st-dot"></i><span class="st-name">${esc(t.label ?? t.name)}</span><span class="st-arg">${esc(args)}</span><span class="st-ms">${esc(toolStatus(t))}${t.exitCode != null ? ` · 退出码 ${esc(t.exitCode)}` : ''}</span></div>`
    })
    .join('')
  const detail = tools
    .map((t) => `<div class="st-out">${esc(toolOutputText(t.result ?? t.error).slice(0, 6000))}</div>${artifactLinks(t.artifacts)}`)
    .join('<hr style="border:0;border-top:1px solid var(--border);margin:8px 0"/>')
  return `<details class="fold steps-fold"><summary>调用 ${tools.length} 次工具</summary><div class="fold-body"><div class="steps">${items}</div><div style="margin-top:8px">${detail}</div></div></details>`
}

const RUN_STATUS = { pending: '待执行', awaiting_approval: '等待确认', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断', limit_reached: '已达执行上限', denied: '已拒绝', timed_out: '已超时' }
function messageRun(message) {
  let status = message.runStatus
  if (!status) {
    if (message.aborted) status = 'cancelled'
    else if (message.finishReason === 'tool_limit') status = 'limit_reached'
    else if (message.toolsFinished) status = (message.tools ?? []).some((tool) => tool.ok === false) ? 'failed' : 'completed'
    else status = 'unknown'
  }
  return {
    id: message.runId, steps: message.tools ?? [], error: message.runError,
    status,
  }
}
function runFeedbackHtml(run) {
  const steps = run.steps ?? []
  const state = (step) => step.status ?? (step.ok === false ? 'failed' : step.ok === true || step.ms != null ? 'completed' : 'pending')
  const waiting = steps.find((step) => state(step) === 'awaiting_approval')
  const active = waiting ?? steps.find((step) => state(step) === 'running')
  const status = run.status === 'running' && waiting ? 'awaiting_approval' : run.status
  const labels = { running: '正在执行', awaiting_approval: '等待你的确认', completed: '本轮执行已完成', failed: '本轮执行有失败', cancelled: '本轮执行已停止', stop_requested: '已请求停止', interrupted: '执行状态待核实', limit_reached: '已达到执行上限' }
  const counts = [
    [steps.filter((step) => state(step) === 'completed').length, '完成'],
    [steps.filter((step) => ['failed', 'timed_out'].includes(state(step))).length, '失败'],
    [steps.filter((step) => state(step) === 'denied').length, '拒绝'],
    [steps.filter((step) => state(step) === 'cancelled').length, '停止'],
  ].filter(([count]) => count).map(([count, label]) => `${label} ${count} 步`)
  const notes = {
    completed: '结果已保留，可查看每一步的输入、输出与文件。',
    failed: '已完成的步骤与输出仍会保留。请先查看失败原因，再决定是否继续。',
    cancelled: '后续执行已停止；已完成的操作不会自动撤销。',
    stop_requested: '服务已收到停止请求，最终状态请查看执行记录；已完成的操作不会自动撤销。',
    interrupted: '连接已中断，最终状态尚未确认。查看执行记录后再继续。',
    limit_reached: '剩余步骤尚未执行。已生成的输出可在执行记录中查看。',
    unknown: '这是历史执行记录，最终状态请以执行详情为准。',
  }
  const current = ['running', 'awaiting_approval'].includes(status)
    ? active ? `${status === 'awaiting_approval' ? '待确认' : '当前步骤'}：${active.label || active.name || '工具调用'}` : run.phase || '正在准备下一步'
    : notes[status] ?? '查看执行记录了解详情。'
  return `<div class="run-feedback-heading"><span class="run-feedback-dot" aria-hidden="true"></span><strong>${esc(labels[status] ?? RUN_STATUS[status] ?? '执行记录')}</strong></div>
    <p class="run-feedback-count">${steps.length ? `已记录 ${steps.length} 步${counts.length ? ` · ${counts.join(' · ')}` : ''}` : '尚未调用工具'}</p>
    <p class="run-feedback-detail">${esc(current)}</p>
    ${run.error && status !== 'cancelled' ? `<p class="err">${esc(toolText(run.error))}</p>` : ''}`
}
function runCardHtml(run) {
  return `<section class="run-feedback" data-state="${esc(run.status ?? 'unknown')}" aria-label="任务执行状态">
    <div class="run-feedback-body" role="status" aria-live="polite" aria-atomic="true">${runFeedbackHtml(run)}</div>
    <button class="btn small run-link" data-action="view-run" data-id="${esc(run.id)}">查看步骤与结果</button></section>`
}
function updateRunFeedback(node, run) {
  let card = $('.run-feedback', node)
  if (!card) {
    $('.run-link', node)?.remove()
    $('.content', node).insertAdjacentHTML('beforebegin', runCardHtml(run))
    return
  }
  card.dataset.state = run.status ?? 'unknown'
  const body = $('.run-feedback-body', card), html = runFeedbackHtml(run)
  if (body.innerHTML !== html) body.innerHTML = html
}
function toolText(value) { return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
function toolOutputText(value) {
  let parsed = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch {} }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.stdout === 'string' || typeof parsed.stderr === 'string') {
      return [parsed.stdout ? `标准输出\n${parsed.stdout}` : '', parsed.stderr ? `错误输出\n${parsed.stderr}` : '', parsed.reason ? `结束原因：${parsed.reason}` : ''].filter(Boolean).join('\n\n') || '（没有输出）'
    }
    if (typeof parsed.content === 'string') return parsed.content
  }
  return toolText(parsed)
}
function toolStatus(tool) {
  if (tool.approval?.status === 'denied') return RUN_STATUS.denied
  if (tool.status) return RUN_STATUS[tool.status] ?? tool.status
  return tool.ok === false ? '失败' : tool.ms != null ? `${tool.ms}ms` : '…'
}
function artifactLinks(artifacts) {
  return (artifacts ?? []).filter((item) => /^\/api\/runs\/[^\\\s?#]+\/artifacts\/[^\\\s?#]+$/.test(item.url ?? ''))
    .map((item) => `<a class="run-artifact" href="${esc(item.url)}" download>${esc(item.name || '输出文件')}${Number.isFinite(item.bytes) ? ` · ${Math.ceil(item.bytes / 1024)} KB` : ''}</a>`).join('')
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

function renderThread({ resetScroll = true } = {}) {
  const thread = $('#thread')
  const scrollTop = thread.scrollTop
  if (resetScroll) S.followOutput = true
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
  updateRegenerateButtons()
  if (!S.followOutput) thread.scrollTop = scrollTop
  scrollBottom(false)
}

function updateRegenerateButtons() {
  const buttons = $$('#threadInner [data-action="regen"]')
  buttons.forEach((button, i) => { button.hidden = i !== buttons.length - 1 })
}

function heroNode() {
  const el = document.createElement('div')
  el.className = 'hero'
  const main = S.current === 'main'
  el.innerHTML = `<img src="/logo.svg" width="42" height="42" alt="" />
    <h3>${main ? '今天，想一起做点什么？' : '从一个想法开始'}</h3>
    <p>${
      main
        ? '随手记下想法，整理一件事，或继续上次的话题。Echo 的主动跟进也会留在这里。'
        : '问题还没想清楚也没关系。先写下来，再用「润色」一起理清。'
    }</p>
    <div class="suggestions">
      ${['帮我把今天的待办理清楚', '把这个想法变成下一步行动', '帮我起草一条消息', '一起梳理一个难题']
        .map((t) => `<button class="sug" data-action="sug">${esc(t)}</button>`)
        .join('')}
    </div><p class="suggestion-hint">选一个起点，编辑后再发送</p>`
  return el
}

function scrollBottom(force = false) {
  const t = $('#thread')
  if (force) S.followOutput = true
  if (S.followOutput) t.scrollTop = t.scrollHeight
  $('#jumpLatest').hidden = S.followOutput || t.scrollHeight <= t.clientHeight
}

function updateScrollState() {
  const t = $('#thread')
  S.followOutput = t.scrollHeight - t.scrollTop - t.clientHeight < 80
  $('#jumpLatest').hidden = S.followOutput
}

function saveDraft() {
  if (!S.current) return
  const text = $('#input').value
  if (text) localStorage.setItem(`echo.draft.${S.current}`, text)
  else localStorage.removeItem(`echo.draft.${S.current}`)
  S.attachmentDrafts.set(S.current, S.att.slice())
}

function updateComposer() {
  const cfg = S.boot?.config ?? {}
  const ready = cfg.upstreamConfigured === true
  const drawing = Boolean(S.drawing && S.drawing === S.current)
  const busy = Boolean(S.stream || S.selecting || S.preparing || S.uploading || drawing)
  const text = $('#input').value.trim()
  $('#sendBtn').disabled = !S.current || !ready || busy || (!text && !S.att.length)
  $('#polishBtn').disabled = !ready || busy || !text || POLISH.running
  $('[data-action="attach"]').hidden = cfg.media?.imageInput === false
  const draw = $('[data-action="draw"]')
  draw.hidden = cfg.media?.imageOutput === false || !cfg.defaultImageModel
  draw.disabled = !ready || busy || Boolean(S.drawing)
  draw.textContent = drawing ? '正在画…' : '画图'
  $('#connectionNotice').hidden = ready
  $('#connectionText').textContent = '连接你的模型后即可开始。你可以先写下草稿。'
  $('#composerHint').textContent = matchMedia('(pointer: coarse)').matches
    ? '回车换行 · 点「发送」开始'
    : 'Enter 发送 · Shift+Enter 换行'
  const draftState = S.uploading ? '正在处理图片…' : text || S.att.length
    ? `草稿已保留${S.att.length ? ' · 图片保留至关闭页面' : ''}` : ''
  if ($('#composerState').textContent !== draftState) $('#composerState').textContent = draftState
  const status = $('#replyStatus')
  status.hidden = !S.stream && !drawing && !S.selecting
  const replyState = S.selecting ? '正在打开对话…' : drawing ? '正在生成图片，完成后会保存在这个对话里…'
    : S.stream ? S.stream.status ?? 'Echo 正在准备回复…' : ''
  if (status.textContent !== replyState) status.textContent = replyState
  $('#thread').setAttribute('aria-busy', String(Boolean(S.stream || S.selecting)))
}

/* ------------------------------ attachments -------------------------------- */

S.att = []

function renderAttachments() {
  const strip = $('#attachStrip')
  strip.hidden = !S.att.length
  strip.innerHTML = S.att
    .map(
      (a, i) =>
        `<div class="thumb" title="${esc(a.name ?? '')}"><img src="${a.dataUrl}" alt="${esc(a.name || '待发送图片')}" /><button type="button" data-action="rm-att" data-i="${i}" aria-label="移除${esc(a.name || '图片')}" title="移除">×</button><span>${Math.round(a.bytes / 1024)}KB</span></div>`,
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
  if (media.imageInput === false || !S.current) return toast('当前未开启图片输入', true)
  const conversationId = S.current
  saveDraft()
  const max = media.maxImagesPerMessage ?? 4
  const maxEdge = media.maxEdge ?? 1536
  S.uploading++
  updateComposer()
  try {
    for (const file of [...(files ?? [])]) {
      if (!/^image\//.test(file.type ?? '')) continue
      try {
        const image = await shrinkImage(file, maxEdge)
        const attachments = S.current === conversationId ? S.att : S.attachmentDrafts.get(conversationId) ?? []
        if (attachments.length >= max) {
          toast(`一条消息最多 ${max} 张图`, true)
          break
        }
        attachments.push(image)
        S.attachmentDrafts.set(conversationId, attachments.slice())
      } catch (err) {
        toast(`图片处理失败：${err.message}`, true)
      }
    }
  } finally {
    S.uploading--
    renderAttachments()
    autogrow()
  }
}

/* --------------------------- 首次引导（BYOK 向导） -------------------------- */

const W = {
  open: false,
  step: 0,
  catalog: null,
  baseUrl: '',
  apiKey: '',
  models: [],
  defaultModel: '',
  utilityModel: '',
  imageModel: '',
  profile: 'standard',
  order: ['scrape', 'gateway'],
  providerCfg: {},
  keys: {},
  test: null,
  perms: null,
  password: '',
}

const STEPS = ['端点', '模型', '记忆', '搜索', '权限', '完成']

async function openWizard({ restart = false } = {}) {
  const [cat, cfgRes] = await Promise.all([api('providers'), api('settings').catch(() => null)])
  W.catalog = cat
  if (!W.open) W.returnFocus = document.activeElement
  W.open = true
  if (!restart) {
    // 从现状预填，避免让人重填一遍
    W.baseUrl = cat.onboarding.baseUrl || ''
    W.models = S.boot?.config?.models?.map((m) => m.id) ?? []
    W.defaultModel = S.boot?.config?.defaultModel ?? ''
    W.utilityModel = S.boot?.config?.utilityModel ?? ''
    W.imageModel = S.boot?.config?.defaultImageModel ?? ''
    W.profile = cat.onboarding.profile || 'standard'
    W.order = [...(cat.onboarding.searchOrder ?? ['scrape', 'gateway'])]
  }
  W.step = restart ? 0 : cat.onboarding.completed ? 0 : 0
  $('#wizard').hidden = false
  renderWizard()
  syncScrim()
  void cfgRes
}

function closeWizard() {
  W.open = false
  $('#wizard').hidden = true
  syncScrim()
  restoreFocus(W.returnFocus)
}

function renderWizard() {
  const el = $('#wizard')
  const step = W.step
  const card = document.createElement('div')
  card.className = 'wizard-card'
  card.innerHTML = `
    <div class="wizard-steps">${STEPS.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
    <h2>${esc(STEPS[step])}</h2>
    <p class="sub">${['第 1 步 · 你要用自己的模型 API（BYOK），密钥只存在本机 data/echo.env',
      '第 2 步 · 从端点拉到的模型里挑默认用哪个',
      '第 3 步 · 决定它记住你多少，以及要不要主动开口',
      '第 4 步 · 联网搜索可以完全不要，也可以接你自己的搜索服务',
      '第 5 步 · 权限与常驻状态检查',
      '就绪'][step]}</p>
    <div id="wBody"></div>
    <div class="wizard-foot">
      <span class="muted small">第 ${step + 1} / ${STEPS.length} 步</span>
      <div class="right">
        ${step > 0 ? '<button class="btn" data-w="back">上一步</button>' : ''}
        <button class="btn ghost" data-w="skip">${step === 0 ? '以后再配' : '先不配'}</button>
        <button class="btn primary" data-w="next">${step === STEPS.length - 1 ? '完成' : '继续'}</button>
      </div>
    </div>`
  el.innerHTML = ''
  el.append(card)
  const body = $('#wBody')
  if (step === 0) body.innerHTML = stepEndpoint()
  if (step === 1) body.innerHTML = stepModels()
  if (step === 2) body.innerHTML = stepProfile()
  if (step === 3) body.innerHTML = stepSearch()
  if (step === 4) body.innerHTML = stepPermissions()
  if (step === 5) body.innerHTML = stepDone()
  bindWizard()
  $('input, select, button', body)?.focus()
}

function stepEndpoint() {
  const presets = W.catalog.upstream.map((p) => `<option value="${esc(p.baseUrl)}" ${p.baseUrl === W.baseUrl ? 'selected' : ''}>${esc(p.label)}${p.baseUrl ? '' : '（手动填）'}</option>`).join('')
  return `
    <div class="field"><label>服务商预设</label><select id="wPreset">${presets}</select></div>
    <div class="field"><label>端点 Base URL（OpenAI 兼容，通常以 /v1 结尾）</label>
      <input type="text" id="wBase" placeholder="https://your-endpoint/v1" value="${esc(W.baseUrl)}" /></div>
    <div class="field"><label>API Key（只写入本机 data/echo.env，600 权限，不进仓库）</label>
      <input type="password" id="wKey" placeholder="sk-…" value="${esc(W.apiKey)}" /></div>
    <div class="row">
      <button class="btn small" data-w="test">测试连接并拉取模型</button>
      <span class="muted small" id="wTestOut">${W.test ? (W.test.ok ? `✓ 连通，发现 ${W.test.count} 个模型` : `✗ ${esc(W.test.error ?? '')}`) : ''}</span>
    </div>`
}

function stepModels() {
  const opts = W.models.length
    ? W.models.map((m) => `<option value="${esc(m)}" ${m === W.defaultModel ? 'selected' : ''}>${esc(m)}</option>`).join('')
    : ''
  return `
    <div class="field"><label>默认模型${W.models.length ? `（已发现 ${W.models.length} 个）` : '（没拉到列表就手填）'}</label>
      ${opts ? `<select id="wModel">${opts}</select>` : `<input type="text" id="wModel" placeholder="例如 gpt-4o-mini / qwen-plus" value="${esc(W.defaultModel)}" />`}</div>
    <div class="field"><label>后台杂活模型（标题、记忆抽取、Dream；默认同默认模型）</label>
      <input type="text" id="wUtility" placeholder="留空 = 用默认模型" value="${esc(W.utilityModel)}" /></div>
    <div class="field"><label>出图模型（可选；留空就关掉 image_gen 工具）</label>
      <input type="text" id="wImage" placeholder="例如 wan2.7-image / gpt-image-1" value="${esc(W.imageModel)}" /></div>
    <p class="muted small">这些都是普通配置项，之后在「设置」里随时能改；模型清单也可以用「重新拉取」更新。</p>`
}

function stepProfile() {
  return Object.entries(W.catalog.profiles)
    .map(([id, p]) => {
      const values = { off: '不抽取 / 不注入 / 不主动 / 不采集屏幕', light: '抽取并注入事实；不 Dream、不主动、不采集屏幕', standard: '抽取 + 注入 + 定期 Dream 与遗忘；主动服务开启', deep: '在标准之上打开屏幕感知（本地 OCR，需要屏幕录制授权）' }[id]
      return `<label class="opt-card ${W.profile === id ? 'sel' : ''}">
        <input type="radio" name="wProfile" value="${id}" ${W.profile === id ? 'checked' : ''} />
        <span><b>${esc(p.label)}</b><span>${esc(values ?? p.note)}</span></span></label>`
    })
    .join('')
}

function providerRows(order, providerCfg, keys) {
  const cat = (W.catalog?.search ?? []).filter((p) => p.id !== 'none')
  return cat
    .map((p) => {
      const idx = (order ?? []).indexOf(p.id)
      const conf = providerCfg?.[p.id] ?? {}
      let extra = ''
      if (p.id === 'searxng') extra = `<input type="text" data-pcfg="searxng" placeholder="https://your-searxng/（实例根地址）" value="${esc(conf.endpoint ?? '')}" style="margin-top:6px" />`
      if (p.id === 'custom') extra = `<input type="text" data-pcfg="custom" placeholder="https://your-search-api/endpoint" value="${esc(conf.endpoint ?? '')}" style="margin-top:6px" />`
      if (p.needsKey) extra = `<input type="password" data-pkey="${p.envVar}" placeholder="${esc(p.envVar)}（写入本机 echo.env）" value="${esc(keys?.[p.envVar] ?? '')}" style="margin-top:6px" />`
      return `<div class="chain-row">
        <input type="checkbox" data-order="${p.id}" ${idx >= 0 ? 'checked' : ''} />
        <span class="idx">${idx >= 0 ? idx + 1 : '·'}</span>
        <span style="flex:1">
          <b>${esc(p.label)}</b>
          <div class="why">${esc(p.note)}${p.ready ? '' : ` · 未就绪：${esc(p.reason)}`}</div>
          ${extra}
        </span>
      </div>`
    })
    .join('')
}

function wizardChainRows() {
  const c = S.boot?.config
  return providerRows(c?.search?.order ?? ['scrape', 'gateway'], c?.search?.providers ?? {}, {})
}

function stepSearch() {
  return `
    <p class="muted small" style="margin-top:0">勾选的按顺序依次尝试，前面的失败（如被限流）自动交给下一个。全部不勾即"不联网"。</p>
    <div class="chain">${providerRows(W.order, W.providerCfg, W.keys)}</div>`
}

function stepPermissions() {
  const p = W.perms
  if (!p) return '<p class="muted small">正在检查…</p>'
  const row = (ok, text) => `<div class="chain-row"><span class="idx">${ok ? '✓' : '!'}</span><span style="flex:1">${text}</span></div>`
  return `
    ${row(p.configured, p.configured ? '模型端点已配置' : '模型端点未配置（第 1 步可以回头补）')}
    ${row(p.runningUnderLaunchd, p.runningUnderLaunchd ? '已由 launchd 常驻（登录自启、崩溃自动拉起）' : '当前是手动启动的；要常驻请跑 ./install.sh')}
    ${row(p.tools.swiftc, p.tools.swiftc ? 'swiftc 可用（能编译状态栏图标）' : '缺少 swiftc：xcode-select --install')}
    ${row(true, `服务地址：${esc(p.bind)} :${p.port}${p.lanAddresses?.length ? ` · 局域网 ${esc(p.lanAddresses[0].split(' ')[0])}` : ''}`)}
    ${row(!p.authRequired, p.authRequired ? '已开启口令验证' : '未要求口令（本机自用；公共网络下建议开）')}
    <div class="field" style="margin-top:12px"><label>屏幕录制权限（只有开启屏幕感知才需要）</label>
      <div class="row"><button class="btn small" data-w="perm-test">测试一次</button>
      <span class="muted small" id="wPermOut">${W.permTest ? (W.permTest.granted ? '✓ 已授权，能抓到画面' : `✗ ${esc(W.permTest.hint)}`) : '未测试'}</span></div>
    </div>
    <div class="field"><label>设个访问口令（可选，<span class="muted">留空则免登录</span>）</label>
      <input type="password" id="wPass" placeholder="≥6 位；开启后手机访问需要输入" value="${esc(W.password)}" /></div>
    <p class="muted small">权限说明与命令见仓库 docs/permissions.md。</p>`
}

function stepDone() {
  const searchText = W.order.length ? W.order.map((id) => W.catalog.search.find((p) => p.id === id)?.label ?? id).join(' → ') : '不联网'
  return `
    <div class="chain">
      <div class="chain-row"><span class="idx">1</span><span style="flex:1">端点：<b>${esc(W.baseUrl || '（沿用环境变量）')}</b></span></div>
      <div class="chain-row"><span class="idx">2</span><span style="flex:1">默认模型：<b>${esc(W.defaultModel || '（未选）')}</b>${W.utilityModel ? ` · 杂活：${esc(W.utilityModel)}` : ''}${W.imageModel ? ` · 出图：${esc(W.imageModel)}` : ''}</span></div>
      <div class="chain-row"><span class="idx">3</span><span style="flex:1">记忆档位：<b>${esc(W.catalog.profiles[W.profile]?.label ?? W.profile)}</b></span></div>
      <div class="chain-row"><span class="idx">4</span><span style="flex:1">搜索链：<b>${esc(searchText)}</b></span></div>
    </div>
    <p class="muted small" style="margin-top:12px">点「完成」会：把密钥写进 data/echo.env、把以上选择写进 config.json，然后你就可以直接开始对话。</p>`
}

function bindWizard() {
  const el = $('#wizard')
  el.querySelectorAll('[data-w]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.w
      if (act === 'back') { W.step = Math.max(0, W.step - 1); return renderWizard() }
      if (act === 'skip') { localStorage.setItem('echo.onboardSkipped', '1'); closeWizard(); return toast('随时可以在「设置 → 引导与权限」里重新配置') }
      if (act === 'test') {
        W.baseUrl = $('#wBase').value.trim()
        W.apiKey = $('#wKey').value.trim()
        $('#wTestOut').textContent = '测试中…'
        const r = await api('onboarding/test', { method: 'POST', body: { baseUrl: W.baseUrl, apiKey: W.apiKey } })
        W.test = r
        if (r.ok) {
          W.models = r.models
          W.defaultModel = W.defaultModel || r.models[0] || ''
        }
        return renderWizard()
      }
      if (act === 'perm-test') {
        $('#wPermOut').textContent = '测试中（系统可能弹授权窗）…'
        W.permTest = await api('permissions/screen-test', { method: 'POST', body: {} })
        return renderWizard()
      }
      if (act === 'next') {
        // 收集当前步骤的输入
        if (W.step === 0) {
          W.baseUrl = ($('#wBase')?.value ?? W.baseUrl).trim()
          W.apiKey = ($('#wKey')?.value ?? W.apiKey).trim()
        } else if (W.step === 1) {
          W.defaultModel = ($('#wModel')?.value ?? '').trim()
          W.utilityModel = ($('#wUtility')?.value ?? '').trim()
          W.imageModel = ($('#wImage')?.value ?? '').trim()
        } else if (W.step === 4) {
          W.password = ($('#wPass')?.value ?? '').trim()
        }
        if (W.step === 3) {
          W.providerCfg = {}
          el.querySelectorAll('[data-pcfg]').forEach((i) => (W.providerCfg[i.dataset.pcfg] = { endpoint: i.value.trim() }))
          el.querySelectorAll('[data-pkey]').forEach((i) => (W.keys[i.dataset.pkey] = i.value.trim()))
        }
        if (W.step < STEPS.length - 1) {
          W.step++
          if (W.step === 4 && !W.perms) W.perms = await api('permissions').catch(() => null)
          return renderWizard()
        }
        // 完成
        btn.disabled = true
        const body = {
          baseUrl: W.baseUrl,
          apiKey: W.apiKey,
          models: W.models,
          defaultModel: W.defaultModel,
          utilityModel: W.utilityModel || W.defaultModel,
          imageModels: W.imageModel ? [{ id: W.imageModel, label: W.imageModel, group: '出图' }] : [],
          defaultImageModel: W.imageModel,
          profile: W.profile,
          search: { order: W.order, providers: W.providerCfg },
          keys: W.keys,
          password: W.password,
        }
        const r = await api('onboarding/complete', { method: 'POST', body })
        if (r.ok) {
          toast('配置已保存，开始对话吧')
          closeWizard()
          await boot({ keep: true })
        } else {
          btn.disabled = false
          toast('保存失败：' + (r.error ?? ''), true)
        }
      }
    }),
  )
  el.querySelector('#wPreset')?.addEventListener('change', (e) => {
    if (e.target.value) $('#wBase').value = e.target.value
  })
  el.querySelectorAll('input[name="wProfile"]').forEach((r) =>
    r.addEventListener('change', () => {
      W.profile = r.value
      renderWizard()
    }),
  )
  el.querySelectorAll('[data-order]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const id = cb.dataset.order
      const set = new Set(W.order)
      if (cb.checked) set.add(id)
      else set.delete(id)
      // 保持目录顺序，避免顺序跳来跳去
      W.order = W.catalog.search.map((p) => p.id).filter((x) => set.has(x))
      renderWizard()
    }),
  )
}

/* ------------------------------- 润色（CoT） ------------------------------- */

const POLISH = { mode: localStorage.getItem('echo.polishMode') ?? 'expand', modes: null, running: false, last: null }

async function runPolish({ mode } = {}) {
  const input = $('#input')
  const text = input.value.trim()
  if (!text) return toast('输入框是空的', true)
  if (POLISH.running) return
  if (mode) {
    POLISH.mode = mode
    localStorage.setItem('echo.polishMode', mode)
  }
  POLISH.running = true
  const btn = $('#polishBtn')
  const original = btn.textContent
  btn.textContent = '润色中…'
  btn.disabled = true
  const conversationId = S.current
  try {
    const r = await api('polish', { method: 'POST', body: { text, mode: POLISH.mode, conversationId } })
    if (S.current !== conversationId || input.value.trim() !== text || S.stream) return
    POLISH.last = r
    if (!r.ok && r.error) toast(r.error, true)
    renderPolishBox()
  } catch (err) {
    toast(`润色失败：${err.message}`, true)
  } finally {
    POLISH.running = false
    btn.textContent = original
    updateComposer()
  }
}

function renderPolishBox() {
  const box = $('#polishBox')
  const r = POLISH.last
  if (!r) {
    box.hidden = true
    return
  }
  const modes = POLISH.modes ?? {}
  const chips = Object.entries(modes)
    .map(([id, m]) => `<button type="button" data-pmode="${id}" aria-pressed="${id === POLISH.mode}" title="${esc(m.note ?? '')}">${esc(m.label ?? id)}</button>`)
    .join('')
  const list = (arr, label) => (arr?.length ? `<div><b>${label}</b><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '')
  box.hidden = false
  box.innerHTML = `
    <div class="head">
      <span>润色${r.changed ? '' : '（原话已经够清楚，基本没改）'}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}</span>
      <div class="pill-group">${chips}</div>
    </div>
    <textarea id="polishText">${esc(r.polished ?? '')}</textarea>
    <div class="why">
      ${r.intent ? `<div><b>它理解的意图：</b>${esc(r.intent)}</div>` : ''}
      ${list(r.gaps, '缺口：')}
      ${list(r.assumptions, '它替你假设的（可以不同意）：')}
      ${r.notes ? `<div><b>说明：</b>${esc(r.notes)}</div>` : ''}
    </div>
    <div class="acts">
      <span class="muted small">${esc((r.usage?.total_tokens ? `${r.usage.total_tokens} tokens · ` : '') + '这段不会自动替换你的输入')}</span>
      <div class="right">
        <button type="button" class="btn small" data-pact="cancel">取消</button>
        <button type="button" class="btn small" data-pact="retry">换个说法</button>
        <button type="button" class="btn small" data-pact="use">替换输入框</button>
        <button type="button" class="btn small primary" data-pact="send">直接发送</button>
      </div>
    </div>`
  box.querySelectorAll('[data-pmode]').forEach((b) =>
    b.addEventListener('click', () => runPolish({ mode: b.dataset.pmode })),
  )
  box.querySelectorAll('[data-pact]').forEach((b) =>
    b.addEventListener('click', async () => {
      const act = b.dataset.pact
      if (act === 'cancel') {
        POLISH.last = null
        return renderPolishBox()
      }
      if (act === 'retry') return runPolish()
      const text = $('#polishText').value.trim()
      if (!text) return toast('润色后的内容是空的', true)
      if (act === 'use') {
        $('#input').value = text
        autogrow()
        localStorage.setItem(`echo.draft.${S.current}`, text)
        POLISH.last = null
        renderPolishBox()
        return toast('已替换输入框内容')
      }
      if (act === 'send') {
        if (S.stream) return toast('正在生成中…', true)
        POLISH.last = null
        renderPolishBox()
        $('#input').value = text
        autogrow()
        return $('#composer').requestSubmit()
      }
    }),
  )
  if (r.modes) POLISH.modes = r.modes
}

/* -------------------------------- streaming -------------------------------- */

async function startStream({ userText, regenerate = false, editId }) {
  if (S.stream || S.selecting || S.preparing || S.uploading || S.drawing === S.current) return toast('请稍候…', true)
  if (!S.boot?.config?.upstreamConfigured) return toast('先连接模型，草稿会保留在这里', true)
  const conversationId = S.current
  if (editId) {
    S.preparing = true
    try {
      await api(`conversations/${conversationId}/truncate`, { method: 'POST', body: { messageId: editId } })
      const messages = $$('#threadInner .msg')
      const index = messages.findIndex((node) => node.dataset.id === editId)
      if (index >= 0) messages.slice(index).forEach((node) => node.remove())
    } finally {
      S.preparing = false
    }
  }
  const inner = $('#threadInner')
  $('.hero', inner)?.remove()
  const outgoing = regenerate || editId ? [] : S.att.slice()
  if (outgoing.length) {
    S.att = []
    renderAttachments()
  }
  if (!regenerate && !editId) saveDraft()
  let userNode
  if (userText != null || outgoing.length) {
    userNode = messageNode({ id: uid(), role: 'user', content: userText ?? '', images: outgoing.map((a) => ({ url: a.dataUrl })) })
    inner.append(userNode)
    scrollBottom(true)
  }
  if (regenerate) {
    const nodes = $$('.msg.assistant', inner)
    nodes.at(-1)?.remove()
  }

  const node = messageNode({ id: uid(), role: 'assistant', content: '', createdAt: new Date().toISOString(), model: $('#modelSelect').value })
  inner.append(node)
  updateRegenerateButtons()
  const contentEl = $('.content', node)
  const stepsHost = { tools: [] }
  const st = { conversationId, buffer: '', reasoning: '', ctrl: new AbortController(), node, contentEl, sources: [], notices: [], searchMode: $('#searchSelect').value }
  S.stream = st
  setBusy(true)
  contentEl.innerHTML = '<span class="cursor"></span>'
  scrollBottom(true)

  let rendered = ''
  let pending = false
  const paint = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      if (st.finished) return
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
      st.error = err.message
      toast(err.message, true)
    }
  } finally {
    await finishStream(st)
  }

  function handleEvent(name, d) {
    if (S.stream !== st) return
    switch (name) {
      case 'meta':
        node.dataset.id = d.messageId
        if (d.runId) st.runId = d.runId
        if (userNode && d.userMessageId) userNode.dataset.id = d.userMessageId
        if (d.memory?.length) {
          $('.meta', node).insertAdjacentHTML('beforeend', `<span title="注入了 ${d.memory.length} 条记忆">记忆×${d.memory.length}</span>`)
        }
        break
      case 'reasoning':
        st.phase = '正在思考下一步'
        st.status = 'Echo 正在思考…'
        updateComposer()
        st.reasoning += d.text
        openReasoning()
        break
      case 'delta':
        st.phase = '正在整理回复'
        if (st.status !== 'Echo 正在回复…') {
          st.status = 'Echo 正在回复…'
          updateComposer()
        }
        st.buffer += d.text
        paint()
        break
      case 'run_start':
        st.runId = d.runId
        if (!$('.run-link', node)) $('.meta', node).insertAdjacentHTML('afterend', `<button class="btn small run-link" data-action="view-run" data-id="${esc(d.runId)}">查看执行记录</button>`)
        break
      case 'tool_call':
        st.status = `正在${d.label ?? d.name}…`
        updateComposer()
        if (!stepsHost.tools.some((tool) => tool.id === d.id)) stepsHost.tools.push({ id: d.id, name: d.name, label: d.label, args: d.args, status: 'running' })
        else Object.assign(stepsHost.tools.find((tool) => tool.id === d.id), { name: d.name, label: d.label, args: d.args })
        renderStepsInto(stepsHost.tools)
        break
      case 'tool_start': {
        const tool = stepsHost.tools.find((item) => item.id === d.id)
        if (tool) tool.status = 'running'
        else stepsHost.tools.push({ id: d.id, name: d.name, status: 'running' })
        renderStepsInto(stepsHost.tools)
        break
      }
      case 'tool_approval': {
        st.status = '等待你确认这次操作，可批准、拒绝或停止'
        updateComposer()
        const tool = stepsHost.tools.find((item) => item.id === d.id)
        if (tool) tool.status = 'awaiting_approval'
        let approvals = $('.run-approvals', node)
        if (!approvals) {
          approvals = document.createElement('div')
          approvals.className = 'run-approvals'
          contentEl.before(approvals)
        }
        if (!$$('[data-approval-id]', approvals).some((card) => card.dataset.approvalId === d.approval.id)) {
          approvals.insertAdjacentHTML('beforeend', approvalHtml(d.runId, { ...tool, ...d, args: d.approval.args ?? tool?.args }))
        }
        renderStepsInto(stepsHost.tools)
        scrollBottom(false)
        break
      }
      case 'tool_output': {
        const tool = stepsHost.tools.find((item) => item.id === d.id)
        if (tool) {
          tool.output = `${tool.output ?? ''}${String(d.text ?? '')}`.slice(-12000)
          tool.status = 'running'
        }
        if (st.status !== '正在执行工具…') {
          st.status = '正在执行工具…'
          updateComposer()
        }
        renderStepsInto(stepsHost.tools)
        break
      }
      case 'tool_result': {
        st.phase = '正在整理结果，准备下一步'
        const t = stepsHost.tools.find((x) => x.id === d.id)
        if (t) {
          t.ok = d.ok
          t.ms = d.ms
          t.result = d.result ?? d.preview ?? d.error
          t.status = d.status ?? (d.ok === false ? 'failed' : 'completed')
          t.exitCode = d.exitCode
          t.artifacts = d.artifacts
          if (t.approval?.id) settleApproval(t.approval.id, t.status)
        }
        $$('[data-approval-id]', node).filter((card) => card.dataset.callId === d.id).forEach((card) => settleApproval(card.dataset.approvalId, t?.status ?? 'completed'))
        renderStepsInto(stepsHost.tools)
        break
      }
      case 'run_complete':
        st.runStatus = d.status
        if (d.status && d.status !== 'completed') st.notices.push(`执行${RUN_STATUS[d.status] ?? d.status}`)
        break
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
        st.runStatus = d.message?.runStatus ?? st.runStatus
        break
      case 'error':
        st.error = d.message
        st.failedMessage = d.assistant
        if (d.assistant?.runId) st.runId = d.assistant.runId
        st.runStatus = d.assistant?.runStatus ?? 'failed'
        break
    }
    if (st.runId && (stepsHost.tools.length || st.runStatus && st.runStatus !== 'completed')) updateRunFeedback(node, { id: st.runId, status: st.runStatus ?? 'running', steps: stepsHost.tools, phase: st.phase, error: st.error })
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
    fold.innerHTML = renderSteps(tools.map((tool) => ({ ...tool, result: tool.result ?? tool.output }))).replace(/^<details[^>]*>|<\/details>$/g, '')
    scrollBottom(false)
  }

  async function finishStream(st) {
    st.finished = true
    const d = st.done
    const message = d?.message ?? st.failedMessage
    const finalText = message?.content ?? st.buffer
    const confirmedCancelled = message?.runStatus === 'cancelled' || st.runStatus === 'cancelled' || d?.aborted === true
    if (!d && !st.error && !st.ctrl.signal.aborted) st.error = '连接中断，回复可能不完整，请重试'
    st.contentEl.innerHTML = md(finalText) + (st.error ? `<div class="err" role="alert">${esc(st.error)}</div>` : '')
    if (!finalText.trim() && !st.error) st.contentEl.innerHTML = `<p class="muted">${confirmedCancelled ? '已停止生成' : st.ctrl.signal.aborted ? '回复连接已断开，执行结果请查看记录' : '（没有内容）'}</p>`
    if (st.reasoning) {
      const el = $('details.reasoning', node)
      if (el) {
        el.open = false
        el.querySelector('summary').textContent = `思考过程 · ${st.reasoning.length} 字`
        $('.fold-body', el).textContent = st.reasoning
      }
    }
    const sources = d?.sources?.length ? d.sources : st.sources
    renderTail(node, { ...(message ?? {}), usage: d?.usage ?? message?.usage, sources, searchMode: st.searchMode, aborted: confirmedCancelled })
    if (st.runId && (stepsHost.tools.length || st.error || d?.aborted || st.ctrl.signal.aborted)) {
      // A closed connection is not proof that a tool stopped on the server.
      const status = message?.runStatus ?? st.runStatus ?? (d?.aborted ? 'cancelled' : d ? messageRun(message ?? {}).status : st.stopRequested ? 'stop_requested' : 'interrupted')
      updateRunFeedback(node, { id: st.runId, status, steps: message?.tools ?? stepsHost.tools, error: message?.runError ?? st.error })
    }
    S.stream = null
    $$('[data-approval-id]', node).forEach((card) => settleApproval(card.dataset.approvalId, confirmedCancelled ? 'cancelled' : 'interrupted'))
    setBusy(false)
    try { await refreshList() } catch (err) { toast(`会话列表更新失败：${err.message}`, true) }
    if (S.boot) {
      const c = S.convs.find((x) => x.id === S.current)
      if (c) $('#convTitle').textContent = c.title
    }
    scrollBottom(false)
  }
}

function setBusy(busy) {
  $('#stopBtn').hidden = !busy
  $('#sendBtn').disabled = busy
  $('#sendBtn').textContent = busy ? '生成中' : '发送'
  document.body.classList.toggle('busy', busy)
  updateComposer()
}

async function stopReply() {
  const stream = S.stream
  if (!stream || stream.stopping) return
  stream.stopping = true
  const previousStatus = stream.status
  stream.status = '正在请求停止…'
  updateComposer()
  try {
    const result = await api('chat/stop', { method: 'POST', body: { conversationId: stream.conversationId } })
    stream.stopRequested = result.stopped === true
    stream.ctrl.abort()
  } catch (err) {
    stream.stopping = false
    stream.status = previousStatus
    if (S.stream === stream) updateComposer()
    toast(`停止请求失败：${err.message}，可以重试`, true)
  }
}

/* --------------------------------- panels ---------------------------------- */

async function openPanel(name) {
  if ($('#drawer').hidden) S.returnFocus = document.activeElement
  S.panel = name
  if (!matchMedia('(min-width: 861px)').matches) $('#app').dataset.sidebar = 'closed'
  $('#drawer').hidden = false
  $('#scrim').hidden = false
  $$('.tab').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.panel === name))
    t.tabIndex = t.dataset.panel === name ? 0 : -1
  })
  ;['memory', 'proactive', 'workspace', 'settings'].forEach((p) => ($(`#panel${cap(p)}`).hidden = p !== name))
  syncScrim()
  $(`#tab-${name}`)?.focus()
  if (name === 'memory') await renderMemoryPanel()
  if (name === 'proactive') await renderProactivePanel()
  if (name === 'settings') await renderSettingsPanel()
  if (name === 'workspace') await renderWorkspacePanel()
}
const cap = (s) => s[0].toUpperCase() + s.slice(1)

/* ---------------------------- workspace harness --------------------------- */

const WORKSPACE = { config: null, local: false, selected: null, loading: false, conversationId: null }

function updateWorkspaceBadge() {
  const badge = $('#workspaceBadge')
  if (!badge) return
  const config = S.boot?.config?.harness ?? WORKSPACE.config ?? {}
  badge.textContent = config.enabled ? `工作区 · ${config.allowShell ? '命令' : config.allowWrites ? '读写' : '只读'}` : '工作区 · 未启用'
  badge.classList.toggle('on', Boolean(config.enabled))
  badge.title = config.enabled ? `${config.workspaceRoot || '工作区'} · 查看权限与执行记录` : '配置工作区与查看执行记录'
}

function approvalHtml(runId, step) {
  const approval = step.approval
  if (!approval || !['pending', 'awaiting_approval', undefined].includes(approval.status)) return ''
  return `<section class="tool-approval" data-approval-id="${esc(approval.id)}" data-call-id="${esc(step.id)}" aria-label="确认工具操作">
    <strong>需要确认 · ${esc(step.name ?? '工作区操作')}</strong>
    <p>${esc(approval.summary || '请核对本次操作的完整输入。')}</p>
    ${step.workspaceRoot ? `<p class="muted small">项目目录：${esc(step.workspaceRoot)}</p>` : ''}
    <pre class="run-code">${esc(toolText(approval.args ?? step.args))}</pre>
    <p class="muted small">批准仅限这一次操作。${step.name === 'shell_exec' ? 'Shell 命令使用运行 Echo 的账户权限，不受文件工具的目录边界保护。' : '工具将使用对应服务的已配置权限。'}</p>
    <div class="row"><button class="btn small primary" data-action="run-approval" data-run-id="${esc(runId)}" data-approval-id="${esc(approval.id)}" data-decision="approve">批准这一次</button>
    <button class="btn small" data-action="run-approval" data-run-id="${esc(runId)}" data-approval-id="${esc(approval.id)}" data-decision="deny">拒绝</button></div>
    <p class="approval-status small" role="status"></p></section>`
}

function settleApproval(id, status) {
  $$('[data-approval-id].tool-approval').filter((card) => card.dataset.approvalId === id && !card.dataset.settled).forEach((card) => {
    card.dataset.settled = 'true'
    $$('button', card).forEach((button) => { button.disabled = true })
    $('.approval-status', card).textContent = card.dataset.decision === 'deny' ? '已拒绝这次操作' : RUN_STATUS[status] ?? status
  })
}

async function decideApproval(button) {
  const { runId, approvalId, decision } = button.dataset
  const cards = $$('[data-approval-id].tool-approval').filter((card) => card.dataset.approvalId === approvalId)
  if (cards.some((card) => card.dataset.submitting || card.dataset.settled)) return
  cards.forEach((card) => {
    card.dataset.submitting = 'true'
    card.dataset.decision = decision
    $$('button', card).forEach((control) => { control.disabled = true })
    $('.approval-status', card).textContent = '正在提交…'
  })
  try {
    await api(`runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: { decision } })
    cards.forEach((card) => {
      card.dataset.decision = decision
      if (!card.dataset.settled) $('.approval-status', card).textContent = decision === 'approve' ? '已批准这一次，等待执行结果' : '已拒绝这次操作'
    })
    if (!$('#drawer').hidden && S.panel === 'workspace') await refreshRuns({ force: true })
  } catch (err) {
    cards.forEach((card) => {
      if (card.dataset.settled) return
      delete card.dataset.submitting
      delete card.dataset.decision
      $$('button', card).forEach((control) => { control.disabled = false })
      $('.approval-status', card).textContent = err.message
    })
  }
}

async function renderWorkspacePanel() {
  const panel = $('#panelWorkspace')
  const data = await api('harness')
  WORKSPACE.config = data.config
  WORKSPACE.local = data.local === true
  const config = data.config ?? {}
  if (S.boot?.config) S.boot.config.harness = config
  updateWorkspaceBadge()
  // Only opening the panel rebuilds its form; background polling updates the runs below.
  panel.innerHTML = `<section class="sect"><h3>工作区执行</h3>
    <p class="muted small">让 Echo 读取项目、编辑文件、执行命令，并保存每一步的输入、输出和结果。启用后，在对话中直接描述任务。</p>
    ${!WORKSPACE.local ? '<p class="notice">在本机打开 Echo 后可设置权限、批准操作和查看执行记录。</p>' : ''}
    <form id="workspaceForm"><fieldset class="workspace-fields" ${!WORKSPACE.local ? 'disabled' : ''}>
      <label class="switch" for="workspaceEnabled">启用工作区工具<input id="workspaceEnabled" name="enabled" type="checkbox" ${config.enabled ? 'checked' : ''} /></label>
      <div class="field"><label for="workspaceRoot">项目目录（绝对路径）</label><input id="workspaceRoot" name="workspaceRoot" type="text" placeholder="/Users/you/projects/my-project" value="${esc(config.workspaceRoot)}" autocomplete="off" spellcheck="false" /></div>
      <label class="switch" for="workspaceWrites">允许编辑工作区文件<input id="workspaceWrites" name="allowWrites" type="checkbox" ${config.allowWrites ? 'checked' : ''} /></label>
      <label class="switch" for="workspaceShell">允许申请 Shell 命令<input id="workspaceShell" name="allowShell" type="checkbox" ${config.allowShell ? 'checked' : ''} /></label>
      <p class="muted small">文件工具限制在选定目录内；启用编辑后，Echo 可直接修改其中的文件。Shell 和 MCP 操作每次都展示完整输入，等你批准后执行。Shell 是受信任的本机命令，不是操作系统沙箱，可能访问目录外的文件或网络。</p>
      <div class="workspace-limits"><div class="field"><label for="workspaceRounds">最多工具轮次</label><input id="workspaceRounds" name="maxToolRounds" type="number" min="1" max="24" value="${esc(config.maxToolRounds ?? 12)}" required /></div>
      <div class="field"><label for="workspaceTimeout">命令超时（秒）</label><input id="workspaceTimeout" name="timeout" type="number" min="1" max="120" value="${esc((config.shellTimeoutMs ?? 60000) / 1000)}" required /></div></div>
      <button class="btn small primary" type="submit">保存工作区权限</button>
    </fieldset><p id="workspaceStatus" class="small" role="status"></p></form></section>
    <section class="sect"><div class="row"><h3>本对话的执行记录</h3><button class="btn small right" data-action="refresh-runs" ${!WORKSPACE.local ? 'disabled' : ''}>刷新</button></div>
      <p class="muted small">查看记录不会再次运行工具。输出文件可下载；中断的执行保留已完成的步骤。</p>
      <div id="runList" class="list"></div><p id="runListStatus" class="small" role="status"></p>
    </section><section id="runInspector" class="run-inspector" tabindex="-1" aria-label="执行详情"></section>`
  if (!WORKSPACE.local) {
    $('#runList').innerHTML = '<p class="muted small">执行记录和输出文件仅在运行 Echo 的本机提供。</p>'
    return
  }
  await refreshRuns({ force: true })
}

async function saveWorkspaceForm(form) {
  if (!WORKSPACE.local || !form.reportValidity() || form.dataset.saving) return
  const values = new FormData(form)
  const config = {
    enabled: values.get('enabled') === 'on',
    workspaceRoot: String(values.get('workspaceRoot') ?? '').trim(),
    allowWrites: values.get('allowWrites') === 'on',
    allowShell: values.get('allowShell') === 'on',
    maxToolRounds: Number(values.get('maxToolRounds')),
    shellTimeoutMs: Number(values.get('timeout')) * 1000,
  }
  const status = $('#workspaceStatus')
  if (config.enabled && !config.workspaceRoot) { status.textContent = '请先填写项目目录。'; $('#workspaceRoot').focus(); return }
  form.dataset.saving = 'true'
  const submit = $('button[type="submit"]', form)
  submit.disabled = true
  status.textContent = '正在保存…'
  try {
    const result = await api('harness', { method: 'PATCH', body: { config } })
    WORKSPACE.config = result.config ?? config
    if (S.boot?.config) S.boot.config.harness = WORKSPACE.config
    updateWorkspaceBadge()
    status.textContent = '已保存。下一条对话将使用这些权限。'
  } catch (err) {
    status.textContent = err.message
  } finally {
    delete form.dataset.saving
    submit.disabled = false
  }
}

function runStepHtml(runId, step, workspaceRoot) {
  const output = step.approval?.status === 'denied' ? '已拒绝本次操作，未执行。' : toolOutputText(step.result === '' ? step.output : step.result ?? step.output)
  return `<details class="run-step" data-step-id="${esc(step.id)}" ${step.status === 'awaiting_approval' ? 'open' : ''}><summary>${esc(step.name || '工具')} <span class="muted small">${esc(toolStatus(step))}${step.ms != null ? ` · ${esc(step.ms)} ms` : ''}${step.exitCode != null ? ` · 退出码 ${esc(step.exitCode)}` : ''}</span></summary>
    <h4>完整输入</h4><pre class="run-code">${esc(toolText(step.args))}</pre>
    ${approvalHtml(runId, { ...step, workspaceRoot })}
    ${output ? `<h4>输出${output.length > 12000 ? '（显示末尾 12,000 字符）' : ''}</h4><pre class="run-code">${esc(output.slice(-12000))}</pre>` : ''}
    ${step.truncated ? '<p class="muted small">输出达到记录上限，记录可能不完整。</p>' : ''}
    ${artifactLinks(step.artifacts)}
    ${(step.changes ?? []).length ? `<p class="small">已修改：${step.changes.map((change) => esc(change.path)).join('、')}。上方可下载修改前后的快照。</p>` : ''}
    ${step.error ? `<p class="err">${esc(toolText(step.error))}</p>` : ''}</details>`
}

async function refreshRuns({ force = false } = {}) {
  if (!WORKSPACE.local || !$('#runList') || WORKSPACE.loading) return
  const conversationId = S.current
  WORKSPACE.loading = true
  try {
    const data = await api(`runs?conversationId=${encodeURIComponent(conversationId)}`)
    if (S.current !== conversationId || S.panel !== 'workspace') return
    const list = $('#runList')
    const runs = data.runs ?? []
    const key = JSON.stringify(runs)
    if (WORKSPACE.conversationId !== conversationId) { WORKSPACE.selected = null; WORKSPACE.conversationId = conversationId }
    if (force || list.dataset.key !== key) {
      const focusedId = document.activeElement?.closest('[data-action="view-run"]')?.dataset.id
      list.innerHTML = runs.map((run) => `<button class="run-row" data-action="view-run" data-id="${esc(run.id)}" aria-pressed="${WORKSPACE.selected === run.id}"><span>${esc(fmtTime(run.startedAt))} · ${esc(RUN_STATUS[run.status] ?? run.status)}</span><span class="muted small">${Array.isArray(run.steps) ? run.steps.length : run.stepCount ?? 0} 步${run.workspaceRoot ? ` · ${esc(run.workspaceRoot)}` : ''}</span></button>`).join('') || '<p class="muted small">还没有执行记录。启用工作区后，让 Echo 先检查项目文件。</p>'
      list.dataset.key = key
      if (focusedId) $$('[data-action="view-run"]', list).find((button) => button.dataset.id === focusedId)?.focus()
    }
    $('#runListStatus').textContent = ''
    if (WORKSPACE.selected) await inspectRun(WORKSPACE.selected, { poll: !force })
  } catch (err) {
    $('#runListStatus').textContent = `记录加载失败：${err.message}`
  } finally {
    WORKSPACE.loading = false
  }
}

async function inspectRun(id, { poll = false } = {}) {
  if (!WORKSPACE.local) return
  WORKSPACE.selected = id
  const data = await api(`runs/${encodeURIComponent(id)}`)
  if (WORKSPACE.selected !== id || S.panel !== 'workspace') return
  const run = data.run ?? data
  const inspector = $('#runInspector')
  if (!inspector) return
  const key = JSON.stringify(run)
  if (poll && inspector.dataset.key === key) return
  const selection = document.getSelection?.()
  const hasSelection = selection && !selection.isCollapsed
  const selectingOutput = hasSelection && (inspector.contains(selection.anchorNode) || inspector.contains(selection.focusNode))
  if (poll && (selectingOutput || document.activeElement !== inspector && inspector.contains(document.activeElement))) {
    // Keep selected output and focused controls mounted while still reporting progress.
    const feedback = $('.run-feedback-body', inspector)
    const html = runFeedbackHtml(run)
    const selectingFeedback = feedback && hasSelection && (feedback.contains(selection.anchorNode) || feedback.contains(selection.focusNode))
    if (feedback && !selectingFeedback && feedback.innerHTML !== html) feedback.innerHTML = html
    const card = $('.run-feedback', inspector)
    if (card) card.dataset.state = run.status
    return
  }
  const openSteps = new Set($$('details[open]', inspector).map((details) => details.dataset.stepId))
  inspector.innerHTML = `<h3>执行详情</h3>
    <div class="run-feedback" data-state="${esc(run.status)}"><div class="run-feedback-body" role="status" aria-live="polite" aria-atomic="true">${runFeedbackHtml(run)}</div></div>
    <p class="muted small">${esc(run.workspaceRoot ?? '')}<br />${esc(fmtTime(run.startedAt))}${run.finishedAt ? ` → ${esc(fmtTime(run.finishedAt))}` : ''}</p>
    ${(run.steps ?? []).map((step) => runStepHtml(id, step, run.workspaceRoot)).join('') || '<p class="muted small">尚未调用工具。</p>'}
    ${artifactLinks(run.artifacts)}`
  inspector.dataset.key = key
  $$('details', inspector).forEach((details) => { if (openSteps.has(details.dataset.stepId)) details.open = true })
  $$('[data-action="view-run"]', $('#runList')).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.id === id)))
  if (!poll) inspector.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'workspaceForm') return
  event.preventDefault()
  saveWorkspaceForm(event.target).catch((err) => toast(err.message, true))
})

function closeDrawer() {
  $('#drawer').hidden = true
  syncScrim()
  restoreFocus(S.returnFocus)
}
function syncScrim() {
  const mobile = !matchMedia('(min-width: 861px)').matches
  const drawer = !$('#drawer').hidden
  if (mobile && drawer) $('#app').dataset.sidebar = 'closed'
  const sidebar = $('#app').dataset.sidebar === 'open'
  $('#scrim').hidden = !drawer && (!mobile || !sidebar)
  $('#app').inert = W.open
  $('main.main').inert = drawer || (mobile && sidebar)
  $('#sidebar').inert = drawer || !sidebar
  $$('[data-action="toggle-sidebar"]').forEach((button) => button.setAttribute('aria-expanded', String(sidebar)))
}
function restoreFocus(previous) {
  if (previous?.isConnected && !previous.closest('[inert]') && previous.getClientRects().length) previous.focus()
  else $('#input').focus()
}
function toggleSidebar() {
  const app = $('#app')
  app.dataset.sidebar = app.dataset.sidebar === 'open' ? 'closed' : 'open'
  syncScrim()
  if (!matchMedia('(min-width: 861px)').matches) {
    if (app.dataset.sidebar === 'open') $('#convFilter').focus()
    else $('.topbar [data-action="toggle-sidebar"]').focus()
  }
}

async function renderMemoryPanel() {
  const [mem, dream, forgetting, screen] = await Promise.all([api('memory'), api('dream'), api('memory/forgetting'), api('screen')])
  const panel = $('#panelMemory')
  if (!$('#memoryContents', panel)) panel.innerHTML = `<details id="relationshipSection" class="fold relationship-section"><summary>相处方式 <span class="muted small">· 按你的习惯回应</span></summary><div id="relationshipBody" class="fold-body"><p class="muted small" role="status">展开后加载。</p></div></details><div id="memoryContents" class="memory-contents"></div>`
  const el = $('#memoryContents', panel)
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
                  <button class="btn small right" data-action="adopt-loop" data-id="${esc(l.id)}">接下这件事</button>
                  <button class="btn small ghost" data-action="loop-done" data-id="${esc(l.id)}">不再跟进</button></div>
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
  updateRelationshipAvailability()
}

/* Preferences and people are deliberately manual, and never refreshed by polling. */
const RELATIONSHIPS = { data: null, loading: false, version: 0 }

async function loadRelationships() {
  const body = $('#relationshipBody')
  if (!body || body.dataset.loaded || RELATIONSHIPS.loading) return
  const version = RELATIONSHIPS.version
  RELATIONSHIPS.loading = true
  body.innerHTML = '<p class="muted small" role="status">正在加载…</p>'
  try {
    const data = await api('relationships')
    if (version !== RELATIONSHIPS.version || body !== $('#relationshipBody')) return
    RELATIONSHIPS.data = data
    body.innerHTML = relationshipProfileHtml(data.profile ?? {})
    body.dataset.loaded = 'true'
    renderRelationshipPeople()
  } catch (err) {
    if (version !== RELATIONSHIPS.version || body !== $('#relationshipBody')) return
    body.innerHTML = `<p class="small" role="status">${esc(err.message)}</p><button class="btn small" data-action="relationship-retry">重新加载</button>`
  } finally {
    if (version === RELATIONSHIPS.version) RELATIONSHIPS.loading = false
  }
}

function relationshipProfileHtml(profile) {
  return `<p class="muted small">让回应更合你的习惯，默认保持克制。这里的人物背景只由你添加，提到相关人物时才参考；不会保存情绪画像，也不会因此增加主动消息。相关内容可能发送给你配置的模型。</p>
    <p id="relationshipAvailability" class="muted small" ${S.boot?.config?.memory?.enabled === false || S.boot?.config?.memory?.inject === false ? '' : 'hidden'}>当前记忆注入已关闭，保存的相处方式与人物背景暂不用于回应。</p>
    <form id="relationshipProfileForm">
      <label class="switch" for="relationshipEnabled">在对话中使用这些设置<input id="relationshipEnabled" name="enabled" type="checkbox" ${profile.enabled !== false ? 'checked' : ''} /></label>
      <div class="relationship-options">
        <div class="field"><label for="relationshipTone">回应语气</label><select id="relationshipTone" name="tone">${[['subtle', '自然克制'], ['warm', '稍微温暖'], ['direct', '简洁直接']].map(([value, label]) => `<option value="${value}" ${(profile.tone ?? 'subtle') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="field"><label for="relationshipSupport">遇到难处时</label><select id="relationshipSupport" name="support">${[['balanced', '顺着当下需要'], ['listen', '先听我说'], ['practical', '先帮我解决']].map(([value, label]) => `<option value="${value}" ${(profile.support ?? 'balanced') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      </div>
      <details class="relationship-more"><summary>称呼与边界（可选）</summary>
        <div class="field"><label for="relationshipName">希望怎么称呼你</label><input id="relationshipName" name="preferredName" type="text" maxlength="80" value="${esc(profile.preferredName)}" autocomplete="off" /></div>
        <div class="field"><label for="relationshipBoundaries">希望它注意什么</label><textarea id="relationshipBoundaries" name="boundaries" maxlength="600" placeholder="例如：工作讨论直接一点，不要反复问我感觉如何。">${esc(profile.boundaries)}</textarea></div>
      </details>
      <p class="muted small">停用只暂停使用这些设置，不会删除已保存的内容。</p>
      <button class="btn small primary" type="submit">保存相处方式</button><p class="relationship-status small" role="status"></p>
    </form>
    <div class="relationship-people"><div class="row"><h4>人物背景 <span id="relationshipPeopleCount" class="muted"></span></h4><button class="btn small right" data-action="relationship-new">添加人物</button></div>
      <p class="muted small">只记需要的背景，随时修改或删除。最多 12 人。</p><div id="relationshipPeople" class="list"></div><div id="relationshipEditor"></div></div>`
}

function updateRelationshipAvailability() {
  const notice = $('#relationshipAvailability')
  if (notice) notice.hidden = S.boot?.config?.memory?.enabled !== false && S.boot?.config?.memory?.inject !== false
}

function relationshipPersonHtml(person) {
  return `<div class="mem-item relationship-person" data-person-id="${esc(person.id)}"><div class="txt"><b>${esc(person.name)}</b>${person.relationship ? `<span class="muted small"> · ${esc(person.relationship)}</span>` : ''}
    ${person.aliases?.length ? `<p class="muted small">也称：${person.aliases.map(esc).join('、')}</p>` : ''}
    ${person.context || person.boundaries ? `<details class="relationship-more"><summary>查看背景</summary>${person.context ? `<p class="relationship-text small">${esc(person.context)}</p>` : ''}${person.boundaries ? `<p class="relationship-text muted small">注意：${esc(person.boundaries)}</p>` : ''}</details>` : ''}
    <div class="row"><button class="btn small ghost" data-action="relationship-edit" data-id="${esc(person.id)}">编辑</button><button class="btn small ghost" data-action="relationship-delete" data-id="${esc(person.id)}">删除</button></div>
    <div class="relationship-delete-confirm" hidden><p class="small">删除后不再附加这份背景；已经出现在会话中的内容会保留。</p><div class="row"><button class="btn small" data-action="relationship-delete-confirm" data-id="${esc(person.id)}">确认删除</button><button class="btn small ghost" data-action="relationship-delete-cancel">保留</button></div></div>
    <p class="relationship-status small" role="status"></p></div></div>`
}

function renderRelationshipPeople() {
  const people = RELATIONSHIPS.data?.people ?? []
  $('#relationshipPeople').innerHTML = people.map(relationshipPersonHtml).join('') || '<p class="muted small">还没有人物背景。需要时再添加。</p>'
  $('#relationshipPeopleCount').textContent = `· ${people.length}/12`
  syncRelationshipEditorButtons()
}

function syncRelationshipEditorButtons() {
  const editing = Boolean($('#relationshipPersonForm'))
  $$('button', $('#relationshipPeople')).forEach((button) => { button.disabled = editing })
  $('[data-action="relationship-new"]').disabled = editing || (RELATIONSHIPS.data?.people?.length ?? 0) >= 12
}

function showRelationshipEditor(id) {
  if ($('#relationshipPersonForm')) return
  const person = id ? RELATIONSHIPS.data?.people?.find((item) => item.id === id) : {}
  if (!person || !id && (RELATIONSHIPS.data?.people?.length ?? 0) >= 12) return
  $('#relationshipEditor').innerHTML = `<form id="relationshipPersonForm" class="relationship-editor" data-id="${esc(id ?? '')}">
    <h4>${id ? '编辑人物背景' : '添加人物'}</h4>
    <div class="field"><label for="relationshipPersonName">名字或常用称呼</label><input id="relationshipPersonName" name="name" type="text" minlength="2" maxlength="80" required value="${esc(person.name)}" autocomplete="off" /></div>
    <div class="field"><label for="relationshipPersonRole">与你的关系（可选）</label><input id="relationshipPersonRole" name="relationship" type="text" maxlength="120" value="${esc(person.relationship)}" placeholder="例如：同事、朋友、导师" /></div>
    <div class="field"><label for="relationshipPersonContext">对话需要的背景（可选）</label><textarea id="relationshipPersonContext" name="context" maxlength="1200" placeholder="例如：我们在一起做项目，最近正在协调分工。">${esc(person.context)}</textarea></div>
    <details class="relationship-more" ${person.aliases?.length || person.boundaries ? 'open' : ''}><summary>其他称呼与边界（可选）</summary>
      <div class="field"><label for="relationshipPersonAliases">其他称呼（用逗号分隔，最多 5 个）</label><input id="relationshipPersonAliases" name="aliases" type="text" maxlength="404" value="${esc((person.aliases ?? []).join(', '))}" /></div>
      <div class="field"><label for="relationshipPersonBoundaries">谈到这个人时需要注意</label><textarea id="relationshipPersonBoundaries" name="boundaries" maxlength="600" placeholder="例如：讨论具体沟通方式，不猜测对方的动机。">${esc(person.boundaries)}</textarea></div>
    </details>
    <div class="row"><button class="btn small primary" type="submit">${id ? '保存修改' : '添加人物背景'}</button><button class="btn small" type="button" data-action="relationship-editor-cancel">取消</button></div><p class="relationship-status small" role="status"></p></form>`
  syncRelationshipEditorButtons()
  $('#relationshipPersonName').focus()
}

function closeRelationshipEditor(id) {
  $('#relationshipEditor').innerHTML = ''
  syncRelationshipEditorButtons()
  ;($$('[data-action="relationship-edit"]').find((button) => button.dataset.id === id) ?? $('[data-action="relationship-new"]'))?.focus()
}

async function saveRelationshipForm(form) {
  if (form.dataset.saving || !form.reportValidity()) return
  const values = new FormData(form), person = form.id === 'relationshipPersonForm'
  const status = $('.relationship-status', form)
  const body = person ? {
    name: String(values.get('name') ?? '').trim(),
    aliases: String(values.get('aliases') ?? '').split(/[,，\n]/).map((alias) => alias.trim()).filter(Boolean),
    relationship: String(values.get('relationship') ?? '').trim(),
    context: String(values.get('context') ?? '').trim(),
    boundaries: String(values.get('boundaries') ?? '').trim(),
  } : {
    enabled: values.get('enabled') === 'on', tone: values.get('tone'), support: values.get('support'),
    preferredName: String(values.get('preferredName') ?? '').trim(), boundaries: String(values.get('boundaries') ?? '').trim(),
  }
  if (person && (body.aliases.length > 5 || body.aliases.some((alias) => alias.length < 2 || alias.length > 80))) { status.textContent = '其他称呼最多 5 个，每个 2–80 个字符。'; return }
  const id = form.dataset.id, version = RELATIONSHIPS.version
  const focused = form.contains(document.activeElement) ? document.activeElement : null
  form.dataset.saving = 'true'
  $$('input, textarea, select, button', form).forEach((control) => { control.disabled = true })
  status.textContent = '正在保存…'
  try {
    const result = await api(person ? `relationships/people${id ? `/${encodeURIComponent(id)}` : ''}` : 'relationships/profile', { method: person && !id ? 'POST' : 'PATCH', body })
    if (version !== RELATIONSHIPS.version) return
    if (person) {
      RELATIONSHIPS.data.people = id ? RELATIONSHIPS.data.people.map((item) => item.id === id ? result.person : item) : [...RELATIONSHIPS.data.people, result.person]
      renderRelationshipPeople()
      closeRelationshipEditor(result.person.id)
    } else {
      RELATIONSHIPS.data.profile = result.profile ?? body
      status.textContent = body.enabled ? '已保存。' : '已停用。已保存的内容仍可在这里修改或删除。'
    }
  } catch (err) {
    status.textContent = err.message
  } finally {
    delete form.dataset.saving
    $$('input, textarea, select, button', form).forEach((control) => { control.disabled = false })
    if (focused?.isConnected && document.activeElement === document.body) focused.focus()
  }
}

async function deleteRelationshipPerson(button) {
  const card = button.closest('[data-person-id]')
  if (!card || card.dataset.deleting) return
  const version = RELATIONSHIPS.version
  card.dataset.deleting = 'true'
  $$('button', card).forEach((control) => { control.disabled = true })
  const status = $('.relationship-status', card)
  status.textContent = '正在删除…'
  try {
    await api(`relationships/people/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' })
    if (version !== RELATIONSHIPS.version) return
    RELATIONSHIPS.data.people = RELATIONSHIPS.data.people.filter((item) => item.id !== button.dataset.id)
    renderRelationshipPeople()
    $('[data-action="relationship-new"]')?.focus()
  } catch (err) {
    status.textContent = err.message
    delete card.dataset.deleting
    $$('button', card).forEach((control) => { control.disabled = false })
  }
}

document.addEventListener('toggle', (event) => {
  if (event.target.id === 'relationshipSection' && event.target.open) loadRelationships()
}, true)
document.addEventListener('submit', (event) => {
  if (!['relationshipProfileForm', 'relationshipPersonForm'].includes(event.target.id)) return
  event.preventDefault()
  saveRelationshipForm(event.target).catch((err) => toast(err.message, true))
})

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

const COMMITMENTS = { items: [], preparations: [], loops: [], editor: null, loading: false, version: 0, proactiveEnabled: null, research: null, researchRevision: 0 }
const GOAL_STATUS = { active: '进行中', paused: '已暂停', done: '已完成', cancelled: '已取消' }
const PREPARATION_STATUS = { idle: '尚未准备', queued: '等待准备', running: '正在准备', ready: '已有准备结果', failed: '准备失败' }
const OUTCOME_LABEL = { accepted: '已采用', completed: '帮助完成', wrong_time: '时机不合适', irrelevant: '不相关', incorrect: '内容有误', good: '有用', bad: '没用' }

function agencyTime(value) {
  const date = new Date(value)
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录'
}

function researchSettingsHtml(research = {}) {
  return `<form id="researchSettingsForm" class="research-settings">
    <label class="goal-checkbox"><input type="checkbox" name="enabled" ${research.enabled ? 'checked' : ''} /> 允许 Echo 在后台做只读研究</label>
    <p class="muted small">只分析启用之后的新对话，发现值得跟进的事情。自动发现的事项先限时跟进 7 天；由你选择是否继续。</p>
    <details class="research-options"><summary>读取范围与发现方式</summary>
      <label class="goal-checkbox"><input type="checkbox" name="discoverChats" ${research.discoverChats !== false ? 'checked' : ''} /> 从新对话发现需要跟进的事项</label>
      <p class="muted small">对话和你为目标指定的资料可能发送给已配置的模型；搜索词会发送给搜索服务。文件只读取你明确附加或指定的文件夹，不会扫描整个 Mac。研究不会发送消息或修改外部内容。</p>
      <p class="muted small">后台研究与主动提醒独立。关闭研究会停止后续研究，已保存的目标和结果仍保留。</p>
    </details>
    <div class="row"><button class="btn small" type="submit">保存研究设置</button><span class="research-form-status small" role="status"></span></div>
  </form>`
}

function renderResearchStatus(research = {}) {
  COMMITMENTS.research = research
  const holder = $('#researchSettings')
  const form = $('#researchSettingsForm')
  if (holder && (!form || !form.dataset.dirty && !form.dataset.saving && !form.contains(document.activeElement))) {
    const signature = JSON.stringify([research.enabled, research.discoverChats])
    if (holder.dataset.signature !== signature) {
      const expanded = $('.research-options', holder)?.open
      holder.innerHTML = researchSettingsHtml(research)
      if (expanded) $('.research-options', holder).open = true
      holder.dataset.signature = signature
    }
  }
  const status = $('#researchStatus')
  const statusHtml = `<p class="muted small">${research.enabled ? '后台研究已开启' : '后台研究已关闭'}${research.lastScanAt ? ` · 上次发现检查 ${esc(agencyTime(research.lastScanAt))}` : ''}</p>
    ${research.enabled && research.state === 'unconfigured' ? '<p class="small needs-check">尚未配置可用模型，研究暂不运行。请在设置中连接模型。</p>' : ''}
    ${research.enabled && research.state === 'budget_wait' ? `<p class="muted small">过去 24 小时的发现检查已达上限（${esc(research.budget?.used ?? 20)}/${esc(research.budget?.limit ?? 20)} 次）${research.budget?.resetsAt ? `，最早恢复 ${esc(agencyTime(research.budget.resetsAt))}` : ''}。</p>` : ''}
    ${research.lastError ? `<p class="small needs-check">最近发现检查失败：${esc(research.lastError)}${research.enabled && research.state === 'retry_wait' && research.nextRetryAt ? ` · 计划重试 ${esc(agencyTime(research.nextRetryAt))}` : ''}</p>` : ''}
    <p class="muted small">仅在这台 Mac 唤醒、Echo 运行且联网时检查；恢复后补查。休眠或离线期间无法保证及时发现变化。</p>`
  if (status && status.innerHTML !== statusHtml) status.innerHTML = statusHtml
}

async function saveResearchSettings(form) {
  if (form.dataset.saving) return
  const values = new FormData(form)
  const research = { enabled: values.get('enabled') === 'on', discoverChats: values.get('discoverChats') === 'on' }
  const controls = $$('input, button', form)
  const status = $('.research-form-status', form)
  form.dataset.saving = 'true'
  controls.forEach((control) => { control.disabled = true })
  try {
    await api('settings', { method: 'PATCH', body: { config: { proactive: { research } } } })
    if (S.boot?.config) {
      S.boot.config.proactive ??= {}
      S.boot.config.proactive.research = research
    }
    COMMITMENTS.research = { ...COMMITMENTS.research, ...research }
    COMMITMENTS.researchRevision++
    $('#researchSettings').dataset.signature = JSON.stringify([research.enabled, research.discoverChats])
    delete form.dataset.dirty
    status.textContent = research.enabled ? '已开启；从现在的新对话开始' : '已关闭后台研究'
    renderResearchStatus(COMMITMENTS.research)
    syncCommitmentCards()
  } catch (err) {
    status.textContent = `保存失败：${err.message}。设置草稿仍保留。`
  } finally {
    delete form.dataset.saving
    controls.forEach((control) => { control.disabled = false })
  }
}

function deadlineLabel(date, time, timezone) {
  return `${esc(date)}${time && timezone ? ` ${esc(time)} ${esc(timezone)}` : /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? '（时间未指定）' : ''}`
}

function deadlineAssessmentHtml(assessment, evidence = []) {
  if (!assessment || assessment.status === 'none') return ''
  const label = { verified: '来源已核对', conflicting: '来源有冲突 · 待核实', unverified: '待核实' }[assessment.status] || '待核实'
  return `<div class="deadline-assessment ${assessment.status === 'verified' ? '' : 'needs-check'}"><b>截止信息：${label}${assessment.date ? ` · ${deadlineLabel(assessment.date, assessment.time, assessment.timezone)}` : ''}</b>
    ${(assessment.claims ?? []).map((claim) => {
      const item = evidence.find((entry) => entry.id === claim.evidenceId)
      const url = typeof item?.source === 'string' ? item.source : item?.source?.url
      const link = /^https?:\/\//i.test(url ?? '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看原文</a>` : ''
      return `<div class="deadline-claim"><span class="small">${claim.status === 'verified' ? '已核对来源与事项' : '待核实'}${claim.date ? ` · ${deadlineLabel(claim.date, claim.time, claim.timezone)}` : ''}${claim.evidenceId ? ` · [${esc(claim.evidenceId)}]` : ''} ${link}</span>
        ${claim.quote ? `<blockquote>${esc(claim.quote)}</blockquote>` : ''}<p class="muted small">${[claim.institution, claim.program, claim.cycle, claim.category, claim.stage].filter(Boolean).map(esc).join(' · ')}</p>
        ${claim.reasons?.length ? `<p class="small">${claim.reasons.map(esc).join('；')}</p>` : ''}</div>`
    }).join('')}${assessment.checkedAt ? `<p class="muted small">核对时间：${esc(agencyTime(assessment.checkedAt))}</p>` : ''}</div>`
}

function evidenceHtml(item) {
  const source = item.source
  const url = typeof source === 'string' ? source : source?.url
  const isGoal = typeof source === 'string' && source.startsWith('commitment:')
  const message = typeof source === 'string' ? source.match(/^conversation:([^/]+)\/(.+)$/) : null
  const isMemory = typeof source === 'string' && source.startsWith('memory:')
  const label = isGoal ? item.discovered ? '从对话发现的目标记录' : '已确认目标' : message ? '原始消息' : isMemory ? '记忆记录（请核对当前是否成立）' : item.label || (/^https?:\/\//i.test(url ?? '') ? host(url) : '来源')
  const link = /^https?:\/\//i.test(url ?? '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label)
  let excerpt = item.excerpt ? `<p>${esc(item.excerpt)}</p>` : ''
  if (isGoal && item.excerpt) {
    try {
      const fields = JSON.parse(item.excerpt)
      const labels = { title: '目标', successCriteria: '完成标准', nextAction: '下一步', blocker: '待解决', deadline: '截止日期' }
      const rows = Object.entries(labels).filter(([key]) => typeof fields?.[key] === 'string' && fields[key].trim())
      if (rows.length) excerpt = `<dl class="goal-facts">${rows.map(([key, name]) => `<dt>${name}</dt><dd>${esc(fields[key])}</dd>`).join('')}</dl>`
    } catch {}
  }
  return `<li>${link}<div class="muted small"><time datetime="${esc(item.observedAt ?? '')}">${esc(agencyTime(item.observedAt))}</time>${item.id ? ` · [${esc(item.id)}]` : ''}</div>${excerpt}${message ? `<button class="btn small ghost" data-action="view-source-message" data-conversation-id="${esc(message[1])}" data-message-id="${esc(message[2])}">查看原消息</button>` : ''}</li>`
}

function preparationExpired(preparation) {
  return preparation.delivery?.status === 'expired' || preparation.delivery?.status === 'pending' && Date.parse(preparation.delivery.expiresAt) <= Date.now()
}

function preparationHtml(preparation) {
  const rawOutcome = typeof preparation.outcome === 'string' ? preparation.outcome : preparation.outcome?.signal
  const outcome = OUTCOME_LABEL[rawOutcome] ? rawOutcome : null
  const wrongTime = preparation.outcome?.timing === 'wrong_time'
  const verified = preparation.verification?.passed === true
  const checks = preparation.verification?.checks ?? []
  const checkText = Array.isArray(checks) ? checks.map((check) => typeof check === 'string' ? check : check.label || check.name || check.message || '').filter(Boolean).join('；') : ''
  const goalStopped = ['paused', 'done', 'cancelled'].includes(preparation.goalStatus)
  const expired = preparationExpired(preparation)
  const waiting = !goalStopped && !expired && preparation.delivery?.status === 'pending' && preparation.proactiveEnabled !== false
  const deliveryText = preparation.goalStatus === 'done' ? '目标已完成，不再准备或提醒；结果保留供回顾。'
    : preparation.goalStatus === 'cancelled' ? '目标已取消，不再准备或提醒；结果仍保留。'
    : preparation.goalStatus === 'paused' ? '目标已暂停，当前不会准备或提醒；结果仍可查看。'
    : expired ? '提醒已过期，不会再推送；结果可在此查看。'
    : preparation.delivery?.status === 'reviewed' ? '你已评阅这份结果，不再另行提醒。'
    : preparation.delivery?.status === 'superseded' ? '已不再安排提醒，使用前请核对最新目标与来源。'
    : preparation.delivery?.status === 'pending' && preparation.proactiveEnabled === false ? '主动提醒已关闭；结果可在此查看。'
    : waiting ? '已准备好，等待合适时机提醒你。' : '结果保留在这里，可随时查看。'
  return `<details class="preparation" data-preparation-id="${esc(preparation.id)}" data-detail-key="${esc(preparation.id)}" ${preparation.latest ? 'open' : ''}>
    <summary>${esc(preparation.title || '准备结果')}<span class="muted small">${esc(agencyTime(preparation.createdAt))}</span></summary>
    <div class="preparation-body">
      ${preparation.outdated && !['done', 'cancelled'].includes(preparation.goalStatus) ? '<p class="small needs-check">这份结果生成后，目标状态或内容已变化；继续使用前请核对。</p>' : ''}
      <div class="content">${md(preparation.content ?? '')}</div>
      ${deadlineAssessmentHtml(preparation.deadlineAssessment, preparation.evidence)}
      ${preparation.error ? `<p class="small needs-check">这次研究未完成：${esc(preparation.error)}${preparation.failedAt ? ` · ${esc(agencyTime(preparation.failedAt))}` : ''}${preparation.retryAt && !goalStopped && !preparation.researchStopped ? ` · 计划重试 ${esc(agencyTime(preparation.retryAt))}` : ''}</p>` : ''}
      ${preparation.assumptions?.length ? `<div class="preparation-assumptions"><b>仍需确认的假设</b><ul>${preparation.assumptions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
      ${preparation.question ? `<p class="preparation-question"><b>待你确认：</b>${esc(preparation.question)}</p>` : ''}
      <p class="verification ${verified ? '' : 'needs-check'}">${verified ? '生成时的来源引用已检查；这不等于事实已经证实。' : '来源引用尚未通过检查，请先核对。'}${checkText ? `<br><span class="small">${esc(checkText)}</span>` : ''}</p>
      <details class="evidence" data-detail-key="evidence-${esc(preparation.id)}"><summary>查看依据 · ${(preparation.evidence ?? []).length} 条</summary>
        <ol>${(preparation.evidence ?? []).map((item) => evidenceHtml({ ...item, discovered: preparation.goalOrigin === 'discovered' })).join('') || '<li>没有可展示的来源。</li>'}</ol>
      </details>
      <p class="muted small">${deliveryText}${waiting && preparation.delivery.expiresAt ? ` 提醒有效至 ${esc(agencyTime(preparation.delivery.expiresAt))}。` : ''}</p>
      <div class="outcome-actions" aria-label="这份结果是否有帮助">${['accepted', 'completed', 'wrong_time', 'irrelevant', 'incorrect'].map((signal) => `<button class="btn small ${signal === outcome || signal === 'wrong_time' && wrongTime ? 'selected' : 'ghost'}" data-action="preparation-feedback" data-signal="${signal}" data-id="${esc(preparation.commitmentId)}" data-preparation-id="${esc(preparation.id)}" aria-pressed="${signal === outcome || signal === 'wrong_time' && wrongTime}">${OUTCOME_LABEL[signal]}</button>`).join('')}</div>
      <p class="muted small">${outcome ? `已反馈：${esc(OUTCOME_LABEL[outcome])}` : '效果未知 · 沉默不会被当作没用。'}${wrongTime ? ' 已反馈时机不合适。' : ''}</p>
    </div>
  </details>`
}

function commitmentHtml(goal, preparations) {
  const finished = goal.status === 'done' || goal.status === 'cancelled'
  const stopped = finished || goal.status === 'paused'
  const researchStopped = goal.scope?.research && COMMITMENTS.research?.enabled === false
  const discovered = goal.origin === 'discovered'
  const discoverySource = goal.discovery?.source ?? goal.source
  const unadopted = discovered && !goal.discovery?.adopted
  const situation = Object.entries({ institution: '机构', program: '项目', cycle: '届次', category: '类别', stage: '阶段' }).filter(([key]) => goal.situation?.[key])
  const progress = goal.status === 'done' ? '目标已完成，不再准备'
    : goal.status === 'cancelled' ? '目标已取消，不再准备'
    : goal.status === 'paused' ? '已暂停准备和提醒' : PREPARATION_STATUS[goal.preparation?.state] || '尚未准备'
  return `<div class="goal-heading"><h4>${esc(goal.title)}</h4><span class="goal-status">${esc(GOAL_STATUS[goal.status] || goal.status)}</span></div>
    ${discovered ? `<div class="goal-discovery"><p class="small">${unadopted ? '从对话发现 · 事项待你核实' : '从对话发现 · 你已选择继续跟进'}${unadopted && goal.discovery?.expiresAt && !stopped ? ` · 临时跟进至 ${esc(agencyTime(goal.discovery.expiresAt))}` : ''}</p>
      ${goal.discovery?.quote ? `<blockquote class="goal-source">${esc(goal.discovery.quote)}</blockquote>` : ''}
      ${discoverySource?.conversationId && discoverySource?.messageId ? `<button class="btn small ghost" data-action="view-source-message" data-conversation-id="${esc(discoverySource.conversationId)}" data-message-id="${esc(discoverySource.messageId)}">查看发现依据的原消息</button>` : ''}</div>` : ''}
    <dl class="goal-facts"><dt>完成标准</dt><dd>${esc(goal.successCriteria || '尚未填写')}</dd><dt>下一步</dt><dd>${esc(goal.nextAction || '尚未填写')}</dd>${goal.blocker ? `<dt>待解决</dt><dd>${esc(goal.blocker)}</dd>` : ''}${goal.deadline ? `<dt>目标截止</dt><dd>${esc(goal.deadline)}${/^\d{4}-\d{2}-\d{2}$/.test(goal.deadline) ? '（时间未指定）' : ''}</dd>` : ''}</dl>
    ${situation.length ? `<details class="goal-context" data-detail-key="situation-${esc(goal.id)}"><summary>事项背景${unadopted ? ' · 待核实' : ''}</summary><dl class="goal-facts">${situation.map(([key, label]) => `<dt>${label}</dt><dd>${esc(goal.situation[key])}</dd>`).join('')}</dl></details>` : ''}
    ${goal.situation?.questions?.length ? `<p class="preparation-question"><b>还需要确认：</b>${goal.situation.questions.map(esc).join('；')}</p>` : ''}
    ${!preparations.some((item) => item.deadlineAssessment) ? deadlineAssessmentHtml(goal.deadlineAssessment) : ''}
    <p class="goal-progress small" role="status">${esc(progress)}${!stopped && goal.preparation?.error ? ` · ${esc(goal.preparation.error)}` : ''}</p>
    ${goal.watch?.lastError ? `<p class="small needs-check">来源检查失败：${esc(goal.watch.lastError)}</p>` : ''}
    <p class="muted small">读取范围：${goal.scope?.memory ? '本地记忆' : '未授权记忆'}${goal.scope?.urls?.length ? ` · ${goal.scope.urls.length} 个指定网页` : ' · 未指定网页'}${goal.scope?.research ? ' · 网页研究' : ''}${goal.scope?.documents?.length ? ` · ${goal.scope.documents.length} 份附加资料` : ''}${goal.scope?.folders?.length ? ` · ${goal.scope.folders.length} 个工作区文件夹` : ''} · ${stopped ? '当前不自动跟进' : goal.watch?.type === 'combined' ? '按来源变化与截止进展跟进' : goal.watch?.type === 'deadline' ? '临近截止时准备' : goal.watch?.type === 'source_change' ? '来源变化时准备' : '手动准备'}</p>
    ${goal.scope?.research && COMMITMENTS.research?.enabled === false ? '<p class="muted small">后台研究已关闭，这个目标的研究暂不运行。</p>' : ''}
    ${goal.watch?.lastCheckAt || goal.watch?.nextCheckAt || goal.preparation?.retryAt ? `<p class="muted small">${goal.watch?.lastCheckAt ? `上次核对 ${esc(agencyTime(goal.watch.lastCheckAt))}` : '尚未核对'}${!stopped && !researchStopped && goal.watch?.nextCheckAt ? ` · 下次计划 ${esc(agencyTime(goal.watch.nextCheckAt))}` : ''}${!stopped && !researchStopped && goal.preparation?.retryAt ? ` · 失败重试 ${esc(agencyTime(goal.preparation.retryAt))}` : ''}</p>` : ''}
    ${goal.completionEvidence ? `<p class="small">完成依据：${esc(typeof goal.completionEvidence === 'string' ? goal.completionEvidence : JSON.stringify(goal.completionEvidence))}</p>` : ''}
    <div class="goal-actions">
      ${unadopted && !finished ? `<button class="btn small primary" data-action="goal-adopt" data-id="${esc(goal.id)}">继续帮我跟进</button>` : ''}
      ${!finished ? `<button class="btn small primary" data-action="goal-prepare" data-id="${esc(goal.id)}" ${goal.status !== 'active' || researchStopped || ['queued', 'running'].includes(goal.preparation?.state) ? 'disabled' : ''}${researchStopped ? ' title="请先在上方开启后台研究"' : ''}>准备下一步</button>
      <button class="btn small" data-action="goal-edit" data-id="${esc(goal.id)}">编辑</button>
      <button class="btn small ghost" data-action="goal-status" data-status="${goal.status === 'paused' ? 'active' : 'paused'}" data-id="${esc(goal.id)}">${goal.status === 'paused' ? '恢复' : '暂停'}</button>
      <button class="btn small ghost" data-action="goal-complete" data-id="${esc(goal.id)}">完成目标</button>
      <button class="btn small ghost" data-action="goal-status" data-status="cancelled" data-id="${esc(goal.id)}">${discovered ? '停止这项研究' : '取消目标'}</button>` : `<button class="btn small ghost" data-action="goal-status" data-status="active" data-id="${esc(goal.id)}">重新开启</button>`}
    </div>
    ${preparations.length ? `<div class="goal-results">${preparations.map((item, index) => preparationHtml({ ...item, latest: index === 0, goalOrigin: goal.origin, goalStatus: goal.status, researchStopped, proactiveEnabled: COMMITMENTS.proactiveEnabled, outdated: item.revision != null && goal.revision != null && item.revision !== goal.revision })).join('')}</div>` : ''}`
}

function syncCommitmentCards({ force = false } = {}) {
  const list = $('#commitmentList')
  if (!list) return
  const ids = new Set(COMMITMENTS.items.map((goal) => goal.id))
  for (const card of $$('[data-goal-id]', list)) if (!ids.has(card.dataset.goalId) && !card.contains(document.activeElement)) card.remove()
  $('#commitmentEmpty').hidden = COMMITMENTS.items.length > 0
  for (const goal of COMMITMENTS.items) {
    const preparations = COMMITMENTS.preparations.filter((item) => item.commitmentId === goal.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    let card = $$('[data-goal-id]', list).find((node) => node.dataset.goalId === goal.id)
    const signature = JSON.stringify([goal, preparations, COMMITMENTS.proactiveEnabled, COMMITMENTS.research?.enabled, preparations.map(preparationExpired)])
    if (card?.dataset.signature === signature) continue
    const focused = card?.contains(document.activeElement) ? document.activeElement : null
    if (focused && !force) continue
    const previousDetails = new Set(card ? $$('details[data-detail-key]', card).map((node) => node.dataset.detailKey) : [])
    const opened = new Set(card ? $$('details[open][data-detail-key]', card).map((node) => node.dataset.detailKey) : [])
    const focusAction = focused?.dataset.action
    const focusSignal = focused?.dataset.signal
    const focusPreparation = focused?.dataset.preparationId
    if (!card) {
      card = document.createElement('article')
      card.className = 'commitment-card'
      card.dataset.goalId = goal.id
      card.tabIndex = -1
      list.append(card)
    }
    card.innerHTML = commitmentHtml(goal, preparations)
    card.dataset.signature = signature
    for (const detail of $$('details[data-detail-key]', card)) if (previousDetails.has(detail.dataset.detailKey)) detail.open = opened.has(detail.dataset.detailKey)
    if (focused) ($$('[data-action]', card).find((node) => node.dataset.action === focusAction && node.dataset.signal === focusSignal && node.dataset.preparationId === focusPreparation && !node.disabled) ?? card).focus()
  }
}

function restoreGoalActionFocus(button) {
  if ($('#drawer').hidden || S.panel !== 'proactive') return
  const active = document.activeElement
  // Disabling the initiating button can move focus to the page before the fetch returns.
  if (active && active !== document.body && active !== document.documentElement && active !== button && active.isConnected) return
  const card = $$('[data-goal-id]', $('#commitmentList')).find((node) => node.dataset.goalId === button.dataset.id)
  if (!card) return
  const controls = $$('button[data-action]', card).filter((node) => !node.disabled)
  const match = controls.find((node) => node.dataset.action === button.dataset.action && node.dataset.signal === button.dataset.signal && node.dataset.preparationId === button.dataset.preparationId)
  ;(match ?? controls[0] ?? card).focus()
}

async function renderProactivePanel({ poll = false, force = false } = {}) {
  const el = $('#panelProactive')
  if (!$('#commitmentList', el)) {
    el.innerHTML = `<section class="sect"><h3 class="agency-title">让 Echo 先做一点功课</h3><div id="researchSettings"></div><div id="researchStatus"></div></section>
      <section class="sect"><div class="row"><h3 class="agency-title">持续推进的目标</h3><button class="btn small primary right" data-action="goal-new">新增目标</button></div>
      <p class="muted small">Echo 准备下一步，保留依据。自动发现的事项会标明出处与待核实信息，你可以随时停止。</p>
      <p class="muted small">准备上限：24 小时内每个目标 2 次，全部目标 5 次。只读取目标授权的范围。</p>
      <div id="commitmentEditor"></div><p id="commitmentLoadStatus" class="muted small" role="status"></p>
      <p id="commitmentEmpty" class="muted small">还没有已确认目标。可以从一条自己的消息或下面的候选事项开始。</p>
      <div id="commitmentList" class="list"></div></section>
      <section class="sect"><h4>待你确认的事项</h4><p class="muted small">Dream 根据上下文推测的事项，尚未成为承诺。</p><div id="commitmentCandidates" class="list"></div></section>
      <details class="agency-settings"><summary>打扰时机与反馈学习</summary><div id="proactiveOverview"></div></details>`
  }
  if (COMMITMENTS.loading) {
    await COMMITMENTS.pending.catch(() => {})
    if (force) return renderProactivePanel({ poll, force })
    return
  }
  COMMITMENTS.loading = true
  const version = COMMITMENTS.version
  const researchRevision = COMMITMENTS.researchRevision
  try {
    COMMITMENTS.pending = Promise.all([api('proactive'), api('dream'), api('agency'), api('commitments'), api('research')])
    const [p, dream, agency, data, research] = await COMMITMENTS.pending
    if (version !== COMMITMENTS.version || !$('#commitmentList', el)) return
    COMMITMENTS.items = data.commitments ?? []
    COMMITMENTS.preparations = data.preparations ?? []
    COMMITMENTS.loops = dream.loops ?? []
    COMMITMENTS.proactiveEnabled = p.enabled
    if (researchRevision === COMMITMENTS.researchRevision) renderResearchStatus(research)
    syncCommitmentCards({ force })
    const candidates = $('#commitmentCandidates')
    if (!candidates.contains(document.activeElement)) {
      const loops = COMMITMENTS.loops.filter((loop) => loop.status !== 'done' && !COMMITMENTS.items.some((goal) => goal.candidateLoopId === loop.id))
      candidates.innerHTML = loops.map((loop) => `<div class="mem-item"><div class="txt"><b>${esc(loop.topic)}</b><p class="muted small">${esc(loop.why ?? '')}${loop.due ? ` · 截止 ${esc(loop.due)}` : ''}</p><button class="btn small" data-action="adopt-loop" data-id="${esc(loop.id)}">接下这件事</button></div></div>`).join('') || '<p class="muted small">暂无待确认事项。</p>'
    }
    const overview = $('#proactiveOverview')
    const signature = JSON.stringify([p, dream.nudges, agency])
    if (!overview.contains(document.activeElement) && overview.dataset.signature !== signature) {
      renderProactiveOverview(p, dream, agency)
      overview.dataset.signature = signature
    }
    $('#commitmentLoadStatus').textContent = ''
  } catch (err) {
    const status = $('#commitmentLoadStatus')
    if (status) status.textContent = `目标刷新失败：${err.message}。现有草稿仍保留。`
    if (!poll) throw err
  } finally {
    COMMITMENTS.loading = false
  }
}

function showCommitmentEditor(goal = {}, { mode = 'edit', source, candidateLoopId, preparationId, quote } = {}) {
  const el = $('#commitmentEditor')
  if ($('#commitmentForm')) {
    toast('请先保存或取消当前目标草稿')
    $('input, textarea', el)?.focus()
    return
  }
  COMMITMENTS.editor = { id: goal.id, revision: goal.revision, source: source ?? goal.source, candidateLoopId: candidateLoopId ?? goal.candidateLoopId, preparationId, mode, documents: [...(goal.scope?.documents ?? [])] }
  if (mode === 'complete') {
    el.innerHTML = `<form id="commitmentForm" class="commitment-editor"><h4>完成「${esc(goal.title)}」</h4>
      <div class="field"><label for="goalCompletion">依据什么确认已经完成？</label><textarea id="goalCompletion" name="completionEvidence" rows="2" maxlength="2000" required placeholder="例如：最终稿已交付，或已核对的结果链接"></textarea></div>
      <div class="row"><button class="btn small primary" type="submit">记录完成</button><button class="btn small" type="button" data-action="goal-editor-cancel">返回</button></div><p class="form-status small" role="status"></p></form>`
  } else {
    el.innerHTML = `<form id="commitmentForm" class="commitment-editor"><h4>${goal.id ? '编辑目标' : '确认一个目标'}</h4>
      ${quote ? `<blockquote class="goal-source">${esc(quote)}</blockquote>` : ''}
      <div class="field"><label for="goalTitle">目标</label><input id="goalTitle" name="title" type="text" maxlength="160" required value="${esc(goal.title ?? '')}" placeholder="例如：周五交付项目周报" /></div>
      <div class="field"><label for="goalCriteria">怎样算完成</label><textarea id="goalCriteria" name="successCriteria" rows="2" maxlength="2000" required placeholder="写清可以核对的结果">${esc(goal.successCriteria ?? '')}</textarea></div>
      <div class="field"><label for="goalNext">先准备哪一步</label><input id="goalNext" name="nextAction" type="text" maxlength="1000" required value="${esc(goal.nextAction ?? '')}" placeholder="例如：整理本周进展与待解决问题" /></div>
      <div class="field"><label for="goalDeadline">截止日期（可不填）</label><input id="goalDeadline" name="deadline" type="date" value="${esc(goal.deadline ?? '')}" /></div>
      <fieldset class="goal-scope"><legend>允许读取的范围</legend>
        <label class="goal-checkbox"><input name="memory" type="checkbox" ${goal.scope?.memory ? 'checked' : ''} /> 使用本地记忆中与目标相关的内容</label>
        <label class="goal-checkbox"><input name="research" type="checkbox" ${goal.scope?.research ? 'checked' : ''} /> 为这个目标做只读研究（搜索网页和读取所选资料）</label>
        <p class="muted small">${COMMITMENTS.research?.enabled ? '研究使用上方的全局授权；只读，不执行外部操作。' : '后台研究目前关闭。可以先保存目标范围，再在上方开启。'}</p>
        <div class="field"><label for="goalUrls">指定网页（最多 3 个，每行一个）</label><textarea id="goalUrls" name="urls" rows="3" placeholder="https://…">${esc((goal.scope?.urls ?? []).join('\n'))}</textarea></div>
        <details class="goal-extra-sources"><summary>附加资料与已确认的官方网站（可选）</summary>
          <div class="field"><label for="goalDocuments">为这个目标附加资料（最多 5 份）</label><input id="goalDocuments" type="file" accept=".pdf,.txt,.md" multiple aria-describedby="goalDocumentsHelp" /><p id="goalDocumentsHelp" class="muted small">PDF、TXT 或 Markdown，每份最多 5 MB。本地 Echo 只保存提取的文字，只有加入这个目标才会用于研究。取消草稿不会删除已上传的资料。</p></div>
          <div id="goalDocumentList"></div><p id="goalUploadStatus" class="small" role="status"></p>
          <div class="field"><label for="goalFolders">工作区文件夹（最多 3 个，每行一个）</label><textarea id="goalFolders" name="folders" rows="2" placeholder="例如：admissions/2027">${esc((goal.scope?.folders ?? []).join('\n'))}</textarea><p class="muted small">相对于设置中的工作区，只授权这些文件夹。留空不读取其他本地文件。</p></div>
          <div class="field"><label for="goalOfficialDomains">已确认的官方网站域名（最多 5 个，可选）</label><textarea id="goalOfficialDomains" name="officialDomains" rows="2" placeholder="例如：admissions.example.edu">${esc((goal.scope?.officialDomains ?? []).join('\n'))}</textarea><p class="muted small">每行一个你已确认的域名。没有它也能寻找线索；只有匹配此范围的来源才能核对为官方截止信息。找到的网页不会自动成为官网。</p></div>
        </details>
        <p class="muted small">准备内容只保存到 Echo。发送消息、发布或修改外部内容需要另行授权。</p>
      </fieldset>
      <details class="goal-context"><summary>事项背景（可选）</summary>
        ${Object.entries({ institution: ['机构', 160], program: ['项目', 200], cycle: ['届次或年份', 80], category: ['申请或活动类别', 80], stage: ['当前阶段', 80] }).map(([key, [label, max]]) => `<div class="field"><label for="goal-${key}">${label}</label><input id="goal-${key}" name="${key}" maxlength="${max}" value="${esc(goal.situation?.[key] ?? '')}" /></div>`).join('')}
        <div class="field"><label for="goalQuestions">还需要确认的问题（最多 5 个，每行一个）</label><textarea id="goalQuestions" name="questions" rows="2" maxlength="1504">${esc((goal.situation?.questions ?? []).join('\n'))}</textarea></div>
      </details>
      <p class="muted small">${goal.status === 'paused' ? '目标暂停期间不会准备，恢复时会准备一次。' : '确认、修改或恢复目标时会准备一次。'}后续按下面的方式跟进，所有准备共用次数预算。</p>
      <div class="field"><label for="goalWatch">后续何时准备</label><select id="goalWatch" name="watch"><option value="manual" ${!goal.watch?.type || goal.watch.type === 'manual' ? 'selected' : ''}>之后由我点击「准备下一步」</option><option value="combined" ${goal.watch?.type === 'combined' ? 'selected' : ''}>综合跟进来源变化和截止进展</option><option value="deadline" ${goal.watch?.type === 'deadline' ? 'selected' : ''}>临近截止日期</option><option value="source_change" ${goal.watch?.type === 'source_change' ? 'selected' : ''}>指定网页有变化时</option></select></div>
      <div class="row"><button class="btn small primary" type="submit">${goal.id ? '保存修改' : '确认并加入目标'}</button><button class="btn small" type="button" data-action="goal-editor-cancel">取消</button></div><p class="form-status small" role="status"></p></form>`
  }
  if (mode !== 'complete') renderGoalDocuments()
  el.scrollIntoView({ block: 'nearest' })
  $('input, textarea', el)?.focus()
}

function renderGoalDocuments() {
  const list = $('#goalDocumentList')
  if (!list || !COMMITMENTS.editor) return
  list.innerHTML = (COMMITMENTS.editor.documents ?? []).map((id) => {
    const document = COMMITMENTS.research?.documents?.find((item) => item.id === id)
    return `<div class="goal-document"><span>${esc(document?.name || '已附加资料')}<small class="muted">${esc(id)}</small></span><button class="btn small ghost" type="button" data-action="goal-document-remove" data-id="${esc(id)}" aria-label="从这个目标移除${esc(document?.name || '资料')}">移除</button></div>`
  }).join('')
}

async function uploadGoalDocuments(input) {
  const editor = COMMITMENTS.editor
  if (!editor || editor.uploading) return
  const files = Array.from(input.files ?? [])
  const status = $('#goalUploadStatus')
  if (!files.length) return
  editor.uploading = true
  input.disabled = true
  try {
    if (editor.documents.length + files.length > 5) throw new Error('每个目标最多附加 5 份资料。')
    if (files.some((file) => !/\.(pdf|txt|md)$/i.test(file.name))) throw new Error('请选择 PDF、TXT 或 Markdown 文件。')
    if (files.some((file) => file.size > 5 * 1024 * 1024)) throw new Error('每份资料不能超过 5 MB。')
    for (const file of files) {
      if (COMMITMENTS.editor !== editor) return
      status.textContent = `正在上传 ${file.name}…`
      const data = String(await readAsDataUrl(file)).split(',')[1]
      if (COMMITMENTS.editor !== editor) return
      const result = await api('research/documents', { method: 'POST', body: { name: file.name, data } })
      if (COMMITMENTS.editor !== editor) return
      if (!result.document?.id) throw new Error('上传响应缺少资料信息，请重试。')
      editor.documents.push(result.document.id)
      COMMITMENTS.research ??= {}
      COMMITMENTS.research.documents ??= []
      COMMITMENTS.research.documents.push(result.document)
      renderGoalDocuments()
    }
    status.textContent = '资料已附加到草稿；保存目标后才会用于研究。'
  } catch (err) {
    if (COMMITMENTS.editor === editor) status.textContent = `上传失败：${err.message} 已上传的资料与目标草稿仍保留。`
  } finally {
    editor.uploading = false
    input.disabled = false
    input.value = ''
  }
}

async function saveCommitmentForm(form) {
  if (!form.reportValidity() || form.dataset.saving) return
  if (COMMITMENTS.editor?.uploading) return toast('资料还在上传，请稍候再保存', true)
  const editor = { ...COMMITMENTS.editor }
  const values = new FormData(form)
  const status = $('.form-status', form)
  const controls = $$('button', form)
  form.dataset.saving = 'true'
  controls.forEach((button) => { button.disabled = true })
  try {
    if (editor.mode === 'complete') {
      const completionEvidence = String(values.get('completionEvidence') ?? '').trim()
      if (!completionEvidence) throw new Error('请填写完成依据。')
      await api(`commitments/${encodeURIComponent(editor.id)}`, { method: 'PATCH', body: { status: 'done', completionEvidence } })
      if (editor.preparationId) {
        try {
          const feedback = await api('feedback', { method: 'POST', body: { commitmentId: editor.id, preparationId: editor.preparationId, signal: 'completed' } })
          if (feedback.ignored) throw new Error('原准备结果已不可用')
        } catch (err) { toast(`目标已完成，但结果反馈未保存：${err.message}`, true) }
      }
    } else {
      const urls = [...new Set(String(values.get('urls') ?? '').split(/\r?\n/).map((url) => url.trim()).filter(Boolean))]
      if (urls.length > 3) throw new Error('最多添加 3 个网页。')
      for (const url of urls) {
        let parsed
        try { parsed = new URL(url) } catch {}
        if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('网页地址需以 https:// 或 http:// 开头，且不能包含登录信息。')
      }
      const watch = String(values.get('watch'))
      const deadline = String(values.get('deadline') ?? '') || null
      if (watch === 'deadline' && !deadline) throw new Error('请填写截止日期，或选择手动准备。')
      if (watch === 'source_change' && !urls.length && values.get('research') !== 'on') throw new Error('来源变化触发需要至少一个指定网页，或勾选只读研究。')
      const body = { title: String(values.get('title')).trim(), successCriteria: String(values.get('successCriteria')).trim(), nextAction: String(values.get('nextAction')).trim(), deadline, scope: { memory: values.get('memory') === 'on', urls }, watch: { type: watch } }
      if (values.get('folders') !== null) {
        const lines = (key) => [...new Set(String(values.get(key) ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
        const folders = lines('folders'), officialDomains = lines('officialDomains').map((domain) => domain.toLowerCase())
        if (folders.length > 3 || folders.some((folder) => /^(?:\/|~|[a-z]:)/i.test(folder) || folder.includes('\\') || folder.split('/').includes('..') || folder === '.')) throw new Error('请填写最多 3 个工作区内的相对文件夹路径，不能使用绝对路径或上级目录。')
        if (officialDomains.length > 5 || officialDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain))) throw new Error('请填写最多 5 个完整官方网站域名，不含协议、路径或通配符。')
        body.scope = { ...body.scope, research: values.get('research') === 'on', documents: editor.documents ?? [], folders, officialDomains }
        body.situation = Object.fromEntries(['institution', 'program', 'cycle', 'category', 'stage'].map((key) => [key, String(values.get(key) ?? '').trim()]))
        body.situation.questions = lines('questions')
        if (body.situation.questions.length > 5 || body.situation.questions.some((question) => question.length > 300)) throw new Error('最多填写 5 个待确认问题，每个最多 300 字。')
        if (!body.scope.research && (body.scope.documents.length || folders.length || officialDomains.length)) throw new Error('使用附加资料、工作区文件夹或官网域名，需要先勾选这个目标的只读研究。')
      }
      if (watch === 'combined' && !deadline && !urls.length && !body.scope.research) throw new Error('综合跟进需要截止日期、指定网页，或勾选只读研究。')
      if (!body.title || !body.successCriteria || !body.nextAction) throw new Error('请填写目标、完成标准和下一步。')
      if (!editor.id && editor.source) body.source = editor.source
      if (!editor.id && editor.candidateLoopId) body.candidateLoopId = editor.candidateLoopId
      if (editor.id && editor.revision) body.expectedRevision = editor.revision
      await api(editor.id ? `commitments/${encodeURIComponent(editor.id)}` : 'commitments', { method: editor.id ? 'PATCH' : 'POST', body })
    }
    COMMITMENTS.editor = null
    $('#commitmentEditor').innerHTML = ''
    toast(editor.mode === 'complete' ? '已记录完成依据' : '目标已保存')
    await renderProactivePanel({ force: true })
    $('[data-action="goal-new"]')?.focus()
  } catch (err) {
    status.textContent = err.message
  } finally {
    delete form.dataset.saving
    controls.forEach((button) => { button.disabled = false })
  }
}

document.addEventListener('submit', (event) => {
  if (event.target.id === 'researchSettingsForm') {
    event.preventDefault()
    saveResearchSettings(event.target).catch((err) => toast(err.message, true))
    return
  }
  if (event.target.id !== 'commitmentForm') return
  event.preventDefault()
  saveCommitmentForm(event.target).catch((err) => toast(err.message, true))
})

function renderProactiveOverview(p, dream, agency) {
  const el = $('#proactiveOverview')
  const nudgeHtml = (dream.nudges ?? [])
    .map((n) => `<div class="mem-item"><div class="txt">${esc(n.topic)}<div class="muted small">${esc(n.angle ?? '')} · 急迫度 ${n.urgency}</div></div></div>`)
    .join('')
  const kindRows = (agency.kinds ?? [])
    .map((k) => {
      const thr = (p.kindThresholds ?? {})[k.kind]
      return `<div class="mem-item"><div class="txt">${esc(KIND_LABEL[k.kind] ?? k.kind)}
        <div class="muted small">有用程度估计 ${(k.mean * 100).toFixed(0)}% · 明确反馈 ${k.trials} 次${thr ? ` · 当前门槛 ${thr}` : ''}</div>
      </div><div class="bar" style="width:56px"><i style="width:${Math.round(k.mean * 100)}%"></i></div></div>`
    })
    .join('')
  el.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${p.todayCount}/${p.budget}</b><span>今日主动开口</span></div>
      <div class="stat"><b>${(agency.outcomes?.accepted ?? 0) + (agency.outcomes?.completed ?? 0)}</b><span>采用或帮助完成</span></div>
      <div class="stat"><b>${agency.outcomes?.unknown ?? 0}</b><span>尚无明确反馈</span></div>
    </div>
    <p class="muted small">共同打扰预算：今天 ${p.attention?.todayCount ?? 0}/${p.attention?.budget ?? S.boot?.config?.attention?.dailyBudget ?? 20} 次 · 最少间隔 ${p.attention?.minGapSeconds ?? 75} 秒。主动消息、伴随气泡和准备结果一起计数。</p>
    <p class="muted small">${p.queue?.length ? `${p.queue.length} 项等待合适时机提醒。` : '没有等待提醒的事项。'}${p.attention?.focus ? ` 当前状态：${esc(({ deep: '专注中', meeting: '会议中', normal: '工作中', idle: '空闲', entertainment: '休闲' })[p.attention.focus] || p.attention.focus)}。` : ''}${p.attention?.observedAt ? ` 状态依据：${esc(agencyTime(p.attention.observedAt))}。` : ''}</p>
    <label class="switch"><span>启用主动提醒</span><input type="checkbox" id="proEnabled" ${p.enabled ? 'checked' : ''} /></label>
    <div class="row">
      <button class="btn small" data-action="pro-run">现在检查一次</button>
      <span class="muted small">上次检查：${p.lastCheckAt ? ago(p.lastCheckAt) : '—'}｜上次开口：${p.lastAt ? ago(p.lastAt) : '从未'}</span>
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
      <p class="muted small">采用、完成和有用等明确反馈帮助 Echo 学习。普通回复和沉默都不代表有用或没用。「时机不合适」只调整打扰时机，并暂停打扰 30 分钟。</p>
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
                  <div class="muted small">${fmtTime(h.at)} · ${esc(KIND_LABEL[h.kind] ?? h.kind)} · ${esc(OUTCOME_LABEL[h.outcome?.signal ?? h.outcome] || '效果未知')}</div></div></div>`,
              )
              .join('')
          : '<div class="muted small">还没有主动发过消息。</div>'
      }</div>
    </div>`
  $('#proEnabled').addEventListener('change', async (e) => {
    const input = e.target
    input.disabled = true
    try {
      await api('proactive', { method: 'PATCH', body: { enabled: input.checked } })
      toast(input.checked ? '主动服务已开启' : '主动服务已暂停')
      if (S.boot?.proactive) S.boot.proactive.enabled = input.checked
      COMMITMENTS.proactiveEnabled = input.checked
      syncCommitmentCards()
    } catch (err) {
      input.checked = !input.checked
      toast(err.message, true)
    } finally { input.disabled = false }
  })
}

async function renderSettingsPanel() {
  const el = $('#panelSettings')
  const c = S.boot.config
  const [mcp, screen, providers, perms, companion] = await Promise.all([api('mcp'), api('screen'), api('providers'), api('permissions').catch(() => null), api('companion').catch(() => null)])
  S.companion = companion
  S.screen = screen
  W.catalog = providers
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
      <h4>联网搜索</h4>
      <div class="switch"><span>允许联网搜索</span><input type="checkbox" id="setSearchOn" ${c.search.enabled ? 'checked' : ''} /></div>
      <p class="muted small" style="margin:6px 0">勾选要用的提供方，按顺序依次尝试（前面的失败自动交给下一个，保存后生效）。密钥写进本机 echo.env，不进仓库。</p>
      ${wizardChainRows()}
      <div class="field" style="margin-top:10px"><label>搜索结果条数 <b>${c.search.maxResults}</b></label>
        <input type="range" id="setCount" min="3" max="10" step="1" value="${c.search.maxResults}" /></div>
      <div class="switch"><span>自动读取首条结果正文</span><input type="checkbox" id="setReadPages" ${c.search.readPages ? 'checked' : ''} /></div>
      <div class="field"><label>一轮回答最多调用工具次数 <b>${c.search.maxToolRounds}</b></label>
        <input type="range" id="setRounds" min="1" max="12" step="1" value="${c.search.maxToolRounds}" /></div>
      <div class="row"><button class="btn small" data-action="search-test">测试搜索链路</button></div>
    </div>
    <div class="sect">
      <h4>引导与权限</h4>
      <div class="row">
        <button class="btn small" data-action="rerun-wizard">重新运行引导</button>
        <span class="muted small">端点 ${c.upstreamConfigured ? '已配置' : '未配置'} · 记忆档 ${esc(c.memory.profile ?? 'standard')} · 搜索链 ${esc((c.search.order ?? []).join(' → ') || '不联网')}</span>
      </div>
      ${
        perms
          ? `<div class="chain" style="margin-top:8px">
              <div class="chain-row"><span class="idx">${perms.configured ? '✓' : '!'}</span><span style="flex:1">模型端点${perms.configured ? '已配置' : '未配置'}</span></div>
              <div class="chain-row"><span class="idx">${perms.runningUnderLaunchd ? '✓' : '!'}</span><span style="flex:1">${perms.runningUnderLaunchd ? 'launchd 常驻中（登录自启）' : '手动启动：跑 ./install.sh 让它常驻'}</span></div>
              <div class="chain-row"><span class="idx">${perms.tools.swiftc ? '✓' : '!'}</span><span style="flex:1">swiftc ${perms.tools.swiftc ? '可用' : '缺失（xcode-select --install）'}</span></div>
              <div class="chain-row"><span class="idx">${perms.authRequired ? '✓' : '·'}</span><span style="flex:1">${perms.authRequired ? '已开启口令验证' : '免登录（本机自用）'} · ${esc(perms.bind)} :${perms.port}</span></div>
              <div class="chain-row"><span class="idx">·</span><span style="flex:1">数据目录：${esc(perms.dataDir)}</span></div>
            </div>
            <div class="row" style="margin-top:8px"><button class="btn small" data-action="perm-test">测试屏幕录制权限</button>
            <span class="muted small" id="permOut">${esc(perms.notes.screen)}</span></div>`
          : '<div class="muted small">权限信息读取失败</div>'
      }
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
      <p class="muted small">「全部忘掉」会清空事实清单、工作记忆、实体图、核心记忆、相处方式、人物背景、目标和准备结果，并在遗忘日志里留一条记录。会话记录默认保留。</p>
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
      <div class="field"><label>屏蔽应用（命中完全不采集，逗号分隔；默认空）</label>
        <input type="text" id="setBlocklist" placeholder="例如：1Password、Alipay、Terminal" value="${esc((c.screen?.blocklist ?? []).join('、'))}" /></div>
      <div class="field"><label>屏蔽关键词正则（命中跳过，逗号分隔；默认空）</label>
        <input type="text" id="setExcludes" placeholder="例如：password、身份证" value="${esc((c.screen?.excludeTitlePatterns ?? []).join(','))}" /></div>
      <p class="muted small">锁屏、键鼠空闲不会被采集。默认只把本地 OCR 出的文字发给模型；原始截图分析完即删，绝不进归档。模型若识别出敏感内容，只记"在处理敏感信息"，不写任何事实进记忆。</p>
    </div>
    <div class="sect">
      <h4>伴随模式 <span class="muted small">· 跟着你一起看，用气泡偶尔说一句</span></h4>
      <div class="switch"><span>开启伴随模式（会大幅提高看屏幕的频率）</span><input type="checkbox" id="setCompOn" ${c.companion?.enabled ? 'checked' : ''} /></div>
      <p class="muted small">开启后状态栏会每 ${c.companion?.intervalSeconds ?? 20} 秒看一眼（本地 OCR，截图即删），在右上角用气泡冒出来：
        聊天时帮你判断语气、给可复制的回复；看片时当个一起看的同伴；办公/写代码时给一条具体建议。点气泡进入小对话窗细聊。
        屏幕没变化时它不会调模型，气泡有预算与间隔，连续被你忽略会自动安静一会儿。</p>
      <div class="field"><label>看屏幕间隔 <b>${c.companion?.intervalSeconds ?? 20}</b> 秒</label>
        <input type="range" id="setCompInterval" min="5" max="120" step="5" value="${c.companion?.intervalSeconds ?? 20}" /></div>
      <div class="field"><label>每小时气泡上限 <b>${c.companion?.hourlyBudget ?? 15}</b></label>
        <input type="range" id="setCompBudget" min="1" max="40" step="1" value="${c.companion?.hourlyBudget ?? 15}" /></div>
      <div class="field"><label>气泡最小间隔 <b>${c.companion?.minGapSeconds ?? 75}</b> 秒</label>
        <input type="range" id="setCompGap" min="20" max="600" step="5" value="${c.companion?.minGapSeconds ?? 75}" /></div>
      <div class="field"><label>只在哪些场景开口（不勾就完全不冒泡）</label>
        <div class="row">${(S.companion?.scenarios ? Object.entries(S.companion.scenarios) : []).map(([id, label]) =>
          `<label class="pill" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" data-cscenario="${id}" ${(S.companion?.enabledScenarios ?? []).includes(id) ? 'checked' : ''} />${esc(label)}</label>`).join('') || '<span class="muted small">（读取中…）</span>'}</div></div>
      <div class="row"><button class="btn small" data-action="comp-pause">${S.companion?.paused ? '恢复伴随' : '暂停 30 分钟'}</button>
        <span class="muted small">今日看过 ${S.companion?.framesToday ?? 0} 帧 · 本小时气泡 ${S.companion?.hourCount ?? 0}/${c.companion?.hourlyBudget ?? 15} · 连续被忽略 ${S.companion?.dismissStreak ?? 0} 次</span></div>
      <div class="list" style="margin-top:8px">${(S.companion?.recent ?? []).slice(0, 5).map((b) =>
        `<div class="mem-item"><div class="txt">${esc(b.bubble)}
          <div class="muted small">${esc(b.scenario)} · ${esc(b.topic)} · ${String(b.ts).slice(11, 16)} · ${esc(b.status)}${b.why ? ` · ${esc(b.why.slice(0, 60))}` : ''}</div></div></div>`).join('')}</div>
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
      <div class="field"><label>记忆档位（选档会一次性写实下面的具体旋钮）</label>
        <select id="setProfile">${Object.entries(providers.profiles)
          .map(([id, p]) => `<option value="${id}" ${(c.memory.profile ?? 'standard') === id ? 'selected' : ''}>${esc(p.label)}</option>`)
          .join('')}</select></div>
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
      <h4>共同打扰预算</h4>
      <p class="muted small">主动消息、伴随气泡和准备结果共用此预算，也保留各自的频率上限。安静准备不占打扰次数。</p>
      <div class="field"><label for="setAttentionBudget">每天合计最多打扰几次</label><input id="setAttentionBudget" type="number" min="0" max="100" step="1" required value="${c.attention?.dailyBudget ?? 20}" /></div>
      <div class="field"><label for="setAttentionGap">不同渠道之间至少间隔（秒）</label><input id="setAttentionGap" type="number" min="0" max="3600" step="5" required value="${c.attention?.minGapSeconds ?? 75}" /></div>
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
      <h4>访问控制</h4>
      <div class="switch"><span>要求访问口令（关掉后同 WiFi 的设备都能直接用，不推荐在公共网络下关闭）</span>
        <input type="checkbox" id="setAuthRequired" ${c.auth?.required ? 'checked' : ''} /></div>
      <div class="row" style="margin-top:6px">
        <button class="btn small" data-action="set-passwd">${c.auth?.passwordSet ? '修改口令' : '设置口令'}</button>
        <span class="muted small">${c.auth?.required ? '当前：需要登录' : '当前：本机自用（免登录）'}</span>
      </div>
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
  if (['#setAttentionBudget', '#setAttentionGap'].some((selector) => $(selector)?.reportValidity?.() === false)) return
  const body = {
    config: {
      upstream: { defaultModel: $('#setModel').value, defaultImageModel: $('#setImageModel').value },
      generation: { temperature: Number($('#setTemp').value) },
      media: { imageInput: $('#setImageIn').checked, imageOutput: $('#setImageOut').checked, maxEdge: Number($('#setMaxEdge').value) },
      systemPrompt: $('#setSystem').value,
      search: {
        enabled: $('#setSearchOn').checked,
        order: $$('#panelSettings [data-order]').filter((cb) => cb.checked).map((cb) => cb.dataset.order),
        providers: (() => {
          const out = {}
          $$('#panelSettings [data-pcfg]').forEach((i) => {
            if (i.value.trim()) out[i.dataset.pcfg] = { endpoint: i.value.trim() }
          })
          return out
        })(),
        maxResults: Number($('#setCount').value),
        readPages: $('#setReadPages').checked,
        maxToolRounds: Number($('#setRounds').value),
      },
      memory: { enabled: $('#setMemOn').checked, extract: $('#setExtract').checked, inject: $('#setInject').checked,
        profile: $('#setProfile')?.value !== S.boot?.config?.memory?.profile ? $('#setProfile')?.value : undefined },
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
      companion: {
        enabled: $('#setCompOn')?.checked ?? false,
        intervalSeconds: Number($('#setCompInterval')?.value ?? 20),
        hourlyBudget: Number($('#setCompBudget')?.value ?? 15),
        minGapSeconds: Number($('#setCompGap')?.value ?? 75),
        scenarios: $$('#panelSettings [data-cscenario]').filter((cb) => cb.checked).map((cb) => cb.dataset.cscenario),
      },
      dream: { enabled: $('#setDreamOn').checked, intervalHours: Number($('#setDreamGap').value) },
      attention: { dailyBudget: Number($('#setAttentionBudget').value), minGapSeconds: Number($('#setAttentionGap').value) },
      proactive: {
        dailyBudget: Number($('#setBudget').value),
        minGapMinutes: Number($('#setMinGap').value),
        confidenceThreshold: Number($('#setThresh').value),
        notify: $('#setNotify').checked,
        quietHours: { start: $('#setQuietStart').value.trim(), end: $('#setQuietEnd').value.trim() },
      },
    },
  }
  const env = {}
  $$('#panelSettings [data-pkey]').forEach((i) => {
    if (i.value.trim()) env[i.dataset.pkey] = i.value.trim()
  })
  await api('settings', { method: 'PATCH', body: { ...body, env } })
  $('#setSaved').textContent = '已保存，立即生效'
  toast('设置已保存')
  await boot({ keep: true })
}

/* ------------------------------- conversations ------------------------------ */

async function selectConv(id) {
  if (S.stream || S.preparing) return toast('正在生成，先停止', true)
  const request = Symbol()
  S.selecting = request
  updateComposer()
  let conv
  try {
    conv = await api(`conversations/${id}`)
    if (S.selecting !== request) return
    if (conv.unread) await api(`conversations/${id}`, { method: 'PATCH', body: { unread: 0 } })
    if (S.selecting !== request) return
  } finally {
    if (S.selecting === request) {
      S.selecting = null
      updateComposer()
    }
  }
  saveDraft()
  S.current = id
  S.conv = conv
  const meta = S.convs.find((c) => c.id === id)
  if (meta) meta.unread = 0
  $('#convTitle').textContent = S.conv.title ?? '对话'
  $('#modelSelect').value = S.conv.model ?? prefs.model ?? S.boot.config.defaultModel
  $('#searchSelect').value = S.conv.searchMode ?? prefs.searchMode
  renderConvs()
  renderThread()
  $('#input').value = localStorage.getItem(`echo.draft.${id}`) ?? ''
  S.att = (S.attachmentDrafts.get(id) ?? []).slice()
  renderAttachments()
  POLISH.last = null
  renderPolishBox()
  autogrow()
  const closeSidebar = !matchMedia('(min-width: 861px)').matches && $('#app').dataset.sidebar === 'open'
  if (closeSidebar) $('#app').dataset.sidebar = 'closed'
  syncScrim()
  if (closeSidebar) $('#convTitle').focus()
}

async function newChat() {
  if (S.stream || S.selecting || S.preparing) return toast('请先等待当前操作完成', true)
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
  $('#app').dataset.sidebar = matchMedia('(min-width: 861px)').matches ? 'open' : 'closed'
  applyTheme()
  const sel = $('#modelSelect')
  const wantModel = prefs.model ?? b.config.defaultModel
  sel.innerHTML = modelOptionsHtml(b.config.models, wantModel)
  sel.value = wantModel
  $('#searchSelect').value = prefs.searchMode
  $('#thinkingBtn').setAttribute('aria-pressed', String(prefs.thinking))
  updateWorkspaceBadge()
  const logoutBtn = document.querySelector('[data-action="logout"]')
  if (logoutBtn) logoutBtn.hidden = !b.config.auth?.required
  renderConvs()
  const requested = new URLSearchParams(location.search).get('conv')
  const target = keep && S.convs.some((c) => c.id === S.current) ? S.current
    : S.convs.some((c) => c.id === requested) ? requested : b.main?.id ?? S.convs[0]?.id
  if (target) await selectConv(target)
  startPolling()
  // 没配置端点/密钥时，直接把引导推上来（可随时"以后再配"）
  if (b.config.onboarding?.needed && !localStorage.getItem('echo.onboardSkipped')) {
    openWizard().catch(() => {})
  }
}

function startPolling() {
  clearInterval(S.poll)
  S.poll = setInterval(async () => {
    if (!document.hidden && !$('#drawer').hidden && S.panel === 'proactive') await renderProactivePanel({ poll: true })
    if (!document.hidden && !$('#drawer').hidden && S.panel === 'workspace') await refreshRuns()
    if (S.stream || S.selecting || S.preparing || $('.edit-box') || document.hidden) return
    const conversationId = S.current
    try {
      const b = await api('bootstrap')
      if (S.stream || S.selecting || S.preparing || $('.edit-box') || S.current !== conversationId) return
      const before = S.convs.find((c) => c.id === S.current)?.messageCount ?? 0
      const cur = b.conversations.find((c) => c.id === S.current)
      let conv
      if (cur && cur.messageCount > before) {
        conv = await api(`conversations/${conversationId}`)
        if (S.stream || S.selecting || S.preparing || $('.edit-box') || S.current !== conversationId) return
      }
      S.boot = b
      updateWorkspaceBadge()
      updateComposer()
      S.convs = b.conversations
      renderConvs()
      if (conv) {
        S.conv = conv
        renderThread({ resetScroll: false })
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
  updateComposer()
}

/* --------------------------------- events ---------------------------------- */

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {}
  // HTTP LAN pages may not expose the Clipboard API.
  const previous = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败，请选中文字后复制')
  } finally {
    area.remove()
    previous?.focus()
  }
}

document.addEventListener('click', (e) => {
  handleAction(e).catch((err) => toast(err.message, true))
})

async function handleAction(e) {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const act = btn.dataset.action
  const id = btn.dataset.id

  if (act === 'relationship-retry') return loadRelationships()
  if (act === 'relationship-new') return showRelationshipEditor()
  if (act === 'relationship-edit') return showRelationshipEditor(id)
  if (act === 'relationship-editor-cancel') return closeRelationshipEditor(btn.closest('form')?.dataset.id)
  if (act === 'relationship-delete' || act === 'relationship-delete-cancel') {
    const confirmation = $('.relationship-delete-confirm', btn.closest('[data-person-id]'))
    confirmation.hidden = act === 'relationship-delete-cancel'
    if (!confirmation.hidden) $('[data-action="relationship-delete-confirm"]', confirmation).focus()
    else $('[data-action="relationship-delete"]', btn.closest('[data-person-id]')).focus()
    return
  }
  if (act === 'relationship-delete-confirm') return deleteRelationshipPerson(btn)
  if (act === 'run-approval') return decideApproval(btn)
  if (act === 'refresh-runs') return refreshRuns({ force: true })
  if (act === 'view-run') {
    if ($('#drawer').hidden || S.panel !== 'workspace') await openPanel('workspace')
    await inspectRun(id)
    $('#runInspector')?.focus()
    return
  }
  if (act === 'goal-new') return showCommitmentEditor()
  if (act === 'goal-document-remove') {
    if (COMMITMENTS.editor) {
      COMMITMENTS.editor.documents = COMMITMENTS.editor.documents.filter((documentId) => documentId !== id)
      renderGoalDocuments()
      $('#goalDocuments')?.focus()
    }
    return
  }
  if (act === 'goal-editor-cancel') {
    COMMITMENTS.editor = null
    $('#commitmentEditor').innerHTML = ''
    $('[data-action="goal-new"]')?.focus()
    return
  }
  if (act === 'adopt-message') {
    const messageId = btn.closest('.msg')?.dataset.id
    const message = S.conv?.messages.find((item) => item.id === messageId && item.role === 'user')
    if (!message) return
    const source = { conversationId: S.current, messageId }
    await openPanel('proactive')
    return showCommitmentEditor({ title: String(message.content).slice(0, 160) }, { source, quote: String(message.content).slice(0, 500) })
  }
  if (act === 'adopt-loop') {
    await openPanel('proactive')
    const loop = COMMITMENTS.loops.find((item) => item.id === id)
    if (!loop) return toast('这条候选事项已更新，请查看最新列表', true)
    return showCommitmentEditor({ title: loop.topic, deadline: loop.due }, { candidateLoopId: loop.id, quote: loop.why })
  }
  if (act === 'goal-edit' || act === 'goal-complete') {
    const goal = COMMITMENTS.items.find((item) => item.id === id)
    if (goal) showCommitmentEditor(goal, { mode: act === 'goal-complete' ? 'complete' : 'edit' })
    return
  }
  if (act === 'goal-prepare' || act === 'goal-status' || act === 'goal-adopt') {
    btn.disabled = true
    try {
      if (act === 'goal-prepare') {
        await api(`commitments/${encodeURIComponent(id)}/prepare`, { method: 'POST', body: {} })
        toast('已加入准备队列，结果会保留在这个目标下')
      } else if (act === 'goal-adopt') {
        await api(`commitments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { adopt: true } })
        toast('已选择继续跟进，不再受临时七天期限限制')
      } else {
        await api(`commitments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: btn.dataset.status } })
        toast(`目标${GOAL_STATUS[btn.dataset.status] === '进行中' ? '已恢复' : GOAL_STATUS[btn.dataset.status]}`)
      }
      await renderProactivePanel({ force: true })
    } finally { btn.disabled = false; restoreGoalActionFocus(btn) }
    return
  }
  if (act === 'preparation-feedback') {
    const goal = COMMITMENTS.items.find((item) => item.id === id)
    if (btn.dataset.signal === 'completed' && goal?.status !== 'done') {
      if (goal) showCommitmentEditor(goal, { mode: 'complete', preparationId: btn.dataset.preparationId })
      return
    }
    btn.disabled = true
    try {
      const feedback = await api('feedback', { method: 'POST', body: { commitmentId: id, preparationId: btn.dataset.preparationId, signal: btn.dataset.signal } })
      if (feedback.ignored) throw new Error('原准备结果已不可用，请刷新后重试')
      toast(btn.dataset.signal === 'wrong_time' ? '收到，暂停打扰 30 分钟，结果仍保留' : `已记录：${OUTCOME_LABEL[btn.dataset.signal]}`)
      await renderProactivePanel({ force: true })
    } finally { btn.disabled = false; restoreGoalActionFocus(btn) }
    return
  }
  if (act === 'view-preparation') {
    const preparationId = btn.dataset.preparationId
    const commitmentId = btn.dataset.commitmentId
    await openPanel('proactive')
    const result = $$('details[data-preparation-id]', $('#commitmentList')).find((node) => node.dataset.preparationId === preparationId)
    const card = $$('[data-goal-id]', $('#commitmentList')).find((node) => node.dataset.goalId === commitmentId)
    if (result) {
      result.open = true
      $('summary', result)?.focus()
      result.scrollIntoView({ block: 'nearest' })
    } else if (card) {
      card.focus()
      card.scrollIntoView({ block: 'nearest' })
    } else toast('这份结果已不可用，请查看当前目标列表', true)
    return
  }
  if (act === 'view-source-message') {
    if (S.stream || S.preparing) return toast('请先等待当前回复完成', true)
    closeDrawer()
    await selectConv(btn.dataset.conversationId)
    const message = $$('#threadInner .msg').find((node) => node.dataset.id === btn.dataset.messageId)
    if (message) {
      message.tabIndex = -1
      message.focus()
      message.scrollIntoView({ block: 'center' })
    } else toast('原消息已不存在，准备结果仍保留了当时的摘录', true)
    return
  }
  if (act === 'jump-latest') {
    scrollBottom(true)
    $('#thread').focus()
    return
  }
  if (act === 'copy-code') {
    const pre = btn.closest('pre')
    await copyText($('code', pre).textContent)
    toast('代码已复制')
    return
  }
  if (act === 'copy-msg') {
    const msg = btn.closest('.msg')
    const text = (msg.classList.contains('user') ? $('.body', msg) : $('.content', msg))?.innerText ?? msg.innerText
    await copyText(text)
    toast('已复制')
    return
  }
  if (act === 'edit-user') {
    if (S.stream || S.preparing) return toast('正在生成，先停止', true)
    const node = btn.closest('.msg')
    if ($('.gallery', node)) return toast('含图片的消息请重新发送，以保留原图', true)
    const body = node.querySelector('.body')
    const current = body.innerText
    node.originalBody = body.outerHTML
    const messages = $$('#threadInner .msg')
    const following = Math.max(0, messages.length - messages.indexOf(node) - 1)
    body.outerHTML = `<div class="body edit-box"><textarea aria-label="编辑消息">${esc(current)}</textarea>
      <p class="edit-hint">保存后将从这里重新开始${following ? `，替换后面的 ${following} 条消息` : ''}。</p>
      <div class="row"><button class="btn small" data-action="edit-cancel">取消</button><button class="btn small primary" data-action="edit-save">保存并重发</button></div></div>`
    $('textarea', node).focus()
    return
  }
  if (act === 'edit-cancel') {
    const node = btn.closest('.msg')
    if (node.originalBody) $('.body', node).outerHTML = node.originalBody
    $('[data-action="edit-user"]', node)?.focus()
    return
  }
  if (act === 'edit-save') {
    const node = btn.closest('.msg')
    const text = $('textarea', node).value.trim()
    if (!text) return
    if (S.stream) return toast('正在生成', true)
    const editId = node.dataset.id
    return startStream({ userText: text, editId })
  }
  if (act === 'regen') return startStream({ regenerate: true })
  if (act === 'stop') return stopReply()
  if (act === 'fb') {
    const signal = btn.dataset.signal
    const r = await api('feedback', { method: 'POST', body: { signal, kind: btn.dataset.kind, conversationId: S.current, messageId: btn.dataset.id } })
    if (r.ignored) return toast('这条反馈未能关联到原消息，请刷新后重试', true)
    btn.parentElement.querySelectorAll('button[data-action="fb"]').forEach((b) => (b.style.color = ''))
    btn.style.color = signal === 'good' ? 'var(--accent)' : 'var(--danger)'
    toast(signal === 'more' ? '已增加主动服务频率' : signal === 'less' ? '已减少主动服务频率' : signal === 'good' ? '已记录：这条内容有用' : '已记录：这条内容没用')
    void r
    return
  }
  if (act === 'sug') {
    const input = $('#input')
    input.value = input.value.trim() ? `${input.value}\n${btn.textContent}` : btn.textContent
    POLISH.last = null
    renderPolishBox()
    saveDraft()
    autogrow()
    input.focus()
    return
  }
  if (act === 'polish') {
    if (!POLISH.modes) POLISH.modes = (await api('polish/modes').catch(() => ({}))).modes ?? {}
    return runPolish()
  }
  if (act === 'attach') { $('#fileInput').click(); return }
  if (act === 'rm-att') { S.att.splice(Number(btn.dataset.i), 1); saveDraft(); renderAttachments(); autogrow(); return }
  if (act === 'draw') {
    if (S.drawing || S.stream || S.selecting) return toast('请等待当前生成完成', true)
    if (!S.boot?.config?.upstreamConfigured || !S.boot.config.defaultImageModel) return toast('请先在设置中配置出图模型', true)
    const prompt = $('#input').value.trim() || window.prompt('要画什么？可以带上风格、构图、光线')
    if (!prompt) return
    const conversationId = S.current
    S.drawing = conversationId
    updateComposer()
    try {
      const r = await api('images', { method: 'POST', body: { prompt, model: S.boot.config.defaultImageModel, conversationId } })
      if (S.current !== conversationId || S.selecting) {
        await refreshList()
        return toast('图片已保存到原会话')
      }
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
    } finally {
      S.drawing = null
      updateComposer()
    }
    return
  }
  if (act === 'toggle-sidebar') {
    return toggleSidebar()
  }
  if (act === 'new-chat') return newChat()
  if (act === 'select-conv') return selectConv(id)
  if (act === 'pin-conv') {
    const c = S.convs.find((x) => x.id === id)
    await api(`conversations/${id}`, { method: 'PATCH', body: { pinned: !c?.pinned } })
    return refreshList()
  }
  if (act === 'del-conv') {
    if (id === S.current && (S.stream || S.preparing)) return toast('请先停止当前生成', true)
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
  if (act === 'comp-pause') {
    const r = await api('companion/pause', { method: 'POST', body: { minutes: S.companion?.paused ? 0 : 30 } })
    toast(r.paused ? '已暂停伴随模式 30 分钟' : '已恢复伴随模式')
    await boot({ keep: true })
    return renderSettingsPanel()
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
    const [d, agency] = await Promise.all([api('diagnostics'), api('agency')])
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
        <div class="stat"><b>${(agency.outcomes?.accepted ?? 0) + (agency.outcomes?.completed ?? 0)}</b><span>累计采用或帮助完成</span></div>
      </div>
      <div class="muted small">用量：入 ${t.tokensIn ?? 0} / 出 ${t.tokensOut ?? 0} tokens · 平均 ${t.avgRounds ?? 0} 轮工具调用 · 模型 ${JSON.stringify(t.models ?? {})}</div>
      ${m.polish?.count ? `<div class="muted small">润色：${m.polish.count} 次 · 平均 ${m.polish.avgMs}ms · 改动率 ${((m.polish.changedRate ?? 0) * 100).toFixed(0)}% · 模式 ${JSON.stringify(m.polish.byMode ?? {})}</div>` : ''}
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
    const word = prompt(`这会清空${scope === 'all' ? '全部记忆和会话' : '全部记忆'}，以及相处方式、人物背景、目标、准备结果和相关记录，不可撤销。输入 WIPE 确认：`)
    if (word !== 'WIPE') return
    const r = await api('memory/wipe', { method: 'POST', body: { confirm: 'WIPE', scope } })
    COMMITMENTS.editor = null
    COMMITMENTS.items = []
    COMMITMENTS.preparations = []
    COMMITMENTS.version++
    $('#panelProactive').innerHTML = ''
    RELATIONSHIPS.version++
    RELATIONSHIPS.data = null
    RELATIONSHIPS.loading = false
    $('#panelMemory').innerHTML = ''
    toast(`已清空：${r.before.observations} 条事实${scope === 'all' ? `、${r.wiped.conversations} 个会话` : ''}`)
    await boot({ keep: true })
    return renderSettingsPanel()
  }
  if (act === 'rerun-wizard') {
    closeDrawer()
    return openWizard({ restart: true })
  }
  if (act === 'perm-test') {
    const out = $('#permOut')
    if (out) out.textContent = '测试中（系统可能弹授权窗）…'
    const r = await api('permissions/screen-test', { method: 'POST', body: {} })
    toast(r.granted ? '屏幕录制权限已就绪' : r.hint, !r.granted)
    if (out) out.textContent = r.granted ? '✓ 已授权，能抓到画面' : `✗ ${r.hint}`
    return
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
  if (act === 'set-passwd') {
    const next = prompt('设置访问口令（≥6 位）')
    if (!next) return
    await api('password', { method: 'POST', body: { next } })
    toast('口令已保存（开启验证后才需要输入）')
    return renderSettingsPanel()
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
}

document.addEventListener('change', async (e) => {
  if (e.target.closest?.('#researchSettingsForm')) e.target.closest('#researchSettingsForm').dataset.dirty = 'true'
  if (e.target.id === 'goalDocuments') {
    await uploadGoalDocuments(e.target).catch((err) => toast(err.message, true))
    return
  }
  if (e.target.id !== 'setAuthRequired') return
  const input = e.target
  const required = input.checked
  let saved = false
  input.disabled = true
  try {
    const r = await api('auth', { method: 'PATCH', body: { required } })
    saved = true
    input.checked = r.required
    toast(r.required ? '已开启口令验证（下次打开需要登录）' : '已关闭口令验证，本机自用')
    await boot({ keep: true })
    await renderSettingsPanel()
  } catch (err) {
    if (!saved) input.checked = !required
    toast(err.message, true)
  } finally {
    input.disabled = false
  }
})

$('#convTitle').addEventListener('click', renameNow)
$('#convTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renameNow() }
})
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
  if ((!text && !S.att.length) || S.stream || S.selecting || S.preparing || S.uploading || S.drawing === S.current) return
  if (!S.boot?.config?.upstreamConfigured) return toast('先连接模型，草稿会保留在这里', true)
  $('#input').value = ''
  localStorage.removeItem(`echo.draft.${S.current}`)
  autogrow()
  startStream({ userText: text }).catch((err) => toast(err.message, true))
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
  saveDraft()
  autogrow()
  if (POLISH.last && $('#input').value.trim() !== POLISH.last.original) {
    POLISH.last = null
    renderPolishBox()
  }
})
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!matchMedia('(pointer: coarse)').matches || e.metaKey || e.ctrlKey)) {
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
$('#thread').addEventListener('scroll', updateScrollState, { passive: true })
$('#thread').addEventListener('load', () => scrollBottom(false), true)
$('#thread').addEventListener('toggle', () => scrollBottom(false), true)
$('#scrim').addEventListener('click', () => {
  if (!$('#drawer').hidden) closeDrawer()
  else if (!matchMedia('(min-width: 861px)').matches && $('#app').dataset.sidebar === 'open') toggleSidebar()
})
document.addEventListener('keydown', (e) => {
  const overlay = W.open ? $('#wizard') : !$('#drawer').hidden ? $('#drawer')
    : !matchMedia('(min-width: 861px)').matches && $('#app').dataset.sidebar === 'open' ? $('#sidebar') : null
  if (overlay) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (W.open) closeWizard()
      else if (overlay === $('#drawer')) closeDrawer()
      else toggleSidebar()
      return
    }
    if (e.key === 'Tab') {
      const items = $$('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]', overlay)
        .filter((el) => !el.hidden && el.tabIndex >= 0 && el.getClientRects().length)
      const first = items[0]
      const last = items.at(-1)
      if (!first) { e.preventDefault(); overlay.focus(); return }
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        e.preventDefault(); first.focus()
      }
    }
    if (overlay === $('#drawer') && e.target.matches('.tab') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      const tabs = $$('.tab')
      const index = tabs.indexOf(e.target)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
        : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      openPanel(tabs[next].dataset.panel).catch((err) => toast(err.message, true))
    }
    if (overlay === $('#sidebar') && (e.key === 'Enter' || e.key === ' ') && e.target.matches('.conv[data-action="select-conv"]')) {
      e.preventDefault()
      selectConv(e.target.dataset.id).catch((err) => toast(err.message, true))
    }
    return
  }
  if (e.key === 'Escape' && e.target.closest('.edit-box')) {
    e.preventDefault()
    $('[data-action="edit-cancel"]', e.target.closest('.edit-box')).click()
    return
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.conv[data-action="select-conv"]')) {
    e.preventDefault()
    selectConv(e.target.dataset.id).catch((err) => toast(err.message, true))
    return
  }
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat() }
  if (meta && e.key === '/') { e.preventDefault(); toggleSidebar() }
  if (e.key === 'Escape') { if (!$('#drawer').hidden) closeDrawer(); else if (!matchMedia('(min-width: 861px)').matches && $('#app').dataset.sidebar === 'open') toggleSidebar(); else if (S.stream) stopReply() }
  if (meta && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); document.querySelector('[data-action="dream-now"]')?.click() }
  if (meta && e.key.toLowerCase() === 'm') { e.preventDefault(); openPanel('memory') }
  if (meta && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); document.querySelector('[data-action="polish"]')?.click() }
})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
addEventListener('resize', () => {
  syncScrim()
  autogrow()
  scrollBottom(false)
})

/* --------------------------------- start ----------------------------------- */
;(async () => {
  applyTheme()
  try {
    await boot()
  } catch (err) {
    showGate('first')
  }
})()
