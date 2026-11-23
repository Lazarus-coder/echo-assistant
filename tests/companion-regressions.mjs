import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { mock } from 'node:test'

// Exercise the mini window without a browser, server, or model connection.
const miniSource = (await fs.readFile(new URL('../public/mini.js', import.meta.url), 'utf8')).replace(/\ninit\(\)\s*$/, '')
function miniWindow(response, token) {
  class Element {
    children = []
    attributes = {}
    style = {}
    value = ''
    innerHTML = ''
    append(child) { this.children.push(child) }
    listeners = {}
    addEventListener(name, listener) { this.listeners[name] = listener }
    setAttribute(name, value) { this.attributes[name] = value }
    querySelector(selector) {
      this.parts ??= {}
      return this.parts[selector] ??= new Element()
    }
  }
  const document = new Element()
  document.createElement = () => new Element()
  const paints = new Map()
  const requests = []
  let frameId = 0
  const context = vm.createContext({
    document,
    __echoLocalToken: token,
    location: { search: '?b=test', pathname: '/mini.html' },
    URLSearchParams, AbortController, TextDecoder,
    fetch: async (url, options) => {
      requests.push({ url, ...options })
      if (url === '/api/chat') {
        assert.equal(document.querySelector('#send').disabled, true, 'sending is disabled while a reply is pending')
        assert.equal(document.querySelector('#send').textContent, '回复中…')
      }
      return response
    },
    requestAnimationFrame: (callback) => { paints.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id) => paints.delete(id),
  })
  vm.runInContext(miniSource, context)
  assert.equal(Object.hasOwn(context, '__echoLocalToken'), false, 'native credential is removed from the global object')
  assert.equal(document.querySelector('[data-act="open-main"]').disabled, true, 'unavailable conversation cannot be opened')
  vm.runInContext('conversationId = "test"; updateComposer()', context)
  return {
    document,
    paints,
    requests,
    api: (expression) => vm.runInContext(expression, context),
    send: () => vm.runInContext('send("hello")', context),
    assistant: () => document.querySelector('#thread').children.at(-1),
  }
}

