import { domainText } from './domain-language.mjs'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { DATA, loadConfig } from './config.mjs'
import { assertId, newId, nowIso, readJSON, writeJSON, clip, MODEL_TOOL_TEXT_LIMIT, jsonTextPrefix } from './util.mjs'
import { validateWorkspaceRoot } from './workspace.mjs'

const RUNS = path.join(DATA, 'runs')
const writes = new Map()
const approvals = new Map()
const active = new Map()
const activeCalls = new Set()
let clearing = false
let clearWork = null
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'limit_reached'])
const runFile = (id) => path.join(RUNS, assertId(id), 'run.json')
const failure = (message, status = 400) => Object.assign(new Error(message), { status })

export async function validateHarnessConfig(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(domainText('harness.invalidSettings'))
  const next = { ...previous }
  const keys = ['enabled', 'workspaceRoot', 'allowWrites', 'allowShell', 'maxToolRounds', 'shellTimeoutMs', 'maxOutputBytes']
  if (Object.keys(input).some((key) => !keys.includes(key))) throw failure(domainText('harness.unknownSetting'))
  for (const key of ['enabled', 'allowWrites', 'allowShell']) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') throw failure(domainText('harness.boolean', key))
    next[key] = input[key]
  }
  for (const [key, min, max] of [['maxToolRounds', 1, 24], ['shellTimeoutMs', 1000, 120000], ['maxOutputBytes', 1024, 2097152]]) {
    if (input[key] === undefined) continue
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw failure(domainText('harness.range', key, min, max))
    next[key] = input[key]
  }
  if (input.workspaceRoot !== undefined) {
    if (typeof input.workspaceRoot !== 'string' || input.workspaceRoot.length > 4096) throw failure(domainText('harness.invalidRoot'))
    next.workspaceRoot = input.workspaceRoot.trim()
  }
  if (next.enabled && !next.workspaceRoot) throw failure(domainText('harness.selectDirectory'))
  if (next.workspaceRoot) next.workspaceRoot = await validateWorkspaceRoot(next.workspaceRoot)
  return next
}

function mutateRun(id, fn) {
  if (clearing) return Promise.reject(failure(domainText('harness.historyCleared'), 404))
  const work = (writes.get(id) ?? Promise.resolve()).then(async () => {
    const run = await readJSON(runFile(id), null)
    if (!run) throw failure(domainText('harness.missingRun'), 404)
    await fn(run)
    run.updatedAt = nowIso()
    if (clearing) throw failure(domainText('harness.historyCleared'), 404)
    await writeJSON(runFile(id), run)
    return run
  })
  const settled = work.catch(() => {})
  writes.set(id, settled)
  settled.finally(() => { if (writes.get(id) === settled) writes.delete(id) })
  return work
}

export async function getRun(id) {
  const run = await readJSON(runFile(id), null)
  if (!run) throw failure(domainText('harness.missingRun'), 404)
  return run
}

export async function listRuns({ conversationId, limit = 20 } = {}) {
  if (conversationId) assertId(conversationId)
  const names = await fs.readdir(RUNS, { withFileTypes: true }).catch(() => [])
  const runs = []
  for (const entry of names) {
    if (!entry.isDirectory() || !/^run_[a-zA-Z0-9_-]+$/.test(entry.name)) continue
    const run = await readJSON(runFile(entry.name), null)
    if (run && (!conversationId || run.conversationId === conversationId)) runs.push(run)
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.max(1, Math.min(100, limit)))
    .map(({ steps, ...run }) => ({ ...run, steps: steps.map(({ id, name, status, approval }) => ({ id, name, status, approval: approval ? { status: approval.status } : undefined })) }))
}

