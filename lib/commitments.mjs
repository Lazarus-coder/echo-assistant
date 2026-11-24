import { runtimeText } from './runtime-language.mjs'
import { loadConfig } from './config.mjs'
import { getConversation, readState, mutateState } from './store.mjs'
import { jsonTask } from './native.mjs'
import { retrieve } from './memory.mjs'
import { webFetch } from './search.mjs'
import { assertId, newId, nowIso } from './util.mjs'
import path from 'node:path'
import { executeWorkspaceTool } from './workspace.mjs'
import { citesReadResearchSource, getResearchDocument, readResearchFile } from './research-sources.mjs'
import { assessDeadlineClaims, commitmentCaseKey, deadlineMilestone, relevantSourceFingerprint } from './deadlines.mjs'

const HOUR = 3600000
const DAY = 24 * HOUR
const workerId = newId('worker')
let worker
const active = new Map()

function problem(message, status = 400) {
  const error = new Error(message)
  error.status = status
  throw error
}

function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) problem(runtimeText('commitments.invalidText', label, required ? runtimeText('commitments.nonempty') : '', max))
  return value.trim()
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) problem(runtimeText('commitments.invalidFormat', label))
  return value
}

function deadline(value) {
  if (value === null || value === '') return null
  const parsed = typeof value === 'string' ? Date.parse(`${value}T00:00:00Z`) : NaN
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) problem(runtimeText('commitments.invalidDeadline'))
  return value
}

async function scope(value) {
  object(value, runtimeText('commitments.scope'))
  if (Object.keys(value).some((key) => !['memory', 'urls', 'research', 'documents', 'folders', 'officialDomains', 'workspaceRoot'].includes(key))) problem(runtimeText('commitments.unknownScopeField'))
  if (value.memory !== undefined && typeof value.memory !== 'boolean') problem(runtimeText('commitments.invalidMemoryPermission'))
  if (value.research !== undefined && typeof value.research !== 'boolean') problem(runtimeText('commitments.invalidResearchPermission'))
  const urls = value.urls ?? []
  if (!Array.isArray(urls) || urls.length > 3) problem(runtimeText('commitments.tooManyUrls'))
  const out = {
    memory: value.memory === true,
    urls: [...new Set(urls.map((raw) => {
      text(raw, runtimeText('commitments.sourceUrl'), 2000, true)
      let url
      try { url = new URL(raw) } catch { problem(runtimeText('commitments.invalidSourceUrl')) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) problem(runtimeText('commitments.invalidUrlScheme'))
      url.hash = ''
      return url.href
    }))],
  }
  if (value.research !== undefined) out.research = value.research
  if (value.documents !== undefined) {
    if (!Array.isArray(value.documents) || value.documents.length > 5) problem(runtimeText('commitments.tooManyDocuments'))
    out.documents = [...new Set(value.documents.map(assertId))]
  }
  if (value.officialDomains !== undefined) {
    if (!Array.isArray(value.officialDomains) || value.officialDomains.length > 5) problem(runtimeText('commitments.tooManyDomains'))
    out.officialDomains = [...new Set(value.officialDomains.map((entry) => {
      const host = text(entry, runtimeText('commitments.officialDomain'), 253, true).toLowerCase()
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.') || host.includes('..')) problem(runtimeText('commitments.invalidDomain'))
      return host
    }))]
  }
  if (value.folders !== undefined) {
    if (!Array.isArray(value.folders) || value.folders.length > 3) problem(runtimeText('commitments.tooManyFolders'))
    const cfg = value.folders.length ? await loadConfig() : null
    out.folders = []
    for (const entry of value.folders) {
      const folder = text(entry, runtimeText('commitments.workspaceFolder'), 500, true)
      if (path.isAbsolute(folder) || folder.includes('\\') || folder.split('/').includes('..') || folder.includes('\0')) problem(runtimeText('commitments.invalidFolderPath'))
      if (!cfg.harness?.enabled || !cfg.harness.workspaceRoot) problem(runtimeText('commitments.chooseWorkspace'))
      if (value.workspaceRoot !== undefined && value.workspaceRoot !== cfg.harness.workspaceRoot) problem(runtimeText('commitments.workspaceChanged'))
      await executeWorkspaceTool('workspace_list', { path: folder, limit: 1 }, { workspaceRoot: cfg.harness.workspaceRoot })
      out.folders.push(path.posix.normalize(folder))
    }
    out.folders = [...new Set(out.folders)]
    if (out.folders.length) out.workspaceRoot = cfg.harness.workspaceRoot
  }
  return out
}

function watch(value) {
  object(value, runtimeText('commitments.watch'))
  if (!['manual', 'deadline', 'source_change', 'combined'].includes(value.type)) problem(runtimeText('commitments.invalidWatch'))
  return { type: value.type }
}

function situation(value) {
  object(value, runtimeText('commitments.situation'))
  const limits = { institution: 160, program: 200, cycle: 80, category: 80, stage: 80 }
  if (Object.keys(value).some((key) => !Object.hasOwn(limits, key) && key !== 'questions')) problem(runtimeText('commitments.unknownSituationField'))
  const result = {}
  for (const [key, max] of Object.entries(limits)) if (value[key] !== undefined) result[key] = text(value[key], key, max)
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions) || value.questions.length > 5) problem(runtimeText('commitments.tooManyQuestions'))
    result.questions = value.questions.map((question) => text(question, runtimeText('commitments.openQuestion'), 300, true))
  }
  return result
}

