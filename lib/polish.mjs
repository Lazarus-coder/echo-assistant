import { languageText } from './language.mjs'
import { domainText } from './domain-language.mjs'
import { clip, tokenize } from './util.mjs'
import { jsonTask } from './native.mjs'
import { getConversation } from './store.mjs'
import { retrieve } from './memory.mjs'
import { workingContext } from './screen.mjs'
import { record } from './metrics.mjs'

/**
 * 提示词润色：输入框里的话通常很短、省主语、缺粒度。
 * 这里做一次显式 CoT：先猜意图 → 找出缺口 → 只做有依据的推断 → 再落笔，
 * 并且把"意图/缺口/假设"一并交回给用户看，而不是偷偷替换掉他写的东西。
 */

export const MODES = {
  expand: {
    get label() { return domainText('polish.expand') },
    get note() { return domainText('polish.expandNote') },
    get instruction() { return domainText('polish.expandInstruction') },
  },
  polish: {
    get label() { return domainText('polish.lightEdit') },
    get note() { return domainText('polish.lightNote') },
    get instruction() { return domainText('polish.lightInstruction') },
  },
  tighten: {
    get label() { return domainText('polish.condense') },
    get note() { return domainText('polish.condenseNote') },
    get instruction() { return domainText('polish.condenseInstruction') },
  },
}

const systemPrompt = () => domainText('polish.systemPrompt')

// 泛化名词不算"提到了"：否则"脚本/项目/报告"这种词会把记忆里无关的具体项目名带进来，
// 模型就可能替用户编出一个他没说过的对象（实测踩过两次）
const GENERIC = new Set(['脚本', '项目', '文件', '文档', '报告', '代码', '更新', '内容', '问题', '东西', '事情', '那个', '这个', '一个', '帮我', '看看', '整理', '部署',
  'script', 'project', 'file', 'document', 'report', 'code', 'update', 'content', 'problem', 'thing', 'this', 'that', 'the', 'for', 'help', 'please', 'look', 'check', 'deploy'])

function sharedTokens(draft, fact) {
  const draftTokens = new Set(tokenize(draft).filter((t) => t.length >= 2 && !GENERIC.has(t)))
  if (!draftTokens.size) return 0
  return tokenize(`${fact} `).filter((t) => t.length >= 2 && !GENERIC.has(t) && draftTokens.has(t)).length
}

/**
 * 只在记忆里出现、用户原话里没有的"专有名词"。提示词管不住模型时（实测它照样把
 * 无关项目名写进正文），用这个做确定性检测：命中就去掉记忆重写一次。
 */
export function novelTerms(draft, memoryText) {
  const d = String(draft ?? '')
  const mem = String(memoryText ?? '')
  const terms = new Set()
  for (const w of mem.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) ?? []) {
    if (!GENERIC.has(w.toLowerCase()) && !d.toLowerCase().includes(w.toLowerCase())) terms.add(w)
  }
  // 中文取 3~4 字滑窗（只取最长串会漏掉"整段里被引用了其中几个字"的情况）；
  // 每个串限额，避免前一个长串的滑窗把后面的串挤掉（实测踩过）
  let perRun = 0
  for (const run of mem.match(/[\u4e00-\u9fff]{3,}/g) ?? []) {
    perRun = 0
    for (const len of [3, 4]) {
      for (let i = 0; i + len <= run.length && perRun < 6; i++) {
        const win = run.slice(i, i + len)
        if (!d.includes(win) && !GENERIC.has(win) && !terms.has(win)) {
          terms.add(win)
          perRun++
        }
      }
    }
  }
  return [...terms].filter((t) => t.length >= 3).slice(0, 30)
}