function events(...frames) {
  return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

{
  const page = miniWindow(Response.json({ outcome: { timing: 'wrong_time' } }))
  const tail = page.api('renderMessage({role:"assistant", id:"intro", companion:{bubbleId:"test"}})').querySelector('.tail')
  assert.match(tail.innerHTML, /data-feedback-message="intro"/)
  const group = page.document.querySelector('fieldset')
  group.dataset = { feedbackMessage: 'intro' }
  const timing = group.querySelector('button')
  timing.dataset = { signal: 'wrong_time' }
  timing.closest = () => group
  group.querySelectorAll = () => [timing]
  await page.document.listeners.click({ target: { closest: () => timing } })
  assert.equal(page.requests[0].url, '/api/feedback')
  assert.deepEqual(JSON.parse(page.requests[0].body), { signal: 'wrong_time', conversationId: 'test', messageId: 'intro' })
  assert.equal(timing.attributes['aria-pressed'], 'true')
  assert.match(group.querySelector('[role="status"]').textContent, /已保存/)
  assert.match(page.api('renderMessage({role:"assistant", id:"intro", companion:{bubbleId:"test"}, feedbackTiming:"good_time"})').querySelector('.tail').innerHTML, /data-signal="good_time" aria-pressed="true"/)
}

{
  const page = miniWindow(Response.json({ outcome: { utility: 'bad' } }))
  const group = page.document.querySelector('fieldset')
  group.dataset = { feedbackMessage: 'intro' }
  const buttons = ['good', 'bad'].map((signal) => {
    const button = group.querySelector(signal)
    button.dataset = { signal }
    button.closest = () => group
    return button
  })
  group.querySelectorAll = () => buttons
  await page.document.listeners.click({ target: { closest: () => buttons[1] } })
  assert.deepEqual(JSON.parse(page.requests[0].body), { signal: 'bad', conversationId: 'test', messageId: 'intro' })
  assert.deepEqual(buttons.map((b) => b.attributes['aria-pressed']), ['false', 'true'])
  assert.equal(group.disabled, false, 'a saved usefulness vote can be corrected')
}

{
  const page = miniWindow(events(['delta', { text: 'partial' }], ['done', { message: { content: 'complete' } }]))
  await page.send()
  assert.equal(page.assistant().querySelector('.content').innerHTML, 'complete')
  assert.equal(page.paints.size, 0, 'a delayed animation must not restore the streaming cursor')
  assert.equal(page.document.querySelector('#thread').attributes['aria-busy'], 'false')
  assert.equal(page.document.querySelector('#send').textContent, '发送')
  assert.equal(page.requests[0].headers['x-echo-local'], undefined, 'ordinary browser sessions do not send a native credential')
}
{
  const token = 'test-native-token'
  const page = miniWindow(events(['done', { message: { content: 'authenticated reply' } }]), token)
  await page.send()
  const request = page.requests[0]
  assert.equal(request.headers['x-echo-local'], token, 'native chat requests authenticate with the local token')
  assert.equal(request.url, '/api/chat')
  assert.equal(request.redirect, 'error', 'redirects must not forward the native token')
  assert.equal(request.url.includes(token) || request.body.includes(token), false, 'native credential stays out of URLs and request bodies')
  for (const expression of ['api("conversations/test")', 'api("companion/test/open", { method: "POST", body: {} })']) {
    const apiPage = miniWindow(Response.json({ ok: true }), token)
    await apiPage.api(expression)
    assert.equal(apiPage.requests[0].headers['x-echo-local'], token, 'both read and write APIs authenticate')
    assert.equal(apiPage.requests[0].redirect, 'error')
    assert.ok(apiPage.requests[0].url.startsWith('/api/'))
  }
}
{
  const page = miniWindow(events(['delta', { text: 'useful partial answer' }], ['error', { message: 'Model is unavailable' }]))
  await page.send()
  assert.equal(page.assistant().querySelector('.content').innerHTML, 'useful partial answer')
  assert.match(page.assistant().querySelector('.tail').innerHTML, /Model is unavailable/)
  assert.equal(page.paints.size, 0)
}
{
  const page = miniWindow(new Response(JSON.stringify({ message: 'This conversation is busy' }), { status: 409 }))
  await page.send()
  assert.match(page.assistant().querySelector('.tail').innerHTML, /This conversation is busy/)
}
{
  const page = miniWindow(events(['delta', { text: 'incomplete reply' }]))
  await page.send()
  assert.equal(page.assistant().querySelector('.content').innerHTML, 'incomplete reply')
  assert.match(page.assistant().querySelector('.tail').innerHTML, /连接已中断/)
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-companion-regressions-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_COMPANION_TEST_KEY = 'fixture-only'
process.env.ECHO_COMPANION_TEST_URL = 'https://model.invalid/v1'
const originalFetch = globalThis.fetch
try {
  const config = {
    upstream: { apiKeyEnv: 'ECHO_COMPANION_TEST_KEY', baseUrlEnv: 'ECHO_COMPANION_TEST_URL' },
    companion: { enabled: true }, memory: { enabled: false },
    proactive: { quietHours: { start: '00:00', end: '00:00' } },
    screen: { enabled: false, blocklist: ['Vault'], excludeTitlePatterns: ['private.project'] },
  }
  await fs.writeFile(process.env.ECHO_CONFIG, JSON.stringify(config))
  const { companionStatus, ingestFrame, setCompanion, pendingBubbles, openBubble } = await import('../lib/companion.mjs')
  const { applyFeedback } = await import('../lib/agency.mjs')
  const { saveConfig } = await import('../lib/config.mjs')
  const { readState, writeState } = await import('../lib/store.mjs')
  const hour = new Date().toISOString().slice(0, 13)
  await fs.writeFile(path.join(sandbox, 'state.json'), JSON.stringify({ companion: { hourly: { key: hour, count: 7 } } }))
  assert.equal((await companionStatus()).hourCount, 7, 'status reports the actual current hour budget usage')
  await fs.writeFile(path.join(sandbox, 'state.json'), JSON.stringify({ companion: { hourly: { key: '2000-01-01T00', count: 7 } } }))
  assert.equal((await companionStatus()).hourCount, 0, 'the previous hour does not count toward the current budget')

  const requests = []
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://model.invalid/v1/chat/completions')
    requests.push(options.body)
    return Response.json({ choices: [{ message: { content: '{"speak":false}' } }] })
  }
  const stateBefore = await fs.readFile(path.join(sandbox, 'state.json'), 'utf8')
  const frame = { app: 'Editor', title: 'Draft', text: 'Prepare a checklist for the upcoming product demonstration.' }
  for (const [fields, reason] of [
    [{ app: 'My Vault' }, 'blocklist:Vault'],
    [{ title: 'Private project notes' }, 'pattern:private.project'],
    [{ text: 'Confidential private project details appear in the OCR output only.' }, 'pattern:private.project'],
    [{ app: 'WeChat' }, 'sensitive_frame'],
    [{ text: 'Meeting agenda for the morning review.\nVerification code: 012345' }, 'sensitive_frame'],
    [{ app: 'Excel', text: 'A window with ordinary text and a number of unrelated menu labels.' }, 'no_screen_cue'],
    [{ text: 'Use the comparison table below.\nCheck the original source before including a statistic.' }, 'ambiguous_screen'],
  ]) {
    assert.equal((await ingestFrame({ ...frame, ...fields })).skipped, reason)
  }
  assert.equal(requests.length, 0, 'excluded frames never reach the model')
  assert.equal(await fs.readFile(path.join(sandbox, 'state.json'), 'utf8'), stateBefore, 'excluded frames cannot become the saved OCR baseline')
  assert.deepEqual((await fs.readdir(sandbox)).sort(), ['config.json', 'state.json'], 'excluded frames create no bubble or log files')
  assert.equal((await ingestFrame(frame)).skipped, 'decided_quiet')
  assert.equal(requests.length, 1, 'an allowed frame still reaches the fixture model')
  for (const speak of [false, true]) {
    for (const [reason, changePermission] of [
      ['blocklist:Editor', () => saveConfig({ screen: { blocklist: ['Editor'] } })],
      ['paused', () => setCompanion({ pauseMinutes: 30 })],
      ['disabled', () => saveConfig({ companion: { enabled: false } })],
      ['scenario_off', () => saveConfig({ companion: { scenarios: ['video'] } })],
    ]) {
      await saveConfig({ screen: { blocklist: [] }, companion: { enabled: true, scenarios: ['work'] } })
      await writeState({ companion: {} })
      globalThis.fetch = async (url) => {
        assert.equal(url, 'https://model.invalid/v1/chat/completions')
        await changePermission()
        const reply = { speak, scenario: 'work', quote: 'checklist', bubble: 'A late suggestion' }
        return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] })
      }
      assert.equal((await ingestFrame(frame)).skipped, reason)
      assert.equal((await readState()).companion.lastFrameText, undefined)
      assert.deepEqual(await pendingBubbles(), [])
    }
  }

  await saveConfig({
    attention: { style: 'balanced', minGapSeconds: 0 },
    companion: { enabled: true, scenarios: ['code', 'work', 'browse', 'video'], minGapSeconds: 0 },
  })
  const mixed = {
    app: 'Editor', title: 'Unrelated window title',
    text: 'UNRELATED_SIDEBAR_SENTINEL\nTypeError: the date parser requires a nonempty string.\nAction items for the upcoming release.',
  }
  let wording = { speak: true, scenario: 'video', topic: 'Injected topic', quote: 'TypeError', bubble: 'Watch the next episode.' }
  requests.length = 0
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://model.invalid/v1/chat/completions')
    requests.push(JSON.parse(options.body))
    return Response.json({ choices: [{ message: { content: JSON.stringify(wording) } }] })
  }
  await writeState({})
  assert.equal((await ingestFrame(mixed)).skipped, 'unusable_wording', 'a renderer proposing a different scenario cannot publish')
  assert.equal(requests.length, 1)
  const prompt = JSON.parse(requests[0].messages[1].content)
  assert.deepEqual(prompt, { scenario: 'code', topic: '定位报错', evidence: 'TypeError: the date parser requires a nonempty string.' })
  assert.doesNotMatch(JSON.stringify(requests[0]), /UNRELATED_SIDEBAR|Unrelated window|Action items/)
  assert.deepEqual(await pendingBubbles(), [])

  await writeState({})
  wording = { speak: true, quote: 'Action items', bubble: 'Check the release tasks.' }
  assert.equal((await ingestFrame(mixed)).skipped, 'unusable_wording', 'a quote from the unselected part of the frame cannot ground a bubble')
  await writeState({})
  wording = { speak: true, quote: 'TypeError', bubble: 'Check the date parser input.', topic: 'Invented topic', why: 'Invented reason' }
  const selected = (await ingestFrame(mixed)).bubble
  assert.equal(selected.scenario, 'code')
  assert.equal(selected.topic, '定位报错')
  assert.equal(selected.selection.kind, 'code')
  assert.equal(selected.selection.source, 'screen')
  assert.equal(selected.excerpt, prompt.evidence)
  assert.doesNotMatch(JSON.stringify(selected), /UNRELATED_SIDEBAR|Invented/)
  assert.ok((await pendingBubbles()).some((b) => b.id === selected.id))
  await saveConfig({ companion: { scenarios: ['work'] } })
  assert.ok(!(await pendingBubbles()).some((b) => b.id === selected.id), 'turning a scene off also holds its pending native overlay')
  await saveConfig({ companion: { scenarios: ['code', 'work', 'browse', 'video'] } })
  assert.ok((await pendingBubbles()).some((b) => b.id === selected.id))
  const opened = await openBubble(selected.id)
  const intro = opened.conversation.messages[0]
  assert.deepEqual(intro.companion.selection, selected.selection)
  let n = requests.length
  assert.equal((await ingestFrame({ ...mixed, text: mixed.text.replace('SIDEBAR', 'MENU') })).skipped, 'unchanged')
  assert.equal(requests.length, n, 'changing irrelevant screen chrome is free')
  await applyFeedback({ conversationId: opened.conversationId, messageId: intro.id, kind: 'work', signal: 'bad' })
  // A later frame can revisit the same evidence after the hard timing holds have expired.
  await writeState({ agency: (await readState()).agency })
  assert.equal((await ingestFrame({ ...mixed, text: prompt.evidence })).skipped, 'feedback_suppressed')
  assert.equal(requests.length, n)
  wording = { speak: true, quote: 'Action items', bubble: 'Review the release tasks.' }
  const alternate = (await ingestFrame(mixed)).bubble
  assert.equal(alternate?.scenario, 'work', 'explicit feedback suppresses this anchor and lets another supported topic surface')
  assert.notEqual(alternate.selection.topicKey, selected.selection.topicKey)
  await applyFeedback({ conversationId: opened.conversationId, messageId: intro.id, signal: 'good' })
  await writeState({ agency: (await readState()).agency })
  wording = { speak: true, quote: 'TypeError', bubble: 'Check the date parser input.' }
  const corrected = (await ingestFrame(mixed)).bubble
  assert.equal(corrected?.selection.anchorId, selected.selection.anchorId, 'corrected feedback restores eligibility')
  assert.ok(corrected.selection.score > selected.selection.score)

  await writeState({})
  for (const subject of ['monthly totals', 'project dates']) {
    const item = (await ingestFrame({ ...mixed, text: 'TypeError: the parser expected a value for ' + subject + '.' })).bubble
    assert.ok(item)
    const chat = await openBubble(item.id)
    await applyFeedback({ conversationId: chat.conversationId, messageId: chat.conversation.messages[0].id, signal: 'bad' })
    await writeState({ agency: (await readState()).agency })
  }
  wording = { speak: true, quote: 'Action items', bubble: 'Review the release tasks.' }
  assert.equal((await ingestFrame(mixed)).bubble?.selection.kind, 'work', 'two distinct content votes can change the selected topic on a new screen')

  const medium = { ...frame, text: 'Use the comparison table to compare these two support plans.' }
  await writeState({})
  await saveConfig({ attention: { style: 'quiet' } })
  n = requests.length
  assert.equal((await ingestFrame(medium)).skipped, 'below_threshold')
  assert.equal(requests.length, n)
  await saveConfig({ attention: { style: 'engaged' } })
  wording = { speak: true, quote: 'comparison table', bubble: 'Check which support plan includes the needed service.' }
  assert.equal((await ingestFrame(medium)).bubble?.scenario, 'browse')
  assert.equal(requests.length, n + 1, 'the effective preset controls whether rendering is worthwhile')

  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    await writeState({})
    const workingProvider = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      globalThis.fetch = workingProvider
      requests.push(JSON.parse(options.body))
      return new Response('temporarily unavailable', { status: 503 })
    }
    n = requests.length
    assert.equal((await ingestFrame(mixed)).skipped, 'model_error')
    const failedCue = { ...mixed, text: prompt.evidence }
    const hold = await ingestFrame(failedCue)
    assert.equal(hold.skipped, 'wording_cooldown')
    assert.equal(Date.parse(hold.retryAt), Date.now() + 5 * 60000)
    assert.equal(requests.length, n + 1, 'immediate same-cue replay makes no request')
    wording = { speak: true, quote: 'Action items', bubble: 'Verify the release checklist.' }
    assert.equal((await ingestFrame(mixed)).bubble?.scenario, 'work', 'a different cue on the same frame can be rendered during the outage')
    mock.timers.tick(5 * 60000 - 1)
    assert.equal((await ingestFrame(mixed)).skipped, 'wording_cooldown')
    assert.equal(requests.length, n + 2)
    mock.timers.tick(1)
    wording = { speak: true, quote: 'TypeError', bubble: 'Inspect the parser input.' }
    assert.equal((await ingestFrame(mixed)).bubble?.scenario, 'code', 'the first cue recovers at the retry boundary')
    assert.equal((await ingestFrame(mixed)).skipped, 'unchanged')
    assert.equal(requests.length, n + 3, 'one failure and two distinct rendered cues consume three requests')
  } finally { mock.timers.reset() }
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
console.log('Companion regressions passed: mini chat, native authentication, screen selection, explicit feedback, grounded wording, timing, and replay.')
