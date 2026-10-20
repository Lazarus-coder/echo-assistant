import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-relationship-background-'))
process.env.ECHO_DATA_DIR = sandbox
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_BACKGROUND_TEST_KEY = 'test-only-never-sent'
process.env.ECHO_BACKGROUND_TEST_URL = 'https://model.invalid/v1'
const originalFetch = globalThis.fetch
const requests = []
let answer = async () => { throw new Error('Unexpected model call') }
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://model.invalid/v1/chat/completions', 'tests never contact a live provider')
  const body = JSON.parse(options.body)
  requests.push(body)
  return Response.json({ choices: [{ message: { content: JSON.stringify(await answer(body)) } }] })
}

try {
  const { saveConfig, loadConfig, P } = await import('../lib/config.mjs')
  const { readState, writeState, createConversation, appendMessage } = await import('../lib/store.mjs')
  const { getRelationships, saveRelationshipProfile, createRelationshipPerson } = await import('../lib/relationships.mjs')
  const { proactiveTick } = await import('../lib/proactive.mjs')
  const { ingestFrame, pendingBubbles } = await import('../lib/companion.mjs')
  const { extractMemory, readObservations, ensureCore, saveCore, loadCore, appendObservation } = await import('../lib/memory.mjs')
  const { buildGraph, loadGraph, queryGraph } = await import('../lib/graph.mjs')
  const { runDream } = await import('../lib/dream.mjs')
  const baseConfig = {
    upstream: { apiKeyEnv: 'ECHO_BACKGROUND_TEST_KEY', baseUrlEnv: 'ECHO_BACKGROUND_TEST_URL', defaultModel: 'mock', utilityModel: 'mock' },
    memory: { enabled: true, inject: true, extract: true, extractMinChars: 1 },
    screen: { enabled: false },
    proactive: { enabled: true, notify: false, quietHours: { start: '00:00', end: '00:00' } },
    companion: { enabled: true, minTextChars: 10, minGapSeconds: 0 },
    attention: { dailyBudget: 20, minGapSeconds: 0 },
  }
  await saveConfig(baseConfig)
  await saveRelationshipProfile({
    enabled: true, tone: 'warm', support: 'listen',
    preferredName: 'PROFILE_NAME_SENTINEL', boundaries: 'PROFILE_BOUNDARY_SENTINEL',
  })
  await createRelationshipPerson({ name: 'Sentinel Person', context: 'PERSON_PRIVATE_SENTINEL', relationship: 'colleague' })
  const loop = { id: 'loop_work', topic: 'Project proposal', why: 'User requested a project checklist', status: 'open', confidence: 0.8 }
  const frame = {
    text: 'Email editor: draft a concise project schedule reply with the agreed checklist.',
    app: 'Editor', title: 'Project draft', hidIdleSeconds: 1,
  }
  const reset = async (extra = {}) => {
    const { relationship } = await readState()
    await writeState({ relationship, ...extra })
    requests.length = 0
    answer = async (body) => body.messages[0].content.includes('主动服务决策')
      ? { act: false, confidence: 0, reason: 'No useful follow-up now' }
      : { speak: false, scenario: 'chat', why: 'No useful wording change' }
  }
  const textOf = (body) => JSON.stringify(body)
  const systemOf = (body) => body.messages.find((message) => message.role === 'system').content
  const userOf = (body) => body.messages.find((message) => message.role === 'user').content
  const assertNoPeople = (body) => assert.doesNotMatch(textOf(body), /PERSON_PRIVATE_SENTINEL|Sentinel Person/)

  await test('a relationship profile and people cannot create proactive material or new model calls', async () => {
    await reset()
    assert.equal((await proactiveTick()).skipped, 'no_material')
    assert.equal(requests.length, 0)
    assert.deepEqual(await pendingBubbles(), [])
  })

  await test('proactive style uses only the profile in its existing request, never as task evidence', async () => {
    await reset({ dream: { loops: [loop] } })
    const before = await getRelationships()
    assert.equal((await proactiveTick()).acted, false)
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.match(systemOf(request), /PROFILE_NAME_SENTINEL/)
    assert.match(systemOf(request), /PROFILE_BOUNDARY_SENTINEL/)
    assert.match(systemOf(request), /情绪或关系猜测不是主动联系的理由/)
    assert.match(systemOf(request), /沉默表示结果未知/)
    assert.match(systemOf(request), /不从屏幕\/OCR 推断/)
    assert.doesNotMatch(userOf(request), /PROFILE_NAME_SENTINEL|PROFILE_BOUNDARY_SENTINEL/)
    assertNoPeople(request)
    assert.deepEqual(await getRelationships(), before, 'background work does not infer or update people')
    assert.deepEqual((await readState()).proactive.queue, [])
  })

  await test('companion offers optional wording help and preserves uncertainty without profiling OCR', async () => {
    await reset()
    const before = await getRelationships()
    assert.equal((await ingestFrame(frame)).skipped, 'decided_quiet')
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.match(systemOf(request), /PROFILE_NAME_SENTINEL/)
    assert.match(systemOf(request), /简短、中性、可选的改写/)
    assert.match(systemOf(request), /沉默、未打开、收起气泡不代表关系变化或情绪/)
    assert.match(systemOf(request), /不据此建立人物或关系档案/)
    assert.doesNotMatch(systemOf(request), /帮他判断关系与语气/)
    assertNoPeople(request)
    assert.deepEqual(await pendingBubbles(), [])
    assert.deepEqual(await getRelationships(), before)
  })

  await test('disabled relationship personalization preserves generic boundaries and existing call counts', async () => {
    await saveRelationshipProfile({ enabled: false })
    await reset({ dream: { loops: [loop] } })
    await proactiveTick()
    await ingestFrame(frame)
    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.doesNotMatch(textOf(request), /PROFILE_NAME_SENTINEL|PROFILE_BOUNDARY_SENTINEL/)
      assertNoPeople(request)
      assert.match(systemOf(request), /不建立情绪档案/)
    }
    await saveRelationshipProfile({ enabled: true })
  })

  await ensureCore()
  await saveCore('# CORE_MEMORY_PRIVATE_SENTINEL\n\nThe user prefers a stable project schedule.', { backup: false })
  const savedFact = await appendObservation({
    text: 'FACT_MEMORY_PRIVATE_SENTINEL: project schedule checklist 跟进 计划 截止 项目.',
    importance: 5, source: 'message:main:private',
  })

  for (const key of ['enabled', 'inject']) {
    await test(`memory.${key}=false prevents core, fact and profile injection into both background requests`, async () => {
      await saveConfig(baseConfig)
      await saveConfig({ memory: { [key]: false } })
      await reset({ dream: { loops: [loop] } })
      await proactiveTick()
      await ingestFrame(frame)
      assert.equal(requests.length, 2, 'no classifier or extra model request is introduced')
      for (const request of requests) {
        assert.doesNotMatch(textOf(request), /PROFILE_NAME_SENTINEL|PROFILE_BOUNDARY_SENTINEL|CORE_MEMORY_PRIVATE_SENTINEL|FACT_MEMORY_PRIVATE_SENTINEL/)
        assertNoPeople(request)
        assert.match(systemOf(request), /不建立情绪档案/)
      }
      await reset()
      assert.equal((await proactiveTick()).skipped, 'no_material', 'disabled memories cannot supply proactive material')
      assert.equal(requests.length, 0)
      assert.ok((await readObservations()).some((observation) => observation.id === savedFact.id), 'disabling injection preserves the saved record')
    })
  }

  await test('existing enabled switches still prevent all background calls', async () => {
    await saveConfig(baseConfig)
    await saveConfig({ proactive: { enabled: false }, companion: { enabled: false } })
    await reset({ dream: { loops: [loop] } })
    assert.equal((await proactiveTick()).skipped, 'disabled')
    assert.equal((await ingestFrame(frame)).skipped, 'disabled')
    assert.equal(requests.length, 0)
    await saveConfig(baseConfig)
  })

  await test('memory extraction keeps explicit stable facts, source attribution and update provenance', async () => {
    await reset()
    const cfg = await loadConfig()
    const firstSource = 'message:main:user_one'
    const secondSource = 'message:main:user_two'
    answer = async () => ({ ops: [{ op: 'ADD', text: '用户偏好简短的工作沟通。', kind: 'user', importance: 4 }] })
    const result = await extractMemory({
      userText: '今天有点烦，但我一直偏好简短的工作沟通。', assistantText: '也许你的同事另有想法。', cfg, source: firstSource,
    })
    assert.equal(requests.length, 1)
    const first = requests[0]
    assert.match(systemOf(first), /临时情绪.*不写成长期性格/)
    assert.match(systemOf(first), /第三方.*用户明确提供/)
    assert.match(systemOf(first), /用户描述/)
    assert.match(userOf(first), /本轮来源：message:main:user_one/)
    assert.match(userOf(first), /用户: 今天有点烦/)
    assert.match(userOf(first), /助手: 也许/)
    const id = result.applied[0].id
    assert.equal((await readObservations()).find((observation) => observation.id === id).source, firstSource)
    answer = async () => ({ ops: [{ op: 'UPDATE', id, text: '用户偏好简短、直接的工作沟通。', kind: 'user', importance: 4 }] })
    await extractMemory({ userText: '关于工作沟通，我也偏好直接说明事项。', assistantText: '知道了。', cfg, source: secondSource })
    const updated = (await readObservations()).find((observation) => observation.id === id)
    assert.equal(updated.source, secondSource)
    assert.deepEqual(updated.sources, [firstSource, secondSource])
    assert.match(userOf(requests[1]), /来源 message:main:user_one/)
    assertNoPeople(first)
  })

  await test('graph relations require actual source observations and matching evidence, with no invented links', async () => {
    await reset()
    const observation = { id: 'observation_graph', status: 'active', kind: 'fact', source: 'message:main:graph_user', text: 'Lee works on Echo.' }
    answer = async () => ({
      entities: [{ name: 'Lee', type: 'person' }, { name: 'Echo', type: 'project' }, { name: 'Invented', type: 'person' }],
      mentions: [{ entity: 'Lee', obs_id: observation.id }, { entity: 'Echo', obs_id: observation.id }, { entity: 'Invented', obs_id: 'missing' }],
      relations: [
        { from: 'Lee', to: 'Echo', type: 'works_on', obs_id: observation.id, evidence: observation.text },
        { from: 'Lee', to: 'Echo', type: 'trusts', obs_id: observation.id, evidence: observation.text },
        { from: 'Lee', to: 'Echo', type: 'related', obs_id: 'missing', evidence: observation.text },
        { from: 'Lee', to: 'Echo', type: 'uses', obs_id: observation.id, evidence: 'Lee is frustrated with Echo.' },
      ],
    })
    assert.deepEqual(await buildGraph({ observations: [observation], cfg: await loadConfig() }), { nodes: 2, edges: 1, added: 2 })
    assert.equal(requests.length, 1)
    const graph = await loadGraph()
    assert.equal(graph.nodes.some((node) => node.name === 'Invented'), false)
    assert.deepEqual(graph.edges[0].obsIds, [observation.id])
    assert.deepEqual((await queryGraph('Lee')).obsIds, [observation.id])
    assert.match(systemOf(requests[0]), /临时情绪.*第三方动机.*关系质量/)
    assert.match(userOf(requests[0]), /来源 message:main:graph_user/)
    assertNoPeople(requests[0])
  })

  await test('dream preserves evidence provenance and uses the existing consolidation plus graph calls', async () => {
    await reset()
    await createConversation({ isMain: true, title: 'Project work' })
    await appendMessage('main', { id: 'stable_task', role: 'user', content: '请明天继续检查项目清单；今天有点累。' })
    await appendMessage('main', { id: 'assistant_guess', role: 'assistant', content: '也许同事没有认真对待你的计划。' })
    const before = await getRelationships()
    answer = async (body) => systemOf(body).includes('"做梦"')
      ? { core_memory_md: await loadCore(), facts: [], forgot: [], revived: [], open_loops: [], nudge_topics: [], insights: '' }
      : { entities: [], relations: [], mentions: [] }
    assert.equal((await runDream({ trigger: 'regression' })).ok, true)
    assert.equal(requests.length, 2, 'relationship guidance does not add another model call to consolidation')
    const dream = requests[0]
    assert.match(systemOf(dream), /临时情绪.*不升级为长期性格/)
    assert.match(systemOf(dream), /不能仅因情绪、关系猜测或未回复而创建跟进/)
    assert.match(systemOf(dream), /不做情绪、性格或人际关系画像/)
    assert.match(userOf(dream), /用户 \[main:stable_task\]/)
    assert.match(userOf(dream), /助手 \[main:assistant_guess\]/)
    assert.match(userOf(dream), /来源 message:main:user_one、message:main:user_two/)
    assertNoPeople(dream)
    assert.deepEqual(await getRelationships(), before)
    assert.deepEqual((await readState()).dream.loops, [])
    assert.ok((await fs.readdir(P.dreams)).length, 'existing audit output is still produced')
  })
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}
