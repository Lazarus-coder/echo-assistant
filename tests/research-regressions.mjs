import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'echo-research-')))
process.env.ECHO_DATA_DIR = path.join(sandbox, 'data')
process.env.ECHO_CONFIG = path.join(sandbox, 'config.json')
process.env.ECHO_RESEARCH_TEST_KEY = 'local-test-only'
process.env.ECHO_RESEARCH_TEST_URL = 'https://model.invalid/v1'
const originalFetch = globalThis.fetch
const workspace = path.join(sandbox, 'workspace')
await fs.mkdir(path.join(workspace, 'shared'), { recursive: true })
await fs.mkdir(path.join(workspace, 'other'), { recursive: true })
await fs.writeFile(path.join(workspace, 'shared', 'guide.txt'), 'Echo University Computer Science 2027 registration closes 2027-08-20.')
await fs.writeFile(path.join(workspace, 'other', 'private.txt'), 'PRIVATE_OUTSIDE_SELECTED_FOLDER')
await fs.writeFile(path.join(workspace, 'shared', '.env'), 'PRIVATE_HIDDEN_SENTINEL')
await fs.symlink(path.join(workspace, 'other', 'private.txt'), path.join(workspace, 'shared', 'link.txt'))
await fs.symlink(path.join(workspace, 'other'), path.join(workspace, 'shared', 'linked-folder'))

