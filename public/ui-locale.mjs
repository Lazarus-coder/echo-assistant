import english from './locales/en.json' with { type: 'json' }
import chinese from './locales/zh-CN.json' with { type: 'json' }

const catalogs = { en: english, 'zh-CN': chinese }
const htmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Expand only explicit markers in packaged source, before user or model data
// reaches the browser. Escape for both layers when HTML is inside a JS literal.
export function localizeWebAsset(filename, source, language) {
  const messages = catalogs[language] ?? english
  return source.replace(/\{\{(html|msg):(\w+)\}\}/g, (marker, context, key) => {
    if (!Object.hasOwn(messages, key)) throw new Error('Unknown UI message: ' + key)
    let value = messages[key]
    if (context === 'html') value = value.replace(/[&<>"']/g, c => htmlEntities[c])
    if (filename.endsWith('.js')) {
      return JSON.stringify(value).slice(1, -1).replaceAll("'", '\\u0027')
        .replaceAll('`', '\\u0060').replaceAll('${', '\\u0024{')
    }
    return filename.endsWith('.webmanifest') ? JSON.stringify(value).slice(1, -1) : value
  })
}
