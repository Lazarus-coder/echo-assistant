/* Echo chat client. Events use data-action so inline scripts stay disabled. */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clamp = (n, a, b) => Math.max(a, Math.min(b, n))
const uid = () => Math.random().toString(36).slice(2, 10)

const FOCUS_LABEL = { deep: '{{msg:focused}}', meeting: '{{msg:inAMeeting}}', normal: '{{msg:working}}', idle: '{{msg:idle}}', entertainment: '{{msg:leisure}}' }
const FACT_LABEL = { user: '{{msg:person}}', project: '{{msg:project}}', feedback: '{{msg:feedbackKind}}', reference: '{{msg:referenceKind}}', fact: '{{msg:factKind}}' }
const BUBBLE_STATUS = { pending: '{{msg:pendingBubble}}', expired: '{{msg:expiredBubble}}', opened: '{{msg:openedBubble}}', dismissed: '{{msg:dismissedBubble}}' }
const MCP_STATE = { idle: '{{msg:idle}}', connecting: '{{msg:connecting}}', ready: '{{msg:ready}}', closed: '{{msg:connectionClosed}}', failed: '{{msg:failed}}' }
const KIND_LABEL = { follow_up: '{{msg:followUp}}', suggest: '{{msg:suggestion}}', guide: '{{msg:guidance}}', ask: '{{msg:question}}', brief: '{{msg:dailyBrief}}' }

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
  brief: null,
}

/* ---------------------------------- api ----------------------------------- */

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-echo-request': 'echo' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (!res.ok && (path === 'login' || path === 'password')) {
    const result = await res.clone().json().catch(() => ({}))
    const gateMessage = {
      bad_password: '{{msg:incorrectPassword}}',
      weak: '{{msg:useAtLeastSixCharacters}}',
      setup_from_loopback_only: '{{msg:setPasswordOnHost}}',
      too_many_attempts: '{{msg:loginRateLimited}}',
    }[result.error]
    if (gateMessage) throw Object.assign(new Error(gateMessage), { status: res.status })
  }
  if (res.status === 401) {
    let mode = 'again'
    try {
      const j = await res.clone().json()
      if (j.error === 'no_password') mode = 'first'
    } catch {}
    showGate(mode)
    throw Object.assign(new Error('{{msg:signInToContinue}}'), { status: 401 })
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const error = await res.json(); msg = error.message ?? (typeof error.error === 'string' ? error.error : msg) } catch {}
    throw Object.assign(new Error(msg), { status: res.status })
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
        `<pre class="code"><div class="code-head"><span>${esc(lang || 'text')}</span><button data-action="copy-code">{{html:copy}}</button></div><code>${highlight(body, lang)}</code></pre>`,
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
  const hm = d.toLocaleTimeString(UI_LANGUAGE, { hour12: false, hour: '2-digit', minute: '2-digit' })
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
function ago(iso) {
  const ms = Date.now() - Date.parse(iso ?? 0)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60000) return '{{msg:justNow}}'
  if (ms < 3600000) return `${Math.floor(ms / 60000)} {{msg:minAgo}}`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} {{msg:hrAgo}}`
  return `${Math.floor(ms / 86400000)} {{msg:daysAgo}}`
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
  if (btn) btn.textContent = { auto: '{{msg:system}}', dark: '{{msg:dark}}', light: '{{msg:light}}' }[want]
}

/* ------------------------------- language --------------------------------- */

const UI_LANGUAGE = '{{msg:locale}}'
const supportedLanguage = value => value === 'en' || value === 'zh-CN'

function languageSelector() {
  return `<label class="language-choice"><span>{{html:interfaceLanguage}}</span>
    <select data-language>
      <option value="en" lang="en" ${UI_LANGUAGE === 'en' ? 'selected' : ''}>{{html:englishName}}</option>
      <option value="zh-CN" lang="zh-CN" ${UI_LANGUAGE === 'zh-CN' ? 'selected' : ''}>{{html:chineseName}}</option>
    </select></label>`
}

function navigateLanguage(language) {
  const url = new URL(location.href)
  url.searchParams.set('lang', language)
  if (S.current) {
    saveDraft()
    url.searchParams.set('conv', S.current)
  }
  location.replace(url.href)
}

function transientWork() {
  return S.stream || S.preparing || S.selecting || S.uploading || S.drawing || POLISH.running
}

function unsavedInputs() {
  return S.att?.length || [...S.attachmentDrafts.values()].some(items => items.length)
    || $('.edit-box') || $('#commitmentForm')
    || $$('[data-language-dirty]').some(editor => !editor.closest('[hidden]'))
}

async function changeLanguage(input) {
  const language = input.value
  input.value = UI_LANGUAGE
  if (!supportedLanguage(language) || language === UI_LANGUAGE) return
  if (transientWork()) return toast('{{msg:waitForCurrentWork}}', true)
  if (unsavedInputs() && !confirm('{{msg:confirmLanguageChange}}')) return
  input.disabled = true
  try {
    if (S.boot) {
      await api('settings', { method: 'PATCH', body: { config: { language } } })
      localStorage.setItem('echo.language', language)
      if (input.closest('#panelSettings')) sessionStorage.setItem('echo.reopenLanguageSettings', '1')
    } else {
      sessionStorage.setItem('echo.pendingLanguage', language)
    }
    navigateLanguage(language)
  } catch (err) {
    input.disabled = false
    toast(err.message, true)
  }
}

document.addEventListener('input', event => {
  if (event.target.matches?.('[data-language]')) return
  const editor = event.target.closest?.('#wizard .wizard-card, #drawer .sect, #gateForm')
  if (editor) editor.dataset.languageDirty = 'true'
})
addEventListener('storage', event => {
  if (event.key === 'echo.language' && supportedLanguage(event.newValue) && event.newValue !== UI_LANGUAGE
    && !transientWork() && !unsavedInputs()) navigateLanguage(event.newValue)
})

/* ---------------------------------- gate ----------------------------------- */

let gateMode = 'first'
function showGate(mode) {
  gateMode = mode ?? 'again'
  S.boot = null
  if (!new URLSearchParams(location.search).has('lang')) {
    const preferred = localStorage.getItem('echo.language') || (/^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en')
    if (preferred !== UI_LANGUAGE && supportedLanguage(preferred)) return navigateLanguage(preferred)
  }
  $('#gateLanguage').innerHTML = languageSelector()
  $('#app').hidden = true
  $('#gate').hidden = false
  $('#gateTitle').textContent = gateMode === 'first' ? '{{msg:setAPassword}}' : 'Echo'
  $('#gateHint').textContent = gateMode === 'first' ? '{{msg:setAPasswordOnThisMacAt}}' : '{{msg:enterYourPassword}}'
  $('#gateSubmit').textContent = gateMode === 'first' ? '{{msg:createPasswordAndSignIn}}' : '{{msg:signIn}}'
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
              <div class="name">${c.isMain ? '<span>{{html:mainChat}}</span>' : esc(c.title)}${c.unread ? '<i class="dot" title="{{html:newMessages}}"></i>' : ''}${c.pinned && !c.isMain ? '<svg viewBox="0 0 24 24" width="11" height="11" style="fill:currentColor;stroke:none"><path d="M14 3l7 7-4 1-3 3-1 4-4-4-5 5 1-6-4-4 6-1 3-3z"/></svg>' : ''}</div>
              <div class="sub">${c.isMain ? '{{msg:proactiveUpdatesAppearHere}}' : esc(c.preview || '{{msg:empty}}')} · ${ago(c.updatedAt)}</div>
            </div>
            <div class="tools">
              ${c.isMain ? '' : `<button data-action="pin-conv" data-id="${esc(c.id)}" title="${c.pinned ? '{{msg:unpin}}' : '{{msg:pin}}'}"><svg viewBox="0 0 24 24"><path d="M9 4h6M12 4v9M8 20l4-7 4 7"/></svg></button>`}
              <button data-action="export-conv" data-id="${esc(c.id)}" title="{{html:exportMarkdown}}"><svg viewBox="0 0 24 24"><path d="M12 4v10M8 10l4 4 4-4M5 19h14"/></svg></button>
              ${c.isMain ? '' : `<button data-action="del-conv" data-id="${esc(c.id)}" title="{{html:delete}}"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12"/></svg></button>`}
            </div>
          </li>`,
        )
        .join('')
    : '<li class="muted small" style="padding:10px">{{html:noMatchingChats}}</li>'
  $('#memCount').textContent = S.boot?.memory?.observations ?? 0
  $('#proCount').textContent = S.boot?.proactive?.todayCount ?? 0
  const followBadge = $('#followBadge')
  if (followBadge) {
    const count = S.boot?.followUps ?? 0
    followBadge.hidden = count === 0
    followBadge.textContent = `{{msg:followUps}} ${count}`
  }
}

async function refreshList() {
  const r = await api('conversations')
  S.convs = r.conversations
  renderConvs()
}

/* --------------------------------- thread ---------------------------------- */

const MESSAGE_FEEDBACK_LABELS = {
  good: ['{{msg:useful}}', '{{msg:thisReminderWasUseful}}'],
  bad: ['{{msg:notUseful}}', '{{msg:thisReminderWasNotUseful}}'],
  good_time: ['{{msg:goodTiming}}', '{{msg:thisWasAGoodTimeForThis}}'],
  wrong_time: ['{{msg:badTiming}}', '{{msg:badTimingPauseRemindersFor30Minutes}}'],
}

function messageFeedbackHtml(m) {
  if (!m.id || (!m.proactive && !m.companion)) return ''
  return Object.entries(MESSAGE_FEEDBACK_LABELS).map(([signal, [label, description]]) => {
    const selected = signal.endsWith('_time') ? (m.feedbackTiming ?? m.feedback) === signal : m.feedback === signal
    return `<button type="button" data-action="fb" data-signal="${signal}" data-kind="${esc(m.kind ?? 'chat')}" data-id="${esc(m.id)}" aria-label="${description}" title="${description}" aria-pressed="${selected}">${label}</button>`
  }).join('') + (typeof m.topicMuted === 'boolean'
    ? topicMuteButton((m.companion?.selection ?? m.selection).topicKey, m.topicMuted, m.id) : '')
}

function topicMuteButton(key, muted, messageId) {
  return `<button type="button" class="btn small" data-action="topic-mute" data-topic-key="${esc(key)}" data-muted="${muted}"${messageId ? ` data-id="${esc(messageId)}"` : ''}>${muted ? '{{msg:unmute}}' : key.startsWith('companion:') ? '{{msg:muteThisKindOfSuggestion}}' : '{{msg:muteThisTopic}}'}</button>`
}

function previewHtml(result) {
  const items = result.items.map((item) => {
    const why = item.reason === 'ok' ? '{{msg:readyToSend}}' : PROACTIVE_REASON_LABELS[item.reason] ?? '{{msg:onHold}}'
    return `<li><b>${esc(item.label)}</b><p>${esc(why)} {{msg:localScore}} ${Number(item.score).toFixed(2)}</p>
      <p class="muted small">${esc(item.reasons.join('{{msg:listClause}}'))}</p>${item.topicKey && !item.requested && item.reason !== 'topic_muted' ? topicMuteButton(item.topicKey, false) : ''}</li>`
  }).join('')
  const muted = result.muted.map((m) => `<li><span>${esc(m.label)} <small class="muted">${esc(agencyTime(m.addedAt))}</small></span> ${topicMuteButton(m.topicKey, true)}</li>`).join('')
  return `${items ? `<ol class="preview-items">${items}</ol>` : `<p class="muted small">${result.enabled ? '{{msg:noReminderCandidatesHaveEligibleSources}}' : '{{msg:proactiveRemindersAreOff}}'}</p>`}
    ${muted ? `<h4>{{html:mutedTopics}}</h4><ul class="preview-mutes">${muted}</ul>` : ''}`
}

let previewRevision = 0
function clearReminderPreview() {
  previewRevision++
  const node = $('#reminderPreview')
  if (node) node.innerHTML = ''
}

async function refreshReminderPreview() {
  const node = $('#reminderPreview')
  if (!node) return
  const version = ++previewRevision
  const result = await api('proactive/preview')
  if (version === previewRevision) node.innerHTML = previewHtml(result)
}

function selectionDetails(selection) {
  if (!selection?.label) return ''
  const reasons = Array.isArray(selection.reasons) ? selection.reasons : []
  return `<details class="fold"><summary>{{html:whyEchoChoseThis}}</summary><div class="fold-body">${esc(selection.label)}${reasons.length ? `<ul>${reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}</div></details>`
}

function messageNode(m) {
  const wrap = document.createElement('div')
  wrap.className = `msg ${m.role === 'user' ? 'user' : 'assistant'}${m.proactive ? ' proactive' : ''}`
  wrap.dataset.id = m.id ?? uid()
  if (m.role === 'user') {
    const imgs = (m.images ?? []).map((u) => (typeof u === 'string' ? { url: u } : u))
    wrap.innerHTML = `<div class="body"><div class="content">${esc(m.content)}</div>${imageGallery(imgs)}</div>`
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="msg-actions" style="align-self:flex-start"><button data-action="edit-user">{{html:editAndResend}}</button><button data-action="copy-msg">{{html:copy}}</button>${String(m.content ?? '').trim() ? '<button data-action="adopt-message">{{html:setAsAGoal}}</button>' : ''}</div>`,
    )
    wrap.style.alignItems = 'flex-end'
    return wrap
  }
  const kindBadge = m.proactive ? `<span class="kind">${KIND_LABEL[m.kind] ?? '{{msg:proactive}}'} {{html:startedByEcho}}</span>` : ''
  wrap.innerHTML = `<div class="avatar">E</div><div class="body">
      <div class="meta"><span class="who">Echo</span><span>${fmtTime(m.createdAt)}</span>${kindBadge}
        <span class="msg-actions">
          <button data-action="copy-msg">{{html:copy}}</button>
          ${m.proactive ? '' : '<button data-action="regen">{{html:regenerate}}</button>'}
          ${messageFeedbackHtml(m)}
        </span>
      </div>
      ${m.reasoning ? `<details class="fold reasoning"><summary>{{html:reasoning}} ${m.reasoning.length} {{html:characters}}</summary><div class="fold-body">${esc(m.reasoning)}</div></details>` : ''}
      ${(m.tools ?? []).length ? renderSteps(m.tools) : ''}
      ${m.runId ? (m.tools?.length || m.aborted || m.runStatus && m.runStatus !== 'completed') ? runCardHtml(messageRun(m)) : `<button class="btn small run-link" data-action="view-run" data-id="${esc(m.runId)}">{{html:viewRun}}</button>` : ''}
      <div class="content"></div>
      ${selectionDetails(m.selection ?? m.companion?.selection)}
      ${m.followUp ? `<div class="follow-up-suggest"><button class="btn small primary" data-action="adopt-follow-up" data-message="${esc(m.id)}">{{html:startFollowUp}}</button><span class="muted small">${m.followUp.stale ? `{{msg:echoNoticedThis}} ${esc(String(m.followUp.ageDays ?? ''))} {{msg:daysAgoCheckWhetherItIsStill}}` : '{{msg:askEchoToPrepareAndFollowUp}}'}</span></div>` : ''}
      ${m.preparationId || m.commitmentId ? `<button class="btn small result-link" data-action="view-preparation" data-preparation-id="${esc(m.preparationId ?? '')}" data-commitment-id="${esc(m.commitmentId ?? '')}">{{html:viewPreparedWork}}</button>` : ''}
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
      return `<div class="step ${t.ok === false ? 'bad' : ''}"><i class="st-dot"></i><span class="st-name">${esc(t.label ?? t.name)}</span><span class="st-arg">${esc(args)}</span><span class="st-ms">${esc(toolStatus(t))}${t.exitCode != null ? ` {{msg:exitCode}} ${esc(t.exitCode)}` : ''}</span></div>`
    })
    .join('')
  const detail = tools
    .map((t) => `<div class="st-out">${esc(toolOutputText(t.result ?? t.error).slice(0, 6000))}</div>${artifactLinks(t.artifacts)}`)
    .join('<hr style="border:0;border-top:1px solid var(--border);margin:8px 0"/>')
  return `<details class="fold steps-fold"><summary>{{html:used}} ${tools.length} {{html:toolCalls}}</summary><div class="fold-body"><div class="steps">${items}</div><div style="margin-top:8px">${detail}</div></div></details>`
}

const RUN_STATUS = { pending: '{{msg:queued}}', awaiting_approval: '{{msg:awaitingApproval}}', running: '{{msg:running}}', completed: '{{msg:completed}}', failed: '{{msg:failed}}', cancelled: '{{msg:stopped}}', interrupted: '{{msg:interrupted}}', limit_reached: '{{msg:limitReached}}', denied: '{{msg:denied}}', timed_out: '{{msg:timedOut}}' }
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
  const labels = { running: '{{msg:running2}}', awaiting_approval: '{{msg:waitingForYourApproval}}', completed: '{{msg:runCompleted}}', failed: '{{msg:runEncounteredAFailure}}', cancelled: '{{msg:runStopped}}', stop_requested: '{{msg:stopRequested}}', interrupted: '{{msg:runStatusUnknown}}', limit_reached: '{{msg:runLimitReached}}' }
  const counts = [
    [steps.filter((step) => state(step) === 'completed').length, '{{msg:finish}}'],
    [steps.filter((step) => ['failed', 'timed_out'].includes(state(step))).length, '{{msg:failed}}'],
    [steps.filter((step) => state(step) === 'denied').length, '{{msg:deny}}'],
    [steps.filter((step) => state(step) === 'cancelled').length, '{{msg:stop}}'],
  ].filter(([count]) => count).map(([count, label]) => `${label} ${count} {{msg:steps}}`)
  const notes = {
    completed: '{{msg:theRecordIncludesEachStepSInputs}}',
    failed: '{{msg:completedStepsAndOutputsAreSavedCheck}}',
    cancelled: '{{msg:executionStoppedCompletedActionsStillApply}}',
    stop_requested: '{{msg:stopRequestedCheckTheRunRecordFor}}',
    interrupted: '{{msg:connectionLostCheckTheRunRecordBefore}}',
    limit_reached: '{{msg:theRemainingStepsHaveYetToRun}}',
    unknown: '{{msg:viewRunDetailsForTheFinalStatus}}',
  }
  const current = ['running', 'awaiting_approval'].includes(status)
    ? active ? `${status === 'awaiting_approval' ? '{{msg:awaitingApproval2}}' : '{{msg:currentStep}}'}{{msg:labelSeparator}}${active.label || active.name || '{{msg:toolCall}}'}` : run.phase || '{{msg:preparingTheNextStep}}'
    : notes[status] ?? '{{msg:viewTheRunRecordForDetails}}'
  return `<div class="run-feedback-heading"><span class="run-feedback-dot" aria-hidden="true"></span><strong>${esc(labels[status] ?? RUN_STATUS[status] ?? '{{msg:runRecord}}')}</strong></div>
    <p class="run-feedback-count">${steps.length ? `{{msg:recorded}} ${steps.length} {{msg:steps}}${counts.length ? ` · ${counts.join(' · ')}` : ''}` : '{{msg:noToolsCalled}}'}</p>
    <p class="run-feedback-detail">${esc(current)}</p>
    ${run.error && status !== 'cancelled' ? `<p class="err">${esc(toolText(run.error))}</p>` : ''}`
}
function runCardHtml(run) {
  return `<section class="run-feedback" data-state="${esc(run.status ?? 'unknown')}" aria-label="{{html:runStatus}}">
    <div class="run-feedback-body" role="status" aria-live="polite" aria-atomic="true">${runFeedbackHtml(run)}</div>
    <button class="btn small run-link" data-action="view-run" data-id="${esc(run.id)}">{{html:viewStepsAndResults}}</button></section>`
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
function parseToolOutput(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
function toolOutputText(value) {
  const parsed = parseToolOutput(value)
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.stdout === 'string' || typeof parsed.stderr === 'string') {
      return [parsed.stdout ? `{{msg:standardOutput}}${parsed.stdout}` : '', parsed.stderr ? `{{msg:standardError}}${parsed.stderr}` : '', parsed.reason ? `{{msg:endReason}}${parsed.reason}` : ''].filter(Boolean).join('\n\n') || '{{msg:noOutput}}'
    }
    if (typeof parsed.content === 'string') return parsed.content
  }
  return toolText(parsed)
}
function toolStatus(tool) {
  if (tool.approval?.status === 'denied') return RUN_STATUS.denied
  if (tool.status) return RUN_STATUS[tool.status] ?? tool.status
  return tool.ok === false ? '{{msg:failed}}' : tool.ms != null ? `${tool.ms}ms` : '…'
}
function artifactLinks(artifacts) {
  return (artifacts ?? []).filter((item) => /^\/api\/runs\/[^\\\s?#]+\/artifacts\/[^\\\s?#]+$/.test(item.url ?? ''))
    .map((item) => `<a class="run-artifact" href="${esc(item.url)}" download>${esc(item.name || '{{msg:outputFiles}}')}${Number.isFinite(item.bytes) ? ` · ${Math.ceil(item.bytes / 1024)} KB` : ''}</a>`).join('')
}

/* -------------------------------- return brief ---------------------------- */

const BRIEF_GAP_MS = 6 * 3600000

// A single read gathers changes after a long absence.
async function maybeShowReturnBrief() {
  if (document.hidden) return
  const last = localStorage.getItem('echo.lastVisit')
  localStorage.setItem('echo.lastVisit', new Date().toISOString())
  if (!last || !Number.isFinite(Date.parse(last))) return
  if (Date.now() - Date.parse(last) < BRIEF_GAP_MS) return
  try {
    const brief = await api(`brief?since=${encodeURIComponent(last)}`)
    S.brief = brief?.items?.length ? brief : null
    $('#briefCard')?.remove()
    const inner = $('#threadInner')
    if (S.brief && inner && S.current === 'main') inner.prepend(briefCard(brief))
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (!S.boot || $('#app').hidden) return
  if (document.hidden) localStorage.setItem('echo.lastVisit', new Date().toISOString())
  else maybeShowReturnBrief()
})

function briefCard(brief) {
  const card = document.createElement('div')
  card.className = 'brief-card'
  card.id = 'briefCard'
  card.innerHTML = briefCardHtml(brief)
  return card
}

function briefCardHtml(brief) {
  const rows = []
  for (const item of brief.items) {
    if (item.kind === 'proactive') rows.push(`{{html:echoSent}} <b>${item.count}</b> {{html:proactiveMessages}}${item.latest?.preview ? ` {{msg:latest}}${esc(item.latest.preview)}` : ''}`)
    else if (item.kind === 'due') rows.push(item.goals.map((g) => `<b>${esc(g.title)}</b> ${g.stage === 'overdue' ? '{{msg:overdue}}' : g.stage === 'today' ? '{{msg:dueToday}}' : '{{msg:dueSoon}}'}{{msg:openParenthesis}}${esc(g.deadline)}{{msg:closeParenthesis}}`).join('{{msg:listClause}}'))
    else if (item.kind === 'drafts') rows.push(`<b>${item.count}</b> {{html:draftsReadyToReview}} ${(item.drafts ?? []).map((d) => `<button class="btn small result-link" data-action="view-preparation" data-preparation-id="${esc(d.id)}" data-commitment-id="${esc(d.commitmentId)}">${esc(d.title)}</button>`).join(' ')}`)
    else if (item.kind === 'failed') rows.push(`<b>${item.count}</b> {{html:goalsNeedAnotherPreparationAttempt}}`)
    else if (item.kind === 'loops') {
      const fresh = item.freshCount ?? 0
      // Older leads need verification before Echo suggests acting on them.
      if (fresh) rows.push(`{{html:thereAre}} <b>${fresh}</b> {{html:leadsYouCanTakeOver}}${item.count > fresh ? `{{msg:otherLeads}} ${item.count - fresh} {{msg:olderLeads}}` : ''}`)
      else if (item.newestDays != null) rows.push(`<b>${item.count}</b> {{html:leadsFirstNoticedAtLeast}} ${item.newestDays} {{msg:daysAgo2}}`)
      else rows.push(`{{html:thereAre2}} <b>${item.count}</b> {{html:leadsOfUnknownAge}}`)
    }
    else if (item.kind === 'facts') rows.push(`{{html:echoSaved}} <b>${item.count}</b> {{html:newFacts}}`)
  }
  return `<div class="brief-head"><span>{{html:sinceYouWereAway}}</span><button class="icon-btn" data-action="dismiss-brief" aria-label="{{html:dismissBrief}}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
    <ul class="brief-list">${rows.map((row) => `<li>${row}</li>`).join('')}</ul>
    <button class="btn small" data-action="open-panel" data-panel="proactive">{{html:openProactiveAssistance}}</button>`
}

// The user confirms a proposed follow-up before it becomes a goal.
async function adoptFollowUp(btn) {
  if (btn.disabled) return
  const message = (S.conv?.messages ?? []).find((entry) => entry.id === btn.dataset.message)
  const proposal = message?.followUp
  if (!proposal) return
  btn.disabled = true
  try {
    const body = { title: proposal.title, successCriteria: proposal.successCriteria }
    if (proposal.deadline) {
      body.deadline = proposal.deadline
      body.watch = { type: 'deadline' }
    }
    if (proposal.candidateLoopId) body.candidateLoopId = proposal.candidateLoopId
    const r = await api('commitments', { method: 'POST', body })
    btn.textContent = '{{msg:followUpStarted}}'
    btn.classList.add('done')
    toast(`{{msg:followUpStarted2}}${r.commitment?.title ?? proposal.title}`)
    const b = await api('bootstrap')
    S.boot = b
    renderConvs()
  } catch (err) {
    if (proposal.candidateLoopId && err.status === 409) {
      btn.textContent = '{{msg:alreadyFollowingUp}}'
      btn.classList.add('done')
      return
    }
    btn.disabled = false
    toast(`{{msg:couldNotStartFollowUp}}${err.message}`, true)
  }
}

function renderTail(node, m) {
  const tail = $('.tail', node)
  if (!tail) return
  const u = m.usage ?? {}
  const parts = []
  if (u.prompt_tokens || u.completion_tokens) {
    const cost = u.completion_tokens_details?.reasoning_tokens ? `{{msg:includingReasoning}} ${u.completion_tokens_details.reasoning_tokens}{{msg:closeParenthesis}}` : ''
    parts.push(`${u.prompt_tokens} {{msg:input}} ${u.completion_tokens} {{msg:output}}${cost}`)
  }
  if (m.model) parts.push(m.model)
  if (m.searchMode && m.searchMode !== 'off') {
    const searched = (m.tools ?? []).some((t) => t.name === 'web_search' || t.name === 'web_fetch')
    parts.push(searched ? '{{msg:usedWebSearch}}' : '{{msg:noWebSearch}}')
  }
  if (m.finishReason === 'length') parts.push('{{msg:lengthLimitReachedSayContinueToKeep}}')
  if (m.aborted) parts.push('{{msg:stopped}}')
  const drafts = new Map()
  for (const step of m.tools ?? []) {
    const draft = step.preparation
    if (step.name === 'follow_up_list' && step.ok === true && draft?.preparationId && draft.commitmentId) drafts.set(draft.preparationId, draft)
  }
  const draftLinks = [...drafts.values()].map((draft) => `<button type="button" class="btn small result-link" data-action="view-preparation" data-preparation-id="${esc(draft.preparationId)}" data-commitment-id="${esc(draft.commitmentId)}">{{html:openDraft}}${esc(draft.title || '{{msg:preparedWork}}')}{{msg:bookTitleEnd}}</button>`).join(' ')
  const hasRecall = m.id && Array.isArray(m.recalled) && m.recalled.length > 0
  tail.innerHTML = `${draftLinks}${parts.length ? `<div class="usage">${esc(parts.join(' · '))}</div>` : ''}${sourceHtml(m.sources)}${hasRecall ? `<details class="fold recalled-facts"><summary>{{html:memoryRetrievedForThisReply}} ${m.recalled.length} {{html:items}}</summary><div class="fold-body"></div></details>` : ''}`
  if (hasRecall) {
    const detail = $('.recalled-facts', tail)
    const conversationId = S.current
    detail.addEventListener('toggle', () => showRecalledFacts(detail, conversationId, m.id))
  }
}

async function showRecalledFacts(detail, conversationId, messageId) {
  const panel = $('.fold-body', detail)
  if (!detail.open) { panel.replaceChildren(); return }
  // Each opening gets its own status node so a late response cannot repopulate a closed or reopened panel.
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  status.textContent = '{{msg:checkingCurrentMemory}}'
  panel.replaceChildren(status)
  try {
    const { facts, unavailableCount } = await api(`conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/recalled-facts`)
    status.innerHTML = `${facts.length ? `<ul>${facts.map((fact) => `<li>${esc(fact.text)}</li>`).join('')}</ul>` : ''}${unavailableCount ? `<p class="muted small">${esc(unavailableCount)} {{html:memoriesHaveChangedOrAreUnavailable}}</p>` : ''}<button type="button" class="btn small ghost" data-action="open-panel" data-panel="memory">{{html:manageMemory}}</button>`
  } catch (error) {
    status.textContent = `{{msg:couldNotLoad}}${error.message}{{msg:collapseAndReopenToTryAgain}}`
  }
}

function sourceHtml(sources) {
  const list = (sources ?? []).filter((s) => /^https?:\/\//i.test(s?.url ?? '')).slice(0, 8)
  if (!list.length) return ''
  return `<div class="sources">${list
    .map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(s.title || host(s.url))}</a>`)
    .join('')}</div>`
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

function modelOptionsHtml(models, selected) {
  const groups = Object.create(null)
  for (const m of models) (groups[m.group ?? '{{msg:other}}'] ??= []).push(m)
  return Object.entries(groups)
    .map(
      ([g, list]) =>
        `<optgroup label="${esc(g)}">${list
          .map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.label)}${m.vision ? ' {{msg:vision}}' : ''}</option>`)
          .join('')}</optgroup>`,
    )
    .join('')
}

