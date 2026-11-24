import { translateTemplate } from './language.mjs'
import english from './locales/domain-en.mjs'
import chinese from './locales/domain-zh-CN.mjs'

// Interpolate after choosing the template. Values may contain original evidence,
// user-written text or machine identifiers and must pass through verbatim.
export function domainText(key, ...values) {
  return translateTemplate(chinese[key], english[key], values)
}

export function isDomainTemplate(key, value) {
  return value === english[key] || value === chinese[key]
}
