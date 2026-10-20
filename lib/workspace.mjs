import path from 'node:path'
import os from 'node:os'
import { constants, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { DATA, P, ROOT } from './config.mjs'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_CHARS = 8000
const fileWrites = new Map()
const hash = (value) => createHash('sha256').update(value).digest('hex')
const inside = (root, target) => target === root || target.startsWith(root + path.sep)
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
const abortError = () => Object.assign(new Error('Operation stopped'), { name: 'AbortError' })
const checkAbort = (signal) => { if (signal?.aborted) throw abortError() }

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}
const filePath = { type: 'string', description: 'Path relative to the selected workspace. Symlink traversal and Echo private data are blocked.' }
const expectedHash = { type: 'string', description: 'Exact SHA-256 hash returned by workspace_read; required before replacing an existing file.' }
export const WORKSPACE_TOOLS = [
  tool('workspace_list', 'List one workspace directory, with bounded pagination.', {
    path: filePath, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
  }),
  tool('workspace_read', 'Read a UTF-8 text file, returning its content hash and numbered lines. Read more pages before editing if truncated.', {
    path: filePath, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 1000 },
    startColumn: { type: 'integer', minimum: 1, description: 'First character to read on startLine, default 1. Use nextColumn when continuing a long line.' },
  }, ['path']),
  tool('workspace_write', 'Create a UTF-8 file or replace an existing file after checking its expectedHash. Saves before/after review snapshots. Parent directory must exist.', {
    path: filePath, content: { type: 'string' }, expectedHash,
  }, ['path', 'content']),
  tool('workspace_edit', 'Replace exactly one occurrence of oldText in a UTF-8 file. Requires its current hash and saves before/after review snapshots.', {
    path: filePath, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, expectedHash,
  }, ['path', 'oldText', 'newText', 'expectedHash']),
  tool('shell_exec', 'Run a shell command after user approval. This is trusted host execution, not an OS sandbox: cwd does not restrict filesystem or network access. Logs are saved, output is bounded, and execution stops after timeout or cancellation.', {
    command: { type: 'string', minLength: 1 },
    cwd: { ...filePath, description: 'Working directory relative to the workspace, default ".".' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
  }, ['command']),
]

async function canonicalExistingAncestor(target) {
  const tail = []
  let current = path.resolve(target)
  while (true) {
    try { return path.join(await fs.realpath(current), ...tail.reverse()) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      tail.push(path.basename(current))
      current = parent
    }
  }
}

async function protectedPaths() {
  return Promise.all([DATA, P.config, path.join(ROOT, '.env')].map(canonicalExistingAncestor))
}

function protectedTarget(target, blocked) {
  return blocked.some((entry) => inside(entry, target))
}

export async function validateWorkspaceRoot(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0') || !path.isAbsolute(root)) throw failure('Choose an absolute workspace directory')
  const real = await fs.realpath(root).catch(() => { throw failure('Workspace directory does not exist') })
  if (!(await fs.stat(real)).isDirectory()) throw failure('Workspace must be a directory')
  if (real === path.parse(real).root) throw failure('Choose a specific workspace, not the filesystem root')
  if (protectedTarget(real, await protectedPaths())) throw failure('Echo private data cannot be a workspace', 403)
  return real
}

function relativePath(value, fallback) {
  const input = value === undefined ? fallback : value
  if (typeof input !== 'string' || !input || input.includes('\0') || path.isAbsolute(input)) throw failure('Path must be relative to the workspace')
  if (input.split(/[\\/]/).includes('..')) throw failure('Path traversal is not allowed', 403)
  return input
}

async function resolvePath(root, value, { missing = false, fallback } = {}) {
  const input = relativePath(value, fallback)
  const target = path.resolve(root, input)
  if (!inside(root, target)) throw failure('Path is outside the workspace', 403)
  const blocked = await protectedPaths()
  if (protectedTarget(target, blocked)) throw failure('Echo private data is not available to workspace tools', 403)
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    const stat = await fs.lstat(current).catch((error) => {
      if (missing && index === parts.length - 1 && error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return target
    if (stat.isSymbolicLink()) throw failure('Workspace tools do not follow symlinks', 403)
    if (index < parts.length - 1 && !stat.isDirectory()) throw failure('Parent path is not a directory')
  }
  return target
}

function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : value
  if (!Number.isSafeInteger(n) || n < min || n > max) throw failure(`${name} must be between ${min} and ${max}`)
  return n
}

function textInput(value, name, { nonempty = false } = {}) {
  if (typeof value !== 'string' || (nonempty && !value) || Buffer.byteLength(value) > MAX_FILE_BYTES) throw failure(`${name} must be text of at most 1 MiB`)
  if (value.includes('\0')) throw failure('Binary content is not supported')
  return value
}

function decode(buffer) {
  if (buffer.includes(0)) throw failure('Binary files are not supported')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) }
  catch { throw failure('Only UTF-8 text files are supported') }
}

