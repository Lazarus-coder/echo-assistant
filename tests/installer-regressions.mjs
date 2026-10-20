#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const source = await readFile(new URL('../scripts/macos/Install Echo.command', import.meta.url), 'utf8')
const options = source.match(/^while \[ \$# -gt 0 \]; do\n[\s\S]*?^done$/m)?.[0]
const copyApp = source.match(/^if \[ -d "\$SRC\/Echo\.app" \]; then\n[\s\S]*?^fi$/m)?.[0]
const quarantine = source.match(/^APP_PATH="\$TARGET\/Echo\.app"\nif [^\n]*quarantine[^\n]*\n[\s\S]*?^fi$/m)?.[0]
const credentials = source.slice(source.indexOf('ENV_FILE='), source.indexOf('# ── 4.'))
assert.ok(options && copyApp && quarantine && credentials.startsWith('ENV_FILE='), 'Installer fragments must be available for the isolated check')

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'echo-installer-regression-'))
try {
  const sourceDir = path.join(sandbox, 'package')
  const target = path.join(sandbox, 'Custom Echo')
  await mkdir(path.join(sourceDir, 'Echo.app'), { recursive: true })
  await mkdir(path.join(target, 'Echo.app'), { recursive: true })
  // Run only the option/copy/quarantine fragments; every external operation is recorded.
  const script = `
set -euo pipefail
SRC="$INSTALLER_TEST_SOURCE"
TARGET="$INSTALLER_TEST_DEFAULT"
DO_LAUNCHD=1
DO_OPEN=1
ASSUME_YES=0
UID_NUM=999
MENUBAR_LABEL=com.echo.menubar
record() { printf '%s\\0' "$@" >> "$INSTALLER_TEST_CALLS"; printf '\\0' >> "$INSTALLER_TEST_CALLS"; }
rm() { record rm "$@"; }
ditto() { record ditto "$@"; }
codesign() { record codesign "$@"; }
xattr() { record xattr "$@"; }
launchctl() { record launchctl "$@"; }
ok() { :; }
info() { :; }
warn() { :; }
${options}
${copyApp}
${quarantine}
`
  for (const noLaunchd of [true, false]) {
    const callsFile = path.join(sandbox, noLaunchd ? 'no-launchd.calls' : 'launchd.calls')
    const result = spawnSync('/bin/bash', ['-c', script, 'installer-check', '--target', target, '--no-open', ...(noLaunchd ? ['--no-launchd'] : [])], {
      encoding: 'utf8',
      input: 'y\n',
      timeout: 5000,
      env: { PATH: '', INSTALLER_TEST_SOURCE: sourceDir, INSTALLER_TEST_DEFAULT: path.join(sandbox, 'unused'), INSTALLER_TEST_CALLS: callsFile },
    })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    const calls = (await readFile(callsFile, 'utf8')).split('\0\0').filter(Boolean).map((call) => call.split('\0'))
    assert.deepEqual(calls.filter(([name]) => name === 'rm'), [['rm', '-rf', path.join(target, 'Echo.app')]], 'A custom target must never remove /Applications/Echo.app or another installation')
    assert.deepEqual(calls.filter(([name]) => name === 'ditto'), [['ditto', path.join(sourceDir, 'Echo.app'), path.join(target, 'Echo.app')]])
    assert.equal(calls.find(([name]) => name === 'codesign')?.at(-1), path.join(target, 'Echo.app'))
    assert.ok(calls.some(([name, action]) => name === 'xattr' && action === '-dr'), 'The accepted quarantine action must run before checking its launchd guard')
    assert.deepEqual(calls.filter(([name]) => name === 'launchctl'), noLaunchd ? [] : [['launchctl', 'kickstart', '-k', 'gui/999/com.echo.menubar']], '--no-launchd must also suppress quarantine-triggered restarts')
    console.log(`✓ custom target and quarantine behavior (${noLaunchd ? '--no-launchd' : 'launchd enabled'})`)
  }
  await mkdir(path.join(target, 'data'))
  for (const key of ['fixture-first-key', 'fixture-replacement-key']) {
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
TARGET="$INSTALLER_TEST_TARGET"
ASSUME_YES=1
ok() { :; }
info() { :; }
${credentials}`], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8', INSTALLER_TEST_TARGET: target, OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://example.invalid/v1' },
    })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    const envFile = path.join(target, 'data/echo.env')
    assert.match(await readFile(envFile, 'utf8'), /OPENAI_API_KEY=fixture-first-key\n/, 'An upgrade must retain existing credentials')
    assert.equal((await stat(envFile)).mode & 0o777, 0o600)
    console.log(`✓ UTF-8 installer credentials (${key === 'fixture-first-key' ? 'first install' : 'upgrade preserves existing key'})`)
  }
} finally {
  await rm(sandbox, { recursive: true, force: true })
}
console.log('4/4 isolated installer checks passed')