const config = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const sources = await import('../lib/research-sources.mjs')
const { researchCommitment, cancelAndDrainResearch } = await import('../lib/research.mjs')
const { extractPdf } = await import('../lib/pdf.mjs')
const { webFetch } = await import('../lib/search.mjs')
const { getRun, listRuns, artifactFile, clearRuns } = await import('../lib/harness.mjs')
const base = {
  upstream: { apiKeyEnv: 'ECHO_RESEARCH_TEST_KEY', baseUrlEnv: 'ECHO_RESEARCH_TEST_URL', defaultModel: 'mock', utilityModel: 'mock' },
  proactive: { enabled: false, research: { enabled: true } },
  search: { enabled: true, order: ['custom'], providers: { custom: { endpoint: 'https://93.184.216.34/search' } } },
  harness: { enabled: true, workspaceRoot: workspace, allowWrites: true, allowShell: true },
}
const goal = {
  id: 'goal_registration', revision: 1, status: 'active', title: 'Complete registration', successCriteria: 'Registration receipt',
  situation: { institution: 'Echo University', program: 'Computer Science', cycle: '2027', stage: 'registration' },
  scope: { research: true, memory: false, urls: [], documents: [], folders: [], officialDomains: ['93.184.216.34'] },
}
const initialEvidence = [{ id: 'goal1', source: `commitment:${goal.id}`, label: 'Goal', observedAt: new Date().toISOString(), excerpt: 'Complete registration.' }]
const finalJSON = () => ({ title: 'Registration checklist', content: 'Review the registration checklist. [goal1]', evidenceIds: ['goal1'], assumptions: [], question: null, deadlineClaims: [] })
const calls = (items) => items.map(([name, args], index) => ({ index, id: `call_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }))
function sse({ content, tools }) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: tools ? { tool_calls: calls(tools) } : { content: JSON.stringify(content ?? finalJSON()) }, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
const requests = []
const reads = []
let modelReply
let pageReply
async function setup(scope = {}) {
  await config.saveConfig(base)
  const current = { ...structuredClone(goal), scope: { ...goal.scope, ...scope } }
  await store.writeState({ commitments: [current] })
  requests.length = 0
  reads.length = 0
  modelReply = async () => sse({})
  pageReply = async () => new Response('<title>Echo University</title><p>Computer Science 2027 registration closes 2027-08-20.</p>', { headers: { 'content-type': 'text/html' } })
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://model.invalid/v1/chat/completions') {
      const body = JSON.parse(options.body)
      requests.push(body)
      return modelReply(body, options)
    }
    if (url === 'https://93.184.216.34/search') return Response.json({ results: [{ title: 'Official registration', url: 'https://93.184.216.34/registration', snippet: 'SEARCH_ONLY_SENTINEL: closes tomorrow' }] })
    assert.match(String(url), /^https:\/\/93\.184\.216\.(34|35)\//, 'tests never contact live services')
    reads.push(String(url))
    return pageReply(url, options)
  }
  return current
}
function pdf(text = 'Registration deadline 2027-08-20.', pages = 1) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] >>`]
  const font = 3 + pages * 2
  for (let index = 0; index < pages; index++) {
    const stream = `BT /F1 12 Tf 72 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let textPDF = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(textPDF)); textPDF += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(textPDF)
  textPDF += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(textPDF)
}
const within = async (promise) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation did not stop promptly')), 3000) })]) }
  finally { clearTimeout(timer) }
}

try {
  await test('patched PDF parser extracts page text and rejects malformed, excessive and timed-out documents', async () => {
    const parsed = await extractPdf(pdf())
    assert.match(parsed.text, /Registration deadline 2027-08-20/)
    assert.equal(parsed.pages[0].page, 1)
    assert.equal(parsed.totalPages, 1)
    await assert.rejects(extractPdf(Buffer.from('not a pdf')))
    await assert.rejects(extractPdf(pdf('text', 41)), /40/)
    await assert.rejects(extractPdf(pdf(), { timeoutMs: 1 }), /超时/)
    const controller = new AbortController()
    const work = extractPdf(pdf(), { signal: controller.signal })
    controller.abort()
    await within(assert.rejects(work, { name: 'AbortError' }))
  })

  await test('shared document uploads return metadata only and keep original page provenance', async () => {
    const created = await sources.saveResearchDocument({ name: 'registration.pdf', data: pdf().toString('base64') })
    assert.equal(created.name, 'registration.pdf')
    assert.equal(created.totalPages, 1)
    assert.equal(created.text, undefined)
    const saved = await sources.getResearchDocument(created.id)
    assert.match(saved.pages[0].text, /Registration deadline/)
    assert.equal(saved.fingerprint.length, 64)
    assert.equal((await sources.listResearchDocuments()).some((document) => document.id === created.id), true)
    for (const input of [{ name: '../escape.txt', data: 'eA==' }, { name: 'script.js', data: 'eA==' }, { name: 'a.txt', data: '@@' }, { name: 'a.txt', data: Buffer.from([0, 1]).toString('base64') }]) await assert.rejects(sources.saveResearchDocument(input))
    await assert.rejects(sources.getResearchDocument('../escape'))
    await assert.rejects(sources.saveResearchDocument({ name: 'large.txt', data: Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString('base64') }), /5 MiB/)
  })

  await test('privacy wipe cancels parsing and drains uploads before deletion, without late restoration', async () => {
    const work = sources.saveResearchDocument({ name: 'pending.pdf', data: pdf('pending', 20).toString('base64') })
    const rejected = assert.rejects(work, { name: 'AbortError' })
    await sources.clearResearchDocuments()
    await rejected
    assert.deepEqual(await sources.listResearchDocuments(), [])
    const next = await sources.saveResearchDocument({ name: 'new.txt', data: Buffer.from('new shared document').toString('base64') })
    assert.equal((await sources.listResearchDocuments())[0].id, next.id, 'uploads work after the wipe completes')
  })

  await test('web PDF reads retain hashes/pages and preserve network and response-size boundaries', async () => {
    await setup()
    pageReply = async () => new Response(pdf(), { headers: { 'content-type': 'application/pdf' } })
    const page = await webFetch('https://93.184.216.34/registration.pdf')
    assert.equal(page.mime, 'application/pdf')
    assert.match(page.content, /2027-08-20/)
    assert.equal(page.pages[0].page, 1)
    assert.equal(page.contentHash.length, 64)
    await assert.rejects(webFetch('https://93.184.216.34/registration.pdf', { maxBytes: 20 }), /大小预算/)
    reads.length = 0
    await assert.rejects(webFetch('http://127.0.0.1/private'))
    assert.deepEqual(reads, [])
    pageReply = async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })
    await assert.rejects(webFetch('https://93.184.216.34/redirect'))
    assert.equal(reads.length, 1, 'redirect is blocked before the private destination is fetched')
  })

  await test('selected-folder reads reuse workspace confinement for text/PDF and exclude hidden or escaped paths', async () => {
    const current = await setup({ folders: ['shared'] })
    await fs.writeFile(path.join(workspace, 'shared', 'guide.pdf'), pdf())
    const cfg = await config.loadConfig()
    const options = { cfg }
    assert.match((await sources.readResearchFile(current, 'shared/guide.txt', options)).text, /Computer Science/)
    assert.match((await sources.readResearchFile(current, 'shared/guide.pdf', options)).text, /Registration deadline/)
    const listing = await sources.listResearchFolder(current, 'shared', options)
    assert.equal(listing.entries.some((entry) => entry.name === '.env' || entry.name === 'link.txt'), false)
    for (const file of ['other/private.txt', 'shared/../other/private.txt', 'shared/link.txt', 'shared/linked-folder/private.txt', 'shared/.env', '/etc/passwd']) await assert.rejects(sources.readResearchFile(current, file, options))
    await assert.rejects(sources.readResearchFile(current, 'shared/guide.txt', { cfg: { harness: { ...cfg.harness, enabled: false } } }), /关闭/)
    await fs.symlink(process.env.ECHO_DATA_DIR, path.join(workspace, 'shared', 'echo-private'))
    await assert.rejects(sources.readResearchFile(current, 'shared/echo-private/state.json', options))
  })

  await test('HTML links expose bounded safe relative PDF destinations that the researcher can follow', async () => {
    const current = await setup()
    pageReply = async (url) => url.endsWith('.pdf')
      ? new Response(pdf(), { headers: { 'content-type': 'application/pdf' } })
      : new Response(`<title>Echo University</title><a href="../docs/guide.pdf">Registration guide</a>
        <a href="javascript:alert(1)">bad</a><a href="https://user:secret@school.example/file">credential</a>
        <a href="http://127.0.0.1/private">local</a>
        ${Array.from({ length: 35 }, (_, i) => `<a href="/link${i}">Link ${i}</a>`).join('')}`, { headers: { 'content-type': 'text/html' } })
    modelReply = async (body) => {
      if (requests.length === 1) return sse({ tools: [['web_fetch', { url: 'https://93.184.216.34/admissions/index.html' }]] })
      if (requests.length === 2) {
        const result = JSON.parse(body.messages.at(-1).content)
        assert.equal(result.links.length, 30)
        assert.deepEqual(result.links[0], { label: 'Registration guide', url: 'https://93.184.216.34/docs/guide.pdf' })
        assert.doesNotMatch(JSON.stringify(result.links), /javascript:|user:secret|127\.0\.0\.1/)
        return sse({ tools: [['web_fetch', { url: result.links[0].url }]] })
      }
      return sse({})
    }
    const result = await researchCommitment(current, { evidence: initialEvidence })
    assert.deepEqual(reads, ['https://93.184.216.34/admissions/index.html', 'https://93.184.216.34/docs/guide.pdf'])
    assert.equal(result.evidence.at(-1).source, reads.at(-1))
    assert.match(result.evidence.at(-1).excerpt, /2027-08-20/)
    assert.equal(result.evidence[1].links, undefined, 'discovery links are tool context rather than cited page evidence')
  })

  await test('research searches then reads the official source, preserving artifacts and treating snippets only as clues', async () => {
    const current = await setup()
    modelReply = async () => requests.length === 1 ? sse({ tools: [['web_search', { query: 'Echo University Computer Science 2027 registration deadline' }]] })
      : requests.length === 2 ? sse({ tools: [['web_fetch', { url: 'https://93.184.216.34/registration' }]] })
        : sse({ content: { ...finalJSON(), content: 'Registration closes on the date stated by the school. [web1]', evidenceIds: ['web1'] } })
    const result = await researchCommitment(current, { evidence: initialEvidence })
    assert.equal(requests.length, 3)
    assert.equal(result.evidence.length, 2)
    assert.doesNotMatch(JSON.stringify(result.evidence), /SEARCH_ONLY_SENTINEL/)
    const official = result.evidence.find((item) => item.id === 'web1')
    assert.equal(official.authority, 'official')
    assert.match(official.excerpt, /2027-08-20/)
    assert.ok(official.observedAt && official.fingerprint)
    const run = await getRun(result.runId)
    assert.equal(run.status, 'completed')
    assert.deepEqual(run.steps.map((step) => step.name), ['web_search', 'web_fetch', 'research_result'])
    const resultStep = run.steps.at(-1)
    const artifact = await artifactFile(run.id, resultStep.id, 'research.json')
    assert.match(await fs.readFile(artifact.file, 'utf8'), /2027-08-20/)
    assert.equal(requests[0].tools.some((entry) => /shell|write|mcp|image/.test(entry.function.name)), false)
    assert.equal((await store.readState()).commitments[0].deadline, undefined, 'research never mutates the goal or asserts completion')
  })

  await test('unconfirmed hosts and model authority assertions cannot create official evidence', async () => {
    const current = await setup()
    modelReply = async () => requests.length === 1 ? sse({ tools: [['web_fetch', { url: 'https://93.184.216.35/page' }]] }) : sse({})
    const result = await researchCommitment(current, { evidence: initialEvidence })
    assert.equal(result.evidence.at(-1).authority, 'unverified')
    assert.equal(result.evidence[0].authority, 'unverified')
  })

  await test('document reads require this goal’s explicit IDs and carry page references', async () => {
    const shared = await sources.saveResearchDocument({ name: 'shared.txt', data: Buffer.from('SHARED_DOCUMENT_TEXT').toString('base64') })
    const privateDocument = await sources.saveResearchDocument({ name: 'private.txt', data: Buffer.from('UNSHARED_DOCUMENT_SENTINEL').toString('base64') })
    const current = await setup({ documents: [shared.id] })
    modelReply = async () => requests.length === 1 ? sse({ tools: [['document_read', { id: privateDocument.id }], ['document_read', { id: shared.id }]] }) : sse({})
    const result = await researchCommitment(current, { evidence: initialEvidence })
    assert.doesNotMatch(JSON.stringify(requests), /UNSHARED_DOCUMENT_SENTINEL/)
    assert.equal(result.evidence.at(-1).source, `document:${shared.id}`)
    assert.equal(result.evidence.at(-1).page, 1)
    assert.equal(result.evidence.at(-1).authority, 'unverified')
    const run = await getRun(result.runId)
    assert.equal(run.steps[0].status, 'failed')
  })

  await test('unknown, prototype and side-effect tool names are rejected and audited without execution', async () => {
    const current = await setup()
    modelReply = async () => requests.length === 1 ? sse({ tools: [
      ['shell_exec', { command: 'touch SHOULD_NOT_EXIST' }], ['workspace_write', { path: 'shared/new.txt', content: 'no' }], ['__proto__', {}],
    ] }) : sse({})
    const result = await researchCommitment(current, { evidence: initialEvidence })
    const run = await getRun(result.runId)
    assert.deepEqual(run.steps.slice(0, 3).map((step) => step.status), ['failed', 'failed', 'failed'])
    assert.equal(await fs.access(path.join(workspace, 'shared', 'new.txt')).then(() => true, () => false), false)
    assert.deepEqual(reads, [])
  })

  await test('six tool calls and four model rounds are hard limits with final synthesis without tools', async () => {
    const current = await setup()
    modelReply = async (body) => requests.length <= 3 ? sse({ tools: [
      ['web_fetch', { url: 'https://93.184.216.34/page' }], ['web_fetch', { url: 'https://93.184.216.34/page' }],
    ] }) : (assert.equal(body.tools, undefined), sse({}))
    await researchCommitment(current, { evidence: initialEvidence })
    assert.equal(requests.length, 4)
    assert.equal(reads.length, 6)
    assert.equal(requests[3].messages.filter((message) => message.role === 'tool').length, 6)
  })

  await test('extra calls receive matching declined responses and never exceed the tool budget', async () => {
    const current = await setup()
    modelReply = async () => requests.length === 1 ? sse({ tools: Array.from({ length: 8 }, () => ['web_fetch', { url: 'https://93.184.216.34/page' }]) }) : sse({})
    await researchCommitment(current, { evidence: initialEvidence })
    assert.equal(reads.length, 6)
    assert.equal(requests[1].messages.filter((message) => message.role === 'tool').length, 8)
    assert.equal(requests[1].tools, undefined)
  })

  await test('disabled research makes no model call and attention silence does not block authorized research', async () => {
    const current = await setup()
    await config.saveConfig({ proactive: { research: { enabled: false } } })
    await assert.rejects(researchCommitment(current), /关闭/)
    assert.equal(requests.length, 0)
    await config.saveConfig({ proactive: { research: { enabled: true }, enabled: false, quietHours: { start: '00:00', end: '23:59' } } })
    assert.ok((await researchCommitment(current, { evidence: initialEvidence })).runId, 'research can prepare while delivery is disabled')
  })

  await test('disabled web access removes web tools and expired discoveries or changed workspaces do no work', async () => {
    const current = await setup()
    await config.saveConfig({ search: { enabled: false } })
    modelReply = async (body) => { assert.equal(body.tools, undefined); return sse({}) }
    await researchCommitment(current, { evidence: initialEvidence })
    assert.deepEqual(reads, [])
    const expired = await setup()
    expired.discovery = { adopted: false, expiresAt: new Date(Date.now() - 1000).toISOString() }
    await store.writeState({ commitments: [expired] })
    await assert.rejects(researchCommitment(expired), /过期/)
    assert.equal(requests.length, 0)
    const bound = await setup({ folders: ['shared'], workspaceRoot: path.join(sandbox, 'different-workspace') })
    await assert.rejects(researchCommitment(bound), /工作区/)
    assert.equal(requests.length, 0)
    await assert.rejects(sources.readResearchFile(bound, 'shared/guide.txt', { cfg: await config.loadConfig() }), /工作区/)
  })

  await test('live goal revisions and permission revocation stop before the next tool or result commit', async () => {
    for (const revoke of [
      () => config.saveConfig({ proactive: { research: { enabled: false } } }),
      () => store.mutateState((state) => { state.commitments[0].revision++ }),
      () => store.mutateState((state) => { state.commitments[0].status = 'paused' }),
    ]) {
      const current = await setup()
      modelReply = async () => sse({ tools: [['web_fetch', { url: 'https://93.184.216.34/page' }]] })
      pageReply = async () => { await revoke(); return new Response('Relevant source', { headers: { 'content-type': 'text/plain' } }) }
      await assert.rejects(researchCommitment(current, { evidence: initialEvidence }), /关闭|变更/)
      assert.equal(requests.length, 1)
      assert.equal(reads.length, 1)
    }
  })

  await test('cancel-and-drain aborts an active body read, preserving failed step audit without late results', async () => {
    const current = await setup()
    let entered
    const started = new Promise((resolve) => { entered = resolve })
    modelReply = async () => sse({ tools: [['web_fetch', { url: 'https://93.184.216.34/slow' }]] })
    pageReply = async (_, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        entered()
      },
    }), { headers: { 'content-type': 'text/plain' } })
    const work = researchCommitment(current, { evidence: initialEvidence })
    const rejected = assert.rejects(work, { name: 'AbortError' })
    await within(started)
    await within(cancelAndDrainResearch('test cancellation'))
    await rejected
    const latest = (await listRuns({ conversationId: current.id }))[0]
    assert.equal(latest.status, 'cancelled')
    assert.equal(latest.steps.at(-1).status, 'cancelled')
    assert.equal(requests.length, 1)
  })

  await test('malformed deadline declarations fail visibly instead of silently dropping conflicts', async () => {
    const current = await setup()
    modelReply = async () => sse({ content: { ...finalJSON(), deadlineClaims: { date: '2027-08-20' } } })
    await assert.rejects(researchCommitment(current, { evidence: initialEvidence }), /声明格式/)
  })

  await test('invalid or ambiguous incoming evidence is rejected before creating a harness run', async () => {
    const current = await setup()
    const before = await listRuns({ conversationId: current.id })
    for (const evidence of [[null], [{ id: 'web1' }], [initialEvidence[0], initialEvidence[0]]]) {
      await assert.rejects(researchCommitment(current, { evidence }), /格式无效/)
    }
    assert.deepEqual(await listRuns({ conversationId: current.id }), before)
    assert.equal(requests.length, 0)
  })
} finally {
  await cancelAndDrainResearch()
  await clearRuns()
  await sources.clearResearchDocuments()
  globalThis.fetch = originalFetch
  // The existing metrics writer batches for 1.5 seconds; let it flush inside the sandbox.
  await new Promise((resolve) => setTimeout(resolve, 1550))
  await fs.rm(sandbox, { recursive: true, force: true })
}