async function readText(target) {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw failure('Path must be a regular file')
    if (stat.size > MAX_FILE_BYTES) throw failure('File exceeds the 1 MiB text budget')
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > MAX_FILE_BYTES) throw failure('File exceeds the 1 MiB text budget')
    const content = bytes.subarray(0, length)
    return { content: decode(content), hash: hash(content), mode: stat.mode & 0o777, bytes: length }
  } finally { await handle.close() }
}

async function listDirectory(root, args, signal) {
  const target = await resolvePath(root, args.path, { fallback: '.' })
  if (!(await fs.stat(target)).isDirectory()) throw failure('Path must be a directory')
  const offset = integer(args.offset, 0, 0, 1000000, 'offset')
  const limit = integer(args.limit, 200, 1, 500, 'limit')
  const blocked = await protectedPaths()
  const entries = []
  const directory = await fs.opendir(target)
  for await (const entry of directory) {
    checkAbort(signal)
    if (protectedTarget(path.join(target, entry.name), blocked)) continue
    entries.push({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })
    if (entries.length > 10000) throw failure('Directory has more than 10,000 entries; choose a smaller directory')
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const page = entries.slice(offset, offset + limit)
  return { text: JSON.stringify({ path: path.relative(root, target) || '.', entries: page, total: entries.length, nextOffset: offset + page.length < entries.length ? offset + page.length : null }), artifacts: [] }
}

async function readFile(root, args, signal) {
  const target = await resolvePath(root, args.path)
  const startLine = integer(args.startLine, 1, 1, 10000000, 'startLine')
  const startColumn = integer(args.startColumn, 1, 1, MAX_FILE_BYTES + 1, 'startColumn')
  const maxLines = integer(args.maxLines, 200, 1, 1000, 'maxLines')
  const current = await readText(target)
  checkAbort(signal)
  const lines = current.content.split('\n')
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines)
  const numbered = []
  let remaining = 64000
  let partialLine = false
  let nextColumn = 1
  for (let index = 0; index < selected.length; index++) {
    const column = index === 0 ? startColumn : 1
    const prefix = `${startLine + index}: `
    if (remaining <= prefix.length) break
    const full = selected[index].slice(column - 1)
    const visible = full.slice(0, remaining - prefix.length)
    numbered.push(prefix + visible)
    remaining -= prefix.length + visible.length + 1
    if (visible.length < full.length) {
      partialLine = true
      nextColumn = column + visible.length
      break
    }
  }
  const endLine = startLine + numbered.length - 1
  const truncated = partialLine || endLine < lines.length
  return {
    text: JSON.stringify({ path: path.relative(root, target), hash: current.hash, bytes: current.bytes, totalLines: lines.length, startLine, startColumn, endLine, content: numbered.join('\n'), truncated, partialLine, nextLine: truncated ? (partialLine ? endLine : endLine + 1) : null, nextColumn: truncated ? nextColumn : null }),
    truncated, artifacts: [],
  }
}

async function artifactDirectory(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw failure('A local output directory is required')
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 })
  return fs.realpath(outputDir)
}

async function snapshot(dir, name, content) {
  const file = path.join(dir, name)
  await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 })
  return { name, file, bytes: Buffer.byteLength(content), mime: 'text/plain; charset=utf-8' }
}

function lockFile(target, operation) {
  const result = (fileWrites.get(target) ?? Promise.resolve()).then(operation)
  const pending = result.catch(() => {})
  fileWrites.set(target, pending)
  pending.finally(() => { if (fileWrites.get(target) === pending) fileWrites.delete(target) })
  return result
}

