import dns from 'node:dns/promises'
import net from 'node:net'
import path from 'node:path'
import { decodeEntities, stripTags, clip, readJSON, writeJSON } from './util.mjs'
import { DATA } from './config.mjs'
import { log } from './log.mjs'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// 搜索引擎的 WAF 会用"缺浏览器头"来判定机器人（360 会 302 到 qcaptcha），
// 所以这里发一套完整的导航请求头，而不是只带 UA。
const BROWSER_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
  'sec-ch-ua': '"Chromium";v="126", "Not:A-Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

const v4Private = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
]

// 198.18.0.0/15 (RFC2544 benchmark) is what Surge/Clash TUN hands out as fake-IPs
// for ordinary public domains on this machine, so it must stay reachable.

function ipToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    n = n * 256 + octet
  }
  return n
}

function inV4Cidr(ip, [cidr, bits]) {
  const a = ipToInt(ip)
  const b = ipToInt(cidr)
  if (a === null || b === null) return false
  const mask = bits <= 0 ? 0 : (((0xffffffff << (32 - bits)) >>> 0))
  return (a & mask) === (b & mask)
}

function parseV6(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '')
  const dotted = /(.*?:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (dotted) {
    const p = dotted[2].split('.').map(Number)
    s = `${dotted[1].replace(/:$/, '')}:${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`
  }
  const sides = s.split('::')
  if (sides.length > 2) return null
  const head = sides[0] ? sides[0].split(':').filter(Boolean) : []
  if (sides.length === 1) {
    if (head.length !== 8) return null
    return head.map((h) => parseInt(h, 16))
  }
  const tail = sides[1] ? sides[1].split(':').filter(Boolean) : []
  const gap = 8 - head.length - tail.length
  if (gap < 0) return null
  return [...head, ...Array(gap).fill('0'), ...tail].map((h) => parseInt(h, 16))
}

const dottedFrom = (hi, lo) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')

function embeddedV4(groups) {
  if (!groups) return null
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return dottedFrom(g6, g7)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return dottedFrom(g6, g7)
  if (g0 === 0x2002) return dottedFrom(g1, g2)
  return null
}

export function isPrivateAddress(ip) {
  const kind = net.isIP(String(ip).replace(/^\[|\]$/g, ''))
  if (!kind) return true
  if (kind === 4) return v4Private.some((range) => inV4Cidr(ip, range))
  const groups = parseV6(ip)
  if (!groups) return true
  const embedded = embeddedV4(groups)
  if (embedded && v4Private.some((range) => inV4Cidr(embedded, range))) return true
  const hex = groups.map((g) => g.toString(16).padStart(4, '0')).join(':')
  if (hex === '0000:0000:0000:0000:0000:0000:0000:0000' || hex === '0000:0000:0000:0000:0000:0000:0000:0001') return true
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true
  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return true
  return false
}

const BLOCKED_HOST_RE = /^(localhost|.*\.(localhost|local|internal|intr|lan|home)$)/i

