import { domainText } from './domain-language.mjs'
/**
 * 提供方目录：把"用哪家的模型 / 怎么联网 / 记忆到什么程度"从代码里抽出来，
 * 变成一份可读的声明。社区用户改这里或改配置即可，不需要动实现。
 *
 * 约定：API Key 一律不进 config.json —— 配置里只写"从哪个环境变量读"，
 * 真正的密钥写在 data/echo.env（0600）或进程环境里。
 */

export const UPSTREAM_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'dashscope', get label() { return domainText('providers.dashscope') }, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'ollama', get label() { return domainText('providers.ollama') }, baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'custom', get label() { return domainText('providers.custom') }, baseUrl: '' },
]

export const SEARCH_PROVIDERS = {
  none: {
    get label() { return domainText('providers.offline') },
    kind: 'none',
    needsKey: false,
    get note() { return domainText('providers.offlineNote') },
  },
  scrape: {
    get label() { return domainText('providers.scrape') },
    kind: 'scrape',
    needsKey: false,
    get note() { return domainText('providers.scrapeNote') },
  },
  gateway: {
    get label() { return domainText('providers.gateway') },
    kind: 'gateway',
    needsKey: false,
    get note() { return domainText('providers.gatewayNote') },
  },
  tavily: {
    label: 'Tavily',
    kind: 'tavily',
    needsKey: true,
    envVar: 'TAVILY_API_KEY',
    endpoint: 'https://api.tavily.com/search',
    get note() { return domainText('providers.tavilyNote') },
  },
  brave: {
    label: 'Brave Search API',
    kind: 'brave',
    needsKey: true,
    envVar: 'BRAVE_API_KEY',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    get note() { return domainText('providers.braveNote') },
  },
  bocha: {
    get label() { return domainText('providers.bocha') },
    kind: 'bocha',
    needsKey: true,
    envVar: 'BOCHA_API_KEY',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    get note() { return domainText('providers.bochaNote') },
  },
  searxng: {
    get label() { return domainText('providers.searxng') },
    kind: 'searxng',
    needsKey: false,
    envVar: 'SEARXNG_URL',
    endpoint: '',
    get note() { return domainText('providers.searxngNote') },
  },
  custom: {
    get label() { return domainText('providers.customSearch') },
    kind: 'custom',
    needsKey: false,
    get note() { return domainText('providers.customNote') },
  },
}

export const MEMORY_PROFILES = {
  off: {
    get label() { return domainText('providers.memoryOff') },
    get note() { return domainText('providers.memoryOffNote') },
    values: {
      memory: { enabled: false, extract: false, inject: false, retrieveTopK: 0 },
      dream: { enabled: false },
      proactive: { enabled: false },
      screen: { enabled: false },
    },
  },
  light: {
    get label() { return domainText('providers.light') },
    get note() { return domainText('providers.lightNote') },
    values: {
      memory: { enabled: true, extract: true, inject: true, retrieveTopK: 4 },
      dream: { enabled: false },
      proactive: { enabled: false },
      screen: { enabled: false },
    },
  },
  standard: {
    get label() { return domainText('providers.standard') },
    get note() { return domainText('providers.standardNote') },
    values: {
      memory: { enabled: true, extract: true, inject: true, retrieveTopK: 6 },
      dream: { enabled: true, intervalHours: 8 },
      proactive: { enabled: true, dailyBudget: 4 },
      screen: { enabled: false },
    },
  },
  deep: {
    get label() { return domainText('providers.deep') },
    get note() { return domainText('providers.deepNote') },
    values: {
      memory: { enabled: true, extract: true, inject: true, retrieveTopK: 8 },
      dream: { enabled: true, intervalHours: 6 },
      proactive: { enabled: true, dailyBudget: 5 },
      screen: { enabled: true, mode: 'ocr', intervalMinutes: 5 },
    },
  },
}

export const DEFAULT_SEARCH_ORDER = ['scrape', 'gateway']

export const searchBindingEnv = (id) => 'ECHO_SEARCH_BINDING_' + id.toUpperCase()

export function normalizeSearchConfig(search = {}) {
  const legacy = { auto: DEFAULT_SEARCH_ORDER, fast: ['scrape'], native: ['gateway'], off: ['none'], bing: ['scrape'] }
  const selected = Array.isArray(search.order) ? search.order : legacy[search.provider] ?? DEFAULT_SEARCH_ORDER
  const order = !selected.length || selected.includes('none') ? ['none'] : selected
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
    if (!ready) reason = domainText('providers.missingKey', envName)
  }
  if (spec.kind === 'searxng') {
    const url = conf.endpoint || envValue || ''
    ready = /^https?:\/\//.test(url)
    if (!ready) reason = domainText('providers.missingInstance')
  }
  if (spec.kind === 'custom') {
    ready = Boolean(conf.endpoint)
    if (!ready) reason = domainText('providers.missingEndpoint')
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
