import dns from 'node:dns/promises'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeEntities, stripTags, clip, readJSON, writeJSON } from './util.mjs'
import { DATA } from './config.mjs'
import { SEARCH_PROVIDERS, DEFAULT_SEARCH_ORDER, providerStatus } from './providers.mjs'
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

async function assertPublicUrl(rawUrl, signal) {
  signal?.throwIfAborted()
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
  const resolver = new dns.Resolver()
  const cancel = () => resolver.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    signal?.throwIfAborted()
    records = await Promise.all([resolver.resolve4(host).catch(() => []), resolver.resolve6(host).catch(() => [])])
    signal?.throwIfAborted()
  } catch {
    signal?.throwIfAborted()
    throw new Error(`域名解析失败: ${host}`)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
  const addrs = records.flat()
  if (!addrs.length) throw new Error(`域名无解析结果: ${host}`)
  for (const addr of addrs) if (isPrivateAddress(addr)) throw new Error(`域名解析到内网地址: ${host} → ${addr}`)
  return url
}

async function get(urlStr, { timeoutMs = 15000, headers = {}, maxRedirects = 4, signal } = {}) {
  let current = await assertPublicUrl(urlStr, signal)
  for (let hop = 0; hop <= maxRedirects; hop++) {
    signal?.throwIfAborted()
    const res = await fetch(current.toString(), {
      headers: { ...BROWSER_HEADERS, ...headers },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    signal?.throwIfAborted()
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) return res
      await res.body?.cancel().catch(() => {})
      if (maxRedirects === 0) {
        throw new Error('授权网页发生重定向，请在目标来源中填写最终网页地址')
      }
      const next = new URL(loc, current).toString()
      // 被判定为机器人时会被踢到验证码页，直接给出可读错误（并让上层熔断该引擎）
      if (/captcha|verify|antispider|访问异常/i.test(next)) {
        const e = new Error(`被要求人机校验（${new URL(next).host}）`)
        e.blocked = true
        throw e
      }
      current = await assertPublicUrl(next, signal)
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

export async function searchWith(engine, query, { count = 6, signal } = {}) {
  signal?.throwIfAborted()
  const spec = ENGINES[engine]
  if (!spec) throw new Error(`未知搜索引擎: ${engine}`)
  const state = await loadEngineState()
  signal?.throwIfAborted()
  const until = state.engines?.[engine]?.blockedUntil ?? 0
  if (until > Date.now()) {
    const e = new Error(`${spec.label} 冷却中（还需 ${Math.ceil((until - Date.now()) / 1000)}s）`)
    e.coolingDown = true
    throw e
  }
  try {
    const res = await get(spec.url(query), { timeoutMs: 12000, signal })
    if (!res.ok) throw new Error(`${spec.label} HTTP ${res.status}`)
    const html = await res.text()
    signal?.throwIfAborted()
    assertNotCaptcha(html, spec.label)
    const results = spec.parse(html).slice(0, count)
    if (!results.length) throw new Error(`${spec.label} 没有解析到结果（可能被限流或改版）`)
    await markEngine(engine, { fails: 0, blockedUntil: 0, lastOkAt: new Date().toISOString(), lastError: null })
    return { query, engine: spec.label, results, at: new Date().toISOString() }
  } catch (err) {
    signal?.throwIfAborted()
    if (err?.name === 'AbortError') throw err
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
export async function webSearch(query, { count = 6, engines = FAST_ENGINES, retry = true, signal } = {}) {
  signal?.throwIfAborted()
  const q = String(query ?? '').trim()
  if (!q) throw new Error('搜索词为空')
  const errors = []
  for (const round of retry ? [1, 2] : [1]) {
    const settled = await Promise.allSettled(engines.map((e) => searchWith(e, q, { count, signal })))
    signal?.throwIfAborted()
    const aborted = settled.find((result) => result.status === 'rejected' && result.reason?.name === 'AbortError')
    if (aborted) throw aborted.reason
    for (const s of settled) if (s.status === 'fulfilled') return s.value
    errors.push(
      ...settled
        .map((s) => (s.status === 'rejected' ? s.reason?.message : ''))
        .filter(Boolean),
    )
    const allCooling = settled.every((s) => s.status === 'rejected' && s.reason?.coolingDown)
    if (allCooling) break // 都在冷却就别等了，交给兜底
    if (round === 1) await delay(500, undefined, { signal })
  }
  throw new Error(errors[0] ?? '搜索引擎都不可用')
}

/* ------------------------- 可插拔的搜索提供方 ------------------------------ */

const envRef = (v) => (typeof v === 'string' && v.startsWith('env:') ? process.env[v.slice(4)] ?? '' : v)

function resolveHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, envRef(v)]))
}

const firstOf = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => typeof v === 'string' && v) ?? ''

