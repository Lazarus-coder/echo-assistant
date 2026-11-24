// Format local API data for the terminal. Identifiers and user content are opaque.
import { readFileSync } from 'node:fs'

const [command, language] = process.argv.slice(2)
const zh = language === 'zh-CN'
const translations = zh ? JSON.parse(readFileSync(new URL('./locales/zh-CN.cli.json', import.meta.url), 'utf8')) : {}
const t = english => translations[english] ?? english
const yes = value => value ? t('yes') : t('no')
const on = value => value ? t('on') : t('off')
const print = (...args) => console.log(' ', ...args)

// The browser and CLI describe the same deterministic deferrals.
const labels = {
  topic_muted: 'youMutedThisTopic',
  sparse_history: 'moreChatHistoryIsNeededToIdentify',
  usual_chat_window: 'thisIsATimeYouOftenChat',
  outside_usual_window: 'thisFallsOutsideYourUsualChatTimes',
  waiting_for_usual_window: 'aUsualChatTimeIsApproachingSo',
  repeated_wrong_time: 'youHaveRepeatedlyRatedThisTimeAs',
  quiet_style_gap: 'theRecommendedInterruptionIntervalHasNotElapsed',
  learned_timing_gap: 'echoIsWaitingForTheIntervalLearned',
  requested_goal: 'youAskedForThisFollowUpSo',
  quiet_hours: 'yourQuietHoursAreInEffect',
  wrong_time_pause: 'remindersArePausedAfterYourTimingFeedback',
  recent_chat_activity: 'youJustSentAMessageEchoWill',
  user_active: 'aConversationIsInProgress',
  focus_deep: 'screenContextSuggestsYouAreFocused',
  focus_meeting: 'screenContextSuggestsYouAreInA',
  shared_daily_budget: 'dailyReminderBudgetUsedAcrossAllChannels',
  daily_budget: 'dailyProactiveMessageLimitReached',
  shared_min_gap: 'tooSoonSinceTheLastReminder',
  min_gap: 'tooSoonSinceTheLastProactiveMessage',
  delivery_in_progress: 'aReminderIsBeingDelivered',
  disabled: 'proactiveRemindersAreOff',
  no_material: 'nothingToFollowUpOn',
  duplicate: 'thisContentHasAlreadyBeenDelivered',
  unchanged_evidence: 'noNewEvidenceForThisItem',
  unchanged_context: 'theEvidenceIsUnchangedSinceTheLast',
  expired: 'thisReminderExpired',
  stale_preparation: 'thePreparedResultChangedOrExpired',
  stale_evidence: 'theEvidenceForThisReminderChangedOr',
  already_delivered: 'reminderDelivered',
  tick_running: 'anotherCheckIsInProgress',
  below_threshold: 'theLocalScoreIsBelowTheReminder',
  empty_message: 'noReminderTextWasGenerated',
  feedback_suppressed: 'youRecentlyRatedThisItemAsLess',
  composer_abstained: 'theModelSuppliedNoWordingForThis',
  unusable_wording: 'theSuggestedWordingDidNotFitThe',
  composer_error: 'itemSelectedTheWordingRequestFailedTemporarily',
  unsupported_evidence: 'thisReminderLacksSupportingEvidence',
  bad_json: 'couldNotReadTheContentEvaluation',
  error: 'checkIncomplete',
  follow_up: 'followUp',
  suggest: 'suggestion',
  guide: 'guidance',
  ask: 'question',
  brief: 'dailyBrief',
}
let catalog
function label(code) {
  if (!code) return '—'
  catalog ??= JSON.parse(readFileSync(new URL(`../public/locales/${zh ? 'zh-CN' : 'en'}.json`, import.meta.url), 'utf8'))
  return catalog[labels[code] ?? code] ?? (code === 'closed' ? t('Closed') : code)
}

