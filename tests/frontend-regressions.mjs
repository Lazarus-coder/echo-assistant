#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Run the actual browser functions without booting a server or calling a model.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
const program = source.split('/* --------------------------------- start ----------------------------------- */')[0]
const tests = []
const test = (name, run) => tests.push({ name, run })

function element(value = '') {
  const listeners = new Map()
  return {
    value,
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    checked: true,
    style: {},
    dataset: {},
    children: [],
    selectedOptions: [{ textContent: 'Test model' }],
    scrollHeight: 100,
    scrollTop: 0,
    clientHeight: 100,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(callback)
    },
    async dispatch(name, event = {}) {
      for (const callback of listeners.get(name) ?? []) await callback(event)
    },
    setAttribute(name, next) { this[name] = next },
    querySelector() { return null },
    querySelectorAll() { return [] },
    matches() { return false },
    append(...children) { this.children.push(...children) },
    remove() { this.removed = true },
    focus() { this.focused = true },
    select() { this.selected = true },
    after() {},
    insertAdjacentHTML(_position, html) { this.innerHTML += html },
  }
}

function harness() {
  const nodes = new Map()
  const collections = new Map()
  const storage = new Map()
  const frames = new Map()
  const intervals = new Map()
  let nextFrame = 0
  let nextInterval = 0
  let desktop = true
  let coarsePointer = false
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element('2'))
    return nodes.get(selector)
  }
  const document = {
    ...element(),
    querySelector: get,
    querySelectorAll: (selector) => collections.get(selector) ?? [],
    createElement: () => element(),
    body: element(),
    documentElement: element(),
    hidden: false,
  }
  const context = vm.createContext({
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    matchMedia: (query) => ({ matches: query.includes('pointer: coarse') ? coarsePointer : desktop, addEventListener() {} }),
    addEventListener() {},
    innerHeight: 800,
    setTimeout() {},
    clearTimeout() {},
    setInterval(callback) {
      const id = ++nextInterval
      intervals.set(id, callback)
      return id
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (callback) => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    console,
  })
  vm.runInContext(program, context)
  return {
    context,
    get,
    collections,
    storage,
    document,
    setDesktop(value) { desktop = value },
    setCoarsePointer(value) { coarsePointer = value },
    run: (code, options) => vm.runInContext(code, context, options),
    async tickIntervals() {
      for (const callback of intervals.values()) await callback()
    },
    flushFrames() {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
    },
  }
}

test('unfinished table text renders without freezing', () => {
  const h = harness()
  const html = h.run('md("| unfinished table header")', { timeout: 250 })
  assert.match(html, /unfinished table header/)
})

test('tables retain separate header and data cells', () => {
  const h = harness()
  const text = '| Name | Value |\n| --- | --- |\n| alpha | beta |'
  const html = h.run(`md(${JSON.stringify(text)})`, { timeout: 250 })
  assert.equal((html.match(/<th>/g) ?? []).length, 2)
  assert.equal((html.match(/<td>/g) ?? []).length, 2)
  assert.match(html, /<td>alpha<\/td>/)
  assert.match(html, /<td>beta<\/td>/)
})

test('unmatched code placeholder is treated as text', () => {
  const h = harness()
  const html = h.run('md("\\u0000CODE99\\u0000")', { timeout: 250 })
  assert.match(html, /CODE99/)
})

test('settings save submits config and provider keys', async () => {
  const h = harness()
  const calls = []
  h.context.recordSettings = async (path, options) => { calls.push({ path, options }); return {} }
  h.run('api = recordSettings; boot = async () => {}; toast = () => {}')
  h.get('#setModel').value = 'test-model'
  h.get('#setImageModel').value = 'test-image'
  h.get('#setTemp').value = '0.4'
  h.get('#setSystem').value = 'A helpful assistant'
  h.get('#setBlocklist').value = 'Password Manager,Private Browser'
  h.get('#setExcludes').value = 'private，secret'
  h.get('#setQuietStart').value = '23:00'
  h.get('#setQuietEnd').value = '07:00'
  h.get('#setAttentionBudget').value = '14'
  h.get('#setAttentionGap').value = '120'
  h.collections.set('#panelSettings [data-order]', [{ checked: true, dataset: { order: 'custom' } }])
  h.collections.set('#panelSettings [data-pcfg]', [{ value: 'https://example.test/search', dataset: { pcfg: 'custom' } }])
  h.collections.set('#panelSettings [data-pkey]', [{ value: 'test-key', dataset: { pkey: 'TEST_API_KEY' } }])
  await h.run('saveSettings()')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, 'settings')
  assert.equal(calls[0].options.method, 'PATCH')
  const body = JSON.parse(JSON.stringify(calls[0].options.body))
  assert.equal(body.config.upstream.defaultModel, 'test-model')
  assert.equal(body.config.generation.temperature, 0.4)
  assert.equal(body.config.systemPrompt, 'A helpful assistant')
  assert.deepEqual(body.config.search.order, ['custom'])
  assert.equal(body.config.search.providers.custom.endpoint, 'https://example.test/search')
  assert.deepEqual(body.config.screen.blocklist, ['Password Manager', 'Private Browser'])
  assert.deepEqual(body.config.attention, { dailyBudget: 14, minGapSeconds: 120 })
  for (const key of ['media', 'memory', 'storage', 'companion', 'dream', 'proactive']) {
    assert.ok(body.config[key], `Missing settings section: ${key}`)
  }
  assert.deepEqual(body.env, { TEST_API_KEY: 'test-key' })
})

