#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
const program = source.split('/* --------------------------------- start ----------------------------------- */')[0]
const tests = []
const test = (name, run) => tests.push({ name, run })
function element() {
  return {
    dataset: {}, style: {}, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    classList: { toggle() {}, add() {}, remove() {} }, selectedOptions: [],
    addEventListener() {}, setAttribute() {}, querySelector() { return null }, querySelectorAll() { return [] },
    focus() { this.focused = true }, scrollIntoView() {}, contains() { return false }, closest() { return null },
    append() {}, before() {}, after() {}, remove() {}, reportValidity() { return true },
    insertAdjacentHTML(_position, html) { this.innerHTML += html },
  }
}
function harness() {
  const nodes = new Map(), listeners = new Map()
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element())
    return nodes.get(selector)
  }
  const document = {
    ...element(), body: element(), documentElement: element(), activeElement: null,
    querySelector: (selector) => ['#commitmentForm', '#researchSettingsForm'].includes(selector) ? nodes.get(selector) ?? null : get(selector),
    querySelectorAll() { return [] }, createElement: element,
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler) },
  }
  const context = vm.createContext({
    document, localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, innerHeight: 800,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    requestAnimationFrame() {}, cancelAnimationFrame() {}, AbortController, TextDecoder, TextEncoder, URL, console,
    FormData: class { constructor(form) { this.values = form.values } get(key) { return this.values[key] ?? null } },
  })
  vm.runInContext(program, context)
  return { context, document, get, nodes, listeners, run: (code) => vm.runInContext(code, context) }
}
function formFixture(h, values = {}) {
  const form = element(), status = element(), button = element(), input = element()
  form.values = values
  form.querySelector = () => status
  form.querySelectorAll = () => [button, input]
  h.context.form = form
  h.run('toast = () => {}; renderProactivePanel = async () => {}')
  return { form, status, button, input }
}
const fields = { title: '查报名时间', successCriteria: '确认适用年份的截止', nextAction: '查学校官网', urls: '', deadline: '', watch: 'combined', folders: '', officialDomains: '', questions: '' }

test('research is opt-in, new chats only, and scope/upstream/desktop limits are explicit', () => {
  const h = harness()
  const html = h.run('researchSettingsHtml()')
  assert.doesNotMatch(html, /name="enabled" checked/)
  assert.match(html, /启用之后的新对话/)
  assert.match(html, /7 天/)
  assert.match(html, /已配置的模型/)
  assert.match(html, /搜索词会发送给搜索服务/)
  assert.match(html, /后台研究与主动提醒独立/)
  h.run(`renderResearchStatus({enabled:false,lastError:'<script>offline</script>',nextRetryAt:'2026-10-21T09:00:00Z'})`)
  assert.match(h.get('#researchStatus').innerHTML, /Mac 唤醒/)
  assert.match(h.get('#researchStatus').innerHTML, /&lt;script&gt;offline/)
  assert.doesNotMatch(h.get('#researchStatus').innerHTML, /<script>/)
  h.run(`renderResearchStatus({enabled:true,state:'unconfigured',lastSuccessAt:'2026-10-20'})`)
  assert.match(h.get('#researchStatus').innerHTML, /尚未配置可用模型/)
  assert.doesNotMatch(h.get('#researchStatus').innerHTML, /研究成功/)
  h.run(`renderResearchStatus({enabled:true,state:'budget_wait',budget:{used:20,limit:20,resetsAt:'2026-10-21'}})`)
  assert.match(h.get('#researchStatus').innerHTML, /过去 24 小时/)
  assert.match(h.get('#researchStatus').innerHTML, /最早恢复/)
})

test('polling preserves unsaved settings and focus while updating research status', () => {
  const h = harness()
  const form = h.get('#researchSettingsForm'), input = element()
  form.dataset.dirty = 'true'
  h.get('#researchSettings').innerHTML = 'unsaved enabled toggle'
  h.document.activeElement = input
  h.run('renderResearchStatus({enabled:false,lastScanAt:"2026-10-20T09:00:00Z"})')
  assert.equal(h.get('#researchSettings').innerHTML, 'unsaved enabled toggle')
  assert.equal(h.document.activeElement, input)
  delete form.dataset.dirty
  form.contains = (node) => node === input
  h.run('renderResearchStatus({enabled:true})')
  assert.equal(h.get('#researchSettings').innerHTML, 'unsaved enabled toggle')
})

