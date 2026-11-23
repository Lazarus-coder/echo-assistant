import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-follow-up-read-'))
process.env.ECHO_DATA_DIR = path.join(sandbox, 'data')
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_DRAFT_TEST_KEY = 'fixture-only'
process.env.ECHO_DRAFT_TEST_URL = 'http://127.0.0.1:1/v1'
const { saveConfig } = await import('../lib/config.mjs')
const { writeState, createConversation, getConversation, readState } = await import('../lib/store.mjs')
const { runTurn } = await import('../lib/chat.mjs')
const { returnBrief } = await import('../lib/brief.mjs')
const { buildToolRegistry } = await import('../lib/tools.mjs')
const cfg = await saveConfig({
  upstream: { apiKeyEnv: 'ECHO_DRAFT_TEST_KEY', baseUrlEnv: 'ECHO_DRAFT_TEST_URL', defaultModel: 'fixture' },
  memory: { enabled: false }, search: { enabled: false }, proactive: { enabled: false, research: { enabled: true } },
})
const goal = {
  id: 'goal_trip', title: 'Plan a trip', revision: 2, status: 'active', nextAction: 'Choose a train',
  scope: { research: true }, watch: { type: 'manual', lastSuccessfulCheckAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 3600000).toISOString() },
  preparation: { state: 'ready', artifactId: 'prep_current' },
}
const draft = {
  id: 'prep_current', commitmentId: goal.id, revision: 2, title: 'Train options', createdAt: new Date().toISOString(),
  content: 'The 09:00 train takes two hours. [document1]', evidence: [{ id: 'document1', source: 'document:timetable', label: 'Timetable', page: 3, excerpt: 'PRIVATE_FULL_SOURCE', fingerprint: 'fixture', observedAt: new Date().toISOString() }],
  assumptions: ['Weekday travel'], question: 'Which station?', verification: { passed: true }, delivery: { status: 'pending' },
}
const read = (args) => buildToolRegistry({ cfg, conversationId: 'main', searchMode: 'off' }).call('follow_up_list', args)
const originalFetch = globalThis.fetch
try {
  await test('a chat can read its selected draft and source references without consuming a notification', async () => {
    const older = { ...draft, revision: 1, id: 'prep_old', content: 'OLD_DRAFT' }
    const unrelated = { ...draft, commitmentId: 'goal_other', content: 'UNRELATED_DRAFT' }
    await writeState({ commitments: [goal], preparations: [older, draft, unrelated] })
    const summary = await read({})
    assert.doesNotMatch(summary.text, /09:00|PRIVATE_FULL_SOURCE/)
    assert.equal(summary.preparation, undefined)
    const conv = await createConversation()
    let toolText
    globalThis.fetch = async (_, options) => {
      const body = JSON.parse(options.body)
      toolText = body.messages.findLast((message) => message.role === 'tool')?.content
      const delta = toolText ? { content: 'Here is your saved draft.' } : { tool_calls: [{
        index: 0, id: 'call_draft', type: 'function', function: { name: 'follow_up_list', arguments: JSON.stringify({ id: goal.id }) },
      }] }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    let last
    for await (const event of runTurn({ conversationId: conv.id, userText: 'Show me my train draft' })) last = event
    assert.equal(last.message.runStatus, 'completed')
    const reference = { commitmentId: goal.id, preparationId: draft.id, title: draft.title }
    assert.deepEqual(last.message.tools[0].preparation, reference)
    assert.deepEqual((await getConversation(conv.id)).messages.at(-1).tools[0].preparation, reference)
    for (const value of [draft.content, draft.question, draft.assumptions[0], goal.nextAction, 'Timetable', '第 3 页']) assert.ok(toolText.includes(value))
    assert.doesNotMatch(toolText, /PRIVATE_FULL_SOURCE|OLD_DRAFT|UNRELATED_DRAFT/)
    assert.equal((await readState()).preparations[1].delivery.status, 'pending')
  })

  await test('stale, unverified, incorrect and revoked drafts stay out of the model response', async () => {
    for (const [savedGoal, savedDraft] of [
      [{ ...goal, revision: 3 }, draft],
      [{ ...goal, watch: { ...goal.watch, lastError: 'offline' } }, draft],
      [{ ...goal, watch: { ...goal.watch, nextCheckAt: '2000-01-01T00:00:00Z' } }, draft],
      [goal, { ...draft, verification: { passed: false } }],
      [goal, { ...draft, evidence: [{ id: 'document1', source: 'commitment:goal_trip', excerpt: 'Goal only' }] }],
      [goal, { ...draft, outcome: { signal: 'incorrect' } }],
      [goal, { ...draft, delivery: { status: 'superseded' } }],
    ]) {
      await writeState({ commitments: [savedGoal], preparations: [savedDraft] })
      const result = await read({ id: goal.id })
      assert.doesNotMatch(result.text, /09:00|Timetable/)
      assert.equal(result.preparation, undefined)
    }
    await writeState({ commitments: [goal], preparations: [draft] })
    await saveConfig({ proactive: { research: { enabled: false } } })
    const revoked = await read({ id: goal.id })
    assert.doesNotMatch(revoked.text, /09:00|Timetable/)
    assert.equal(revoked.preparation, undefined)
    await assert.rejects(read({ id: 'goal_missing' }), /目标不存在/)
  })

  await test('long drafts can be read completely within chat limits and stale cursors cannot cross drafts', async () => {
    await saveConfig({ proactive: { research: { enabled: true } } })
    const long = { ...draft, content: 'START ' + 'A'.repeat(11980) + ' END [document1]', delivery: { status: 'reviewed' } }
    await writeState({ commitments: [goal], preparations: [long] })
    let cursor, firstCursor
    const pages = []
    do {
      const { text } = await read({ id: goal.id, cursor })
      assert.ok(text.length <= 8000)
      pages.push(text)
      cursor = /cursor=(\S+)$/.exec(text)?.[1]
      firstCursor ??= cursor
    } while (cursor && pages.length < 5)
    assert.equal(pages.length, 3)
    assert.equal(cursor, undefined)
    const assembled = pages.map((page) => page.slice(page.indexOf('\n\n') + 2).replace(/\n继续读取：cursor=\S+$/, '')).join('')
    assert.ok(assembled.includes(long.content))
    await writeState({ commitments: [{ ...goal, preparation: { state: 'ready', artifactId: 'prep_new' } }], preparations: [{ ...long, id: 'prep_new' }] })
    await assert.rejects(read({ id: goal.id, cursor: firstCursor }), /草稿已更新/)
  })

  await test('lookup, pending list and return brief honor current access to a saved workspace or web source', async () => {
    const root = path.join(sandbox, 'project')
    const current = { ...goal, scope: { research: true, workspaceRoot: root, folders: ['shared'] } }
    const saved = { ...draft, evidence: [{ ...draft.evidence[0], source: 'workspace:shared/timetable.md' }],
      delivery: { status: 'pending', expiresAt: new Date(Date.now() + 86400000).toISOString() } }
    await writeState({ commitments: [current], preparations: [saved] })
    await saveConfig({ harness: { enabled: true, workspaceRoot: root } })
    assert.match((await read({})).text, /有草稿待送达/)
    assert.match((await read({ id: goal.id })).text, /09:00/)
    assert.ok((await returnBrief()).items.some((item) => item.kind === 'drafts'))
    for (const harness of [{ enabled: false, workspaceRoot: root }, { enabled: true, workspaceRoot: path.join(sandbox, 'different') }]) {
      await saveConfig({ harness })
      assert.doesNotMatch((await read({})).text, /有草稿待送达/)
      assert.doesNotMatch((await read({ id: goal.id })).text, /09:00/)
      assert.ok((await returnBrief()).items.every((item) => item.kind !== 'drafts'))
    }
    await writeState({ commitments: [goal], preparations: [{ ...saved, evidence: [{ ...draft.evidence[0], source: 'https://example.org/times' }] }] })
    await saveConfig({ search: { enabled: false } })
    assert.doesNotMatch((await read({ id: goal.id })).text, /09:00/)
    assert.doesNotMatch((await read({})).text, /有草稿待送达/)
  })
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
