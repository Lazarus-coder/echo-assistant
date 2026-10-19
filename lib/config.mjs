import path from 'node:path'
import { promises as fs } from 'node:fs'
import { readJSON, writeJSON } from './util.mjs'
import { normalizeSearchConfig } from './providers.mjs'

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// 允许把数据目录挪走（自测沙箱、多实例并存都用它）
export const DATA = process.env.ECHO_DATA_DIR ? path.resolve(process.env.ECHO_DATA_DIR) : path.join(ROOT, 'data')
export const PUBLIC = path.join(ROOT, 'public')
export const P = {
  config: process.env.ECHO_CONFIG ? path.resolve(process.env.ECHO_CONFIG) : path.join(ROOT, 'config.json'),
  auth: path.join(DATA, 'auth.json'),
  env: path.join(DATA, 'echo.env'),
  conv: (id) => path.join(DATA, 'conversations', `${id}.json`),
  convDir: path.join(DATA, 'conversations'),
  memoryCore: path.join(DATA, 'memory', 'MEMORY.md'),
  memoryObs: path.join(DATA, 'memory', 'observations.jsonl'),
  memoryBackups: path.join(DATA, 'memory', 'backups'),
  dreams: path.join(DATA, 'memory', 'dreams'),
  state: path.join(DATA, 'state.json'),
  logs: path.join(DATA, 'logs'),
  uploads: path.join(DATA, 'uploads'),
}

export const DEFAULTS = {
  bind: 'all',
  port: 8787,
  // 本机自用默认不要求口令；改成 true（或 ./bin/echo auth on）即恢复登录验证
  requirePassword: false,
  onboarding: { completed: false, at: null },
  upstream: {
    // BYOK：这里不预设任何厂商。baseUrl 由引导页或环境变量填入；
    // 密钥只写进 data/echo.env / 进程环境，绝不进 config.json。
    baseUrl: '',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    models: [],
    imageModels: [],
    defaultModel: '',
    defaultImageModel: '',
    utilityModel: '',
    // 主模型不可用（5xx/超限/模型下线）时按顺序降级
    fallback: [],
    maxTokens: 8000,
    contextChars: 120000,
  },
  media: {
    imageInput: true,
    imageOutput: true,
    maxImagesPerMessage: 4,
    maxImageBytes: 8 * 1024 * 1024,
    maxEdge: 1536,
  },
  generation: { temperature: 0.6, enableThinking: false, topP: null },
  systemPrompt:
    '你是 Echo，运行在用户自己机器上的私人助手。回答简洁、直接、口语化，中文优先；不确定就说不确定并给出验证方式。',
  search: {
    enabled: true,
    // 依次尝试的提供方链；可用项见 lib/providers.mjs（none/scrape/gateway/tavily/brave/bocha/searxng/custom）
    order: ['scrape', 'gateway'],
    providers: {},
    maxResults: 6,
    readPages: true,
    maxToolRounds: 8,
  },
  memory: {
    enabled: true,
    profile: 'standard',
    inject: true,
    injectChars: 2600,
    retrieveTopK: 6,
    extract: true,
    extractMinChars: 24,
    coreMaxChars: 3200,
    // 遗忘引擎：强度 = 重要度 × 使用增益 × 时间衰减
    halfLifeDays: 14,
    usageGain: 0.5,
    fadeThreshold: 0.35,
    fadeMinAgeDays: 21,
    maxActiveObservations: 1200,
    digestEvery: 12,
    digestMaxChars: 1800,
    graphEntities: 6,
  },
  screen: {
    enabled: false,
    intervalMinutes: 5,
    mode: 'ocr',
    retentionDays: 3,
    keepImages: false,
    workingMinutes: 90,
    digestMinutes: 45,
    idleSkipSeconds: 180,
    visionModel: 'qwen3.6-flash',
    // 默认不预设屏蔽名单：自己的机器自己定。界面或 config.json 里随时加。
    blocklist: [],
    excludeTitlePatterns: [],
  },
  storage: {
    screenImageBudgetMB: 200,
    uploadsBudgetMB: 300,
    screenRetentionDays: 3,
    uploadRetentionDays: 60,
  },
  // 伴随模式：显式开启后大幅提高截图频率，跟着用户一起看屏幕，用气泡偶尔说一句
  companion: {
    enabled: false,
    intervalSeconds: 20,
    hourlyBudget: 15,
    minGapSeconds: 75,
    idleSkipSeconds: 120,
    minTextChars: 40,
    changeThreshold: 0.88,
    dismissStreakLimit: 3,
    backoffMinutes: 10,
    scenarios: ['chat', 'video', 'work', 'code', 'browse', 'other'],
    model: '',
  },
  dream: {
    enabled: true,
    intervalHours: 6,
    minIdleMinutes: 10,
    observationWindow: 120,
  },
  proactive: {
    enabled: true,
    tickMinutes: 5,
    minGapMinutes: 45,
    dailyBudget: 5,
    quietHours: { start: '22:30', end: '08:30' },
    idleToFirstNudgeMinutes: 25,
    confidenceThreshold: 0.62,
    ignoreDecay: 2,
    notify: true,
  },
  mcpServers: {},
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

let cache = null
let cacheStamp = 0

/** 带 mtime 缓存的读取：文件被别的路径（CLI/接口/手改）改动后同样生效。 */
export async function loadConfig() {
  const stamp = await fs.stat(P.config).then((s) => s.mtimeMs).catch(() => 0)
  if (cache && stamp === cacheStamp) return cache
  const saved = await readJSON(P.config, {})
  cache = deepMerge(DEFAULTS, saved)
  // 搜索节统一成"提供方链"形态（兼容早期的 provider: auto|fast|native 写法）
  cache.search = normalizeSearchConfig(cache.search)
  cacheStamp = stamp
  return cache
}

export async function saveConfig(patch) {
  const current = await loadConfig()
  const next = deepMerge(current, patch)
  await writeJSON(P.config, next)
  cache = next
  cacheStamp = await fs.stat(P.config).then((s) => s.mtimeMs).catch(() => 0)
  return next
}

/**
 * 凭据解析（BYOK）：密钥只从环境/echo.env 读，配置里只存"从哪个变量读"。
 * 不带参数时用最近一次 loadConfig 的结果；也可显式传入配置。
 */
export function upstreamCreds(cfg) {
  const c = cfg ?? cache ?? DEFAULTS
  const apiKeyEnv = c.upstream?.apiKeyEnv ?? 'OPENAI_API_KEY'
  const baseUrlEnv = c.upstream?.baseUrlEnv ?? 'OPENAI_BASE_URL'
  const apiKey = process.env[apiKeyEnv] || process.env.OPENAI_API_KEY || ''
  const baseUrl = String(process.env[baseUrlEnv] || c.upstream?.baseUrl || '').replace(/\/+$/, '')
  return { apiKey, baseUrl, apiKeyEnv, baseUrlEnv, configured: Boolean(apiKey && baseUrl) }
}