test('failed consent save preserves draft, focus and previous effective permissions', async () => {
  const h = harness()
  const f = formFixture(h, { enabled: 'on', discoverChats: 'on' })
  h.document.activeElement = f.input
  h.run('COMMITMENTS.research={enabled:false}; api=async()=>{throw new Error("offline")}')
  await h.run('saveResearchSettings(form)')
  assert.match(f.status.textContent, /保存失败：offline/)
  assert.equal(f.form.values.enabled, 'on')
  assert.equal(h.run('COMMITMENTS.research.enabled'), false)
  assert.equal(h.document.activeElement, f.input)
  assert.equal(f.input.disabled, false)
})

test('consent save is single-flight and sends only explicit research booleans', async () => {
  const h = harness(), f = formFixture(h, { enabled: 'on' })
  let finish, calls = 0
  h.context.save = (path, options) => {
    calls++
    assert.equal(path, 'settings')
    assert.deepEqual(JSON.parse(JSON.stringify(options.body)), { config: { proactive: { research: { enabled: true, discoverChats: false } } } })
    return new Promise((resolve) => { finish = resolve })
  }
  h.run('api=save')
  const pending = h.run('saveResearchSettings(form)')
  await h.run('saveResearchSettings(form)')
  assert.equal(calls, 1)
  assert.equal(f.input.disabled, true)
  finish({})
  await pending
  assert.equal(h.run('COMMITMENTS.research.enabled'), true)
  assert.equal(f.input.disabled, false)
})

test('discovered cards show exact escaped provenance, provisional background and bounded responsibility', () => {
  const h = harness()
  const goal = { id: 'g1', status: 'active', title: '报名', origin: 'discovered', source: { conversationId: 'c1', messageId: 'm1' }, discovery: { quote: '学校说 <img src=x> 还不清楚', expiresAt: '2026-10-27T00:00:00Z' }, situation: { institution: '<script>', questions: ['是哪一届？'] }, scope: { research: true }, watch: { type: 'combined' } }
  h.context.goal = goal
  const html = h.run('commitmentHtml(goal,[])')
  assert.match(html, /事项待你核实/)
  assert.match(html, /临时跟进至/)
  assert.match(html, /data-conversation-id="c1" data-message-id="m1"/)
  assert.match(html, /继续帮我跟进/)
  assert.match(html, /停止这项研究/)
  assert.match(html, /还需要确认/)
  assert.doesNotMatch(html, /<img|<script>/)
  goal.discovery.adopted = true
  const adopted = h.run('commitmentHtml(goal,[])')
  assert.match(adopted, /你已选择继续跟进/)
  assert.doesNotMatch(adopted, /临时跟进至|继续帮我跟进/)
  goal.discovery.source = { conversationId: 'original', messageId: 'original-message' }
  goal.source = { conversationId: 'clarification', messageId: 'new-message' }
  const provenance = h.run('commitmentHtml(goal,[])')
  assert.match(provenance, /data-conversation-id="original" data-message-id="original-message"/)
  assert.doesNotMatch(provenance, /data-conversation-id="clarification"/)
})

test('date claims distinguish conflict from verification, preserve exact quotes, and reject unsafe links', () => {
  const h = harness()
  h.context.assessment = { status: 'conflicting', date: '2026-11-01', claims: [{ evidenceId: 'e1', quote: '"Deadline is Nov 1" <svg>', date: '2026-11-01', status: 'unverified', institution: 'School', cycle: '2025', reasons: ['届次不一致'] }] }
  const html = h.run(`deadlineAssessmentHtml(assessment,[{id:'e1',source:'javascript:alert(1)'}])`)
  assert.match(html, /来源有冲突 · 待核实/)
  assert.match(html, /时间未指定/)
  assert.match(html, /&quot;Deadline is Nov 1&quot; &lt;svg&gt;/)
  assert.match(html, /届次不一致/)
  assert.doesNotMatch(html, /href=|<svg>/)
  const verified = h.run(`deadlineAssessmentHtml({...assessment,status:'verified'},[{id:'e1',source:'https://school.example/deadline'}])`)
  assert.match(verified, /来源已核对/)
  assert.match(verified, /href="https:\/\/school.example\/deadline"/)
  const clock = h.run(`deadlineAssessmentHtml({status:'verified',date:'2026-11-01',time:'17:00',timezone:'Asia/Shanghai',claims:[]})`)
  assert.match(clock, /2026-11-01 17:00 Asia\/Shanghai/)
  assert.doesNotMatch(clock, /时间未指定/)
})

