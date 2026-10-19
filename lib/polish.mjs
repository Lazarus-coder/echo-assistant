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
    label: '细化',
    note: '补全隐含要素、把粒度说到可执行（默认）',
    instruction:
      '把请求补全到"可直接执行"的粒度：补齐对象、范围、格式、约束、时间、数量等缺失要素；隐含的前提显式写出来。',
  },
  polish: {
    label: '保守',
    note: '只顺语句与错别字，不新增要素',
    instruction: '只做语序、断句、错别字的修正，尽量保持原句结构与信息量不变——不要新增任何要素。',
  },
  tighten: {
    label: '精简',
    note: '压到最必要，约束一个不丢',
    instruction: '压到最必要的长度，删掉冗余与客套，但**所有约束与限定都不能丢**。',
  },
}

const SYSTEM = `你在为一个私人助手做「提示词补齐」。用户输入框里的话往往很短、省主语、缺细节，你要读上下文，猜准他想要什么，把它写成一条粒度合适的请求。

按这个顺序推理（推理过程不要输出，只输出最后的 JSON）：
1. 意图：他到底想达成什么结果？一句话。
2. 缺口：这句话缺了哪些要素？(对象 / 范围 / 格式 / 约束 / 时间 / 数量 / 受众)
3. 推断：每个缺口最可能是什么？只在上下文有依据时推断；没有依据的走"最小假设"，并写进 assumptions。
4. 落笔：写出一条可以直接发送的请求。

硬规则：
- 保留用户的语言（中文就用中文）和语气：他随口说就别端着，他正式就别口语化。
- 绝不编造事实：数字、人名、需求、期限，凡是他没表达、也不可从上下文推断的，一律不写。
- 不写"请帮我""麻烦你"这类客套开头；不用 markdown 标题；polished 控制在一段话内。
- 真的无法推断时，用"（可选：A / B）"这种括注把选择权留给他，而不是替他决定。
- **输入过于模糊（连核心对象都没有）时，不要用记忆里的内容替它补出对象**：改为把问题问清楚（例："帮我看一下——具体看什么？把对象或目标补一句就行"），并把该缺口写进 gaps。
- **记忆里的专有名词（项目名/文件名/人名）只能出现在 assumptions 里，不能写进 polished 正文**——除非用户原话里就出现过它。正文里要么用他原话里的说法（"那个部署脚本"），要么把对象作为问题问出来。
- 原话已经足够清楚时，polished 就基本等于原文——不要为了显得有用而改写。
- 上下文只用于理解意图，不要把上下文里的内容搬进 polished（除非他已经提到）。

只输出 JSON：{"intent":"","gaps":[""],"assumptions":[""],"polished":"","notes":""}`

// 泛化名词不算"提到了"：否则"脚本/项目/报告"这种词会把记忆里无关的具体项目名带进来，
// 模型就可能替用户编出一个他没说过的对象（实测踩过两次）
const GENERIC = new Set(['脚本', '项目', '文件', '文档', '报告', '代码', '更新', '内容', '问题', '东西', '事情', '那个', '这个', '一个', '帮我', '看看', '整理', '部署'])

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
    if (!d.toLowerCase().includes(w.toLowerCase())) terms.add(w)
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
        `<对话上下文：${conv.title || '未命名'}>`,
        ...tail.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${clip(String(m.content ?? '').replace(/\s+/g, ' '), 200)}`),
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
      if (relevant.length) parts.push('<相关记忆（仅在用户确实提到时才引用）>', ...relevant.map((f) => `- ${f.text}`))
    }
  } catch {}
  try {
    if (cfg.screen?.enabled) {
      const now = await workingContext({ minutes: 30 })
      if (now.text) {
        const block = `<此刻在做什么>\n${now.app ?? ''}${now.activity ? `｜${now.activity}` : ''}`
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
    const e = new Error('输入框是空的，没什么可润色')
    e.status = 400
    throw e
  }
  if (draft.length > 4000) {
    const e = new Error('这段太长了（>4000 字），先拆开再说')
    e.status = 400
    throw e
  }
  const spec = MODES[mode] ?? MODES.expand
  const started = Date.now()
  const call = async (includeMemory) => {
    const ctx = await buildContext({ conversationId, text: draft, cfg, includeMemory })
    const out = await jsonTask({
      system: `${SYSTEM}\n\n本次模式：${spec.label} —— ${spec.instruction}`,
      user: [ctx.text || '<没有额外上下文>', '', '<用户输入框里的原话>', draft].join('\n'),
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
      json.assumptions = [...(json.assumptions ?? []), `已忽略记忆里的名称：${leaked.join('、')}`]
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
  if (!polished) result.error = '模型没有给出结果，原样返回'
  record({ kind: 'polish', mode, ms: result.ms, ok: result.ok, changed: result.changed, chars: draft.length })
  return result
}