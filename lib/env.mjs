import { promises as fs } from 'node:fs'

/**
 * Load `KEY=value` lines into process.env without ever logging the values.
 * Existing real env vars win so launchd/shell overrides are respected.
 */
export async function loadEnvFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return { loaded: false, keys: [] }
  }
  const keys = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const [, key] = m
    let value = m[2].trim()
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined && value !== '') {
      process.env[key] = value
      keys.push(key)
    } else if (value === '') {
      keys.push(key)
    }
  }
  return { loaded: true, keys }
}
