/**
 * 提供方目录：把"用哪家的模型 / 怎么联网 / 记忆到什么程度"从代码里抽出来，
 * 变成一份可读的声明。社区用户改这里或改配置即可，不需要动实现。
 *
 * 约定：API Key 一律不进 config.json —— 配置里只写"从哪个环境变量读"，
 * 真正的密钥写在 data/echo.env（0600）或进程环境里。
 */

export const UPSTREAM_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'dashscope', label: '阿里云百炼（OpenAI 兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'custom', label: '自定义 / 其他兼容端点', baseUrl: '' },
]

export const SEARCH_PROVIDERS = {
  none: {
    label: '不联网',
    kind: 'none',
    needsKey: false,
    note: '模型只凭已有知识与记忆回答',
  },
  scrape: {
    label: '零配置抓取（中文引擎）',
    kind: 'scrape',
    needsKey: false,
    note: '免 Key，最快；会被第三方限流，已内置熔断冷却后自动交给下一个提供方',
  },
  gateway: {
    label: '网关托管搜索',
    kind: 'gateway',
    needsKey: false,
    note: '复用你已有的模型网关（Responses web_search），无需额外订阅；延迟约 3–8s，带 sources',
  },
  tavily: {
    label: 'Tavily',
    kind: 'tavily',
    needsKey: true,
    envVar: 'TAVILY_API_KEY',
    endpoint: 'https://api.tavily.com/search',
    note: '面向 LLM 的搜索 API，返回正文摘要',
  },
  brave: {
    label: 'Brave Search API',
    kind: 'brave',
    needsKey: true,
    envVar: 'BRAVE_API_KEY',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    note: '独立索引，隐私友好',
  },
  bocha: {
    label: '博查 Bocha',
    kind: 'bocha',
    needsKey: true,
    envVar: 'BOCHA_API_KEY',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    note: '中文结果质量好',
  },
  searxng: {
    label: 'SearXNG（自建或公共实例）',
    kind: 'searxng',
    needsKey: false,
    envVar: 'SEARXNG_URL',
    endpoint: '',
    note: '给一个实例地址即可，聚合多个引擎；建议自建',
  },
  custom: {
    label: '自定义 HTTP 搜索',
    kind: 'custom',
    needsKey: false,
    note: '任何返回 {results:[{title,url,snippet}]} 或同构数组的接口；可自定义方法与请求头',
  },
}

export const MEMORY_PROFILES = {
  off: {
    label: '关闭（不给任何记忆）',
    note: '只做当次对话，不抽取、不注入、不做屏幕感知',
    values: {
      memory: { enabled: false, extract: false, inject: false, retrieveTopK: 0 },
      dream: { enabled: false },
      proactive: { enabled: false },
      screen: { enabled: false },
    },
  },
  light: {
    label: '轻量（只记事实，不主动打扰）',
    note: '抽取长期事实并在对话中注入；不做 Dream 巩固、不主动开口、不采集屏幕',
    values: {
      memory: { enabled: true, extract: true, inject: true, retrieveTopK: 4 },
      dream: { enabled: false },
      proactive: { enabled: false },
      screen: { enabled: false },
    },
  },
  standard: {
    label: '标准（推荐）',
    note: '抽取 + 注入 + 定期 Dream 巩固与遗忘；主动服务开启但不采集屏幕',
    values: {
      memory: { enabled: true, extract: true, inject: true, retrieveTopK: 6 },
      dream: { enabled: true, intervalHours: 8 },
      proactive: { enabled: true, dailyBudget: 4 },
      screen: { enabled: false },
    },
  },
  deep: {
    label: '深度（含屏幕感知）',
    note: '在标准之上打开屏幕感知（本地 OCR），工作记忆参与对话与主动判断；需要屏幕录制授权',
    values: {
      memory: { enabled: true, extract: true, inject: true, retrieveTopK: 8 },
      dream: { enabled: true, intervalHours: 6 },
      proactive: { enabled: true, dailyBudget: 5 },
      screen: { enabled: true, mode: 'ocr', intervalMinutes: 5 },
    },
  },
}

export const DEFAULT_SEARCH_ORDER = ['scrape', 'gateway']

export function normalizeSearchConfig(search = {}) {
  const legacy = { auto: DEFAULT_SEARCH_ORDER, fast: ['scrape'], native: ['gateway'], off: ['none'], bing: ['scrape'] }
  const order = Array.isArray(search.order) && search.order.length ? search.order : legacy[search.provider] ?? DEFAULT_SEARCH_ORDER
  const providers = {}
  for (const [id, spec] of Object.entries(SEARCH_PROVIDERS)) {
    providers[id] = { ...(search.providers?.[id] ?? {}) }
  }
  return { ...search, order, providers }
}

/** 某个提供方是否已具备可用条件（key/地址齐了没有）。 */
export function providerStatus(id, cfg) {
  const spec = SEARCH_PROVIDERS[id]
  if (!spec) return { id, known: false, ready: false, label: id }
  const conf = cfg?.search?.providers?.[id] ?? {}
  const envName = conf.envVar ?? spec.envVar
  const envValue = envName ? process.env[envName] : undefined
  let ready = true
  let reason = ''
  if (spec.needsKey) {
    ready = Boolean(envValue || conf.apiKey)
    if (!ready) reason = `缺少密钥（环境变量 ${envName}）`
  }
  if (spec.kind === 'searxng') {
    const url = conf.endpoint || envValue || ''
    ready = /^https?:\/\//.test(url)
    if (!ready) reason = '缺少实例地址（SEARXNG_URL 或 providers.searxng.endpoint）'
  }
  if (spec.kind === 'custom') {
    ready = Boolean(conf.endpoint)
    if (!ready) reason = '未配置 endpoint'
  }
  return {
    id,
    known: true,
    label: spec.label,
    kind: spec.kind,
    needsKey: spec.needsKey,
    ready,
    reason,
    note: spec.note,
    inOrder: (cfg?.search?.order ?? []).includes(id),
    envVar: envName ?? null,
    endpoint: conf.endpoint ?? spec.endpoint ?? '',
  }
}

export function searchProviderCatalog(cfg) {
  return Object.keys(SEARCH_PROVIDERS).map((id) => providerStatus(id, cfg))
}

/** 给引导页用：把"记忆到什么程度"翻译成具体配置值。 */
export function memoryProfileValues(profileId) {
  const p = MEMORY_PROFILES[profileId]
  return p ? { profile: profileId, ...p.values } : null
}

export function upstreamKeyEnv(cfg) {
  return cfg?.upstream?.apiKeyEnv ?? 'OPENAI_API_KEY'
}

export function upstreamBaseUrlEnv(cfg) {
  return cfg?.upstream?.baseUrlEnv ?? 'OPENAI_BASE_URL'
}