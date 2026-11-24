import { domainText } from './domain-language.mjs'
import { readState, mutateState } from './store.mjs'
import { assertId, newId, nowIso } from './util.mjs'

export const DEFAULT_RELATIONSHIP_PROFILE = Object.freeze({
  enabled: true,
  tone: 'subtle',
  support: 'balanced',
  preferredName: '',
  boundaries: '',
})

const profileKeys = Object.keys(DEFAULT_RELATIONSHIP_PROFILE)
const personKeys = ['name', 'aliases', 'relationship', 'context', 'boundaries']
const tones = new Set(['subtle', 'warm', 'direct'])
const supportModes = new Set(['balanced', 'listen', 'practical'])

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function checkShape(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalid(domainText('relationships.unknownField'))
  }
}

function text(value, field, max, min = 0) {
  if (typeof value !== 'string') throw invalid(domainText('relationships.invalidText', field))
  const result = value.trim()
  if (result.length < min || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw invalid(domainText('relationships.textLength', field, min, max))
  }
  return result
}

function profilePatch(input) {
  checkShape(input, profileKeys)
  const patch = { ...input }
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw invalid(domainText('relationships.invalidEnabled'))
  if ('tone' in patch && !tones.has(patch.tone)) throw invalid(domainText('relationships.invalidTone'))
  if ('support' in patch && !supportModes.has(patch.support)) throw invalid(domainText('relationships.invalidSupport'))
  if ('preferredName' in patch) patch.preferredName = text(patch.preferredName, domainText('relationships.preferredName'), 80)
  if ('boundaries' in patch) patch.boundaries = text(patch.boundaries, domainText('relationships.boundaries'), 600)
  return patch
}

function personPatch(input, creating = false) {
  checkShape(input, personKeys)
  const patch = { ...input }
  if (creating || 'name' in patch) patch.name = text(patch.name, domainText('relationships.name'), 80, 2)
  for (const [key, max] of [['relationship', 120], ['context', 1200], ['boundaries', 600]]) {
    if (key in patch) patch[key] = text(patch[key], key, max)
  }
  if ('aliases' in patch) {
    if (!Array.isArray(patch.aliases) || patch.aliases.length > 5) throw invalid(domainText('relationships.maxAliases'))
    patch.aliases = patch.aliases.map((alias) => text(alias, domainText('relationships.alias'), 80, 2))
  }
  return patch
}

function relationshipState(state) {
  const saved = state.relationship ?? {}
  return {
    profile: { ...DEFAULT_RELATIONSHIP_PROFILE, ...saved.profile },
    people: Array.isArray(saved.people) ? saved.people : [],
  }
}

const folded = (value) => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
const names = (person) => [person.name, ...person.aliases]

function checkNames(person, people) {
  const labels = names(person).map(folded)
  if (new Set(labels).size !== labels.length) throw invalid(domainText('relationships.duplicateAlias'))
  if (people.some((other) => other.id !== person.id && names(other).some((name) => labels.includes(folded(name))))) {
    throw invalid(domainText('relationships.nameInUse'), 409)
  }
}

export async function getRelationships() {
  return relationshipState(await readState())
}

export async function saveRelationshipProfile(input) {
  const patch = profilePatch(input)
  let result
  await mutateState((state) => {
    result = relationshipState(state)
    result.profile = { ...result.profile, ...patch }
    state.relationship = result
  })
  return result
}

export async function createRelationshipPerson(input) {
  const patch = personPatch(input, true)
  let person
  await mutateState((state) => {
    const relationship = relationshipState(state)
    if (relationship.people.length >= 12) throw invalid(domainText('relationships.maxContacts'), 409)
    const now = nowIso()
    person = { id: newId('person'), name: '', aliases: [], relationship: '', context: '', boundaries: '', ...patch, source: 'user', createdAt: now, updatedAt: now }
    checkNames(person, relationship.people)
    relationship.people.push(person)
    state.relationship = relationship
  })
  return person
}

export async function updateRelationshipPerson(id, input) {
  assertId(id)
  const patch = personPatch(input)
  let person
  await mutateState((state) => {
    const relationship = relationshipState(state)
    const index = relationship.people.findIndex((entry) => entry.id === id)
    if (index < 0) throw invalid(domainText('relationships.contactMissing'), 404)
    person = { ...relationship.people[index], ...patch, source: 'user', updatedAt: nowIso() }
    checkNames(person, relationship.people)
    relationship.people[index] = person
    state.relationship = relationship
  })
  return person
}

export async function deleteRelationshipPerson(id) {
  assertId(id)
  let deleted = false
  await mutateState((state) => {
    const relationship = relationshipState(state)
    const index = relationship.people.findIndex((entry) => entry.id === id)
    if (index < 0) return
    relationship.people.splice(index, 1)
    state.relationship = relationship
    deleted = true
  })
  return deleted
}