async function source(value) {
  if (value === null) return null
  object(value, runtimeText('commitments.originalMessage'))
  assertId(value.conversationId)
  assertId(value.messageId)
  const conv = await getConversation(value.conversationId)
  const message = conv?.messages?.find((m) => m.id === value.messageId)
  if (!message) problem(runtimeText('commitments.messageMissing'))
  return {
    conversationId: conv.id,
    messageId: message.id,
    role: message.role,
    excerpt: String(message.content ?? '').slice(0, 2400),
    observedAt: nowIso(),
  }
}

async function validated(input, partial = false) {
  object(input, runtimeText('commitments.goal'))
  const out = {}
  for (const [key, max, required] of [['title', 160, true], ['successCriteria', 2000, true], ['nextAction', 1200, false], ['blocker', 1200, false], ['completionEvidence', 2000, false]]) {
    if (input[key] !== undefined) out[key] = text(input[key], key, max, required)
    else if (!partial && key !== 'completionEvidence') out[key] = required ? problem(runtimeText('commitments.missingField', key)) : ''
  }
  if (input.deadline !== undefined) { out.deadline = deadline(input.deadline); out.deadlineOrigin = out.deadline ? 'user' : null }
  if (input.status !== undefined) {
    if (!['active', 'paused', 'done', 'cancelled'].includes(input.status)) problem(runtimeText('commitments.invalidStatus'))
    out.status = input.status
  }
  if (input.scope !== undefined) out.scope = await scope(input.scope)
  if (input.watch !== undefined) out.watch = watch(input.watch)
  if (input.situation !== undefined) out.situation = situation(input.situation)
  if (input.source !== undefined) out.source = await source(input.source)
  return out
}

function ensure(state) {
  state.commitments ??= []
  state.preparations ??= []
  state.commitmentWork ??= { runs: [] }
  state.commitmentWork.runs ??= []
  return state
}

function requireGoal(state, id) {
  const goal = state.commitments.find((c) => c.id === id)
  if (!goal) problem(runtimeText('server.goalNotFound'), 404)
  return goal
}

function validateCombination(goal) {
  if (goal.watch.type === 'deadline' && !goal.deadline) problem(runtimeText('commitments.dateRequired'))
  if (goal.watch.type === 'source_change' && !goal.scope.urls.length && !goal.scope.research) problem(runtimeText('commitments.sourceRequired'))
  if (goal.watch.type === 'combined' && !goal.deadline && !goal.scope.urls.length && !goal.scope.research) problem(runtimeText('commitments.combinedWatchRequirements'))
  if ((goal.scope.documents?.length || goal.scope.folders?.length || goal.scope.officialDomains?.length) && !goal.scope.research) problem(runtimeText('commitments.researchScopeRequired'))
  if (goal.status === 'done' && !goal.completionEvidence?.trim()) problem(runtimeText('commitments.criteriaRequired'))
}

function queue(goal, reason) {
  const originalReason = ['retry', 'interrupted'].includes(reason) ? goal.preparation?.originalReason ?? goal.preparation?.reason : null
  goal.preparation = { state: 'queued', queuedAt: nowIso(), reason, ...(originalReason ? { originalReason } : {}) }
}

export async function listCommitments() {
  const state = ensure(await readState())
  return { commitments: state.commitments, preparations: state.preparations }
}

export async function createCommitment(input) {
  const fields = await validated(input)
  if (input.candidateLoopId !== undefined) fields.candidateLoopId = assertId(input.candidateLoopId)
  const at = nowIso()
  const goal = {
    id: newId('goal'), status: 'active', origin: 'user', deadline: null, source: null,
    scope: { memory: false, urls: [] }, watch: { type: 'manual' },
    ...fields, revision: 1, preparation: { state: 'idle' }, createdAt: at, updatedAt: at,
  }
  validateCombination(goal)
  if (goal.status === 'active') queue(goal, 'accepted')
  await mutateState((state) => {
    ensure(state)
    if (state.commitments.filter((c) => ['active', 'paused'].includes(c.status)).length >= 30) problem(runtimeText('commitments.tooManyGoals'))
    if (goal.candidateLoopId && !(state.dream?.loops ?? []).some((loop) => loop.id === goal.candidateLoopId && loop.status !== 'done')) problem(runtimeText('commitments.leadMissing'))
    if (goal.candidateLoopId && state.commitments.some((c) => c.candidateLoopId === goal.candidateLoopId && ['active', 'paused'].includes(c.status))) problem(runtimeText('commitments.alreadyTracked'), 409)
    state.commitments.push(goal)
  })
  return goal
}

