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
    selectedOptions: [], classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, setAttribute(name, value) { this[name] = value },
    querySelector() { return null }, querySelectorAll() { return [] },
    focus() { this.focused = true }, scrollIntoView() {}, contains() { return false },
    closest() { return null }, append() {}, before() {}, after() {}, remove() {},
    insertAdjacentHTML(_position, html) { this.innerHTML += html }, reportValidity() { return true },
  }
}
function harness() {
  const nodes = new Map(), collections = new Map()
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector) }
  const document = { ...element(), querySelector: get, querySelectorAll: (selector) => collections.get(selector) ?? [], createElement: element, body: element(), documentElement: element(), activeElement: null }
  const context = vm.createContext({ document, localStorage: { getItem() { return null }, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, innerHeight: 800, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {}, AbortController, TextDecoder, TextEncoder, URL, console, FormData: class { constructor(form) { this.values = form.values } get(key) { return this.values[key] ?? null } } })
  vm.runInContext(program, context)
  return { context, document, get, collections, run: (code) => vm.runInContext(code, context) }
}

test('approval renders exact multiline input as text and includes project directory', () => {
  const h = harness()
  const step = { id: 'call1', name: 'shell_exec', workspaceRoot: '/tmp/project', approval: { id: 'approval1', status: 'pending', args: { command: "echo '<img src=x onerror=alert(1)>'\nprintf second", cwd: 'src' } } }
  const html = h.run(`approvalHtml('run1', ${JSON.stringify(step)})`)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /项目目录：\/tmp\/project/)
  assert.match(html, /&quot;cwd&quot;: &quot;src&quot;/)
  assert.match(html, /批准这一次/)
  assert.match(html, /data-decision="deny"/)
})

test('terminal approvals cannot be approved again from the record', () => {
  const h = harness()
  for (const status of ['approved', 'denied', 'expired', 'cancelled']) assert.equal(h.run(`approvalHtml('run1', {approval:{id:'a',status:'${status}'}})`), '')
})

test('artifact downloads only accept local authenticated run artifact paths', () => {
  const h = harness()
  const artifacts = [
    { url: '/api/runs/run_1/artifacts/step_1/stdout.txt', name: '<stdout>', bytes: 2049 },
    { url: 'https://evil.test/steal', name: 'remote' },
    { url: '//evil.test/steal', name: 'remote2' },
    { url: '/api/runs/\\evil.test/artifacts/a', name: 'backslash' },
    { url: 'javascript:alert(1)', name: 'script' },
    { url: '/api/runs/run_1/artifacts/step_1/stdout.txt?redirect=https://evil.test', name: 'query' },
  ]
  const html = h.run(`artifactLinks(${JSON.stringify(artifacts)})`)
  assert.equal((html.match(/<a /g) ?? []).length, 1)
  assert.match(html, /download>&lt;stdout&gt; · 3 KB/)
  assert.doesNotMatch(html, /evil|javascript/)
})

test('tool history shows structured output, failed status, exit code and before/after artifacts', () => {
  const h = harness()
  const step = { id: 'step_1', name: 'shell_exec', args: { command: 'false' }, status: 'failed', exitCode: 1, result: { stdout: '<script>text</script>' }, artifacts: [{ name: 'stderr.txt', url: '/api/runs/run_1/artifacts/step_1/stderr.txt' }] }
  const html = h.run(`runStepHtml('run_1', ${JSON.stringify(step)})`)
  assert.match(html, /失败/)
  assert.match(html, /退出码 1/)
  assert.match(html, /&lt;script&gt;text&lt;\/script&gt;/)
  assert.match(html, /stderr.txt/)
  assert.doesNotMatch(html, /\[object Object\]|<script>/)
})

