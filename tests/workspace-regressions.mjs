import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-workspace-'))
let workspaceRoot = path.join(sandbox, 'workspace')
const outside = path.join(sandbox, 'outside')
process.env.ECHO_DATA_DIR = path.join(workspaceRoot, 'echo-private')
process.env.ECHO_CONFIG = path.join(workspaceRoot, 'echo-settings.json')
process.env.ECHO_TEST_SECRET = 'must-not-reach-shell'
process.env.OPENAI_API_KEY = 'also-must-not-reach-shell'
await fs.mkdir(workspaceRoot)
workspaceRoot = await fs.realpath(workspaceRoot)
await fs.mkdir(outside)
await fs.mkdir(process.env.ECHO_DATA_DIR)
await fs.writeFile(path.join(process.env.ECHO_DATA_DIR, 'private.txt'), 'private memory')
await fs.writeFile(process.env.ECHO_CONFIG, '{"private":"settings"}')
const { WORKSPACE_TOOLS, executeWorkspaceTool, validateWorkspaceRoot } = await import('../lib/workspace.mjs')
let sequence = 0
const options = (extra = {}) => ({ workspaceRoot, allowWrites: true, allowShell: true, outputDir: path.join(sandbox, 'output', String(++sequence)), ...extra })
const call = (name, args, extra = {}) => executeWorkspaceTool(name, args, options(extra))
const parsed = (result) => JSON.parse(result.text)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const node = quote(process.execPath)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await test('tool definitions expose conventional function calling and root validation', async () => {
    assert.deepEqual(WORKSPACE_TOOLS.map((entry) => entry.function.name), ['workspace_list', 'workspace_read', 'workspace_write', 'workspace_edit', 'shell_exec'])
    for (const tool of WORKSPACE_TOOLS) assert.equal(tool.function.parameters.additionalProperties, false)
    assert.equal(await validateWorkspaceRoot(workspaceRoot), await fs.realpath(workspaceRoot))
    await assert.rejects(validateWorkspaceRoot('/'), /specific workspace/)
    await assert.rejects(validateWorkspaceRoot('relative'), /absolute workspace/)
    await assert.rejects(validateWorkspaceRoot(process.env.ECHO_DATA_DIR), { status: 403 })
    await assert.rejects(validateWorkspaceRoot(path.join(workspaceRoot, 'missing')), /does not exist/)
  })

  await test('file paths block traversal, outside symlinks, directory symlinks, and Echo private files', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside')
    await fs.symlink(outside, path.join(workspaceRoot, 'outside-link'))
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(workspaceRoot, 'file-link'))
    for (const file of ['../outside/secret.txt', path.join(outside, 'secret.txt'), 'outside-link/secret.txt', 'file-link', 'echo-private/private.txt', 'echo-settings.json']) {
      await assert.rejects(call('workspace_read', { path: file }))
      await assert.rejects(call('workspace_write', { path: file, content: 'changed' }))
    }
    assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside')
    const listing = parsed(await call('workspace_list', {}))
    assert.equal(listing.entries.some((entry) => entry.name === 'echo-private' || entry.name === 'echo-settings.json'), false)
    assert.equal(listing.entries.find((entry) => entry.name === 'outside-link').type, 'symlink')
    await assert.rejects(call('shell_exec', { command: 'pwd', cwd: '../outside' }), { status: 403 })
  })

  await test('replacing the selected workspace with a symlink does not authorize a new root', async () => {
    const selected = path.join(workspaceRoot, 'selected-root')
    await fs.mkdir(selected)
    const authorizedRoot = await validateWorkspaceRoot(selected)
    await fs.rename(selected, path.join(workspaceRoot, 'original-root'))
    await fs.symlink(outside, selected)
    await assert.rejects(call('workspace_read', { path: 'secret.txt' }, { workspaceRoot: authorizedRoot }), { status: 403 })
    await assert.rejects(call('shell_exec', { command: 'pwd' }, { workspaceRoot: authorizedRoot }), { status: 403 })
    assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside')
  })

  await test('create, paginated read, exact edit, and review snapshots preserve hashes and content', async () => {
    const created = await call('workspace_write', { path: 'notes.txt', content: 'one\ntwo\nthree\n' })
    const initial = parsed(created)
    assert.equal(initial.changed, true)
    assert.equal(created.changes[0].before, null)
    assert.match(initial.hash, /^[a-f0-9]{64}$/)
    assert.equal(created.artifacts.length, 1)
    assert.equal(await fs.readFile(created.artifacts[0].file, 'utf8'), 'one\ntwo\nthree\n')
    const read = parsed(await call('workspace_read', { path: 'notes.txt', startLine: 2, maxLines: 1 }))
    assert.equal(read.content, '2: two')
    assert.equal(read.nextLine, 3)
    assert.equal(read.hash, initial.hash)
    const edited = await call('workspace_edit', { path: 'notes.txt', oldText: 'two', newText: 'TWO', expectedHash: read.hash })
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes.txt'), 'utf8'), 'one\nTWO\nthree\n')
    assert.equal(edited.artifacts.length, 2)
    assert.equal(await fs.readFile(edited.artifacts[0].file, 'utf8'), 'one\ntwo\nthree\n')
    assert.equal(await fs.readFile(edited.artifacts[1].file, 'utf8'), 'one\nTWO\nthree\n')
    assert.equal(edited.changes[0].before, read.hash)
    assert.notEqual(edited.changes[0].after, read.hash)
    assert.equal((await fs.stat(path.join(workspaceRoot, 'notes.txt'))).mode & 0o777, 0o644)
  })

  await test('existing files require current hashes and repeated text requires a unique replacement', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'repeat.txt'), 'same same')
    const before = parsed(await call('workspace_read', { path: 'repeat.txt' }))
    await assert.rejects(call('workspace_write', { path: 'repeat.txt', content: 'blind overwrite' }), { status: 409 })
    await assert.rejects(call('workspace_write', { path: 'repeat.txt', content: 'stale overwrite', expectedHash: '0'.repeat(64) }), { status: 409 })
    await assert.rejects(call('workspace_edit', { path: 'repeat.txt', oldText: 'same', newText: 'different', expectedHash: before.hash }), { status: 409 })
    await assert.rejects(call('workspace_edit', { path: 'repeat.txt', oldText: '', newText: 'different', expectedHash: before.hash }), { status: 400 })
    await assert.rejects(call('workspace_write', { path: 'missing-hash.txt', content: 'new', expectedHash: before.hash }), { status: 409 })
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'repeat.txt'), 'utf8'), 'same same')
    const unchanged = await call('workspace_write', { path: 'repeat.txt', content: 'same same', expectedHash: before.hash })
    assert.equal(parsed(unchanged).changed, false)
    assert.deepEqual(unchanged.artifacts, [])
  })

  await test('concurrent edits with one original hash cannot overwrite each other', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'race.txt'), 'original')
    const { hash } = parsed(await call('workspace_read', { path: 'race.txt' }))
    const results = await Promise.allSettled(['first', 'second'].map((content) => call('workspace_write', { path: 'race.txt', content, expectedHash: hash })))
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409)
  })

  await test('long text lines have usable continuation columns and UTF-8 BOM survives edits', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'long-line.txt'), 'x'.repeat(90000) + '\nlast')
    const first = parsed(await call('workspace_read', { path: 'long-line.txt' }))
    assert.equal(first.partialLine, true)
    assert.equal(first.nextLine, 1)
    assert.ok(first.nextColumn > 1)
    const second = parsed(await call('workspace_read', { path: 'long-line.txt', startLine: first.nextLine, startColumn: first.nextColumn }))
    assert.equal(second.truncated, false)
    const restored = first.content.slice(3) + second.content.split('\n')[0].slice(3)
    assert.equal(restored, 'x'.repeat(90000))
    await fs.writeFile(path.join(workspaceRoot, 'bom.txt'), '\ufefforiginal')
    const original = parsed(await call('workspace_read', { path: 'bom.txt' }))
    await call('workspace_edit', { path: 'bom.txt', oldText: 'original', newText: 'updated', expectedHash: original.hash })
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'bom.txt'), 'utf8'), '\ufeffupdated')
  })

  await test('file tools enforce text, size, pagination, permissions, and argument bounds', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'binary.dat'), Buffer.from([65, 0, 66]))
    await fs.writeFile(path.join(workspaceRoot, 'invalid.dat'), Buffer.from([255, 254, 65]))
    await fs.writeFile(path.join(workspaceRoot, 'large.txt'), 'a'.repeat(1024 * 1024 + 1))
    await assert.rejects(call('workspace_read', { path: 'binary.dat' }), /Binary/)
    await assert.rejects(call('workspace_read', { path: 'invalid.dat' }), /UTF-8/)
    await assert.rejects(call('workspace_read', { path: 'large.txt' }), /budget/)
    await assert.rejects(call('workspace_read', { path: '.', startLine: 0 }), /startLine/)
    await assert.rejects(call('workspace_list', { limit: 501 }), /limit/)
    await assert.rejects(call('workspace_list', { limit: null }), /limit/)
    await assert.rejects(call('workspace_write', { path: 'denied.txt', content: 'x' }, { allowWrites: false }), { status: 403 })
    await assert.rejects(call('workspace_write', { path: 'invalid-write.txt', content: '\0' }), /Binary/)
    await assert.rejects(call('workspace_read', { path: 'notes.txt', unexpected: true }), /Unsupported/)
    await assert.rejects(call('unknown', {}), /Unknown/)
    const page = parsed(await call('workspace_list', { limit: 2, offset: 1 }))
    assert.equal(page.entries.length, 2)
    assert.equal(page.nextOffset, 3)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(call('workspace_write', { path: 'aborted.txt', content: 'x' }, { signal: controller.signal }), { name: 'AbortError' })
    await assert.rejects(fs.stat(path.join(workspaceRoot, 'aborted.txt')), { code: 'ENOENT' })
  })

  await test('shell returns stdout, stderr, nonzero status, and downloadable output files', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'subdir'))
    const result = await call('shell_exec', { command: 'printf "hello"; printf "problem" >&2; exit 7', cwd: 'subdir' })
    const output = parsed(result)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 7)
    assert.equal(output.cwd, 'subdir')
    assert.equal(output.stdout, 'hello')
    assert.equal(output.stderr, 'problem')
    assert.equal(await fs.readFile(result.artifacts[0].file, 'utf8'), 'hello')
    assert.equal(await fs.readFile(result.artifacts[1].file, 'utf8'), 'problem')
    assert.equal(result.artifacts[0].bytes, 5)
    const success = await call('shell_exec', { command: 'printf done' })
    assert.equal(success.ok, true)
    await assert.rejects(call('shell_exec', { command: 'true' }, { allowShell: false }), { status: 403 })
    await assert.rejects(call('shell_exec', { command: 'true', timeoutMs: 120001 }), /timeoutMs/)
  })

  await test('shell uses a credential-free environment allowlist and no implicit startup environment', async () => {
    process.env.BASH_ENV = '/should-not-be-loaded'
    process.env.NODE_OPTIONS = '--invalid-secret-option'
    const result = await call('shell_exec', { command: '/usr/bin/env' })
    assert.equal(result.ok, true)
    const environment = parsed(result).stdout
    assert.ok(environment.includes(`PWD=${await fs.realpath(workspaceRoot)}`))
    assert.ok(environment.includes('PATH='))
    for (const secret of ['must-not-reach-shell', 'OPENAI_API_KEY', 'ECHO_TEST_SECRET', 'BASH_ENV', 'NODE_OPTIONS', 'ECHO_DATA_DIR', 'ECHO_CONFIG']) assert.ok(!environment.includes(secret), secret)
    delete process.env.BASH_ENV
    delete process.env.NODE_OPTIONS
  })

  await test('shell output limit terminates the command and retains bounded logs and live preview', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'flood.mjs'), "const b=Buffer.alloc(65536,120); setInterval(()=>process.stdout.write(b),1)")
    let live = ''
    const result = await call('shell_exec', { command: `${node} flood.mjs`, timeoutMs: 5000 }, { onOutput: ({ text }) => { live += text } })
    assert.equal(result.ok, false)
    assert.equal(parsed(result).reason, 'output_limit')
    assert.equal(result.truncated, true)
    assert.ok(live.length > 0 && live.length <= 8000)
    assert.ok(parsed(result).stdout.length <= 8000)
    assert.equal(result.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0), 2 * 1024 * 1024)
    for (const artifact of result.artifacts) assert.equal((await fs.stat(artifact.file)).size, artifact.bytes)
  })

  await test('timeout kills a process group that ignores TERM', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'stubborn.mjs'), "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")
    const started = Date.now()
    const result = await call('shell_exec', { command: `${node} stubborn.mjs`, timeoutMs: 200 })
    assert.equal(result.ok, false)
    assert.equal(parsed(result).reason, 'timeout')
    assert.ok(Date.now() - started < 3000)
  })

  await test('configured shell caps cannot be widened by tool arguments', async () => {
    await assert.rejects(call('shell_exec', { command: 'true', timeoutMs: 1000 }, { timeoutMs: 200 }), /timeoutMs/)
    const timed = await call('shell_exec', { command: `${node} stubborn.mjs` }, { timeoutMs: 200 })
    assert.equal(parsed(timed).reason, 'timeout')
    const bounded = await call('shell_exec', { command: `${node} flood.mjs` }, { maxOutputBytes: 1024 })
    assert.equal(parsed(bounded).reason, 'output_limit')
    assert.equal(bounded.truncated, true)
    assert.equal(bounded.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0), 1024)
  })

  await test('Stop cancels descendants and exposes partial output artifacts on AbortError', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'descendant.mjs'), "import fs from 'node:fs';process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('ticks.txt','x'),20)")
    await fs.writeFile(path.join(workspaceRoot, 'parent.mjs'), "import {spawn} from 'node:child_process';process.on('SIGTERM',()=>{});spawn(process.execPath,['descendant.mjs'],{stdio:'inherit'});console.log('started');setInterval(()=>{},1000)")
    const controller = new AbortController()
    let abortTimer
    let caught
    try {
      await call('shell_exec', { command: `${node} parent.mjs`, timeoutMs: 5000 }, { signal: controller.signal, onOutput: () => { abortTimer ??= setTimeout(() => controller.abort(), 150) } })
    } catch (error) { caught = error }
    clearTimeout(abortTimer)
    assert.equal(caught?.name, 'AbortError')
    assert.equal(parsed(caught.result).reason, 'cancelled')
    assert.equal(caught.artifacts.length, 2)
    assert.ok((await fs.readFile(caught.artifacts[0].file, 'utf8')).includes('started'))
    const ticks = await fs.readFile(path.join(workspaceRoot, 'ticks.txt'), 'utf8')
    assert.ok(ticks.length > 0)
    await pause(150)
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'ticks.txt'), 'utf8'), ticks)
  })
} finally {
  delete process.env.ECHO_TEST_SECRET
  delete process.env.OPENAI_API_KEY
  delete process.env.BASH_ENV
  delete process.env.NODE_OPTIONS
  await fs.rm(sandbox, { recursive: true, force: true })
}