async function writeFile(root, name, args, { signal, outputDir }) {
  const initialTarget = await resolvePath(root, args.path, { missing: name === 'workspace_write' })
  return lockFile(initialTarget, async () => {
    checkAbort(signal)
    const target = await resolvePath(root, args.path, { missing: name === 'workspace_write' })
    const current = await readText(target).catch((error) => { if (error.code === 'ENOENT' && name === 'workspace_write') return null; throw error })
    if (args.expectedHash !== undefined && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash))) throw failure('expectedHash must be the SHA-256 returned by workspace_read')
    if (current && args.expectedHash !== current.hash) throw failure('File changed or expectedHash is missing. Read the file before editing.', 409)
    if (!current && args.expectedHash !== undefined) throw failure('Expected file no longer exists. Read the workspace again.', 409)
    let content
    if (name === 'workspace_edit') {
      const oldText = textInput(args.oldText, 'oldText', { nonempty: true })
      const newText = textInput(args.newText, 'newText')
      const index = current.content.indexOf(oldText)
      if (index < 0 || current.content.indexOf(oldText, index + 1) >= 0) throw failure('oldText must occur exactly once; include more surrounding text', 409)
      content = current.content.slice(0, index) + newText + current.content.slice(index + oldText.length)
    } else content = textInput(args.content, 'content')
    textInput(content, 'Result')
    const after = hash(content)
    if (current?.hash === after) return { text: JSON.stringify({ path: path.relative(root, target), hash: after, changed: false }), artifacts: [], changes: [] }
    const dir = await artifactDirectory(outputDir)
    const token = randomUUID()
    const artifacts = []
    if (current) artifacts.push(await snapshot(dir, `${token}.before.txt`, current.content))
    artifacts.push(await snapshot(dir, `${token}.after.txt`, content))
    checkAbort(signal)
    await resolvePath(root, args.path, { missing: !current })
    // Recheck after snapshot I/O so a user's intervening edit is not replaced.
    if (current && (await readText(target)).hash !== current.hash) throw failure('File changed while preparing the edit. Read it again.', 409)
    checkAbort(signal)
    if (!current) await fs.writeFile(target, content, { flag: 'wx', mode: 0o644 }).catch((error) => { if (error.code === 'EEXIST') throw failure('File was created concurrently. Read it before editing.', 409); throw error })
    else {
      const temporary = path.join(path.dirname(target), `.echo-${token}.tmp`)
      try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: current.mode })
        checkAbort(signal)
        await resolvePath(root, args.path)
        if ((await readText(target)).hash !== current.hash) throw failure('File changed while preparing the edit. Read it again.', 409)
        await fs.rename(temporary, target)
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
    }
    const change = { path: path.relative(root, target), before: current?.hash ?? null, after }
    return { text: JSON.stringify({ ...change, hash: after, changed: true, bytes: Buffer.byteLength(content) }), ok: true, artifacts, changes: [change] }
  })
}