test('polish controls do not implicitly submit the composer', () => {
  const h = harness()
  h.run(`POLISH.last = { polished: "Improved draft", changed: true };
    POLISH.modes = { expand: { label: "Expand" } };
    renderPolishBox()`)
  const buttons = h.get('#polishBox').innerHTML.match(/<button\b[^>]*>/g) ?? []
  assert.ok(buttons.length >= 5)
  for (const button of buttons) assert.match(button, /\btype=["']button["']/)
})

test('saving unchanged memory profile preserves individual settings', async () => {
  const h = harness()
  const calls = []
  h.context.recordSettings = async (_path, options) => { calls.push(JSON.parse(JSON.stringify(options.body))); return {} }
  h.run(`api = recordSettings; boot = async () => {}; toast = () => {};
    S.boot = { config: { memory: { profile: "standard" } } }`)
  h.get('#setProfile').value = 'standard'
  h.get('#setExtract').checked = false
  await h.run('saveSettings()')
  assert.equal(Object.hasOwn(calls[0].config.memory, 'profile'), false)
  assert.equal(calls[0].config.memory.extract, false)
  h.get('#setProfile').value = 'deep'
  await h.run('saveSettings()')
  assert.equal(calls[1].config.memory.profile, 'deep')
})

test('polish response is ignored after changing conversation or draft', async () => {
  for (const change of ['conversation', 'draft']) {
    const h = harness()
    let finish
    h.context.pendingPolish = () => new Promise((resolve) => { finish = resolve })
    h.run(`api = pendingPolish; toast = () => {}; S.current = "first";
      S.boot = { config: { upstreamConfigured: true } }`)
    h.get('#input').value = 'Original draft'
    h.get('#polishBox').hidden = true
    const request = h.run('runPolish()')
    assert.equal(h.get('#polishBtn').disabled, true)
    if (change === 'conversation') h.run('S.current = "second"')
    else h.get('#input').value = 'New draft'
    finish({ ok: true, polished: 'Old polished draft' })
    await request
    assert.equal(h.run('POLISH.last'), null, change)
    assert.equal(h.get('#polishBox').hidden, true, change)
    assert.equal(h.get('#polishBtn').disabled, false, change)
    assert.equal(h.run('POLISH.running'), false, change)
  }
})

test('mobile sidebar scrim opens, dismisses, and closes after selection', async () => {
  const h = harness()
  h.setDesktop(false)
  h.get('#drawer').hidden = true
  h.get('#scrim').hidden = true
  h.get('#app').dataset.sidebar = 'closed'
  h.run('toggleSidebar()')
  assert.equal(h.get('#app').dataset.sidebar, 'open')
  assert.equal(h.get('#scrim').hidden, false)
  await h.get('#scrim').dispatch('click')
  assert.equal(h.get('#app').dataset.sidebar, 'closed')
  assert.equal(h.get('#scrim').hidden, true)
  assert.equal(h.get('.topbar [data-action="toggle-sidebar"]').focused, true, 'Dismissing the sidebar returns focus to its menu button')
  assert.notEqual(h.get('#input').focused, true, 'Closing navigation must not open a phone keyboard')

  h.run(`api = async () => ({ id: "selected", title: "Selected" });
    renderConvs = () => {};
    renderThread = () => {};
    renderPolishBox = () => {};
    autogrow = () => {};
    S.boot = { config: { defaultModel: "test-model" } };
    toggleSidebar()`)
  await h.run('selectConv("selected")')
  assert.equal(h.get('#app').dataset.sidebar, 'closed')
  assert.equal(h.get('#scrim').hidden, true)
  assert.equal(h.get('#convTitle').focused, true, 'Selection moves focus out of the closed mobile sidebar')

  h.run('renderSettingsPanel = async () => {}; toggleSidebar()')
  await h.run('openPanel("settings")')
  assert.equal(h.get('#app').dataset.sidebar, 'closed', 'Sidebar must not cover the settings drawer')
  assert.equal(h.get('#drawer').hidden, false)
  assert.equal(h.get('#scrim').hidden, false)
})

test('auth checkbox changes persist and failed updates restore the toggle', async () => {
  for (const success of [true, false]) {
    const h = harness()
    const calls = []
    let finish
    let fail
    h.context.updateAuth = (path, options) => {
      calls.push({ path, options })
      return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    }
    h.run(`api = updateAuth; boot = async () => {};
      renderSettingsPanel = async () => {}; toast = () => {}`)
    const input = h.get('#setAuthRequired')
    input.id = 'setAuthRequired'
    input.checked = true
    const request = h.document.dispatch('change', { target: input })
    assert.equal(calls.length, 1, 'The checkbox must have an active change handler')
    assert.equal(calls[0].path, 'auth')
    assert.equal(calls[0].options.method, 'PATCH')
    assert.equal(calls[0].options.body.required, true)
    assert.equal(input.disabled, true, 'Prevent repeated updates while saving')
    if (success) finish({ required: true })
    else fail(new Error('Could not save'))
    await request
    assert.equal(input.checked, success)
    assert.equal(input.disabled, false)
  }
})

test('auth toggle stays saved when only the subsequent refresh fails', async () => {
  const h = harness()
  h.run(`api = async () => ({ required: true });
    boot = async () => { throw new Error("Refresh failed") };
    toast = () => {}`)
  const input = h.get('#setAuthRequired')
  input.id = 'setAuthRequired'
  input.checked = true
  await h.document.dispatch('change', { target: input })
  assert.equal(input.checked, true)
  assert.equal(input.disabled, false)
})

test('slower conversation load cannot replace the latest selection', async () => {
  const h = harness()
  const pending = new Map()
  h.context.fetchConversation = (path) => new Promise((resolve) => pending.set(path, resolve))
  h.run(`api = fetchConversation;
    renderConvs = () => {};
    renderThread = () => {};
    renderPolishBox = () => {};
    autogrow = () => {};
    S.boot = { config: { defaultModel: "test-model" } };
    S.current = "initial";
    S.conv = { id: "initial" }`)
  const first = h.run('selectConv("first")')
  const second = h.run('selectConv("second")')
  pending.get('conversations/second')({ id: 'second', title: 'Second' })
  await second
  pending.get('conversations/first')({ id: 'first', title: 'First' })
  await first
  assert.equal(h.run('S.current'), 'second')
  assert.equal(h.run('S.conv.id'), 'second')
  assert.equal(h.get('#convTitle').textContent, 'Second')
})

function streamHarness(events) {
  const h = harness()
  const messages = []
  h.context.makeMessage = () => {
    const node = element()
    const content = element()
    const parts = new Map([['.content', content], ['.meta', element()], ['.tail', element()]])
    node.querySelector = (selector) => {
      if (selector === '.err') return content.innerHTML.includes('class="err"') ? element() : null
      return parts.get(selector) ?? null
    }
    messages.push({ node, content })
    return node
  }
  const bytes = new TextEncoder().encode(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''))
  h.context.fetch = async () => ({
    ok: true,
    body: { getReader() {
      let delivered = false
      return { async read() {
        if (delivered) return { done: true }
        delivered = true
        return { done: false, value: bytes }
      } }
    } },
  })
  h.run(`messageNode = makeMessage;
    refreshList = async () => {};
    scrollBottom = () => {};
    toast = () => {};
    S.current = "test-conversation";
    S.boot = { config: { generation: {}, upstreamConfigured: true, defaultImageModel: "test-image" } };
    S.convs = [];
    S.att = []`)
  return { ...h, messages }
}

test('stream failures stay visible after finalization and delayed paint', async () => {
  const h = streamHarness([['delta', { text: 'Partial reply' }], ['error', { message: 'Model connection failed' }]])
  await h.run('startStream({ userText: "Hello" })')
  const content = h.messages.at(-1).content
  assert.match(content.innerHTML, /Model connection failed/)
  assert.equal(h.run('S.stream'), null)
  h.flushFrames()
  assert.match(content.innerHTML, /Model connection failed/)
  assert.doesNotMatch(content.innerHTML, /class="cursor"/)
})

test('delayed streaming paint cannot replace the completed response', async () => {
  const h = streamHarness([
    ['delta', { text: 'Partial reply' }],
    ['done', { message: { content: 'Completed reply' } }],
  ])
  await h.run('startStream({ userText: "Hello" })')
  h.flushFrames()
  const content = h.messages.at(-1).content
  assert.match(content.innerHTML, /Completed reply/)
  assert.doesNotMatch(content.innerHTML, /Partial reply|class="cursor"/)
})

test('stream metadata reconciles the user and assistant message IDs', async () => {
  const h = streamHarness([
    ['meta', { messageId: 'saved-assistant', userMessageId: 'saved-user' }],
    ['done', { message: { content: 'Completed reply' } }],
  ])
  await h.run('startStream({ userText: "Hello" })')
  assert.equal(h.messages[0].node.dataset.id, 'saved-user')
  assert.equal(h.messages[1].node.dataset.id, 'saved-assistant')
})

test('task feedback follows real tool events and preserves the final failed outcome', async () => {
  const tools = [{ id: 'step1', name: 'workspace_read', ok: false, status: 'failed', result: 'File missing' }]
  const h = streamHarness([
    ['meta', { messageId: 'assistant1', runId: 'run1' }],
    ['tool_call', { id: 'step1', name: 'workspace_read', label: '读取文件' }],
    ['tool_result', { id: 'step1', ok: false, status: 'failed', error: 'File missing' }],
    ['run_complete', { status: 'failed' }],
    ['done', { message: { runId: 'run1', runStatus: 'failed', tools, content: 'Could not read the file.' } }],
  ])
  const feedback = []
  h.context.capture = (_node, run) => feedback.push(JSON.parse(JSON.stringify(run)))
  h.run('updateRunFeedback = capture')
  await h.run('startStream({ userText: "Check the file" })')
  assert.ok(feedback.some((run) => run.status === 'running' && run.steps[0]?.label === '读取文件'))
  assert.equal(feedback.at(-1).status, 'failed')
  assert.equal(feedback.at(-1).steps[0].result, 'File missing')
})

test('a disconnected task keeps completed steps without inventing success or user cancellation', async () => {
  const h = streamHarness([
    ['meta', { runId: 'run1' }],
    ['tool_call', { id: 'step1', name: 'workspace_list' }],
    ['tool_result', { id: 'step1', ok: true, ms: 12, result: 'README.md' }],
  ])
  const feedback = []
  h.context.capture = (_node, run) => feedback.push(JSON.parse(JSON.stringify(run)))
  h.run('updateRunFeedback = capture')
  await h.run('startStream({ userText: "Check the project" })')
  assert.equal(feedback.at(-1).status, 'interrupted')
  assert.equal(feedback.at(-1).steps[0].status, 'completed')
  assert.match(feedback.at(-1).error, /连接中断/)
})

test('an error event uses the saved terminal snapshot for task counts and partial results', async () => {
  const message = { runId: 'run1', runStatus: 'failed', runError: 'Model failed after reading', content: 'Saved partial result', tools: [{ id: 'step1', name: 'workspace_read', ok: true, ms: 8 }] }
  const h = streamHarness([
    ['meta', { runId: 'run1' }],
    ['tool_call', { id: 'step1', name: 'workspace_read' }],
    ['error', { message: 'Model failed after reading', assistant: message }],
  ])
  const feedback = []
  h.context.capture = (_node, run) => feedback.push(JSON.parse(JSON.stringify(run)))
  h.run('updateRunFeedback = capture')
  await h.run('startStream({ userText: "Read the file" })')
  assert.equal(feedback.at(-1).steps[0].ok, true)
  assert.equal(feedback.at(-1).error, message.runError)
  assert.match(h.messages.at(-1).content.innerHTML, /Saved partial result/)
})

test('stop requests are single-flight and a late response cannot abort a newer browser stream', async () => {
  const h = harness(), old = new AbortController(), next = new AbortController()
  let finish, calls = 0
  h.context.old = old
  h.context.next = next
  h.context.stop = (path, options) => {
    calls++
    assert.equal(path, 'chat/stop')
    assert.equal(options.body.conversationId, 'old-conversation')
    return new Promise((resolve) => { finish = resolve })
  }
  h.run('api = stop; updateComposer = () => {}; S.stream = {conversationId:"old-conversation",ctrl:old}')
  const first = h.run('stopReply()')
  await h.run('stopReply()')
  assert.equal(calls, 1)
  h.run('S.stream = {conversationId:"new-conversation",ctrl:next}')
  finish({ stopped: true })
  await first
  assert.equal(old.signal.aborted, true)
  assert.equal(next.signal.aborted, false)
})

test('failed stop requests leave the task connected and allow an explicit retry', async () => {
  const h = harness(), ctrl = new AbortController()
  h.context.ctrl = ctrl
  h.run('updateComposer = () => {}; toast = () => {}; S.stream = {conversationId:"c",ctrl,status:"正在读取"}; api = async () => { throw new Error("Network offline") }')
  await h.run('stopReply()')
  assert.equal(ctrl.signal.aborted, false)
  assert.equal(h.run('S.stream.stopping'), false)
  assert.equal(h.run('S.stream.status'), '正在读取')
  h.run('api = async () => ({stopped:true})')
  await h.run('stopReply()')
  assert.equal(ctrl.signal.aborted, true)
  assert.equal(h.run('S.stream.stopRequested'), true)
})

test('a browser abort never turns a completed or unconfirmed task into a cancelled outcome', async () => {
  for (const completed of [false, true]) {
    const h = streamHarness([
      ['meta', { runId: 'run1' }],
      ['tool_call', { id: 'step1', name: 'workspace_list' }],
      ...(completed ? [['done', { message: { runStatus: 'completed', content: 'Done', tools: [{ id: 'step1', ok: true }] } }]] : []),
    ])
    const feedback = [], tails = []
    h.context.capture = (_node, run) => {
      feedback.push(JSON.parse(JSON.stringify(run)))
      h.run('S.stream?.ctrl.abort()')
    }
    h.context.captureTail = (_node, message) => tails.push(message)
    h.run('updateRunFeedback = capture; renderTail = captureTail')
    await h.run('startStream({ userText: "Check files" })')
    assert.equal(feedback.at(-1).status, completed ? 'completed' : 'interrupted')
    assert.equal(tails.at(-1).aborted, false)
  }
})

test('editing removes downstream messages only after successful truncation', async () => {
  for (const success of [true, false]) {
    const h = streamHarness([['done', { message: { content: 'Replacement reply' } }]])
    const existing = ['earlier', 'edited-user', 'old-answer', 'later-user'].map((id) => {
      const node = element()
      node.dataset.id = id
      return node
    })
    h.collections.set('#threadInner .msg', existing)
    let finish
    let fail
    h.context.truncate = () => new Promise((resolve, reject) => { finish = resolve; fail = reject })
    h.run('api = truncate')
    const request = h.run('startStream({ userText: "Edited", editId: "edited-user" })')
    assert.equal(h.run('S.preparing'), true)
    assert.ok(existing.every((node) => !node.removed), 'Keep history visible while saving')
    if (success) {
      finish({})
      await request
      assert.ok(!existing[0].removed, 'Messages before the edit must remain')
      assert.ok(existing.slice(1).every((node) => node.removed))
    } else {
      fail(new Error('Truncation failed'))
      await assert.rejects(request, /Truncation failed/)
      assert.ok(existing.every((node) => !node.removed), 'A failed edit must preserve visible history')
    }
    assert.equal(h.run('S.preparing'), false)
  }
})

test('generated images are displayed only in their original conversation', async () => {
  for (const switchConversation of [false, true]) {
    const h = streamHarness([])
    let finish
    h.context.generateImage = () => new Promise((resolve) => { finish = resolve })
    h.context.drawEvent = { target: { closest: () => ({ dataset: { action: 'draw' } }) } }
    h.run('api = generateImage')
    h.get('#input').value = 'Draw mountains'
    const request = h.run('handleAction(drawEvent)')
    if (switchConversation) h.run('S.current = "another-conversation"')
    finish({ message: { role: 'assistant', content: 'Generated image', images: [{ url: '/api/uploads/example.png' }] } })
    await request
    assert.equal(h.messages.length, switchConversation ? 0 : 1)
  }
})

test('composer enables sending only when a configured conversation has content and is ready', () => {
  const h = harness()
  h.run(`S.current = "current";
    S.boot = { config: { upstreamConfigured: true, media: {} } };
    S.att = []`)
  h.get('#input').value = '   '
  h.run('updateComposer()')
  assert.equal(h.get('#sendBtn').disabled, true, 'Whitespace alone is not a message')
  h.get('#input').value = 'Ready to send'
  h.run('updateComposer()')
  assert.equal(h.get('#sendBtn').disabled, false)

  for (const [change, restore, reason] of [
    ['S.current = null', 'S.current = "current"', 'No selected conversation'],
    ['S.boot.config.upstreamConfigured = false', 'S.boot.config.upstreamConfigured = true', 'Model endpoint needs setup'],
    ['S.stream = {}', 'S.stream = null', 'Reply is streaming'],
    ['S.selecting = Symbol()', 'S.selecting = null', 'Conversation is loading'],
    ['S.preparing = true', 'S.preparing = false', 'Another message is being prepared'],
    ['S.uploading = 1', 'S.uploading = 0', 'An attached image is being processed'],
    ['S.drawing = "current"', 'S.drawing = null', 'Image generation is in progress in this conversation'],
  ]) {
    h.run(`${change}; updateComposer()`)
    assert.equal(h.get('#sendBtn').disabled, true, reason)
    h.run(`${restore}; updateComposer()`)
    assert.equal(h.get('#sendBtn').disabled, false, `${reason}: controls recover when ready`)
  }

  h.get('#input').value = ''
  h.run('S.att = [{ name: "photo.png", dataUrl: "data:image/png;base64,test", bytes: 3 }]; updateComposer()')
  assert.equal(h.get('#sendBtn').disabled, false, 'An image can be sent without accompanying text')
  h.run('S.drawing = "another-conversation"; updateComposer()')
  assert.equal(h.get('#sendBtn').disabled, false, 'Image generation elsewhere must not block this conversation')
})

test('composer image actions reflect configured image capabilities', () => {
  const h = harness()
  h.run(`S.current = "current";
    S.boot = { config: { upstreamConfigured: true, defaultImageModel: "test-image", media: { imageInput: true, imageOutput: true } } };
    S.att = []`)
  h.get('#input').value = 'An illustrated landscape'
  h.run('updateComposer()')
  assert.equal(h.get('[data-action="attach"]').hidden, false)
  assert.equal(h.get('[data-action="draw"]').hidden, false)
  assert.equal(h.get('[data-action="draw"]').disabled, false)
  h.run('S.boot.config.media.imageInput = false; updateComposer()')
  assert.equal(h.get('[data-action="attach"]').hidden, true)
  assert.equal(h.get('[data-action="draw"]').hidden, false)
  h.run('S.boot.config.media.imageInput = true; S.boot.config.media.imageOutput = false; updateComposer()')
  assert.equal(h.get('[data-action="attach"]').hidden, false)
  assert.equal(h.get('[data-action="draw"]').hidden, true)
  h.run('S.boot.config.media.imageOutput = true; S.boot.config.defaultImageModel = ""; updateComposer()')
  assert.equal(h.get('[data-action="draw"]').hidden, true, 'Drawing needs an image model')
})

test('suggestions become editable drafts without submitting or discarding existing text', async () => {
  for (const original of ['', 'Existing draft']) {
    const h = harness()
    let submissions = 0
    h.get('#composer').requestSubmit = () => { submissions++ }
    h.context.suggestionEvent = {
      target: { closest: () => ({ dataset: { action: 'sug' }, textContent: 'Suggested question' }) },
    }
    h.run(`S.current = "current";
      S.boot = { config: { upstreamConfigured: true, media: {} } };
      startStream = () => { throw new Error("Suggestions must not send messages") }`)
    h.get('#input').value = original
    await h.run('handleAction(suggestionEvent)')
    const expected = original ? `${original}\nSuggested question` : 'Suggested question'
    assert.equal(h.get('#input').value, expected)
    assert.equal(h.storage.get('echo.draft.current'), expected, 'The suggestion is preserved as a draft')
    assert.equal(h.get('#input').focused, true, 'The user can edit immediately')
    assert.equal(submissions, 0)
  }
})

test('saving drafts preserves text and a separate attachment snapshot per conversation', () => {
  const h = harness()
  h.run(`S.current = "first";
    S.att = [{ name: "first.png", dataUrl: "data:image/png;base64,first", bytes: 5 }]`)
  h.get('#input').value = 'Unsent first draft'
  h.run('saveDraft()')
  assert.equal(h.storage.get('echo.draft.first'), 'Unsent first draft')
  assert.equal(h.run('S.attachmentDrafts.get("first")[0].name'), 'first.png')
  h.run('S.att.pop()')
  assert.equal(h.run('S.attachmentDrafts.get("first").length'), 1, 'Editing attachments must not mutate an already saved snapshot')
  h.run('S.current = null')
  h.get('#input').value = 'No conversation yet'
  h.run('saveDraft()')
  assert.equal(h.storage.has('echo.draft.null'), false)
})

test('switching conversations preserves and restores their own text and image drafts', async () => {
  const h = harness()
  h.run(`api = async (path) => ({ id: path.split("/").at(-1), messages: [] });
    renderConvs = () => {};
    renderThread = () => {};
    renderPolishBox = () => {};
    S.boot = { config: { upstreamConfigured: true, defaultModel: "test-model", media: {} } };
    S.current = "first";
    S.conv = { id: "first" };
    S.att = [{ name: "first.png", dataUrl: "data:image/png;base64,first", bytes: 5 }];
    S.attachmentDrafts.set("second", [{ name: "second.png", dataUrl: "data:image/png;base64,second", bytes: 6 }])`)
  h.get('#input').value = 'First conversation draft'
  h.storage.set('echo.draft.second', 'Second conversation draft')
  await h.run('selectConv("second")')
  assert.equal(h.get('#input').value, 'Second conversation draft')
  assert.equal(h.run('S.att[0].name'), 'second.png')
  assert.equal(h.storage.get('echo.draft.first'), 'First conversation draft')
  assert.equal(h.run('S.attachmentDrafts.get("first")[0].name'), 'first.png')

  h.get('#input').value = 'Updated second draft'
  h.run('S.att.splice(0)')
  await h.run('selectConv("first")')
  assert.equal(h.get('#input').value, 'First conversation draft')
  assert.equal(h.run('S.att[0].name'), 'first.png')
  assert.equal(h.storage.get('echo.draft.second'), 'Updated second draft')
  await h.run('selectConv("second")')
  assert.equal(h.get('#input').value, 'Updated second draft')
  assert.equal(h.run('S.att.length'), 0, 'Removed attachments must not reappear')
})

test('failed conversation loading leaves the active draft and attachments intact', async () => {
  const h = harness()
  h.run(`api = async () => { throw new Error("Could not load conversation") };
    S.boot = { config: { upstreamConfigured: true, media: {} } };
    S.current = "first";
    S.conv = { id: "first" };
    S.att = [{ name: "first.png", dataUrl: "data:image/png;base64,first", bytes: 5 }]`)
  h.get('#input').value = 'Do not lose this draft'
  await assert.rejects(h.run('selectConv("unavailable")'), /Could not load conversation/)
  assert.equal(h.run('S.current'), 'first')
  assert.equal(h.get('#input').value, 'Do not lose this draft')
  assert.equal(h.run('S.att[0].name'), 'first.png')
  assert.equal(h.run('S.selecting'), null)
})

test('new output follows the bottom only when the reader has chosen to follow', () => {
  const h = harness()
  const thread = h.get('#thread')
  thread.scrollHeight = 1200
  thread.clientHeight = 400
  thread.scrollTop = 600
  h.run('S.followOutput = false; scrollBottom()')
  assert.equal(thread.scrollTop, 600, 'Streaming must not move a reader away from earlier messages')
  h.run('S.followOutput = true; scrollBottom()')
  assert.equal(thread.scrollTop, 1200, 'Following continues as output grows')
  thread.scrollTop = 100
  h.run('S.followOutput = false; scrollBottom(true)')
  assert.equal(thread.scrollTop, 1200, 'Jumping to the latest output explicitly scrolls')
  assert.equal(h.run('S.followOutput'), true, 'Jumping to latest resumes following')
})

test('scroll position controls following and the jump-to-latest affordance', () => {
  const h = harness()
  const thread = h.get('#thread')
  thread.scrollHeight = 1000
  thread.clientHeight = 200
  for (const [scrollTop, follows] of [[721, true], [720, false], [0, false], [800, true]]) {
    thread.scrollTop = scrollTop
    h.run('updateScrollState()')
    assert.equal(h.run('S.followOutput'), follows, `Scroll distance ${800 - scrollTop}`)
    assert.equal(h.get('#jumpLatest').hidden, follows, `Jump control at scroll distance ${800 - scrollTop}`)
  }
  thread.scrollHeight = 200
  thread.scrollTop = 0
  h.run('updateScrollState()')
  assert.equal(h.run('S.followOutput'), true)
  assert.equal(h.get('#jumpLatest').hidden, true, 'A short conversation needs no jump control')
})

test('desktop Enter sends while touch Enter and composition preserve typing', async () => {
  const h = harness()
  let submissions = 0
  h.get('#composer').requestSubmit = () => { submissions++ }
  for (const [coarsePointer, keys, sends] of [
    [false, {}, true],
    [false, { shiftKey: true }, false],
    [false, { isComposing: true }, false],
    [true, {}, false],
    [true, { ctrlKey: true }, true],
    [true, { metaKey: true }, true],
    [true, { isComposing: true, ctrlKey: true }, false],
  ]) {
    h.setCoarsePointer(coarsePointer)
    let prevented = false
    const before = submissions
    await h.get('#input').dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true }, ...keys })
    assert.equal(submissions - before, sends ? 1 : 0, JSON.stringify({ coarsePointer, keys }))
    assert.equal(prevented, sends, 'Newline and IME keystrokes must retain their default behavior')
  }
})

