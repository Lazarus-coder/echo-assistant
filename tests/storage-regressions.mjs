import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-storage-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_LOG_LEVEL = 'error'
const { saveConfig, P } = await import('../lib/config.mjs')
const { privateCaptureSpool, pruneStorage, storageStats, sweepTempCaptures } = await import('../lib/storage.mjs')
const shots = path.join(sandbox, 'screenshots')
const MB = 1024 * 1024
const originalRm = fs.rm

async function setup(storage = {}) {
  for (const dir of [shots, P.uploads, P.convDir]) {
    await originalRm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
  }
  await saveConfig({ storage: {
    screenRetentionDays: 3, uploadRetentionDays: 60,
    screenImageBudgetMB: 100, uploadsBudgetMB: 100, ...storage,
  } })
}

async function file(dir, name, ageDays) {
  const full = path.join(dir, name)
  await fs.writeFile(full, Buffer.alloc(MB))
  const time = new Date(Date.now() - ageDays * 86400000)
  await fs.utimes(full, time, time)
  return full
}

function failRemoval(t, paths) {
  t.mock.method(fs, 'rm', async (full, options) => {
    if (paths.includes(full)) throw Object.assign(new Error('simulated permission failure'), { code: 'EACCES' })
    return originalRm(full, options)
  })
}

try {
  await test('capture cleanup stays in its own profile and preserves active, unrelated and linked files', async (t) => {
    const spool = path.join(sandbox, 'spool')
    const peer = path.join(sandbox, 'other-profile', 'spool')
    await fs.mkdir(peer, { recursive: true, mode: 0o750 })
    await fs.mkdir(spool)
    await fs.chmod(spool, 0o755)
    assert.equal(await privateCaptureSpool(), spool)
    assert.equal((await fs.stat(spool)).mode & 0o777, 0o700)
    const name = 'capture-' + randomUUID() + '.jpg'
    const peerFile = await file(peer, name, 2)
    await file(spool, name, 2)
    await file(spool, '.perm-probe-12345.jpg', 2)
    await file(spool, '.perm-probe-' + randomUUID() + '.jpg', 2)
    const active = await file(spool, 'capture-' + randomUUID() + '.jpg', 0)
    const unknown = await file(spool, 'meeting-notes.jpg', 2)
    const linked = path.join(spool, 'capture-' + randomUUID() + '.jpg')
    await fs.symlink(peerFile, linked)
    const read = fs.readdir, visits = []
    t.mock.method(fs, 'readdir', async (dir, ...opts) => {
      visits.push(dir)
      assert.equal(dir, spool, 'maintenance must only enumerate the fixture profile')
      return read(dir, ...opts)
    })
    assert.equal(await sweepTempCaptures(), 3)
    assert.equal(await sweepTempCaptures(), 0)
    assert.deepEqual(visits, [spool, spool])
    await Promise.all([active, unknown, linked, peerFile].map((p) => fs.access(p)))
    await fs.rename(spool, spool + '-saved')
    await fs.symlink(peer, spool)
    const before = (await fs.stat(peer)).mode
    assert.equal(await sweepTempCaptures(), 0)
    await assert.rejects(privateCaptureSpool)
    assert.equal((await fs.stat(peer)).mode, before)
    assert.deepEqual(visits, [spool, spool])
    await fs.access(peerFile)
  })

  for (const kind of ['screenshots', 'uploads']) {
    for (const phase of ['age', 'budget']) {
      await test(`${kind}: ${phase} cleanup counts only successful deletions and continues after failures`, async (t) => {
        const dir = kind === 'screenshots' ? shots : P.uploads
        const protectedCount = kind === 'uploads' ? 1 : 0
        const budgetKey = kind === 'screenshots' ? 'screenImageBudgetMB' : 'uploadsBudgetMB'
        await setup(phase === 'budget' ? { [budgetKey]: 2 + protectedCount } : {})
        const age = phase === 'age' ? 90 : 1
        const blocked = await file(dir, 'blocked.jpg', age + 1)
        await file(dir, 'removable.jpg', age)
        if (phase === 'budget') await file(dir, 'newest.jpg', 0)
        if (protectedCount) {
          await file(dir, 'protected.jpg', 100)
          await fs.writeFile(P.conv('recent'), JSON.stringify({ content: '/api/uploads/protected.jpg' }))
        }
        failRemoval(t, [blocked])
        const report = await pruneStorage({ force: true })
        const stats = await storageStats()
        const remaining = await fs.readdir(dir)
        assert.deepEqual(remaining.sort(), ['blocked.jpg', ...(protectedCount ? ['protected.jpg'] : [])])
        assert.equal(report[kind].afterMB, stats[kind].mb)
        assert.equal(report[kind].afterMB, 1 + protectedCount)
        assert.equal(report.freedMB, phase === 'age' ? 1 : 2)
        assert.equal(report[kind].beforeMB - report[kind].afterMB, report.freedMB)
        if (protectedCount) assert.equal(report.uploads.protected, 1)
      })
    }
  }

  await test('upload age and budget cleanup retry failures without counting successful deletions twice', async (t) => {
    await setup({ uploadsBudgetMB: 2 })
    const removed = await file(P.uploads, 'old.jpg', 90)
    const retried = await file(P.uploads, 'retry.jpg', 80)
    await file(P.uploads, 'new.jpg', 0)
    await file(P.uploads, 'protected.jpg', 100)
    await fs.writeFile(P.conv('recent'), JSON.stringify({ content: '/api/uploads/protected.jpg' }))
    const attempts = new Map()
    t.mock.method(fs, 'rm', async (full, options) => {
      attempts.set(full, (attempts.get(full) ?? 0) + 1)
      if (full === retried && attempts.get(full) === 1) {
        throw Object.assign(new Error('simulated temporary failure'), { code: 'EACCES' })
      }
      return originalRm(full, options)
    })
    const report = await pruneStorage()
    assert.equal(attempts.get(removed), 1)
    assert.equal(attempts.get(retried), 2)
    assert.deepEqual(await fs.readdir(P.uploads), ['protected.jpg'])
    assert.equal(report.uploads.beforeMB, 4)
    assert.equal(report.uploads.afterMB, 1)
    assert.equal(report.freedMB, 3)
  })

  await test('failed deletions release no storage and remain visible in both totals', async (t) => {
    await setup()
    const blocked = await Promise.all([file(shots, 'blocked.jpg', 90), file(P.uploads, 'blocked.jpg', 90)])
    failRemoval(t, blocked)
    const report = await pruneStorage()
    assert.equal(report.freedMB, 0)
    assert.equal(report.screenshots.afterMB, 1)
    assert.equal(report.uploads.afterMB, 1)
    await Promise.all(blocked.map((full) => fs.access(full)))
  })
} finally {
  await originalRm(sandbox, { recursive: true, force: true })
}