/** 组装润色用的上下文（与聊天用的同一批信号，但更短）。includeMemory=false 用于护栏重试。 */
async function buildContext({ conversationId, text, cfg, includeMemory = true }) {
  const parts = []
  let memoryText = ''
  const otherParts = []
  const conv = conversationId ? await getConversation(conversationId).catch(() => null) : null
  if (conv) {
    const tail = (conv.messages ?? []).slice(-8)
    if (tail.length) {
      const block = [
        domainText('polish.chatContext', conv.title || domainText('polish.untitled')),
        ...tail.map((m) => `${m.role === 'user' ? domainText('polish.user') : domainText('polish.assistant')}: ${clip(String(m.content ?? '').replace(/\s+/g, ' '), 200)}`),
      ]
      parts.push(...block)
      otherParts.push(block.join('\n'))
    }
  }
  try {
    if (includeMemory) {
      const facts = await retrieve(text, { topK: 4 })
      // 只让与草稿有"有效词面重叠"的记忆参与推断（泛化名词不算重叠）
      const relevant = facts.filter((f) => sharedTokens(text, `${f.text} ${(f.tags ?? []).join(' ')}`) > 0)
      memoryText = relevant.map((f) => f.text).join('\n')
      if (relevant.length) parts.push(domainText('polish.memoryContext'), ...relevant.map((f) => `- ${f.text}`))
    }
  } catch {}
  try {
    if (cfg.screen?.enabled) {
      const now = await workingContext({ minutes: 30 })
      if (now.text) {
        const block = domainText('polish.currentActivity', now.app ?? '', now.activity ? languageText('｜', ' | ') + now.activity : '')
        parts.push(block)
        otherParts.push(block)
      }
    }
  } catch {}
  return { text: parts.join('\n').slice(0, 6000), memoryText, otherText: otherParts.join('\n') }
}

export async function polishText({ text, mode = 'expand', conversationId, cfg }) {
  const draft = String(text ?? '').trim()
  if (!draft) {
    const e = new Error(domainText('polish.empty'))
    e.status = 400
    throw e
  }
  if (draft.length > 4000) {
    const e = new Error(domainText('polish.tooLong'))
    e.status = 400
    throw e
  }
  const spec = MODES[mode] ?? MODES.expand
  const started = Date.now()
  const call = async (includeMemory) => {
    const ctx = await buildContext({ conversationId, text: draft, cfg, includeMemory })
    const out = await jsonTask({
      system: domainText('polish.mode', systemPrompt(), spec.label, spec.instruction),
      user: [ctx.text || domainText('polish.noContext'), '', domainText('polish.draft'), draft].join('\n'),
      model: cfg.upstream.utilityModel || cfg.upstream.defaultModel,
      maxTokens: 900,
      temperature: 0.3,
      timeoutMs: 45000,
      schemaHint: '{"intent":"","gaps":[],"assumptions":[],"polished":"","notes":""}',
    })
    return { ...out, ctx }
  }

  let { json, usage, ctx } = await call(true)
  // 护栏：正文里出现了"只在记忆里、不在原话里"的专有名词 → 去掉记忆重写一次
  let guard = null
  // 只拦"记忆里独有"的名称：对话上下文与屏幕里出现过的名字属于合理语境，不拦
  const leaked = novelTerms(draft, ctx.memoryText).filter(
    (t) => !ctx.otherText.includes(t) && String(json?.polished ?? '').includes(t),
  )
  if (leaked.length && ctx.memoryText) {
    const retry = await call(false)
    if (retry.json?.polished) {
      json = retry.json
      usage = retry.usage
      guard = { reason: 'memory-nouns-stripped', leaked }
      json.assumptions = [...(json.assumptions ?? []), domainText('polish.omittedNames', leaked.join(languageText('、', ', ')))]
    }
  }

  const polished = clip(String(json?.polished ?? '').trim(), 4000)
  const result = {
    ok: Boolean(polished),
    mode,
    modeLabel: spec.label,
    original: draft,
    polished: polished || draft,
    intent: clip(String(json?.intent ?? '').trim(), 200),
    gaps: Array.isArray(json?.gaps) ? json.gaps.slice(0, 6).map((g) => clip(String(g), 120)) : [],
    assumptions: Array.isArray(json?.assumptions) ? json.assumptions.slice(0, 6).map((a) => clip(String(a), 160)) : [],
    notes: clip(String(json?.notes ?? '').trim(), 240),
    usage,
    ms: Date.now() - started,
    changed: polished !== draft,
    contextChars: ctx.text.length,
    guard,
  }
  if (!polished) result.error = domainText('polish.noResult')
  record({ kind: 'polish', mode, ms: result.ms, ok: result.ok, changed: result.changed, chars: draft.length })
  return result
}