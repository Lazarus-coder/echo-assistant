import dns from 'node:dns/promises'
import net from 'node:net'
import { decodeEntities, stripTags, clip } from './util.mjs'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) return res
      current = await assertPublicUrl(new URL(loc, current).toString())
      continue
    }
    return res
  }
  throw new Error('重定向次数过多')
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

export async function searchWith(engine, query, { count = 6 } = {}) {
  const spec = ENGINES[engine]
  if (!spec) throw new Error(`未知搜索引擎: ${engine}`)
  const res = await get(spec.url(query), { timeoutMs: 12000 })
  if (!res.ok) throw new Error(`${spec.label} HTTP ${res.status}`)
  const results = spec.parse(await res.text()).slice(0, count)
  if (!results.length) throw new Error(`${spec.label} 没有解析到结果（可能被限流或改版）`)
  return { query, engine: spec.label, results, at: new Date().toISOString() }
}

/** Fast engines in parallel; first one with usable results wins. */
export async function webSearch(query, { count = 6, engines = FAST_ENGINES } = {}) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('搜索词为空')
  const settled = await Promise.allSettled(engines.map((e) => searchWith(e, q, { count })))
  for (const s of settled) if (s.status === 'fulfilled') return s.value
  const errors = settled.map((s) => (s.status === 'rejected' ? s.reason?.message : '')).filter(Boolean)
  throw new Error(errors[0] ?? '搜索引擎都不可用')
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
