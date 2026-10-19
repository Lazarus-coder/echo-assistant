const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[process.env.ECHO_LOG_LEVEL] ?? LEVELS.info

function emit(level, args) {
  if (LEVELS[level] < threshold) return
  console.log(`${new Date().toISOString()} [${level}]`, ...args)
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
}
