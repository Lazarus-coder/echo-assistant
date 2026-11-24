import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-harness-'))
let workspaceRoot = path.join(sandbox, 'workspace')
process.env.ECHO_DATA_DIR = path.join(sandbox, 'data')
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_HARNESS_TEST_KEY = 'local-test-only'
process.env.ECHO_HARNESS_TEST_URL = 'http://127.0.0.1:1/v1'
await fs.mkdir(workspaceRoot)
workspaceRoot = await fs.realpath(workspaceRoot)
await fs.writeFile(process.env.ECHO_CONFIG, JSON.stringify({
  upstream: { apiKeyEnv: 'ECHO_HARNESS_TEST_KEY', baseUrlEnv: 'ECHO_HARNESS_TEST_URL', defaultModel: 'test', utilityModel: 'test' },
  search: { enabled: false }, memory: { enabled: false }, screen: { enabled: false },
  media: { imageOutput: false }, harness: { enabled: true, workspaceRoot, allowWrites: true, allowShell: true, maxToolRounds: 1 },
}))

const harness = await import('../lib/harness.mjs')
const { buildToolRegistry } = await import('../lib/tools.mjs')
const { runTurn } = await import('../lib/chat.mjs')
const { assembleContext } = await import('../lib/context.mjs')
const { loadConfig, saveConfig } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const originalFetch = globalThis.fetch
const activeRuns = new Set()
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const within = async (promise) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test operation timed out')), 2000) })]) }
  finally { clearTimeout(timer) }
}
async function start(extra = {}) {
  const run = await harness.startRun({ conversationId: 'conv_test', messageId: 'message_test', userMessageId: 'user_test', workspaceRoot, ...extra })
  activeRuns.add(run)
  return run
}
async function finish(run, status = 'completed') {
  await run.finish(status)
  activeRuns.delete(run)
}
async function resetConfig(extra = {}) {
  return saveConfig({ harness: { enabled: true, workspaceRoot, allowWrites: true, allowShell: true, maxToolRounds: 1, shellTimeoutMs: 60000, maxOutputBytes: 2097152, ...extra } })
}
async function collect(generator, onEvent = () => {}) {
  const events = []
  for await (const event of generator) { events.push(event); await onEvent(event) }
  return events
}
function response({ content = '', calls = [], finish = calls.length ? 'tool_calls' : 'stop' } = {}) {
  const delta = { content, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : {}) }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
function assertToolProtocol(messages) {
  const pending = new Set()
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(pending.delete(message.tool_call_id), `unexpected result ${message.tool_call_id}`)
      continue
    }
    assert.equal(pending.size, 0, `missing tool results before ${message.role}: ${[...pending]}`)
    for (const call of message.tool_calls ?? []) {
      assert.ok(!pending.has(call.id), `duplicate call ${call.id}`)
      pending.add(call.id)
    }
  }
  assert.equal(pending.size, 0, `missing final tool results: ${[...pending]}`)
}