async function assertPublicUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`URL 无法解析: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的协议: ${url.protocol}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (BLOCKED_HOST_RE.test(host)) throw new Error(`禁止访问内网地址: ${host}`)
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`禁止访问内网地址: ${host}`)
    return url
  }
  let records = []
  try {
    records = await Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])])
  } catch {
    throw new Error(`域名解析失败: ${host}`)
  }
  const addrs = records.flat()
  if (!addrs.length) throw new Error(`域名无解析结果: ${host}`)
  for (const addr of addrs) if (isPrivateAddress(addr)) throw new Error(`域名解析到内网地址: ${host} → ${addr}`)
  return url
}

async function get(urlStr, { timeoutMs = 15000, headers = {}, maxRedirects = 4 } = {}) {
  let current = await assertPublicUrl(urlStr)
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current.toString(), {
      headers: { ...BROWSER_HEADERS, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) return res
      const next = new URL(loc, current).toString()
      // 被判定为机器人时会被踢到验证码页，直接给出可读错误（并让上层熔断该引擎）
      if (/captcha|verify|antispider|访问异常/i.test(next)) {
        const e = new Error(`被要求人机校验（${new URL(next).host}）`)
        e.blocked = true
        throw e
      }
      current = await assertPublicUrl(next)
      continue
    }
    return res
  }
  throw new Error('重定向次数过多')
}

const CAPTCHA_RE = /访问异常|安全验证|请输入验证码|antispider|robot check|unusual traffic/i

function assertNotCaptcha(html, label) {
  if (CAPTCHA_RE.test(String(html).slice(0, 4000))) {
    const e = new Error(`${label} 触发了人机校验`)
    e.blocked = true
    throw e
  }
}

/* ---------------------------------- search --------------------------------- */

const clean = (s) => stripTags(s).replace(/\s+/g, ' ').trim()

const ENGINES = {
  so360: {
    label: '360',
    url: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}&src=sug`,
    parse(html) {
      const out = []
      for (const block of String(html).split(/<li class="res-list"/).slice(1)) {
        const a = /<h3[^>]*>\s*<a([^>]*?)>([\s\S]*?)<\/a>/.exec(block)
        if (!a) continue
        const href = /href="([^"]+)"/.exec(a[1])?.[1]
        // data-mdurl carries the real destination; so.com href is a JS redirect
        const mdurl = /data-mdurl="([^"]+)"/.exec(a[1])?.[1]
        const url = mdurl ?? href
        if (!url || !/^https?:\/\//.test(decodeEntities(url))) continue
        const snip = /<p class="(?:res-desc|res-abstract)"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]
        out.push({ title: clean(a[2]), url: decodeEntities(url), snippet: clean(snip ?? '').slice(0, 300) })
        if (out.length >= 10) break
      }
      return out
    },
  },
  bing: {
    label: 'Bing',
    url: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&FORM=QBLH&mkt=zh-CN`,
    parse(html) {
      const out = []
      for (const block of String(html).split(/<li class="b_algo"/i).slice(1)) {
        const href = /<a[^>]+href="(https?:\/\/[^"]+?)"/i.exec(block)
        const title = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
        if (!href || !title) continue
        const snippet = clean(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? '').replace(/^\d+\s*(分钟|小时|天|周)前\s*·?\s*/, '')
        out.push({ title: clean(title[1]), url: decodeEntities(href[1]), snippet: snippet.slice(0, 300) })
        if (out.length >= 10) break
      }
      return out
    },
  },
}

export const FAST_ENGINES = ['so360', 'bing']
const ENGINE_STATE = path.join(DATA, 'memory', 'engines.json')
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000
const FAIL_COOLDOWN_MS = 5 * 60 * 1000
const FAIL_THRESHOLD = 3

/** 熔断状态：被验证码拦下或连续失败的引擎先冷静一会儿，别继续撞墙。 */
async function loadEngineState() {
  return (await readJSON(ENGINE_STATE, null)) ?? { engines: {} }
}

async function saveEngineState(state) {
  await writeJSON(ENGINE_STATE, state)
}

export async function engineStatus() {
  const { engines } = await loadEngineState()
  const now = Date.now()
  return Object.fromEntries(
    Object.entries(engines).map(([k, v]) => [
      k,
      {
        fails: v.fails ?? 0,
        coolingDown: (v.blockedUntil ?? 0) > now,
        cooldownSeconds: Math.max(0, Math.round(((v.blockedUntil ?? 0) - now) / 1000)),
        lastOkAt: v.lastOkAt ?? null,
        lastError: v.lastError ?? null,
      },
    ]),
  )
}

async function markEngine(engine, patch) {
  const state = await loadEngineState()
  state.engines[engine] = { ...(state.engines[engine] ?? {}), ...patch }
  await saveEngineState(state)
}

function hostOf(u) {
  try {
    return new URL(u).hostname
  } catch {
    return u
  }
}

export async function searchWith(engine, query, { count = 6 } = {}) {
  const spec = ENGINES[engine]
  if (!spec) throw new Error(`未知搜索引擎: ${engine}`)
  const state = await loadEngineState()
  const until = state.engines?.[engine]?.blockedUntil ?? 0
  if (until > Date.now()) {
    const e = new Error(`${spec.label} 冷却中（还需 ${Math.ceil((until - Date.now()) / 1000)}s）`)
    e.coolingDown = true
    throw e
  }
  try {
    const res = await get(spec.url(query), { timeoutMs: 12000 })
    if (!res.ok) throw new Error(`${spec.label} HTTP ${res.status}`)
    const html = await res.text()
    assertNotCaptcha(html, spec.label)
    const results = spec.parse(html).slice(0, count)
    if (!results.length) throw new Error(`${spec.label} 没有解析到结果（可能被限流或改版）`)
    await markEngine(engine, { fails: 0, blockedUntil: 0, lastOkAt: new Date().toISOString(), lastError: null })
    return { query, engine: spec.label, results, at: new Date().toISOString() }
  } catch (err) {
    const state2 = await loadEngineState()
    const fails = (state2.engines?.[engine]?.fails ?? 0) + 1
    const cooldown = err.blocked ? BLOCK_COOLDOWN_MS : fails >= FAIL_THRESHOLD ? FAIL_COOLDOWN_MS : 0
    await markEngine(engine, {
      fails,
      lastError: err.message.slice(0, 120),
      blockedUntil: cooldown ? Date.now() + cooldown : 0,
      lastBlockedAt: err.blocked ? new Date().toISOString() : state2.engines?.[engine]?.lastBlockedAt ?? null,
    })
    if (cooldown) log.warn(`${spec.label} ${err.blocked ? '被人机校验拦截' : `连续失败 ${fails} 次`}，冷却 ${Math.round(cooldown / 1000)}s`)
    throw err
  }
}

/** Fast engines in parallel; first one with usable results wins. 全挂则短延迟重试一轮。 */
export async function webSearch(query, { count = 6, engines = FAST_ENGINES, retry = true } = {}) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('搜索词为空')
  const errors = []
  for (const round of retry ? [1, 2] : [1]) {
    const settled = await Promise.allSettled(engines.map((e) => searchWith(e, q, { count })))
    for (const s of settled) if (s.status === 'fulfilled') return s.value
    errors.push(
      ...settled
        .map((s) => (s.status === 'rejected' ? s.reason?.message : ''))
        .filter(Boolean),
    )
    const allCooling = settled.every((s) => s.status === 'rejected' && s.reason?.coolingDown)
    if (allCooling) break // 都在冷却就别等了，交给兜底
    if (round === 1) await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(errors[0] ?? '搜索引擎都不可用')
}

/**
 * 搜索的唯一入口（聊天工具与诊断接口共用）：先快后兜底，谁成用谁。
 * provider: auto | fast | native
 */
export async function searchWithFallback({ query, cfg, count, nativeSearch }) {
  const provider = cfg?.search?.provider ?? 'auto'
  const attempts = provider === 'native' ? ['native'] : provider === 'fast' ? ['fast'] : ['fast', 'native']
  let lastError
  const log = []
  for (const which of attempts) {
    const t0 = Date.now()
    try {
      if (which === 'fast') {
        const r = await webSearch(query, { count: count ?? cfg?.search?.maxResults ?? 6 })
        if (r.results?.length) return { ...r, provider: `${r.engine} 抓取`, ms: Date.now() - t0, attempts: log }
        lastError = '抓取没有结果'
      } else {
        if (!nativeSearch) throw new Error('未配置托管搜索')
        const r = await nativeSearch(query, { model: cfg?.upstream?.utilityModel })
        if (!r.sources?.length && !r.answer) throw new Error('托管搜索没有返回')
        return {
          query,
          engine: '阿里云托管搜索',
          provider: '阿里云 Responses web_search',
          answer: r.answer,
          results: (r.sources ?? []).map((s) => ({ title: s.title || hostOf(s.url), url: s.url, snippet: '' })),
          ms: Date.now() - t0,
          attempts: log,
        }
      }
    } catch (err) {
      lastError = err.message
      log.push({ engine: which, ok: false, ms: Date.now() - t0, error: err.message.slice(0, 120) })
    }
  }
  const e = new Error(lastError ?? '搜索失败')
  e.attempts = log
  throw e
}

/* ---------------------------------- fetch ---------------------------------- */

function htmlToText(html) {
  let src = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|video|audio|form|nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' ')
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? '')
  src = src
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(src)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1)
    .join('\n')
  return { title, text }
}

export async function webFetch(url, { maxChars = 12000 } = {}) {
  const res = await get(url, { timeoutMs: 20000 })
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`)
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (/image\/|pdf|octet-stream|video\/|audio\//.test(type)) {
    return { url, skipped: true, note: `该地址是二进制资源（${type.split(';')[0]}），无法直接读取正文，请换用 HTML 页面` }
  }
  if (!/html|text|json|xml/.test(type)) return { url, skipped: true, note: `不支持的内容类型: ${type || '未知'}` }
  const body = await res.text()
  const { title, text } = htmlToText(body)
  return {
    url: res.url || url,
    title,
    content: clip(text, maxChars),
    truncated: text.length > maxChars,
    totalChars: text.length,
  }
}