export async function updateCommitment(id, patch) {
  assertId(id)
  object(patch, runtimeText('commitments.update'))
  if (patch.expectedRevision !== undefined && (!Number.isInteger(patch.expectedRevision) || patch.expectedRevision < 1)) problem(runtimeText('commitments.invalidVersion'))
  if (patch.adopt !== undefined && patch.adopt !== true) problem(runtimeText('commitments.invalidAdopt'))
  const fields = await validated(patch, true)
  let result, changed = false
  await mutateState((state) => {
    ensure(state)
    const goal = requireGoal(state, id)
    if (patch.expectedRevision !== undefined && goal.revision !== patch.expectedRevision) problem(runtimeText('commitments.versionChanged'), 409)
    const next = { ...goal, ...fields, ...(fields.situation ? { situation: { ...goal.situation, ...fields.situation } } : {}) }
    if (fields.deadline === goal.deadline) next.deadlineOrigin = goal.deadlineOrigin
    if (fields.watch?.type === goal.watch.type) next.watch = goal.watch
    if (fields.deadline === null && !fields.watch) {
      if (goal.watch.type === 'deadline') next.watch = { type: 'manual' }
      if (goal.watch.type === 'combined' && !next.scope.research) next.watch = { type: next.scope.urls.length ? 'source_change' : 'manual' }
    }
    if (patch.adopt && goal.discovery && !goal.discovery.adopted) {
      if (['done', 'cancelled'].includes(goal.status)) problem(runtimeText('commitments.cannotAdoptClosed'), 409)
      next.discovery = { ...goal.discovery, adopted: true, adoptedAt: nowIso() }
    }
    validateCombination(next)
    if (!Object.keys(fields).some((key) => JSON.stringify(next[key]) !== JSON.stringify(goal[key])) && next.discovery === goal.discovery) { result = goal; return }
    changed = true
    next.revision = (goal.revision ?? 1) + 1
    next.updatedAt = nowIso()
    next.preparation = { state: 'idle' }
    next.watch = { type: next.watch.type }
    if (next.deadline !== goal.deadline || JSON.stringify(next.situation) !== JSON.stringify(goal.situation) || JSON.stringify(next.scope) !== JSON.stringify(goal.scope)) {
      delete next.deadlineAssessment
      delete next.deadlineVersion
    }
    if (next.status === 'active') queue(next, next.discovery !== goal.discovery ? 'adopted' : goal.status === 'active' ? 'updated' : 'resumed')
    state.commitments[state.commitments.indexOf(goal)] = next
    for (const artifact of state.preparations) {
      if (artifact.commitmentId === id && artifact.delivery.status === 'pending') artifact.delivery.status = 'superseded'
    }
    result = next
  })
  if (changed) active.get(id)?.controller.abort(new Error(runtimeText('commitments.goalChanged')))
  return result
}

async function userEvidence(reference, quote) {
  const origin = await source(reference)
  if (!origin || origin.role !== 'user') problem(runtimeText('commitments.originalEvidenceRequired'))
  const exact = text(quote, runtimeText('commitments.originalQuote'), 1600, true)
  // Read the complete message instead of trusting the bounded display excerpt.
  const conv = await getConversation(origin.conversationId)
  const message = conv?.messages?.find((entry) => entry.id === origin.messageId && entry.role === 'user')
  if (!message || !String(message.content ?? '').includes(exact)) problem(runtimeText('commitments.quoteMismatch'))
  if (!origin.excerpt.includes(exact)) {
    const start = Math.max(0, String(message.content).indexOf(exact) - 600)
    origin.excerpt = String(message.content).slice(start, start + 2400)
  }
  return { origin, quote: exact, content: String(message.content ?? '') }
}

export async function discoverCommitment(input, { source: reference, confidence, quote } = {}) {
  if (!(await loadConfig()).proactive?.research?.enabled) problem(runtimeText('commitments.discoveryOff'), 403)
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) problem(runtimeText('commitments.invalidConfidence'))
  const evidence = await userEvidence(reference, quote)
  const fields = await validated({
    title: input.title, successCriteria: input.successCriteria, nextAction: input.nextAction ?? '', blocker: input.blocker ?? '',
    ...(input.situation ? { situation: input.situation } : {}),
  })
  // Identity is copied only when the actual user message contains it verbatim.
  for (const key of ['institution', 'program', 'cycle', 'category', 'stage']) {
    if (fields.situation?.[key] && !evidence.quote.includes(fields.situation[key])) problem(runtimeText('commitments.missingQuotedField', key))
  }
  const at = nowIso()
  const goal = {
    id: newId('goal'), origin: 'discovered', status: 'active', deadline: null,
    ...fields, source: evidence.origin,
    scope: { memory: false, urls: [], research: true }, watch: { type: 'combined' },
    discovery: { confidence, quote: evidence.quote, source: { conversationId: evidence.origin.conversationId, messageId: evidence.origin.messageId }, expiresAt: new Date(Date.now() + 7 * DAY).toISOString(), adopted: false },
    revision: 1, createdAt: at, updatedAt: at,
  }
  goal.discovery.caseKey = commitmentCaseKey(goal)
  queue(goal, 'discovered')
  let result
  await mutateState(async (state) => {
    ensure(state)
    if (!(await loadConfig()).proactive?.research?.enabled) problem(runtimeText('commitments.researchOff'), 403)
    const currentSource = await userEvidence(reference, quote)
    if (currentSource.origin.excerpt !== evidence.origin.excerpt) problem(runtimeText('commitments.messageChanged'), 409)
    const duplicate = state.commitments.find((entry) =>
      ((entry.discovery?.source ?? entry.source)?.conversationId === evidence.origin.conversationId && (entry.discovery?.source ?? entry.source)?.messageId === evidence.origin.messageId && entry.discovery?.quote === evidence.quote)
      || commitmentCaseKey(entry) === commitmentCaseKey(goal) || entry.discovery?.caseKey === goal.discovery.caseKey)
    if (duplicate) { result = duplicate; return }
    if (state.commitments.filter((entry) => ['active', 'paused'].includes(entry.status)).length >= 30) problem(runtimeText('commitments.tooManyGoals'))
    state.commitments.push(goal)
    result = goal
  })
  return result
}