function normalizeResults(list = []) {
  return list
    .map((r) => ({
      title: firstOf(r, ['title', 'name', 'heading']),
      url: firstOf(r, ['url', 'link', 'href']),
      snippet: (firstOf(r, ['snippet', 'content', 'description', 'summary', 'text']) || '').slice(0, 400),
    }))
    .filter((r) => r.url)
}

/** 走第三方 HTTP 搜索 API（tavily / brave / bocha / searxng / custom）。 */
async function searchViaHttpProvider(id, query, { cfg, count = 6, signal }) {
  signal?.throwIfAborted()
  const spec = SEARCH_PROVIDERS[id]
  const conf = cfg?.search?.providers?.[id] ?? {}
  const key = process.env[conf.envVar ?? spec.envVar] || ''
  const endpoint = conf.endpoint || spec.endpoint
  const timeout = conf.timeoutMs ?? 20000
  const req = (url, init) => fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) })

  if (id === 'tavily') {
    if (!key) throw new Error('缺少 TAVILY_API_KEY')
    const res = await req(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: count, search_depth: 'basic', include_answer: true }),
    })
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)
    const j = await res.json()
    return { results: normalizeResults(j.results ?? []).slice(0, count), answer: j.answer ?? '', provider: spec.label }
  }

  if (id === 'brave') {
    if (!key) throw new Error('缺少 BRAVE_API_KEY')
    const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${count}`
    const res = await req(url, { headers: { accept: 'application/json', 'x-subscription-token': key } })
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`)
    const j = await res.json()
    return { results: normalizeResults(j.web?.results ?? []).slice(0, count), provider: spec.label }
  }

  if (id === 'bocha') {
    if (!key) throw new Error('缺少 BOCHA_API_KEY')
    const res = await req(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, count, summary: true }),
    })
    if (!res.ok) throw new Error(`博查 HTTP ${res.status}`)
    const j = await res.json()
    const pages = j?.data?.webPages?.value ?? j?.data?.pages ?? j?.webPages?.value ?? []
    return { results: normalizeResults(pages).slice(0, count), provider: spec.label }
  }

  if (id === 'searxng') {
    const base = conf.endpoint || process.env.SEARXNG_URL || ''
    if (!/^https?:\/\//.test(base)) throw new Error('缺少 SearXNG 实例地址（SEARXNG_URL）')
    const sep = base.includes('?') ? '&' : '?'
    const res = await req(`${base.replace(/\/+$/, '')}/search${sep}q=${encodeURIComponent(query)}&format=json&language=zh-CN`)
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`)
    const j = await res.json()
    return { results: normalizeResults(j.results ?? []).slice(0, count), provider: spec.label }
  }

  if (id === 'custom') {
    if (!conf.endpoint) throw new Error('自定义搜索未配置 endpoint')
    const method = (conf.method ?? 'POST').toUpperCase()
    const headers = { accept: 'application/json', ...resolveHeaders(conf.headers ?? {}) }
    const init = { method, headers }
    if (method !== 'GET') {
      headers['content-type'] = headers['content-type'] ?? 'application/json'
      init.body = JSON.stringify(conf.bodyTemplate ? JSON.parse(JSON.stringify(conf.bodyTemplate).replace(/\{\{query\}\}/g, JSON.stringify(query).slice(1, -1)).replace(/\{\{count\}\}/g, String(count))) : { query, count })
    }
    const res = await req(method === 'GET' ? `${conf.endpoint}${conf.endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}` : conf.endpoint, init)
    if (!res.ok) throw new Error(`自定义搜索 HTTP ${res.status}`)
    const j = await res.json()
    const list = Array.isArray(j) ? j : j.results ?? j.data ?? []
    return { results: normalizeResults(list).slice(0, count), provider: spec.label }
  }

  throw new Error(`未知搜索提供方: ${id}`)
}

/**
 * 搜索的唯一入口（聊天工具与诊断接口共用）：按 cfg.search.order 依次尝试。
 * none 表示明确不联网；scrape 与 gateway 是零配置路径；其余需要各自的 key/地址。
 */
export async function searchWithFallback({ query, cfg, count, nativeSearch, signal }) {
  signal?.throwIfAborted()
  const order = Array.isArray(cfg?.search?.order) && cfg.search.order.length ? cfg.search.order : DEFAULT_SEARCH_ORDER
  const attempts = []
  let lastError
  for (const id of order) {
    signal?.throwIfAborted()
    if (id === 'none') {
      attempts.push({ engine: 'none', ok: false, error: '按配置不联网' })
      lastError = lastError ?? '按配置不联网'
      continue
    }
    const spec = SEARCH_PROVIDERS[id]
    if (!spec) {
      attempts.push({ engine: id, ok: false, error: '未知提供方' })
      continue
    }
    const st = providerStatus(id, cfg)
    if (!st.ready) {
      attempts.push({ engine: id, ok: false, error: st.reason })
      lastError = lastError ?? st.reason
      continue
    }
    const t0 = Date.now()
    try {
      let out
      if (id === 'scrape') {
        const r = await webSearch(query, { count: count ?? cfg?.search?.maxResults ?? 6, signal })
        out = { query, engine: `${r.engine} 抓取`, results: r.results, provider: 'scrape' }
      } else if (id === 'gateway') {
        if (!nativeSearch) throw new Error('未配置托管搜索')
        const r = await nativeSearch(query, { model: cfg?.upstream?.utilityModel || cfg?.upstream?.defaultModel, signal })
        if (!r.sources?.length && !r.answer) throw new Error('托管搜索没有返回')
        out = {
          query,
          engine: '网关托管搜索',
          provider: 'gateway',
          answer: r.answer,
          results: (r.sources ?? []).map((s) => ({ title: s.title || hostOf(s.url), url: s.url, snippet: '' })),
        }
      } else {
        const r = await searchViaHttpProvider(id, query, { cfg, count, signal })
        out = { query, engine: r.provider, provider: id, results: r.results, answer: r.answer }
      }
      signal?.throwIfAborted()
      if (!out.results?.length && !out.answer) throw new Error('没有结果')
      attempts.push({ engine: id, ok: true, ms: Date.now() - t0, results: out.results?.length ?? 0 })
      return { ...out, ms: Date.now() - t0, attempts }
    } catch (err) {
      signal?.throwIfAborted()
      if (err?.name === 'AbortError') throw err
      lastError = err.message
      attempts.push({ engine: id, ok: false, ms: Date.now() - t0, error: err.message.slice(0, 120) })
    }
  }
  const e = new Error(lastError ?? '搜索失败')
  e.attempts = attempts
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

export async function webFetch(url, { maxChars = 12000, allowRedirects = true, maxBytes = 2 * 1024 * 1024, signal } = {}) {
  signal?.throwIfAborted()
  const res = await get(url, { timeoutMs: 20000, maxRedirects: allowRedirects ? 4 : 0, signal })
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`)
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (/image\/|pdf|octet-stream|video\/|audio\//.test(type)) {
    await res.body?.cancel().catch(() => {})
    return { url, skipped: true, note: `该地址是二进制资源（${type.split(';')[0]}），无法直接读取正文，请换用 HTML 页面` }
  }
  if (!/html|text|json|xml/.test(type)) {
    await res.body?.cancel().catch(() => {})
    return { url, skipped: true, note: `不支持的内容类型: ${type || '未知'}` }
  }
  const reader = res.body?.getReader()
  const chunks = []
  let bytes = 0
  if (reader) {
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) throw new Error('网页超过读取大小预算，请选择更小的来源')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  signal?.throwIfAborted()
  const body = Buffer.concat(chunks).toString('utf8')
  const { title, text } = htmlToText(body)
  return {
    url: res.url || url,
    title,
    content: clip(text, maxChars),
    contentHash: createHash('sha256').update(text).digest('hex'),
    truncated: text.length > maxChars,
    totalChars: text.length,
  }
}
