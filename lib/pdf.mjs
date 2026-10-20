import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const MAX_BYTES = 5 * 1024 * 1024

/** Parse untrusted PDFs off the server thread, without the viewer/scripting layer. */
export async function extractPdf(buffer, { signal, maxPages = 40, maxChars = 120000, timeoutMs = 15000 } = {}) {
  signal?.throwIfAborted()
  if (!(buffer instanceof Uint8Array) || !buffer.length || buffer.length > MAX_BYTES) throw new Error('PDF 须小于 5 MiB')
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 80 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) throw new Error('PDF 读取预算无效')
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { bytes: buffer, maxPages, maxChars }, env: {},
    resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
  })
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => finish(signal.reason ?? new DOMException('已取消', 'AbortError'))
      const timer = setTimeout(() => finish(new Error('PDF 解析超时')), Math.min(15000, Math.max(1, timeoutMs)))
      const finish = (error, value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      worker.once('message', (message) => finish(message.error ? new Error(message.error) : null, message.result))
      worker.once('error', (error) => finish(error))
      worker.once('exit', (code) => { if (code) finish(new Error('PDF 解析超过资源限制或意外退出')) })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally {
    await worker.terminate()
  }
}

if (!isMainThread && workerData?.bytes) {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = getDocument({
      data: new Uint8Array(workerData.bytes),
      isEvalSupported: false, useWorkerFetch: false, disableFontFace: true,
      useSystemFonts: false, stopAtErrors: true, verbosity: 0,
    })
    const document = await loading.promise
    try {
      if (document.numPages > workerData.maxPages) throw new Error(`PDF 超过 ${workerData.maxPages} 页，请分享相关页`)
      const pages = []
      let remaining = workerData.maxChars
      let truncated = false
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber)
        const content = await page.getTextContent()
        let text = ''
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue
          text += `${item.str}${item.hasEOL ? '\n' : ' '}`
          if (text.length > remaining) { truncated = true; break }
        }
        text = text.slice(0, remaining).trim()
        pages.push({ page: pageNumber, text })
        remaining -= text.length
        page.cleanup()
        if (remaining <= 0) { truncated ||= pageNumber < document.numPages; break }
      }
      const text = pages.map((page) => `[第 ${page.page} 页]\n${page.text}`).join('\n\n')
      if (!pages.some((page) => page.text.trim())) throw new Error('PDF 没有可提取文字；请分享文字版本或清晰截图')
      parentPort.postMessage({ result: { text, pages, totalPages: document.numPages, truncated } })
    } finally {
      await loading.destroy()
    }
  } catch (error) {
    parentPort.postMessage({ error: String(error.message).slice(0, 300) })
  }
}