export async function completeCommitmentFromMessage(id, { conversationId, messageId, quote, expectedRevision } = {}) {
  assertId(id)
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) problem(runtimeText('commitments.invalidVersion'))
  const evidence = await userEvidence({ conversationId, messageId }, quote)
  const value = evidence.quote
  const entireMessage = evidence.content
  const negated = /\b(?:not|never|haven't|hasn't|isn't|wasn't|didn't|will|would|if|when|once|hope|plan|tomorrow|said|says|told|friend|he|she|they)\b|(?:还没|没有|尚未|(?:未|没|不)(?:完成|提交|报名|注册|解决|缴费|交付|(?:做|弄|办|处理|搞)完|搞定)|不是|如果|明天|打算|计划|希望|准备|他说|她说|他们说|她们说)|[“”「」"]/iu.test(value)
  const affirmative = /(?:我)?(?:已经|已|成功)(?:完成|提交|报名|注册|解决|缴费|交付)|(?:完成|提交|报名|注册|解决|缴费|交付)(?:了|成功)|(?:做|弄|办|处理|搞)完(?:了|成)|搞定(?:了)?|\b(?:i(?:'ve| have)? (?:finished|completed|submitted|registered|resolved)|i(?:'m| am) done|(?:registration|application|submission|task|issue) (?:is|has been) (?:complete[dr]?|done|submitted|resolved))\b/iu.test(value)
  const contradicted = /\b(?:not|never|haven't|hasn't|isn't|wasn't|didn't|will|would|if|when|once|hope|plan|tomorrow|said|says|told|pending|remaining|awaiting)\b|\b(?:waiting for|still need|but (?:i )?need)\b|还没|没有|尚未|未完成|未提交|如果|计划|打算|希望|他说|她说|他们说|她们说|还需|仍需|还要|尚待|待缴|等待确认|未收到|[？?“”「」"]/iu.test(entireMessage)
  if (negated || contradicted || !affirmative) problem(runtimeText('commitments.completionEvidenceRequired'))
  let result
  await mutateState(async (state) => {
    ensure(state)
    const goal = requireGoal(state, id)
    if (expectedRevision !== undefined && goal.revision !== expectedRevision) problem(runtimeText('commitments.versionChanged'), 409)
    const currentEvidence = await userEvidence({ conversationId, messageId }, quote)
    if (currentEvidence.content !== entireMessage) problem(runtimeText('commitments.completionChanged'), 409)
    if (goal.source && goal.source.conversationId !== conversationId && ![goal.situation?.program, goal.title].some((label) => label && value.includes(label))) problem(runtimeText('commitments.ambiguousCompletion'))
    const otherActive = state.commitments.some((entry) => entry.id !== id && entry.status === 'active' && entry.source?.conversationId === conversationId)
    if (otherActive && ![goal.situation?.program, goal.title].some((label) => label && value.toLowerCase().includes(label.toLowerCase()))) problem(runtimeText('commitments.multipleGoals'))
    if (['done', 'cancelled'].includes(goal.status)) { result = goal; return }
    goal.status = 'done'
    goal.completionEvidence = value
    goal.completionSource = evidence.origin
    goal.updatedAt = nowIso()
    goal.revision = (goal.revision ?? 1) + 1
    goal.preparation = { state: 'idle' }
    goal.watch = { ...goal.watch, nextCheckAt: null }
    for (const artifact of state.preparations) if (artifact.commitmentId === id && artifact.delivery.status === 'pending') artifact.delivery.status = 'superseded'
    result = goal
  })
  active.get(id)?.controller.abort(new Error(runtimeText('commitments.completedByUser')))
  return result
}

export function cancelCommitmentWork(reason = runtimeText('commitments.preparationCancelled'), { researchOnly = false } = {}) {
  for (const { controller, research } of active.values()) if (!researchOnly || research) controller.abort(new Error(reason))
}

export async function requestPreparation(id) {
  assertId(id)
  let result
  await mutateState((state) => {
    ensure(state)
    const goal = requireGoal(state, id)
    if (goal.status !== 'active') problem(runtimeText('commitments.resumeFirst'), 409)
    if (goal.preparation.state !== 'running') queue(goal, 'requested')
    result = goal
  })
  return result
}

export async function answerPreparation(id, input) {
  assertId(id)
  object(input, runtimeText('commitments.questionResponse'))
  const preparationId = assertId(input.preparationId)
  const answerText = text(input.answer, runtimeText('commitments.answer'), 1600, true)
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) problem(runtimeText('commitments.invalidVersion'))
  let result
  await mutateState((state) => {
    ensure(state)
    const goal = requireGoal(state, id)
    const draft = state.preparations.find((p) => p.id === preparationId && p.commitmentId === id)
    if (!draft?.question || draft.revision !== input.expectedRevision) problem(runtimeText('commitments.questionChanged'), 409)
    if (draft.answer) {
      if (draft.answer.text !== answerText) problem(runtimeText('commitments.conflictingAnswer'), 409)
      result = { commitment: goal, answer: draft.answer, duplicate: true }
      return
    }
    if (!fresh(goal, draft.revision) || goal.preparation?.state !== 'ready' || goal.preparation.artifactId !== draft.id) {
      problem(runtimeText('commitments.draftChanged'), 409)
    }
    const at = nowIso()
    draft.answer = { text: answerText, answeredAt: at }
    if (draft.delivery?.status === 'pending') draft.delivery.status = 'superseded'
    goal.revision++
    goal.updatedAt = at
    delete goal.watch.awaitingClarification
    queue(goal, 'answered')
    result = { commitment: goal, answer: draft.answer, duplicate: false }
  })
  return result
}

function fresh(goal, revision) {
  return goal?.status === 'active' && goal.revision === revision && !(goal.discovery && !goal.discovery.adopted && Date.parse(goal.discovery.expiresAt) <= Date.now())
}