test('copy uses the clipboard API and falls back without leaving hidden text behind', async () => {
  for (const mode of ['modern', 'unavailable', 'denied', 'fallback-failed']) {
    const h = harness()
    const copied = []
    const previous = element()
    h.document.activeElement = previous
    h.context.navigator = mode === 'unavailable' ? {} : {
      clipboard: { async writeText(text) {
        if (mode !== 'modern') throw new Error('Permission denied')
        copied.push(text)
      } },
    }
    h.document.execCommand = (command) => {
      assert.equal(command, 'copy')
      const area = h.document.body.children.at(-1)
      assert.equal(area.selected, true)
      copied.push(area.value)
      return mode !== 'fallback-failed'
    }
    const request = h.run('copyText("Code worth keeping")')
    if (mode === 'fallback-failed') await assert.rejects(request, /复制失败/)
    else await request
    assert.deepEqual(copied, ['Code worth keeping'])
    if (mode === 'modern') {
      assert.equal(h.document.body.children.length, 0, 'Modern clipboard needs no extra DOM')
    } else {
      assert.equal(h.document.body.children.at(-1).removed, true, 'Temporary copy field is always removed')
      assert.equal(previous.focused, true, 'Copying returns focus to the previous control')
    }
  }
})

test('drawer keyboard focus wraps and Escape returns to the composer', async () => {
  const h = harness()
  const drawer = h.get('#drawer')
  const controls = [element(), element()]
  for (const control of controls) {
    control.tabIndex = 0
    control.getClientRects = () => [{}]
  }
  drawer.querySelectorAll = () => controls
  drawer.contains = (node) => controls.includes(node)
  drawer.hidden = false
  for (const [active, shiftKey, expected] of [
    [controls[1], false, controls[0]],
    [controls[0], true, controls[1]],
    [element(), false, controls[0]],
  ]) {
    for (const control of controls) control.focused = false
    h.document.activeElement = active
    let prevented = false
    await h.document.dispatch('keydown', { key: 'Tab', shiftKey, target: active, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(expected.focused, true, 'Tab keeps keyboard focus inside the drawer')
  }
  await h.document.dispatch('keydown', { key: 'Escape', target: controls[0], preventDefault() {} })
  assert.equal(drawer.hidden, true)
  assert.equal(h.get('#input').focused, true)
  assert.equal(h.get('#scrim').hidden, true)
})

test('mobile sidebar conversation rows activate with Enter and Space', async () => {
  const h = harness()
  const selected = []
  h.setDesktop(false)
  h.get('#drawer').hidden = true
  h.get('#app').dataset.sidebar = 'open'
  h.context.recordSelection = async (id) => { selected.push(id) }
  h.run('selectConv = recordSelection')
  const row = element()
  row.dataset = { action: 'select-conv', id: 'chosen-conversation' }
  row.matches = (selector) => selector === '.conv[data-action="select-conv"]'
  for (const key of ['Enter', ' ']) {
    let prevented = false
    await h.document.dispatch('keydown', { key, target: row, preventDefault() { prevented = true } })
    assert.equal(prevented, true, `${JSON.stringify(key)} activates the row instead of scrolling`)
  }
  assert.deepEqual(selected, ['chosen-conversation', 'chosen-conversation'])

  const nestedButton = element()
  nestedButton.dataset = { action: 'export-conv', id: 'chosen-conversation' }
  await h.document.dispatch('keydown', { key: 'Enter', target: nestedButton, preventDefault() {} })
  assert.equal(selected.length, 2, 'A nested action retains its own keyboard behavior')
})

test('overlay inert state targets the main region without disabling a conversation row', () => {
  const h = harness()
  h.run(`S.current = "main";
    S.convs = [{ id: "main", title: "Main", isMain: true, updatedAt: "2026-10-20T00:00:00Z" }];
    renderConvs()`)
  const rowClasses = h.get('#convList').innerHTML.match(/<li class="([^"]*)"/)?.[1].split(/\s+/) ?? []
  assert.equal(rowClasses.includes('main'), false, 'Conversation styling must not collide with the main region class')

  const row = element()
  row.inert = false
  const main = h.get('main.main')
  main.inert = false
  h.document.querySelector = (selector) => selector === '.main' ? row : h.get(selector)
  h.setDesktop(false)
  h.get('#drawer').hidden = true
  h.get('#app').dataset.sidebar = 'open'
  h.run('syncScrim()')
  assert.equal(main.inert, true, 'Opening the mobile sidebar disables the background conversation')
  assert.equal(row.inert, false, 'The main conversation row remains selectable')
  assert.equal(h.get('#sidebar').inert, false)

  h.get('#app').dataset.sidebar = 'closed'
  h.run('syncScrim()')
  assert.equal(main.inert, false, 'Closing the sidebar restores the conversation')
  assert.equal(h.get('#sidebar').inert, true)

  h.get('#drawer').hidden = false
  h.get('#app').dataset.sidebar = 'open'
  h.run('syncScrim()')
  assert.equal(main.inert, true)
  assert.equal(h.get('#sidebar').inert, true, 'A drawer disables both background regions')
  assert.equal(row.inert, false, 'Inert belongs on a region, never on a matching row')
})

test('an image that finishes processing after switching stays with its original conversation', async () => {
  const h = harness()
  let finishImage
  h.context.pendingImage = () => new Promise((resolve) => { finishImage = resolve })
  h.run(`shrinkImage = pendingImage;
    api = async (path) => ({ id: path.split("/").at(-1), messages: [] });
    renderConvs = () => {};
    renderThread = () => {};
    renderPolishBox = () => {};
    S.boot = { config: { upstreamConfigured: true, defaultModel: "test-model", media: { imageInput: true } } };
    S.current = "original";
    S.conv = { id: "original" };
    S.att = [];
    S.attachmentDrafts.set("second", [{ name: "second.png", dataUrl: "data:image/png;base64,second", bytes: 6 }])`)
  h.get('#input').value = 'Original draft'
  h.storage.set('echo.draft.second', 'Second draft')
  const processing = h.run('addFiles([{ type: "image/png", name: "original.png" }])')
  assert.equal(h.run('S.uploading'), 1)
  await h.run('selectConv("second")')
  assert.equal(h.run('S.current'), 'second')
  assert.equal(h.run('S.att[0].name'), 'second.png')

  finishImage({ name: 'original.png', dataUrl: 'data:image/png;base64,original', bytes: 8 })
  await processing
  assert.equal(h.run('S.uploading'), 0)
  assert.equal(h.get('#input').value, 'Second draft')
  assert.equal(h.run('S.att.length'), 1)
  assert.equal(h.run('S.att[0].name'), 'second.png', 'A background upload must not attach to the newly selected conversation')
  assert.equal(h.run('S.attachmentDrafts.get("original")[0].name'), 'original.png')
  await h.run('selectConv("original")')
  assert.equal(h.get('#input').value, 'Original draft')
  assert.equal(h.run('S.att[0].name'), 'original.png', 'The completed image is available when returning to its draft')
})

test('background polling preserves inline edits before and during each network request', async () => {
  for (const editStage of ['before', 'bootstrap', 'conversation', 'none']) {
    const h = harness()
    const calls = []
    let editing = editStage === 'before'
    const editor = element('Unsent inline edit')
    h.document.querySelector = (selector) => selector === '.edit-box' ? editing ? editor : null : h.get(selector)
    let finishBootstrap
    let finishConversation
    let requestedConversation
    const conversationRequested = new Promise((resolve) => { requestedConversation = resolve })
    h.context.pollApi = (path) => {
      calls.push(path)
      if (path === 'bootstrap') return new Promise((resolve) => { finishBootstrap = resolve })
      assert.equal(path, 'conversations/current')
      requestedConversation()
      return new Promise((resolve) => { finishConversation = resolve })
    }
    let renders = 0
    h.context.recordThreadRender = () => { renders++ }
    h.run(`api = pollApi;
      renderConvs = () => {};
      renderThread = recordThreadRender;
      S.current = "current";
      S.convs = [{ id: "current", messageCount: 1 }];
      S.conv = { id: "current", messages: [{ content: "Original message" }] };
      startPolling()`)
    const poll = h.tickIntervals()
    if (editStage !== 'before') {
      assert.deepEqual(calls, ['bootstrap'])
      if (editStage === 'bootstrap') editing = true
      finishBootstrap({ config: { upstreamConfigured: true }, conversations: [{ id: 'current', messageCount: 2 }] })
      if (editStage !== 'bootstrap') {
        await conversationRequested
        if (editStage === 'conversation') editing = true
        finishConversation({ id: 'current', messages: [{ content: 'Replacement from server' }] })
      }
    }
    await poll
    if (editStage === 'none') {
      assert.equal(renders, 1, 'Normal polling still refreshes conversations')
      assert.equal(h.run('S.conv.messages[0].content'), 'Replacement from server')
    } else {
      assert.equal(renders, 0, `An edit opened ${editStage} must not be replaced`)
      assert.equal(h.run('S.conv.messages[0].content'), 'Original message')
      assert.equal(h.run('S.convs[0].messageCount'), 1, 'An interrupted refresh must not consume the pending arrival')
      assert.equal(editor.value, 'Unsent inline edit')
      assert.equal(calls.length, editStage === 'before' ? 0 : editStage === 'bootstrap' ? 1 : 2)
      editing = false
      const resumedCalls = []
      h.context.resumedPollApi = async (path) => {
        resumedCalls.push(path)
        return path === 'bootstrap'
          ? { config: { upstreamConfigured: true }, conversations: [{ id: 'current', messageCount: 2 }] }
          : { id: 'current', messages: [{ content: 'Replacement after edit' }] }
      }
      h.run('api = resumedPollApi')
      await h.tickIntervals()
      assert.deepEqual(resumedCalls, ['bootstrap', 'conversations/current'], 'Polling fetches the pending message after editing ends')
      assert.equal(renders, 1)
      assert.equal(h.run('S.conv.messages[0].content'), 'Replacement after edit')
    }
  }
})

function commitmentFormHarness(values, editor = { mode: 'edit' }) {
  const h = harness()
  const form = element()
  const status = element()
  const buttons = [element(), element()]
  form.values = values
  form.reportValidity = () => true
  form.querySelector = () => status
  form.querySelectorAll = () => buttons
  h.context.FormData = class {
    constructor(node) { this.values = node.values }
    get(key) { return this.values[key] ?? null }
  }
  const calls = []
  h.context.recordGoalApi = async (path, options) => { calls.push({ path, ...JSON.parse(JSON.stringify(options)) }); return {} }
  h.context.testForm = form
  h.context.testEditor = editor
  h.run('api = recordGoalApi; toast = () => {}; renderProactivePanel = async () => {}; COMMITMENTS.editor = testEditor')
  return { ...h, form, status, buttons, calls, save: () => h.run('saveCommitmentForm(testForm)') }
}

test('adopting a user message keeps exact source IDs and leaves memory scope unchecked', async () => {
  const h = harness()
  h.document.querySelector = (selector) => selector === '#commitmentForm' ? null : h.get(selector)
  h.get('#commitmentEditor').scrollIntoView = () => {}
  h.context.adoptButton = { dataset: { action: 'adopt-message' }, closest: () => ({ dataset: { id: 'user-message-17' } }) }
  h.run(`openPanel = async () => {};
    S.current = "conversation-4";
    S.conv = {messages: [{id: "user-message-17", role: "user", content: "<report> finish the draft"}]}`)
  await h.run('handleAction({target: {closest: () => adoptButton}})')
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(COMMITMENTS.editor.source)')), { conversationId: 'conversation-4', messageId: 'user-message-17' })
  const html = h.get('#commitmentEditor').innerHTML
  assert.match(html, /&lt;report&gt;/)
  const memory = html.match(/<input[^>]+name="memory"[^>]*>/)?.[0]
  assert.ok(memory)
  assert.doesNotMatch(memory, /\bchecked\b/)
})

test('goal form rejects invalid scope and automatic trigger prerequisites before sending', async () => {
  const base = { title: 'Report', successCriteria: 'Draft reviewed', nextAction: 'Prepare outline', watch: 'manual' }
  for (const [extra, expected] of [
    [{ watch: 'deadline' }, /截止日期/],
    [{ watch: 'source_change' }, /指定网页/],
    [{ urls: 'https://one.test\nhttps://two.test\nhttps://three.test\nhttps://four.test' }, /最多.*3/],
    [{ urls: 'javascript:alert(1)' }, /网页地址/],
    [{ urls: 'https://user:password@example.test' }, /登录信息/],
    [{ title: '   ' }, /填写目标/],
  ]) {
    const h = commitmentFormHarness({ ...base, ...extra })
    await h.save()
    assert.equal(h.calls.length, 0, 'Invalid goals must not reach the server')
    assert.match(h.status.textContent, expected)
    assert.equal(h.form.values.title, extra.title ?? 'Report', 'Validation retains the draft')
    assert.ok(h.buttons.every((button) => !button.disabled), 'Validation allows corrections')
  }
})

test('confirmed goal submission sends only opted-in scope and preserves attribution', async () => {
  const h = commitmentFormHarness(
    { title: ' Report ', successCriteria: ' Reviewed ', nextAction: ' Outline ', urls: 'https://example.test/a\nhttps://example.test/a', watch: 'source_change' },
    { mode: 'edit', source: { conversationId: 'conv-1', messageId: 'message-2' }, candidateLoopId: 'loop-3' },
  )
  await h.save()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].path, 'commitments')
  assert.equal(h.calls[0].method, 'POST')
  assert.deepEqual(h.calls[0].body.scope, { memory: false, urls: ['https://example.test/a'] })
  assert.deepEqual(h.calls[0].body.source, { conversationId: 'conv-1', messageId: 'message-2' })
  assert.equal(h.calls[0].body.candidateLoopId, 'loop-3')
  assert.equal(h.calls[0].body.title, 'Report')
  assert.equal(h.calls[0].body.watch.type, 'source_change')
})

