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
const { getRun } = await import('../lib/harness.mjs')
const { webFetch } = await import('../lib/search.mjs')
const { appendObservation, retrieve, readObservations } = await import('../lib/memory.mjs')
const { ingestScreenEvent, setScreenConfig } = await import('../lib/screen.mjs')
const { returnBrief } = await import('../lib/brief.mjs')
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
    const saved = (await store.getConversation(conv.id)).messages.at(-1)
    assert.deepEqual(saved, JSON.parse(JSON.stringify(done.message)))
    assert.equal(saved.runStatus, 'cancelled')
    const run = await getRun(saved.runId)
    assert.equal(run.status, saved.runStatus)
    assert.equal(run.error, saved.runError)
  })

  await test('successful replies persist each streamed fragment exactly once', async () => {
    globalThis.fetch = async () => streamingResponse([
      `data: ${delta('Hello')}\n\n`,
      `data: ${delta(' world')}\n\n`,
      'data: [DONE]\n\n',
    ])
    const conv = await store.createConversation()
    const { events } = await collect(runTurn({ conversationId: conv.id, userText: 'Question' }))
    const done = events.find((e) => e.type === 'done')
    assert.equal(done?.message.content, 'Hello world')
    const saved = await store.getConversation(conv.id)
    assert.deepEqual(saved.messages.at(-1), JSON.parse(JSON.stringify(done.message)))
    assert.equal(done.message.runStatus, 'completed')
    assert.equal(done.message.runError, undefined)
    assert.equal((await getRun(done.message.runId)).status, 'completed')
    assert.equal(events.find((e) => e.type === 'meta')?.userMessageId, saved.messages[0].id)
  })

  for (const partial of ['', 'Keep the partial result.']) {
    await test(`upstream failure persists its outcome ${partial ? 'after partial text' : 'before any text'}`, async () => {
      globalThis.fetch = async () => streamingResponse([
        ...(partial ? [`data: ${delta(partial)}\n\n`] : []),
        'data: {"error":{"message":"Model request rejected"}}\n\n',
      ])
      const conv = await seededConversation()
      const completed = []
      const snapshots = []
      const { events } = await collect(runTurn({
        conversationId: conv.id, userText: 'Continue',
        onToolEvent: (event) => {
          if (event.type === 'run_complete') {
            completed.push(event)
            snapshots.push(store.getConversation(conv.id))
          }
        },
      }))
      const failure = events.find((event) => event.type === 'error')
      const saved = (await store.getConversation(conv.id)).messages.at(-1)
      assert.equal(events.some((event) => event.type === 'done'), false)
      assert.equal(failure.message, 'Model request rejected')
      assert.equal(saved.role, 'assistant')
      assert.equal(saved.runStatus, 'failed')
      assert.equal(saved.runError, failure.message)
      assert.equal(saved.content, partial)
      assert.equal(saved.finalContent, partial)
      assert.equal(saved.toolsFinished, true)
      assert.deepEqual(saved, JSON.parse(JSON.stringify(failure.assistant)))
      const run = await getRun(saved.runId)
      assert.equal(run.status, saved.runStatus)
      assert.equal(run.error, saved.runError)
      assert.equal(completed.at(-1).status, saved.runStatus)
      assert.equal((await snapshots.at(-1)).messages.at(-1).runStatus, 'failed')
      assert.deepEqual((await store.getConversation(conv.id)).messages.slice(0, 2), conv.messages, 'legacy messages remain unchanged')
    })
  }

  await test('cancelling before the first model request persists a cancelled outcome', async () => {
    const controller = new AbortController()
    let requests = 0
    globalThis.fetch = async () => { requests++; throw new Error('Unexpected model request') }
    const conv = await store.createConversation()
    let done
    for await (const event of runTurn({ conversationId: conv.id, userText: 'Stop before generation', signal: controller.signal })) {
      if (event.type === 'meta') controller.abort()
      if (event.type === 'done') done = event
    }
    assert.equal(requests, 0)
    assert.equal(done.aborted, true)
    const saved = (await store.getConversation(conv.id)).messages.at(-1)
    assert.deepEqual(saved, JSON.parse(JSON.stringify(done.message)))
    assert.equal(saved.runStatus, 'cancelled')
    assert.equal((await getRun(saved.runId)).status, saved.runStatus)
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

  await test('malformed observation tags and lines cannot poison retrieval', async () => {
    const obsFile = path.join(sandbox, 'memory', 'observations.jsonl')
    await fs.mkdir(path.dirname(obsFile), { recursive: true })
    await fs.writeFile(obsFile, [
      JSON.stringify({ id: 'o_poison_tags', text: '标签被写成数字的旧数据', tags: 5, status: 'active', importance: 2, last_seen: new Date().toISOString() }),
      JSON.stringify({ id: 'o_poison_text', text: 5, tags: [], status: 'active', importance: 2 }),
      JSON.stringify({ id: 'o_good', text: '正常的一条记忆', tags: ['ok'], status: 'active', importance: 2, last_seen: new Date().toISOString() }),
    ].join('\n') + '\n')
    const list = await readObservations()
    assert.deepEqual(list.map((o) => o.id), ['o_poison_tags', 'o_good'])
    assert.deepEqual(list[0].tags, [])
    assert.ok(Array.isArray(await retrieve('正常记忆')))
    const added = await appendObservation({ text: '写入时也要归一化标签', tags: 'not-an-array' })
    assert.deepEqual(added.tags, [])
    assert.ok((await retrieve('标签')).length >= 1)
  })

  await test('malformed screen blocklist config cannot break screen ingestion', async () => {
    await saveConfig({ screen: { enabled: true, blocklist: 5, excludeTitlePatterns: 'nope' } })
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"activity":"回归测试","signals":[]}' } }] })
    const result = await ingestScreenEvent({ text: '正在写的回归测试屏幕文本', app: 'Test', title: 'Window' })
    assert.ok(result.event)
    const normalized = await setScreenConfig({ blocklist: 5, excludeTitlePatterns: 'nope' })
    assert.deepEqual(normalized.blocklist, [])
    assert.deepEqual(normalized.excludeTitlePatterns, [])
    await saveConfig({ screen: { enabled: false } })
  })

  await test('return brief aggregates what happened while the user was away', async () => {
    const localToday = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    const since = new Date(Date.now() - 24 * 3600000).toISOString()
    const now = new Date().toISOString()
    await store.createConversation({ isMain: true })
    await store.appendMessage('main', { id: 'm_brief_proactive', role: 'assistant', proactive: true, content: '你不在时准备好的主动消息', createdAt: now })
    await store.writeState({
      commitments: [
        { id: 'goal_brief_due', title: '签证预约', status: 'active', deadline: localToday, revision: 1, preparation: { state: 'ready' }, scope: {}, watch: {} },
        { id: 'goal_brief_failed', title: '准备失败的目标', status: 'active', revision: 1, deadline: null, preparation: { state: 'failed', retryAt: now }, scope: {}, watch: {} },
        { id: 'goal_brief_tracked', title: '已接管的线索', status: 'active', revision: 1, preparation: { state: 'idle' }, candidateLoopId: 'loop_brief', scope: {}, watch: {} },
      ],
      preparations: [{ id: 'prep_brief', commitmentId: 'goal_brief_due', revision: 1, title: '草稿标题', delivery: { status: 'pending', expiresAt: new Date(Date.now() + 3600000).toISOString() }, createdAt: now }],
      dream: { loops: [{ id: 'loop_brief', topic: '已接管的线索', status: 'open' }, { id: 'loop_open', topic: '待接管的线索', status: 'open' }] },
    })
    globalThis.fetch = originalFetch
    const brief = await returnBrief({ since })
    const kinds = brief.items.map((item) => item.kind)
    for (const kind of ['proactive', 'due', 'drafts', 'failed', 'loops']) assert.ok(kinds.includes(kind), `missing ${kind} in ${kinds}`)
    assert.equal(brief.items.find((item) => item.kind === 'due').goals[0].stage, 'today')
    assert.equal(brief.items.find((item) => item.kind === 'loops').count, 1, 'tracked loops must not be listed as open')
    assert.equal(brief.items.find((item) => item.kind === 'proactive').count, 1)
    assert.equal(brief.since, since)
    assert.equal((await returnBrief({ since })).items.length, brief.items.length, 'the brief is read-only and repeatable')
    const clean = await returnBrief({ since: new Date(Date.now() + 3600000).toISOString() })
    assert.ok(!clean.items.some((item) => item.kind === 'proactive'), 'messages newer than the visit are not counted')
  })
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
