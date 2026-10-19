import { spawn } from 'node:child_process'
import { log } from './log.mjs'

/** Fire a macOS notification without requiring a bundled app. */
export function macNotify(title, message) {
  const script = `display notification ${aq(message)} with title ${aq(title)} sound name "Glass"`
  const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' })
  child.on('error', (err) => log.warn('通知失败', err.message))
}

function aq(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 200)}"`
}