test('failed tool history preserves the error when its recorded output is empty', () => {
  const h = harness()
  const step = { id: 'step_1', name: 'workspace_read', args: { path: 'notes.md' }, status: 'failed', result: '', error: 'Permission denied: <script>notes.md</script>' }
  const html = h.run(`runStepHtml('run_1', ${JSON.stringify(step)})`)
  assert.match(html, /失败/)
  assert.match(html, /Permission denied: &lt;script&gt;notes\.md&lt;\/script&gt;/)
  assert.equal((html.match(/Permission denied/g) ?? []).length, 1, 'The error should be visible once even without tool output')
  assert.doesNotMatch(html, /<script>/)
})

test('run feedback distinguishes waiting, running and terminal outcomes without invented percentages', () => {
  const h = harness()
  for (const [status, label, explanation] of [
    ['awaiting_approval', '等待你的确认'],
    ['running', '正在执行'],
    ['completed', '本轮执行已完成', '结果已保留'],
    ['failed', '本轮执行有失败', '查看失败原因'],
    ['cancelled', '本轮执行已停止', '已完成的操作不会自动撤销'],
    ['limit_reached', '已达到执行上限', '剩余步骤尚未执行'],
    ['interrupted', '执行状态待核实', '最终状态尚未确认'],
  ]) {
    const html = h.run(`runFeedbackHtml(${JSON.stringify({ id: 'run_1', status, steps: [] })})`)
    assert.ok(html.includes(label), `${status} should have a readable, distinct outcome`)
    if (explanation) assert.ok(html.includes(explanation), `${status} should explain what the user can expect next`)
    assert.doesNotMatch(html, /\d+(?:\.\d+)?\s*%/, 'Tool counts do not establish a task completion percentage')
    if (status !== 'completed') assert.doesNotMatch(html, /本轮执行已完成/, 'An unsuccessful or unfinished run must not be presented as complete')
  }
})

