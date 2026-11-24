import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import english from '../lib/locales/domain-en.mjs'
import chinese from '../lib/locales/domain-zh-CN.mjs'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-domain-language-'))
process.env.ECHO_DATA_DIR = path.join(temp, 'data')
process.env.ECHO_CONFIG = path.join(temp, 'config.json')
const { saveConfig, P } = await import('../lib/config.mjs')
const { buildSystemPrompt } = await import('../lib/chat.mjs')
const { buildToolRegistry, labelFor } = await import('../lib/tools.mjs')
const { MODES } = await import('../lib/polish.mjs')
const { SEARCH_PROVIDERS } = await import('../lib/providers.mjs')
const { relationshipGuidance } = await import('../lib/relationships.mjs')
const { validateWorkspaceRoot } = await import('../lib/workspace.mjs')
const { ensureCore, loadCore, saveCore } = await import('../lib/memory.mjs')
const { rankProactiveContent } = await import('../lib/proactive-content.mjs')

try {
  await test('domain catalogs have matching placeholders for every key', () => {
    assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort())
    const slots = (value) => [...value.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(english)) {
      assert.deepEqual(slots(english[key]), slots(chinese[key]), key)
      assert.doesNotMatch(english[key], /\p{Script=Han}/u, key)
    }
  })

  await test('live language switches change model instructions, tool descriptions, result text and settings', async () => {
    const userNote = '保留 {0} $&'
    let knownTools
    for (const language of ['en', 'zh-CN', 'en']) {
      const en = language === 'en'
      const cfg = await saveConfig({ language, harness: { enabled: true, allowShell: true, allowWrites: true } })
      const prompt = buildSystemPrompt({ cfg, conv: { isMain: true }, memoryText: userNote, searchMode: 'on' })
      assert.ok(prompt.includes(userNote))
      assert.match(prompt, en ? /Reply in English/ : /默认用中文/)
      if (en) assert.doesNotMatch(prompt.replace(userNote, ''), /\p{Script=Han}/u)
      const fakeRun = { signal: new AbortController().signal, call: ({ execute, args }) => execute(args) }
      const registry = buildToolRegistry({ cfg, allowLocalTools: true, run: fakeRun })
      const names = registry.defs.map((d) => d.function.name).sort()
      if (knownTools) assert.deepEqual(knownTools, names)
      knownTools = names
      for (const def of registry.defs) {
        if (en) assert.doesNotMatch(JSON.stringify(def), /\p{Script=Han}/u)
        else assert.match(def.function.description, /\p{Script=Han}/u)
      }
      const time = await registry.call('local_time', {})
      assert.match(time.text, en ? /time zone/ : /时区/)
      assert.equal(labelFor('shell_exec'), en ? 'Run command' : '运行命令')
      assert.equal(MODES.tighten.label, en ? 'Condense' : '精简')
      assert.equal(SEARCH_PROVIDERS.none.label, en ? 'Offline' : '不联网')
      assert.match(relationshipGuidance({ enabled: true }), en ? /Communication preferences/ : /交流偏好/)
      await assert.rejects(validateWorkspaceRoot('relative'), en ? /absolute workspace/ : /绝对路径/)
    }
  })

  await test('a language switch renders an unchanged memory template without rewriting user notes', async () => {
    await saveConfig({ language: 'zh-CN' })
    const original = await ensureCore()
    assert.match(original, /核心记忆/)
    await saveConfig({ language: 'en' })
    assert.match(await loadCore(), /Echo core memory/)
    assert.equal(await fs.readFile(P.memoryCore, 'utf8'), original)
    const note = original + '\n自定义项目 {0} $&\n'
    await saveCore(note)
    assert.equal(await loadCore(), note)
    await saveConfig({ language: 'zh-CN' })
    assert.equal(await loadCore(), note)
  })

  await test('language switches preserve learned topic, evidence identity and duplicate suppression', async () => {
    const now = Date.UTC(2026, 8, 1, 12)
    const state = { dream: { at: new Date(now).toISOString(), loops: [
      { id: 'loop_launch', topic: 'Launch {0}', why: 'Check the launch calendar', due: '2026-09-02', status: 'open', confidence: 1 },
    ] } }
    const cfg = await saveConfig({ language: 'zh-CN' })
    const zh = rankProactiveContent({ cfg, state, now }).chosen
    const enCfg = await saveConfig({ language: 'en' })
    const en = rankProactiveContent({ cfg: enCfg, state, now }).chosen
    assert.equal(en.anchorKey, zh.anchorKey)
    assert.equal(en.selection.materialKey, zh.selection.materialKey)
    assert.equal(en.selection.topicKey, zh.selection.topicKey)
    assert.deepEqual(en.selection.score, zh.selection.score)
    assert.match(zh.evidence[0].excerpt, /截止/)
    assert.match(en.evidence[0].excerpt, /Launch \{0\}; Check the launch calendar; due 2026-09-02/)
    assert.doesNotMatch(JSON.stringify([en.evidence, en.selection.reasons]), /\p{Script=Han}/u)
    const queued = { id: 'candidate_1', kind: en.selection.kind, anchorId: en.selection.anchorId,
      content: 'A draft from the earlier session.', wordingLanguage: 'en', evidence: en.evidence, selection: en.selection }
    const reuse = rankProactiveContent({ cfg: enCfg, state, now, queue: [queued] })
    assert.equal(reuse.chosen.candidate.id, queued.id)
    assert.equal(reuse.chosen.candidate.anchorKey, zh.anchorKey)
    const stale = { ...queued, evidence: [{ ...en.evidence[0], excerpt: 'A different launch' }] }
    assert.deepEqual(rankProactiveContent({ cfg: enCfg, state, now, queue: [stale] }).staleQueueIds, [stale.id])
    const legacyQueue = { ...queued, evidence: zh.evidence, wordingLanguage: undefined, content: '已保存的旧版提醒。' }
    const reword = rankProactiveContent({ cfg: enCfg, state, now, queue: [legacyQueue] })
    assert.deepEqual(reword.staleQueueIds, [legacyQueue.id])
    assert.equal(reword.chosen.candidate, undefined)
    assert.equal(reword.chosen.anchorKey, zh.anchorKey)
    state.attention = { history: [{ anchorKey: zh.anchorKey, status: 'delivered' }] }
    const repeated = rankProactiveContent({ cfg: enCfg, state, now })
    assert.equal(repeated.chosen, null)
    assert.equal(repeated.reason, 'unchanged_evidence')
  })
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