try {
  await test('approval freezes exact arguments and persists the running step before execution', async () => {
    const requested = deferred()
    const run = await start({ onEvent: (event) => { if (event.type === 'tool_approval') requested.resolve(event) } })
    const args = { command: 'printf approved', cwd: '.', metadata: { purpose: 'test' } }
    let executed = false
    const work = run.call({
      name: 'shell_exec', args, callId: 'call_approved', needsApproval: true,
      execute: async (approvedArgs) => {
        executed = true
        const saved = await harness.getRun(run.id)
        assert.equal(saved.steps[0].status, 'running')
        assert.equal(saved.steps[0].approval.status, 'approved')
        assert.deepEqual(approvedArgs, { command: 'printf approved', cwd: '.', metadata: { purpose: 'test' } })
        assert.deepEqual(saved.steps[0].args, approvedArgs)
        return { text: 'approved output' }
      },
    })
    args.command = 'mutated command'
    args.metadata.purpose = 'mutated purpose'
    const event = await within(requested.promise)
    assert.equal(executed, false)
    assert.equal(event.approval.args.command, 'printf approved')
    const pending = await harness.getRun(run.id)
    assert.equal(pending.status, 'awaiting_approval')
    assert.equal(pending.steps[0].approval.id, event.approval.id)
    await harness.decideApproval(run.id, event.approval.id, 'approve')
    await assert.rejects(harness.decideApproval(run.id, event.approval.id, 'approve'), { status: 409 })
    const result = await within(work)
    assert.equal(executed, true)
    assert.equal(result.stepId, pending.steps[0].id)
    assert.equal((await harness.getRun(run.id)).steps[0].status, 'completed')
    await finish(run)
  })

  await test('denial and cancellation never execute the pending action and invalidate the approval', async () => {
    for (const decision of ['deny', 'cancel']) {
      const requested = deferred()
      const controller = new AbortController()
      const run = await start({ signal: controller.signal, onEvent: (event) => { if (event.type === 'tool_approval') requested.resolve(event) } })
      let executed = false
      const work = run.call({ name: 'shell_exec', args: { command: 'must not execute' }, needsApproval: true, execute: async () => { executed = true; return { text: 'unexpected' } } })
      const rejected = assert.rejects(work, (error) => decision === 'deny' ? error.denied === true && error.status === 403 : error.name === 'AbortError')
      const event = await within(requested.promise)
      await assert.rejects(harness.decideApproval('run_wrong', event.approval.id, 'approve'), { status: 409 })
      if (decision === 'deny') await harness.decideApproval(run.id, event.approval.id, 'deny')
      else controller.abort()
      await within(rejected)
      assert.equal(executed, false)
      await assert.rejects(harness.decideApproval(run.id, event.approval.id, 'approve'), { status: 409 })
      const saved = await harness.getRun(run.id)
      assert.equal(saved.steps[0].approval.status, decision === 'deny' ? 'denied' : 'cancelled')
      await finish(run, 'cancelled')
    }
  })

  await test('an already stopped turn cannot leave a running record without an active worker', async () => {
    const priorIds = new Set((await harness.listRuns({ limit: 100 })).map((run) => run.id))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(start({ signal: controller.signal }), { name: 'AbortError' })
    const created = (await harness.listRuns({ limit: 100 })).filter((run) => !priorIds.has(run.id))
    assert.ok(created.every((run) => ['cancelled', 'interrupted'].includes(run.status)), 'aborted startup left an apparently running worker')
  })

  await test('Stop after a completed side effect preserves its result, change record and artifacts', async () => {
    const controller = new AbortController()
    const run = await start({ signal: controller.signal })
    const target = path.join(workspaceRoot, 'completed-before-stop.txt')
    const changes = [{ path: 'completed-before-stop.txt', before: null, after: 'verified-change' }]
    const result = await run.call({
      name: 'workspace_write', args: { path: 'completed-before-stop.txt', content: 'already written' },
      execute: async (_, { outputDir }) => {
        await fs.writeFile(target, 'already written')
        const snapshot = path.join(outputDir, 'after.txt')
        await fs.writeFile(snapshot, 'already written')
        controller.abort()
        return { text: 'The file was written before Stop.', ok: true, changes, artifacts: [{ file: snapshot }] }
      },
    })
    assert.equal(run.signal.aborted, true)
    assert.equal(await fs.readFile(target, 'utf8'), 'already written')
    const step = (await harness.getRun(run.id)).steps[0]
    assert.equal(step.status, 'completed')
    assert.equal(step.result, 'The file was written before Stop.')
    assert.deepEqual(step.changes, changes)
    assert.deepEqual(step.artifacts.map((artifact) => artifact.name), ['after.txt', 'result.txt'])
    assert.equal(result.stepId, step.id)
    assert.equal(await fs.readFile((await harness.artifactFile(run.id, step.id, 'after.txt')).file, 'utf8'), 'already written')
    await finish(run, 'cancelled')
    const stopped = await harness.getRun(run.id)
    assert.equal(stopped.status, 'cancelled')
    assert.equal(stopped.steps[0].status, 'completed', 'cancelling the run must not erase a completed effect')
  })

  await test('restart recovery preserves finished steps and marks unfinished work without replaying it', async () => {
    const id = 'run_recovery_test'
    const file = path.join(process.env.ECHO_DATA_DIR, 'runs', id, 'run.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({
      id, status: 'awaiting_approval', startedAt: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'step_finished', status: 'completed', result: 'Already saved' },
        { id: 'step_waiting', status: 'awaiting_approval', approval: { id: 'approval_orphaned', status: 'pending' } },
      ],
    }))
    await harness.recoverRuns()
    const recovered = await harness.getRun(id)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(recovered.steps[0].status, 'completed')
    assert.equal(recovered.steps[0].result, 'Already saved')
    assert.equal(recovered.steps[1].status, 'interrupted')
    assert.equal(recovered.steps[1].approval.status, 'expired')
    assert.ok(recovered.finishedAt)
    await assert.rejects(harness.decideApproval(id, 'approval_orphaned', 'approve'), { status: 409 })
    const saved = await fs.readFile(file, 'utf8')
    await harness.recoverRuns()
    assert.equal(await fs.readFile(file, 'utf8'), saved)
  })

  await test('output reads require the run manifest and reject traversal, symlinks, and another run', async () => {
    const outside = path.join(sandbox, 'outside.txt')
    await fs.writeFile(outside, 'not an artifact')
    const run = await start()
    let outputDir
    const result = await run.call({
      name: 'test_output', args: {}, execute: async (_, context) => {
        outputDir = context.outputDir
        await fs.writeFile(path.join(outputDir, 'stdout.txt'), '0123456789')
        await fs.writeFile(path.join(outputDir, 'unregistered.txt'), 'hidden')
        await fs.symlink(outside, path.join(outputDir, 'symlink.txt'))
        return { text: 'tool summary', artifacts: [{ file: outside }, { file: path.join(outputDir, 'stdout.txt'), name: '../../forged' }, { file: path.join(outputDir, 'symlink.txt') }] }
      },
    })
    assert.deepEqual(result.artifacts.map((artifact) => artifact.name), ['stdout.txt', 'result.txt'])
    const file = await harness.artifactFile(run.id, result.stepId, 'stdout.txt')
    assert.equal(file.file, path.join(outputDir, 'stdout.txt'))
    const page = JSON.parse((await run.readOutput({ stepId: result.stepId, name: 'stdout.txt', offset: 2, maxChars: 4 })).text)
    assert.deepEqual(page, { content: '2345', nextOffset: 6, totalChars: 10 })
    await assert.rejects(harness.artifactFile(run.id, result.stepId, '../outside.txt'), { status: 400 })
    await assert.rejects(harness.artifactFile(run.id, '../step_escape', 'stdout.txt'), { status: 400 })
    await assert.rejects(harness.artifactFile(run.id, result.stepId, 'unregistered.txt'), { status: 404 })
    await assert.rejects(harness.artifactFile(run.id, result.stepId, 'symlink.txt'), { status: 404 })
    await assert.rejects(run.readOutput({ runId: 'run_other', stepId: result.stepId, name: 'stdout.txt' }), { status: 404 })
    await fs.rm(file.file)
    await fs.symlink(outside, file.file)
    await assert.rejects(harness.artifactFile(run.id, result.stepId, 'stdout.txt'), { status: 404 })
    await finish(run)
  })

  await test('registered artifacts reject symlinked step and run directories', async () => {
    const run = await start()
    const result = await run.call({
      name: 'test_output', args: {}, execute: async (_, { outputDir }) => {
        const file = path.join(outputDir, 'stdout.txt')
        await fs.writeFile(file, 'registered output')
        return { text: 'summary', artifacts: [{ file }] }
      },
    })
    const runDir = path.join(process.env.ECHO_DATA_DIR, 'runs', run.id)
    for (const directory of [path.join(runDir, result.stepId), runDir]) {
      const moved = `${directory}-saved`
      await fs.rename(directory, moved)
      await fs.symlink(moved, directory)
      try {
        await assert.rejects(harness.artifactFile(run.id, result.stepId, 'stdout.txt'), { status: 404 })
        await assert.rejects(run.readOutput({ stepId: result.stepId, name: 'stdout.txt' }), { status: 404 })
      } finally {
        await fs.unlink(directory)
        await fs.rename(moved, directory)
      }
    }
    assert.equal(JSON.parse((await run.readOutput({ stepId: result.stepId, name: 'stdout.txt' })).text).content, 'registered output')
    await finish(run)
  })

  await test('interrupted effects enter continuation context and old output stays within its conversation', async () => {
    const conv = await store.createConversation()
    const prior = await start({ conversationId: conv.id })
    const result = await prior.call({
      name: 'workspace_write', args: { path: 'already-applied.txt' },
      execute: async (_, { outputDir }) => {
        const file = path.join(outputDir, 'stdout.txt')
        await fs.writeFile(file, 'previous output')
        return { text: 'Already applied before interruption.', changes: [{ path: 'already-applied.txt', after: 'saved-hash' }], artifacts: [{ file }] }
      },
    })
    const recordPath = path.join(process.env.ECHO_DATA_DIR, 'runs', prior.id, 'run.json')
    const interruptedRecord = JSON.parse(await fs.readFile(recordPath, 'utf8'))
    interruptedRecord.steps.push({ id: 'step_uncertain', name: 'shell_exec', status: 'running', args: { command: 'external-action' } })
    await fs.writeFile(recordPath, JSON.stringify(interruptedRecord))
    await harness.recoverRuns()
    const summary = await harness.interruptedRunContext(conv.id)
    assert.ok(summary.includes(prior.id) && summary.includes(result.stepId))
    assert.match(summary, /Already applied before interruption/)
    assert.match(summary, /中断的步骤是否产生效果未知/)
    assert.match(summary, /不要直接重放操作/)
    assert.ok(summary.length < 17000)
    assert.equal(await harness.interruptedRunContext('conv_unrelated'), '')
    const continuation = await start({ conversationId: conv.id })
    const page = JSON.parse((await continuation.readOutput({ runId: prior.id, stepId: result.stepId, name: 'stdout.txt', offset: 9, maxChars: 6 })).text)
    assert.equal(page.content, 'output')
    const unrelated = await start({ conversationId: 'conv_unrelated' })
    await assert.rejects(unrelated.readOutput({ runId: prior.id, stepId: result.stepId, name: 'stdout.txt' }), { status: 400 })
    let request
    globalThis.fetch = async (_, options) => { request = JSON.parse(options.body); return response({ content: 'Checked the prior effects before continuing.' }) }
    await collect(runTurn({ conversationId: conv.id, userText: 'Continue safely', allowLocalTools: true }))
    assert.ok(request.messages[0].content.includes(prior.id))
    assert.match(request.messages[0].content, /Already applied before interruption/)
    await finish(continuation)
    await finish(unrelated)
    await finish(prior, 'interrupted')
  })

  await test('fresh permissions block a previously registered write, shell, or workspace read', async () => {
    const cfg = await resetConfig()
    const run = await start()
    const registry = buildToolRegistry({ cfg, conversationId: 'conv_test', run, allowLocalTools: true })
    assert.ok(registry.defs.some((tool) => tool.function.name === 'workspace_write'))
    await saveConfig({ harness: { allowWrites: false, allowShell: false } })
    await assert.rejects(registry.call('workspace_write', { path: 'revoked.txt', content: 'must not write' }), { status: 403 })
    await assert.rejects(harness.currentWorkspacePermission(cfg.harness, 'shell_exec'), { status: 403 })
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'revoked.txt')), { code: 'ENOENT' })
    await registry.call('workspace_list', {})
    await saveConfig({ harness: { enabled: false } })
    await assert.rejects(registry.call('workspace_list', {}), { status: 403 })
    await finish(run, 'failed')
    await resetConfig()
  })

  await test('remote tool registries omit local capabilities and unknown prototype names are rejected', async () => {
    const cfg = await loadConfig()
    const registry = buildToolRegistry({ cfg, conversationId: 'conv_test', allowLocalTools: false, mcp: { tools: () => [{ name: 'server__external', inputSchema: { type: 'object' } }] } })
    assert.ok(!registry.defs.some((tool) => /^(workspace_|shell_exec|read_output|server__)/.test(tool.function.name)))
    for (const name of ['toString', 'constructor', '__proto__', 'not_a_tool']) await assert.rejects(registry.call(name, {}), /没有这个工具/)
  })

  await test('approval cannot restore shell permission revoked while the prompt was pending', async () => {
    const cfg = await resetConfig()
    const requested = deferred()
    const run = await start({ onEvent: (event) => { if (event.type === 'tool_approval') requested.resolve(event) } })
    const registry = buildToolRegistry({ cfg, conversationId: 'conv_test', run, allowLocalTools: true })
    const work = registry.call('shell_exec', { command: 'printf forbidden > revoked-shell.txt' })
    const rejected = assert.rejects(work, { status: 403 })
    const event = await within(requested.promise)
    await saveConfig({ harness: { allowShell: false } })
    await harness.decideApproval(run.id, event.approval.id, 'approve')
    await within(rejected)
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'revoked-shell.txt')), { code: 'ENOENT' })
    assert.equal((await harness.getRun(run.id)).steps[0].status, 'failed')
    await finish(run, 'failed')
    await resetConfig()
  })

  await test('tool round budget always leaves one final synthesis request with tools disabled', async () => {
    await resetConfig({ maxToolRounds: 1 })
    const conv = await store.createConversation()
    const requests = []
    globalThis.fetch = async (_, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return requests.length === 1
        ? response({ calls: [{ id: 'budget_time', name: 'local_time' }] })
        : response({ content: 'Verified the time; no further tools executed.' })
    }
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Check the time', allowLocalTools: true }))
    assert.equal(requests.length, 2)
    assert.ok(requests[0].tools.length > 0)
    assert.equal(requests[1].tools, undefined)
    assert.equal(requests[1].tool_choice, undefined)
    assertToolProtocol(requests[1].messages)
    const done = events.findLast((event) => event.type === 'done')
    assert.equal(done.message.tools.length, 1)
    assert.equal(done.message.finalContent, 'Verified the time; no further tools executed.')
    assert.equal(done.message.runStatus, 'completed')
    assert.equal(done.message.runError, undefined)
    assert.deepEqual((await store.getConversation(conv.id)).messages.at(-1), JSON.parse(JSON.stringify(done.message)))
    assert.equal((await harness.getRun(done.message.runId)).status, 'completed')
  })

  await test('a model cannot execute extra tools after the final synthesis budget', async () => {
    await resetConfig({ maxToolRounds: 1 })
    const conv = await store.createConversation()
    let requests = 0
    globalThis.fetch = async () => response({ calls: ++requests === 1
      ? [{ id: 'budget_initial', name: 'local_time' }]
      : [{ id: 'budget_forbidden', name: 'workspace_write', args: { path: 'past-budget.txt', content: 'must not write' } }] })
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Keep working forever', allowLocalTools: true }))
    assert.equal(requests, 2)
    const done = events.findLast((event) => event.type === 'done')
    assert.equal(done.message.tools.length, 1)
    assert.equal(done.message.finishReason, 'tool_limit')
    assert.equal(done.message.runStatus, 'limit_reached')
    assert.deepEqual((await store.getConversation(conv.id)).messages.at(-1), JSON.parse(JSON.stringify(done.message)))
    assert.equal((await harness.getRun(done.message.runId)).status, 'limit_reached')
    await harness.recoverRuns()
    assert.equal((await harness.getRun(done.message.runId)).status, 'limit_reached', 'restart recovery preserves a terminal budget outcome')
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'past-budget.txt')), { code: 'ENOENT' })
  })

  await test('one large model batch is limited to 32 actual tool calls', async () => {
    await resetConfig({ maxToolRounds: 2 })
    const conv = await store.createConversation()
    const requests = []
    globalThis.fetch = async (_, options) => {
      requests.push(JSON.parse(options.body))
      return requests.length === 1
        ? response({ calls: Array.from({ length: 40 }, (_, index) => ({ id: `many_${index}`, name: 'local_time' })) })
        : response({ content: 'Stopped at the tool budget.' })
    }
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Check many times', allowLocalTools: true }))
    const done = events.findLast((event) => event.type === 'done')
    assert.equal(done.message.tools.length, 32)
    assert.equal(requests.length, 2)
    assert.equal(done.rounds, requests.length)
    assert.equal(requests[1].tools, undefined)
    assert.equal(done.message.finishReason, 'tool_limit', 'a successful summary cannot hide the eight unexecuted requests')
    assert.equal(done.message.runStatus, 'limit_reached')
    assert.match(done.message.finalContent, /剩余工作尚未执行/)
    assert.deepEqual((await store.getConversation(conv.id)).messages.at(-1), JSON.parse(JSON.stringify(done.message)))
    assert.equal((await harness.getRun(done.message.runId)).status, 'limit_reached')
    assertToolProtocol(requests[1].messages)
  })

  await test('a failed workspace operation stays failed after the model summarizes it', async () => {
    await resetConfig({ maxToolRounds: 2 })
    const conv = await store.createConversation()
    let requests = 0
    globalThis.fetch = async () => ++requests === 1
      ? response({ calls: [{ id: 'missing_file', name: 'workspace_read', args: { path: 'missing-file.txt' } }] })
      : response({ content: 'The file could not be read.' })
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Read the file', allowLocalTools: true }))
    const done = events.findLast((event) => event.type === 'done')
    assert.equal(done.message.tools[0].ok, false)
    assert.equal(done.message.runStatus, 'failed')
    assert.match(done.message.runError, /工具失败/)
    assert.deepEqual((await store.getConversation(conv.id)).messages.at(-1), JSON.parse(JSON.stringify(done.message)))
    const run = await harness.getRun(done.message.runId)
    assert.equal(run.status, 'failed')
    assert.equal(run.error, done.message.runError)
    assert.equal(run.steps[0].status, 'failed')
  })

  for (const unrelatedFailure of [false, true]) {
    await test(`a repaired program passes the original command, preserving unrelated failures: ${unrelatedFailure}`, async () => {
      await resetConfig({ maxToolRounds: 6 })
      const conv = await store.createConversation()
      const file = 'math.cjs'
      await fs.writeFile(path.join(workspaceRoot, file), 'module.exports = () => 1\n')
      await fs.writeFile(path.join(workspaceRoot, 'check.cjs'), "require('node:assert/strict').equal(require('./math.cjs')(), 2)\n")
      const command = { command: 'node check.cjs', cwd: '.' }
      let requests = 0
      globalThis.fetch = async (_, options) => {
        const body = JSON.parse(options.body)
        switch (++requests) {
          case 1: return response({ calls: [
            ...(unrelatedFailure ? [{ id: 'missing', name: 'workspace_read', args: { path: 'another-missing.cjs' } }] : []),
            { id: 'run-test', name: 'shell_exec', args: command },
          ] })
          case 2: return response({ calls: [{ id: 'locate', name: 'workspace_search', args: { query: 'module.exports = () =>' } }] })
          case 3: {
            const { matches } = JSON.parse(body.messages.at(-1).content.split('\n输出文件')[0])
            return response({ calls: [{ id: 'inspect', name: 'workspace_read', args: { path: matches[0].path } }] })
          }
          case 4: {
            const { hash } = JSON.parse(body.messages.at(-1).content.split('\n输出文件')[0])
            return response({ calls: [{ id: 'repair', name: 'workspace_edit', args: { path: file, oldText: '=> 1', newText: '=> 2', expectedHash: hash } }] })
          }
          case 5: return response({ calls: [{ id: 'retest', name: 'shell_exec', args: { cwd: '.', command: command.command } }] })
          case 6: return response({ content: 'Re-ran check.cjs after editing math.cjs.' })
          default: throw new Error('Unexpected model request')
        }
      }
      const approvals = new Set()
      const events = await collect(runTurn({ conversationId: conv.id, userText: 'Fix the failing check', allowLocalTools: true,
        onToolEvent(event) {
          if (event.type !== 'tool_approval') return
          approvals.add(event.approval.id)
          void harness.decideApproval(event.runId, event.approval.id, 'approve')
        },
      }))
      const done = events.at(-1)
      assert.equal(done.type, 'done')
      assert.equal(requests, 6)
      assert.equal(approvals.size, 2)
      assert.equal(await fs.readFile(path.join(workspaceRoot, file), 'utf8'), 'module.exports = () => 2\n')
      const run = await harness.getRun(done.message.runId)
      assert.deepEqual(run.steps.filter((step) => step.name === 'shell_exec').map((step) => [step.status, step.exitCode]), [['failed', 1], ['completed', 0]])
      assert.equal(run.status, unrelatedFailure ? 'failed' : 'completed')
      assert.equal(done.message.runStatus, run.status)
      assert.equal((await store.getConversation(conv.id)).messages.at(-1).runStatus, run.status)
      if (unrelatedFailure) assert.match(run.error, /another-missing/)
    })
  }

  await test('repeating a failed command without progress stops before another approval or side effect', async () => {
    await resetConfig({ maxToolRounds: 8 })
    const conv = await store.createConversation()
    const command = 'printf x >> attempts.txt && exit 9'
    let requests = 0, approvals = 0
    globalThis.fetch = async () => response({ calls: [
      { id: `attempt-${++requests}`, name: 'shell_exec', args: { command } },
      ...(requests > 1 ? [{ id: 'discarded', name: 'workspace_write', args: { path: 'discarded.txt', content: 'skip' } }] : []),
    ] })
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Run the diagnostic', allowLocalTools: true,
      onToolEvent(event) {
        if (event.type !== 'tool_approval') return
        approvals++
        void harness.decideApproval(event.runId, event.approval.id, 'approve')
      },
    }))
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    const run = await harness.getRun(last.assistant.runId)
    assert.equal(run.status, 'failed')
    assert.equal(run.finishReason, 'no_progress')
    assert.equal(last.assistant.finishReason, run.finishReason)
    assert.equal(run.steps.length, 1)
    assert.equal(requests, 2)
    assert.equal(approvals, 1)
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'attempts.txt'), 'utf8'), 'x')
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'discarded.txt')), { code: 'ENOENT' })
    assertToolProtocol(last.assistant.toolMessages)
  })

  for (const finish of ['length', 'content_filter']) {
    await test(`the model's ${finish} finish reason cannot dispatch a partial file change`, async () => {
      await resetConfig()
      const conv = await store.createConversation()
      globalThis.fetch = async () => response({ content: 'Partial result.', finish,
        calls: [{ id: 'fragment', name: 'workspace_write', args: { path: 'truncated.txt', content: 'partial' } }],
      })
      const events = await collect(runTurn({ conversationId: conv.id, userText: 'Make the change', allowLocalTools: true }))
      const assistant = (await store.getConversation(conv.id)).messages.at(-1)
      assert.equal(assistant.finishReason, finish)
      assert.match(assistant.content, /Partial result/)
      assert.equal(assistant.runStatus, finish === 'length' ? 'limit_reached' : 'failed')
      const run = await harness.getRun(assistant.runId)
      assert.equal(run.status, assistant.runStatus)
      assert.equal(run.finishReason, finish)
      assert.equal(run.steps.length, 0)
      assert.ok(!events.some((event) => event.type === 'tool_call'))
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'truncated.txt')), { code: 'ENOENT' })
    })
  }

  await test('chat pages recover escaped source and shell output using only the cursors delivered to the model', async () => {
    await resetConfig({ maxToolRounds: 16 })
    const conv = await store.createConversation()
    const file = 'paged-source.txt'
    const source = 'first\n' + 'x'.repeat(7800) + '\\\t\u0001"🧩'.repeat(1800) + '\nlast\n'
    await fs.writeFile(path.join(workspaceRoot, file), source)
    const lines = []
    let output = '', hash, stepId, filePages = 0, logPages = 0
    globalThis.fetch = async (_, options) => {
      const { messages } = JSON.parse(options.body)
      const last = messages.at(-1)
      const use = (name, args) => response({ calls: [{ id: 'page_' + messages.length, name, args }] })
      if (last.role !== 'tool') return use('workspace_read', { path: file })
      const tool = messages.at(-2).tool_calls[0].function.name
      if (tool === 'shell_exec') {
        stepId = JSON.parse(last.content.split('\n输出文件（可用 read_output 读取）：')[1]).stepId
        return use('read_output', { stepId, name: 'stdout.txt', maxChars: 16000 })
      }
      assert.ok(last.content.length <= 8000)
      const page = JSON.parse(last.content)
      if (tool === 'workspace_read') {
        filePages++
        assert.match(page.hash, /^[a-f0-9]{64}$/)
        hash ??= page.hash
        assert.equal(page.hash, hash)
        for (const numbered of page.content.split('\n')) {
          const [, line, fragment] = /^(\d+): (.*)$/u.exec(numbered)
          lines[Number(line) - 1] = (lines[Number(line) - 1] ?? '') + fragment
        }
        if (page.nextLine !== null) return use(tool, { path: file, startLine: page.nextLine, startColumn: page.nextColumn })
        assert.equal(lines.join('\n'), source)
        return use('shell_exec', { command: 'cat paged-source.txt' })
      }
      assert.equal(tool, 'read_output')
      logPages++
      output += page.content
      assert.equal(page.totalChars, source.length)
      if (page.nextOffset !== null) {
        assert.equal(page.nextOffset, output.length)
        return use(tool, { stepId, name: 'stdout.txt', offset: page.nextOffset })
      }
      assert.equal(output, source)
      return response({ content: 'Read the complete file and command log.' })
    }
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Read the fixture and compare its output', allowLocalTools: true,
      onToolEvent(event) {
        if (event.type === 'tool_approval') void harness.decideApproval(event.runId, event.approval.id, 'approve')
      },
    }))
    assert.equal(events.at(-1).type, 'done')
    assert.equal(events.at(-1).message.runStatus, 'completed')
    assert.ok(filePages > 1 && logPages > 1)
  })

  await test('usage without a response does not complete the user request', async () => {
    const conv = await store.createConversation()
    globalThis.fetch = async () => new Response('data: {"choices":[],"usage":{"prompt_tokens":3}}\n\ndata: [DONE]\n\n')
    const events = await collect(runTurn({ conversationId: conv.id, userText: 'Describe the result' }))
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.equal(last.assistant.runStatus, 'failed')
    assert.equal((await harness.getRun(last.assistant.runId)).finishReason, 'empty_response')
  })

  await test('context budgeting counts large tool request contents before retaining older history', async () => {
    const current = await loadConfig()
    const cfg = { ...current, upstream: { ...current.upstream, contextChars: 12000 } }
    const oldCall = { id: 'large_write', type: 'function', function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'large.txt', content: 'x'.repeat(24000) }) } }
    const conv = { messages: [
      { id: 'old_question', role: 'user', content: 'Write a large file.' },
      {
        id: 'old_result', role: 'assistant', content: 'Created the file.',
        tools: [{ name: 'workspace_write', result: 'done' }],
        toolMessages: [
          { role: 'assistant', content: '', tool_calls: [oldCall] },
          { role: 'tool', tool_call_id: oldCall.id, content: 'done' },
        ],
      },
      { id: 'recent_question', role: 'user', content: 'What next?' },
      { id: 'recent_answer', role: 'assistant', content: 'Review the result.' },
    ] }
    const assembled = await assembleContext({ cfg, conv, memoryText: '', screenText: '', systemText: 'Test assistant.' })
    assert.deepEqual(assembled.slice.map((message) => message.id), ['recent_question', 'recent_answer'])
    assert.equal(assembled.pressure.keepFrom, 2)
    assert.equal(assembled.pressure.uncovered, 2)
  })

  await test('Stop during a tool batch leaves valid tool history for the next user turn', async () => {
    await resetConfig({ maxToolRounds: 2 })
    const conv = await store.createConversation()
    const controller = new AbortController()
    globalThis.fetch = async () => response({ calls: [{ id: 'cancel_first', name: 'local_time' }, { id: 'cancel_second', name: 'local_time' }] })
    const interrupted = await collect(runTurn({ conversationId: conv.id, userText: 'Check twice', signal: controller.signal, allowLocalTools: true }), (event) => {
      if (event.type === 'tool_result' && event.id === 'cancel_first') controller.abort()
    })
    const stopped = interrupted.findLast((event) => event.type === 'done')
    assert.equal(stopped.aborted, true)
    assert.equal(stopped.message.tools.length, 1)
    assert.equal(stopped.message.runStatus, 'cancelled')
    assert.deepEqual((await store.getConversation(conv.id)).messages.at(-1), JSON.parse(JSON.stringify(stopped.message)))
    assert.equal((await harness.getRun(stopped.message.runId)).status, 'cancelled')
    let replay
    globalThis.fetch = async (_, options) => { replay = JSON.parse(options.body); return response({ content: 'Continuing after Stop.' }) }
    await collect(runTurn({ conversationId: conv.id, userText: 'What happened?', allowLocalTools: true }))
    assertToolProtocol(replay.messages)
    assert.equal(replay.messages.filter((message) => message.role === 'tool' && message.tool_call_id === 'cancel_second').length, 1)
  })

  await test('denying a batch action stops its siblings and keeps replay history valid', async () => {
    await resetConfig({ maxToolRounds: 2 })
    const conv = await store.createConversation()
    const decisions = []
    globalThis.fetch = async () => response({ calls: [
      { id: 'denied_first', name: 'shell_exec', args: { command: 'printf must-not-run' } },
      { id: 'denied_second', name: 'workspace_write', args: { path: 'denied-sibling.txt', content: 'must not write' } },
    ] })
    const events = await collect(runTurn({
      conversationId: conv.id, userText: 'Propose changes', allowLocalTools: true,
      onToolEvent: (event) => { if (event.type === 'tool_approval') decisions.push(harness.decideApproval(event.runId, event.approval.id, 'deny')) },
    }))
    await Promise.all(decisions)
    const done = events.findLast((event) => event.type === 'done')
    assert.equal(done.aborted, true)
    assert.equal(done.message.tools.length, 1)
    assert.equal(done.message.runStatus, 'cancelled')
    assert.deepEqual((await store.getConversation(conv.id)).messages.at(-1), JSON.parse(JSON.stringify(done.message)))
    assert.equal((await harness.getRun(done.message.runId)).error, done.message.runError)
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'denied-sibling.txt')), { code: 'ENOENT' })
    let replay
    globalThis.fetch = async (_, options) => { replay = JSON.parse(options.body); return response({ content: 'The operation was declined.' }) }
    await collect(runTurn({ conversationId: conv.id, userText: 'Explain what was stopped', allowLocalTools: true }))
    assertToolProtocol(replay.messages)
    assert.equal(replay.messages.filter((message) => message.role === 'tool' && message.tool_call_id === 'denied_second').length, 1)
  })

  await test('privacy wipe drains cancelled tool cleanup before deleting runs and late finish cannot restore them', async () => {
    const entered = deferred()
    const cancelled = deferred()
    const releaseCleanup = deferred()
    const run = await start()
    let stepId
    let outputDir
    const work = run.call({
      name: 'test_cancellable_output', args: {},
      execute: async (_, context) => {
        outputDir = context.outputDir
        entered.resolve()
        await new Promise((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener('abort', resolve, { once: true })
        })
        cancelled.resolve()
        await releaseCleanup.promise
        // An interrupted tool may finish flushing its partial logs during cleanup.
        await fs.mkdir(outputDir, { recursive: true })
        const file = path.join(outputDir, 'partial.txt')
        await fs.writeFile(file, 'sensitive partial output')
        throw Object.assign(new DOMException('Stopped by privacy wipe', 'AbortError'), { artifacts: [{ file }], result: { text: 'partial result' } })
      },
    })
    const rejected = assert.rejects(work, (error) => {
      stepId = error.stepId
      return error.name === 'AbortError'
    })
    await within(entered.promise)
    const clearing = harness.clearRuns()
    try {
      await within(cancelled.promise)
      await assert.rejects(start(), { status: 409 })
      assert.equal((await fs.stat(outputDir)).isDirectory(), true)
    } finally { releaseCleanup.resolve() }
    await within(Promise.all([clearing, rejected]))
    assert.ok(stepId)
    await assert.rejects(harness.getRun(run.id), { status: 404 })
    await assert.rejects(harness.artifactFile(run.id, stepId, 'partial.txt'), { status: 404 })
    assert.deepEqual(await harness.listRuns(), [])
    await assert.rejects(fs.stat(path.join(process.env.ECHO_DATA_DIR, 'runs')), { code: 'ENOENT' })
    await finish(run, 'cancelled')
    await assert.rejects(fs.stat(path.join(process.env.ECHO_DATA_DIR, 'runs')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' })
  })
} finally {
  globalThis.fetch = originalFetch
  harness.cancelHarnessRuns('Test cleanup')
  for (const run of activeRuns) await run.finish('cancelled')
  delete process.env.ECHO_HARNESS_TEST_KEY
  delete process.env.ECHO_HARNESS_TEST_URL
  await fs.rm(sandbox, { recursive: true, force: true })
}