async function readSources(goal, signal) {
  const cfg = goal.scope.research ? await loadConfig() : null
  if (goal.scope.research && !cfg.proactive?.research?.enabled) throw Object.assign(new Error(runtimeText('commitments.researchOff')), { status: 403 })
  const urls = [...new Set([...goal.scope.urls, ...(goal.scope.research ? goal.watch.sources ?? [] : [])])].slice(0, 6)
  const pages = await Promise.all(urls.map(async (url, index) => {
    try {
      if (goal.scope.research && (!cfg.search?.enabled || cfg.search.order?.includes('none'))) throw new Error(runtimeText('research.fetchOff'))
      const page = await webFetch(url, { maxChars: goal.scope.research ? 16000 : 6500, maxBytes: goal.scope.research ? 5 * 1024 * 1024 : 512 * 1024, allowRedirects: Boolean(goal.scope.research), signal })
      if (goal.scope.research) {
        const latest = await loadConfig()
        if (!latest.proactive?.research?.enabled || !latest.search?.enabled || latest.search.order?.includes('none')) throw new Error(runtimeText('commitments.webResearchOff'))
      }
      if (page.skipped || !page.content?.trim()) throw new Error(page.note || runtimeText('commitments.emptySource'))
      const result = {
        id: `web${index + 1}`, label: page.title || url,
        source: page.url || url, requestedUrl: url, observedAt: nowIso(),
        excerpt: page.content, fingerprint: page.contentHash, truncated: Boolean(page.truncated),
      }
      result.fingerprint = relevantSourceFingerprint(goal, result)
      return result
    } catch (error) {
      return { id: `web${index + 1}`, source: url, requestedUrl: url, observedAt: nowIso(), error: String(error.message).slice(0, 300) }
    }
  }))
  if (goal.scope.research) {
    for (const [index, reference] of [...(goal.watch.fileSources ?? []), ...(goal.watch.documentSources ?? [])].slice(0, 8).entries()) {
      try {
        signal?.throwIfAborted()
        const latest = await loadConfig()
        if (!latest.proactive?.research?.enabled) throw new Error(runtimeText('commitments.researchOff'))
        if (reference.startsWith('workspace:') && goal.scope.workspaceRoot && latest.harness?.workspaceRoot !== goal.scope.workspaceRoot) throw new Error(runtimeText('commitments.workspaceScopeChanged'))
        const document = reference.startsWith('workspace:')
          ? await readResearchFile(goal, reference.slice('workspace:'.length), { cfg: latest, signal })
          : await getResearchDocument(reference.slice('document:'.length))
        const result = { id: `local${index + 1}`, source: reference, requestedUrl: reference, label: document.name, observedAt: nowIso(), excerpt: String(document.text ?? '').slice(0, 16000), fingerprint: document.fingerprint, sourceType: reference.startsWith('workspace:') ? 'workspace' : 'document' }
        pages.push(result)
      } catch (error) {
        pages.push({ id: `local${index + 1}`, source: reference, requestedUrl: reference, observedAt: nowIso(), error: String(error.message).slice(0, 300) })
      }
    }
  }
  return pages
}

async function currentGoal(goal) {
  const state = ensure(await readState())
  return fresh(state.commitments.find((c) => c.id === goal.id), goal.revision)
}

async function checkWatches() {
  const snapshot = ensure(await readState())
  const sources = new Map()
  for (const goal of snapshot.commitments) {
    const researchSources = goal.scope.research && (goal.watch.sources?.length || goal.watch.fileSources?.length || goal.watch.documentSources?.length)
    if (!fresh(goal, goal.revision) || ['queued', 'running'].includes(goal.preparation.state) || (goal.watch.type === 'manual' && !researchSources)) continue
    if (Date.parse(goal.watch.nextCheckAt) > Date.now()) continue
    if (goal.preparation.state === 'failed' && Date.parse(goal.preparation.retryAt) > Date.now()) continue
    if (goal.scope.research && !(await loadConfig()).proactive?.research?.enabled) continue
    let pages
    const controller = new AbortController()
    active.set(goal.id, { controller, research: Boolean(goal.scope.research) })
    try {
    if (['source_change', 'combined'].includes(goal.watch.type) || researchSources) {
      pages = await readSources(goal, controller.signal)
      sources.set(goal.id, { revision: goal.revision, pages })
    }
    if (controller.signal.aborted) continue
    await mutateState(async (state) => {
      if (controller.signal.aborted || (goal.scope.research && !(await loadConfig()).proactive?.research?.enabled)) return
      ensure(state)
      const current = state.commitments.find((c) => c.id === goal.id)
      if (!fresh(current, goal.revision) || ['queued', 'running'].includes(current.preparation.state)) return
      current.watch.lastCheckAt = nowIso()
      current.watch.nextCheckAt = new Date(Date.now() + HOUR).toISOString()
      const milestone = ['deadline', 'combined'].includes(current.watch.type) ? deadlineMilestone(current) : null
      const milestoneDue = milestone && !current.watch.deadlineMilestones?.[milestone.key]
      if (milestoneDue) {
        queue(current, 'deadline_approaching')
        current.preparation.milestone = milestone.key
      }
      if (pages) {
        current.watch.lastError = pages.find((p) => p.error)?.error ?? null
        if (current.watch.lastError) {
          current.watch.failureCount = Math.min((current.watch.failureCount ?? 0) + 1, 8)
          current.watch.nextCheckAt = new Date(Date.now() + Math.min(24 * HOUR, HOUR * 2 ** (current.watch.failureCount - 1))).toISOString()
          return
        }
        current.watch.failureCount = 0
        current.watch.lastSuccessfulCheckAt = nowIso()
        const fingerprints = { ...(current.watch.fingerprints ?? {}) }
        let changed = pages.length > 0 && !Object.keys(fingerprints).length
        for (const page of pages.filter((p) => !p.error)) {
          if (fingerprints[page.requestedUrl] !== page.fingerprint) changed = true
        }
        // A changed baseline is committed only after preparation succeeds.
        if (!milestoneDue && changed) queue(current, 'source_changed')
        if (!milestoneDue && !pages.length && current.scope.research) {
          const latest = state.preparations.findLast((entry) => entry.commitmentId === current.id && entry.revision === current.revision)
          const waitingForUser = latest?.question && !latest.evidence?.some((entry) => /^(?:https?:\/\/|workspace:|document:)/.test(entry.source ?? ''))
          current.watch.awaitingClarification = Boolean(waitingForUser)
          if (!waitingForUser) queue(current, 'research_refresh')
        }
      }
    })
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      if (active.get(goal.id)?.controller === controller) active.delete(goal.id)
    }
  }
  return sources
}