test('run feedback reports observed step counts and the pending approval with escaped tool text', () => {
  const h = harness()
  const run = {
    id: 'run_1', status: 'running',
    steps: [
      { id: 'step_1', name: 'workspace_read', status: 'completed' },
      { id: 'step_2', name: 'workspace_edit', status: 'failed' },
      { id: 'step_3', name: '<img src=x onerror=alert(1)>', status: 'awaiting_approval' },
    ],
  }
  const html = h.run(`runFeedbackHtml(${JSON.stringify(run)})`)
  assert.match(html, /已记录 3 步/)
  assert.match(html, /完成 1 步/)
  assert.match(html, /失败 1 步/)
  assert.match(html, /等待你的确认/)
  assert.match(html, /待确认：&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img|正在执行|\d+(?:\.\d+)?\s*%/)
  run.steps[2].status = 'running'
  const running = h.run(`runFeedbackHtml(${JSON.stringify(run)})`)
  assert.match(running, /正在执行/)
  assert.match(running, /当前步骤：&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(running, /<img|等待你的确认|\d+(?:\.\d+)?\s*%/)
})

test('run feedback escapes the failure explanation', () => {
  const h = harness()
  const run = { id: 'run_1', status: 'failed', steps: [], error: 'Cannot read <img src=x onerror=alert(1)> & retry' }
  const html = h.run(`runFeedbackHtml(${JSON.stringify(run)})`)
  assert.match(html, /Cannot read &lt;img src=x onerror=alert\(1\)&gt; &amp; retry/)
  assert.doesNotMatch(html, /<img/)
})

test('shell and file output use readable lines without losing stderr or termination reason', () => {
  const h = harness()
  const shell = h.run(`toolOutputText(${JSON.stringify(JSON.stringify({ stdout: 'first\nsecond', stderr: 'failure\n', reason: 'timeout' }))})`)
  assert.equal(shell, '标准输出\nfirst\nsecond\n\n错误输出\nfailure\n\n\n结束原因：timeout')
  assert.equal(h.run(`toolOutputText('{"path":"README.md","content":"1: title\\\\n2: body"}')`), '1: title\n2: body')
  assert.equal(h.run(`toolOutputText('{"stdout": "unfinished')`), '{"stdout": "unfinished')
})

test('approval submission is single-use even with repeated clicks', async () => {
  const h = harness(), card = element(), approve = element(), deny = element(), status = element()
  card.dataset.approvalId = 'approval1'
  card.querySelectorAll = () => [approve, deny]
  card.querySelector = () => status
  h.collections.set('[data-approval-id].tool-approval', [card])
  approve.dataset = { runId: 'run1', approvalId: 'approval1', decision: 'approve' }
  h.context.button = approve
  let finish, calls = 0
  h.context.submit = async (path, options) => { calls++; assert.equal(path, 'runs/run1/approvals/approval1'); assert.equal(options.body.decision, 'approve'); return new Promise((resolve) => { finish = resolve }) }
  h.run('api = submit')
  h.get('#drawer').hidden = true
  const first = h.run('decideApproval(button)')
  await h.run('decideApproval(button)')
  assert.equal(calls, 1)
  assert.equal(approve.disabled, true)
  assert.equal(deny.disabled, true)
  finish({ ok: true })
  await first
  await h.run('decideApproval(button)')
  assert.equal(calls, 1)
  assert.equal(card.dataset.decision, 'approve')
  assert.match(status.textContent, /已批准这一次/)
  h.run('settleApproval(\"approval1\", \"completed\")')
  assert.equal(card.dataset.settled, 'true')
  assert.equal(status.textContent, '已完成')
})

test('failed approval preserves the request and offers a retry with the error visible', async () => {
  const h = harness(), card = element(), button = element(), status = element()
  card.dataset.approvalId = 'approval1'
  card.querySelectorAll = () => [button]
  card.querySelector = () => status
  h.collections.set('[data-approval-id].tool-approval', [card])
  button.dataset = { runId: 'run1', approvalId: 'approval1', decision: 'deny' }
  h.context.button = button
  h.run('api = async () => { throw new Error("Connection failed") }')
  await h.run('decideApproval(button)')
  assert.equal(button.disabled, false)
  assert.equal(card.dataset.submitting, undefined)
  assert.equal(status.textContent, 'Connection failed')
})

test('remote workspace sessions cannot submit capability changes', async () => {
  const h = harness()
  let calls = 0
  h.context.submit = async () => { calls++ }
  h.context.form = element()
  h.run('api = submit; WORKSPACE.local = false')
  await h.run('saveWorkspaceForm(form)')
  await h.run('refreshRuns()')
  await h.run('inspectRun(\"run1\")')
  assert.equal(calls, 0)
})

test('workspace form submits bounded units and preserves the draft on failure', async () => {
  const h = harness(), form = element(), submit = element()
  form.values = { enabled: 'on', workspaceRoot: '/tmp/project', allowWrites: 'on', maxToolRounds: '12', timeout: '60' }
  form.querySelector = () => submit
  h.context.form = form
  h.context.save = async (path, options) => {
    assert.equal(path, 'harness')
    assert.equal(options.method, 'PATCH')
    assert.equal(options.body.config.shellTimeoutMs, 60000)
    assert.equal(options.body.config.maxToolRounds, 12)
    assert.equal(options.body.config.allowWrites, true)
    assert.equal(options.body.config.allowShell, false)
    throw new Error('Directory does not exist')
  }
  h.run('WORKSPACE.local = true; api = save')
  await h.run('saveWorkspaceForm(form)')
  assert.equal(form.values.workspaceRoot, '/tmp/project')
  assert.equal(submit.disabled, false)
  assert.equal(h.get('#workspaceStatus').textContent, 'Directory does not exist')
})

test('run polling does not rebuild the workspace permission form', async () => {
  const h = harness()
  h.get('#panelWorkspace').innerHTML = 'form remains mounted'
  h.get('#workspaceRoot').value = '/tmp/unsaved'
  h.run('WORKSPACE.local = true; S.current = "main"; S.panel = "workspace"; api = async () => ({runs:[{id:"run1",status:"running",steps:[]}]})')
  await h.run('refreshRuns()')
  assert.equal(h.get('#panelWorkspace').innerHTML, 'form remains mounted')
  assert.equal(h.get('#workspaceRoot').value, '/tmp/unsaved')
  assert.match(h.get('#runList').innerHTML, /run1/)
})

test('run detail responses cannot replace a newer selected run', async () => {
  const h = harness(), pending = new Map()
  h.context.load = (path) => new Promise((resolve) => pending.set(path, resolve))
  h.run('WORKSPACE.local = true; S.panel = "workspace"; api = load')
  const first = h.run('inspectRun("old")')
  const second = h.run('inspectRun("new")')
  pending.get('runs/new')({ run: { id: 'new', status: 'completed', workspaceRoot: '/tmp/new', steps: [] } })
  await second
  pending.get('runs/old')({ run: { id: 'old', status: 'failed', workspaceRoot: '/tmp/old', steps: [] } })
  await first
  assert.match(h.get('#runInspector').innerHTML, /\/tmp\/new/)
  assert.doesNotMatch(h.get('#runInspector').innerHTML, /\/tmp\/old/)
})

test('focusing the run inspector itself does not freeze its completion state', async () => {
  const h = harness()
  const inspector = h.get('#runInspector')
  inspector.innerHTML = '执行中'
  h.document.activeElement = inspector
  inspector.contains = (node) => node === inspector
  h.run('WORKSPACE.local = true; S.panel = "workspace"; api = async () => ({run:{id:"run1",status:"completed",steps:[]}})')
  await h.run('inspectRun("run1", {poll:true})')
  assert.match(inspector.innerHTML, /已完成/)
  assert.equal(h.document.activeElement, inspector)
})

test('focused run output stays mounted while background polling updates its feedback', async () => {
  const h = harness()
  const inspector = h.get('#runInspector')
  const focusedOutput = element()
  const feedback = element()
  inspector.innerHTML = 'selected output'
  feedback.innerHTML = '执行中'
  h.document.activeElement = focusedOutput
  inspector.contains = (node) => node === inspector || node === focusedOutput
  inspector.querySelector = (selector) => selector === '.run-feedback-body' ? feedback : null
  h.run('WORKSPACE.local = true; S.panel = "workspace"; api = async () => ({run:{id:"run1",status:"completed",steps:[]}})')
  await h.run('inspectRun("run1", {poll:true})')
  assert.equal(inspector.innerHTML, 'selected output')
  assert.match(feedback.innerHTML, /已完成/)
  assert.equal(h.document.activeElement, focusedOutput)
})

test('a mouse selection in run output survives polling while the feedback still completes', async () => {
  const h = harness()
  const inspector = h.get('#runInspector'), output = element(), feedback = element(), card = element()
  const text = { nodeType: 3, textContent: 'selected command output', parentNode: output }
  const selection = { isCollapsed: false, anchorNode: text, focusNode: text, anchorOffset: 0, focusOffset: 8 }
  inspector.innerHTML = '<pre>selected command output</pre>'
  feedback.innerHTML = '正在执行'
  card.dataset.state = 'running'
  h.document.activeElement = h.document.body
  h.document.getSelection = () => selection
  inspector.contains = (node) => node === inspector || node === output || node === text
  inspector.querySelector = (selector) => selector === '.run-feedback-body' ? feedback : selector === '.run-feedback' ? card : null
  h.run('WORKSPACE.local = true; S.panel = "workspace"; api = async () => ({run:{id:"run1",status:"completed",steps:[]}})')
  await h.run('inspectRun("run1", {poll:true})')
  assert.equal(inspector.innerHTML, '<pre>selected command output</pre>', 'Polling must not replace the selected output')
  assert.match(feedback.innerHTML, /本轮执行已完成/)
  assert.equal(card.dataset.state, 'completed')
  assert.equal(h.document.activeElement, h.document.body, 'Updating feedback must not steal focus')
  assert.equal(h.document.getSelection().anchorNode, text)
  assert.equal(h.document.getSelection().focusOffset, 8)
})

let failures = 0
for (const { name, run } of tests) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures++; console.error(`✗ ${name}\n${error.stack}`) }
}
console.log(`${tests.length - failures}/${tests.length} harness UI checks passed`)
if (failures) process.exitCode = 1
