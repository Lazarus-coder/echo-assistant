import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { loadConfig, saveConfig, upstreamCreds, deepMerge, P, DATA, ROOT } from './lib/config.mjs'
import { loadEnvFile } from './lib/env.mjs'
import { log } from './lib/log.mjs'
import { readJSON, writeJSON, nowIso, clip, assertId, newId } from './lib/util.mjs'
import {
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  patchConversation,
  saveConversation,
  exportMarkdown,
  truncateFrom,
  mutateState,
  MAIN_ID,
  readState,
} from './lib/store.mjs'
import { runTurn } from './lib/chat.mjs'
import { maybeDigest, updateDigest, estimateTokens } from './lib/context.mjs'
import { buildGraph, graphStats, queryGraph, entitySummary } from './lib/graph.mjs'
import { McpHub } from './lib/mcp.mjs'
import {
  ensureCore,
  loadCore,
  saveCore,
  listObservations,
  memoryStats,
  extractMemory,
  retrieve,
  deleteObservation,
  appendObservation,
  forgetScan,
  forgetById,
  setProtected,
  recallForgetting,
  readForgettingLog,
  strengthOf,
  logForgetting,
} from './lib/memory.mjs'
import { runDream, dreamStatus, dreamRunning, updateLoop } from './lib/dream.mjs'
import { proactiveTick, proactiveStatus, recordUserEngagement } from './lib/proactive.mjs'
import { applyFeedback, agencyStats, settlePending } from './lib/agency.mjs'
import { webSearch, searchWithFallback, engineStatus } from './lib/search.mjs'
import { nativeSearch } from './lib/native.mjs'
import { generateImage, saveImage, parseDataUrl } from './lib/media.mjs'
import {
  ingestScreenEvent,
  screenStatus,
  setScreenConfig,
  requestCapture,
  markCaptureHandled,
  digestScreenSession,
  pruneScreenData,
  workingContext,
} from './lib/screen.mjs'
import { pruneStorage, storageStats, sweepTempCaptures, ensureStorageDirs } from './lib/storage.mjs'
import { record, metricsSummary } from './lib/metrics.mjs'
import { polishText, MODES } from './lib/polish.mjs'
import { ingestFrame, companionStatus, pendingBubbles, setCompanion, openBubble, dismissBubble } from './lib/companion.mjs'
import {
  UPSTREAM_PRESETS,
  MEMORY_PROFILES,
  DEFAULT_SEARCH_ORDER,
  searchProviderCatalog,
  memoryProfileValues,
} from './lib/providers.mjs'