export async function recoverRuns() {
  const dirs = await fs.readdir(RUNS, { withFileTypes: true }).catch(() => [])
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^run_[a-zA-Z0-9_-]+$/.test(dir.name)) continue
    const run = await readJSON(runFile(dir.name), null)
    if (!run || terminal.has(run.status)) continue
    await mutateRun(run.id, (current) => {
      current.status = 'interrupted'
      current.finishedAt = nowIso()
      current.error = domainText('harness.interrupted')
      for (const step of current.steps) if (!terminal.has(step.status)) {
        step.status = 'interrupted'
        step.finishedAt = nowIso()
        if (step.approval?.status === 'pending') step.approval.status = 'expired'
      }
    })
  }
}

export async function interruptedRunContext(conversationId) {
  const interrupted = (await listRuns({ conversationId })).filter((run) => run.status === 'interrupted').slice(0, 2)
  const summaries = []
  for (const summary of interrupted) {
    const run = await getRun(summary.id)
    summaries.push({
      runId: run.id, startedAt: run.startedAt, workspaceRoot: run.workspaceRoot,
      steps: run.steps.map((step) => ({
        stepId: step.id, name: step.name, status: step.status,
        args: clip(JSON.stringify(step.args), 800), result: clip(step.result ?? step.error ?? '', 600),
        changes: step.changes, artifacts: step.artifacts,
      })),
    })
  }
  return summaries.length ? domainText('harness.priorRunContext', clip(JSON.stringify(summaries), 16000)) : ''
}

export function cancelHarnessRuns(reason = domainText('harness.permissionsChanged')) {
  for (const controller of active.values()) controller.abort(new DOMException(reason, 'AbortError'))
}

export function clearRuns() {
  if (clearWork) return clearWork
  clearing = true
  clearWork = (async () => {
    cancelHarnessRuns(domainText('harness.historyCleared'))
    // Let cancelled tools close output files before removing their directory.
    await Promise.allSettled([...activeCalls])
    while (writes.size) await Promise.allSettled([...writes.values()])
    await fs.rm(RUNS, { recursive: true, force: true })
  })().finally(() => {
    clearing = false
    clearWork = null
  })
  return clearWork
}

export async function decideApproval(runId, approvalId, decision) {
  assertId(runId)
  assertId(approvalId)
  if (!['approve', 'deny'].includes(decision)) throw failure(domainText('harness.invalidDecision'))
  const pending = approvals.get(approvalId)
  if (!pending || pending.runId !== runId) throw failure(domainText('harness.approvalExpired'), 409)
  pending.resolve(decision === 'approve')
  return { ok: true, decision }
}

export async function artifactFile(runId, callId, filename) {
  assertId(runId)
  assertId(callId)
  if (!filename || filename !== path.basename(filename)) throw failure(domainText('harness.invalidName'))
  for (const directory of [path.join(RUNS, runId), path.join(RUNS, runId, callId)]) {
    const info = await fs.lstat(directory).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()) throw failure(domainText('harness.outputUnavailable'), 404)
  }
  const run = await getRun(runId)
  const step = run.steps.find((s) => s.id === callId)
  const artifact = step?.artifacts?.find((a) => a.name === filename)
  if (!artifact) throw failure(domainText('harness.outputMissing'), 404)
  const file = path.join(RUNS, runId, callId, filename)
  const info = await fs.lstat(file).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 3 * 1024 * 1024) throw failure(domainText('harness.outputUnavailable'), 404)
  if (await fs.realpath(file) !== path.join(await fs.realpath(RUNS), runId, callId, filename)) throw failure(domainText('harness.outputUnavailable'), 404)
  return { file, name: filename, bytes: info.size, mime: 'text/plain; charset=utf-8' }
}