function outputArtifact(json, evidence, goal) {
  object(json, runtimeText('commitments.result'))
  const title = text(json.title, runtimeText('commitments.resultTitle'), 200, true)
  let content = text(json.content, runtimeText('commitments.resultBody'), 16000, true)
  if (!Array.isArray(json.evidenceIds) || !json.evidenceIds.length || json.evidenceIds.some((id) => typeof id !== 'string' || !evidence.some((e) => e.id === id))) problem(runtimeText('commitments.unknownCitation'))
  const citations = [...content.matchAll(/\[([a-z]+\d+)\]/g)].map((m) => m[1])
  if (!citations.length || citations.some((id) => !evidence.some((e) => e.id === id)) || citations.some((id) => !json.evidenceIds.includes(id))) problem(runtimeText('commitments.missingCitation'))
  if (json.deadlineClaims !== undefined && (!Array.isArray(json.deadlineClaims) || json.deadlineClaims.length > 8)) problem(runtimeText('commitments.invalidDateList'))
  const deadlineAssessment = goal.scope.research ? assessDeadlineClaims(json.deadlineClaims, evidence, goal) : null
  if (deadlineAssessment?.status === 'conflicting') content = runtimeText('commitments.conflictingDates', content)
  if (deadlineAssessment?.status === 'unverified') content = runtimeText('commitments.unverifiedDates', content)
  const evidenceIds = new Set([...json.evidenceIds, ...(deadlineAssessment?.claims ?? []).map((claim) => claim.evidenceId)])
  return {
    title, content,
    ...(goal.scope.research && json.resultKind === 'clarification' ? { resultKind: 'clarification' } : {}),
    evidence: evidence.filter((e) => evidenceIds.has(e.id)),
    ...(deadlineAssessment ? { deadlineAssessment } : {}),
    assumptions: Array.isArray(json.assumptions) ? json.assumptions.slice(0, 6).map((s) => text(s, runtimeText('commitments.assumption'), 500)) : [],
    question: json.question ? text(json.question, runtimeText('commitments.openQuestion'), 600) : null,
    verification: {
      passed: true,
      checks: [runtimeText('commitments.checkedStructure'), runtimeText('commitments.checkedCitations'), runtimeText('commitments.checkedScope')],
      factualAccuracy: 'not_independently_verified',
      note: runtimeText('commitments.reviewNotice'),
    },
  }
}