// 版本号只有一个来源：package.json（自测里有一条断言禁止两边漂移）
const VERSION = await (async () => {
  try {
    const raw = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
    return JSON.parse(raw).version || '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
})()
const COOKIE = 'echo_s'
const MAX_BODY = 1.5 * 1024 * 1024

/* ---------------------------------- auth ----------------------------------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPassword(password, { salt, hash }) {
  try {
    const candidate = crypto.scryptSync(String(password ?? ''), salt, 64)
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

async function setPassword(password) {
  const auth = await readJSON(P.auth, {})
  auth.password = hashPassword(password)
  auth.setAt = nowIso()
  await writeJSON(P.auth, auth)
  authState.passwordSet = true
  return auth
}

async function authed(req) {
  const auth = await readJSON(P.auth, {})
  const localSecret = await ensureLocalToken()
  const headers = req.headers
  if (headers['x-echo-local'] === localSecret && isLoopback(req)) return { via: 'local' }
  const cookie = parseCookies(headers.cookie ?? '')[COOKIE]
  if (!cookie) return null
  const digest = crypto.createHash('sha256').update(cookie).digest('hex')
  const session = auth.sessions?.[digest]
  if (!session) return null
  if (Date.parse(session.expiresAt) < Date.now()) {
    delete auth.sessions[digest]
    await writeJSON(P.auth, auth)
    return null
  }
  return { via: 'cookie', session }
}

async function ensureLocalToken() {
  const file = path.join(DATA, 'local.token')
  try {
    return (await fs.readFile(file, 'utf8')).trim()
  } catch {
    const secret = crypto.randomBytes(24).toString('hex')
    await fs.mkdir(DATA, { recursive: true })
    await fs.writeFile(file, secret, { mode: 0o600 })
    return secret
  }
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function parseCookies(str) {
  const out = {}
  for (const part of String(str).split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

async function createSession(res) {
  const secret = crypto.randomBytes(24).toString('hex')
  const auth = await readJSON(P.auth, {})
  auth.sessions = auth.sessions ?? {}
  for (const [k, v] of Object.entries(auth.sessions)) if (Date.parse(v.expiresAt) < Date.now()) delete auth.sessions[k]
  auth.sessions[crypto.createHash('sha256').update(secret).digest('hex')] = { createdAt: nowIso(), expiresAt: new Date(Date.now() + 90 * 864e5).toISOString() }
  await writeJSON(P.auth, auth)
  res.setHeader('set-cookie', `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${90 * 86400}`)
}

const loginAttempts = new Map()
function rateLimited(ip) {
  const rec = loginAttempts.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > 5 * 60000) {
    loginAttempts.delete(ip)
    return false
  }
  return rec.count >= 10
}

/* -------------------------------- helpers ---------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(payload)
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
}

async function serveStatic(req, res, urlPath) {
  const map = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css',
    '/manifest.webmanifest': 'manifest.webmanifest',
    '/logo.svg': 'logo.svg',
    '/mini.html': 'mini.html',
    '/mini.js': 'mini.js',
  }
  const file = map[urlPath]
  if (!file) return send(res, 404, 'not found')
  const full = path.join(PUBLIC_DIR, file)
  try {
    const stat = await fs.stat(full)
    // 资源带上 mtime 版本号，避免浏览器拿到旧 JS/CSS（升级后无需手动清缓存）
    if (file === 'index.html') {
      let html = await fs.readFile(full, 'utf8')
      for (const asset of ['app.js', 'style.css', 'logo.svg', 'mini.js']) {
        const st = await fs.stat(path.join(PUBLIC_DIR, asset)).catch(() => null)
        if (st) html = html.replaceAll(`"/${asset}"`, `"/${asset}?v=${Math.round(st.mtimeMs)}"`)
      }
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    }
    const etag = `W/"${stat.mtimeMs}-${stat.size}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      return res.end()
    }
    const body = await fs.readFile(full)
    send(res, 200, body, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', etag, 'cache-control': 'no-cache' })
  } catch (err) {
    send(res, 500, `static error: ${err.message}`)
  }
}

const PUBLIC_DIR = path.join(ROOT, 'public')

/* --------------------------------- runtime --------------------------------- */

const inflight = new Map()
let mcp = new McpHub({})
let cfg = await loadConfig()
let bootedAt = Date.now()
let authState = { passwordSet: false }

async function refreshConfig() {
  cfg = await loadConfig()
  return cfg
}

async function connectMcp() {
  try {
    mcp.close()
  } catch {}
  mcp = new McpHub(cfg.mcpServers ?? {})
  if (Object.keys(cfg.mcpServers ?? {}).length) await mcp.connectAll()
  return mcp.status()
}

async function generateTitle(conversationId, userText, assistantText) {
  try {
    const { apiKey, baseUrl } = upstreamCreds()
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.upstream.utilityModel,
        messages: [
          { role: 'system', content: '给这段对话起一个 4-12 字的中文标题，只输出标题本身，不要引号、不要标点结尾。' },
          { role: 'user', content: `用户：${clip(userText, 600)}\n助手：${clip(assistantText, 400)}` },
        ],
        max_tokens: 40,
        temperature: 0.2,
        enable_thinking: false,
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return
    const data = await res.json()
    const title = String(data.choices?.[0]?.message?.content ?? '').trim().replace(/^["'「《]+|["'」》]+$/g, '').slice(0, 30)
    if (title) await patchConversation(conversationId, { title })
  } catch (err) {
    log.debug('标题生成失败', err.message)
  }
}

async function maybeExtractMemory(conv, assistant) {
  try {
    const user = [...conv.messages].reverse().find((m) => m.role === 'user')
    if (!user || user.proactive) return
    const out = await extractMemory({ userText: user.content, assistantText: assistant.content, cfg, source: conv.id })
    return out
  } catch (err) {
    log.warn('记忆抽取异常', err.message)
  }
}

/* ------------------------------ 引导与提供方 ------------------------------ */

function onboardingState() {
  const creds = upstreamCreds()
  const hasModels = (cfg.upstream?.models ?? []).length > 0
  // 已经能用（有端点+密钥+模型清单）就不打扰；否则把引导推上来
  const usable = creds.configured && hasModels
  return {
    needed: !usable && cfg.onboarding?.completed !== true,
    completed: cfg.onboarding?.completed === true,
    usable,
    hasKey: Boolean(creds.apiKey),
    hasBaseUrl: Boolean(creds.baseUrl),
    apiKeyEnv: creds.apiKeyEnv,
    baseUrlEnv: creds.baseUrlEnv,
    baseUrl: creds.baseUrl,
    modelCount: (cfg.upstream.models ?? []).length,
    searchOrder: cfg.search?.order ?? DEFAULT_SEARCH_ORDER,
    profile: cfg.memory?.profile ?? 'standard',
  }
}

/** 合并写入 data/echo.env（只动指定键，其它行原样保留），并立即生效。 */
/** 档位 → 具体配置：memoryProfileValues 给的是跨段补丁，必须在顶层合并。 */
function applyProfilePatch(patch, profileId) {
  const values = profileId ? memoryProfileValues(profileId) : null
  if (!values) return patch
  const { profile, ...rest } = values
  return deepMerge(deepMerge(patch, { memory: { profile } }), rest)
}

async function writeEnvValues(values) {
  const file = P.env
  let lines = []
  try {
    lines = (await fs.readFile(file, 'utf8')).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  } catch {}
  const keep = new Map()
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) keep.set(m[1], m[2])
  }
  let removed = 0
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v === undefined || v === null) continue
    if (String(v) === '') {
      // 显式清空 = 删除该密钥（界面不会发空值，只有明确的"清除"才会走到这）
      if (keep.delete(k)) removed++
      delete process.env[k]
      continue
    }
    keep.set(k, v)
    process.env[k] = v
  }
  if (removed) log.warn(`已从 echo.env 移除 ${removed} 个密钥`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${[...keep.entries()].map(([k, v]) => `${k}=${v}`).join('\n')}${keep.size ? '\n' : ''}`, { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => {})
  return [...keep.keys()]
}

/** BYOK 引导页第二步用：拿 key 去问端点有哪些模型。 */
async function discoverModels({ baseUrl, apiKey }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) throw new Error('端点地址要写成 https://… 的完整 URL')
  if (!apiKey) throw new Error('缺少 API Key')
  const res = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`端点返回 HTTP ${res.status}：${text.slice(0, 160)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('端点没有返回 JSON，请确认是 OpenAI 兼容的 /v1 地址')
  }
  const models = (data.data ?? data.models ?? []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
  return { baseUrl: base, count: models.length, models: models.slice(0, 400) }
}

async function permissionsReport() {
  const { apiKey, baseUrl } = upstreamCreds()
  const has = (cmd, args = ['--version']) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: 'ignore' })
      p.on('error', () => resolve(false))
      p.on('exit', (code) => resolve(code === 0))
    })
  const [swiftc, screencapture] = await Promise.all([
    has('/usr/bin/xcrun', ['--find', 'swiftc']),
    fs
      .access('/usr/sbin/screencapture')
      .then(() => true)
      .catch(() => false),
  ])
  return {
    node: process.version,
    platform: process.platform,
    port: Number(process.env.ECHO_PORT ?? cfg.port),
    bind: (process.env.ECHO_BIND ?? cfg.bind) === 'all' ? '0.0.0.0（局域网可访问）' : '127.0.0.1（仅本机）',
    lanAddresses: lanAddresses(),
    authRequired: cfg.requirePassword === true,
    configured: Boolean(apiKey && baseUrl),
    runningUnderLaunchd: process.ppid === 1 || Boolean(process.env.XPC_SERVICE_NAME),
    dataDir: DATA,
    tools: { swiftc, screencapture },
    notes: {
      screen: '屏幕感知需要「屏幕录制」权限：点状态栏图标里的授权项，或在 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 EchoBar。授权后重启状态栏图标。',
      swifts: swiftc ? '可以编译状态栏 App（./bin/echo up 用的是已编译好的 build/EchoBar）' : '没找到 swiftc：先装 Xcode Command Line Tools（xcode-select --install）再跑 ./install.sh',
      notifications: '主动消息用 osascript 发通知；首次可能需要在 系统设置 → 通知 里允许',
      persist: '常驻与开机自启用 ./install.sh 注册 launchd：com.echo.chat（服务）+ com.echo.menubar（图标）',
      store: '所有数据都在本机 data/ 目录：明文可读、可备份、可删除',
    },
  }
}

