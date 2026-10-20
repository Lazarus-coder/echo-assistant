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
  const nodes = new Map(), collections = new Map(), listeners = new Map(), intervals = []
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element())
    return nodes.get(selector)
  }
  const document = {
    ...element(), body: element(), documentElement: element(), activeElement: null,
    querySelector: (selector) => selector === '#relationshipPersonForm' ? nodes.get(selector) ?? null : get(selector),
    querySelectorAll: (selector) => collections.get(selector) ?? [], createElement: element,
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler) },
  }
  const context = vm.createContext({
    document, localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, innerHeight: 800,
    setTimeout() {}, clearTimeout() {}, setInterval(handler) { intervals.push(handler) }, clearInterval() {},
    requestAnimationFrame() {}, cancelAnimationFrame() {}, AbortController, TextDecoder, TextEncoder, URL, console,
    FormData: class { constructor(form) { this.values = form.values } get(key) { return this.values[key] ?? null } },
  })
  vm.runInContext(program, context)
  return { context, document, get, nodes, listeners, intervals, run: (code) => vm.runInContext(code, context) }
}
function formFixture(h, id, values, personId) {
  const form = element(), status = element(), submit = element(), input = element()
  form.id = id; form.values = values
  if (personId) form.dataset.id = personId
  form.querySelector = (selector) => selector === '.relationship-status' ? status : null
  form.querySelectorAll = () => [submit, input]
  h.context.form = form
  return { form, status, submit, input }
}

test('profile defaults are subtle and optional, and all stored content is escaped', () => {
  const h = harness()
  const html = h.run(`relationshipProfileHtml({preferredName:'"><img src=x>',boundaries:'</textarea><script>alert(1)</script>'})`)
  assert.match(html, /value="subtle" selected/)
  assert.match(html, /value="balanced" selected/)
  assert.match(html, /&quot;&gt;&lt;img/)
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/)
  assert.doesNotMatch(html, /<img|<script|mood|情绪分数/)
  assert.match(html, /不会保存情绪画像/)
  assert.match(html, /相关内容可能发送给你配置的模型/)
  assert.match(html, /<details class="relationship-more"><summary>称呼与边界（可选）/)
})

test('disabled saved context stays editable and explains the separate memory gate', () => {
  const h = harness()
  h.run('S.boot = {config:{memory:{enabled:true, inject:false}}}')
  const html = h.run('relationshipProfileHtml({enabled:false})')
  assert.match(html, /当前记忆注入已关闭/)
  assert.doesNotMatch(html, /name="enabled"[^>]*checked/)
  assert.doesNotMatch(html, /<fieldset[^>]*disabled/)
  assert.match(html, /停用只暂停使用这些设置，不会删除/)
})

test('person cards treat names, relationships, aliases and background as plain text', () => {
  const h = harness()
  const html = h.run(`relationshipPersonHtml(${JSON.stringify({ id: '"bad', name: '<img>', relationship: '<svg>', aliases: ['<iframe>'], context: '</details><script>', boundaries: '<strong>' })})`)
  assert.doesNotMatch(html, /<img|<svg|<iframe|<script|<strong>/)
  assert.match(html, /data-person-id="&quot;bad"/)
  assert.match(html, /&lt;iframe&gt;/)
  assert.match(html, /已经出现在会话中的内容会保留/)
  assert.match(html, /class="relationship-delete-confirm" hidden/)
})

test('collapsing or polling never loads relationship data; expansion loads it only once', async () => {
  const h = harness()
  let calls = 0
  h.context.load = async () => { calls++; return { profile: {}, people: [] } }
  h.run('api = load')
  for (const handler of h.listeners.get('toggle')) handler({ target: { id: 'relationshipSection', open: false } })
  assert.equal(calls, 0)
  await h.run('loadRelationships()')
  await h.run('loadRelationships()')
  assert.equal(calls, 1)
  const polling = h.run('startPolling.toString()')
  assert.doesNotMatch(polling, /relationship|renderMemoryPanel/)
})

test('failed loading can retry without exposing server error HTML', async () => {
  const h = harness()
  h.run('api = async () => { throw new Error("<script>offline</script>") }')
  await h.run('loadRelationships()')
  assert.match(h.get('#relationshipBody').innerHTML, /&lt;script&gt;offline/)
  assert.match(h.get('#relationshipBody').innerHTML, /relationship-retry/)
  h.run('api = async () => ({profile:{}, people:[]})')
  await h.run('loadRelationships()')
  assert.equal(h.get('#relationshipBody').dataset.loaded, 'true')
})

test('profile save failure preserves all values and focused input for retry', async () => {
  const h = harness()
  const f = formFixture(h, 'relationshipProfileForm', { enabled: 'on', tone: 'warm', support: 'listen', preferredName: ' AJ ', boundaries: ' Keep this draft ' })
  h.document.activeElement = f.input
  h.run('RELATIONSHIPS.data = {profile:{},people:[]}; api = async () => { throw new Error("offline") }')
  await h.run('saveRelationshipForm(form)')
  assert.equal(f.status.textContent, 'offline')
  assert.equal(f.form.values.boundaries, ' Keep this draft ')
  assert.equal(f.form.values.tone, 'warm')
  assert.equal(h.document.activeElement, f.input)
  assert.equal(f.input.disabled, false)
  assert.equal(f.submit.disabled, false)
})

