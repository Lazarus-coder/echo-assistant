import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-tool-cancel-'))
process.env.ECHO_DATA_DIR = path.join(sandbox, 'data')
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_CANCEL_TEST_KEY = 'local-test-only'
process.env.ECHO_CANCEL_TEST_URL = 'http://127.0.0.1:1/v1'
await fs.writeFile(process.env.ECHO_CONFIG, JSON.stringify({
  upstream: { apiKeyEnv: 'ECHO_CANCEL_TEST_KEY', baseUrlEnv: 'ECHO_CANCEL_TEST_URL', defaultModel: 'test', utilityModel: 'test', imageModels: [{ id: 'image-test' }], defaultImageModel: 'image-test' },
  search: { enabled: true, order: ['custom', 'gateway'], providers: { custom: { endpoint: 'https://93.184.216.34/search' } }, readPages: true },
  memory: { enabled: false }, screen: { enabled: false }, media: { imageOutput: true },
}))
const { loadConfig } = await import('../lib/config.mjs')
const { webFetch, webSearch, searchWithFallback } = await import('../lib/search.mjs')
const { generateImage, saveImage } = await import('../lib/media.mjs')
const { nativeSearch } = await import('../lib/native.mjs')
const { buildToolRegistry } = await import('../lib/tools.mjs')
const harness = await import('../lib/harness.mjs')
const cfg = await loadConfig()
const originalFetch = globalThis.fetch
const originalResolve4 = dns.Resolver.prototype.resolve4
const originalResolve6 = dns.Resolver.prototype.resolve6
const originalCancel = dns.Resolver.prototype.cancel
const originalWriteFile = fs.writeFile
const uploads = path.join(process.env.ECHO_DATA_DIR, 'uploads')
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const within = async (promise) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation did not finish promptly')), 1500) })]) }
  finally { clearTimeout(timer) }
}
const pendingBodies = new Set()
function blockedResponse(signal, type = 'text/plain') {
  assert.ok(signal, 'fetch must receive a signal')
  return new Response(new ReadableStream({
    start(controller) {
      pendingBodies.add(controller)
      const stop = () => {
        pendingBodies.delete(controller)
        controller.error(signal.reason)
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    },
    cancel() {},
  }), { headers: { 'content-type': type } })
}
async function uploadFiles() {
  return fs.readdir(uploads).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
}
async function cancelAtEntry(operation, entered, controller) {
  const rejected = assert.rejects(operation, { name: 'AbortError' })
  await within(entered.promise)
  controller.abort()
  await within(rejected)
}
function restoreDns() {
  dns.Resolver.prototype.resolve4 = originalResolve4
  dns.Resolver.prototype.resolve6 = originalResolve6
  dns.Resolver.prototype.cancel = originalCancel
}
const imageReply = () => new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://93.184.216.34/generated.png' }] } }] } }), { headers: { 'content-type': 'application/json' } })

try {
  await test('already cancelled web, gateway, and image operations make no network requests', async () => {
    const controller = new AbortController()
    controller.abort()
    let requests = 0
    globalThis.fetch = async () => { requests++; throw new Error('Unexpected fetch') }
    for (const operation of [
      () => webFetch('https://93.184.216.34/page', { signal: controller.signal }),
      () => webSearch('query', { signal: controller.signal }),
      () => searchWithFallback({ query: 'query', cfg, nativeSearch, signal: controller.signal }),
      () => nativeSearch('query', { signal: controller.signal }),
      () => generateImage({ prompt: 'test', model: 'image-test', signal: controller.signal }),
      () => saveImage({ dataUrl: 'data:image/png;base64,eA==', signal: controller.signal }),
    ]) await assert.rejects(operation(), { name: 'AbortError' })
    assert.equal(requests, 0)
    assert.deepEqual(await uploadFiles(), [])
  })

  await test('web fetch aborts an in-progress body and releases its reader', async () => {
    const controller = new AbortController()
    const entered = deferred()
    let receivedSignal, response
    globalThis.fetch = async (_, options) => {
      receivedSignal = options.signal
      response = blockedResponse(options.signal, 'text/html')
      entered.resolve()
      return response
    }
    await cancelAtEntry(webFetch('https://93.184.216.34/page', { signal: controller.signal }), entered, controller)
    assert.equal(receivedSignal.aborted, true)
    assert.equal(response.body.locked, false)
  })

  await test('web fetch cancels pending DNS resolution before any HTTP request', async () => {
    const controller = new AbortController()
    const entered = deferred()
    const lookups = new WeakMap()
    let cancelled = 0, requests = 0
    const pending = function () {
      return new Promise((_, reject) => {
        const items = lookups.get(this) ?? []
        items.push(reject)
        lookups.set(this, items)
        if (items.length === 2) entered.resolve()
      })
    }
    dns.Resolver.prototype.resolve4 = pending
    dns.Resolver.prototype.resolve6 = pending
    dns.Resolver.prototype.cancel = function () {
      cancelled++
      for (const reject of lookups.get(this) ?? []) reject(new Error('DNS cancelled'))
    }
    globalThis.fetch = async () => { requests++; throw new Error('Unexpected HTTP request') }
    try {
      await cancelAtEntry(webFetch('https://example.com/page', { signal: controller.signal }), entered, controller)
      assert.equal(cancelled, 1)
      assert.equal(requests, 0)
    } finally { restoreDns() }
  })

  await test('cancelled parallel search neither retries nor records an engine failure', async () => {
    const controller = new AbortController()
    const entered = deferred()
    const engineFile = path.join(process.env.ECHO_DATA_DIR, 'memory', 'engines.json')
    await fs.mkdir(path.dirname(engineFile), { recursive: true })
    await fs.writeFile(engineFile, JSON.stringify({ engines: {} }))
    dns.Resolver.prototype.resolve4 = async () => ['93.184.216.34']
    dns.Resolver.prototype.resolve6 = async () => []
    let requests = 0
    globalThis.fetch = async (_, options) => {
      requests++
      if (requests === 2) entered.resolve()
      return blockedResponse(options.signal, 'text/html')
    }
    try {
      await cancelAtEntry(webSearch('query', { signal: controller.signal }), entered, controller)
      assert.equal(requests, 2)
      assert.deepEqual(JSON.parse(await fs.readFile(engineFile, 'utf8')), { engines: {} })
    } finally { restoreDns() }
  })

  await test('cancelled provider JSON prevents fallback but ordinary provider errors still fall back', async () => {
    const controller = new AbortController()
    const entered = deferred()
    let requests = 0, fallback = 0
    const gateway = async () => { fallback++; return { answer: 'Fallback result', sources: [] } }
    globalThis.fetch = async (_, options) => {
      requests++
      entered.resolve()
      return blockedResponse(options.signal, 'application/json')
    }
    await cancelAtEntry(searchWithFallback({ query: 'query', cfg, nativeSearch: gateway, signal: controller.signal }), entered, controller)
    assert.equal(requests, 1)
    assert.equal(fallback, 0)
    globalThis.fetch = async () => new Response('temporary failure', { status: 503 })
    const result = await searchWithFallback({ query: 'query', cfg, nativeSearch: gateway })
    assert.equal(result.provider, 'gateway')
    assert.equal(fallback, 1)
  })

  await test('gateway search forwards cancellation to Responses and does not start another provider', async () => {
    const controller = new AbortController()
    const entered = deferred()
    const gatewayCfg = { ...cfg, search: { ...cfg.search, order: ['gateway', 'custom'] } }
    const urls = []
    globalThis.fetch = async (url, options) => {
      urls.push(url)
      entered.resolve()
      return blockedResponse(options.signal, 'application/json')
    }
    await cancelAtEntry(searchWithFallback({ query: 'query', cfg: gatewayCfg, nativeSearch, signal: controller.signal }), entered, controller)
    assert.equal(urls.length, 1)
    assert.ok(urls[0].endsWith('/responses'))
  })

  await test('cancelling image generation stops the response body before any asset download', async () => {
    const controller = new AbortController()
    const entered = deferred()
    let requests = 0
    globalThis.fetch = async (_, options) => { requests++; entered.resolve(); return blockedResponse(options.signal, 'application/json') }
    await cancelAtEntry(generateImage({ prompt: 'test image', model: 'image-test', signal: controller.signal }), entered, controller)
    assert.equal(requests, 1)
    assert.deepEqual(await uploadFiles(), [])
  })

  await test('cancelling an image download stops its body without retrying or saving a partial upload', async () => {
    const controller = new AbortController()
    const entered = deferred()
    let requests = 0
    globalThis.fetch = async (_, options) => {
      if (++requests === 1) return imageReply()
      entered.resolve()
      return blockedResponse(options.signal, 'image/png')
    }
    await cancelAtEntry(generateImage({ prompt: 'test image', model: 'image-test', signal: controller.signal }), entered, controller)
    assert.equal(requests, 2)
    assert.deepEqual(await uploadFiles(), [])
  })

  await test('ordinary image download errors retain the existing single retry', async () => {
    let requests = 0
    globalThis.fetch = async () => ++requests === 1
      ? new Response('temporary failure', { status: 503 })
      : new Response(Buffer.from('fake png'), { headers: { 'content-type': 'image/png' } })
    const saved = await saveImage({ url: 'https://93.184.216.34/image.png' })
    assert.equal(requests, 2)
    assert.equal(await fs.readFile(path.join(uploads, saved.file), 'utf8'), 'fake png')
    await fs.rm(path.join(uploads, saved.file))
  })

  await test('cancellation during a local image write removes its partial file', async () => {
    const controller = new AbortController()
    fs.writeFile = async (file, content, options) => {
      if (String(file).startsWith(uploads + path.sep)) {
        await originalWriteFile(file, 'partial')
        controller.abort()
      }
      return originalWriteFile(file, content, options)
    }
    try {
      await assert.rejects(saveImage({ dataUrl: 'data:image/png;base64,eA==', signal: controller.signal }), { name: 'AbortError' })
      assert.deepEqual(await uploadFiles(), [])
    } finally { fs.writeFile = originalWriteFile }
  })

  await test('harness Stop reaches web first-page reads and image downloads through the tool registry', async () => {
    for (const name of ['web_search', 'image_gen']) {
      const entered = deferred()
      const controller = new AbortController()
      const run = await harness.startRun({ conversationId: 'test_conversation', messageId: 'test_message', signal: controller.signal })
      const registry = buildToolRegistry({ cfg, run, conversationId: 'test_conversation' })
      let requests = 0
      globalThis.fetch = async (_, options) => {
        if (++requests === 1) return name === 'image_gen'
          ? imageReply()
          : new Response(JSON.stringify({ results: [{ title: 'Result', url: 'https://93.184.216.34/page', snippet: 'test' }] }), { headers: { 'content-type': 'application/json' } })
        entered.resolve()
        return blockedResponse(options.signal, name === 'image_gen' ? 'image/png' : 'text/html')
      }
      try {
        await cancelAtEntry(registry.call(name, name === 'image_gen' ? { prompt: 'test image' } : { query: 'test' }), entered, controller)
        assert.equal(requests, 2)
        assert.deepEqual(await uploadFiles(), [])
      } finally { await run.finish('cancelled') }
    }
  })
} finally {
  globalThis.fetch = originalFetch
  fs.writeFile = originalWriteFile
  restoreDns()
  harness.cancelHarnessRuns('Test cleanup')
  for (const controller of pendingBodies) { try { controller.error(new DOMException('Test cleanup', 'AbortError')) } catch {} }
  delete process.env.ECHO_CANCEL_TEST_KEY
  delete process.env.ECHO_CANCEL_TEST_URL
  await fs.rm(sandbox, { recursive: true, force: true })
}
