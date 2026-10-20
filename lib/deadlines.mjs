import { createHash } from 'node:crypto'

const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20)
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

export function commitmentCaseKey(goal) {
  const situation = goal.situation ?? {}
  const identity = ['institution', 'program', 'cycle', 'category'].map((key) => normalize(situation[key]))
  return identity.slice(0, 3).every(Boolean) ? identity.join(':') : `title:${normalize(goal.title)}:${identity.join(':')}`
}

function quotedDate(quote, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false
  const [year, month, day] = date.split('-').map(Number)
  const numeric = new RegExp(`(?:^|\\D)${year}\\s*(?:[-/.]|年)\\s*0?${month}\\s*(?:[-/.]|月)\\s*0?${day}(?:日)?(?:\\D|$)`, 'u')
  const monthName = `(?:${months[month - 1]}|${months[month - 1].slice(0, 3)}\\.?)`
  const english = new RegExp(`(?:${monthName}\\s+0?${day}(?:st|nd|rd|th)?\\s*,?\\s*${year}|0?${day}(?:st|nd|rd|th)?\\s+${monthName}\\s*,?\\s*${year})`, 'iu')
  return numeric.test(quote) || english.test(quote)
}

function officialSource(evidence, domains) {
  try {
    const url = new URL(evidence.source)
    return ['http:', 'https:'].includes(url.protocol) && evidence.authority === 'official' && domains.includes(url.hostname.toLowerCase())
  } catch { return false }
}

export function assessDeadlineClaims(rawClaims, evidence, goal) {
  const claims = (Array.isArray(rawClaims) ? rawClaims : []).slice(0, 8).map((raw) => {
    const claim = {}
    for (const key of ['evidenceId', 'quote', 'date', 'institution', 'program', 'cycle', 'category', 'stage', 'time', 'timezone']) {
      if (typeof raw?.[key] === 'string') claim[key] = raw[key].trim().slice(0, key === 'quote' ? 1600 : 200)
    }
    const reasons = []
    const item = evidence.find((entry) => entry.id === claim.evidenceId)
    if (!item || item.error || !claim.quote || !String(item.excerpt ?? '').includes(claim.quote)) reasons.push('原文中未找到完整引文')
    if (!quotedDate(claim.quote ?? '', claim.date)) reasons.push('引文未明确包含完整年月日')
    if (!item || !officialSource(item, goal.scope?.officialDomains ?? [])) reasons.push('来源域名尚未确认为官方来源')
    const sourceText = normalize(`${item?.label ?? ''} ${item?.excerpt ?? ''}`)
    const quoteText = normalize(claim.quote)
    for (const key of ['institution', 'program', 'cycle', 'stage']) {
      const expected = normalize(goal.situation?.[key])
      if (!expected || normalize(claim[key]) !== expected || !sourceText.includes(expected)) reasons.push(`无法核对 ${key}`)
      if (key !== 'institution' && expected && !quoteText.includes(expected)) reasons.push(`引文缺少 ${key} 上下文`)
    }
    if (goal.situation?.category && (normalize(claim.category) !== normalize(goal.situation.category) || !quoteText.includes(normalize(goal.situation.category)))) reasons.push('事项类型不一致或引文缺少事项类型')
    if (claim.time || claim.timezone) {
      if (!claim.time || !claim.timezone || !claim.quote?.includes(claim.time) || !claim.quote.includes(claim.timezone)) reasons.push('引文未明确给出时间与时区')
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(claim.time ?? '')) reasons.push('时间格式无效')
      try {
        if (!/^(?:(?:UTC|GMT)?[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(claim.timezone ?? '')) new Intl.DateTimeFormat('en', { timeZone: claim.timezone }).format()
      } catch { reasons.push('时区格式无效') }
    }
    return { ...claim, status: reasons.length ? 'unverified' : 'verified', reasons }
  })
  const qualified = claims.filter((claim) => claim.status === 'verified')
  const dates = [...new Set(qualified.map((claim) => claim.date))]
  const clocks = [...new Set(qualified.filter((claim) => claim.time && claim.timezone).map((claim) => `${claim.time}|${claim.timezone}`))]
  const manualConflict = goal.deadline && goal.deadlineOrigin !== 'research' && dates.some((date) => date !== goal.deadline)
  const conflicting = dates.length > 1 || clocks.length > 1 || manualConflict
  if (conflicting) for (const claim of qualified) {
    claim.status = 'conflicting'
    claim.reasons.push(manualConflict ? '与用户已设置的日期不一致' : '官方来源之间存在日期冲突')
  }
  const status = conflicting ? 'conflicting' : dates.length === 1 ? 'verified' : claims.length ? 'unverified' : 'none'
  const date = status === 'verified' ? dates[0] : null
  const [time, timezone] = clocks.length === 1 && date ? clocks[0].split('|') : []
  return {
    status, date, claims, checkedAt: new Date().toISOString(),
    ...(time ? { time, timezone } : {}),
    ...(date ? { version: hash(JSON.stringify({ date, time, timezone, identity: commitmentCaseKey(goal), stage: normalize(goal.situation?.stage) })) } : {}),
    note: '核对范围为原文引文、日期、事项身份及用户指定官方域名；不代表独立证明事实。未给出时间的日期不推定具体截止时刻。',
  }
}

export function relevantSourceFingerprint(goal, page) {
  if (!goal.scope?.research) return page.fingerprint
  const terms = [goal.situation?.program, goal.situation?.cycle, goal.situation?.category, goal.title]
    .filter(Boolean).map(normalize).filter((term) => term.length > 1)
  const lines = String(page.excerpt ?? '').split(/[\n。！？]+/u).map((line) => line.trim())
    .filter((line) => line && !/copyright|privacy policy|all rights reserved|版权所有|隐私政策|^\s*(?:©|last updated|last modified|更新时间)/iu.test(line))
  const relevant = lines.filter((line) => /deadline|registration|application|admission|close[sd]?|截止|报名|申请|招生|注册|\d{4}[-/年]/iu.test(line) || terms.some((term) => normalize(line).includes(term)))
  return hash((relevant.length ? relevant : lines).map((line) => line.replace(/\s+/gu, ' ').trim()).join('\n'))
}

export function deadlineMilestone(goal, now = new Date()) {
  if (!goal.deadline || goal.deadlineAssessment?.status === 'conflicting') return null
  if (goal.deadlineOrigin === 'research' && goal.deadlineAssessment?.status !== 'verified') return null
  const assessment = goal.deadlineAssessment?.status === 'verified' ? goal.deadlineAssessment : null
  const clock = localClock(now, assessment?.timezone)
  const today = `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
  const days = Math.round((Date.parse(`${goal.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
  if (!Number.isFinite(days) || days > 2) return null
  const [hour, minute] = (assessment?.time ?? '').split(':').map(Number)
  const timePassed = Number.isFinite(hour) && Number.isFinite(minute) && clock.hour * 60 + clock.minute >= hour * 60 + minute
  const stage = days > 0 ? 'soon' : days === 0 && !timePassed ? 'today' : 'overdue'
  return { key: `${goal.deadlineVersion ?? goal.deadline}:${stage}`, stage }
}

function localClock(now, timezone) {
  const offset = timezone?.match(/^(?:(?:UTC|GMT)?)([+-])(\d{2}):(\d{2})$/)
  if (offset) {
    const shifted = new Date(now.getTime() + (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1) * 60000)
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
  }
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
      return Object.fromEntries(parts.filter((part) => ['year', 'month', 'day', 'hour', 'minute'].includes(part.type)).map((part) => [part.type, Number(part.value)]))
    } catch {}
  }
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() }
}