test('completing a goal requires evidence and records result feedback only after completion', async () => {
  const invalid = commitmentFormHarness({ completionEvidence: '   ' }, { mode: 'complete', id: 'goal-1', preparationId: 'result-1' })
  await invalid.save()
  assert.equal(invalid.calls.length, 0)
  assert.match(invalid.status.textContent, /完成依据/)
  const valid = commitmentFormHarness({ completionEvidence: ' Final draft reviewed and delivered ' }, { mode: 'complete', id: 'goal-1', preparationId: 'result-1' })
  await valid.save()
  assert.equal(valid.calls.length, 2)
  assert.equal(valid.calls[0].path, 'commitments/goal-1')
  assert.deepEqual(valid.calls[0].body, { status: 'done', completionEvidence: 'Final draft reviewed and delivered' })
  assert.equal(valid.calls[1].path, 'feedback')
  assert.deepEqual(valid.calls[1].body, { commitmentId: 'goal-1', preparationId: 'result-1', signal: 'completed' })
})

test('goal refresh preserves the editor and focused card, then updates after focus moves', async () => {
  const h = harness()
  const panel = h.get('#panelProactive')
  const list = h.get('#commitmentList')
  const editor = h.get('#commitmentEditor')
  editor.innerHTML = '<form>Unsaved goal with cursor here</form>'
  panel.querySelector = () => list
  const card = element()
  card.dataset = { goalId: 'goal-1', signature: 'previous' }
  card.innerHTML = 'Earlier preparation state'
  const focused = element()
  h.document.activeElement = focused
  card.contains = (node) => node === focused
  list.querySelectorAll = () => [card]
  h.get('#commitmentCandidates').contains = () => false
  h.get('#proactiveOverview').contains = () => false
  h.context.goalRefreshApi = async (path) => path === 'commitments'
    ? { commitments: [{ id: 'goal-1', title: 'Draft', status: 'active', preparation: { state: 'ready' } }], preparations: [] }
    : path === 'dream' ? { loops: [] } : {}
  h.run('api = goalRefreshApi; renderProactiveOverview = () => {}')
  await h.run('renderProactivePanel({poll: true})')
  assert.equal(editor.innerHTML, '<form>Unsaved goal with cursor here</form>')
  assert.equal(card.innerHTML, 'Earlier preparation state', 'Polling must not replace the focused control')
  assert.equal(h.document.activeElement, focused)
  h.document.activeElement = null
  h.run('syncCommitmentCards()')
  assert.match(card.innerHTML, /已有准备结果/)
  assert.equal(editor.innerHTML, '<form>Unsaved goal with cursor here</form>')
})

