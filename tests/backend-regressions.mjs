import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-backend-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_BACKEND_TEST_KEY = 'local-test-only'
process.env.ECHO_BACKEND_TEST_URL = 'http://127.0.0.1:1/v1'
await fs.writeFile(process.env.ECHO_CONFIG, JSON.stringify({
  upstream: { apiKeyEnv: 'ECHO_BACKEND_TEST_KEY', baseUrlEnv: 'ECHO_BACKEND_TEST_URL', defaultModel: 'test', utilityModel: 'test' },
  search: { enabled: false },
  memory: { enabled: false },
  screen: { enabled: false },
  media: { imageOutput: false },
}))

const { streamChat } = await import('../lib/upstream.mjs')
const { loadConfig, saveConfig } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const { updateDigest } = await import('../lib/context.mjs')
const { runTurn } = await import('../lib/chat.mjs')
const { webFetch } = await import('../lib/search.mjs')
const cfg = await loadConfig()
const originalFetch = globalThis.fetch
const encoder = new TextEncoder()
const delta = (text) => JSON.stringify({ choices: [{ delta: { content: text } }] })

async function collect(gen) {
  const events = []
  while (true) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

function streamingResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

async function seededConversation() {
  const conv = await store.createConversation()
  conv.messages = [
    { id: 'message_one', role: 'user', content: 'Original question' },
    { id: 'message_two', role: 'assistant', content: 'Original answer' },
  ]
  return store.saveConversation(conv)
}

try {
  await test('concurrent settings saves cannot undo a workspace permission revocation', async () => {
    await saveConfig({ harness: { enabled: true, allowShell: true } })
    await Promise.all([
      saveConfig({ harness: { enabled: false, allowShell: false } }),
      saveConfig({ generation: { temperature: 0.3 } }),
      saveConfig({ media: { maxEdge: 1024 } }),
    ])
    const saved = await loadConfig()
    assert.equal(saved.harness.enabled, false)
    assert.equal(saved.harness.allowShell, false)
    assert.equal(saved.generation.temperature, 0.3)
    assert.equal(saved.media.maxEdge, 1024)
  })

  await test('concurrent state updates preserve all writes and recover after a failed mutation', async () => {
    await store.writeState({ count: 0, commitments: [{ id: 'goal_one' }] })
    await Promise.all(Array.from({ length: 25 }, () => store.mutateState((state) => { state.count++ })))
    await assert.rejects(store.mutateState(() => { throw new Error('rejected update') }), /rejected update/)
    await store.mutateState((state) => { state.ready = true })
    const state = await store.readState()
    assert.equal(state.count, 25)
    assert.equal(state.commitments[0].id, 'goal_one')
    assert.equal(state.ready, true)
  })

  await test('background conversation appends preserve each message without duplicate delivery', async () => {
    const conv = await store.createConversation()
    const messages = Array.from({ length: 15 }, (_, i) => ({ id: `message_${i}`, role: 'assistant', content: String(i) }))
    await Promise.all(messages.map((message) => store.appendMessage(conv.id, message)))
    await store.appendMessage(conv.id, messages[0])
    assert.equal((await store.getConversation(conv.id)).messages.length, 15)
  })

  await test('outcome metrics count corrected votes once and separate timing from usefulness', async () => {
    const { metricsSummary } = await import('../lib/metrics.mjs')
    const events = [
      { kind: 'proactive', acted: true, kindOf: 'brief' },
      ...['accepted', 'incorrect', 'accepted', 'completed', 'wrong_time'].map((signal) => ({ kind: 'agency_outcome', interventionId: 'preparation:one', signal })),
      ...[1, 2].map(() => ({ kind: 'commitment_completed', commitmentId: 'goal_one' })),
    ]
    await fs.writeFile(path.join(sandbox, 'metrics.jsonl'), events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e })).join('\n'))
    const summary = await metricsSummary()
    assert.deepEqual(summary.proactive.byKind, { brief: 1 })
    assert.equal(summary.agency.ratedInterventions, 1)
    assert.equal(summary.agency.outcomes.completed, 1)
    assert.equal(summary.agency.outcomes.accepted, 0)
    assert.equal(summary.agency.outcomes.incorrect, 0)
    assert.equal(summary.agency.outcomes.wrong_time, 1)
    assert.equal(summary.agency.completedCommitments, 1)
  })

  await test('memory diagnostics read only the configured data directory', async () => {
    const { memoryStats } = await import('../lib/memory.mjs')
    await store.mutateState((state) => { state.dream = { at: '2026-01-02T03:04:05.000Z' } })
    assert.equal((await memoryStats()).lastDream, '2026-01-02T03:04:05.000Z')
  })

  await test('scoped source reads never follow a redirect outside the chosen URL', async () => {
    const visited = []
    globalThis.fetch = async (url) => {
      visited.push(url)
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })
    }
    await assert.rejects(webFetch('https://93.184.216.34/source', { allowRedirects: false }), /重定向/)
    assert.deepEqual(visited, ['https://93.184.216.34/source'])
  })

  await test('source reads stop at the configured response-size budget', async () => {
    globalThis.fetch = async () => new Response('x'.repeat(100), { headers: { 'content-type': 'text/plain' } })
    await assert.rejects(webFetch('https://93.184.216.34/source', { maxBytes: 32 }), /大小预算/)
  })

  await test('streaming accepts CRLF frames split across transport chunks', async () => {
    globalThis.fetch = async () => streamingResponse([
      `data: ${delta('你好')}\r`,
      `\n\r\n`,
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ])
    const { events, result } = await collect(streamChat({ body: { model: 'test' }, baseUrl: 'http://unused', apiKey: 'test' }))
    assert.equal(events.map((e) => e.text ?? '').join(''), '你好')
    assert.equal(result.content, '你好')
    assert.equal(result.finishReason, 'stop')
  })

  await test('streaming joins multiline SSE data', async () => {
    globalThis.fetch = async () => streamingResponse([
      'data: {"choices":[\ndata: {"delta":{"content":"multiline"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const { result } = await collect(streamChat({ body: { model: 'test' }, baseUrl: 'http://unused', apiKey: 'test' }))
    assert.equal(result.content, 'multiline')
  })

  await test('upstream error events are reported instead of returning an empty success', async () => {
    globalThis.fetch = async () => streamingResponse(['data: {"error":{"message":"Quota exhausted"}}\n\n'])
    await assert.rejects(collect(streamChat({ body: { model: 'test' }, baseUrl: 'http://unused', apiKey: 'test' })), /Quota exhausted/)
  })

  await test('DONE finishes the reply even when the provider leaves the connection open', { timeout: 1000 }, async () => {
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${delta('Complete')}\n\ndata: [DONE]\n\n`))
      },
      cancel() { cancelled = true },
    }))
    const { result } = await collect(streamChat({ body: { model: 'test' }, baseUrl: 'http://unused', apiKey: 'test' }))
    assert.equal(result.content, 'Complete')
    assert.equal(cancelled, true)
  })

  await test('an empty upstream response fails visibly after its retries', async () => {
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      return streamingResponse([])
    }
    await assert.rejects(collect(streamChat({ body: { model: 'test' }, baseUrl: 'http://unused', apiKey: 'test' })), /空响应/)
    assert.equal(requests, 3)
  })

  await test('stopping an in-progress reply retains the text already shown', async () => {
    const ctrl = new AbortController()
    globalThis.fetch = async (_, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${delta('Keep this partial answer')}\n\n`))
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      },
    }))
    const conv = await store.createConversation()
    let done
    for await (const event of runTurn({ conversationId: conv.id, userText: 'Question', signal: ctrl.signal })) {
      if (event.type === 'delta') ctrl.abort()
      if (event.type === 'done') done = event
    }
    assert.equal(done?.aborted, true)
    assert.equal(done?.message.content, 'Keep this partial answer')
    assert.equal((await store.getConversation(conv.id)).messages.at(-1).content, 'Keep this partial answer')
  })

  await test('successful replies persist each streamed fragment exactly once', async () => {
    globalThis.fetch = async () => streamingResponse([
      `data: ${delta('Hello')}\n\n`,
      `data: ${delta(' world')}\n\n`,
      'data: [DONE]\n\n',
    ])
    const conv = await store.createConversation()
    const { events } = await collect(runTurn({ conversationId: conv.id, userText: 'Question' }))
    assert.equal(events.find((e) => e.type === 'done')?.message.content, 'Hello world')
    const saved = await store.getConversation(conv.id)
    assert.equal(saved.messages.at(-1).content, 'Hello world')
    assert.equal(events.find((e) => e.type === 'meta')?.userMessageId, saved.messages[0].id)
  })

  await test('a late reply cannot restore a conversation cleared while it was generating', async () => {
    globalThis.fetch = async () => streamingResponse([
      `data: ${delta('A late answer')}\n\n`,
      'data: [DONE]\n\n',
    ])
    const conv = await store.createConversation()
    for await (const event of runTurn({ conversationId: conv.id, userText: 'Clear me' })) {
      if (event.type === 'delta') await store.mutateConversation(conv.id, (current) => { current.messages = [] })
    }
    assert.deepEqual((await store.getConversation(conv.id)).messages, [])
  })

  await test('a completed digest preserves messages and title updated while it was generated', async () => {
    const conv = await seededConversation()
    globalThis.fetch = async () => {
      await store.appendMessage(conv.id, { id: 'message_new', role: 'user', content: 'Follow-up' })
      await store.patchConversation(conv.id, { title: 'Updated title' })
      return Response.json({ choices: [{ message: { content: 'A useful summary' } }] })
    }
    const result = await updateDigest({ conv, cfg, force: true })
    const saved = await store.getConversation(conv.id)
    assert.equal(result.updated, true)
    assert.equal(saved.messages.at(-1).id, 'message_new')
    assert.equal(saved.title, 'Updated title')
    assert.equal(saved.digest.uptoIndex, 2)
  })

  await test('a digest generated for edited history is discarded', async () => {
    const conv = await seededConversation()
    globalThis.fetch = async () => {
      await store.truncateFrom(conv.id, 'message_one')
      await store.appendMessage(conv.id, { id: 'message_revised', role: 'user', content: 'Revised question' })
      return Response.json({ choices: [{ message: { content: 'Outdated summary' } }] })
    }
    const result = await updateDigest({ conv, cfg, force: true })
    const saved = await store.getConversation(conv.id)
    assert.equal(result.updated, false)
    assert.equal(saved.messages[0].id, 'message_revised')
    assert.ok(!saved.digest)
  })

  await test('editing summarized history invalidates its stale digest', async () => {
    const conv = await seededConversation()
    conv.digest = { text: 'Old summary', covers: conv.messages.map((m) => m.id), uptoIndex: 2 }
    await store.saveConversation(conv)
    const saved = await store.truncateFrom(conv.id, 'message_two')
    assert.ok(!saved.digest)
    assert.equal(saved.messages.length, 1)
  })

  await test('a pending digest does not restore a deleted conversation', async () => {
    const conv = await seededConversation()
    globalThis.fetch = async () => {
      await store.deleteConversation(conv.id)
      return Response.json({ choices: [{ message: { content: 'Deleted history' } }] })
    }
    assert.equal((await updateDigest({ conv, cfg, force: true })).updated, false)
    assert.equal(await store.getConversation(conv.id), null)
  })
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