async function prepare(goal, runId, cachedPages, signal) {
  let evidence = [{
    id: 'goal1', label: goal.discovery && !goal.discovery.adopted ? runtimeText('commitments.discoveredLead') : runtimeText('commitments.confirmedGoal'), source: `commitment:${goal.id}`, observedAt: goal.updatedAt,
    excerpt: JSON.stringify({ title: goal.title, successCriteria: goal.successCriteria, nextAction: goal.nextAction, blocker: goal.blocker, deadline: goal.deadline, situation: goal.situation }),
  }]
  if (goal.source) evidence.push({ id: 'message1', label: runtimeText('commitments.creationMessage'), source: `conversation:${goal.source.conversationId}/${goal.source.messageId}`, observedAt: goal.source.observedAt, excerpt: goal.source.excerpt })
  if (goal.scope.memory) {
    const memories = await retrieve(`${goal.title} ${goal.successCriteria}`, { topK: 4 })
    evidence.push(...memories.map((m, i) => ({
      id: `memory${i + 1}`, label: runtimeText('commitments.memoryRecord'), source: `memory:${m.id}`,
      observedAt: m.last_seen || m.created_at, excerpt: m.text,
    })))
  }
  const state = ensure(await readState())
  if (!fresh(state.commitments.find((c) => c.id === goal.id), goal.revision)) return { discarded: true }
  // Keep older answers in the draft history while bounding the context sent on each preparation.
  const answered = state.preparations.filter((p) => p.commitmentId === goal.id && p.answer).slice(-5)
  for (const draft of answered) evidence.push({
    id: `answer${draft.revision}`, label: runtimeText('commitments.userAnswer'), source: `preparation:${draft.id}`, observedAt: draft.answer.answeredAt,
    excerpt: runtimeText('commitments.answerEvidence', draft.question, draft.answer.text),
  })
  const pages = cachedPages ?? (goal.scope.research ? [] : await readSources(goal, signal))
  if (!await currentGoal(goal)) return { discarded: true }
  const sourceErrors = pages.filter((p) => p.error)
  if (sourceErrors.length) problem(runtimeText('commitments.authorizedSourceFailed', sourceErrors.map((p) => `${p.source} — ${p.error}`).join('；')))
  evidence.push(...pages.filter((p) => !p.error))
  const cfg = await loadConfig()
  if (goal.scope.research && pages.some((page) => /^https?:/.test(page.source)) && (!cfg.search?.enabled || cfg.search.order?.includes('none'))) problem(runtimeText('commitments.webResearchStopped'), 403)
  if (!await currentGoal(goal)) return { discarded: true }
  signal?.throwIfAborted()
  let json, researchRunId
  if (goal.scope.research) {
    if (!cfg.proactive?.research?.enabled) problem(runtimeText('commitments.discoveryOff'), 403)
    const { researchCommitment } = await import('./research.mjs')
    const researched = await researchCommitment(goal, { evidence, signal })
    json = researched.json
    evidence = researched.evidence
    researchRunId = researched.runId
  } else {
    ;({ json } = await jsonTask({
    model: cfg.upstream.utilityModel || cfg.upstream.defaultModel,
    maxTokens: 1800, timeoutMs: 60000, temperature: 0.2, signal,
    system: runtimeText('commitments.systemPrompt'),
    user: JSON.stringify({ goal: { title: goal.title, successCriteria: goal.successCriteria, nextAction: goal.nextAction, blocker: goal.blocker, deadline: goal.deadline }, trigger: goal.preparation.reason, evidence, unavailableSources: sourceErrors }),
    }))
  }
  if (signal?.aborted || !await currentGoal(goal) || (goal.scope.research && !(await loadConfig()).proactive?.research?.enabled)) return { discarded: true }
  const output = outputArtifact(json, evidence, goal)
  let artifact
  await mutateState((state) => {
    ensure(state)
    const current = state.commitments.find((c) => c.id === goal.id)
    if (!fresh(current, goal.revision) || current.preparation.runId !== runId) return
    const at = nowIso()
    artifact = {
      id: newId('prep'), commitmentId: goal.id, revision: goal.revision, ...output,
      trigger: goal.preparation.originalReason ?? goal.preparation.reason, sourceErrors, createdAt: at, outcome: null,
      ...(researchRunId ? { runId: researchRunId } : {}),
      delivery: { status: 'pending', expiresAt: new Date(Date.now() + 7 * DAY).toISOString() },
    }
    for (const old of state.preparations) if (old.commitmentId === goal.id && old.delivery.status === 'pending') old.delivery.status = 'superseded'
    state.preparations.push(artifact)
    current.preparation = { state: 'ready', artifactId: artifact.id, completedAt: at }
    if (output.deadlineAssessment) {
      current.deadlineAssessment = output.deadlineAssessment
      if (output.deadlineAssessment.status === 'verified' && (!current.deadline || current.deadlineOrigin === 'research')) {
        current.deadline = output.deadlineAssessment.date
        current.deadlineOrigin = 'research'
        current.deadlineVersion = output.deadlineAssessment.version
      }
    }
    const watchedPages = goal.scope.research ? evidence.filter((entry) => /^(?:https?:\/\/|workspace:|document:)/.test(entry.source ?? '') && !entry.error) : pages
    const fingerprints = Object.fromEntries(watchedPages.map((page) => [page.requestedUrl ?? page.source, /^(?:workspace:|document:)/.test(page.source) ? page.fingerprint : relevantSourceFingerprint(goal, page)]))
    current.watch.nextCheckAt = new Date(Date.now() + HOUR).toISOString()
    current.watch.lastCheckAt = at
    current.watch.lastSuccessfulCheckAt = at
    current.watch.fingerprints = fingerprints
    if (goal.scope.research) {
      current.watch.sources = Object.keys(fingerprints).filter((entry) => /^https?:/.test(entry)).slice(0, 6)
      current.watch.fileSources = Object.keys(fingerprints).filter((entry) => entry.startsWith('workspace:')).slice(0, 4)
      current.watch.documentSources = Object.keys(fingerprints).filter((entry) => entry.startsWith('document:')).slice(0, 5)
      artifact.semanticFingerprint = JSON.stringify({ fingerprints, deadline: output.deadlineAssessment?.version ?? output.deadlineAssessment?.status, question: output.question })
    }
    current.watch.lastError = sourceErrors[0]?.error ?? null
    current.watch.failureCount = 0
    const milestone = ['deadline', 'combined'].includes(current.watch.type) ? deadlineMilestone(current) : null
    if (milestone) {
      current.watch.deadlineMilestones ??= {}
      current.watch.deadlineMilestones[milestone.key] = at
      current.watch.deadlineTriggered = current.deadline
      artifact.milestone = milestone.key
    }
    current.updatedAt = at
  })
  return artifact ? { prepared: artifact.id } : { discarded: true }
}