test('prepared results distinguish citation checks from truth and timing from usefulness', () => {
  const h = harness()
  const html = h.run(`preparationHtml({
    id: "result-1", commitmentId: "goal-1", title: "Draft", content: "<script>unsafe</script>",
    evidence: [{id: "web1", label: "Source", source: "javascript:alert(1)", observedAt: "2026-10-20T01:00:00Z", excerpt: "<unsafe>"}],
    verification: {passed: true, checks: ["References checked"]},
    outcome: {signal: "unknown", timing: "wrong_time"}, assumptions: ["Needs confirmation"], question: "Which date?"
  })`)
  assert.match(html, /这不等于事实已经证实/)
  assert.match(html, /效果未知/)
  assert.doesNotMatch(html, /已反馈：unknown/)
  assert.match(html, /data-signal="wrong_time"[^>]*aria-pressed="true"/)
  assert.match(html, /Needs confirmation/)
  assert.match(html, /Which date\?/)
  assert.doesNotMatch(html, /<script>|href="javascript:/)
  assert.match(html, /&lt;unsafe&gt;/)
})

test('an open drawer closes the sidebar when resizing from desktop to mobile', () => {
  const h = harness()
  h.get('#app').dataset.sidebar = 'open'
  h.get('#drawer').hidden = false
  h.run('syncScrim()')
  assert.equal(h.get('#app').dataset.sidebar, 'open', 'Desktop may retain its sidebar layout')
  h.setDesktop(false)
  h.run('syncScrim()')
  assert.equal(h.get('#app').dataset.sidebar, 'closed', 'The mobile sidebar must not cover the drawer')
  assert.equal(h.get('#sidebar').inert, true)
  assert.equal(h.get('#scrim').hidden, false)
})

test('paused and finished goals do not claim preparation is pending or untouched', () => {
  const h = harness()
  for (const status of ['paused', 'done', 'cancelled']) {
    h.context.goalState = status
    const html = h.run(`commitmentHtml({
      id: "goal-1", title: "Report", status: goalState, revision: 2,
      preparation: {state: "idle"}, watch: {type: "deadline"}, deadline: "2099-12-31",
      completionEvidence: "Reviewed and sent"
    }, [{
      id: "prep-1", commitmentId: "goal-1", revision: 1,
      delivery: {status: "pending", expiresAt: "2099-12-31T00:00:00Z"},
      outcome: {signal: "completed"}, verification: {passed: true}
    }])`)
    assert.doesNotMatch(html, /尚未准备|等待合适时机|临近截止时准备/)
    assert.match(html, /当前不自动跟进/)
    if (status !== 'paused') {
      assert.doesNotMatch(html, /data-action="goal-prepare"|目标状态或内容已变化/)
      assert.match(html, /不再准备/)
    } else assert.match(html, /已暂停准备和提醒/)
    assert.match(html, /data-signal="completed"[^>]*aria-pressed="true"/)
  }
})

test('expired, disabled, and reviewed results never promise a later reminder', () => {
  const h = harness()
  for (const [delivery, enabled, expected] of [
    [{ status: 'pending', expiresAt: '2000-01-01T00:00:00Z' }, true, /提醒已过期，不会再推送/],
    [{ status: 'pending', expiresAt: '2099-01-01T00:00:00Z' }, false, /主动提醒已关闭/],
    [{ status: 'reviewed', expiresAt: '2099-01-01T00:00:00Z' }, true, /你已评阅这份结果，不再另行提醒/],
  ]) {
    h.context.resultDelivery = delivery
    h.context.remindersEnabled = enabled
    const html = h.run('preparationHtml({ id: "prep-1", commitmentId: "goal-1", goalStatus: "active", delivery: resultDelivery, proactiveEnabled: remindersEnabled })')
    assert.match(html, expected)
    assert.doesNotMatch(html, /等待合适时机|提醒有效至/)
  }
})

test('crediting an already completed goal preserves completion evidence without a second status change', async () => {
  const h = harness()
  const calls = []
  h.context.recordResultFeedback = async (path, options) => { calls.push({ path, ...JSON.parse(JSON.stringify(options)) }); return {} }
  h.context.completedButton = { dataset: { action: 'preparation-feedback', signal: 'completed', id: 'goal-1', preparationId: 'prep-1' } }
  h.run(`api = recordResultFeedback; renderProactivePanel = async () => {}; toast = () => {};
    showCommitmentEditor = () => { throw new Error("Must not request completion again") };
    COMMITMENTS.items = [{id: "goal-1", status: "done", completionEvidence: "Original verified delivery"}]`)
  await h.run('handleAction({target: {closest: () => completedButton}})')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, 'feedback')
  assert.equal(calls[0].body.signal, 'completed')
  assert.equal(h.run('COMMITMENTS.items[0].completionEvidence'), 'Original verified delivery')
})

