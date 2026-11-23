import { networkInterfaces } from 'node:os'

export function bindAddress(mode, requirePassword, passwordSet) {
  return mode === 'all' && (passwordSet || requirePassword !== true) ? '0.0.0.0' : '127.0.0.1'
}

export function describeListener({ address, port }, interfaces = networkInterfaces) {
  const bind = address === '0.0.0.0' ? 'all' : 'local'
  const addresses = []
  if (bind === 'all') {
    for (const [name, rows] of Object.entries(interfaces())) {
      for (const row of rows ?? []) {
        if (row.family !== 'IPv4' || row.internal || /^(?:169\.254|198\.1[89])\./.test(row.address)) continue
        addresses.push({ ip: row.address, name })
      }
    }
    addresses.sort((a, b) => Number(b.name === 'en0') - Number(a.name === 'en0'))
  }
  return { bind, address, port, lanAddresses: addresses.map(({ ip, name }) => `${ip} (${name})`),
    lanUrl: addresses.length ? `http://${addresses[0].ip}:${port}` : null }
}