test('stopped goals and disabled research do not promise future research, and errors remain visible', () => {
  const h = harness()
  h.run('COMMITMENTS.research={enabled:false}')
  const html = h.run(`commitmentHtml({id:'g',status:'cancelled',origin:'discovered',scope:{research:true},preparation:{retryAt:'2026-10-21'},watch:{lastCheckAt:'2026-10-20',nextCheckAt:'2026-10-21',lastError:'offline'}},[])`)
  assert.match(html, /当前不自动跟进/)
  assert.match(html, /研究暂不运行/)
  assert.match(html, /来源检查失败：offline/)
  assert.doesNotMatch(html, /下次计划|失败重试|继续帮我跟进/)
  const disabled = h.run(`commitmentHtml({id:'g',status:'active',scope:{research:true},watch:{nextCheckAt:'2026-10-21'}},[])`)
  assert.doesNotMatch(disabled, /下次计划/)
  assert.match(disabled, /data-action="goal-prepare"[^>]*disabled/)
})

test('latest sourced result opens by default and discovered evidence is not called user-confirmed', () => {
  const h = harness()
  const html = h.run(`commitmentHtml({id:'g',status:'active',origin:'discovered'},[{id:'p1',content:'Result',evidence:[{source:'commitment:g',excerpt:'source'}]},{id:'p2',content:'Old'}])`)
  assert.match(html, /data-preparation-id="p1" data-detail-key="p1" open/)
  assert.doesNotMatch(html, /data-preparation-id="p2" data-detail-key="p2" open/)
  assert.match(html, /从对话发现的目标记录/)
  assert.doesNotMatch(html, /已确认目标/)
})

test('editor has accessible scoped controls and escapes supplied situation', () => {
  const h = harness()
  h.run(`showCommitmentEditor({scope:{documents:['d1'],folders:['notes']},situation:{institution:'"><img>',questions:['</textarea><svg>']}})`)
  const html = h.get('#commitmentEditor').innerHTML
  assert.match(html, /for="goalDocuments"/)
  assert.match(html, /accept=".pdf,.txt,.md"/)
  assert.match(html, /aria-describedby="goalDocumentsHelp"/)
  assert.match(html, /for="goalOfficialDomains"/)
  assert.match(html, /value="combined"/)
  assert.doesNotMatch(html, /<img>|<svg>/)
  assert.match(html, /&lt;\/textarea&gt;&lt;svg&gt;/)
})

test('goal save sends explicit sources, situation, and combined watch without inventing a deadline', async () => {
  const h = harness()
  formFixture(h, { ...fields, research: 'on', folders: 'admissions/2027\nnotes', officialDomains: 'Admissions.Example.edu', institution: 'School', cycle: '2027', questions: '具体截止时区？' })
  let sent
  h.context.save = async (path, options) => { sent = { path, options }; return {} }
  h.run(`COMMITMENTS.editor={mode:'edit',documents:['doc1']};api=save`)
  await h.run('saveCommitmentForm(form)')
  assert.equal(sent.options.body.watch.type, 'combined')
  assert.equal(sent.options.body.deadline, null)
  assert.deepEqual(JSON.parse(JSON.stringify(sent.options.body.scope)), { memory: false, urls: [], research: true, documents: ['doc1'], folders: ['admissions/2027', 'notes'], officialDomains: ['admissions.example.edu'] })
  assert.equal(sent.options.body.situation.cycle, '2027')
})

test('invalid folder and official-domain scope stays in the draft without any request', async () => {
  for (const values of [{ folders: '../private' }, { folders: '/Users/me' }, { folders: 'a\nb\nc\nd' }, { officialDomains: 'https://school.example/path' }, { officialDomains: '*.example.edu' }]) {
    const h = harness(), f = formFixture(h, { ...fields, ...values })
    h.run('COMMITMENTS.editor={mode:"edit",documents:[]};api=async()=>{throw new Error("unexpected request")}')
    await h.run('saveCommitmentForm(form)')
    assert.match(f.status.textContent, /相对文件夹|官方网站域名/)
    assert.notEqual(h.run('COMMITMENTS.editor'), null)
    assert.equal(f.button.disabled, false)
  }
})

test('concurrent background changes cannot silently overwrite an older open goal draft', async () => {
  const h = harness(), f = formFixture(h, { ...fields, research: 'on', title: 'Keep my edited draft' })
  h.document.activeElement = f.input
  h.context.save = async (_path, options) => {
    assert.equal(options.body.expectedRevision, 2)
    throw new Error('目标版本已变化')
  }
  h.run(`COMMITMENTS.editor={id:'goal1',revision:2,mode:'edit',documents:[]};api=save`)
  await h.run('saveCommitmentForm(form)')
  assert.equal(f.status.textContent, '目标版本已变化')
  assert.equal(f.form.values.title, 'Keep my edited draft')
  assert.equal(h.document.activeElement, f.input)
  assert.equal(h.run('COMMITMENTS.editor.revision'), 2)
})