test('goal evidence displays readable criteria instead of raw identifiers and JSON', () => {
  const h = harness()
  const html = h.run(`evidenceHtml({
    id: "goal1", source: "commitment:goal_opaque_123",
    excerpt: JSON.stringify({title: "Weekly <report>", successCriteria: "Ready for review", nextAction: "Outline findings", deadline: "2026-10-30"})
  })`)
  assert.match(html, /已确认目标/)
  assert.match(html, /\[goal1\]/)
  assert.match(html, /完成标准/)
  assert.match(html, /Ready for review/)
  assert.match(html, /Weekly &lt;report&gt;/)
  assert.doesNotMatch(html, /commitment:goal_opaque_123|"successCriteria"|"nextAction"/)
})

test('disabled goal actions regain their matching result or pause control after refresh', async () => {
  for (const action of ['preparation-feedback', 'goal-status']) {
    const h = harness()
    const before = element()
    before.dataset = action === 'preparation-feedback'
      ? { action, id: 'goal-1', preparationId: 'older-result', signal: 'accepted' }
      : { action, id: 'goal-1', status: 'paused' }
    let disabled = false
    Object.defineProperty(before, 'disabled', {
      get: () => disabled,
      set(value) { disabled = value; if (value) h.document.activeElement = h.document.body },
    })
    const other = element()
    other.dataset = { action: 'preparation-feedback', id: 'goal-1', preparationId: 'newer-result', signal: 'accepted' }
    const after = element()
    after.dataset = action === 'preparation-feedback'
      ? { ...before.dataset }
      : { action, id: 'goal-1', status: 'active' }
    after.focus = () => { h.document.activeElement = after }
    const card = element()
    card.dataset.goalId = 'goal-1'
    card.querySelectorAll = () => [other, after]
    h.get('#commitmentList').querySelectorAll = () => [card]
    h.get('#drawer').hidden = false
    h.document.activeElement = before
    h.context.goalActionButton = before
    h.run('S.panel = "proactive"; api = async () => ({}); renderProactivePanel = async () => {}; toast = () => {}')
    await h.run('handleAction({target: {closest: () => goalActionButton}})')
    assert.equal(h.document.activeElement, after, 'Restore the same artifact signal, or the replacement resume button')
    assert.equal(other.focused, undefined, 'Do not jump to the newest result with the same signal')
  }
})

