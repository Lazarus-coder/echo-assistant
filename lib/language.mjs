export const APP_LANGUAGES = ['en', 'zh-CN']
let activeLanguage = 'zh-CN'

export function normalizeLanguage(value, fallback = 'zh-CN') {
  const tag = String(value ?? '').trim().replaceAll('_', '-').toLowerCase()
  if (/^zh(?:-|$)/.test(tag)) return 'zh-CN'
  if (/^en(?:-|$)/.test(tag)) return 'en'
  return fallback
}

export function setActiveLanguage(language) {
  activeLanguage = normalizeLanguage(language)
}

export function languageText(chinese, english, language = activeLanguage) {
  return language === 'en' ? english : chinese
}

export function translateTemplate(chinese, english, values) {
  const template = languageText(chinese, english)
  return values.length ? template.replace(/\{(\d+)\}/g, (_, index) => String(values[index])) : template
}