async function work() {
  const summary = { prepared: [], failed: [], discarded: 0, budgetDeferred: 0 }
  await mutateState((state) => {
    ensure(state)
    for (const goal of state.commitments) {
      if (goal.discovery && !goal.discovery.adopted && Date.parse(goal.discovery.expiresAt) <= Date.now() && ['active', 'paused'].includes(goal.status)) {
        goal.status = 'cancelled'
        goal.discovery.expiredAt = nowIso()
        goal.revision = (goal.revision ?? 1) + 1
        goal.preparation = { state: 'idle' }
        for (const artifact of state.preparations) if (artifact.commitmentId === goal.id && artifact.delivery.status === 'pending') artifact.delivery.status = 'expired'
        active.get(goal.id)?.controller.abort(new Error(runtimeText('commitments.expiredLead')))
      }
      if (goal.preparation.state === 'running' && goal.preparation.workerId !== workerId) {
        if (goal.status === 'active') queue(goal, 'interrupted')
        else goal.preparation = { state: 'idle' }
      }
      if (fresh(goal, goal.revision) && goal.preparation.state === 'failed' && Date.parse(goal.preparation.retryAt) <= Date.now()) queue(goal, 'retry')
    }
  })
  const sourceCache = await checkWatches()
  const priority = (goal) => {
    if (['requested', 'answered'].includes(goal.preparation.reason)) return 0
    const milestone = deadlineMilestone(goal)
    if (milestone && !goal.watch.deadlineMilestones?.[milestone.key]) return 1
    if (goal.preparation.reason === 'research_refresh') return 5
    if (goal.origin !== 'discovered') return 2
    return goal.preparation.reason === 'retry' ? 4 : 3
  }
  const ids = ensure(await readState()).commitments.filter((g) => g.status === 'active' && g.preparation.state === 'queued').sort((a, b) => priority(a) - priority(b)).map((g) => g.id)
  for (const id of ids) {
    let goal, runId
    await mutateState(async (state) => {
      ensure(state)
      const current = state.commitments.find((g) => g.id === id)
      if (current?.status !== 'active' || current.preparation.state !== 'queued') return
      if (current.scope.research && !(await loadConfig()).proactive?.research?.enabled) {
        current.preparation.error = runtimeText('commitments.enableResearch')
        return
      }
      const runs = state.commitmentWork.runs = state.commitmentWork.runs.filter((run) => Date.parse(run.at) > Date.now() - DAY)
      if (runs.length >= 5 || runs.filter((run) => run.commitmentId === id).length >= 2) {
        current.preparation.error = runtimeText('commitments.budgetExhausted')
        summary.budgetDeferred++
        return
      }
      runId = newId('run')
      runs.push({ id: runId, commitmentId: id, at: nowIso() })
      current.preparation = { ...current.preparation, state: 'running', runId, workerId, startedAt: nowIso() }
      delete current.preparation.error
      goal = structuredClone(current)
    })
    if (!goal) continue
    const controller = new AbortController()
    active.set(id, { controller, research: Boolean(goal.scope.research) })
    try {
      const cached = sourceCache.get(goal.id)
      const result = await prepare(goal, runId, cached?.revision === goal.revision ? cached.pages : undefined, controller.signal)
      if (result.prepared) summary.prepared.push(result.prepared)
      else {
        summary.discarded++
        await mutateState((state) => {
          const current = ensure(state).commitments.find((entry) => entry.id === id)
          if (current?.preparation.runId === runId) queue(current, 'interrupted')
        })
      }
    } catch (error) {
      if (controller.signal.aborted || !await currentGoal(goal)) {
        summary.discarded++
        await mutateState((state) => {
          const current = ensure(state).commitments.find((entry) => entry.id === id)
          if (current?.preparation.runId === runId) queue(current, 'interrupted')
        })
        continue
      }
      await mutateState((state) => {
        ensure(state)
        const current = state.commitments.find((g) => g.id === id)
        if (!fresh(current, goal.revision) || current.preparation.runId !== runId) return
        const failureCount = Math.min((current.watch.failureCount ?? 0) + 1, 8)
        const retryAt = new Date(Date.now() + Math.min(6 * HOUR, 5 * 60000 * 2 ** (failureCount - 1))).toISOString()
        current.watch = { ...current.watch, failureCount, lastError: String(error.message).slice(0, 500), nextCheckAt: retryAt, lastCheckAt: nowIso() }
        current.preparation = { state: 'failed', originalReason: goal.preparation.originalReason ?? goal.preparation.reason,
          error: String(error.message).slice(0, 500), failedAt: nowIso(), retryAt }
      })
      summary.failed.push({ commitmentId: id, error: String(error.message).slice(0, 500) })
    } finally {
      if (active.get(id)?.controller === controller) active.delete(id)
    }
  }
  return summary
}

export function prepareDueCommitments() {
  if (!worker) worker = work().finally(() => { worker = null })
  return worker
}

export async function pendingPreparations(snapshot) {
  const state = ensure(snapshot ?? await readState())
  const cfg = await loadConfig()
  return state.preparations.filter((artifact) =>
    artifact.delivery.status === 'pending' &&
    Date.parse(artifact.delivery.expiresAt) > Date.now() &&
    canDeliverPreparation(state.commitments.find((g) => g.id === artifact.commitmentId), artifact, cfg))
}

export function canDeliverPreparation(goal, artifact, cfg) {
  if (!fresh(goal, artifact.revision)) return false
  if (!goal.scope?.research) return true
  if (!cfg.proactive?.research?.enabled) return false
  const evidence = artifact.evidence ?? []
  if (artifact.resultKind !== 'clarification' && !citesReadResearchSource(artifact.content, evidence)) return false
  const watch = goal.watch ?? {}
  const usesWeb = watch.sources?.length || evidence.some((item) => /^https?:\/\//.test(item?.source))
  const usesWorkspace = watch.fileSources?.length || evidence.some((item) => /^workspace:/.test(item?.source))
  if (usesWeb && (!cfg.search?.enabled || cfg.search.order?.includes('none'))) return false
  if (usesWorkspace && (!cfg.harness?.enabled || !goal.scope.workspaceRoot || cfg.harness.workspaceRoot !== goal.scope.workspaceRoot)) return false
  if (usesWeb || usesWorkspace || watch.documentSources?.length || evidence.some((item) => /^document:/.test(item?.source)) || ['source_change', 'combined'].includes(watch.type)) {
    if (watch.lastError || ['queued', 'running', 'failed'].includes(goal.preparation?.state)) return false
    if (!(Date.parse(watch.lastSuccessfulCheckAt) > Date.now() - HOUR && Date.parse(watch.nextCheckAt) > Date.now())) return false
  }
  return true
}

export async function markPreparationDelivered(id, { conversationId, messageId, deliveredAt, timingTrigger, deliveryTimeZone }) {
  assertId(id)
  assertId(conversationId)
  assertId(messageId)
  let result = null
  await mutateState(async (state) => {
    const cfg = await loadConfig()
    ensure(state)
    const artifact = state.preparations.find((p) => p.id === id)
    if (!artifact || artifact.delivery.status !== 'pending' || Date.parse(artifact.delivery.expiresAt) <= Date.now() || !canDeliverPreparation(state.commitments.find((g) => g.id === artifact.commitmentId), artifact, cfg)) return
    artifact.delivery = { ...artifact.delivery, status: 'delivered', conversationId, messageId, deliveredAt: deliveredAt ?? nowIso(),
      timingTrigger, timeZone: deliveryTimeZone }
    result = artifact
  })
  return result
}