function imageGallery(images) {
  const list = (images ?? []).filter((i) => /^(\/api\/uploads\/|data:image\/)/.test(i?.url ?? ''))
  if (!list.length) return ''
  return `<div class="gallery">${list
    .map(
      (i) =>
        `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(i.url)}" alt="${esc(i.prompt ?? '{{msg:image}}')}" loading="lazy" /></a>`,
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
  if (S.brief && S.current === 'main') inner.prepend(briefCard(S.brief))
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
    <h3>${main ? '{{msg:whatWouldYouLikeToWorkOn}}' : '{{msg:startWithAnIdea}}'}</h3>
    <p>${
      main
        ? '{{msg:captureAThoughtOrganizeATaskOr}}'
        : '{{msg:writeDownWhatYouHaveSoFar}}'
    }</p>
    <div class="suggestions">
      ${['{{msg:helpMeOrganizeTodaySTasks}}', '{{msg:turnThisIdeaIntoANextStep}}', '{{msg:helpMeDraftAMessage}}', '{{msg:helpMeThinkThroughAProblem}}']
        .map((t) => `<button class="sug" data-action="sug">${esc(t)}</button>`)
        .join('')}
    </div><p class="suggestion-hint">{{html:chooseAStartingPointAndEditIt}}</p>`
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

function chatReady() {
  const cfg = S.boot?.config
  return cfg?.onboarding?.usable ?? (cfg?.upstreamConfigured === true)
}

function visibleWorkspaceMode() {
  if (!S.boot?.localTools || !S.current || S.conv?.id !== S.current) return undefined
  if (!S.boot.config.harness?.enabled && S.conv.workspaceMode !== 'read_only') return undefined
  return S.conv.workspaceMode === 'read_only' ? 'read_only' : 'work'
}

function updateComposer() {
  const cfg = S.boot?.config ?? {}
  const ready = chatReady()
  const drawing = Boolean(S.drawing && S.drawing === S.current)
  const busy = Boolean(S.stream || S.selecting || S.preparing || S.uploading || drawing)
  const mode = visibleWorkspaceMode()
  const modeSelect = $('#workspaceMode')
  modeSelect.hidden = !mode
  modeSelect.disabled = !mode || busy
  if (mode && !S.preparing) modeSelect.value = mode
  const text = $('#input').value.trim()
  $('#sendBtn').disabled = !S.current || !ready || busy || (!text && !S.att.length)
  $('#polishBtn').disabled = !ready || busy || !text || POLISH.running
  $('[data-action="attach"]').hidden = cfg.media?.imageInput === false
  const draw = $('[data-action="draw"]')
  draw.hidden = cfg.media?.imageOutput === false || !cfg.defaultImageModel
  draw.disabled = !cfg.upstreamConfigured || busy || Boolean(S.drawing)
  draw.textContent = drawing ? '{{msg:drawing}}' : '{{msg:draw}}'
  $('#connectionNotice').hidden = ready
  $('#connectionText').textContent = cfg.upstreamConfigured ? '{{msg:chooseADefaultModelInSetupYour}}' : '{{msg:connectYourModelToStartYouCan}}'
  $('#composerHint').textContent = matchMedia('(pointer: coarse)').matches
    ? '{{msg:enterForANewLineClickSend}}'
    : '{{msg:enterToSendShiftEnterForA}}'
  const draftState = S.uploading ? '{{msg:processingImage}}' : text || S.att.length
    ? `{{msg:draftSaved}}${S.att.length ? ' {{msg:imagesStayHereUntilThisPageCloses}}' : ''}` : ''
  if ($('#composerState').textContent !== draftState) $('#composerState').textContent = draftState
  const status = $('#replyStatus')
  status.hidden = !S.stream && !drawing && !S.selecting
  const replyState = S.selecting ? '{{msg:openingChat}}' : drawing ? '{{msg:generatingAnImageItWillBeSaved}}'
    : S.stream ? S.stream.status ?? '{{msg:echoIsPreparingAReply}}' : ''
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
        `<div class="thumb" title="${esc(a.name ?? '')}"><img src="${esc(a.dataUrl)}" alt="${esc(a.name || '{{msg:imagesToSend}}')}" /><button type="button" data-action="rm-att" data-i="${i}" aria-label="{{msg:remove}}{{msg:wordSpace}}${esc(a.name || '{{msg:image}}')}" title="{{html:remove2}}">×</button><span>${Math.round(a.bytes / 1024)}KB</span></div>`,
    )
    .join('')
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('{{msg:couldNotReadFile}}'))
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
      reject(new Error('{{msg:couldNotDecodeThisImage}}'))
    }
    im.src = url
  })
}

async function addFiles(files) {
  const media = S.boot?.config?.media ?? {}
  if (media.imageInput === false || !S.current) return toast('{{msg:imageInputIsOff}}', true)
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
          toast(`{{msg:imagesPerMessage}} ${max} {{msg:images}}`, true)
          break
        }
        attachments.push(image)
        S.attachmentDrafts.set(conversationId, attachments.slice())
      } catch (err) {
        toast(`{{msg:couldNotProcessImage}}${err.message}`, true)
      }
    }
  } finally {
    S.uploading--
    renderAttachments()
    autogrow()
  }
}

/* -------------------------------- setup wizard ---------------------------- */

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

const STEPS = ['{{msg:endpoint}}', '{{msg:models}}', '{{msg:memory}}', '{{msg:search}}', '{{msg:permissions}}', '{{msg:finish}}']

async function openWizard() {
  const cat = await api('providers')
  W.catalog = cat
  if (!W.open) W.returnFocus = document.activeElement
  W.open = true
  const config = S.boot?.config
  W.baseUrl = cat.onboarding.baseUrl || ''
  W.models = config?.models?.map((m) => m.id) ?? []
  W.discovered = false
  W.defaultModel = config?.defaultModel ?? ''
  W.utilityModel = config?.utilityModel ?? ''
  W.imageModel = config?.defaultImageModel ?? ''
  W.profile = cat.onboarding.profile || 'standard'
  W.order = (cat.onboarding.searchOrder ?? ['scrape', 'gateway']).filter((id) => id !== 'none')
  W.providerCfg = { ...config?.search?.providers }
  W.step = 0
  W.test = W.perms = W.permTest = null
  $('#wizard').hidden = false
  renderWizard()
  syncScrim()
}

function closeWizard() {
  W.open = false
  W.apiKey = W.password = ''
  W.keys = {}
  $('#wizard').hidden = true
  $('#wizard').replaceChildren()
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
    ${step === 0 ? languageSelector() : ''}
    <h2>${esc(STEPS[step])}</h2>
    <p class="sub">${['{{msg:step1ConnectYourModelProviderThe}}',
      '{{msg:step2ChooseTheDefaultModelFor}}',
      '{{msg:step3ChooseWhatEchoRemembersAnd}}',
      '{{msg:step4SetUpAnOptionalWeb}}',
      '{{msg:step5ReviewPermissionsAndStartupSettings}}',
      '{{msg:ready}}'][step]}</p>
    <div id="wBody"></div>
    <div class="wizard-foot">
      <span class="muted small">{{html:step}} ${step + 1} / ${STEPS.length} {{html:stepSuffix}}</span>
      <div class="right">
        ${step > 0 ? '<button class="btn" data-w="back">{{html:back}}</button>' : ''}
        <button class="btn ghost" data-w="skip">${step === 0 ? '{{msg:setUpLater}}' : '{{msg:skipForNow}}'}</button>
        <button class="btn primary" data-w="next">${step === STEPS.length - 1 ? '{{msg:finish}}' : '{{msg:continue}}'}</button>
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
  const preset = W.catalog.upstream.find((p) => p.baseUrl === W.baseUrl)?.baseUrl ?? ''
  const presets = W.catalog.upstream.map((p) => `<option value="${esc(p.baseUrl)}" ${p.baseUrl === preset ? 'selected' : ''}>${esc(p.label)}${p.baseUrl ? '' : '{{msg:wordSpace}}{{msg:enterManually}}'}</option>`).join('')
  const savedKey = W.catalog.onboarding.hasKey && W.baseUrl === W.catalog.onboarding.baseUrl
  return `
    <div class="field"><label for="wPreset">{{html:providerPreset}}</label><select id="wPreset">${presets}</select></div>
    <div class="field"><label for="wBase">{{html:endpointBaseUrlOpenaiCompatibleUsuallyEnding}}</label>
      <input type="text" id="wBase" placeholder="https://your-endpoint/v1" value="${esc(W.baseUrl)}" /></div>
    <div class="field"><label for="wKey">{{html:apiKeyStoredLocally}}</label>
      <input type="password" id="wKey" placeholder="${savedKey ? '{{msg:leaveBlankToKeepTheCurrentKey}}' : '{{msg:enterTheKeyForThisEndpoint}}'}" value="${esc(W.apiKey)}" /></div>
    <div class="row">
      <button class="btn small" data-w="test">{{html:testConnectionAndListModels}}</button>
      <span class="muted small" role="status" id="wTestOut">${W.test ? (W.test.ok ? `{{msg:found}} ${W.test.count} {{msg:modelIds}}` : `✗ ${esc(W.test.error ?? '')}`) : '{{msg:youCanContinueWithAKnownModel}}'}</span>
    </div>`
}

function stepModels() {
  return `
    <div class="field"><label for="wModel">{{html:defaultModelChooseOrEnterAnId}}</label>
      <input type="text" id="wModel" list="wModels" required placeholder="{{html:forExampleGpt4oMiniOrQwen}}" value="${esc(W.defaultModel)}" />
      <datalist id="wModels">${W.models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist></div>
    <div class="field"><label>{{html:backgroundModelForTitlesMemoryExtractionAnd}}</label>
      <input type="text" id="wUtility" placeholder="{{html:leaveBlankToUseTheDefaultModel}}" value="${esc(W.utilityModel)}" /></div>
    <div class="field"><label>{{html:imageGenerationModelOptional}}</label>
      <input type="text" id="wImage" placeholder="{{html:forExampleWan27ImageOrGpt}}" value="${esc(W.imageModel)}" /></div>
    <p class="muted small">{{html:youCanChangeTheseSettingsLaterAnd}}</p>`
}

function stepProfile() {
  return Object.entries(W.catalog.profiles)
    .map(([id, p]) => {
      const values = { off: '{{msg:noMemoryExtractionRecallRemindersOrScreen}}', light: '{{msg:extractAndRecallFactsNoMemoryReviews}}', standard: '{{msg:extractAndRecallFactsReviewMemoryRegularly}}', deep: '{{msg:standardMemoryPlusScreenAwarenessWithLocal}}' }[id]
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
      if (p.id === 'searxng') extra = `<input type="text" data-pcfg="searxng" placeholder="{{html:httpsYourSearxngInstanceRootUrl}}" value="${esc(conf.endpoint ?? '')}" style="margin-top:6px" />`
      if (p.id === 'custom') extra = `<input type="text" data-pcfg="custom" placeholder="https://your-search-api/endpoint" value="${esc(conf.endpoint ?? '')}" style="margin-top:6px" />`
      if (p.needsKey) extra = `<input type="password" data-pkey="${p.envVar}" placeholder="${esc(p.envVar)}{{msg:wordSpace}}{{msg:savedToTheLocalEchoEnvFile}}" value="${esc(keys?.[p.envVar] ?? '')}" style="margin-top:6px" />`
      return `<div class="chain-row">
        <input type="checkbox" data-order="${p.id}" ${idx >= 0 ? 'checked' : ''} />
        <span class="idx">${idx >= 0 ? idx + 1 : '·'}</span>
        <span style="flex:1">
          <b>${esc(p.label)}</b>
          <div class="why">${esc(p.note)}${p.ready ? '' : ` {{msg:unavailable}}${esc(p.reason)}`}</div>
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
    <p class="muted small" style="margin-top:0">{{html:selectedProvidersAreTriedInOrderIf}}</p>
    <div class="chain">${providerRows(W.order, W.providerCfg, W.keys)}</div>`
}

function stepPermissions() {
  const p = W.perms
  if (!p) return '<p class="muted small">{{html:checking}}</p>'
  const row = (ok, text) => `<div class="chain-row"><span class="idx">${ok ? '✓' : '!'}</span><span style="flex:1">${text}</span></div>`
  return `
    ${row(true, '{{msg:modelSettingsAreReadyChooseFinishTo}}')}
    ${row(p.runningUnderLaunchd, p.runningUnderLaunchd ? '{{msg:runningWithLaunchdAtLoginAndAfter}}' : '{{msg:startedManuallyRunInstallShToEnable}}')}
    ${row(p.tools.swiftc, p.tools.swiftc ? '{{msg:swiftcIsAvailableToBuildTheMenu}}' : '{{msg:installTheSwiftCompilerWithXcodeSelect}}')}
    ${row(true, `{{msg:listeningOn}}${esc(p.bind)} :${p.port}${p.lanUrl ? ` {{msg:sameNetwork}} ${esc(p.lanUrl)}` : ''}`)}
    ${row(p.authRequired, p.authRequired ? '{{msg:passwordProtectionIsOn}}' : '{{msg:passwordProtectionIsOff}}')}
    <div class="field" style="margin-top:12px"><label>{{html:screenRecordingPermissionForScreenAwareness}}</label>
      <div class="row"><button class="btn small" data-w="perm-test">{{html:testPermission}}</button>
      <span class="muted small" id="wPermOut">${W.permTest ? (W.permTest.granted ? '{{msg:screenRecordingPermissionGranted}}' : `✗ ${esc(W.permTest.hint)}`) : '{{msg:untested}}'}</span></div>
    </div>
    ${p.canSetInitialPassword ? `<div class="field"><label for="wPass">{{html:setAPasswordAndRequireSignIn}}</label>
      <input type="password" id="wPass" minlength="6" autocomplete="new-password" placeholder="{{html:atLeast6Characters}}" value="${esc(W.password)}" /></div>` : '<p class="muted small">{{html:manageYourPasswordInSettingsAccessOn}}</p>'}
    <p class="muted small">{{html:seeDocsPermissionsMdForDetailsAnd}}</p>`
}

function stepDone() {
  const searchText = W.order.length ? W.order.map((id) => W.catalog.search.find((p) => p.id === id)?.label ?? id).join(' → ') : '{{msg:webSearchOff}}'
  return `
    <div class="chain">
      <div class="chain-row"><span class="idx">1</span><span style="flex:1">{{html:endpoint2}}<b>${esc(W.baseUrl || '{{msg:useEnvironmentVariable}}')}</b></span></div>
      <div class="chain-row"><span class="idx">2</span><span style="flex:1">{{html:defaultModel}}<b>${esc(W.defaultModel || '{{msg:noneSelected}}')}</b>${W.utilityModel ? ` {{msg:background}}${esc(W.utilityModel)}` : ''}${W.imageModel ? ` {{msg:images2}}${esc(W.imageModel)}` : ''}</span></div>
      <div class="chain-row"><span class="idx">3</span><span style="flex:1">{{html:memoryProfile}}<b>${esc(W.catalog.profiles[W.profile]?.label ?? W.profile)}</b></span></div>
      <div class="chain-row"><span class="idx">4</span><span style="flex:1">{{html:searchProviders}}<b>${esc(searchText)}</b></span></div>
    </div>
    <p class="muted small" style="margin-top:12px">{{html:chooseFinishToSaveYourCredentialsTo}}</p>`
}

function bindWizard() {
  const el = $('#wizard')
  function syncEndpoint() {
    const baseUrl = $('#wBase').value.trim().replace(/\/+$/, '')
    if (baseUrl === W.baseUrl) return
    W.baseUrl = baseUrl
    W.test = null
    W.apiKey = $('#wKey').value = ''
    W.models = []
    W.discovered = false
    W.defaultModel = W.utilityModel = W.imageModel = ''
    $('#wTestOut').textContent = ''
  }
  el.querySelectorAll('[data-w]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.w
      if (act === 'back') { W.step = Math.max(0, W.step - 1); return renderWizard() }
      if (act === 'skip') { localStorage.setItem('echo.onboardSkipped', '1'); closeWizard(); return toast('{{msg:youCanRunSetupAgainFromSettings}}') }
      if (act === 'test') {
        syncEndpoint()
        W.apiKey = $('#wKey').value.trim()
        $('#wTestOut').textContent = '{{msg:testing}}'
        const pending = Symbol()
        W.test = pending
        const r = await api('onboarding/test', { method: 'POST', body: { baseUrl: W.baseUrl, apiKey: W.apiKey } })
          .catch((err) => ({ ok: false, error: err.message }))
        if (!W.open || W.step !== 0 || W.test !== pending) return
        W.test = r
        if (r.ok) {
          W.models = r.models
          W.discovered = true
          if (!W.defaultModel && r.models.length === 1) W.defaultModel = r.models[0]
        }
        return renderWizard()
      }
      if (act === 'perm-test') {
        $('#wPermOut').textContent = '{{msg:testingMacosMayRequestPermission}}'
        W.permTest = await api('permissions/screen-test', { method: 'POST', body: {} })
        return renderWizard()
      }
      if (act === 'next') {
        // Collect this step before moving on.
        if (W.step === 0) {
          syncEndpoint()
          W.apiKey = ($('#wKey')?.value ?? W.apiKey).trim()
          if (!W.baseUrl) return toast('{{msg:enterTheModelEndpointUrl}}', true)
          if ((!W.catalog.onboarding.hasKey || W.baseUrl !== W.catalog.onboarding.baseUrl) && !W.apiKey) return toast('{{msg:enterTheApiKeyForThisEndpoint}}', true)
        } else if (W.step === 1) {
          if ($('#wModel')?.reportValidity() === false) return
          W.defaultModel = ($('#wModel')?.value ?? '').trim()
          if (!W.defaultModel) return toast('{{msg:chooseOrEnterADefaultModel}}', true)
          W.utilityModel = ($('#wUtility')?.value ?? '').trim()
          W.imageModel = ($('#wImage')?.value ?? '').trim()
        } else if (W.step === 4) {
          if ($('#wPass')?.reportValidity() === false) return
          W.password = $('#wPass')?.value ?? ''
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
        btn.disabled = true
        const body = {
          baseUrl: W.baseUrl,
          apiKey: W.apiKey,
          ...(W.discovered ? { models: W.models } : {}),
          defaultModel: W.defaultModel,
          utilityModel: W.utilityModel,
          ...(W.imageModel !== (S.boot?.config?.defaultImageModel ?? '') || W.baseUrl !== W.catalog.onboarding.baseUrl ? {
            imageModels: W.imageModel ? [{ id: W.imageModel, label: W.imageModel, groupKind: 'image' }] : [],
            defaultImageModel: W.imageModel,
          } : {}),
          profile: W.profile,
          search: { order: W.order, providers: W.providerCfg },
          keys: W.keys,
          password: W.password,
        }
        try {
          await api('onboarding/complete', { method: 'POST', body })
          toast('{{msg:settingsSavedYouCanStartChatting}}')
          closeWizard()
          await boot({ keep: true })
        } catch (err) {
          btn.disabled = false
          toast(err.message, true)
        }
      }
    }),
  )
  el.querySelector('#wPreset')?.addEventListener('change', (e) => {
    $('#wBase').value = e.target.value
    syncEndpoint()
  })
  el.querySelector('#wBase')?.addEventListener('input', syncEndpoint)
  el.querySelector('#wKey')?.addEventListener('input', () => {
    W.test = null
    $('#wTestOut').textContent = ''
  })
  el.querySelectorAll('input[name="wProfile"]').forEach((r) =>
    r.addEventListener('change', () => {
      W.profile = r.value
      renderWizard()
    }),
  )
  el.querySelectorAll('[data-order]').forEach((cb) =>
    cb.addEventListener('change', () => {
      el.querySelectorAll('[data-pcfg]').forEach((i) => (W.providerCfg[i.dataset.pcfg] = { endpoint: i.value.trim() }))
      el.querySelectorAll('[data-pkey]').forEach((i) => (W.keys[i.dataset.pkey] = i.value.trim()))
      const id = cb.dataset.order
      const set = new Set(W.order)
      if (cb.checked) set.add(id)
      else set.delete(id)
      W.order = [...set]
      renderWizard()
    }),
  )
}

/* -------------------------------- request refinement --------------------- */

const POLISH = { mode: localStorage.getItem('echo.polishMode') ?? 'expand', modes: null, running: false, last: null }

async function runPolish({ mode } = {}) {
  const input = $('#input')
  const text = input.value.trim()
  if (!text) return toast('{{msg:enterAMessageFirst}}', true)
  if (!chatReady()) return toast('{{msg:finishModelSetupFirstYourDraftIs}}', true)
  if (POLISH.running) return
  if (mode) {
    POLISH.mode = mode
    localStorage.setItem('echo.polishMode', mode)
  }
  POLISH.running = true
  const btn = $('#polishBtn')
  const original = btn.textContent
  btn.textContent = '{{msg:refining}}'
  btn.disabled = true
  const conversationId = S.current
  try {
    const r = await api('polish', { method: 'POST', body: { text, mode: POLISH.mode, conversationId } })
    if (S.current !== conversationId || input.value.trim() !== text || S.stream) return
    POLISH.last = r
    if (!r.ok && r.error) toast(r.error, true)
    renderPolishBox()
  } catch (err) {
    toast(`{{msg:couldNotRefine}}${err.message}`, true)
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
      <span>{{html:refine}}{{msg:wordSpace}}${r.changed ? '' : '{{msg:yourOriginalWordingWasAlreadyClear}}'}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}</span>
      <div class="pill-group">${chips}</div>
    </div>
    <textarea id="polishText">${esc(r.polished ?? '')}</textarea>
    <div class="why">
      ${r.intent ? `<div><b>{{html:interpretedIntent}}</b>${esc(r.intent)}</div>` : ''}
      ${list(r.gaps, '{{msg:missingDetails}}')}
      ${list(r.assumptions, '{{msg:assumptionsYouCanChange}}')}
      ${r.notes ? `<div><b>{{html:notes}}</b>${esc(r.notes)}</div>` : ''}
    </div>
    <div class="acts">
      <span class="muted small">${esc((r.usage?.total_tokens ? `${r.usage.total_tokens} tokens · ` : '') + '{{msg:yourOriginalMessageStaysInTheComposer}}')}</span>
      <div class="right">
        <button type="button" class="btn small" data-pact="cancel">{{html:cancel}}</button>
        <button type="button" class="btn small" data-pact="retry">{{html:tryDifferentWording}}</button>
        <button type="button" class="btn small" data-pact="use">{{html:replaceComposerText}}</button>
        <button type="button" class="btn small primary" data-pact="send">{{html:sendNow}}</button>
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
      if (!text) return toast('{{msg:theRefinedMessageIsEmpty}}', true)
      if (act === 'use') {
        $('#input').value = text
        autogrow()
        localStorage.setItem(`echo.draft.${S.current}`, text)
        POLISH.last = null
        renderPolishBox()
        return toast('{{msg:composerUpdated}}')
      }
      if (act === 'send') {
        if (S.stream) return toast('{{msg:aReplyIsAlreadyBeingGenerated}}', true)
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
  if (S.stream || S.selecting || S.preparing || S.uploading || S.drawing === S.current) return toast('{{msg:pleaseWait}}', true)
  if (!chatReady()) return toast('{{msg:finishModelSetupFirstYourDraftIs}}', true)
  const conversationId = S.current
  const superseded = []
  if (editId) {
    const messages = $$('#threadInner .msg')
    const index = messages.findIndex((node) => node.dataset.id === editId)
    if (index >= 0) superseded.push(...messages.slice(index))
  } else if (regenerate) {
    const last = $$('#threadInner .msg.assistant').at(-1)
    if (last) superseded.push(last)
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
        workspaceMode: visibleWorkspaceMode(),
        editMessageId: editId,
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
      if (res.status === 409 && e.error === 'workspace_mode_changed') {
        st.modeChanged = true
        S.stream = null
        userNode?.remove()
        node.remove()
        if (S.conv?.id === conversationId && ['work', 'read_only'].includes(e.workspaceMode)) S.conv.workspaceMode = e.workspaceMode
        if (userText && !editId) $('#input').value = [userText, $('#input').value].filter(Boolean).join('\n\n')
        S.att = [...outgoing, ...S.att]
        renderAttachments()
        saveDraft()
        setBusy(false)
        autogrow()
        updateRegenerateButtons()
        toast(e.message ?? '{{msg:theWorkspaceModeChangedCheckItBefore}}', true)
        return
      }
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
          console.error('{{msg:couldNotRenderEvent}}', name, err)
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      st.error = err.message
      toast(err.message, true)
    }
  } finally {
    if (!st.modeChanged) await finishStream(st)
  }

  function handleEvent(name, d) {
    if (S.stream !== st) return
    switch (name) {
      case 'meta':
        superseded.forEach((previous) => previous.remove())
        node.dataset.id = d.messageId
        if (d.runId) st.runId = d.runId
        if (userNode && d.userMessageId) userNode.dataset.id = d.userMessageId
        break
      case 'reasoning':
        st.phase = '{{msg:consideringTheNextStep}}'
        st.status = '{{msg:echoIsThinking}}'
        updateComposer()
        st.reasoning += d.text
        openReasoning()
        break
      case 'delta':
        st.phase = '{{msg:preparingReply}}'
        if (st.status !== '{{msg:echoIsReplying}}') {
          st.status = '{{msg:echoIsReplying}}'
          updateComposer()
        }
        st.buffer += d.text
        paint()
        break
      case 'run_start':
        st.runId = d.runId
        if (!$('.run-link', node)) $('.meta', node).insertAdjacentHTML('afterend', `<button class="btn small run-link" data-action="view-run" data-id="${esc(d.runId)}">{{html:viewRun}}</button>`)
        break
      case 'tool_call':
        st.status = `{{msg:inProgress}}${d.label ?? d.name}…`
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
        st.status = '{{msg:approveDenyOrStopThisAction}}'
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
        if (st.status !== '{{msg:runningTool}}') {
          st.status = '{{msg:runningTool}}'
          updateComposer()
        }
        renderStepsInto(stepsHost.tools)
        break
      }
      case 'tool_result': {
        st.phase = '{{msg:reviewingResultsAndPreparingTheNextStep}}'
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
        if (d.status && d.status !== 'completed') st.notices.push(`{{msg:run}}{{msg:wordSpace}}${RUN_STATUS[d.status] ?? d.status}`)
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
    el.innerHTML = `<summary>{{html:thinking2}}</summary><div class="fold-body"></div>`
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
    if (!d && !st.error && !st.ctrl.signal.aborted) st.error = '{{msg:connectionLostTheReplyMayBeIncomplete2}}'
    st.contentEl.innerHTML = md(finalText) + (st.error ? `<div class="err" role="alert">${esc(st.error)}</div>` : '')
    if (!finalText.trim() && !st.error) st.contentEl.innerHTML = `<p class="muted">${confirmedCancelled ? '{{msg:generationStopped}}' : st.ctrl.signal.aborted ? '{{msg:connectionLostCheckTheRunRecordFor}}' : '{{msg:noContent}}'}</p>`
    if (st.reasoning) {
      const el = $('details.reasoning', node)
      if (el) {
        el.open = false
        el.querySelector('summary').textContent = `{{msg:reasoning}} ${st.reasoning.length} {{msg:characters}}`
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
    try { await refreshList() } catch (err) { toast(`{{msg:couldNotRefreshChatList}}${err.message}`, true) }
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
  $('#sendBtn').textContent = busy ? '{{msg:generating}}' : '{{msg:send}}'
  document.body.classList.toggle('busy', busy)
  updateComposer()
}

async function stopReply() {
  const stream = S.stream
  if (!stream || stream.stopping) return
  stream.stopping = true
  const previousStatus = stream.status
  stream.status = '{{msg:requestingStop}}'
  updateComposer()
  try {
    const result = await api('chat/stop', { method: 'POST', body: { conversationId: stream.conversationId } })
    stream.stopRequested = result.stopped === true
    stream.ctrl.abort()
  } catch (err) {
    stream.stopping = false
    stream.status = previousStatus
    if (S.stream === stream) updateComposer()
    toast(`{{msg:couldNotStop}}${err.message}{{msg:youCanRetry}}`, true)
  }
}

/* --------------------------------- panels ---------------------------------- */

async function openPanel(name) {
  clearReminderPreview()
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
  badge.textContent = config.enabled ? `{{msg:workspace2}} ${config.allowShell ? '{{msg:commands}}' : config.allowWrites ? '{{msg:readAndWrite}}' : '{{msg:readOnly}}'}` : '{{msg:workspaceOff}}'
  badge.classList.toggle('on', Boolean(config.enabled))
  badge.title = config.enabled ? `${config.workspaceRoot || '{{msg:workspace}}'} {{msg:viewPermissionsAndRunHistory}}` : '{{msg:setWorkspacePermissionsAndReviewRuns}}'
}

function approvalHtml(runId, step) {
  const approval = step.approval
  if (!approval || !['pending', 'awaiting_approval', undefined].includes(approval.status)) return ''
  return `<section class="tool-approval" data-approval-id="${esc(approval.id)}" data-call-id="${esc(step.id)}" aria-label="{{html:reviewToolAction}}">
    <strong>{{html:approvalNeeded}} ${esc(step.name ?? '{{msg:workspaceAction}}')}</strong>
    <p>${esc(approval.summary || '{{msg:reviewTheFullInputForThisAction}}')}</p>
    ${step.workspaceRoot ? `<p class="muted small">{{html:projectDirectory}}${esc(step.workspaceRoot)}</p>` : ''}
    <pre class="run-code">${esc(toolText(approval.args ?? step.args))}</pre>
    <p class="muted small">{{html:approvalAppliesToThisActionOnly}}{{msg:wordSpace}}${step.name === 'shell_exec' ? '{{msg:shellCommandsRunWithThePrivilegesOf}}' : '{{msg:thisToolUsesThePermissionsConfiguredFor}}'}</p>
    <div class="row"><button class="btn small primary" data-action="run-approval" data-run-id="${esc(runId)}" data-approval-id="${esc(approval.id)}" data-decision="approve">{{html:approveOnce}}</button>
    <button class="btn small" data-action="run-approval" data-run-id="${esc(runId)}" data-approval-id="${esc(approval.id)}" data-decision="deny">{{html:deny}}</button></div>
    <p class="approval-status small" role="status"></p></section>`
}

function settleApproval(id, status) {
  $$('[data-approval-id].tool-approval').filter((card) => card.dataset.approvalId === id && !card.dataset.settled).forEach((card) => {
    card.dataset.settled = 'true'
    $$('button', card).forEach((button) => { button.disabled = true })
    $('.approval-status', card).textContent = card.dataset.decision === 'deny' ? '{{msg:actionDenied}}' : RUN_STATUS[status] ?? status
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
    $('.approval-status', card).textContent = '{{msg:submitting}}'
  })
  try {
    await api(`runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: { decision } })
    cards.forEach((card) => {
      card.dataset.decision = decision
      if (!card.dataset.settled) $('.approval-status', card).textContent = decision === 'approve' ? '{{msg:approvedWaitingForTheResult}}' : '{{msg:actionDenied}}'
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
  updateComposer()
  // Only opening the panel rebuilds its form; background polling updates the runs below.
  panel.innerHTML = `<section class="sect"><h3>{{html:workspaceTools}}</h3>
    <p class="muted small">{{html:letEchoReadAProjectEditFiles}}</p>
    ${!WORKSPACE.local ? '<p class="notice">{{html:openEchoOnTheHostMacTo}}</p>' : ''}
    <form id="workspaceForm"><fieldset class="workspace-fields" ${!WORKSPACE.local ? 'disabled' : ''}>
      <label class="switch" for="workspaceEnabled">{{html:enableWorkspaceTools}}<input id="workspaceEnabled" name="enabled" type="checkbox" ${config.enabled ? 'checked' : ''} /></label>
      <div class="field"><label for="workspaceRoot">{{html:projectDirectoryAbsolutePath}}</label><input id="workspaceRoot" name="workspaceRoot" type="text" placeholder="/Users/you/projects/my-project" value="${esc(config.workspaceRoot)}" autocomplete="off" spellcheck="false" /></div>
      <label class="switch" for="workspaceWrites">{{html:allowFileEdits}}<input id="workspaceWrites" name="allowWrites" type="checkbox" ${config.allowWrites ? 'checked' : ''} /></label>
      <label class="switch" for="workspaceShell">{{html:allowCommandRequests}}<input id="workspaceShell" name="allowShell" type="checkbox" ${config.allowShell ? 'checked' : ''} /></label>
      <p class="muted small">{{html:fileToolsStayWithinThisDirectoryEnabling}}</p>
      <div class="workspace-limits"><div class="field"><label for="workspaceRounds">{{html:maximumToolRounds}}</label><input id="workspaceRounds" name="maxToolRounds" type="number" min="1" max="24" value="${esc(config.maxToolRounds ?? 12)}" required /></div>
      <div class="field"><label for="workspaceTimeout">{{html:commandTimeoutSeconds}}</label><input id="workspaceTimeout" name="timeout" type="number" min="1" max="120" value="${esc((config.shellTimeoutMs ?? 60000) / 1000)}" required /></div></div>
      <button class="btn small primary" type="submit">{{html:saveWorkspacePermissions}}</button>
    </fieldset><p id="workspaceStatus" class="small" role="status"></p></form></section>
    <section class="sect"><div class="row"><h3>{{html:runsInThisChat}}</h3><button class="btn small right" data-action="refresh-runs" ${!WORKSPACE.local ? 'disabled' : ''}>{{html:refresh}}</button></div>
      <p class="muted small">{{html:viewingARecordDoesNotRerunIts}}</p>
      <div id="runList" class="list"></div><p id="runListStatus" class="small" role="status"></p>
    </section><section id="runInspector" class="run-inspector" tabindex="-1" aria-label="{{html:runDetails}}"></section>`
  if (!WORKSPACE.local) {
    $('#runList').innerHTML = '<p class="muted small">{{html:runRecordsAndOutputsAreAvailableOn}}</p>'
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
  if (config.enabled && !config.workspaceRoot) { status.textContent = '{{msg:enterTheProjectDirectoryFirst}}'; $('#workspaceRoot').focus(); return }
  form.dataset.saving = 'true'
  const submit = $('button[type="submit"]', form)
  submit.disabled = true
  status.textContent = '{{msg:saving}}'
  try {
    const result = await api('harness', { method: 'PATCH', body: { config } })
    WORKSPACE.config = result.config ?? config
    if (S.boot?.config) S.boot.config.harness = WORKSPACE.config
    updateWorkspaceBadge()
    updateComposer()
    status.textContent = '{{msg:savedTheNextTurnWillUseThese}}'
  } catch (err) {
    status.textContent = err.message
  } finally {
    delete form.dataset.saving
    submit.disabled = false
  }
}

function runReviewHtml(run) {
  if (!WORKSPACE.local) return ''
  const files = [], commands = []
  for (const step of run.steps ?? []) {
    if (['workspace_write', 'workspace_edit'].includes(step.name) && step.changes?.length) {
      const changes = step.changes.map((change) => `${change.before === null ? '{{msg:created}}' : '{{msg:modified}}'} <code>${esc(change.path)}</code>`)
      const snapshots = (step.artifacts ?? []).filter((a) => /\.(before|after)\.txt$/.test(a.name))
        .map((a) => ({ ...a, name: a.name.endsWith('.before.txt') ? '{{msg:before}}' : '{{msg:after}}' }))
      files.push(`<li>${changes.join('{{msg:listSeparator}}')}<div>${artifactLinks(snapshots)}</div></li>`)
    }
    if (step.name !== 'shell_exec') continue
    const result = parseToolOutput(step.result)
    const command = step.args?.command ?? result?.command
    const cwd = result?.cwd ?? step.args?.cwd ?? (step.args ? '.' : '{{msg:unrecorded}}')
    const exit = step.exitCode ?? result?.exitCode
    const reason = step.terminationReason ?? result?.reason
    const signal = step.exitSignal ?? result?.signal
    const reasonLabels = { timeout: '{{msg:commandTimedOut}}', output_limit: '{{msg:outputLimitReached}}', cancelled: '{{msg:stopped}}', output_error: '{{msg:couldNotSaveOutput}}', process_error: '{{msg:processError}}' }
    const details = [toolStatus(step), exit != null ? `{{msg:exitCode2}} ${exit}` : '', reasonLabels[reason] ?? reason, signal,
      step.args?.timeoutMs != null ? `{{msg:requestTimedOut}} ${step.args.timeoutMs} ms` : ''].filter(Boolean)
    const error = step.error || result?.error || (step.status === 'failed' && result?.stderr)
    const logs = (step.artifacts ?? []).filter((a) => ['stdout.txt', 'stderr.txt'].includes(a.name))
    commands.push(`<li><pre class="run-code">${esc(command ?? '{{msg:commandUnavailable}}')}</pre><p class="muted small">{{html:directory}} <code>${esc(cwd)}</code> · ${esc(details.join(' · '))}</p>
      ${error ? `<pre class="run-code err">${esc(String(error).length > 1000 ? '…' + String(error).slice(-1000) : error)}</pre>` : ''}${artifactLinks(logs)}</li>`)
  }
  if (!files.length && !commands.length) return ''
  return `<section class="run-review" aria-label="{{html:workspaceResults}}"><h3>{{html:workspaceResults}}</h3>
    ${files.length ? `<h4>{{html:changesRecordedByFileTools}}</h4><ul>${files.join('')}</ul>` : ''}
    <h4>{{html:shellCommands}}</h4>${commands.length ? `<ol>${commands.join('')}</ol>` : '<p class="muted small">{{html:noShellCommandsWereRecordedForThis}}</p>'}</section>`
}

function runStepHtml(runId, step, workspaceRoot) {
  const output = step.approval?.status === 'denied' ? '{{msg:actionDeniedBeforeExecution}}' : toolOutputText(step.result === '' ? step.output : step.result ?? step.output)
  return `<details class="run-step" data-step-id="${esc(step.id)}" ${step.status === 'awaiting_approval' ? 'open' : ''}><summary>${esc(step.name || '{{msg:tool}}')} <span class="muted small">${esc(toolStatus(step))}${step.ms != null ? ` · ${esc(step.ms)} ms` : ''}${step.exitCode != null ? ` {{msg:exitCode}} ${esc(step.exitCode)}` : ''}</span></summary>
    <h4>{{html:fullInput}}</h4><pre class="run-code">${esc(toolText(step.args))}</pre>
    ${approvalHtml(runId, { ...step, workspaceRoot })}
    ${output ? `<h4>{{html:output2}}{{msg:wordSpace}}${output.length > 12000 ? '{{msg:last12000Characters}}' : ''}</h4><pre class="run-code">${esc(output.slice(-12000))}</pre>` : ''}
    ${step.truncated ? '<p class="muted small">{{html:theRecordReachedItsOutputLimitAnd}}</p>' : ''}
    ${artifactLinks(step.artifacts)}
    ${(step.changes ?? []).length ? `<p class="small">{{html:changed}}${step.changes.map((change) => esc(change.path)).join('{{msg:listSeparator}}')}{{html:downloadTheBeforeAndAfterSnapshotsAbove}}</p>` : ''}
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
      list.innerHTML = runs.map((run) => `<button class="run-row" data-action="view-run" data-id="${esc(run.id)}" aria-pressed="${WORKSPACE.selected === run.id}"><span>${esc(fmtTime(run.startedAt))} · ${esc(RUN_STATUS[run.status] ?? run.status)}</span><span class="muted small">${Array.isArray(run.steps) ? run.steps.length : run.stepCount ?? 0} {{msg:steps}}${run.workspaceRoot ? ` · ${esc(run.workspaceRoot)}` : ''}</span></button>`).join('') || '<p class="muted small">{{html:noRunsYetEnableTheWorkspaceAnd}}</p>'
      list.dataset.key = key
      if (focusedId) $$('[data-action="view-run"]', list).find((button) => button.dataset.id === focusedId)?.focus()
    }
    $('#runListStatus').textContent = ''
    if (WORKSPACE.selected) await inspectRun(WORKSPACE.selected, { poll: !force })
  } catch (err) {
    $('#runListStatus').textContent = `{{msg:couldNotLoadTheRecord}}${err.message}`
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
  inspector.innerHTML = `<h3>{{html:runDetails}}</h3>
    <div class="run-feedback" data-state="${esc(run.status)}"><div class="run-feedback-body" role="status" aria-live="polite" aria-atomic="true">${runFeedbackHtml(run)}</div></div>
    <p class="muted small">${esc(run.workspaceRoot ?? '')}${run.workspaceMode === 'read_only' ? ' {{msg:readOnlyPlan}}' : run.workspaceMode === 'work' && run.workspaceRoot ? ' {{msg:work}}' : ''}<br />${esc(fmtTime(run.startedAt))}${run.finishedAt ? ` → ${esc(fmtTime(run.finishedAt))}` : ''}</p>
    ${runReviewHtml(run)}
    ${(run.steps ?? []).map((step) => runStepHtml(id, step, run.workspaceRoot)).join('') || '<p class="muted small">{{html:noToolsCalled2}}</p>'}
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
  clearReminderPreview()
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
  if (!$('#memoryContents', panel)) panel.innerHTML = `<details id="relationshipSection" class="fold relationship-section"><summary>{{html:interactionPreferences}} <span class="muted small">{{html:howEchoResponds}}</span></summary><div id="relationshipBody" class="fold-body"><p class="muted small" role="status">{{html:expandToLoad}}</p></div></details><div id="memoryContents" class="memory-contents"></div>`
  const el = $('#memoryContents', panel)
  const f = mem.stats.forgetting ?? {}
  el.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${mem.stats.observations}</b><span>{{html:activeFacts}}</span></div>
      <div class="stat"><b>${f.avgStrength ?? 0}</b><span>{{html:averageStrength}}</span></div>
      <div class="stat"><b>${f.faded ?? 0}</b><span>{{html:faded2}}</span></div>
      <div class="stat"><b>${f.fadingSoon ?? 0}</b><span>{{html:nearFading}}</span></div>
    </div>
    <p class="muted small">{{html:memoryStrengthCombinesImportanceUseAndAge}}</p>

    ${screen.screen.enabled ? screenBlock(screen) : ''}

    <div class="sect">
      <h4>{{html:coreMemoryMemoryMd}} <span class="muted">{{html:includedInEachChat}}</span></h4>
      <textarea id="coreEdit" class="core-editor">${esc(mem.core)}</textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn small primary" data-action="save-core">{{html:save}}</button>
        <button class="btn small" data-action="dream-now">{{html:reviewMemoryNow}}</button>
        <span class="muted small">{{html:lastReview}}${dream.last ? ago(dream.last) : '{{msg:neverRun}}'}</span>
      </div>
    </div>

    <div class="sect">
      <h4>{{html:followUpItems}}</h4>
      <div class="list">${
        dream.loops.length
          ? dream.loops
              .map(
                (l) => `<div class="loop"><div class="row"><b>${esc(l.topic)}</b>${l.due ? `<span class="due">{{html:due}} ${esc(l.due)}</span>` : ''}
                  <button class="btn small right" data-action="adopt-loop" data-id="${esc(l.id)}">{{html:startFollowingUp}}</button>
                  <button class="btn small ghost" data-action="loop-done" data-id="${esc(l.id)}">{{html:stopTracking}}</button></div>
                  <div class="muted small">${esc(l.why ?? '')}${l.raised ? ` {{msg:mentioned}} ${l.raised} {{msg:times}}` : ''}${l.ageDays != null ? ` · ${esc(String(l.ageDays))} {{msg:daysAgo3}}` : ''}</div></div>`,
              )
              .join('')
          : '<div class="muted small">{{html:noItemsToFollowUpFromMemory}}</div>'
      }</div>
    </div>

    <div class="sect">
      <h4>{{html:facts}} <span class="muted small">{{html:recallStrengthensFacts}}</span></h4>
      <div class="filter" style="margin-bottom:8px"><svg viewBox="0 0 24 24" class="i"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input id="memFilter" type="search" placeholder="{{html:filterFacts}}" /></div>
      <div class="list" id="memList">${mem.observations.map(obsHtml).join('') || '<div class="muted small">{{html:noFactsYetAskEchoToRemember}}</div>'}</div>
      <div class="row" style="margin-top:10px">
        <input id="newMem" type="text" placeholder="{{html:addAFactManually}}" style="flex:1;border:1px solid var(--border-strong);border-radius:9px;padding:8px 10px;background:var(--panel-2)" />
        <button class="btn small primary" data-action="add-mem">{{html:add}}</button>
      </div>
    </div>

    <div class="sect">
      <h4>{{html:forgottenOrFaded}}${(forgetting.items ?? []).length}{{msg:closeParenthesis}}</h4>
      <p class="muted small">{{html:reviewFactsThatHaveFadedOrBeen}}</p>
      <div class="list">${
        (forgetting.items ?? []).length
          ? forgetting.items
              .map(
                (o) => `<div class="mem-item ${o.status === 'deleted' ? 'gone' : ''}">
                  <div class="txt">${esc(o.text)}
                    <div class="muted small">${o.status === 'faded' ? '{{msg:faded}}' : '{{msg:forgotten}}'} · ${esc(o.reason)} {{msg:importance}} ${o.importance} {{msg:matches}} ${o.hits} {{msg:times}}${o.strength != null ? ` {{msg:strength}} ${o.strength}` : ''}</div>
                  </div>
                  <button class="btn small ghost" data-action="revive" data-id="${esc(o.id)}">{{html:restore}}</button>
                </div>`,
              )
              .join('')
          : '<div class="muted small">{{html:nothingForgottenYet}}</div>'
      }</div>
      <details class="fold" style="margin-top:8px"><summary>{{html:forgettingLog}}</summary>
        <div class="fold-body">${(forgetting.log ?? []).map((b) => `<pre style="white-space:pre-wrap;font:11.5px/1.6 var(--mono)">${esc(b)}</pre>`).join('') || '<span class="muted">{{html:empty2}}</span>'}</div>
      </details>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="forget-scan">{{html:previewAForgettingScan}}</button></div>
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
  body.innerHTML = '<p class="muted small" role="status">{{html:loading}}</p>'
  try {
    const data = await api('relationships')
    if (version !== RELATIONSHIPS.version || body !== $('#relationshipBody')) return
    RELATIONSHIPS.data = data
    body.innerHTML = relationshipProfileHtml(data.profile ?? {})
    body.dataset.loaded = 'true'
    renderRelationshipPeople()
  } catch (err) {
    if (version !== RELATIONSHIPS.version || body !== $('#relationshipBody')) return
    body.innerHTML = `<p class="small" role="status">${esc(err.message)}</p><button class="btn small" data-action="relationship-retry">{{html:reload}}</button>`
  } finally {
    if (version === RELATIONSHIPS.version) RELATIONSHIPS.loading = false
  }
}

function relationshipProfileHtml(profile) {
  return `<p class="muted small">{{html:chooseHowEchoRespondsYouControlThe}}</p>
    <p id="relationshipAvailability" class="muted small" ${S.boot?.config?.memory?.enabled === false || S.boot?.config?.memory?.inject === false ? '' : 'hidden'}>{{html:memoryRecallIsOffThesePreferencesAnd}}</p>
    <form id="relationshipProfileForm">
      <label class="switch" for="relationshipEnabled">{{html:useThesePreferencesInChat}}<input id="relationshipEnabled" name="enabled" type="checkbox" ${profile.enabled !== false ? 'checked' : ''} /></label>
      <div class="relationship-options">
        <div class="field"><label for="relationshipTone">{{html:responseStyle}}</label><select id="relationshipTone" name="tone">${[['subtle', '{{msg:neutralAndRestrained}}'], ['warm', '{{msg:aLittleWarmer}}'], ['direct', '{{msg:briefAndDirect}}']].map(([value, label]) => `<option value="${value}" ${(profile.tone ?? 'subtle') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="field"><label for="relationshipSupport">{{html:whenSomethingIsDifficult}}</label><select id="relationshipSupport" name="support">${[['balanced', '{{msg:followTheSituation}}'], ['listen', '{{msg:listenFirst}}'], ['practical', '{{msg:helpSolveItFirst}}']].map(([value, label]) => `<option value="${value}" ${(profile.support ?? 'balanced') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      </div>
      <details class="relationship-more"><summary>{{html:nameAndBoundariesOptional}}</summary>
        <div class="field"><label for="relationshipName">{{html:whatShouldEchoCallYou}}</label><input id="relationshipName" name="preferredName" type="text" maxlength="80" value="${esc(profile.preferredName)}" autocomplete="off" /></div>
        <div class="field"><label for="relationshipBoundaries">{{html:whatShouldEchoKeepInMind}}</label><textarea id="relationshipBoundaries" name="boundaries" maxlength="600" placeholder="{{html:forExampleBeDirectInWorkDiscussions}}">${esc(profile.boundaries)}</textarea></div>
      </details>
      <p class="muted small">{{html:turningThisOffKeepsTheSavedSettings}}</p>
      <button class="btn small primary" type="submit">{{html:savePreferences}}</button><p class="relationship-status small" role="status"></p>
    </form>
    <div class="relationship-people"><div class="row"><h4>{{html:people}} <span id="relationshipPeopleCount" class="muted"></span></h4><button class="btn small right" data-action="relationship-new">{{html:addPerson}}</button></div>
      <p class="muted small">{{html:saveOnlyTheBackgroundYouNeedYou}}</p><div id="relationshipPeople" class="list"></div><div id="relationshipEditor"></div></div>`
}

function updateRelationshipAvailability() {
  const notice = $('#relationshipAvailability')
  if (notice) notice.hidden = S.boot?.config?.memory?.enabled !== false && S.boot?.config?.memory?.inject !== false
}

function relationshipPersonHtml(person) {
  return `<div class="mem-item relationship-person" data-person-id="${esc(person.id)}"><div class="txt"><b>${esc(person.name)}</b>${person.relationship ? `<span class="muted small"> · ${esc(person.relationship)}</span>` : ''}
    ${person.aliases?.length ? `<p class="muted small">{{html:alsoKnownAs}}${person.aliases.map(esc).join('{{msg:listSeparator}}')}</p>` : ''}
    ${person.context || person.boundaries ? `<details class="relationship-more"><summary>{{html:viewBackground}}</summary>${person.context ? `<p class="relationship-text small">${esc(person.context)}</p>` : ''}${person.boundaries ? `<p class="relationship-text muted small">{{html:note}}${esc(person.boundaries)}</p>` : ''}</details>` : ''}
    <div class="row"><button class="btn small ghost" data-action="relationship-edit" data-id="${esc(person.id)}">{{html:edit}}</button><button class="btn small ghost" data-action="relationship-delete" data-id="${esc(person.id)}">{{html:delete}}</button></div>
    <div class="relationship-delete-confirm" hidden><p class="small">{{html:removingThisNoteStopsFutureUseExisting}}</p><div class="row"><button class="btn small" data-action="relationship-delete-confirm" data-id="${esc(person.id)}">{{html:confirmRemoval}}</button><button class="btn small ghost" data-action="relationship-delete-cancel">{{html:keep}}</button></div></div>
    <p class="relationship-status small" role="status"></p></div></div>`
}

function renderRelationshipPeople() {
  const people = RELATIONSHIPS.data?.people ?? []
  $('#relationshipPeople').innerHTML = people.map(relationshipPersonHtml).join('') || '<p class="muted small">{{html:noPeopleAddedYet}}</p>'
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
    <h4>${id ? '{{msg:editPerson}}' : '{{msg:addPerson}}'}</h4>
    <div class="field"><label for="relationshipPersonName">{{html:nameOrNickname}}</label><input id="relationshipPersonName" name="name" type="text" minlength="2" maxlength="80" required value="${esc(person.name)}" autocomplete="off" /></div>
    <div class="field"><label for="relationshipPersonRole">{{html:relationshipOptional}}</label><input id="relationshipPersonRole" name="relationship" type="text" maxlength="120" value="${esc(person.relationship)}" placeholder="{{html:forExampleColleagueFriendOrMentor}}" /></div>
    <div class="field"><label for="relationshipPersonContext">{{html:relevantBackgroundOptional}}</label><textarea id="relationshipPersonContext" name="context" maxlength="1200" placeholder="{{html:forExampleWeWorkOnAProject}}">${esc(person.context)}</textarea></div>
    <details class="relationship-more" ${person.aliases?.length || person.boundaries ? 'open' : ''}><summary>{{html:otherNamesAndBoundariesOptional}}</summary>
      <div class="field"><label for="relationshipPersonAliases">{{html:otherNamesCommaSeparatedUpTo5}}</label><input id="relationshipPersonAliases" name="aliases" type="text" maxlength="404" value="${esc((person.aliases ?? []).join(', '))}" /></div>
      <div class="field"><label for="relationshipPersonBoundaries">{{html:whatToKeepInMindAboutThis}}</label><textarea id="relationshipPersonBoundaries" name="boundaries" maxlength="600" placeholder="{{html:forExampleDiscussHowToCommunicateWithout}}">${esc(person.boundaries)}</textarea></div>
    </details>
    <div class="row"><button class="btn small primary" type="submit">${id ? '{{msg:saveChanges}}' : '{{msg:addPerson2}}'}</button><button class="btn small" type="button" data-action="relationship-editor-cancel">{{html:cancel}}</button></div><p class="relationship-status small" role="status"></p></form>`
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
  if (person && (body.aliases.length > 5 || body.aliases.some((alias) => alias.length < 2 || alias.length > 80))) { status.textContent = '{{msg:enterUpToFiveAliasesEach2}}'; return }
  const id = form.dataset.id, version = RELATIONSHIPS.version
  const focused = form.contains(document.activeElement) ? document.activeElement : null
  form.dataset.saving = 'true'
  $$('input, textarea, select, button', form).forEach((control) => { control.disabled = true })
  status.textContent = '{{msg:saving}}'
  try {
    const result = await api(person ? `relationships/people${id ? `/${encodeURIComponent(id)}` : ''}` : 'relationships/profile', { method: person && !id ? 'POST' : 'PATCH', body })
    if (version !== RELATIONSHIPS.version) return
    if (person) {
      RELATIONSHIPS.data.people = id ? RELATIONSHIPS.data.people.map((item) => item.id === id ? result.person : item) : [...RELATIONSHIPS.data.people, result.person]
      renderRelationshipPeople()
      closeRelationshipEditor(result.person.id)
    } else {
      RELATIONSHIPS.data.profile = result.profile ?? body
      status.textContent = body.enabled ? '{{msg:saved}}' : '{{msg:turnedOffSavedItemsCanStillBe}}'
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
  status.textContent = '{{msg:removing}}'
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
  return `<div class="sect" data-screen-capture="${s.captureRequested ? 'pending' : 'ready'}">
    <h4>{{html:currentActivity}} <span class="muted small">· ${s.mode === 'image' ? '{{msg:screenshotsSentToModel}}' : '{{msg:localOcr}}'}{{html:temporaryImagesAreDeletedAfterProcessing}}</span></h4>
    ${s.lastAt ? `<div class="muted small">${s.lastOk === false ? '{{msg:lastCaptureDidNotFinish}}' : '{{msg:lastCapture}}'} ${ago(s.lastAt)} {{msg:today}} ${s.todayCount} {{msg:capturesWorkingMemory}} ${s.workingCount} {{html:items}}</div>` : '<div class="muted small">{{html:noScreenActivityYetTryCaptureNow}}</div>'}
    <div class="muted small" role="status">${s.captureRequested ? '{{msg:waitingForTheMenuBarAppTo}}' : s.captureExpired ? '{{msg:requestExpiredCheckThatTheMenuBar}}' : s.permissionMissing ? '{{msg:grantTheMenuBarAppScreenRecording}}' : ''}</div>
    <div class="list" style="margin-top:8px">${ev
      .map(
        (e) => `<div class="mem-item"><div class="txt">${esc(e.activity || '{{msg:unknown}}')}
          <div class="muted small">${String(e.ts).slice(11, 16)} · ${esc(e.app || '?')} · ${esc(FOCUS_LABEL[e.focus] ?? e.focus)}${e.sensitive ? ' {{msg:sensitiveDetailsHidden}}' : ''}</div></div></div>`,
      )
      .join('')}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-action="look-now" ${s.captureRequested ? 'disabled' : ''}>{{html:captureNow}}</button>
      <button class="btn small" data-action="screen-digest">{{html:saveToMemory}}</button>
      <span class="muted small">{{html:storageScreenshots}} ${st.screenshots.mb}MB / ${st.screenshots.budgetMB}{{msg:mbImages}} ${st.uploads.mb}MB / ${st.uploads.budgetMB}MB</span>
    </div>
  </div>`
}

function obsHtml(o) {
  const gone = o.status !== 'active'
  const strength = o.strength ?? null
  return `<div class="mem-item ${gone ? 'gone' : ''}" data-id="${esc(o.id)}">
    <div class="txt">${o.protected ? '📌 ' : ''}${esc(o.text)}
      <div class="muted small">${esc(FACT_LABEL[o.kind] ?? o.kind)} {{msg:importance}} ${o.importance}${strength != null ? ` {{msg:strength}} ${strength}` : ''} {{msg:matches}} ${o.hits ?? 1} {{msg:times2}} ${String(o.created_at ?? '').slice(0, 10)}${o.source ? ` · ${esc(o.source)}` : ''}</div>
    </div>
    ${gone
      ? '<span class="tag">{{html:faded2}}</span>'
      : `<button class="btn small ghost" data-action="protect-mem" data-id="${esc(o.id)}" data-on="${o.protected ? '0' : '1'}" title="{{html:protectFromFading}}">${o.protected ? '{{msg:unprotect}}' : '{{msg:protect}}'}</button>
         <button class="btn small ghost" data-action="forget-mem" data-id="${esc(o.id)}" title="{{html:removeFromMemory}}">{{html:forget}}</button>`}
  </div>`
}

const COMMITMENTS = { items: [], preparations: [], loops: [], editor: null, loading: false, version: 0, proactiveEnabled: null, research: null, researchRevision: 0 }
const answerDrafts = new Map()
const GOAL_STATUS = { active: '{{msg:active}}', paused: '{{msg:paused}}', done: '{{msg:completed}}', cancelled: '{{msg:canceled}}' }
const PREPARATION_STATUS = { idle: '{{msg:noPreparationYet}}', queued: '{{msg:queuedForPreparation}}', running: '{{msg:preparing}}', ready: '{{msg:prepared}}', failed: '{{msg:preparationFailed}}' }
const OUTCOME_LABEL = { accepted: '{{msg:used2}}', completed: '{{msg:helpedCompleteTheGoal}}', good_time: '{{msg:goodTiming}}', wrong_time: '{{msg:badTiming}}', irrelevant: '{{msg:irrelevant}}', incorrect: '{{msg:incorrect}}', good: '{{msg:useful}}', bad: '{{msg:notUseful}}' }

function agencyTime(value) {
  const date = new Date(value)
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString(UI_LANGUAGE, { hour12: false }) : '{{msg:timeUnrecorded}}'
}

function researchSettingsHtml(research = {}) {
  return `<form id="researchSettingsForm" class="research-settings">
    <label class="goal-checkbox"><input type="checkbox" name="enabled" ${research.enabled ? 'checked' : ''} /> {{html:allowReadOnlyBackgroundResearch}}</label>
    <p class="muted small">{{html:analyzeNewChatsFromTheTimeYou}}</p>
    <details class="research-options"><summary>{{html:sourcesAndDiscovery}}</summary>
      <label class="goal-checkbox"><input type="checkbox" name="discoverChats" ${research.discoverChats !== false ? 'checked' : ''} /> {{html:discoverFollowUpsFromNewChats}}</label>
      <p class="muted small">{{html:chatExcerptsAndGoalSourcesMayBe}}</p>
      <p class="muted small">{{html:turningOffResearchStopsFutureResearchYour}}</p>
    </details>
    <div class="row"><button class="btn small" type="submit">{{html:saveResearchSettings}}</button><span class="research-form-status small" role="status"></span></div>
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
  const statusHtml = `<p class="muted small">${research.enabled ? '{{msg:backgroundResearchOn}}' : '{{msg:backgroundResearchOff}}'}${research.lastScanAt ? ` {{msg:lastDiscoveryCheck}} ${esc(agencyTime(research.lastScanAt))}` : ''}</p>
    ${research.enabled && research.state === 'unconfigured' ? '<p class="small needs-check">{{html:connectAModelInSettingsToRun}}</p>' : ''}
    ${research.enabled && research.state === 'budget_wait' ? `<p class="muted small">{{html:discoveryChecksReachedThe24HourLimit}}${esc(research.budget?.used ?? 20)}/${esc(research.budget?.limit ?? 20)} {{msg:checks}}${research.budget?.resetsAt ? `{{msg:earliestRetry}} ${esc(agencyTime(research.budget.resetsAt))}` : ''}{{msg:period}}</p>` : ''}
    ${research.lastError ? `<p class="small needs-check">{{html:lastDiscoveryCheckFailed}}${esc(research.lastError)}${research.enabled && research.state === 'retry_wait' && research.nextRetryAt ? ` {{msg:scheduledRetry}} ${esc(agencyTime(research.nextRetryAt))}` : ''}</p>` : ''}
    <p class="muted small">{{html:checksRunWhileThisMacIsAwake}}</p>`
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
    status.textContent = research.enabled ? '{{msg:enabledForNewChatsStartingNow}}' : '{{msg:backgroundResearchOff2}}'
    renderResearchStatus(COMMITMENTS.research)
    syncCommitmentCards()
  } catch (err) {
    status.textContent = `{{msg:couldNotSave}}${err.message}{{msg:yourSettingsDraftIsSaved}}`
  } finally {
    delete form.dataset.saving
    controls.forEach((control) => { control.disabled = false })
  }
}

function deadlineLabel(date, time, timezone) {
  return `${esc(date)}${time && timezone ? ` ${esc(time)} ${esc(timezone)}` : /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? '{{msg:timeUnspecified}}' : ''}`
}

function deadlineAssessmentHtml(assessment, evidence = []) {
  if (!assessment || assessment.status === 'none') return ''
  const label = { verified: '{{msg:sourcesVerified}}', conflicting: '{{msg:sourcesDisagreeNeedsVerification}}', unverified: '{{msg:needsVerification}}' }[assessment.status] || '{{msg:needsVerification}}'
  return `<div class="deadline-assessment ${assessment.status === 'verified' ? '' : 'needs-check'}"><b>{{html:deadlineEvidence}}${label}${assessment.date ? ` · ${deadlineLabel(assessment.date, assessment.time, assessment.timezone)}` : ''}</b>
    ${(assessment.claims ?? []).map((claim) => {
      const item = evidence.find((entry) => entry.id === claim.evidenceId)
      const url = typeof item?.source === 'string' ? item.source : item?.source?.url
      const link = /^https?:\/\//i.test(url ?? '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">{{html:viewSource}}</a>` : ''
      return `<div class="deadline-claim"><span class="small">${claim.status === 'verified' ? '{{msg:sourceAndGoalVerified}}' : '{{msg:needsVerification}}'}${claim.date ? ` · ${deadlineLabel(claim.date, claim.time, claim.timezone)}` : ''}${claim.evidenceId ? ` · [${esc(claim.evidenceId)}]` : ''} ${link}</span>
        ${claim.quote ? `<blockquote>${esc(claim.quote)}</blockquote>` : ''}<p class="muted small">${[claim.institution, claim.program, claim.cycle, claim.category, claim.stage].filter(Boolean).map(esc).join(' · ')}</p>
        ${claim.reasons?.length ? `<p class="small">${claim.reasons.map(esc).join('{{msg:listClause}}')}</p>` : ''}</div>`
    }).join('')}${assessment.checkedAt ? `<p class="muted small">{{html:verifiedAt}}${esc(agencyTime(assessment.checkedAt))}</p>` : ''}</div>`
}

function evidenceHtml(item) {
  const source = item.source
  const url = typeof source === 'string' ? source : source?.url
  const isGoal = typeof source === 'string' && source.startsWith('commitment:')
  const message = typeof source === 'string' ? source.match(/^conversation:([^/]+)\/(.+)$/) : null
  const isMemory = typeof source === 'string' && source.startsWith('memory:')
  const label = isGoal ? item.discovered ? '{{msg:goalDiscoveredInChat}}' : '{{msg:confirmedGoal}}' : message ? '{{msg:originalMessage}}' : isMemory ? '{{msg:memoryCheckWhetherItIsCurrent}}' : item.label || (/^https?:\/\//i.test(url ?? '') ? host(url) : '{{msg:source}}')
  const link = /^https?:\/\//i.test(url ?? '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label)
  let excerpt = item.excerpt ? `<p>${esc(item.excerpt)}</p>` : ''
  if (isGoal && item.excerpt) {
    try {
      const fields = JSON.parse(item.excerpt)
      const labels = { title: '{{msg:goal}}', successCriteria: '{{msg:completionCriteria}}', nextAction: '{{msg:nextStep}}', blocker: '{{msg:blocker}}', deadline: '{{msg:deadline}}' }
      const rows = Object.entries(labels).filter(([key]) => typeof fields?.[key] === 'string' && fields[key].trim())
      if (rows.length) excerpt = `<dl class="goal-facts">${rows.map(([key, name]) => `<dt>${name}</dt><dd>${esc(fields[key])}</dd>`).join('')}</dl>`
    } catch {}
  }
  return `<li>${link}<div class="muted small"><time datetime="${esc(item.observedAt ?? '')}">${esc(agencyTime(item.observedAt))}</time>${item.id ? ` · [${esc(item.id)}]` : ''}</div>${excerpt}${message ? `<button class="btn small ghost" data-action="view-source-message" data-conversation-id="${esc(message[1])}" data-message-id="${esc(message[2])}">{{html:viewOriginalMessage}}</button>` : ''}</li>`
}

function preparationExpired(preparation) {
  return preparation.delivery?.status === 'expired' || preparation.delivery?.status === 'pending' && Date.parse(preparation.delivery.expiresAt) <= Date.now()
}

function canAnswerPreparation(goal, preparation) {
  return goal?.status === 'active' && goal.preparation?.state === 'ready' && goal.preparation.artifactId === preparation.id &&
    !(goal.discovery && !goal.discovery.adopted && Date.parse(goal.discovery.expiresAt) <= Date.now()) &&
    Number.isInteger(goal.revision) && goal.revision === preparation.revision && Boolean(preparation.question?.trim()) && !preparation.answer
}

function preparationQuestionHtml(preparation, goal) {
  if (!preparation.question) return ''
  const draft = answerDrafts.get(preparation.id)
  const actionable = canAnswerPreparation(goal, preparation) && !draft?.stale
  const id = esc(preparation.id)
  const answered = preparation.answer
  const question = `<p class="preparation-question" id="question-${id}"><b>${actionable ? '{{msg:needsYourInput}}' : '{{msg:originalQuestion}}'}{{msg:labelSeparator}}</b>${esc(preparation.question)}</p>`
  const saved = answered ? `<p class="preparation-question"><b>{{html:yourAnswer}}</b>${esc(answered.text)} · <small>${esc(agencyTime(answered.answeredAt))}</small></p>` : ''
  if (!actionable && !draft?.text) return question + saved
  const latest = goal?.preparation?.artifactId
  return `${question}${saved}<form data-answer-preparation="${id}" data-goal="${esc(goal.id)}" data-revision="${esc(preparation.revision)}">
    <div class="field"><label for="answer-${id}">${actionable ? '{{msg:yourAnswer2}}' : '{{msg:unsubmittedDraft}}'}</label>
      <textarea id="answer-${id}" name="answer" rows="2" maxlength="1600" required aria-describedby="question-${id}" ${!actionable || draft?.saving ? 'readonly' : ''}>${esc(draft?.text ?? '')}</textarea></div>
    ${actionable ? `<button class="btn small primary" type="submit" aria-disabled="${Boolean(draft?.saving)}">{{html:answerAndContinuePreparation}}</button>`
      : `<button class="btn small" type="button" data-action="view-preparation" data-preparation-id="${esc(latest !== preparation.id ? latest ?? '' : '')}" data-commitment-id="${esc(goal.id)}">${latest && latest !== preparation.id ? '{{msg:viewLatestResult}}' : '{{msg:viewCurrentGoal}}'}</button>`}
    <p class="form-status small" role="status">${esc(draft?.message || (!actionable ? '{{msg:thisQuestionHasChangedYourDraftIs}}' : ''))}</p></form>`
}

function preparationHtml(preparation, goal) {
  const rawOutcome = typeof preparation.outcome === 'string' ? preparation.outcome : preparation.outcome?.signal
  const outcome = OUTCOME_LABEL[rawOutcome] ? rawOutcome : null
  const timing = preparation.outcome?.timing
  const signals = ['accepted', 'completed', 'irrelevant', 'incorrect', 'wrong_time']
  if (preparation.delivery?.deliveredAt || timing) signals.push('good_time')
  const verified = preparation.verification?.passed === true
  const checks = preparation.verification?.checks ?? []
  const checkText = Array.isArray(checks) ? checks.map((check) => typeof check === 'string' ? check : check.label || check.name || check.message || '').filter(Boolean).join('{{msg:listClause}}') : ''
  const goalStopped = ['paused', 'done', 'cancelled'].includes(preparation.goalStatus)
  const expired = preparationExpired(preparation)
  const waiting = !goalStopped && !expired && preparation.delivery?.status === 'pending' && preparation.proactiveEnabled !== false
  const deliveryText = preparation.goalStatus === 'done' ? '{{msg:goalCompletedResultsRemainAvailableForReview}}'
    : preparation.goalStatus === 'cancelled' ? '{{msg:goalCanceledExistingResultsAreSaved}}'
    : preparation.goalStatus === 'paused' ? '{{msg:goalPausedResultsRemainAvailable}}'
    : expired ? '{{msg:theReminderExpiredTheResultIsAvailable}}'
    : preparation.delivery?.status === 'reviewed' ? '{{msg:youReviewedThisResultFurtherRemindersAre}}'
    : preparation.delivery?.status === 'superseded' ? '{{msg:remindersEndedCheckTheCurrentGoalAnd}}'
    : preparation.delivery?.status === 'pending' && preparation.proactiveEnabled === false ? '{{msg:proactiveRemindersAreOffYouCanView}}'
    : waiting ? '{{msg:readyForTheNextSuitableTimeTo}}' : '{{msg:yourResultIsAvailableHereWheneverYou}}'
  return `<details class="preparation" data-preparation-id="${esc(preparation.id)}" data-detail-key="${esc(preparation.id)}" ${preparation.latest ? 'open' : ''}>
    <summary>${esc(preparation.title || '{{msg:preparedWork}}')}<span class="muted small">${esc(agencyTime(preparation.createdAt))}</span></summary>
    <div class="preparation-body">
      ${preparation.outdated && !['done', 'cancelled'].includes(preparation.goalStatus) ? '<p class="small needs-check">{{html:theGoalHasChangedSinceThisResult}}</p>' : ''}
      <div class="content">${md(preparation.content ?? '')}</div>
      ${deadlineAssessmentHtml(preparation.deadlineAssessment, preparation.evidence)}
      ${preparation.error ? `<p class="small needs-check">{{html:researchIncomplete}}${esc(preparation.error)}${preparation.failedAt ? ` · ${esc(agencyTime(preparation.failedAt))}` : ''}${preparation.retryAt && !goalStopped && !preparation.researchStopped ? ` {{msg:scheduledRetry}} ${esc(agencyTime(preparation.retryAt))}` : ''}</p>` : ''}
      ${preparation.assumptions?.length ? `<div class="preparation-assumptions"><b>{{html:assumptionsToCheck}}</b><ul>${preparation.assumptions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
      ${preparationQuestionHtml(preparation, goal)}
      <p class="verification ${verified ? '' : 'needs-check'}">${verified ? '{{msg:referencesWereCheckedWhenThisResultWas}}' : '{{msg:theSourceReferencesNeedVerification}}'}${checkText ? `<br><span class="small">${esc(checkText)}</span>` : ''}</p>
      <details class="evidence" data-detail-key="evidence-${esc(preparation.id)}"><summary>{{html:viewEvidence}} ${(preparation.evidence ?? []).length} {{html:items}}</summary>
        <ol>${(preparation.evidence ?? []).map((item) => evidenceHtml({ ...item, discovered: preparation.goalOrigin === 'discovered' })).join('') || '<li>{{html:noSourcesAvailable}}</li>'}</ol>
      </details>
      <p class="muted small">${deliveryText}${waiting && preparation.delivery.expiresAt ? ` {{msg:reminderExpires}} ${esc(agencyTime(preparation.delivery.expiresAt))}{{msg:period}}` : ''}</p>
      <div class="outcome-actions" role="group" aria-label="{{html:rateThisResultAndItsTiming}}">${signals.map((signal) => `<button class="btn small ${signal === outcome || signal === timing ? 'selected' : 'ghost'}" data-action="preparation-feedback" data-signal="${signal}" data-id="${esc(preparation.commitmentId)}" data-preparation-id="${esc(preparation.id)}" aria-pressed="${signal === outcome || signal === timing}">${OUTCOME_LABEL[signal]}</button>`).join('')}</div>
      <p class="muted small">${outcome ? `{{msg:yourFeedback}}${esc(OUTCOME_LABEL[outcome])}` : '{{msg:outcomeUnknownSilenceDoesNotCountAs}}'}${timing && OUTCOME_LABEL[timing] ? ` {{msg:timingFeedback}}${esc(OUTCOME_LABEL[timing])}{{msg:period}}` : ''}</p>
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
  const situation = Object.entries({ institution: '{{msg:organization}}', program: '{{msg:project}}', cycle: '{{msg:edition}}', category: '{{msg:category}}', stage: '{{msg:stage}}' }).filter(([key]) => goal.situation?.[key])
  const answered = goal.preparation?.reason === 'answered'
  const progress = goal.status === 'done' ? '{{msg:goalCompletePreparationHasEnded}}'
    : goal.status === 'cancelled' ? '{{msg:goalCanceledPreparationHasEnded}}'
    : goal.status === 'paused' ? '{{msg:preparationAndRemindersPaused}}'
    : answered && goal.preparation.state === 'queued' ? researchStopped ? '{{msg:answerSavedEnableBackgroundResearchToContinue}}' : '{{msg:answerSavedTheNextVersionIsQueued}}'
    : answered && goal.preparation.state === 'running' ? '{{msg:preparingAnUpdateWithYourAnswer}}' : PREPARATION_STATUS[goal.preparation?.state] || '{{msg:noPreparationYet}}'
  return `<div class="goal-heading"><h4>${esc(goal.title)}</h4><span class="goal-status">${esc(GOAL_STATUS[goal.status] || goal.status)}</span></div>
    ${discovered ? `<div class="goal-discovery"><p class="small">${unadopted ? '{{msg:discoveredInChatAwaitingVerification}}' : '{{msg:discoveredInChatYouChoseToFollow}}'}${unadopted && goal.discovery?.expiresAt && !stopped ? ` {{msg:followingTemporarilyUntil}} ${esc(agencyTime(goal.discovery.expiresAt))}` : ''}</p>
      ${goal.discovery?.quote ? `<blockquote class="goal-source">${esc(goal.discovery.quote)}</blockquote>` : ''}
      ${discoverySource?.conversationId && discoverySource?.messageId ? `<button class="btn small ghost" data-action="view-source-message" data-conversation-id="${esc(discoverySource.conversationId)}" data-message-id="${esc(discoverySource.messageId)}">{{html:viewOriginalMessage2}}</button>` : ''}</div>` : ''}
    <dl class="goal-facts"><dt>{{html:completionCriteria}}</dt><dd>${esc(goal.successCriteria || '{{msg:unspecified}}')}</dd><dt>{{html:nextStep}}</dt><dd>${esc(goal.nextAction || '{{msg:unspecified}}')}</dd>${goal.blocker ? `<dt>{{html:blocker}}</dt><dd>${esc(goal.blocker)}</dd>` : ''}${goal.deadline ? `<dt>{{html:goalDeadline}}</dt><dd>${esc(goal.deadline)}${/^\d{4}-\d{2}-\d{2}$/.test(goal.deadline) ? '{{msg:timeUnspecified}}' : ''}</dd>` : ''}</dl>
    ${situation.length ? `<details class="goal-context" data-detail-key="situation-${esc(goal.id)}"><summary>{{html:background2}}${unadopted ? ' {{msg:needsVerification2}}' : ''}</summary><dl class="goal-facts">${situation.map(([key, label]) => `<dt>${label}</dt><dd>${esc(goal.situation[key])}</dd>`).join('')}</dl></details>` : ''}
    ${goal.situation?.questions?.length ? `<p class="preparation-question"><b>{{html:stillToConfirm}}</b>${goal.situation.questions.map(esc).join('{{msg:listClause}}')}</p>` : ''}
    ${!preparations.some((item) => item.deadlineAssessment) ? deadlineAssessmentHtml(goal.deadlineAssessment) : ''}
    <p class="goal-progress small" role="status">${esc(progress)}${!stopped && goal.preparation?.error ? ` · ${esc(goal.preparation.error)}` : ''}</p>
    ${goal.watch?.lastError ? `<p class="small needs-check">{{html:sourceCheckFailed}}${esc(goal.watch.lastError)}</p>` : ''}
    <p class="muted small">{{html:sourcesInScope}}${goal.scope?.memory ? '{{msg:localMemory}}' : '{{msg:memoryAccessOff}}'}${goal.scope?.urls?.length ? ` · ${goal.scope.urls.length} {{msg:selectedPages}}` : ' {{msg:noPagesSpecified}}'}${goal.scope?.research ? ' {{msg:webResearch}}' : ''}${goal.scope?.documents?.length ? ` · ${goal.scope.documents.length} {{msg:attachments}}` : ''}${goal.scope?.folders?.length ? ` · ${goal.scope.folders.length} {{msg:workspaceFolders}}` : ''} · ${stopped ? '{{msg:automaticFollowUpOff}}' : goal.watch?.type === 'combined' ? '{{msg:followSourceChangesAndApproachingDeadlines}}' : goal.watch?.type === 'deadline' ? '{{msg:prepareNearDeadline}}' : goal.watch?.type === 'source_change' ? '{{msg:prepareWhenSourcesChange}}' : '{{msg:manualPreparation}}'}</p>
    ${goal.scope?.research && COMMITMENTS.research?.enabled === false ? '<p class="muted small">{{html:backgroundResearchIsOffForThisGoal}}</p>' : ''}
    ${goal.watch?.lastCheckAt || goal.watch?.nextCheckAt || goal.preparation?.retryAt ? `<p class="muted small">${goal.watch?.lastCheckAt ? `{{msg:lastChecked}} ${esc(agencyTime(goal.watch.lastCheckAt))}` : '{{msg:neverChecked}}'}${!stopped && !researchStopped && goal.watch?.nextCheckAt ? ` {{msg:scheduledFor}} ${esc(agencyTime(goal.watch.nextCheckAt))}` : ''}${!stopped && !researchStopped && goal.preparation?.retryAt ? ` {{msg:retryingAfterFailure}} ${esc(agencyTime(goal.preparation.retryAt))}` : ''}</p>` : ''}
    ${goal.completionEvidence ? `<p class="small">{{html:completionEvidence}}${esc(typeof goal.completionEvidence === 'string' ? goal.completionEvidence : JSON.stringify(goal.completionEvidence))}</p>` : ''}
    <div class="goal-actions">
      ${unadopted && !finished ? `<button class="btn small primary" data-action="goal-adopt" data-id="${esc(goal.id)}">{{html:keepFollowingUp}}</button>` : ''}
      ${!finished ? `<button class="btn small primary" data-action="goal-prepare" data-id="${esc(goal.id)}" ${goal.status !== 'active' || researchStopped || ['queued', 'running'].includes(goal.preparation?.state) ? 'disabled' : ''}${researchStopped ? ' title="{{html:enableBackgroundResearchAboveFirst}}"' : ''}>{{html:prepareNextStep}}</button>
      <button class="btn small" data-action="goal-edit" data-id="${esc(goal.id)}">{{html:edit}}</button>
      <button class="btn small ghost" data-action="goal-status" data-status="${goal.status === 'paused' ? 'active' : 'paused'}" data-id="${esc(goal.id)}">${goal.status === 'paused' ? '{{msg:resume}}' : '{{msg:pause}}'}</button>
      <button class="btn small ghost" data-action="goal-complete" data-id="${esc(goal.id)}">{{html:completeGoal}}</button>
      <button class="btn small ghost" data-action="goal-status" data-status="cancelled" data-id="${esc(goal.id)}">${discovered ? '{{msg:stopThisResearch}}' : '{{msg:cancelGoal}}'}</button>` : `<button class="btn small ghost" data-action="goal-status" data-status="active" data-id="${esc(goal.id)}">{{html:reopen}}</button>`}
    </div>
    ${preparations.length ? `<div class="goal-results">${preparations.map((item, index) => preparationHtml({ ...item, latest: index === 0, goalOrigin: goal.origin, goalStatus: goal.status, researchStopped, proactiveEnabled: COMMITMENTS.proactiveEnabled, outdated: item.revision != null && goal.revision != null && item.revision !== goal.revision }, goal)).join('')}</div>` : ''}`
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
    const signature = JSON.stringify([goal, preparations, COMMITMENTS.proactiveEnabled, COMMITMENTS.research?.enabled, preparations.map((item) => [preparationExpired(item), canAnswerPreparation(goal, item)])])
    if (card?.dataset.signature === signature) continue
    const focused = card?.contains(document.activeElement) ? document.activeElement : null
    const summaryKey = focused?.tagName === 'SUMMARY' ? focused.parentElement?.dataset.detailKey : null
    const answerForm = focused?.closest?.('form[data-answer-preparation]')
    const preparationId = answerForm?.dataset.answerPreparation
    const focusedPreparation = preparationId && preparations.find((item) => item.id === preparationId)
    if (focused && focused !== card && !summaryKey && !force && (!answerForm || focusedPreparation && canAnswerPreparation(goal, focusedPreparation))) continue
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
    if (answerForm) {
      const next = $$('form[data-answer-preparation]', card).find((form) => form.dataset.answerPreparation === preparationId)
      const detail = $$('details[data-preparation-id]', card).find((node) => node.dataset.preparationId === preparationId)
      const control = next && $(focused.tagName === 'TEXTAREA' ? 'textarea' : 'button', next)
      ;(control || detail && $('summary', detail) || card).focus({ preventScroll: true })
      if (control?.tagName === 'TEXTAREA') control.setSelectionRange(focused.selectionStart, focused.selectionEnd)
    } else if (summaryKey) {
      const detail = $$('details[data-detail-key]', card).find((node) => node.dataset.detailKey === summaryKey)
      ;(detail && $('summary', detail) || card).focus({ preventScroll: true })
    } else if (focused) ($$('[data-action]', card).find((node) => node.dataset.action === focusAction && node.dataset.signal === focusSignal && node.dataset.preparationId === focusPreparation && !node.disabled) ?? card).focus()
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
    el.innerHTML = `<section class="sect"><div class="row"><h3 class="agency-title">{{html:reminderPreview}}</h3><button class="btn small right" data-action="preview-reminders">{{html:previewCandidates}}</button></div>
      <p class="muted small">{{html:previewLocalRankingsReasonsForDeferralAnd}}</p><div id="reminderPreview" aria-live="polite"></div></section>
      <section class="sect"><h3 class="agency-title">{{html:letEchoResearchANextStep}}</h3><div id="researchSettings"></div><div id="researchStatus"></div></section>
      <section class="sect"><div class="row"><h3 class="agency-title">{{html:ongoingGoals}}</h3><button class="btn small primary right" data-action="goal-new">{{html:addGoal}}</button></div>
      <p class="muted small">{{html:echoPreparesTheNextStepAndRecords}}</p>
      <p class="muted small">{{html:preparationLimitPer24HoursTwicePer}}</p>
      <div id="commitmentEditor"></div><p id="commitmentLoadStatus" class="muted small" role="status"></p>
      <p id="commitmentEmpty" class="muted small">{{html:noConfirmedGoalsYetStartFromOne}}</p>
      <div id="commitmentList" class="list"></div></section>
      <section class="sect"><h4>{{html:itemsToConfirm}}</h4><p class="muted small">{{html:memoryReviewInferredTheseFromContextConfirm}}</p><div id="commitmentCandidates" class="list"></div></section>
      <details class="agency-settings"><summary>{{html:interruptionTimingAndFeedback}}</summary><div id="proactiveOverview"></div></details>`
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
      candidates.innerHTML = loops.map((loop) => `<div class="mem-item"><div class="txt"><b>${esc(loop.topic)}</b><p class="muted small">${esc(loop.why ?? '')}${loop.due ? ` {{msg:due2}} ${esc(loop.due)}` : ''}${loop.ageDays != null ? ` · ${esc(String(loop.ageDays))} {{msg:daysAgo3}}` : ''}</p><button class="btn small" data-action="adopt-loop" data-id="${esc(loop.id)}">{{html:startFollowingUp}}</button></div></div>`).join('') || '<p class="muted small">{{html:noItemsToConfirm}}</p>'
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
    if (status) status.textContent = `{{msg:failedToRefreshGoals}}${err.message}{{msg:yourDraftIsSaved}}`
    if (!poll) throw err
  } finally {
    COMMITMENTS.loading = false
  }
}

function showCommitmentEditor(goal = {}, { mode = 'edit', source, candidateLoopId, preparationId, quote } = {}) {
  const el = $('#commitmentEditor')
  if ($('#commitmentForm')) {
    toast('{{msg:saveOrCancelYourCurrentGoalDraft}}')
    $('input, textarea', el)?.focus()
    return
  }
  COMMITMENTS.editor = { id: goal.id, revision: goal.revision, source: source ?? goal.source, candidateLoopId: candidateLoopId ?? goal.candidateLoopId, preparationId, mode, documents: [...(goal.scope?.documents ?? [])] }
  if (mode === 'complete') {
    el.innerHTML = `<form id="commitmentForm" class="commitment-editor"><h4>{{html:complete}}${esc(goal.title)}{{msg:quoteEnd}}</h4>
      <div class="field"><label for="goalCompletion">{{html:whatConfirmsThatThisGoalIsComplete}}</label><textarea id="goalCompletion" name="completionEvidence" rows="2" maxlength="2000" required placeholder="{{html:forExampleALinkToTheDelivered}}"></textarea></div>
      <div class="row"><button class="btn small primary" type="submit">{{html:recordCompletion}}</button><button class="btn small" type="button" data-action="goal-editor-cancel">{{html:back2}}</button></div><p class="form-status small" role="status"></p></form>`
  } else {
    el.innerHTML = `<form id="commitmentForm" class="commitment-editor"><h4>${goal.id ? '{{msg:editGoal}}' : '{{msg:confirmAGoal}}'}</h4>
      ${quote ? `<blockquote class="goal-source">${esc(quote)}</blockquote>` : ''}
      <div class="field"><label for="goalTitle">{{html:goal}}</label><input id="goalTitle" name="title" type="text" maxlength="160" required value="${esc(goal.title ?? '')}" placeholder="{{html:forExampleDeliverTheWeeklyProjectReport}}" /></div>
      <div class="field"><label for="goalCriteria">{{html:completionCriteria2}}</label><textarea id="goalCriteria" name="successCriteria" rows="2" maxlength="2000" required placeholder="{{html:describeAResultYouCanVerify}}">${esc(goal.successCriteria ?? '')}</textarea></div>
      <div class="field"><label for="goalNext">{{html:firstStepToPrepare}}</label><input id="goalNext" name="nextAction" type="text" maxlength="1000" required value="${esc(goal.nextAction ?? '')}" placeholder="{{html:forExampleSummarizeThisWeekSProgress}}" /></div>
      <div class="field"><label for="goalDeadline">{{html:deadlineOptional}}</label><input id="goalDeadline" name="deadline" type="date" value="${esc(goal.deadline ?? '')}" /></div>
      <fieldset class="goal-scope"><legend>{{html:allowedSources}}</legend>
        <label class="goal-checkbox"><input name="memory" type="checkbox" ${goal.scope?.memory ? 'checked' : ''} /> {{html:useRelevantInformationFromLocalMemory}}</label>
        <label class="goal-checkbox"><input name="research" type="checkbox" ${goal.scope?.research ? 'checked' : ''} /> {{html:allowReadOnlyResearchForThisGoal}}</label>
        <p class="muted small">${COMMITMENTS.research?.enabled ? '{{msg:researchUsesTheReadOnlyAccessGranted}}' : '{{msg:backgroundResearchIsOffYouCanSave}}'}</p>
        <div class="field"><label for="goalUrls">{{html:webPagesUpTo3OnePer}}</label><textarea id="goalUrls" name="urls" rows="3" placeholder="https://…">${esc((goal.scope?.urls ?? []).join('\n'))}</textarea></div>
        <details class="goal-extra-sources"><summary>{{html:attachmentsAndVerifiedOfficialWebsitesOptional}}</summary>
          <div class="field"><label for="goalDocuments">{{html:attachFilesToThisGoalUpTo}}</label><input id="goalDocuments" type="file" accept=".pdf,.txt,.md" multiple aria-describedby="goalDocumentsHelp" /><p id="goalDocumentsHelp" class="muted small">{{html:pdfTxtOrMarkdownUpTo5}}</p></div>
          <div id="goalDocumentList"></div><p id="goalUploadStatus" class="small" role="status"></p>
          <div class="field"><label for="goalFolders">{{html:workspaceFoldersUpTo3OnePer}}</label><textarea id="goalFolders" name="folders" rows="2" placeholder="{{html:forExampleAdmissions2027}}">${esc((goal.scope?.folders ?? []).join('\n'))}</textarea><p class="muted small">{{html:specifyPathsRelativeToTheConfiguredWorkspace}}</p></div>
          <div class="field"><label for="goalOfficialDomains">{{html:verifiedOfficialDomainsUpTo5Optional}}</label><textarea id="goalOfficialDomains" name="officialDomains" rows="2" placeholder="{{html:forExampleAdmissionsExampleEdu}}">${esc((goal.scope?.officialDomains ?? []).join('\n'))}</textarea><p class="muted small">{{html:enterOneVerifiedDomainPerLineEcho}}</p></div>
        </details>
        <p class="muted small">{{html:echoSavesPreparedMaterialLocallySendingMessages}}</p>
      </fieldset>
      <details class="goal-context"><summary>{{html:backgroundOptional}}</summary>
        ${Object.entries({ institution: ['{{msg:organization}}', 160], program: ['{{msg:project}}', 200], cycle: ['{{msg:editionOrYear}}', 80], category: ['{{msg:applicationOrEventCategory}}', 80], stage: ['{{msg:currentStage}}', 80] }).map(([key, [label, max]]) => `<div class="field"><label for="goal-${key}">${label}</label><input id="goal-${key}" name="${key}" maxlength="${max}" value="${esc(goal.situation?.[key] ?? '')}" /></div>`).join('')}
        <div class="field"><label for="goalQuestions">{{html:openQuestionsUpTo5OnePer}}</label><textarea id="goalQuestions" name="questions" rows="2" maxlength="1504">${esc((goal.situation?.questions ?? []).join('\n'))}</textarea></div>
      </details>
      <p class="muted small">${goal.status === 'paused' ? '{{msg:preparationPausesWithThisGoalResumingIt}}' : '{{msg:confirmingEditingOrResumingThisGoalPrepares}}'}{{msg:wordSpace}}{{html:chooseWhenToPrepareUpdatesAllUpdates}}</p>
      <div class="field"><label for="goalWatch">{{html:prepareFutureUpdates}}</label><select id="goalWatch" name="watch"><option value="manual" ${!goal.watch?.type || goal.watch.type === 'manual' ? 'selected' : ''}>{{html:whenIClickPrepareNextStep}}</option><option value="combined" ${goal.watch?.type === 'combined' ? 'selected' : ''}>{{html:onSourceChangesOrApproachingDeadlines}}</option><option value="deadline" ${goal.watch?.type === 'deadline' ? 'selected' : ''}>{{html:nearTheDeadline}}</option><option value="source_change" ${goal.watch?.type === 'source_change' ? 'selected' : ''}>{{html:whenASelectedWebPageChanges}}</option></select></div>
      <div class="row"><button class="btn small primary" type="submit">${goal.id ? '{{msg:saveChanges}}' : '{{msg:confirmAndAddGoal}}'}</button><button class="btn small" type="button" data-action="goal-editor-cancel">{{html:cancel}}</button></div><p class="form-status small" role="status"></p></form>`
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
    return `<div class="goal-document"><span>${esc(document?.name || '{{msg:attachedFiles}}')}<small class="muted">${esc(id)}</small></span><button class="btn small ghost" type="button" data-action="goal-document-remove" data-id="${esc(id)}" aria-label="{{msg:removeFromThisGoal}}${esc(document?.name || '{{msg:file}}')}">{{html:remove2}}</button></div>`
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
    if (editor.documents.length + files.length > 5) throw new Error('{{msg:attachUpToFiveFilesPerGoal}}')
    if (files.some((file) => !/\.(pdf|txt|md)$/i.test(file.name))) throw new Error('{{msg:selectAPdfTxtOrMarkdownFile}}')
    if (files.some((file) => file.size > 5 * 1024 * 1024)) throw new Error('{{msg:eachFileMustBe5MbOr}}')
    for (const file of files) {
      if (COMMITMENTS.editor !== editor) return
      status.textContent = `{{msg:uploading}} ${file.name}…`
      const data = String(await readAsDataUrl(file)).split(',')[1]
      if (COMMITMENTS.editor !== editor) return
      const result = await api('research/documents', { method: 'POST', body: { name: file.name, data } })
      if (COMMITMENTS.editor !== editor) return
      if (!result.document?.id) throw new Error('{{msg:theUploadResponseDidNotIncludeThe}}')
      editor.documents.push(result.document.id)
      COMMITMENTS.research ??= {}
      COMMITMENTS.research.documents ??= []
      COMMITMENTS.research.documents.push(result.document)
      renderGoalDocuments()
    }
    status.textContent = '{{msg:fileAttachedToTheDraftSaveThe}}'
  } catch (err) {
    if (COMMITMENTS.editor === editor) status.textContent = `{{msg:uploadFailed}}${err.message} {{msg:yourUploadsAndGoalDraftAreSaved}}`
  } finally {
    editor.uploading = false
    input.disabled = false
    input.value = ''
  }
}

async function saveCommitmentForm(form) {
  if (!form.reportValidity() || form.dataset.saving) return
  if (COMMITMENTS.editor?.uploading) return toast('{{msg:waitForFileUploadsToFinishBefore}}', true)
  const editor = { ...COMMITMENTS.editor }
  const values = new FormData(form)
  const status = $('.form-status', form)
  const controls = $$('button', form)
  form.dataset.saving = 'true'
  controls.forEach((button) => { button.disabled = true })
  try {
    if (editor.mode === 'complete') {
      const completionEvidence = String(values.get('completionEvidence') ?? '').trim()
      if (!completionEvidence) throw new Error('{{msg:enterCompletionEvidence}}')
      await api(`commitments/${encodeURIComponent(editor.id)}`, { method: 'PATCH', body: { status: 'done', completionEvidence } })
      if (editor.preparationId) {
        try {
          const feedback = await api('feedback', { method: 'POST', body: { commitmentId: editor.id, preparationId: editor.preparationId, signal: 'completed' } })
          if (feedback.ignored) throw new Error('{{msg:theOriginalResultIsUnavailable}}')
        } catch (err) { toast(`{{msg:goalCompletedResultFeedbackCouldNotBe}}${err.message}`, true) }
      }
    } else {
      const urls = [...new Set(String(values.get('urls') ?? '').split(/\r?\n/).map((url) => url.trim()).filter(Boolean))]
      if (urls.length > 3) throw new Error('{{msg:addUpToThreeWebPages}}')
      for (const url of urls) {
        let parsed
        try { parsed = new URL(url) } catch {}
        if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('{{msg:useAnHttpsOrHttpAddressWithout}}')
      }
      const watch = String(values.get('watch'))
      const deadline = String(values.get('deadline') ?? '') || null
      if (watch === 'deadline' && !deadline) throw new Error('{{msg:enterADeadlineOrChooseManualPreparation}}')
      if (watch === 'source_change' && !urls.length && values.get('research') !== 'on') throw new Error('{{msg:toFollowSourceChangesSpecifyAWeb}}')
      const body = { title: String(values.get('title')).trim(), successCriteria: String(values.get('successCriteria')).trim(), nextAction: String(values.get('nextAction')).trim(), deadline, scope: { memory: values.get('memory') === 'on', urls }, watch: { type: watch } }
      if (values.get('folders') !== null) {
        const lines = (key) => [...new Set(String(values.get(key) ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
        const folders = lines('folders'), officialDomains = lines('officialDomains').map((domain) => domain.toLowerCase())
        if (folders.length > 3 || folders.some((folder) => /^(?:\/|~|[a-z]:)/i.test(folder) || folder.includes('\\') || folder.split('/').includes('..') || folder === '.')) throw new Error('{{msg:listUpToThreeRelativeWorkspaceFolders}}')
        if (officialDomains.length > 5 || officialDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain))) throw new Error('{{msg:enterUpToFiveFullOfficialDomains}}')
        body.scope = { ...body.scope, research: values.get('research') === 'on', documents: editor.documents ?? [], folders, officialDomains }
        body.situation = Object.fromEntries(['institution', 'program', 'cycle', 'category', 'stage'].map((key) => [key, String(values.get(key) ?? '').trim()]))
        body.situation.questions = lines('questions')
        if (body.situation.questions.length > 5 || body.situation.questions.some((question) => question.length > 300)) throw new Error('{{msg:enterUpToFiveQuestions300Characters}}')
        if (!body.scope.research && (body.scope.documents.length || folders.length || officialDomains.length)) throw new Error('{{msg:enableReadOnlyResearchToUseAttachments}}')
      }
      if (watch === 'combined' && !deadline && !urls.length && !body.scope.research) throw new Error('{{msg:toFollowSourcesAndDeadlinesEnterA}}')
      if (!body.title || !body.successCriteria || !body.nextAction) throw new Error('{{msg:enterAGoalCompletionCriteriaAndNext}}')
      if (!editor.id && editor.source) body.source = editor.source
      if (!editor.id && editor.candidateLoopId) body.candidateLoopId = editor.candidateLoopId
      if (editor.id && editor.revision) body.expectedRevision = editor.revision
      await api(editor.id ? `commitments/${encodeURIComponent(editor.id)}` : 'commitments', { method: editor.id ? 'PATCH' : 'POST', body })
    }
    COMMITMENTS.editor = null
    $('#commitmentEditor').innerHTML = ''
    toast(editor.mode === 'complete' ? '{{msg:completionEvidenceRecorded}}' : '{{msg:goalSaved}}')
    await renderProactivePanel({ force: true })
    $('[data-action="goal-new"]')?.focus()
  } catch (err) {
    status.textContent = err.message
  } finally {
    delete form.dataset.saving
    controls.forEach((button) => { button.disabled = false })
  }
}

document.addEventListener('input', (event) => {
  const id = event.target.form?.dataset.answerPreparation
  if (!id || event.target.name !== 'answer' || event.target.readOnly) return
  if (event.target.value) answerDrafts.set(id, { text: event.target.value })
  else answerDrafts.delete(id)
})

async function submitPreparationAnswer(form) {
  const { answerPreparation: preparationId, goal: goalId, revision } = form.dataset
  const existing = answerDrafts.get(preparationId)
  if (existing?.saving || existing?.stale || !form.reportValidity()) return
  const input = $('textarea', form), submit = $('button[type="submit"]', form), status = $('[role="status"]', form)
  if (!submit) return
  const answer = input.value.trim()
  if (!answer || answer.length > 1600) { status.textContent = '{{msg:enterAnAnswerOf1To1}}'; input.focus(); return }
  const draft = { text: input.value, saving: true, message: '{{msg:savingAnswer}}' }
  answerDrafts.set(preparationId, draft)
  input.readOnly = true
  submit.setAttribute('aria-disabled', 'true')
  status.textContent = draft.message
  try {
    const result = await api(`commitments/${encodeURIComponent(goalId)}/answer`, {
      method: 'POST', body: { preparationId, expectedRevision: Number(revision), answer },
    })
    if (answerDrafts.get(preparationId) !== draft) return
    const index = COMMITMENTS.items.findIndex((goal) => goal.id === goalId)
    if (index >= 0 && result.commitment.revision >= COMMITMENTS.items[index].revision) COMMITMENTS.items[index] = result.commitment
    const preparation = COMMITMENTS.preparations.find((item) => item.id === preparationId)
    if (preparation) preparation.answer = result.answer
    answerDrafts.delete(preparationId)
    COMMITMENTS.version++
    toast('{{msg:answerSaved}}')
  } catch (err) {
    if (answerDrafts.get(preparationId) !== draft) return
    draft.saving = false
    draft.stale = err.status === 409
    draft.message = draft.stale ? `${err.message}{{msg:seeTheCurrentGoalAndLatestResult}}` : `{{msg:couldNotConfirmYourAnswerWasSaved}}${err.message}{{msg:youCanTryAgain}}`
    const card = form.closest('[data-goal-id]')
    if (card) delete card.dataset.signature
    syncCommitmentCards({ force: true })
    if (!draft.stale) return
  }
  syncCommitmentCards({ force: true })
  await renderProactivePanel({ force: true, poll: true })
}

document.addEventListener('submit', (event) => {
  if (event.target.dataset.answerPreparation) {
    event.preventDefault()
    submitPreparationAnswer(event.target).catch((err) => toast(err.message, true))
    return
  }
  if (event.target.id === 'researchSettingsForm') {
    event.preventDefault()
    saveResearchSettings(event.target).catch((err) => toast(err.message, true))
    return
  }
  if (event.target.id !== 'commitmentForm') return
  event.preventDefault()
  saveCommitmentForm(event.target).catch((err) => toast(err.message, true))
})

const ATTENTION_STYLE_LABELS = { quiet: '{{msg:quiet}}', balanced: '{{msg:balanced}}', engaged: '{{msg:active2}}' }
const ATTENTION_STYLE_HINTS = {
  quiet: '{{msg:longerIntervalsAndAHigherScoreThreshold}}',
  balanced: '{{msg:moderateScoreThreshold}}',
  engaged: '{{msg:shorterIntervalsAndALowerScoreThreshold}}',
}
const PROACTIVE_REASON_LABELS = {
  topic_muted: '{{msg:youMutedThisTopic}}',
  sparse_history: '{{msg:moreChatHistoryIsNeededToIdentify}}',
  usual_chat_window: '{{msg:thisIsATimeYouOftenChat}}',
  outside_usual_window: '{{msg:thisFallsOutsideYourUsualChatTimes}}',
  waiting_for_usual_window: '{{msg:aUsualChatTimeIsApproachingSo}}',
  repeated_wrong_time: '{{msg:youHaveRepeatedlyRatedThisTimeAs}}',
  quiet_style_gap: '{{msg:theRecommendedInterruptionIntervalHasNotElapsed}}',
  learned_timing_gap: '{{msg:echoIsWaitingForTheIntervalLearned}}',
  requested_goal: '{{msg:youAskedForThisFollowUpSo}}',
  quiet_hours: '{{msg:yourQuietHoursAreInEffect}}', wrong_time_pause: '{{msg:remindersArePausedAfterYourTimingFeedback}}',
  recent_chat_activity: '{{msg:youJustSentAMessageEchoWill}}', user_active: '{{msg:aConversationIsInProgress}}',
  focus_deep: '{{msg:screenContextSuggestsYouAreFocused}}', focus_meeting: '{{msg:screenContextSuggestsYouAreInA}}',
  shared_daily_budget: '{{msg:dailyReminderBudgetUsedAcrossAllChannels}}', daily_budget: '{{msg:dailyProactiveMessageLimitReached}}',
  shared_min_gap: '{{msg:tooSoonSinceTheLastReminder}}', min_gap: '{{msg:tooSoonSinceTheLastProactiveMessage}}',
  delivery_in_progress: '{{msg:aReminderIsBeingDelivered}}', disabled: '{{msg:proactiveRemindersAreOff}}',
  no_material: '{{msg:nothingToFollowUpOn}}', duplicate: '{{msg:thisContentHasAlreadyBeenDelivered}}', unchanged_evidence: '{{msg:noNewEvidenceForThisItem}}',
  unchanged_context: '{{msg:theEvidenceIsUnchangedSinceTheLast}}',
  expired: '{{msg:thisReminderExpired}}', stale_preparation: '{{msg:thePreparedResultChangedOrExpired}}', stale_evidence: '{{msg:theEvidenceForThisReminderChangedOr}}',
  already_delivered: '{{msg:reminderDelivered}}', tick_running: '{{msg:anotherCheckIsInProgress}}',
  below_threshold: '{{msg:theLocalScoreIsBelowTheReminder}}', empty_message: '{{msg:noReminderTextWasGenerated}}',
  feedback_suppressed: '{{msg:youRecentlyRatedThisItemAsLess}}', composer_abstained: '{{msg:theModelSuppliedNoWordingForThis}}',
  unusable_wording: '{{msg:theSuggestedWordingDidNotFitThe}}', composer_error: '{{msg:itemSelectedTheWordingRequestFailedTemporarily}}',
  unsupported_evidence: '{{msg:thisReminderLacksSupportingEvidence}}', bad_json: '{{msg:couldNotReadTheContentEvaluation}}', error: '{{msg:checkIncomplete}}',
}

function policyParametersHtml(policy) {
  if (!policy?.base || !policy.effective) return ''
  const rows = [['ambientGapMinutes', '{{msg:recommendedIntervalMinutes}}'], ['habitWaitMinutes', '{{msg:maximumWaitForAUsualChatTime}}'], ['minScore', '{{msg:minimumContentScore01}}']]
  const value = (n) => Number.isFinite(n) ? Number(n.toFixed(2)) : '—'
  const explanations = {
    timing_feedback: '{{msg:recentFeedbackMarkedTheTimingInconvenient}}', welcome_timing: '{{msg:recentFeedbackMarkedTheTimingHelpful}}',
    regular_chat_hours: '{{msg:usualChatTimesIdentified}}', score_calibration: '{{msg:contentThresholdPreferenceApplied}}',
  }
  const adjustments = (Array.isArray(policy.reasons) ? policy.reasons : []).map((key) => explanations[key]).filter(Boolean)
  return `<table class="policy-parameters"><caption>{{html:parametersForThisTriggerType}}</caption>
    <thead><tr><th scope="col">{{html:parameter}}</th><th scope="col">{{html:preset}}</th><th scope="col">{{html:current}}</th></tr></thead>
    <tbody>${rows.map(([key, label]) => `<tr><th scope="row">${label}</th><td>${value(policy.base[key])}</td><td>${value(policy.effective[key])}</td></tr>`).join('')}</tbody></table>
    ${adjustments.length ? `<p class="muted small">${esc(adjustments.join('{{msg:listClause}}'))}{{msg:period}}</p>` : ''}`
}

function lastSelectionHtml(decision) {
  if (!decision) return '<p class="muted small">{{html:noContentSelectionsYet}}</p>'
  if (decision.policy !== 'local') return `<p class="muted small">{{html:legacyModelEvaluation}} ${esc(decision.reason ?? '{{msg:noReasonRecorded}}')}</p>`
  const selection = decision.selection
  const wording = { drafted: '{{msg:wordingGenerated}}', abstained: '{{msg:noWordingSupplied}}', unusable: '{{msg:wordingCheckFailed}}', prepared: '{{msg:usedThePreparedResult}}', error: '{{msg:wordingRequestTemporarilyFailed}}' }
  return `<dl class="kv"><dt>${decision.act ? '{{msg:selectedItem}}' : '{{msg:deferralReason}}'}</dt><dd>${esc(decision.act ? selection?.label ?? '—' : PROACTIVE_REASON_LABELS[decision.reason] ?? decision.reason ?? '—')}</dd>
    ${Number.isFinite(selection?.score) ? `<dt>{{html:localRankingScore01}}</dt><dd>${selection.score.toFixed(2)}</dd>` : ''}
    ${Array.isArray(selection?.reasons) && selection.reasons.length ? `<dt>{{html:selectionEvidence}}</dt><dd>${esc(selection.reasons.join('{{msg:listClause}}'))}</dd>` : ''}
    ${wording[decision.wording] ? `<dt>{{html:presentation}}</dt><dd>${wording[decision.wording]}</dd>` : ''}</dl>`
}

function renderProactiveOverview(p, dream, agency) {
  const el = $('#proactiveOverview')
  const timing = p.nextGate?.timing ?? p.attention?.timing
  const style = timing?.style ?? S.boot?.config?.attention?.style ?? 'balanced'
  const gate = p.nextGate
  const gateSummary = gate?.allow ? '{{msg:aReminderIsCurrentlyAllowed}}' : PROACTIVE_REASON_LABELS[gate?.reason] ?? '{{msg:noDecisionAvailable}}'
  const usualHours = (timing?.usualStartHours ?? []).map((hour) => `${String(hour).padStart(2, '0')}:00–${String(hour + 3).padStart(2, '0')}:00`).join('{{msg:listSeparator}}')
  const nudgeHtml = (dream.nudges ?? [])
    .map((n) => `<div class="mem-item"><div class="txt">${esc(n.topic)}<div class="muted small">${esc(n.angle ?? '')} {{msg:urgency}} ${n.urgency}</div></div></div>`)
    .join('')
  const kindRows = (agency.kinds ?? [])
    .map((k) => {
      return `<div class="mem-item"><div class="txt">${esc(KIND_LABEL[k.kind] ?? k.kind)}
        <div class="muted small">{{html:estimatedUsefulness}} ${(k.mean * 100).toFixed(0)}{{msg:explicitFeedback}} ${k.trials} {{html:times}}</div>
      </div><div class="bar" style="width:56px"><i style="width:${Math.round(k.mean * 100)}%"></i></div></div>`
    })
    .join('')
  el.innerHTML = `
    <div class="stat-row">
      <div class="stat"><b>${p.todayCount}/${p.budget}</b><span>{{html:proactiveMessagesToday}}</span></div>
      <div class="stat"><b>${(agency.outcomes?.accepted ?? 0) + (agency.outcomes?.completed ?? 0)}</b><span>{{html:adoptedOrHelpedComplete}}</span></div>
      <div class="stat"><b>${agency.outcomes?.unknown ?? 0}</b><span>{{html:noExplicitFeedbackYet}}</span></div>
    </div>
    <p class="muted small">{{html:sharedInterruptionBudgetToday}} ${p.attention?.todayCount ?? 0}/${p.attention?.budget ?? S.boot?.config?.attention?.dailyBudget ?? 20} {{msg:timesMinimumGap}} ${p.attention?.minGapSeconds ?? 75} {{html:secondsRemindersCompanionBubblesAndReadyDrafts}}</p>
    <p class="muted small">${p.queue?.length ? `${p.queue.length} {{msg:itemsWaitingForASuitableTime}}` : '{{msg:noRemindersWaiting}}'}${p.attention?.focus ? ` {{msg:currentActivity2}}${esc(FOCUS_LABEL[p.attention.focus] || p.attention.focus)}{{msg:period}}` : ''}${p.attention?.observedAt ? ` {{msg:evidence}}${esc(agencyTime(p.attention.observedAt))}{{msg:period}}` : ''}</p>
    <label class="switch"><span>{{html:enableProactiveReminders}}</span><input type="checkbox" id="proEnabled" ${p.enabled ? 'checked' : ''} /></label>
    <div class="row">
      <button class="btn small" data-action="pro-run">{{html:checkNow}}</button>
      <span class="muted small">{{html:lastContentCheck}}{{msg:wordSpace}}${p.lastCheckAt ? ago(p.lastCheckAt) : '—'} {{msg:lastReminder}}{{msg:wordSpace}}${p.lastAt ? ago(p.lastAt) : '{{msg:never}}'}</span>
    </div>
    <div class="sect">
      <h4>{{html:reminderTimingOnThisMac}}</h4>
      <dl class="kv">
        <dt>{{html:reminderStyle}}</dt><dd>${esc(ATTENTION_STYLE_LABELS[style] ?? ATTENTION_STYLE_LABELS.balanced)}</dd>
        ${timing?.trigger ? `<dt>{{html:reminderType}}</dt><dd>${esc(({ requested_goal: '{{msg:followUpYouRequested}}', suggestion: '{{msg:generalSuggestion}}', companion: '{{msg:companionBubble}}' })[timing.trigger] ?? '{{msg:proactiveReminder}}')}</dd>` : ''}
        <dt>{{html:currentDecision}}</dt><dd>${esc(gateSummary)}</dd>
        ${gate?.allow && gate.selection?.label ? `<dt>{{html:highestPriorityNow}}</dt><dd>${esc(gate.selection.label)}</dd>` : ''}
        ${timing && timing.reason !== gate?.reason && PROACTIVE_REASON_LABELS[timing.reason] ? `<dt>{{html:timingEvidence}}</dt><dd>${esc(PROACTIVE_REASON_LABELS[timing.reason])}</dd>` : ''}
        ${usualHours ? `<dt>{{html:usualChatTimesEchoLocalTime}}</dt><dd>${esc(usualHours)}</dd>` : ''}
        ${timing?.reason === 'sparse_history' && Number.isInteger(timing.observedDays) ? `<dt>{{html:daysWithChatHistoryInThePast}}</dt><dd>${timing.observedDays} {{html:daysThroughYesterday}}</dd>` : ''}
        ${timing?.reason === 'repeated_wrong_time' && Number.isInteger(timing.wrongTimeDays) ? `<dt>{{html:inconvenientTimingForSimilarReminders}}</dt><dd>{{html:inThePastTwoWeeks}} ${timing.wrongTimeDays} {{html:days}}</dd>` : ''}
        ${timing?.nextEligibleAt && timing.reason === gate?.reason ? `<dt>{{html:earliestReminderUnderThisRule}}</dt><dd>${esc(agencyTime(timing.nextEligibleAt))}</dd>` : ''}
        <dt>{{html:quietHours}}</dt><dd>${esc(p.quietHours?.start ?? '—')} → ${esc(p.quietHours?.end ?? '—')}</dd>
      </dl>
      ${policyParametersHtml(timing?.policy)}
    </div>
    <div class="sect">
      <h4>{{html:latestContentSelection}}</h4>
      ${lastSelectionHtml(p.lastDecision)}
    </div>
    <div class="sect">
      <h4>{{html:howYourFeedbackShapesReminders}}</h4>
      <p class="muted small">{{html:usefulAndNotUsefulAdjustTheRanking}}</p>
      <div class="list">${kindRows || '<div class="muted small">{{html:noSamplesYet}}</div>'}</div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-action="fb" data-signal="more" data-kind="global">{{html:moreOften}}</button>
        <button class="btn small" data-action="fb" data-signal="less" data-kind="global">{{html:lessOften}}</button>
      </div>
    </div>
    <div class="sect">
      <h4>{{html:topicsFromMemoryReview}}</h4>
      <div class="list">${nudgeHtml || '<div class="muted small">{{html:noCandidateTopicsYet}}</div>'}</div>
    </div>
    <div class="sect">
      <h4>{{html:recentProactiveMessages}}</h4>
      <div class="list">${
        (p.history ?? []).length
          ? [...p.history].reverse()
              .map(
                (h) => `<div class="mem-item"><div class="txt">${esc(h.message)}
                  <div class="muted small">${fmtTime(h.at)} · ${esc(KIND_LABEL[h.kind] ?? h.kind)} · ${esc(OUTCOME_LABEL[h.outcome?.signal ?? h.outcome] || '{{msg:outcomeUnknown}}')}</div></div></div>`,
              )
              .join('')
          : '<div class="muted small">{{html:noProactiveMessagesYet}}</div>'
      }</div>
    </div>`
  $('#proEnabled').addEventListener('change', async (e) => {
    const input = e.target
    input.disabled = true
    try {
      await api('proactive', { method: 'PATCH', body: { enabled: input.checked } })
      toast(input.checked ? '{{msg:proactiveRemindersAreOn}}' : '{{msg:proactiveRemindersArePaused}}')
      if (S.boot?.proactive) S.boot.proactive.enabled = input.checked
      COMMITMENTS.proactiveEnabled = input.checked
      syncCommitmentCards()
    } catch (err) {
      input.checked = !input.checked
      toast(err.message, true)
    } finally { input.disabled = false }
  })
}

let settingsRequest = 0

async function renderSettingsPanel() {
  const el = $('#panelSettings')
  const request = ++settingsRequest
  el.innerHTML = '<p class="muted small" role="status">{{html:loadingSettings}}</p>'
  let response
  try {
    response = await Promise.all([api('settings'), api('screen'), api('providers'), api('permissions').catch(() => null), api('companion').catch(() => null)])
  } catch (err) {
    if (request === settingsRequest) el.innerHTML = `<p role="alert">{{html:couldNotLoadSettings}}${esc(err.message)}</p><button class="btn small" data-action="open-panel" data-panel="settings">{{html:reloadSettings}}</button>`
    return
  }
  if (request !== settingsRequest) return
  const [{ config: c, mcp }, screen, providers, perms, companion] = response
  S.boot.config = c
  S.companion = companion
  S.screen = screen
  W.catalog = providers
  el.innerHTML = `
    <div class="sect">${languageSelector()}</div>
    <div class="sect">
      <h4>{{html:chat}}</h4>
      <div class="field"><label>{{html:defaultModel2}}</label>
        <select id="setModel">${c.models.map((m) => `<option value="${esc(m.id)}" ${m.id === c.defaultModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
      <div class="field"><label>{{html:temperature}} <b>${c.generation.temperature}</b></label>
        <input type="range" id="setTemp" min="0" max="1.4" step="0.05" value="${c.generation.temperature}" /></div>
      <div class="field"><label>{{html:systemPrompt}}</label><textarea id="setSystem">${esc(c.systemPrompt)}</textarea></div>
    </div>
    <div class="sect">
      <h4>{{html:webSearch}}</h4>
      <div class="switch"><span>{{html:allowWebSearch}}</span><input type="checkbox" id="setSearchOn" ${c.search.enabled ? 'checked' : ''} /></div>
      <p class="muted small" style="margin:6px 0">{{html:selectSearchProvidersInTheOrderEcho}}</p>
      ${wizardChainRows()}
      <div class="field" style="margin-top:10px"><label>{{html:searchResultsPerQuery}} <b>${c.search.maxResults}</b></label>
        <input type="range" id="setCount" min="3" max="10" step="1" value="${c.search.maxResults}" /></div>
      <div class="switch"><span>{{html:readTheFirstSearchResultAutomatically}}</span><input type="checkbox" id="setReadPages" ${c.search.readPages ? 'checked' : ''} /></div>
      <div class="field"><label>{{html:maximumToolRoundsPerReply}} <b>${c.search.maxToolRounds}</b></label>
        <input type="range" id="setRounds" min="1" max="12" step="1" value="${c.search.maxToolRounds}" /></div>
      <div class="row"><button class="btn small" data-action="search-test">{{html:testSearchProviders}}</button></div>
    </div>
    <div class="sect">
      <h4>{{html:setupAndPermissions}}</h4>
      <div class="row">
        <button class="btn small" data-action="rerun-wizard">{{html:runSetupAgain}}</button>
        <span class="muted small">{{html:endpoint}} ${c.upstreamConfigured ? '{{msg:configured}}' : '{{msg:notConfigured}}'} {{msg:memoryProfile2}} ${esc(providers.profiles[c.memory.profile ?? 'standard']?.label ?? c.memory.profile ?? '')} {{msg:searchProviders2}} ${esc((c.search.order ?? []).map(id => providers.search.find(p => p.id === id)?.label ?? id).join(' → ') || '{{msg:webSearchOff}}')}</span>
      </div>
      ${
        perms
          ? `<div class="chain" style="margin-top:8px">
              <div class="chain-row"><span class="idx">${perms.configured ? '✓' : '!'}</span><span style="flex:1">{{html:modelEndpoint}}{{msg:wordSpace}}${perms.configured ? '{{msg:configured}}' : '{{msg:notConfigured}}'}</span></div>
              <div class="chain-row"><span class="idx">${perms.runningUnderLaunchd ? '✓' : '!'}</span><span style="flex:1">${perms.runningUnderLaunchd ? '{{msg:runningWithLaunchdAtLogin}}' : '{{msg:startedManuallyRunInstallShToStart}}'}</span></div>
              <div class="chain-row"><span class="idx">${perms.tools.swiftc ? '✓' : '!'}</span><span style="flex:1">swiftc ${perms.tools.swiftc ? '{{msg:available}}' : '{{msg:missingRunXcodeSelectInstall}}'}</span></div>
              <div class="chain-row"><span class="idx">${perms.authRequired ? '✓' : '·'}</span><span style="flex:1">${perms.authRequired ? '{{msg:passwordProtectionIsOn}}' : '{{msg:noSignInRequired}}'} · ${esc(perms.bind)} :${perms.port}</span></div>
              <div class="chain-row"><span class="idx">·</span><span style="flex:1">{{html:dataFolder}}${esc(perms.dataDir)}</span></div>
            </div>
            <div class="row" style="margin-top:8px"><button class="btn small" data-action="perm-test">{{html:testScreenRecordingPermission}}</button>
            <span class="muted small" id="permOut">${esc(perms.notes.screen)}</span></div>`
          : '<div class="muted small">{{html:couldNotLoadPermissions}}</div>'
      }
    </div>
    <div class="sect">
      <h4>{{html:diagnostics}} <span class="muted small">{{html:fromLocalMetricsJsonl}}</span></h4>
      <div id="diagBox" class="list"><div class="muted small">{{html:loading3}}</div></div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-action="load-diag">{{html:refreshDiagnostics}}</button>
        <button class="btn small" data-action="backup">{{html:exportJsonBackup}}</button>
      </div>
    </div>
    <div class="sect">
      <h4>{{html:privacyControls}}</h4>
      <p class="muted small">{{html:forgetEverythingClearsFactsWorkingAndCore}}</p>
      <div class="row">
        <button class="btn small" data-action="wipe" data-scope="memory">{{html:clearAllMemory}}</button>
        <button class="btn small" data-action="wipe" data-scope="all">{{html:alsoClearConversations}}</button>
      </div>
    </div>
    <div class="sect">
      <h4>{{html:imagesAndMultimodalInput}}</h4>
      <div class="switch"><span>{{html:allowImageInput}}</span><input type="checkbox" id="setImageIn" ${c.media?.imageInput !== false ? 'checked' : ''} /></div>
      <div class="switch"><span>{{html:allowImageGeneration}}</span><input type="checkbox" id="setImageOut" ${c.media?.imageOutput !== false ? 'checked' : ''} /></div>
      <div class="field"><label>{{html:imageModel}}</label>
        <select id="setImageModel">${(c.imageModels ?? [])
          .map((m) => `<option value="${esc(m.id)}" ${m.id === c.defaultImageModel ? 'selected' : ''}>${esc(m.label)}${m.note ? ` · ${esc(m.note)}` : ''}</option>`)
          .join('')}</select></div>
      <div class="field"><label>{{html:maximumImageEdgeBeforeUpload}} <b>${c.media?.maxEdge ?? 1536}</b> px</label>
        <input type="range" id="setMaxEdge" min="768" max="2048" step="128" value="${c.media?.maxEdge ?? 1536}" /></div>
      <p class="muted small">{{html:imageInputRequiresAChatModelWith}}</p>
    </div>
    <div class="sect">
      <h4>{{html:screenAwareness}}</h4>
      <div class="switch"><span>{{html:enableCaptureFromTheMenuBar}}</span><input type="checkbox" id="setScreenOn" ${c.screen?.enabled ? 'checked' : ''} /></div>
      <div class="field"><label>{{html:captureInterval}} <b>${c.screen?.intervalMinutes ?? 5}</b> {{html:minutes}}</label>
        <input type="range" id="setScreenGap" min="1" max="30" step="1" value="${c.screen?.intervalMinutes ?? 5}" /></div>
      <div class="field"><label>{{html:analysisMethod}}</label>
        <select id="setScreenMode">
          <option value="ocr" ${c.screen?.mode !== 'image' ? 'selected' : ''}>{{html:onDeviceOcrRecommendedScreenshotsStayOn}}</option>
          <option value="image" ${c.screen?.mode === 'image' ? 'selected' : ''}>{{html:sendScreenshotsToTheModel}}</option>
        </select></div>
      <div class="field"><label>{{html:daysToKeepScreenSessionSummaries}} <b>${c.screen?.retentionDays ?? 7}</b></label>
        <input type="range" id="setScreenDays" min="0" max="14" step="1" value="${c.screen?.retentionDays ?? 7}" /></div>
      <div class="field"><label>{{html:excludedAppsCommaSeparatedEmptyByDefault}}</label>
        <input type="text" id="setBlocklist" placeholder="{{html:forExample1passwordAlipayTerminal}}" value="${esc((c.screen?.blocklist ?? []).join('{{msg:listSeparator}}'))}" /></div>
      <div class="field"><label>{{html:excludedTextPatternsCommaSeparatedRegularExpressions}}</label>
        <input type="text" id="setExcludes" placeholder="{{html:forExamplePasswordPassportNumber}}" value="${esc((c.screen?.excludeTitlePatterns ?? []).join(','))}" /></div>
      <p class="muted small">{{html:echoSkipsLockedAndIdleScreensBy}}</p>
    </div>
    <div class="sect">
      <h4>{{html:companionMode}} <span class="muted small">{{html:occasionalSuggestionsAboutYourCurrentScreen}}</span></h4>
      <div class="switch"><span>{{html:enableCompanionModeMoreFrequentScreenChecks}}</span><input type="checkbox" id="setCompOn" ${c.companion?.enabled ? 'checked' : ''} /></div>
      <p class="muted small">{{html:theMenuBarAppChecksTheScreen}} ${c.companion?.intervalSeconds ?? 20} {{html:secondsUsingLocalOcrAndDeletesEach}}
        {{html:echoCanHelpWithTheToneOf}}
        {{html:echoSkipsUnchangedScreensBubblesRespectHourly}}</p>
      <div class="field"><label>{{html:screenCheckInterval}} <b>${c.companion?.intervalSeconds ?? 20}</b> {{html:seconds}}</label>
        <input type="range" id="setCompInterval" min="5" max="120" step="5" value="${c.companion?.intervalSeconds ?? 20}" /></div>
      <div class="field"><label>{{html:maximumBubblesPerHour}} <b>${c.companion?.hourlyBudget ?? 15}</b></label>
        <input type="range" id="setCompBudget" min="1" max="40" step="1" value="${c.companion?.hourlyBudget ?? 15}" /></div>
      <div class="field"><label>{{html:minimumGapBetweenBubbles}} <b>${c.companion?.minGapSeconds ?? 75}</b> {{html:seconds}}</label>
        <input type="range" id="setCompGap" min="20" max="600" step="5" value="${c.companion?.minGapSeconds ?? 75}" /></div>
      <div class="field"><label>{{html:showSuggestionsInTheseContextsClearAll}}</label>
        <div class="row">${(S.companion?.scenarios ? Object.entries(S.companion.scenarios) : []).map(([id, label]) =>
          `<label class="pill" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" data-cscenario="${id}" ${(S.companion?.enabledScenarios ?? []).includes(id) ? 'checked' : ''} />${esc(label)}</label>`).join('') || '<span class="muted small">{{html:loading2}}</span>'}</div></div>
      <div class="row"><button class="btn small" data-action="comp-pause">${S.companion?.paused ? '{{msg:resumeCompanion}}' : '{{msg:pauseFor30Minutes}}'}</button>
        <span class="muted small">{{html:framesSeenToday}} ${S.companion?.framesToday ?? 0} {{msg:bubblesThisHour}} ${S.companion?.hourCount ?? 0}/${c.companion?.hourlyBudget ?? 15} {{msg:consecutiveDismissals}} ${S.companion?.dismissStreak ?? 0} {{html:times}}</span></div>
      <div class="list" style="margin-top:8px">${(S.companion?.recent ?? []).slice(0, 5).map((b) =>
        `<div class="mem-item"><div class="txt">${esc(b.bubble)}
          <div class="muted small">${esc(S.companion.scenarios?.[b.scenario] ?? b.scenario)} · ${esc(b.topic)} · ${String(b.ts).slice(11, 16)} · ${esc(BUBBLE_STATUS[b.status] ?? b.status)}${b.why && !b.selection ? ` · ${esc(b.why.slice(0, 60))}` : ''}</div>${selectionDetails(b.selection)}</div></div>`).join('')}</div>
    </div>
    <div class="sect">
      <h4>{{html:storageLimits}}</h4>
      <div class="muted small">{{html:currentUsageScreenshots}} ${(S.screen?.storage?.screenshots?.mb ?? 0)}{{msg:mbGeneratedImages}} ${(S.screen?.storage?.uploads?.mb ?? 0)}{{msg:mbTextRecords}} ${(S.screen?.storage?.texts?.kb ?? 0)}KB</div>
      <div class="field"><label>{{html:screenshotStorageLimit}} <b>${c.storage?.screenImageBudgetMB ?? 200}</b> MB</label>
        <input type="range" id="setShotBudget" min="20" max="1000" step="20" value="${c.storage?.screenImageBudgetMB ?? 200}" /></div>
      <div class="field"><label>{{html:generatedImageStorageLimit}} <b>${c.storage?.uploadsBudgetMB ?? 300}</b> MB</label>
        <input type="range" id="setUploadBudget" min="50" max="2000" step="50" value="${c.storage?.uploadsBudgetMB ?? 300}" /></div>
      <div class="row"><button class="btn small" data-action="storage-prune">{{html:cleanUpNow}}</button>
        <span class="muted small">{{html:at80OfAStorageLimitEcho}}</span></div>
    </div>
    <div class="sect">
      <h4>{{html:memory}}</h4>
      <div class="field"><label>{{html:memoryProfileSelectingOneAppliesItsSettings}}</label>
        <select id="setProfile">${Object.entries(providers.profiles)
          .map(([id, p]) => `<option value="${id}" ${(c.memory.profile ?? 'standard') === id ? 'selected' : ''}>${esc(p.label)}</option>`)
          .join('')}</select></div>
      <div class="switch"><span>{{html:enableLongTermMemory}}</span><input type="checkbox" id="setMemOn" ${c.memory.enabled ? 'checked' : ''} /></div>
      <div class="switch"><span>{{html:extractFactsAfterAConversation}}</span><input type="checkbox" id="setExtract" ${c.memory.extract ? 'checked' : ''} /></div>
      <div class="switch"><span>{{html:includeMemoryInModelPrompts}}</span><input type="checkbox" id="setInject" ${c.memory.inject ? 'checked' : ''} /></div>
    </div>
    <div class="sect">
      <h4>{{html:memoryReviewAndProactiveAssistance}}</h4>
      <div class="switch"><span>{{html:reviewMemoryPeriodically}}</span><input type="checkbox" id="setDreamOn" ${c.dream.enabled ? 'checked' : ''} /></div>
      <div class="field"><label>{{html:reviewIntervalInHours}}<b>${c.dream.intervalHours}</b></label>
        <input type="range" id="setDreamGap" min="1" max="24" step="1" value="${c.dream.intervalHours}" /></div>
      <div class="field"><label>{{html:maximumProactiveMessagesPerDay}} <b>${c.proactive.dailyBudget}</b></label>
        <input type="range" id="setBudget" min="0" max="12" step="1" value="${c.proactive.dailyBudget}" /></div>
      <div class="field"><label>{{html:minimumIntervalInMinutes}}<b>${c.proactive.minGapMinutes}</b></label>
        <input type="range" id="setMinGap" min="10" max="240" step="5" value="${c.proactive.minGapMinutes}" /></div>
      <div class="field"><label for="setThresh">{{html:contentSelectionThreshold}} <b>${c.proactive.confidenceThreshold}</b></label>
        <input type="range" id="setThresh" min="0.3" max="0.95" step="0.01" value="${c.proactive.confidenceThreshold}" /></div>
      <div class="field"><label>{{html:quietHoursInLocalTime}}</label>
        <div class="row"><input type="text" id="setQuietStart" value="${esc(c.proactive.quietHours.start)}" style="width:110px" />
        <span class="muted">→</span><input type="text" id="setQuietEnd" value="${esc(c.proactive.quietHours.end)}" style="width:110px" /></div></div>
      <div class="switch"><span>{{html:showMacosNotificationsForProactiveMessages}}</span><input type="checkbox" id="setNotify" ${c.proactive.notify ? 'checked' : ''} /></div>
    </div>
    <div class="sect">
      <h4>{{html:reminderTimingAndSharedInterruptionBudget}}</h4>
      <div class="field"><label for="setAttentionStyle">{{html:reminderStyle}}</label>
        <select id="setAttentionStyle" aria-describedby="attentionStyleHelp">${Object.entries(ATTENTION_STYLE_LABELS).map(([value, label]) =>
          `<option value="${value}" ${value === (c.attention?.style ?? 'balanced') ? 'selected' : ''}>${label} · ${ATTENTION_STYLE_HINTS[value]}</option>`).join('')}</select></div>
      <p class="muted small" id="attentionStyleHelp">{{html:aPresetSetsTheStartingValuesEcho}}</p>
      <p class="muted small">{{html:remindersCompanionBubblesAndDeliveredDraftsShare}}</p>
      <div class="field"><label for="setAttentionBudget">{{html:maximumInterruptionsPerDay}}</label><input id="setAttentionBudget" type="number" min="0" max="100" step="1" required value="${c.attention?.dailyBudget ?? 20}" /></div>
      <div class="field"><label for="setAttentionGap">{{html:minimumSecondsBetweenChannels}}</label><input id="setAttentionGap" type="number" min="0" max="3600" step="5" required value="${c.attention?.minGapSeconds ?? 75}" /></div>
    </div>
    <div class="sect">
      <h4>{{html:mcpServers}}</h4>
      <div class="list">${
        mcp.length
          ? mcp.map((s) => `<div class="mem-item"><div class="txt">${esc(s.name)}<div class="muted small">${esc(MCP_STATE[s.state] ?? s.state)} · ${s.tools} {{msg:tools}}${s.error ? ` · ${esc(s.error)}` : ''}</div></div></div>`).join('')
          : '<div class="muted small">{{html:noMcpServersConfiguredAddAStdio}}</div>'
      }</div>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="mcp-reload">{{html:reloadMcpServers}}</button>
      <button class="btn small" data-action="search-test">{{html:testSearchProviders}}</button></div>
    </div>
    <div class="sect">
      <h4>{{html:accessControl}}</h4>
      <div class="switch"><span>{{html:requireAPassword}}{{msg:wordSpace}}${c.listener?.bind === 'all' ? '{{msg:availableOnTheLocalNetwork}}' : ''}</span>
        <input type="checkbox" id="setAuthRequired" ${c.auth?.required ? 'checked' : ''} /></div>
      <div class="row" style="margin-top:6px">
        <button class="btn small" data-action="set-passwd">${c.auth?.passwordSet ? '{{msg:changePassword}}' : '{{msg:setPassword}}'}</button>
        <span class="muted small">${c.auth?.required ? '{{msg:signInRequired}}' : '{{msg:signInOptional}}'}</span>
      </div>
    </div>
    <div class="sect">
      <h4>{{html:service}}</h4>
      <div class="kv"><dt>{{html:listeningAddress}}</dt><dd>${c.listener ? `${c.listener.bind === 'all' ? '{{msg:localNetwork}}' : '{{msg:thisMacOnly}}'} · ${esc(c.listener.address)}:${esc(c.listener.port)}` : '{{msg:listenerInformationUnavailable}}'}</dd>
      ${c.listener?.lanUrl ? `<dt>{{html:accessOnTheSameNetwork}}</dt><dd>${esc(c.listener.lanUrl)}</dd>` : ''}
      <dt>{{html:dataFolder2}}</dt><dd style="text-align:left;font:11px var(--mono)">data/</dd></div>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="change-passwd">{{html:changeAccessPassword}}</button></div>
      <div class="row"><button class="btn small primary" data-action="save-settings">{{html:saveSettings}}</button><span id="setSaved" class="muted small"></span></div>
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
      attention: { style: $('#setAttentionStyle').value, dailyBudget: Number($('#setAttentionBudget').value), minGapSeconds: Number($('#setAttentionGap').value) },
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
  $('#setSaved').textContent = '{{msg:savedAndApplied}}'
  toast('{{msg:settingsSaved}}')
  await boot({ keep: true })
}

/* ------------------------------- conversations ------------------------------ */

async function selectConv(id) {
  if (S.stream || S.preparing) return toast('{{msg:stopTheCurrentReplyFirst}}', true)
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
  $('#convTitle').textContent = S.conv.title ?? '{{msg:chat}}'
  const preferredModel = S.conv.model || prefs.model
  $('#modelSelect').value = S.boot.config.models?.some((m) => m.id === preferredModel) ? preferredModel : S.boot.config.defaultModel
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
  if (S.stream || S.selecting || S.preparing) return toast('{{msg:waitForTheCurrentOperationToFinish}}', true)
  const conv = await api('conversations', { method: 'POST', body: {} })
  await refreshList()
  await selectConv(conv.id)
  $('#input').focus()
}

/* ---------------------------------- boot ----------------------------------- */

async function boot({ keep = false } = {}) {
  const b = await api('bootstrap')
  const pending = globalThis.sessionStorage?.getItem('echo.pendingLanguage')
  if (supportedLanguage(pending)) {
    if (b.config.language !== pending) await api('settings', { method: 'PATCH', body: { config: { language: pending } } })
    sessionStorage.removeItem('echo.pendingLanguage')
    localStorage.setItem('echo.language', pending)
    b.config.language = pending
  }
  if (supportedLanguage(b.config.language) && b.config.language !== UI_LANGUAGE) {
    navigateLanguage(b.config.language)
    return
  }
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
  await maybeShowReturnBrief()
  startPolling()
  // On first use, open setup until the user connects an endpoint or skips it.
  if (b.config.onboarding?.needed && !localStorage.getItem('echo.onboardSkipped')) {
    await openWizard().catch(() => {})
  } else if (globalThis.sessionStorage?.getItem('echo.reopenLanguageSettings')) {
    sessionStorage.removeItem('echo.reopenLanguageSettings')
    await openPanel('settings')
    $('#panelSettings [data-language]')?.focus()
  }
}

function startPolling() {
  clearInterval(S.poll)
  S.poll = setInterval(async () => {
    const capture = S.panel === 'memory' && !document.hidden && !$('#drawer').hidden && $('[data-screen-capture]')
    if (capture && capture.dataset.screenCapture === 'pending') {
      try {
        const snapshot = await api('screen')
        if (capture.isConnected && !snapshot.screen.captureRequested) capture.outerHTML = snapshot.screen.enabled ? screenBlock(snapshot) : ''
      } catch {}
    }
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
      if (supportedLanguage(b.config?.language) && b.config.language !== UI_LANGUAGE && !transientWork() && !unsavedInputs()) {
        navigateLanguage(b.config.language)
        return
      }
      S.boot = b
      updateWorkspaceBadge()
      updateComposer()
      S.convs = b.conversations
      renderConvs()
      if (conv) {
        S.conv = conv
        renderThread({ resetScroll: false })
        if (S.current === 'main') toast('{{msg:echoSentAProactiveMessage}}')
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
  $('#ctxChip').textContent = `${model} · ${mode === 'off' ? '{{msg:webSearchOff}}' : mode === 'on' ? '{{msg:alwaysSearch}}' : '{{msg:searchWhenNeeded}}'}${prefs.thinking ? ' {{msg:thinkingOn}}' : ''}`
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
    if (!document.execCommand('copy')) throw new Error('{{msg:copyFailedSelectTheTextAndCopy}}')
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
  if (act === 'adopt-follow-up') return adoptFollowUp(btn)
  if (act === 'dismiss-brief') {
    S.brief = null
    $('#briefCard')?.remove()
    return
  }
  if (act === 'adopt-loop') {
    await openPanel('proactive')
    const loop = COMMITMENTS.loops.find((item) => item.id === id)
    if (!loop) return toast('{{msg:thisSuggestionHasChangedCheckTheLatest}}', true)
    return showCommitmentEditor({ title: loop.topic, deadline: loop.due, watch: { type: loop.due ? 'deadline' : 'manual' } }, { candidateLoopId: loop.id, quote: loop.why })
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
        toast('{{msg:preparationQueuedTheResultWillBeSaved}}')
      } else if (act === 'goal-adopt') {
        await api(`commitments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { adopt: true } })
        toast('{{msg:followUpAdoptedTheSevenDayExpiry}}')
      } else {
        await api(`commitments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: btn.dataset.status } })
        toast(`{{msg:goal}}{{msg:wordSpace}}${btn.dataset.status === 'active' ? '{{msg:resumed}}' : GOAL_STATUS[btn.dataset.status]}`)
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
      if (feedback.ignored) throw new Error('{{msg:theOriginalDraftIsUnavailableRefreshAnd}}')
      toast(btn.dataset.signal === 'wrong_time' && Date.parse(feedback.pausedUntil) > Date.now() ? `{{msg:timingFeedbackSavedPausedUntil}} ${agencyTime(feedback.pausedUntil)}` : `{{msg:recorded2}}${OUTCOME_LABEL[btn.dataset.signal]}`)
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
    } else toast('{{msg:thisResultIsUnavailableCheckTheCurrent}}', true)
    return
  }
  if (act === 'view-source-message') {
    if (S.stream || S.preparing) return toast('{{msg:waitForTheCurrentReplyToFinish}}', true)
    closeDrawer()
    await selectConv(btn.dataset.conversationId)
    const message = $$('#threadInner .msg').find((node) => node.dataset.id === btn.dataset.messageId)
    if (message) {
      message.tabIndex = -1
      message.focus()
      message.scrollIntoView({ block: 'center' })
    } else toast('{{msg:theOriginalMessageIsUnavailableItsExcerpt}}', true)
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
    toast('{{msg:codeCopied}}')
    return
  }
  if (act === 'copy-msg') {
    const msg = btn.closest('.msg')
    const text = (msg.classList.contains('user') ? $('.body', msg) : $('.content', msg))?.innerText ?? msg.innerText
    await copyText(text)
    toast('{{msg:copied}}')
    return
  }
  if (act === 'edit-user') {
    if (S.stream || S.preparing) return toast('{{msg:stopTheCurrentReplyFirst}}', true)
    const node = btn.closest('.msg')
    if ($('.gallery', node)) return toast('{{msg:resendTheMessageWithItsImagesTo}}', true)
    const body = node.querySelector('.body')
    const current = body.innerText
    node.originalBody = body.outerHTML
    const messages = $$('#threadInner .msg')
    const following = Math.max(0, messages.length - messages.indexOf(node) - 1)
    body.outerHTML = `<div class="body edit-box"><textarea aria-label="{{html:editMessage}}">${esc(current)}</textarea>
      <p class="edit-hint">{{html:savingWillRestartTheConversationFromHere}}${following ? `{{msg:replacingTheFollowing}} ${following} {{msg:proactiveMessages}}` : ''}{{msg:period}}</p>
      <div class="row"><button class="btn small" data-action="edit-cancel">{{html:cancel}}</button><button class="btn small primary" data-action="edit-save">{{html:saveAndResend}}</button></div></div>`
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
    if (S.stream) return toast('{{msg:generating2}}', true)
    const editId = node.dataset.id
    return startStream({ userText: text, editId })
  }
  if (act === 'regen') return startStream({ regenerate: true })
  if (act === 'stop') return stopReply()
  if (act === 'preview-reminders') {
    btn.disabled = true
    try { await refreshReminderPreview() } finally { btn.disabled = false }
    return
  }
  if (act === 'topic-mute') {
    const { topicKey } = btn.dataset
    const conversationId = S.current
    btn.disabled = true
    try {
      const result = await api('proactive/topic-mutes', { method: btn.dataset.muted === 'true' ? 'DELETE' : 'PUT',
        body: { topicKey, ...(id ? { conversationId, messageId: id } : {}) } })
      for (const m of S.conv?.messages ?? []) {
        if (typeof m.topicMuted === 'boolean' && (m.companion?.selection ?? m.selection)?.topicKey === topicKey) m.topicMuted = result.muted
      }
      for (const b of $$('button[data-action="topic-mute"][data-id]')) {
        if (b.dataset.topicKey !== topicKey) continue
        b.dataset.muted = String(result.muted)
        b.textContent = result.muted ? '{{msg:unmute}}' : topicKey.startsWith('companion:') ? '{{msg:muteThisKindOfSuggestion}}' : '{{msg:muteThisTopic}}'
      }
      toast(result.muted ? '{{msg:topicMutedFollowUpsYouRequestedWill}}' : '{{msg:topicUnmuted}}')
      if (S.panel === 'proactive' && !$('#drawer').hidden) {
        await refreshReminderPreview()
        if (!id) $('[data-action="preview-reminders"]')?.focus()
      }
    } finally { btn.disabled = false }
    return
  }
  if (act === 'fb') {
    const signal = btn.dataset.signal
    const conversationId = S.current
    const controls = btn.parentElement?.querySelectorAll('button[data-action="fb"]') ?? []
    controls.forEach((b) => { b.disabled = true })
    let r
    try {
      r = await api('feedback', { method: 'POST', body: { signal, kind: btn.dataset.kind, conversationId, messageId: btn.dataset.id } })
    } finally {
      controls.forEach((b) => { b.disabled = false })
    }
    if (r.ignored) return toast('{{msg:couldNotMatchThisFeedbackToIts}}', true)
    if (r.outcome) {
      const message = S.conv?.id === conversationId && S.conv.messages.find((m) => m.id === btn.dataset.id)
      if (message) Object.assign(message, { feedback: r.outcome.utility, feedbackTiming: r.outcome.timing })
      controls.forEach((b) =>
        b.setAttribute('aria-pressed', String([r.outcome.utility, r.outcome.timing].includes(b.dataset.signal))))
    }
    const confirmations = { more: '{{msg:proactiveRemindersWillAppearMoreOften}}', less: '{{msg:proactiveRemindersWillAppearLessOften}}', good: '{{msg:recordedAsUseful}}', bad: '{{msg:recordedAsNotUseful}}',
      good_time: '{{msg:goodTimingRecorded}}',
      wrong_time: r.duplicate ? '{{msg:timingFeedbackAlreadyRecordedForThisReminder}}' : (r.pausedUntil && Date.parse(r.pausedUntil) > Date.now() ? `{{msg:timingFeedbackSavedPausedUntil}} ${agencyTime(r.pausedUntil)}` : '{{msg:timingFeedbackSaved}}') }
    toast(confirmations[signal])
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
    if (S.drawing || S.stream || S.selecting) return toast('{{msg:waitForTheCurrentReplyToFinish2}}', true)
    if (!S.boot?.config?.upstreamConfigured || !S.boot.config.defaultImageModel) return toast('{{msg:chooseAnImageModelInSettingsFirst}}', true)
    const prompt = $('#input').value.trim() || window.prompt('{{msg:whatShouldEchoDrawYouCanSpecify}}')
    if (!prompt) return
    const conversationId = S.current
    S.drawing = conversationId
    updateComposer()
    try {
      const r = await api('images', { method: 'POST', body: { prompt, model: S.boot.config.defaultImageModel, conversationId } })
      if (S.current !== conversationId || S.selecting) {
        await refreshList()
        return toast('{{msg:imageSavedToTheOriginalConversation}}')
      }
      const inner = $('#threadInner')
      $('.hero', inner)?.remove()
      inner.append(
        messageNode(
          r.message ?? {
            id: uid(),
            role: 'assistant',
            content: `{{msg:imageReady}}${prompt}`,
            images: [{ url: r.path, prompt }],
            createdAt: new Date().toISOString(),
            model: r.model,
          },
        ),
      )
      scrollBottom()
      await refreshList()
    } catch (err) {
      toast(`{{msg:imageGenerationFailed}}${err.message}`, true)
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
    if (id === S.current && (S.stream || S.preparing)) return toast('{{msg:stopTheCurrentReplyFirst2}}', true)
    if (!confirm('{{msg:deleteThisConversation}}')) return
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
    toast('{{msg:reviewingMemory}}')
    const r = await api('dream', { method: 'POST', body: {} })
    toast(r.result?.ok ? `{{msg:memoryReviewComplete}}${r.result.summary?.join('{{msg:listClause}}') ?? ''}` : `{{msg:memoryReviewFailed}}${r.result?.error ?? ''}`, !r.result?.ok)
    await boot({ keep: true })
    if (!$('#panelMemory').hidden) await renderMemoryPanel()
    return
  }
  if (act === 'save-core') {
    await api('memory/core', { method: 'PUT', body: { text: $('#coreEdit').value } })
    toast('{{msg:coreMemorySaved}}')
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
    const why = prompt('{{msg:whyShouldEchoForgetThisYourReason}}', '{{msg:forgottenAtYourRequest}}')
    if (why === null) return
    await api('memory/forget', { method: 'POST', body: { id, why } })
    toast('{{msg:forgottenYourReasonHasBeenRecorded}}')
    return renderMemoryPanel()
  }
  if (act === 'protect-mem') {
    const on = btn.dataset.on === '1'
    await api('memory/protect', { method: 'POST', body: { id, on } })
    toast(on ? '{{msg:protectedFromAutomaticFading}}' : '{{msg:protectionRemoved}}')
    return renderMemoryPanel()
  }
  if (act === 'revive') {
    await api('memory/protect', { method: 'POST', body: { id, on: true } })
    toast('{{msg:restoredAndProtected}}')
    return renderMemoryPanel()
  }
  if (act === 'forget-scan') {
    const r = await api('memory/forget-scan', { method: 'POST', body: { dryRun: true } })
    const n = r.result.faded.length
    toast(n ? `{{msg:scanned}} ${r.result.scanned} {{msg:entriesWith}} ${n} {{msg:markedToFadePreviewOnly}}` : `{{msg:scanned}} ${r.result.scanned} {{msg:entriesNoneAreDueToFade}}`)
    return
  }
  if (act === 'look-now') {
    const result = await api('screen/capture', { method: 'POST', body: { reason: 'ui' } })
    if (!result.requested) return toast('{{msg:enableScreenAwarenessInSettingsFirst}}')
    const capture = btn.closest('[data-screen-capture]')
    if (capture) {
      capture.dataset.screenCapture = 'pending'
      btn.disabled = true
      $('[role="status"]', capture).textContent = '{{msg:waitingForTheMenuBarAppTo}}'
    }
    return
  }
  if (act === 'screen-digest') {
    const r = await api('screen/digest', { method: 'POST', body: {} })
    toast(r.session ? `{{msg:summarySaved}}${r.session.summary}` : `{{msg:tooFewSamples}}${r.count ?? 0} {{msg:entries}}`, !r.session)
    return renderMemoryPanel()
  }
  if (act === 'comp-pause') {
    const r = await api('companion/pause', { method: 'POST', body: { minutes: S.companion?.paused ? 0 : 30 } })
    toast(r.paused ? '{{msg:companionPausedFor30Minutes}}' : '{{msg:companionResumed}}')
    await boot({ keep: true })
    return renderSettingsPanel()
  }
  if (act === 'storage-prune') {
    const r = await api('storage/prune', { method: 'POST', body: {} })
    toast(`{{msg:cleanupCompleteFreed}} ${r.report.freedMB}MB`)
    return renderSettingsPanel()
  }
  if (act === 'loop-done') {
    await api('dream/loop', { method: 'PATCH', body: { id, status: 'done' } })
    return renderMemoryPanel()
  }
  if (act === 'pro-run') {
    toast('{{msg:checkingReminderEligibility}}')
    const r = await api('proactive/run', { method: 'POST', body: {} })
    if (r.result?.acted) { toast(`{{msg:sent}}${KIND_LABEL[r.result.message.kind] ?? ''}`); await selectConv('main') }
    else toast(PROACTIVE_REASON_LABELS[r.result?.skipped] ?? '{{msg:noReminderWasSentThisTime}}')
    return renderProactivePanel()
  }
  if (act === 'load-diag') {
    const [d, agency] = await Promise.all([api('diagnostics'), api('agency')])
    const m = d.metrics ?? {}
    const t = m.turns ?? {}
    const toolRows = Object.entries(m.tools ?? {})
      .map(([k, v]) => `<div class="mem-item"><div class="txt">${esc(k)}<div class="muted small">${v.count} {{msg:runsSuccessRate}} ${(v.okRate * 100).toFixed(0)}% · P50 ${v.p50Ms}ms · P95 ${v.p95Ms}ms</div></div></div>`)
      .join('')
    const searchRows = Object.entries(m.search ?? {})
      .map(([k, v]) => `<div class="mem-item"><div class="txt">{{html:search2}} ${esc(k)}<div class="muted small">${v.count} {{msg:runsSuccessRate}} ${(v.okRate * 100).toFixed(0)}% · P50 ${v.p50Ms}ms</div></div></div>`)
      .join('')
    $('#diagBox').innerHTML = `
      <div class="stat-row">
        <div class="stat"><b>${t.count ?? 0}</b><span>{{html:repliesInTheLast7Days}}</span></div>
        <div class="stat"><b>${((t.errorRate ?? 0) * 100).toFixed(0)}%</b><span>{{html:failureRate}}</span></div>
        <div class="stat"><b>${t.p95Ms ?? 0}</b><span>{{html:label95thPercentileLatencyMs}}</span></div>
        <div class="stat"><b>${(agency.outcomes?.accepted ?? 0) + (agency.outcomes?.completed ?? 0)}</b><span>{{html:totalAdoptedOrHelpedComplete}}</span></div>
      </div>
      <div class="muted small">{{html:usageInput}} ${t.tokensIn ?? 0} {{msg:output3}} ${t.tokensOut ?? 0} {{msg:tokensAverage}} ${t.avgRounds ?? 0} {{msg:toolRoundsModel}} ${esc(JSON.stringify(t.models ?? {}))}</div>
      ${m.polish?.count ? `<div class="muted small">{{html:rewrite}}${m.polish.count} {{msg:runsAverage}} ${m.polish.avgMs}{{msg:msChangeRate}} ${((m.polish.changedRate ?? 0) * 100).toFixed(0)}{{msg:mode}} ${esc(JSON.stringify(m.polish.byMode ?? {}))}</div>` : ''}
      ${toolRows}${searchRows}
      ${m.errors?.top?.length ? `<div class="muted small">{{html:mostCommonErrors}}${m.errors.top.map(([k, v]) => `${esc(String(k))}×${v}`).join('{{msg:commaSeparator}}')}</div>` : ''}
      <div class="muted small">{{html:storageScreenshots2}} ${d.storage?.screenshots?.mb}{{msg:mbImages2}} ${d.storage?.uploads?.mb}{{msg:mbMemory}} ${d.memory?.observations} {{msg:entriesFaded}} ${d.memory?.forgetting?.faded}{{msg:graph}} ${d.graph?.nodes} {{html:nodes}}</div>`
    return
  }
  if (act === 'backup') {
    window.open('/api/backup', '_blank')
    return
  }
  if (act === 'wipe') {
    const scope = btn.dataset.scope
    const word = prompt(`{{msg:thisWillPermanentlyClear}}{{msg:wordSpace}}${scope === 'all' ? '{{msg:allMemoryAndConversations}}' : '{{msg:allMemory}}'}{{msg:alongWithCommunicationPreferencesPeopleGoalsDrafts}}`)
    if (word !== 'WIPE') return
    const r = await api('memory/wipe', { method: 'POST', body: { confirm: 'WIPE', scope } })
    COMMITMENTS.editor = null
    COMMITMENTS.items = []
    COMMITMENTS.preparations = []
    answerDrafts.clear()
    COMMITMENTS.version++
    $('#panelProactive').innerHTML = ''
    RELATIONSHIPS.version++
    RELATIONSHIPS.data = null
    RELATIONSHIPS.loading = false
    $('#panelMemory').innerHTML = ''
    toast(`{{msg:cleared}}${r.before.observations} {{msg:facts2}}${scope === 'all' ? `{{msg:listSeparator}}${r.wiped.conversations} {{msg:conversations}}` : ''}`)
    await boot({ keep: true })
    return renderSettingsPanel()
  }
  if (act === 'rerun-wizard') {
    closeDrawer()
    return openWizard()
  }
  if (act === 'perm-test') {
    const out = $('#permOut')
    if (out) out.textContent = '{{msg:testingMacosMayRequestPermission}}'
    const r = await api('permissions/screen-test', { method: 'POST', body: {} })
    toast(r.granted ? '{{msg:screenRecordingPermissionIsReady}}' : r.hint, !r.granted)
    if (out) out.textContent = r.granted ? '{{msg:screenRecordingPermissionGranted}}' : `✗ ${r.hint}`
    return
  }
  if (act === 'save-settings') return saveSettings()
  if (act === 'mcp-reload') {
    const r = await api('mcp/reload', { method: 'POST', body: {} })
    toast(`MCP{{msg:labelSeparator}}${r.servers.map((s) => `${s.name}=${MCP_STATE[s.state] ?? s.state}`).join(' ') || '{{msg:notConfigured2}}'}`)
    return renderSettingsPanel()
  }
  if (act === 'search-test') {
    toast('{{msg:testingSearchProviders}}')
    const r = await api('search/test', { method: 'POST', body: { query: '{{msg:usdToCnyExchangeRateToday}}' } })
    toast(`${r.engine} · ${r.ms}ms · ${r.results.length} {{msg:items}}`)
    return
  }
  if (act === 'set-passwd') {
    const next = prompt('{{msg:setAnAccessPasswordAtLeast6}}')
    if (!next) return
    await api('password', { method: 'POST', body: { next } })
    toast('{{msg:passwordSavedItWillBeRequiredWhen}}')
    return renderSettingsPanel()
  }
  if (act === 'change-passwd') {
    const next = prompt('{{msg:newPasswordAtLeast6CharactersChange}}')
    if (!next) return
    await api('password', { method: 'POST', body: { next } })
    return toast('{{msg:passwordUpdated}}')
  }
  if (act === 'logout') {
    await api('logout', { method: 'POST', body: {} })
    location.reload()
    return
  }
}

document.addEventListener('change', async (e) => {
  if (e.target.matches?.('[data-language]')) return changeLanguage(e.target)
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
    toast(r.required ? '{{msg:passwordRequiredOnYourNextVisit}}' : '{{msg:passwordSignInDisabled}}')
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
  const t = prompt('{{msg:conversationTitle}}', $('#convTitle').textContent)
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
  if (!chatReady()) return toast('{{msg:finishModelSetupFirstYourDraftIs}}', true)
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
async function changeWorkspaceMode(select) {
  const mode = select.value
  if (!visibleWorkspaceMode() || select.disabled || !['read_only', 'work'].includes(mode)) return
  const id = S.current
  S.preparing = true
  updateComposer()
  try {
    const saved = await api(`conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { workspaceMode: mode } })
    if (saved.id !== id || saved.workspaceMode !== mode) throw new Error('{{msg:couldNotSaveTheWorkspaceModeRefresh}}')
    if (S.conv?.id === id) S.conv.workspaceMode = saved.workspaceMode
  } catch (error) {
    toast(error.message, true)
  } finally {
    S.preparing = false
    updateComposer()
  }
}
$('#workspaceMode').addEventListener('change', (event) => changeWorkspaceMode(event.target))
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
    if (err.status !== 401) {
      showGate('again')
      $('#gateError').textContent = err.message
      $('#gateError').hidden = false
    }
  }
})()
