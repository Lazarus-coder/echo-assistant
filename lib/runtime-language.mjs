import { translateTemplate } from './language.mjs'
import english from './locales/runtime-en.mjs'
import chinese from './locales/runtime-zh-CN.mjs'

export function runtimeText(key, ...values) {
  return translateTemplate(chinese[key], english[key], values)
}