test('automatic research supports unknown URLs but attachments require explicit per-goal permission', async () => {
  const h = harness(), f = formFixture(h, { ...fields, watch: 'source_change', research: 'on' })
  let calls = 0
  h.context.save = async () => { calls++; return {} }
  h.run(`COMMITMENTS.editor={mode:'edit',documents:[]};api=save`)
  await h.run('saveCommitmentForm(form)')
  assert.equal(calls, 1)
  const blocked = harness(), b = formFixture(blocked, { ...fields, watch: 'manual' })
  blocked.run(`COMMITMENTS.editor={mode:'edit',documents:['doc1']};api=async()=>{throw new Error('must not send')}`)
  await blocked.run('saveCommitmentForm(form)')
  assert.match(b.status.textContent, /需要先勾选/)
  assert.equal(blocked.run('COMMITMENTS.editor.documents[0]'), 'doc1')
})

test('upload bounds are checked before reading files and failures preserve uploaded IDs and draft', async () => {
  for (const file of [{ name: 'huge.pdf', size: 5 * 1024 * 1024 + 1 }, { name: 'secret.exe', size: 1 }]) {
    const h = harness(), input = element()
    input.files = [file]
    h.context.input = input
    h.run(`COMMITMENTS.editor={documents:['existing']};readAsDataUrl=async()=>{throw new Error('must not read')}`)
    await h.run('uploadGoalDocuments(input)')
    assert.match(h.get('#goalUploadStatus').textContent, /5 MB|Markdown/)
    assert.equal(h.run('COMMITMENTS.editor.documents[0]'), 'existing')
    assert.equal(input.disabled, false)
  }
  const h = harness(), input = element()
  input.files = [{ name: 'a.md', size: 1 }, { name: 'b.md', size: 1 }]
  h.context.input = input
  let calls = 0
  h.context.upload = async () => { if (++calls === 1) return { document: { id: 'a', name: '<img>.md' } }; throw new Error('offline') }
  h.run(`COMMITMENTS.editor={documents:[]};readAsDataUrl=async()=> 'data:text/plain;base64,QQ==';api=upload`)
  await h.run('uploadGoalDocuments(input)')
  assert.deepEqual(Array.from(h.run('COMMITMENTS.editor.documents')), ['a'])
  assert.match(h.get('#goalUploadStatus').textContent, /offline/)
  assert.match(h.get('#goalDocumentList').innerHTML, /&lt;img&gt;.md/)
})

test('late document upload cannot attach to a different or cancelled goal draft', async () => {
  const h = harness(), input = element()
  input.files = [{ name: 'a.md', size: 1 }]
  h.context.input = input
  let finish
  h.context.upload = () => new Promise((resolve) => { finish = resolve })
  h.run(`COMMITMENTS.editor={documents:[]};readAsDataUrl=async()=> 'data:text/plain;base64,QQ==';api=upload`)
  const pending = h.run('uploadGoalDocuments(input)')
  await Promise.resolve()
  h.run(`COMMITMENTS.editor={documents:['other']}`)
  finish({ document: { id: 'late' } })
  await pending
  assert.deepEqual(Array.from(h.run('COMMITMENTS.editor.documents')), ['other'])
})

test('adopting a discovered goal sends only explicit adoption, while stopping sends cancellation', async () => {
  for (const [action, expected] of [['goal-adopt', { adopt: true }], ['goal-status', { status: 'cancelled' }]]) {
    const h = harness()
    const button = element()
    button.dataset = { action, id: 'goal/1', status: 'cancelled' }
    button.closest = () => button
    h.context.button = button
    let request
    h.context.save = async (path, options) => { request = { path, body: options.body }; return {} }
    h.run('api=save;toast=()=>{};renderProactivePanel=async()=>{};restoreGoalActionFocus=()=>{}')
    await h.run('handleAction({target:button})')
    assert.equal(request.path, 'commitments/goal%2F1')
    assert.deepEqual(JSON.parse(JSON.stringify(request.body)), expected)
    assert.equal(button.disabled, false)
  }
})

let failures = 0
for (const { name, run } of tests) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures++; console.error(`✗ ${name}\n  ${error.stack}`) }
}
console.log(`${tests.length - failures}/${tests.length} proactive UI checks passed`)
if (failures) process.exitCode = 1