export async function startRun({ conversationId, messageId, userMessageId, workspaceRoot, workspaceMode = 'work', signal: parent, onEvent = () => {} }) {
  if (clearing) throw failure(domainText('harness.clearing'), 409)
  parent?.throwIfAborted()
  const id = newId('run')
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const signal = controller.signal
  active.set(id, controller)
  const initialWrite = writeJSON(runFile(id), {
    id, conversationId, messageId, userMessageId, workspaceRoot: workspaceRoot || null, workspaceMode,
    status: 'running', startedAt: nowIso(), updatedAt: nowIso(), steps: [],
  })
  writes.set(id, initialWrite.catch(() => {}))
  try {
    await initialWrite
    signal.throwIfAborted()
  } catch (error) {
    if (signal.aborted) await mutateRun(id, (run) => {
      run.status = 'cancelled'
      run.finishedAt = nowIso()
      run.error = error.message
    }).catch(() => {})
    active.delete(id)
    parent?.removeEventListener('abort', abort)
    throw error
  } finally {
    writes.delete(id)
  }
  const emit = (type, event = {}) => onEvent({ type, runId: id, ...event })
  emit('run_start', { workspaceRoot: workspaceRoot || null })

  async function approval(step) {
    const approvalId = newId('approval')
    const requestedAt = nowIso()
    const record = {
      id: approvalId, status: 'pending', requestedAt,
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
      summary: step.name === 'shell_exec' ? domainText('harness.confirmShell') : domainText('harness.confirmMcp'),
      args: step.args,
    }
    await mutateRun(id, (run) => {
      run.status = 'awaiting_approval'
      Object.assign(run.steps.find((s) => s.id === step.id), { status: 'awaiting_approval', approval: record })
    })
    let accepted
    try {
      accepted = await new Promise((resolve, reject) => {
        const stop = () => { cleanup(); reject(signal.reason ?? new DOMException(domainText('harness.stopped'), 'AbortError')) }
        const timer = setTimeout(() => { cleanup(); reject(Object.assign(failure(domainText('harness.approvalTimedOut'), 408), { denied: true })) }, 5 * 60000)
        const cleanup = () => { clearTimeout(timer); approvals.delete(approvalId); signal.removeEventListener('abort', stop) }
        approvals.set(approvalId, { runId: id, resolve: (value) => { cleanup(); resolve(value) } })
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) return stop()
        emit('tool_approval', { id: step.eventId ?? step.id, stepId: step.id, name: step.name, workspaceRoot, approval: record })
      })
    } catch (error) {
      await mutateRun(id, (run) => {
        const current = run.steps.find((s) => s.id === step.id)
        current.approval.status = signal.aborted ? 'cancelled' : 'expired'
      })
      throw error
    }
    await mutateRun(id, (run) => {
      run.status = 'running'
      const current = run.steps.find((s) => s.id === step.id)
      current.approval.status = accepted ? 'approved' : 'denied'
      current.approval.decidedAt = nowIso()
    })
    if (!accepted) throw Object.assign(failure(domainText('harness.denialInstruction'), 403), { denied: true })
    signal.throwIfAborted()
  }

  async function attachArtifacts(stepId, artifacts = []) {
    const dir = await fs.realpath(path.join(RUNS, id, stepId)).catch(() => null)
    if (!dir) return []
    const list = []
    for (const artifact of artifacts.slice(0, 8)) {
      const original = path.resolve(artifact.file ?? '')
      const info = await fs.lstat(original).catch(() => null)
      if (!info?.isFile() || info.isSymbolicLink()) continue
      const file = await fs.realpath(original).catch(() => '')
      const name = path.basename(file)
      if (path.dirname(file) !== dir || !/^[a-zA-Z0-9_.-]+$/.test(name)) continue
      const stat = await fs.lstat(file).catch(() => null)
      if (!stat?.isFile() || stat.isSymbolicLink()) continue
      list.push({ name, bytes: stat.size, url: `/api/runs/${id}/artifacts/${stepId}/${name}` })
    }
    return list
  }

  async function call({ name, args, callId, needsApproval = false, execute }) {
      signal.throwIfAborted()
      if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 131072) throw failure(domainText('harness.invalidArguments'))
      // The exact copy shown for approval is the copy passed to execution.
      args = JSON.parse(JSON.stringify(args))
      const step = { id: newId('step'), modelCallId: callId, name, args, status: 'pending', startedAt: nowIso() }
      const outputDir = path.join(RUNS, id, step.id)
      await fs.mkdir(outputDir, { recursive: true })
      await mutateRun(id, (run) => { run.steps.push(step) })
      emit('tool_start', { id: callId, stepId: step.id, name })
      try {
        if (needsApproval) await approval({ ...step, eventId: callId })
        signal.throwIfAborted()
        await mutateRun(id, (run) => { run.steps.find((s) => s.id === step.id).status = 'running' })
        const result = await execute(args, {
          signal, outputDir,
          onOutput: (chunk) => emit('tool_output', { id: callId, stepId: step.id, stream: chunk.stream, text: clip(chunk.text, 8000) }),
        })
        const resultFile = path.join(outputDir, 'result.txt')
        await fs.writeFile(resultFile, clip(result.text ?? '', 64000), { mode: 0o600 })
        const artifacts = await attachArtifacts(step.id, [...(result.artifacts ?? []), { file: resultFile }])
        await mutateRun(id, (run) => {
          Object.assign(run.steps.find((s) => s.id === step.id), {
            status: result.ok === false ? 'failed' : 'completed', finishedAt: nowIso(),
            result: clip(result.text ?? '', 16000), exitCode: result.exitCode ?? null,
            terminationReason: result.terminationReason, exitSignal: result.exitSignal,
            artifacts, changes: result.changes ?? [], truncated: Boolean(result.truncated),
          })
        })
        return { ...result, artifacts, runId: id, stepId: step.id }
      } catch (error) {
        const artifacts = await attachArtifacts(step.id, error.artifacts)
        await mutateRun(id, (run) => {
          run.status = 'running'
          Object.assign(run.steps.find((s) => s.id === step.id), {
            status: signal.aborted ? 'cancelled' : 'failed', finishedAt: nowIso(), error: error.message,
            artifacts, result: clip(error.result?.text ?? '', 16000),
            exitCode: error.result?.exitCode, terminationReason: error.result?.terminationReason, exitSignal: error.result?.exitSignal,
          })
        }).catch(() => {})
        error.artifacts = artifacts
        error.runId = id
        error.stepId = step.id
        throw error
      }
  }

  return {
    id, signal,
    async call(options) {
      const work = call(options)
      activeCalls.add(work)
      try { return await work } finally { activeCalls.delete(work) }
    },
    async readOutput({ runId = id, stepId, name, offset = 0, maxChars = 8000 }) {
      if (runId !== id && (await getRun(runId)).conversationId !== conversationId) throw failure(domainText('harness.crossChatOutput'))
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 16000) throw failure(domainText('harness.invalidPage'))
      const { file } = await artifactFile(runId, stepId, name)
      const text = await fs.readFile(file, 'utf8')
      const page = { content: '', nextOffset: Math.max(1000, text.length), totalChars: text.length }
      page.content = jsonTextPrefix(text.slice(offset, offset + maxChars), MODEL_TOOL_TEXT_LIMIT - JSON.stringify(page).length)
      const end = offset + page.content.length
      page.nextOffset = end < text.length ? end : null
      return { text: JSON.stringify(page), truncated: page.nextOffset !== null }
    },
    async finish(status, details = {}) {
      active.delete(id)
      parent?.removeEventListener('abort', abort)
      await mutateRun(id, (run) => {
        run.status = status
        run.finishedAt = nowIso()
        Object.assign(run, details)
      }).catch(() => {})
      emit('run_complete', { status })
    },
  }
}

export async function currentWorkspacePermission(initial, name) {
  const current = (await loadConfig()).harness ?? {}
  if (!current.enabled || current.workspaceRoot !== initial.workspaceRoot) throw failure(domainText('harness.permissionsRevoked'), 403)
  if (['workspace_write', 'workspace_edit'].includes(name) && !current.allowWrites) throw failure(domainText('harness.writesDisabled'), 403)
  if (name === 'shell_exec' && !current.allowShell) throw failure(domainText('harness.commandsDisabled'), 403)
  return current
}