export function relationshipGuidance(profileOrStatus, { background = false } = {}) {
  const profile = { ...DEFAULT_RELATIONSHIP_PROFILE, ...(profileOrStatus?.profile ?? profileOrStatus) }
  const general = [
    domainText('relationships.measureHelp'),
    domainText('relationships.feelings'),
    domainText('relationships.noDependency'),
    background ? domainText('relationships.background') : domainText('relationships.noCheckins'),
    domainText('relationships.scope'),
  ]
  if (!profile.enabled) return general.join('\n')
  const tone = {
    subtle: domainText('relationships.subtle'),
    warm: domainText('relationships.warm'),
    direct: domainText('relationships.direct'),
  }[profile.tone] ?? ''
  const support = {
    balanced: domainText('relationships.balanced'),
    listen: domainText('relationships.listen'),
    practical: domainText('relationships.practical'),
  }[profile.support] ?? ''
  const preferences = JSON.stringify({ preferredName: profile.preferredName, boundaries: profile.boundaries })
  return [
    ...general,
    domainText('relationships.preferences'),
    tone,
    support,
    domainText('relationships.profileInstruction'),
    preferences,
  ].filter(Boolean).join('\n')
}

function namePosition(query, name) {
  const needle = folded(name)
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(needle)) return query.indexOf(needle)
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'u').exec(query)
  return match ? match.index + match[0].length - match[1].length : -1
}

function matchingPeople(query, people) {
  const normalized = folded(query)
  return people.map((person) => {
    const positions = names(person).map((name) => namePosition(normalized, name)).filter((position) => position >= 0)
    return { person, position: positions.length ? Math.min(...positions) : -1 }
  }).filter(({ position }) => position >= 0).sort((a, b) => a.position - b.position).slice(0, 3).map(({ person }) => person)
}

function isShortFollowup(query) {
  if (!query || query.length > 160) return false
  return /^(?:他|她)(?:们)?/u.test(query)
    || /^(?:那(?:么)?[，,\s]*)?(?:我)?(?:该|应该|可以)?(?:怎么|如何)(?:回复?|说|回应)[呢啊呀？?！!。\s]*$/u.test(query)
    || /^(?:(?:帮我|替我)?回复?(?:他|她)(?:们)?|(?:把|将)?(?:这|那)(?:个|条|段)(?:回复|消息|回答|文字|语气)|(?:改得|说得|写得)(?:更)?(?:柔和|委婉|温和|简短|直接|礼貌|自然|客气))/u.test(query)
    || /^(?:换个说法|(?:再)?(?:柔和|委婉|简短|温和|礼貌)(?:一点|些))[吧呢？?！!。\s]*$/u.test(query)
    || /^(?:(?:and|then|so|but)\b\s*)?(?:he|she|they|him|her|them)\b/iu.test(query)
    || /^(?:what (?:should|could|can) i (?:say|do)|how (?:should|could|can) i (?:reply|respond))(?: to (?:him|her|them))?[?!.…\s]*$/iu.test(query)
    || /^(?:make|keep) (?:it|that|this) (?:a little |slightly |more )?(?:soft(?:er)?|kind(?:er)?|warm(?:er)?|short(?:er)?|clear(?:er)?|concise|polite|neutral|gentle)\b/iu.test(query)
    || /^(?:rewrite|shorten|soften)(?: (?:it|that|this)(?: (?:reply|message|response))?)?[?!.…\s]*$/iu.test(query)
    || /^(?:(?:this|that) (?:reply|message|response)\b|try again[?!.…\s]*$)/iu.test(query)
}

export async function buildRelationshipContext({ query = '', recentUserTexts = [] } = {}) {
  const { profile, people } = await getRelationships()
  if (!profile.enabled) return { text: relationshipGuidance({ enabled: false }), used: [] }
  const current = typeof query === 'string' ? query.trim() : ''
  let matched = matchingPeople(current, people)
  if (!matched.length && isShortFollowup(current)) {
    // Only the immediately preceding user message can disambiguate a short follow-up.
    const previous = recentUserTexts.at(-1)
    if (typeof previous === 'string' && previous.trim()) matched = matchingPeople(previous, people)
  }
  const lines = [relationshipGuidance(profile)]
  if (matched.length) {
    lines.push(
      domainText('relationships.contactInstruction'),
      JSON.stringify(matched.map((person) => ({
        name: person.name, aliases: person.aliases, relationship: person.relationship, context: person.context, boundaries: person.boundaries, source: 'user', updatedAt: person.updatedAt,
      }))),
    )
  }
  return { text: lines.join('\n'), used: matched.map(({ id, name }) => ({ id, name })) }
}