/** 屏幕录制权限探测：真抓一张（会触发系统弹窗），据此判断是否授权。 */
async function screenPermissionProbe() {
  const file = path.join(DATA, 'spool', `.perm-probe-${Date.now()}.jpg`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    const ok = await new Promise((resolve) => {
      const p = spawn('/usr/sbin/screencapture', ['-x', '-t', 'jpg', file], { stdio: 'ignore' })
      p.on('error', () => resolve(false))
      p.on('exit', (code) => resolve(code === 0))
    })
    const size = await fs.stat(file).then((s) => s.size).catch(() => 0)
    return {
      granted: ok && size > 2000,
      bytes: size,
      hint: ok && size > 2000 ? '已授权' : '未授权或抓不到画面：到 系统设置 → 隐私与安全性 → 屏幕录制 勾选 EchoBar（或你启动它的终端），然后重启状态栏图标',
    }
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

/* ---------------------------------- routes --------------------------------- */

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const method = req.method
  const authRequired = cfg.requirePassword === true
  const needsAuth = authRequired && !(method === 'GET' && seg[1] === 'health')
  let who = null
  if (needsAuth) {
    const auth = await readJSON(P.auth, {})
    if (!auth.password) {
      if (method === 'POST' && seg[1] === 'password') return setupPassword(req, res)
      return send(res, 401, { error: 'no_password', message: '还没有设置访问口令，请先设置' })
    }
    who = await authed(req)
    if (!who) {
      if (method === 'POST' && seg[1] === 'login') return doLogin(req, res)
      return send(res, 401, { error: 'unauthorized', message: '口令不正确或未登录' })
    }
    if (method !== 'GET' && req.headers['x-echo-request'] !== 'echo') {
      return send(res, 403, { error: 'csrf', message: '缺少 x-echo-request 头' })
    }
  } else if (method !== 'GET' && seg[1] !== 'login' && seg[1] !== 'password' && seg[1] !== 'logout' && req.headers['x-echo-request'] !== 'echo') {
    // 免登录也保留这一层：跨站网页无法伪造自定义头，也就打不到你的额度
    return send(res, 403, { error: 'csrf', message: '缺少 x-echo-request 头' })
  }

  const p = seg.slice(1).join('/')

  // 每次请求都对齐配置（loadConfig 带 mtime 缓存，代价是一次 stat）：
  // 这样 CLI、状态栏、别的接口改过配置后都立即生效
  cfg = await loadConfig()

  if (method === 'GET' && p === 'health') {
    return send(res, 200, { ok: true, version: VERSION, uptime: Math.round((Date.now() - bootedAt) / 1000) })
  }

  if (method === 'POST' && p === 'login') return doLogin(req, res)
  if (method === 'POST' && p === 'logout') {
    const auth = await readJSON(P.auth, {})
    const cookie = parseCookies(req.headers.cookie ?? '')[COOKIE]
    if (cookie) delete auth.sessions?.[crypto.createHash('sha256').update(cookie).digest('hex')]
    await writeJSON(P.auth, auth)
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
    return send(res, 200, { ok: true })
  }
  if (method === 'POST' && p === 'password') return changePassword(req, res, who)
  if (method === 'PATCH' && p === 'auth') {
    const body = await readBody(req)
    cfg = await saveConfig({ requirePassword: Boolean(body.required) })
    log.warn(`访问控制：${cfg.requirePassword ? '已开启口令验证' : '已关闭口令验证（仅本机自用）'}`)
    return send(res, 200, { required: cfg.requirePassword, passwordSet: authState.passwordSet })
  }

  if (method === 'GET' && p === 'bootstrap') {
    const conversations = await listConversations()
    return send(res, 200, {
      version: VERSION,
      config: publicConfig(cfg),
      conversations,
      main: conversations.find((c) => c.id === MAIN_ID) ?? null,
      memory: await memoryStats(),
      dream: await dreamStatus(),
      proactive: await proactiveStatus(),
      mcp: mcp.status(),
      upstream: upstreamReady(),
    })
  }

  if (method === 'GET' && p === 'summary') {
    const state = await readState()
    const main = await getConversation(MAIN_ID)
    const stats = await memoryStats()
    const [storage, screen] = await Promise.all([storageStats(), screenStatus({ includeEvents: 4 })])
    return send(res, 200, {
      ok: true,
      version: VERSION,
      busy: inflight.size,
      unread: main?.unread ?? 0,
      proactiveLastAt: state?.proactive?.lastAt ?? null,
      proactiveToday: state?.proactive?.daily?.count ?? 0,
      dreamLastAt: state?.dream?.at ?? null,
      loops: (state?.dream?.loops ?? []).length,
      nudges: (state?.dream?.nudges ?? []).length,
      memory: stats,
      forgetting: stats.forgetting,
      storage: { screenshotsMB: storage.screenshots.mb, uploadsMB: storage.uploads.mb, screenBudgetMB: storage.screenshots.budgetMB, uploadsBudgetMB: storage.uploads.budgetMB },
      screen: {
        enabled: screen.enabled,
        mode: screen.mode,
        intervalMinutes: screen.intervalMinutes,
        idleSkipSeconds: cfg.screen?.idleSkipSeconds ?? 180,
        lastAt: screen.lastAt,
        captureRequested: screen.captureRequested,
        captureReason: screen.captureReason,
        activity: screen.events[0]?.activity ?? null,
        app: screen.events[0]?.app ?? null,
      },
      enabled: { proactive: cfg.proactive.enabled, dream: cfg.dream.enabled, search: cfg.search.enabled, memory: cfg.memory.enabled, screen: cfg.screen?.enabled, companion: cfg.companion?.enabled },
      companion: {
        enabled: cfg.companion?.enabled === true,
        paused: Boolean(state?.companion?.pausedUntil && Date.parse(state.companion.pausedUntil) > Date.now()),
        intervalSeconds: cfg.companion?.intervalSeconds ?? 20,
        pending: (await pendingBubbles()).length,
      },
      mainTitle: main?.title ?? '主对话',
      lastPreview: clip(String(main?.messages?.at(-1)?.content ?? ''), 80),
    })
  }

  if (method === 'PATCH' && p === 'settings') {
    const body = await readBody(req)
    let patch = body.config ?? {}
    // 记忆档位是预设：选档就把具体旋钮一次性写实，避免"档位与数值打架"
    if (patch.memory?.profile) patch = applyProfilePatch(patch, patch.memory.profile)
    cfg = await saveConfig(patch)
    if (body.env && typeof body.env === 'object') {
      const written = await writeEnvValues(body.env)
      if (written.length) log.info(`设置页写入密钥：${written.join(',')}`)
    }
    if (body.restartMcp) await connectMcp()
    return send(res, 200, { config: publicConfig(cfg), mcp: mcp.status() })
  }
  if (method === 'GET' && p === 'settings') return send(res, 200, { config: publicConfig(cfg), mcp: mcp.status() })

  if (method === 'POST' && p === 'conversations') {
    const body = await readBody(req)
    const conv = await createConversation({ title: body.title ?? '新对话', model: body.model, system: body.system })
    return send(res, 200, conv)
  }
  if (method === 'GET' && p === 'conversations') return send(res, 200, { conversations: await listConversations() })

  if (seg[1] === 'conversations' && seg[2]) {
    const id = assertId(seg[2])
    const action = seg[3]
    if (method === 'GET' && !action) {
      const conv = await getConversation(id)
      if (!conv) return send(res, 404, { error: 'not found' })
      return send(res, 200, conv)
    }
    if (method === 'PATCH' && !action) {
      const body = await readBody(req)
      const conv = await patchConversation(id, body)
      return send(res, 200, conv ?? { error: 'not found' })
    }
    if (method === 'DELETE' && !action) {
      if (id === MAIN_ID) return send(res, 400, { error: '主对话不能删除' })
      await deleteConversation(id)
      return send(res, 200, { ok: true })
    }
    if (method === 'POST' && action === 'truncate') {
      const body = await readBody(req)
      const conv = await truncateFrom(id, String(body.messageId ?? ''))
      if (!conv) return send(res, 404, { error: 'not found' })
      return send(res, 200, { messageCount: conv.messages.length })
    }
    if (method === 'GET' && action === 'export') {
      const conv = await getConversation(id)
      if (!conv) return send(res, 404, { error: 'not found' })
      const md = exportMarkdown(conv)
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="echo-${id}.md"`,
      })
      return res.end(md)
    }
  }

  if (method === 'GET' && seg[1] === 'uploads' && seg[2]) {
    const file = path.basename(seg[2])
    const full = path.join(P.uploads, file)
    if (!full.startsWith(P.uploads)) return send(res, 400, { error: 'bad path' })
    try {
      const body = await fs.readFile(full)
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] ?? 'application/octet-stream'
      return send(res, 200, body, { 'content-type': mime, 'cache-control': 'private, max-age=31536000, immutable' })
    } catch {
      return send(res, 404, { error: 'not found' })
    }
  }

  if (method === 'POST' && p === 'images') {
    const body = await readBody(req)
    const result = await generateImage({
      prompt: body.prompt,
      model: body.model ?? cfg.upstream.defaultImageModel,
      conversationId: body.conversationId,
    })
    if (body.conversationId) {
      const conv = await getConversation(assertId(String(body.conversationId)))
      if (conv) {
        const msg = {
          id: newId('m'),
          role: 'assistant',
          content: `画好了：${result.prompt}`,
          images: [{ url: result.path, prompt: result.prompt, model: result.model }],
          model: result.model,
          createdAt: nowIso(),
          usage: result.usage ?? null,
        }
        conv.messages.push(msg)
        await saveConversation(conv)
        result.message = msg
      }
    }
    return send(res, 200, result)
  }

  /* ------------------------------ 屏幕感知 ------------------------------ */
  if (method === 'POST' && p === 'screen') {
    const body = await readBody(req)
    const result = await ingestScreenEvent({
      text: body.text,
      imageDataUrl: body.image,
      app: body.app,
      title: body.title,
      ts: body.ts,
      hidIdleSeconds: body.hidIdleSeconds,
    })
    if (body.fromCapture) await markCaptureHandled({ ok: !result.error, error: result.error })
    return send(res, 200, result)
  }
  if (method === 'GET' && p === 'screen') {
    const [status, storage] = [await screenStatus(), await storageStats()]
    return send(res, 200, { screen: status, storage })
  }
  if (method === 'PATCH' && p === 'screen') {
    const body = await readBody(req)
    const screen = await setScreenConfig(body.screen ?? body)
    return send(res, 200, { screen, status: await screenStatus() })
  }
  if (method === 'POST' && p === 'screen/capture') {
    const body = await readBody(req)
    await requestCapture(body.reason ?? 'manual')
    return send(res, 200, { ok: true, requested: true })
  }
  if (method === 'POST' && p === 'screen/digest') {
    const r = await digestScreenSession({ force: true })
    return send(res, 200, r)
  }

  /* -------------------------------- 存储 ------------------------------- */
  if (method === 'GET' && p === 'storage') return send(res, 200, await storageStats())
  if (method === 'POST' && p === 'storage/prune') {
    const report = await pruneStorage({ force: true })
    const swept = await sweepTempCaptures({ olderThanMinutes: 0 })
    return send(res, 200, { report, swept, stats: await storageStats() })
  }

  if (method === 'GET' && p === 'backup') {
    const convs = []
    for (const m of await listConversations()) {
      const c = await getConversation(m.id)
      if (c) convs.push(c)
    }
    const bundle = {
      product: 'Echo',
      version: VERSION,
      at: nowIso(),
      config: { ...publicConfig(cfg), upstream: { models: cfg.upstream.models.map((m) => m.id), defaultModel: cfg.upstream.defaultModel } },
      conversations: convs,
      memory: {
        core: await loadCore(),
        observations: await listObservations({ limit: 5000, includeInactive: true }),
        graph: await readJSON(path.join(DATA, 'memory', 'graph.json'), null),
        forgettingLog: await readForgettingLog({ limit: 200 }),
      },
      agency: await agencyStats(),
      note: '凭据（API key / 口令哈希 / 会话 cookie）不在此备份里',
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="echo-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    })
    return res.end(JSON.stringify(bundle, null, 2))
  }

  if (method === 'POST' && p === 'memory/wipe') {
    const body = await readBody(req)
    if (body.confirm !== 'WIPE') return send(res, 400, { error: 'confirm_required', message: '需要 {"confirm":"WIPE"} 才执行' })
    const scope = body.scope === 'all' ? 'all' : 'memory'
    const before = await memoryStats()
    const wiped = await wipeEverything({ includeConversations: scope === 'all' })
    log.warn(`用户执行了「全部忘掉」（scope=${scope}）`)
    return send(res, 200, { ok: true, scope, before, wiped, stats: await memoryStats() })
  }

  /* --------------------------- 引导 / 提供方 / 权限 --------------------------- */
  if (method === 'GET' && p === 'providers') {
    return send(res, 200, {
      upstream: UPSTREAM_PRESETS,
      search: searchProviderCatalog(cfg),
      profiles: Object.fromEntries(Object.entries(MEMORY_PROFILES).map(([id, v]) => [id, { label: v.label, note: v.note }])),
      onboarding: onboardingState(),
    })
  }

  if (method === 'POST' && p === 'onboarding/test') {
    const body = await readBody(req)
    try {
      const r = await discoverModels({ baseUrl: body.baseUrl ?? cfg.upstream.baseUrl, apiKey: String(body.apiKey ?? '').trim() || upstreamCreds().apiKey })
      return send(res, 200, { ok: true, ...r })
    } catch (err) {
      return send(res, 200, { ok: false, error: err.message })
    }
  }

  if (method === 'POST' && p === 'onboarding/complete') {
    const body = await readBody(req)
    const envValues = {}
    const keyName = String(body.apiKeyEnv || cfg.upstream.apiKeyEnv || 'OPENAI_API_KEY')
    if (body.apiKey) envValues[keyName] = String(body.apiKey).trim()
    for (const [k, v] of Object.entries(body.keys ?? {})) if (/^[A-Z0-9_]+$/.test(k) && v) envValues[k] = String(v).trim()
    const written = await writeEnvValues(envValues)

    const upstream = {}
    if (body.baseUrl) upstream.baseUrl = String(body.baseUrl).replace(/\/+$/, '')
    if (Array.isArray(body.models) && body.models.length) {
      upstream.models = body.models.map((m) => (typeof m === 'string' ? { id: m, label: m, group: '已发现' } : m))
    }
    if (body.defaultModel) upstream.defaultModel = body.defaultModel
    if (body.utilityModel) upstream.utilityModel = body.utilityModel
    if (Array.isArray(body.imageModels) && body.imageModels.length) {
      upstream.imageModels = body.imageModels
      upstream.defaultImageModel = body.defaultImageModel ?? body.imageModels[0]?.id ?? ''
    }
    const patch = applyProfilePatch({ onboarding: { completed: true, at: nowIso() }, upstream }, body.profile)
    if (body.search?.order) patch.search = { order: body.search.order.filter((x) => typeof x === 'string') }
    if (body.search?.providers) patch.search = { ...(patch.search ?? {}), providers: body.search.providers }
    if (body.password && String(body.password).length >= 6) await setPassword(String(body.password))

    cfg = await saveConfig(patch)
    if (body.restartMcp) await connectMcp()
    log.info(`引导完成：端点 ${cfg.upstream.baseUrl || '(来自环境变量)'} · 模型 ${cfg.upstream.models.length} 个 · 记忆档 ${cfg.memory.profile} · 搜索链 ${(cfg.search.order ?? []).join('→')}${written.length ? ` · 写入密钥 ${written.join(',')}` : ''}`)
    return send(res, 200, { ok: true, envKeys: written, onboarding: onboardingState(), config: publicConfig(cfg) })
  }

  if (method === 'GET' && p === 'permissions') return send(res, 200, await permissionsReport())
  if (method === 'POST' && p === 'permissions/screen-test') return send(res, 200, await screenPermissionProbe())

  /* ------------------------------ 伴随模式 ------------------------------ */
  if (method === 'POST' && p === 'companion/frame') {
    const body = await readBody(req)
    const result = await ingestFrame({
      text: body.text,
      app: body.app,
      title: body.title,
      ts: body.ts,
      hidIdleSeconds: Number(body.hidIdleSeconds ?? 0),
    })
    return send(res, 200, result)
  }
  if (method === 'GET' && p === 'companion') return send(res, 200, await companionStatus({ includeBubbles: Number(url.searchParams.get('n') ?? 12) }))
  if (method === 'GET' && p === 'companion/pending') return send(res, 200, { bubbles: await pendingBubbles() })
  if (method === 'PATCH' && p === 'companion') {
    const body = await readBody(req)
    return send(res, 200, await setCompanion(body.companion ?? body))
  }
  if (method === 'POST' && p === 'companion/pause') {
    const body = await readBody(req)
    return send(res, 200, await setCompanion({ pauseMinutes: Number(body.minutes ?? 30) }))
  }
  if (seg[1] === 'companion' && seg[2] && seg[3]) {
    const id = String(seg[2])
    const action = String(seg[3])
    if (method === 'POST' && action === 'open') {
      const r = await openBubble(id)
      if (!r) return send(res, 404, { error: 'not found' })
      return send(res, 200, { conversationId: r.conversationId, bubble: r.bubble })
    }
    if (method === 'POST' && action === 'dismiss') {
      const body = await readBody(req)
      const b = await dismissBubble(id, { reason: body.reason })
      if (!b) return send(res, 404, { error: 'not found' })
      return send(res, 200, { ok: true, bubble: b, status: await companionStatus({ includeBubbles: 4 }) })
    }
  }

  /* -------------------------------- 图谱 ------------------------------- */
  if (method === 'GET' && p === 'graph') {
    const [stats, entities] = await Promise.all([graphStats(), entitySummary()])
    return send(res, 200, { stats, entities })
  }
  if (method === 'POST' && p === 'graph/rebuild') {
    const obs = await listObservations({ limit: 60 })
    const r = await buildGraph({ observations: obs, cfg, maxObs: 60 })
    return send(res, 200, { result: r, stats: await graphStats(), entities: await entitySummary() })
  }
  if (method === 'GET' && seg[1] === 'graph' && seg[2]) {
    const r = await queryGraph(decodeURIComponent(seg[2]))
    return send(res, r ? 200 : 404, r ?? { error: 'not found' })
  }

  /* ------------------------------ 上下文与诊断 -------------------------- */
  if (method === 'GET' && p === 'context') {
    const conv = await getConversation(String(url.searchParams.get('id') ?? MAIN_ID))
    if (!conv) return send(res, 404, { error: 'not found' })
    const covers = new Set(conv.digest?.covers ?? [])
    return send(res, 200, {
      messages: conv.messages.length,
      digestChars: (conv.digest?.text ?? '').length,
      digestCovered: covers.size,
      pendingForDigest: conv.messages.filter((m) => !covers.has(m.id)).length,
      estTokens: conv.messages.reduce((a, m) => a + estimateTokens(String(m.content ?? '')) + 8, 0),
      budgetChars: cfg.upstream.contextChars,
    })
  }
  if (method === 'POST' && p === 'context/digest') {
    const body = await readBody(req)
    const conv = await getConversation(String(body.conversationId ?? MAIN_ID))
    if (!conv) return send(res, 404, { error: 'not found' })
    const r = await updateDigest({ conv, cfg, force: true })
    return send(res, 200, r)
  }
  if (method === 'GET' && p === 'diagnostics') return send(res, 200, await diagnostics())

  /* -------------------------------- 遗忘 ------------------------------- */
  if (method === 'GET' && p === 'memory/forgetting') {
    const [data, log] = [await recallForgetting({ limit: 60 }), await readForgettingLog({ limit: 20 })]
    return send(res, 200, { ...data, log })
  }
  if (method === 'POST' && p === 'memory/forget') {
    const body = await readBody(req)
    const target = await forgetById(String(body.id ?? ''), String(body.why ?? '用户要求忘记'))
    if (!target) return send(res, 404, { error: 'not found' })
    return send(res, 200, { ok: true, forgotten: { id: target.id, text: target.text }, stats: await memoryStats() })
  }
  if (method === 'POST' && p === 'memory/protect') {
    const body = await readBody(req)
    const target = await setProtected(String(body.id ?? ''), body.on !== false)
    if (!target) return send(res, 404, { error: 'not found' })
    return send(res, 200, { ok: true, protected: Boolean(target.protected), status: target.status, stats: await memoryStats() })
  }
  if (method === 'POST' && p === 'memory/forget-scan') {
    const body = await readBody(req)
    const result = await forgetScan({ trigger: 'manual', dryRun: Boolean(body.dryRun) })
    return send(res, 200, { result, stats: await memoryStats() })
  }

  if (method === 'POST' && p === 'polish') {
    const body = await readBody(req)
    const mode = MODES[body.mode] ? body.mode : 'expand'
    try {
      const result = await polishText({ text: body.text, mode, conversationId: body.conversationId, cfg })
      return send(res, 200, result)
    } catch (err) {
      return send(res, err.status ?? 200, { ok: false, error: err.message, modes: Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, { label: m.label, note: m.note }])) })
    }
  }
  if (method === 'GET' && p === 'polish/modes') {
    return send(res, 200, { modes: Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, { label: m.label, note: m.note }])) })
  }

  if (method === 'POST' && p === 'chat') return streamChatHandler(req, res)
  if (method === 'POST' && p === 'chat/stop') {
    const body = await readBody(req)
    const id = body.conversationId ? assertId(body.conversationId) : null
    const ctrl = id ? inflight.get(id) : null
    if (ctrl) ctrl.abort()
    return send(res, 200, { stopped: Boolean(ctrl) })
  }

  if (method === 'GET' && p === 'memory') {
    const [core, obs, stats] = [await loadCore(), await listObservations({ limit: 400, includeInactive: true }), await memoryStats()]
    return send(res, 200, { core, observations: obs.map((o) => ({ ...o, strength: strengthOf(o, cfg) })), stats })
  }
  if (method === 'PUT' && p === 'memory/core') {
    const body = await readBody(req)
    const text = String(body.text ?? '')
    if (text.length > 40000) return send(res, 400, { error: '太长' })
    await saveCore(text, { backup: true })
    return send(res, 200, { ok: true, stats: await memoryStats() })
  }
  if (method === 'POST' && p === 'memory/observation') {
    const body = await readBody(req)
    const obs = await appendObservation({ ...body, source: 'manual' })
    return send(res, 200, { observation: obs, stats: await memoryStats() })
  }
  if (seg[1] === 'memory' && seg[2] === 'observation' && seg[3] && method === 'DELETE') {
    const ok = await deleteObservation(seg[3])
    if (!ok) return send(res, 404, { error: 'not found' })
    return send(res, 200, { ok: true, stats: await memoryStats() })
  }
  if (method === 'POST' && p === 'memory/search') {
    const body = await readBody(req)
    return send(res, 200, { results: await retrieve(String(body.query ?? ''), { topK: Math.min(20, body.topK ?? 10) }) })
  }

  if (method === 'POST' && p === 'dream') {
    if (dreamRunning()) return send(res, 409, { error: 'dream 正在运行' })
    const result = await runDream({ trigger: 'manual' })
    return send(res, 200, { result, status: await dreamStatus(), memory: await memoryStats() })
  }
  if (method === 'GET' && p === 'dream') return send(res, 200, await dreamStatus())
  if (method === 'PATCH' && p === 'dream/loop') {
    const body = await readBody(req)
    const state = await updateLoop(body)
    return send(res, 200, { loops: state?.dream?.loops ?? [] })
  }

  if (method === 'GET' && p === 'agency') return send(res, 200, await agencyStats())
  if (method === 'POST' && p === 'feedback') {
    const body = await readBody(req)
    const conv = body.conversationId ? await getConversation(String(body.conversationId)) : null
    const msg = conv?.messages?.find((m) => m.id === body.messageId)
    const kind = body.kind ?? msg?.kind ?? null
    const r = await applyFeedback({ kind, signal: String(body.signal ?? '') })
    if (msg) msg.feedback = String(body.signal ?? '')
    if (conv) await saveConversation(conv)
    return send(res, 200, { ok: true, ...r, agency: await agencyStats() })
  }

  if (method === 'GET' && p === 'proactive') return send(res, 200, await proactiveStatus())
  if (method === 'POST' && p === 'proactive/run') {
    const result = await proactiveTick({ busyConversations: new Set() })
    return send(res, 200, { result, status: await proactiveStatus() })
  }
  if (method === 'PATCH' && p === 'proactive') {
    const body = await readBody(req)
    cfg = await saveConfig({ proactive: { enabled: Boolean(body.enabled) } })
    return send(res, 200, await proactiveStatus())
  }

  if (method === 'POST' && p === 'search/test') {
    const body = await readBody(req)
    const query = String(body.query ?? 'test')
    const started = Date.now()
    try {
      const r = await searchWithFallback({ query, cfg, count: body.count ?? 5, nativeSearch })
      return send(res, 200, { ...r, engines: await engineStatus(), ms: Date.now() - started })
    } catch (err) {
      return send(res, 200, { query, ok: false, ms: Date.now() - started, error: err.message, attempts: err.attempts ?? [], engines: await engineStatus(), results: [] })
    }
  }
  if (method === 'GET' && p === 'search/engines') return send(res, 200, { engines: await engineStatus() })

  if (method === 'GET' && p === 'mcp') return send(res, 200, { servers: mcp.status(), tools: mcp.tools() })
  if (method === 'POST' && p === 'mcp/reload') {
    await refreshConfig()
    return send(res, 200, { servers: await connectMcp() })
  }

  return send(res, 404, { error: 'unknown route', route: `/${p}` })
}

function upstreamReady() {
  const { apiKey, baseUrl, apiKeyEnv, baseUrlEnv, configured } = upstreamCreds()
  return { hasKey: Boolean(apiKey), baseUrl, apiKeyEnv, baseUrlEnv, configured, models: (cfg.upstream.models ?? []).map((m) => m.id) }
}

/** 隐私兜底：把记忆（可选连同会话）清空，但在遗忘日志里留一条可解释的记录。 */
async function wipeEverything({ includeConversations = false } = {}) {
  const memDir = path.join(DATA, 'memory')
  const before = await memoryStats()
  const counts = { observations: before.observations, conversations: 0 }
  await logForgetting(
    [{ id: 'ALL', text: `用户清空了全部记忆（${before.observations} 条有效事实、${before.total} 条历史）`, kind: 'system', importance: 5 }],
    { trigger: 'user', kind: 'wiped', note: '隐私兜底操作：只留这条记录用于解释' },
  )
  await fs.writeFile(path.join(memDir, 'observations.jsonl'), '')
  await fs.writeFile(path.join(memDir, 'working.jsonl'), '')
  await fs.rm(path.join(memDir, 'graph.json'), { force: true })
  const seed = `# Echo 核心记忆\n\n> 这份文件会注入每一次对话。刚刚被清空过（${nowIso()}），从零开始。\n\n## 关于你\n\n## 正在跟进\n\n## 偏好与约定\n\n## 待办与提醒\n`
  await saveCore(seed, { backup: true })
  if (includeConversations) {
    for (const m of await listConversations()) {
      if (m.id === MAIN_ID) {
        const conv = await getConversation(MAIN_ID)
        if (conv) {
          conv.messages = []
          conv.digest = null
          conv.title = '主对话'
          await saveConversation(conv)
        }
        continue
      }
      await deleteConversation(m.id)
      counts.conversations++
    }
  }
  await mutateState((s) => {
    s.dream = { loops: [], nudges: [], at: null }
    s.proactive = { history: [], daily: { date: null, count: 0 }, consecutiveIgnores: 0 }
    s.agency = {}
    return s
  })
  return counts
}

/** 自我报告：跑过什么、多快、失败在哪——RSI 的度量面。 */
async function diagnostics() {
  const [metrics, storage, mem, graph, screen, agency] = await Promise.all([
    metricsSummary({ days: 7 }),
    storageStats(),
    memoryStats(),
    graphStats(),
    screenStatus({ includeEvents: 3 }),
    agencyStats(),
  ])
  const convs = await listConversations()
  const { apiKey, baseUrl } = upstreamCreds()
  return {
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
    auth: { passwordSet: Boolean((await readJSON(P.auth, {})).password) },
    upstream: { hasKey: Boolean(apiKey), baseUrl, model: cfg.upstream.defaultModel },
    features: {
      search: cfg.search.enabled,
      memory: cfg.memory.enabled,
      dream: cfg.dream.enabled,
      proactive: cfg.proactive.enabled,
      screen: cfg.screen?.enabled,
      imageIn: cfg.media?.imageInput,
      imageOut: cfg.media?.imageOutput,
    },
    counts: { conversations: convs.length, messages: convs.reduce((a, c) => a + c.messageCount, 0) },
    metrics,
    storage,
    memory: mem,
    graph,
    agency,
    search: { provider: cfg.search.provider, engines: await engineStatus() },
    screen: { enabled: screen.enabled, lastAt: screen.lastAt, todayCount: screen.todayCount, working: screen.workingCount, sessions: screen.sessions.length },
    mcp: mcp.status(),
    inflight: inflight.size,
  }
}

function publicConfig(c) {
  return {
    bind: c.bind,
    port: c.port,
    auth: { required: c.requirePassword === true, passwordSet: authState.passwordSet },
    onboarding: onboardingState(),
    providers: { search: searchProviderCatalog(c), upstream: UPSTREAM_PRESETS, profiles: Object.keys(MEMORY_PROFILES) },
    upstreamConfigured: Boolean(upstreamCreds(c).configured),
    models: c.upstream.models,
    imageModels: c.upstream.imageModels ?? [],
    defaultImageModel: c.upstream.defaultImageModel,
    media: c.media,
    defaultModel: c.upstream.defaultModel,
    generation: c.generation,
    systemPrompt: c.systemPrompt,
    search: c.search,
    memory: c.memory,
    screen: c.screen,
    storage: c.storage,
    dream: c.dream,
    proactive: c.proactive,
    mcpServers: Object.fromEntries(Object.entries(c.mcpServers ?? {}).map(([k, v]) => [k, { type: v.type, enabled: v.enabled !== false, url: v.url, command: v.command, args: v.args }])),
  }
}

function setupAllowed(req) {
  return isLoopback(req) || Boolean(process.env.ECHO_ALLOW_REMOTE_SETUP)
}

async function setupPassword(req, res) {
  if (!setupAllowed(req)) return send(res, 403, { error: 'setup_from_loopback_only', message: '首次设置口令只能在本机浏览器完成' })
  const body = await readBody(req)
  const password = String(body.password ?? '')
  if (password.length < 6) return send(res, 400, { error: 'weak', message: '口令至少 6 位' })
  await setPassword(password)
  await createSession(res)
  log.info('已设置访问口令')
  return send(res, 200, { ok: true })
}

async function doLogin(req, res) {
  const ip = req.socket?.remoteAddress ?? '?'
  if (rateLimited(ip)) return send(res, 429, { error: 'too_many_attempts', message: '尝试过多，等 5 分钟' })
  const body = await readBody(req)
  const auth = await readJSON(P.auth, {})
  const ok = auth.password ? verifyPassword(String(body.password ?? ''), auth.password) : false
  if (!ok) {
    const rec = loginAttempts.get(ip) ?? { first: Date.now(), count: 0 }
    rec.count++
    loginAttempts.set(ip, rec)
    log.warn('口令错误', ip)
    return send(res, 401, { error: 'bad_password', message: '口令不对' })
  }
  loginAttempts.delete(ip)
  await createSession(res)
  return send(res, 200, { ok: true })
}

async function changePassword(req, res, who) {
  if (who?.via !== 'local' && !isLoopback(req)) return send(res, 403, { error: 'loopback_only' })
  const body = await readBody(req)
  const auth = await readJSON(P.auth, {})
  // 关掉验证的本机自用模式：改口令不必再报旧口令
  const needCurrent = cfg.requirePassword === true && auth.password
  if (needCurrent && !verifyPassword(String(body.current ?? ''), auth.password)) return send(res, 401, { error: 'bad_current' })
  const next = String(body.next ?? body.password ?? '')
  if (next.length < 6) return send(res, 400, { error: 'weak' })
  await setPassword(next)
  return send(res, 200, { ok: true })
}

/* -------------------------------- chat SSE -------------------------------- */

async function streamChatHandler(req, res) {
  const body = await readBody(req)
  const conversationId = assertId(String(body.conversationId ?? ''))
  if (inflight.has(conversationId)) return send(res, 409, { error: 'busy', message: '这个会话正在生成中' })
  const ctrl = new AbortController()
  inflight.set(conversationId, ctrl)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': ok\n\n')
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 20000)
  // 页面关掉/刷新就别继续烧 token 了
  res.on('close', () => {
    if (!res.writableEnded && inflight.get(conversationId) === ctrl) ctrl.abort()
  })

  const attachments = []
  for (const img of (Array.isArray(body.images) ? body.images : []).slice(0, cfg.media?.maxImagesPerMessage ?? 4)) {
    try {
      const dataUrl = typeof img === 'string' ? img : img?.dataUrl
      if (!dataUrl) continue
      const parsed = parseDataUrl(dataUrl)
      if (!parsed) continue
      if (parsed.buffer.length > (cfg.media?.maxImageBytes ?? 8 * 1024 * 1024)) {
        sseWrite(res, 'notice', { text: `有图片超过 ${Math.round((cfg.media.maxImageBytes ?? 8e6) / 1e6)}MB，已跳过` })
        continue
      }
      const saved = await saveImage({ dataUrl, prefix: 'up' })
      attachments.push({ url: saved.path, bytes: saved.bytes })
    } catch (err) {
      log.warn('附件保存失败', err.message)
    }
  }

  if (body.userText || attachments.length) await recordUserEngagement(conversationId)

  try {
    const main = await getConversation(MAIN_ID)
    if (conversationId === MAIN_ID && main?.unread) await patchConversation(MAIN_ID, { unread: 0 })
    const startedAt = Date.now()
    let doneEvt = null
    let toolCount = 0
    let failedTools = 0
    for await (const ev of runTurn({
      conversationId,
      userText: body.userText,
      regenerate: Boolean(body.regenerate),
      searchMode: body.searchMode,
      model: body.model,
      temperature: body.temperature,
      enableThinking: body.enableThinking,
      signal: ctrl.signal,
      mcp,
      images: attachments.map((a) => a.url),
    })) {
      if (ev.type === 'tool_result') {
        toolCount++
        if (!ev.ok) failedTools++
      }
      if (ev.type === 'done') doneEvt = ev
      if (res.writableEnded) break
      sseWrite(res, ev.type, ev)
    }
    record({
      kind: 'turn',
      conversationId,
      model: doneEvt?.message?.model ?? body.model ?? cfg.upstream.defaultModel,
      rounds: doneEvt?.rounds ?? 1,
      ms: Date.now() - startedAt,
      ok: Boolean(doneEvt) && !failedTools,
      aborted: Boolean(doneEvt?.aborted),
      tools: toolCount,
      failedTools,
      usage: doneEvt?.usage ?? null,
      context: doneEvt?.message?.context ?? null,
      hasImages: attachments.length > 0,
      proactive: conversationId === MAIN_ID,
    })
    const conv = await getConversation(conversationId)
    const assistant = conv?.messages?.at(-1)
    if (assistant?.role === 'assistant' && !body.regenerate) {
      const user = [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'user')
      if (conv && conv.messages.filter((m) => m.role === 'user').length === 1 && conv.title === '新对话') {
        generateTitle(conversationId, user?.content ?? '', assistant.content).catch(() => {})
      }
      maybeExtractMemory(conv, assistant).catch((err) => log.warn('抽取失败', err.message))
      maybeDigest(conversationId, cfg).catch((err) => log.warn('摘要失败', err.message))
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      log.error('stream 失败', err.message)
      if (!res.writableEnded) sseWrite(res, 'error', { message: err.message })
    }
  } finally {
    clearInterval(heartbeat)
    inflight.delete(conversationId)
    if (!res.writableEnded) res.end()
  }
}

/* --------------------------------- server ---------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  )
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname)
    return send(res, 405, { error: 'method not allowed' })
  } catch (err) {
    const status = err?.status ?? 500
    if (status >= 500) log.error(`${req.method} ${url.pathname}`, err)
    if (!res.headersSent) send(res, status, { error: err?.message ?? 'server error' })
    else res.end()
  }
})

/* -------------------------------- schedulers -------------------------------- */

let dreamChecking = false
let lastMaintenance = 0
let lastScreenDigest = 0
const tick = setInterval(async () => {
  try {
    if (Date.now() - lastMaintenance > 6 * 3600000) {
      lastMaintenance = Date.now()
      await pruneStorage().catch((err) => log.warn('存储清理失败', err.message))
      await sweepTempCaptures().catch(() => {})
      await pruneScreenData().catch(() => {})
      await forgetScan({ trigger: 'schedule' }).catch((err) => log.warn('遗忘扫描失败', err.message))
    }
    if (cfg.screen?.enabled && Date.now() - lastScreenDigest > (cfg.screen.digestMinutes ?? 45) * 60000) {
      lastScreenDigest = Date.now()
      await digestScreenSession().catch((err) => log.warn('屏幕摘要失败', err.message))
    }
    if (!cfg.dream.enabled || dreamChecking || inflight.size) return
    dreamChecking = true
    const state = await readDreamState()
    const lastAt = state?.at ? Date.parse(state.at) : 0
    const due = Number.isFinite(lastAt) && Date.now() - lastAt > cfg.dream.intervalHours * 3600000
    if (due) {
      const lastUser = (await readState())?.lastUserMessageAt
      const idleOk = !lastUser || Date.now() - Date.parse(lastUser) > cfg.dream.minIdleMinutes * 60000
      const stats = await memoryStats()
      const conversations = await listConversations()
      const hasMaterial = stats.observations > 0 || conversations.some((c) => c.messageCount > 0)
      if (idleOk && hasMaterial) {
        log.info('触发 Dream 提炼')
        await runDream({ trigger: 'schedule' })
      }
    }
  } catch (err) {
    log.error('dream 调度异常', err.message)
  } finally {
    dreamChecking = false
  }
}, 5 * 60 * 1000)

async function readDreamState() {
  return (await readState())?.dream ?? null
}

let proactiveBusy = false
let lastProactiveAttempt = 0
const proactiveTimer = setInterval(async () => {
  try {
    if (!cfg.proactive.enabled || proactiveBusy) return
    await settlePending().catch(() => {})
    const tickMs = Math.max(1, cfg.proactive.tickMinutes ?? 5) * 60000
    if (Date.now() - lastProactiveAttempt < tickMs) return
    lastProactiveAttempt = Date.now()
    proactiveBusy = true
    const result = await proactiveTick({ busyConversations: new Set(inflight.keys()) })
    if (!result.acted && result.skipped !== 'quiet_hours' && result.skipped !== 'disabled') log.debug('主动服务跳过:', result.skipped)
  } catch (err) {
    log.error('主动服务调度异常', err.message)
  } finally {
    proactiveBusy = false
  }
}, 60000)

/* --------------------------------- startup --------------------------------- */

async function boot() {
  await fs.mkdir(path.join(P.convDir), { recursive: true })
  await fs.mkdir(P.logs, { recursive: true })
  await ensureStorageDirs()
  await ensureLocalToken()
  const envResult = await loadEnvFile(P.env)
  await ensureCore()
  await createConversation({ isMain: true, title: '主对话' })
  await refreshConfig()
  await connectMcp()
  lastMaintenance = Date.now()
  await pruneStorage().catch(() => {})
  await sweepTempCaptures().catch(() => {})

  const port = Number(process.env.ECHO_PORT ?? cfg.port)
  const wantLan = (process.env.ECHO_BIND ?? cfg.bind) === 'all'
  const auth = await readJSON(P.auth, {})
  authState.passwordSet = Boolean(auth.password)
  const authRequired = cfg.requirePassword === true
  const bind = wantLan && (auth.password || !authRequired) ? '0.0.0.0' : '127.0.0.1'
  if (authRequired && !auth.password) log.warn('要求口令但还没设置，已退化为仅本机监听')

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, resolve)
  })

  const ips = lanAddresses()
  log.info(`Echo v${VERSION} 已启动 · 监听 ${bind}:${port} · env文件=${envResult.loaded ? '已加载' : '无'}`)
  log.info(`  本机   http://127.0.0.1:${port}`)
  for (const ip of bind === '0.0.0.0' ? ips : []) log.info(`  局域网 http://${ip}:${port}`)
  log.info(`  上游   ${upstreamCreds().baseUrl} · key=${upstreamCreds().apiKey ? '已配置' : '缺失'} · 模型=${cfg.upstream.defaultModel}`)
  log.info(`  记忆   ${JSON.stringify(await memoryStats())}`)
}

function lanAddresses() {
  const out = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // skip APIPA and the proxy's fake-IP range; they are never reachable from a phone
      if (a.address.startsWith('169.254.') || a.address.startsWith('198.18.')) continue
      out.push(`${a.address} (${name})`)
    }
  }
  return out.sort((x, y) => (x.includes('(en0)') ? -1 : y.includes('(en0)') ? 1 : 0))
}

async function shutdown(signal) {
  log.info(`收到 ${signal}，正在退出`)
  clearInterval(tick)
  clearInterval(proactiveTimer)
  for (const [, ctrl] of inflight) ctrl.abort()
  try {
    mcp.close()
  } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 4000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err))
process.on('uncaughtException', (err) => log.error('uncaughtException', err))

boot().catch((err) => {
  log.error('启动失败', err)
  process.exit(1)
})