function shellEnvironment(cwd) {
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), SHELL: '/bin/sh', PWD: cwd, TERM: 'dumb' }
  for (const key of ['USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key]
  return env
}

async function shellExec(root, args, { signal, outputDir, onOutput, timeoutMs: configuredTimeout, maxOutputBytes: configuredOutput }) {
  const command = textInput(args.command, 'command', { nonempty: true })
  if (command.length > 32000) throw failure('Command exceeds 32,000 characters')
  const timeoutCeiling = integer(configuredTimeout, 120000, 100, 120000, 'Configured timeout')
  const timeoutMs = integer(args.timeoutMs, Math.min(60000, timeoutCeiling), 100, timeoutCeiling, 'timeoutMs')
  const maxOutputBytes = integer(configuredOutput, MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES, 'Configured output budget')
  const cwd = await resolvePath(root, args.cwd, { fallback: '.' })
  if (!(await fs.stat(cwd)).isDirectory()) throw failure('Shell cwd must be a directory')
  const dir = await artifactDirectory(outputDir)
  checkAbort(signal)
  const files = { stdout: path.join(dir, 'stdout.txt'), stderr: path.join(dir, 'stderr.txt') }
  const handles = {}
  try {
    for (const stream of ['stdout', 'stderr']) handles[stream] = await fs.open(files[stream], 'wx', 0o600)
  } catch (error) {
    await Promise.all(Object.values(handles).map((handle) => handle.close()))
    throw error
  }
  const sizes = { stdout: 0, stderr: 0 }
  const queues = { stdout: Promise.resolve(), stderr: Promise.resolve() }
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const preview = { stdout: '', stderr: '' }
  let received = 0, emitted = 0, reason = null, processError = null, timer, killer, child
  const killGroup = (sig) => {
    if (!child?.pid) return
    try { process.kill(-child.pid, sig) } catch (error) { if (error.code !== 'ESRCH') processError ??= error }
  }
  const stop = (why) => {
    if (reason) return
    reason = why
    killGroup('SIGTERM')
    killer = setTimeout(() => killGroup('SIGKILL'), 250)
  }
  const onAbort = () => stop('cancelled')
  const output = (stream, chunk) => {
    const available = Math.max(0, maxOutputBytes - received)
    const accepted = chunk.subarray(0, available)
    received += accepted.length
    sizes[stream] += accepted.length
    if (accepted.length) {
      queues[stream] = queues[stream].then(async () => {
        let offset = 0
        while (offset < accepted.length) {
          const { bytesWritten } = await handles[stream].write(accepted, offset, accepted.length - offset)
          if (!bytesWritten) throw failure('Unable to save command output', 500)
          offset += bytesWritten
        }
      }).catch((error) => { processError ??= error; stop('output_error') })
      const decoded = decoders[stream].write(accepted)
      const remaining = MAX_PREVIEW_CHARS - preview.stdout.length - preview.stderr.length
      if (remaining > 0) preview[stream] += decoded.slice(0, remaining)
      // Live events share the same bounded preview budget as the final result.
      const event = decoded.slice(0, Math.max(0, MAX_PREVIEW_CHARS - emitted))
      emitted += event.length
      if (event && onOutput) {
        try { Promise.resolve(onOutput({ stream, text: event })).catch(() => {}) } catch {}
      }
    }
    if (chunk.length > accepted.length) stop('output_limit')
  }
  let exitCode = null, exitSignal = null
  try {
    checkAbort(signal)
    child = spawn('/bin/sh', ['-c', command], { cwd, env: shellEnvironment(cwd), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => output('stdout', chunk))
    child.stderr.on('data', (chunk) => output('stderr', chunk))
    timer = setTimeout(() => stop('timeout'), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    await new Promise((resolve) => {
      child.on('error', (error) => { processError = error })
      child.on('close', (code, sig) => { exitCode = code; exitSignal = sig; resolve() })
    })
    // A descendant may close its pipes but ignore TERM; finish killing the group.
    if (reason) killGroup('SIGKILL')
    await Promise.all(Object.values(queues))
  } finally {
    clearTimeout(timer)
    clearTimeout(killer)
    signal?.removeEventListener('abort', onAbort)
    await Promise.all(Object.values(handles).map((handle) => handle.close()))
  }
  const artifacts = ['stdout', 'stderr'].map((stream) => ({ name: `${stream}.txt`, file: files[stream], bytes: sizes[stream], mime: 'text/plain; charset=utf-8' }))
  const truncated = reason === 'output_limit' || received > Buffer.byteLength(preview.stdout + preview.stderr)
  const result = {
    text: JSON.stringify({ command, cwd: path.relative(root, cwd) || '.', exitCode, signal: exitSignal, reason: reason ?? (processError ? 'process_error' : null), stdout: preview.stdout, stderr: preview.stderr, error: processError?.message, outputBytes: received, truncated }),
    ok: !reason && !processError && exitCode === 0, exitCode, artifacts,
    truncated,
  }
  if (reason === 'cancelled') throw Object.assign(abortError(), { artifacts, result })
  return result
}

export async function executeWorkspaceTool(name, args, options = {}) {
  if (!WORKSPACE_TOOLS.some((entry) => entry.function.name === name)) throw failure('Unknown workspace tool')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('Tool arguments must be an object')
  const allowed = new Set(Object.keys(WORKSPACE_TOOLS.find((entry) => entry.function.name === name).function.parameters.properties))
  if (Object.keys(args).some((key) => !allowed.has(key))) throw failure('Unsupported tool argument')
  checkAbort(options.signal)
  const root = await validateWorkspaceRoot(options.workspaceRoot)
  if (root !== path.resolve(options.workspaceRoot)) throw failure('Workspace path changed. Select the workspace again before continuing.', 403)
  if (name === 'workspace_list') return listDirectory(root, args, options.signal)
  if (name === 'workspace_read') return readFile(root, args, options.signal)
  if (name === 'shell_exec') {
    if (options.allowShell !== true) throw failure('Shell execution is not enabled for this run', 403)
    return shellExec(root, args, options)
  }
  if (options.allowWrites !== true) throw failure('Workspace writes are not enabled for this run', 403)
  return writeFile(root, name, args, options)
}
