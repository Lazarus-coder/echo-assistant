import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

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
    addEventListener() {}
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
try {
  await fs.writeFile(process.env.ECHO_CONFIG, '{}')
  const { companionStatus } = await import('../lib/companion.mjs')
  const hour = new Date().toISOString().slice(0, 13)
  await fs.writeFile(path.join(sandbox, 'state.json'), JSON.stringify({ companion: { hourly: { key: hour, count: 7 } } }))
  assert.equal((await companionStatus()).hourCount, 7, 'status reports the actual current hour budget usage')
  await fs.writeFile(path.join(sandbox, 'state.json'), JSON.stringify({ companion: { hourly: { key: '2000-01-01T00', count: 7 } } }))
  assert.equal((await companionStatus()).hourCount, 0, 'the previous hour does not count toward the current budget')
} finally {
  await fs.rm(sandbox, { recursive: true, force: true })
}
console.log('Companion regressions passed: streaming; composer state; scoped native authentication; hourly budget.')
