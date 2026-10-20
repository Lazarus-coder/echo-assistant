import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { P, upstreamCreds } from './config.mjs'
import { log } from './log.mjs'

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function parseDataUrl(dataUrl) {
  const m = /^data:([\w./+-]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''))
  if (!m) return null
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }
}

/** Persist an image (data URL or remote URL) under data/uploads, return its served path. */
export async function saveImage({ dataUrl, url, prefix = 'img', name, signal }) {
  signal?.throwIfAborted()
  let buffer
  let mime = 'image/png'
  if (dataUrl) {
    const parsed = parseDataUrl(dataUrl)
    if (!parsed) throw new Error('图片数据格式不对')
    buffer = parsed.buffer
    mime = parsed.mime
  } else if (url) {
    // 出图结果是几 MB 的 OSS 对象，走代理可能要几十秒，超时给宽一点并重试一次
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted()
      try {
        const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        mime = (res.headers.get('content-type') ?? 'image/png').split(';')[0]
        buffer = Buffer.from(await res.arrayBuffer())
        signal?.throwIfAborted()
        lastErr = null
        break
      } catch (err) {
        signal?.throwIfAborted()
        if (err?.name === 'AbortError') throw err
        lastErr = err
        log.warn(`下载图片失败（第 ${attempt + 1} 次）:`, err.message)
      }
    }
    if (lastErr) throw new Error(`下载图片失败: ${lastErr.message}`)
    if (!buffer?.length) throw new Error('下载到的图片是空的')
  } else {
    throw new Error('缺少图片内容')
  }
  signal?.throwIfAborted()
  await fs.mkdir(P.uploads, { recursive: true })
  signal?.throwIfAborted()
  const ext = EXT_BY_MIME[mime] ?? 'png'
  const base = (name ?? prefix).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || prefix
  const file = `${base}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}.${ext}`
  const destination = path.join(P.uploads, file)
  try {
    await fs.writeFile(destination, buffer, { signal })
    signal?.throwIfAborted()
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => {})
    throw error
  }
  return { path: `/api/uploads/${file}`, file, mime, bytes: buffer.length }
}

export async function readImageAsDataUrl(servedPath) {
  const file = path.basename(String(servedPath))
  const buf = await fs.readFile(path.join(P.uploads, file))
  const ext = path.extname(file).slice(1).toLowerCase()
  const mime = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext)?.[0] ?? 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/* ----------------------------- image generation ---------------------------- */

/**
 * The gateway routes image models through chat/completions but answers with the
 * DashScope shape: {output:{choices:[{message:{content:[{type:'image',image:url}]}}]}}.
 */
export async function generateImage({ prompt, model, conversationId, signal }) {
  signal?.throwIfAborted()
  const { apiKey, baseUrl } = upstreamCreds()
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY')
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('请描述要画什么')
  const started = Date.now()
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
  })
  const raw = await res.text()
  signal?.throwIfAborted()
  if (!res.ok) throw new Error(`出图失败 HTTP ${res.status}: ${raw.slice(0, 200)}`)
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`出图返回无法解析: ${raw.slice(0, 160)}`)
  }
  const content = data.output?.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.content ?? []
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }]
  const remote = parts.find((p) => p?.type === 'image' && p.image)?.image ?? null
  const note = parts.filter((p) => p?.type === 'text' && p.text).map((p) => p.text).join(' ').trim()
  if (!remote) throw new Error(`没有拿到图片${note ? `：${note}` : ''}`)
  // 出图链接带签名会过期，落盘保平安
  const saved = await saveImage({ url: remote, prefix: 'gen', signal })
  log.info(`出图完成 ${model} ${Date.now() - started}ms ${saved.bytes}B`)
  return { remote, ...saved, usage: data.usage ?? null, prompt: text, model, ms: Date.now() - started, conversationId }
}

export async function buildImageParts(images = [], cfg) {
  const max = cfg?.media?.maxImagesPerMessage ?? 4
  const parts = []
  for (const img of images.slice(0, max)) {
    const ref = typeof img === 'string' ? img : img?.url
    if (!ref) continue
    if (/^https?:\/\//.test(ref)) {
      parts.push({ type: 'image_url', image_url: { url: ref } })
      continue
    }
    try {
      const dataUrl = await readImageAsDataUrl(ref)
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    } catch (err) {
      log.warn(`读取图片失败 ${ref}:`, err.message)
    }
  }
  return parts
}
