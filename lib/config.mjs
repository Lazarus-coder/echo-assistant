import path from 'node:path'
import { promises as fs } from 'node:fs'
import { readJSON, writeJSON } from './util.mjs'

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
  upstream: {
    models: [
      { id: 'auto', label: 'Auto · 智能路由', group: '推荐', vision: false, thinking: true, note: '由网关挑模型' },
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', group: '千问', vision: true, thinking: true, note: '最强，带视觉' },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', group: '千问', vision: true, thinking: true, note: '快，带视觉' },
      { id: 'qwen3.7-max', label: 'Qwen3.7 Max', group: '千问', vision: false, thinking: true },
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', group: '千问', vision: true, thinking: true },
      { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash', group: '千问', vision: true, thinking: true, note: '最省' },
      { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek v4.1 Flash 1017', group: 'DeepSeek', vision: true, thinking: true },
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek v4.1 Flash', group: 'DeepSeek', vision: true, thinking: true },
      { id: 'deepseek-v4-pro-0813', label: 'DeepSeek v4 Pro 0813', group: 'DeepSeek', vision: false, thinking: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek v4 Pro', group: 'DeepSeek', vision: false, thinking: true },
      { id: 'deepseek-v4-flash-0731', label: 'DeepSeek v4 Flash 0731', group: 'DeepSeek', vision: false, thinking: true },
      { id: 'glm-5.3', label: 'GLM 5.3', group: '智谱', vision: false, thinking: true },
      { id: 'glm-5.2', label: 'GLM 5.2', group: '智谱', vision: false, thinking: true },
    ],
    imageModels: [
      { id: 'qwen-image-3.0-pro', label: 'Qwen Image 3.0 Pro', note: '2048² 出图' },
      { id: 'wan2.7-image', label: '万相 2.7', note: '快' },
      { id: 'wan2.7-image-pro', label: '万相 2.7 Pro', note: '质量优先' },
    ],
    defaultImageModel: 'qwen-image-3.0-pro',
    defaultModel: 'qwen3.8-max',
    utilityModel: 'qwen3.6-flash',
    // 主模型不可用（5xx/超限/模型下线）时按顺序降级
    fallback: ['qwen3.8-flash', 'qwen3.6-flash', 'glm-5.2'],
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
    provider: 'auto',
    maxResults: 6,
    readPages: true,
    maxToolRounds: 8,
  },
  memory: {
    enabled: true,
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

export function upstreamCreds() {
  const apiKey = process.env.OPENAI_API_KEY ?? ''
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
  return { apiKey, baseUrl }
}