test('goal action completion does not steal focus from a control chosen during the request', async () => {
  const h = harness()
  const editorInput = { isConnected: true }
  const button = element()
  button.dataset = { action: 'goal-status', id: 'goal-1', status: 'paused' }
  const replacement = element()
  replacement.dataset = { action: 'goal-status', id: 'goal-1', status: 'active' }
  const card = element()
  card.dataset.goalId = 'goal-1'
  card.querySelectorAll = () => [replacement]
  h.get('#commitmentList').querySelectorAll = () => [card]
  h.get('#drawer').hidden = false
  h.context.goalActionButton = button
  h.context.moveFocusDuringRequest = async () => { h.document.activeElement = editorInput; return {} }
  h.run('S.panel = "proactive"; api = moveFocusDuringRequest; renderProactivePanel = async () => {}; toast = () => {}')
  await h.run('handleAction({target: {closest: () => goalActionButton}})')
  assert.equal(h.document.activeElement, editorInput)
  assert.equal(replacement.focused, undefined)
})

let failures = 0
for (const { name, run } of tests) {
  try {
    await run()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures++
    console.error(`✗ ${name}\n  ${error.stack ?? error}`)
  }
}
console.log(`${tests.length - failures}/${tests.length} frontend regression checks passed`)
process.exitCode = failures ? 1 : 0