function format(d) {
  if (d.ok === false) throw new Error(d.message || d.error || t('Request failed'))
  switch (command) {
    case 'health': {
      const l = d.listener
      if (l) print(t('Listener:'), l.address === '0.0.0.0' ? t('LAN') : t('local'), `${l.address}:${l.port}`)
      break
    }
    case 'summary':
      if (d.listener?.lanUrl) print(t('LAN address:'), d.listener.lanUrl)
      print(t('Unread'), d.unread ?? 0, t('· Check-ins today'), d.proactiveToday ?? 0, t('· Follow-ups'), d.loops ?? 0, t('· Memories'), d.memory?.observations ?? 0)
      print(t('Last Dream'), d.dreamLastAt || t('never'), t('· Search'), on(d.enabled?.search), t('· Proactivity'), on(d.enabled?.proactive))
      break
    case 'dream': {
      const r = d.result
      if (!r?.ok) throw new Error(r?.error || t('Dream failed'))
      print((r.summary ?? []).join(zh ? '；' : '; '))
      print(t('Follow-ups:'), r.loops?.length ?? 0, t('· Topics:'), r.nudges?.length ?? 0)
      break
    }
    case 'say': {
      const r = d.result
      if (r.acted) print(t('Sent:'), r.message.content.slice(0, 120))
      else print(t('Skipped:'), label(r.skipped), r.reason ?? '')
      break
    }
    case 'search':
      print(t('Engine:'), d.engine, '·', d.ms + ' ms', '·', d.results.length, t('results'))
      for (const r of d.results.slice(0, 3)) print('-', r.url)
      break
    case 'mcp':
      if (!d.servers?.length) print(t('No MCP servers configured.'))
      for (const s of d.servers ?? []) print(s.name, label(s.state), s.tools, t('tools'))
      break
    case 'auth': {
      const a = d.config.auth ?? {}
      print(t('Password authentication:'), on(a.required), t('· Password set:'), yes(a.passwordSet))
      print(t('Usage:'), './bin/echo auth on|off')
      break
    }
    case 'forget':
      print(t('Faded or forgotten:'), d.items.length)
      for (const o of d.items.slice(0, 6)) print('-', '[' + label(o.status) + ']', o.text.slice(0, 50), '←', o.reason)
      print(t('Recent forgetting log:'))
      for (const b of (d.log ?? []).slice(0, 8)) print(b.split('\n')[0])
      break
    case 'diag': {
      const m = d.metrics, turns = m.turns
      print(t('Turns in 7 days:'), turns.count, t('· Failure rate:'), Math.round(turns.errorRate * 100) + '%', '· P95', turns.p95Ms + ' ms', t('· Average rounds:'), turns.avgRounds)
      print(t('Input tokens:'), turns.tokensIn, t('· Output tokens:'), turns.tokensOut)
      for (const [k, v] of Object.entries(m.tools ?? {})) print(t('Tool:'), k, v.count, t('calls · Success:'), Math.round(v.okRate * 100) + '%', '· P50', v.p50Ms + ' ms')
      for (const [k, v] of Object.entries(m.search ?? {})) print(t('Search:'), k, v.count, t('calls'), '· P50', v.p50Ms + ' ms')
      print(t('Proactive messages:'), m.proactive?.acted ?? 0, t('· Reply rate:'), m.proactive?.replyRate ?? '—')
      print(t('Screenshots:'), d.storage.screenshots.mb + ' MB', t('· Uploads:'), d.storage.uploads.mb + ' MB')
      print(t('Memories:'), d.memory.observations, t('· Faded:'), d.memory.forgetting.faded, t('· Graph nodes:'), d.graph.nodes)
      print(t('Preferred suggestion type:'), label(d.agency.best), t('· Screen awareness:'), on(d.screen.enabled))
      break
    }
    case 'selftest':
      print(t('Checks passed:'), d.passed + '/' + d.total)
      for (const [index, result] of d.results.entries()) {
        if (!result.ok) print(t('Failed check:'), result.track, '#' + (index + 1), zh ? result.name : '')
      }
      print(t('Detailed report:'), 'tests/last-report.json')
      break
    default: throw new Error('Unknown formatter ' + command)
  }
}

try { format(JSON.parse(readFileSync(0, 'utf8'))) }
catch (error) { console.error(error.message); process.exitCode = 1 }