test('profile disable is explicit and repeated submissions send only one request', async () => {
  const h = harness()
  const f = formFixture(h, 'relationshipProfileForm', { tone: 'direct', support: 'practical', preferredName: '', boundaries: '' })
  let finish, calls = 0
  h.context.save = (path, options) => {
    calls++
    assert.equal(path, 'relationships/profile')
    assert.equal(options.method, 'PATCH')
    assert.equal(options.body.enabled, false)
    return new Promise((resolve) => { finish = resolve })
  }
  h.run('RELATIONSHIPS.data = {profile:{},people:[]}; api = save')
  const first = h.run('saveRelationshipForm(form)')
  await h.run('saveRelationshipForm(form)')
  assert.equal(calls, 1)
  assert.equal(f.input.disabled, true)
  finish({ profile: { enabled: false } })
  await first
  assert.match(f.status.textContent, /已停用/)
  assert.equal(f.input.disabled, false)
})

test('person save sends normalized aliases and retains the complete editor on failure', async () => {
  const h = harness()
  const f = formFixture(h, 'relationshipPersonForm', { name: ' 张老师 ', aliases: ' 老张， Professor Zhang ', relationship: ' 导师 ', context: ' Keep this exact draft ', boundaries: ' No guesses ' }, 'person_1')
  let calls = 0
  h.context.save = async (path, options) => {
    calls++
    assert.equal(path, 'relationships/people/person_1')
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(Array.from(options.body.aliases), ['老张', 'Professor Zhang'])
    assert.equal(options.body.name, '张老师')
    throw new Error('Could not save')
  }
  h.run('api = save')
  await h.run('saveRelationshipForm(form)')
  assert.equal(calls, 1)
  assert.equal(f.status.textContent, 'Could not save')
  assert.equal(f.form.values.context, ' Keep this exact draft ')
  assert.equal(f.form.dataset.id, 'person_1')
})

test('invalid alias counts and lengths are rejected before a network request', async () => {
  for (const aliases of ['a', 'aa,bb,cc,dd,ee,ff', 'a'.repeat(81)]) {
    const h = harness()
    const f = formFixture(h, 'relationshipPersonForm', { name: 'Alex', aliases })
    h.run('api = () => { throw new Error("should not call") }')
    await h.run('saveRelationshipForm(form)')
    assert.match(f.status.textContent, /最多 5 个，每个 2–80/)
  }
})

test('an existing person draft blocks replacing it with a second editor', () => {
  const h = harness()
  h.nodes.set('#relationshipPersonForm', element())
  h.get('#relationshipEditor').innerHTML = 'unsaved text and focus stay here'
  h.run('showRelationshipEditor("another_person")')
  assert.equal(h.get('#relationshipEditor').innerHTML, 'unsaved text and focus stay here')
})

test('closing an editor restores keyboard focus without throwing after the DOM update', () => {
  const h = harness()
  h.get('#relationshipEditor').innerHTML = 'editor'
  h.run('closeRelationshipEditor()')
  assert.equal(h.get('#relationshipEditor').innerHTML, '')
  assert.equal(h.get('[data-action="relationship-new"]').focused, true)
})

test('Memory refresh preserves the relationship form DOM and current focus', async () => {
  const h = harness(), content = element(), profile = element(), panel = h.get('#panelMemory')
  panel.innerHTML = 'relationship controls remain mounted'
  panel.querySelector = (selector) => selector === '#memoryContents' ? content : null
  h.document.activeElement = profile
  h.run(`api = async (path) => path === 'memory' ? {stats:{},core:'new memory',observations:[]} : path === 'dream' ? {loops:[]} : path === 'memory/forgetting' ? {items:[]} : {screen:{enabled:false}}`)
  await h.run('renderMemoryPanel()')
  assert.equal(panel.innerHTML, 'relationship controls remain mounted')
  assert.equal(h.document.activeElement, profile)
  assert.match(content.innerHTML, /new memory/)
})

test('memory gate notice refreshes independently without replacing drafts', () => {
  const h = harness()
  h.get('#relationshipBody').innerHTML = 'mounted unsaved forms'
  h.run('S.boot = {config:{memory:{enabled:true,inject:false}}}; updateRelationshipAvailability()')
  assert.equal(h.get('#relationshipAvailability').hidden, false)
  h.run('S.boot.config.memory.inject = true; updateRelationshipAvailability()')
  assert.equal(h.get('#relationshipAvailability').hidden, true)
  assert.equal(h.get('#relationshipBody').innerHTML, 'mounted unsaved forms')
})

test('stale load responses cannot restore relationship data after a wipe', async () => {
  const h = harness()
  let finish
  h.context.load = () => new Promise((resolve) => { finish = resolve })
  h.run('api = load')
  const request = h.run('loadRelationships()')
  h.run('RELATIONSHIPS.version++; RELATIONSHIPS.data = null; RELATIONSHIPS.loading = false')
  h.get('#relationshipBody').innerHTML = 'cleared'
  finish({ profile: { preferredName: 'private old name' }, people: [] })
  await request
  assert.equal(h.get('#relationshipBody').innerHTML, 'cleared')
  assert.equal(h.run('RELATIONSHIPS.data'), null)
})

test('delete failures preserve the card and offer retry with a readable error', async () => {
  const h = harness(), card = element(), button = element(), status = element()
  button.dataset.id = 'person_1'
  button.closest = () => card
  card.querySelector = () => status
  card.querySelectorAll = () => [button]
  h.context.button = button
  h.run('RELATIONSHIPS.data = {people:[{id:"person_1",name:"Alex"}]}; api = async () => { throw new Error("offline") }')
  await h.run('deleteRelationshipPerson(button)')
  assert.equal(status.textContent, 'offline')
  assert.equal(button.disabled, false)
  assert.equal(h.run('RELATIONSHIPS.data.people.length'), 1)
})

let failures = 0
for (const { name, run } of tests) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failures++; console.error(`✗ ${name}\n${error.stack}`) }
}
console.log(`${tests.length - failures}/${tests.length} relationship UI checks passed`)
if (failures) process.exitCode = 1
