import { log } from '../lib/log'
import type { ContentRequest, ContentResponse } from '../lib/messages'
import { extractPosts } from './extract'
import { extractPagination } from './pagination'
import { detectForumPlatform } from './platform'

const platform = detectForumPlatform()
log.info(`[ThreadWeaver] forum platform: ${platform} (${location.host})`)

chrome.runtime.onMessage.addListener(
  (req: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
    if (req.type === 'GET_PAGE_TEXT') {
      sendResponse({
        type: 'PAGE_TEXT',
        url: location.href,
        title: document.title,
        text: document.body?.innerText ?? '',
      })
      return true
    }
    if (req.type === 'GET_POSTS') {
      const posts = extractPosts(platform)
      const pagination = extractPagination(platform)
      sendResponse({
        type: 'POSTS',
        url: location.href,
        title: document.title,
        platform,
        posts,
        pagination,
      })
      return true
    }
    if (req.type === 'FETCH_PAGE_POSTS') {
      // Fetch another page of the same thread using the page's cookies, then
      // run our extractor against the response HTML. Async — return true to
      // keep the message channel open until sendResponse fires.
      const url = req.url
      void fetchPagePosts(url)
        .then((posts) => sendResponse({ type: 'FETCHED_POSTS', url, posts }))
        .catch((err) => {
          sendResponse({
            type: 'FETCHED_POSTS',
            url,
            posts: [],
            error: err instanceof Error ? err.message : String(err),
          })
        })
      return true
    }
    if (req.type === 'FETCH_IMAGE_BASE64') {
      const url = req.url
      void fetchImageBase64(url)
        .then(({ base64, mimeType }) =>
          sendResponse({ type: 'FETCHED_IMAGE', url, base64, mimeType }),
        )
        .catch((err) => {
          sendResponse({
            type: 'FETCHED_IMAGE',
            url,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      return true
    }
    return undefined
  },
)

async function fetchPagePosts(url: string) {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return extractPosts(platform, doc)
}

const MAX_IMAGE_BYTES = 512 * 1024 // raw binary; base64 grows ~33%

// MIMEs we'll forward to Ollama. Narrowed to JPEG + PNG only:
// - GIF: animated frames make Ollama's vision pipeline 500
// - WebP: animated (VP8X) variants 500 for the same reason; sniff can't
//   reliably distinguish single-frame from animated without parsing chunks
// - SVG: vector, no value to a vision model
// - HEIC/AVIF: variable Ollama support
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
])

async function fetchImageBase64(
  url: string,
): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${blob.size} bytes)`)
  }

  // Stage 1: claimed MIME from server. Cheap reject before reading buffer.
  const claimedMime = (blob.type || '').split(';')[0].trim().toLowerCase()
  if (claimedMime && !ALLOWED_MIME.has(claimedMime)) {
    throw new Error(`unsupported mime: ${claimedMime}`)
  }

  const buf = new Uint8Array(await blob.arrayBuffer())

  // Stage 2: magic-byte sniff. Authoritative — servers routinely lie about
  // content-type (404 HTML pages served as image/jpeg, etc.). Without this we
  // pass garbage to Ollama and it 500s the whole chunk.
  const sniffed = sniffImageFormat(buf)
  if (!sniffed) throw new Error('not a recognized image format')

  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  log.info(
    `[ThreadWeaver] image attached: ${sniffed} ${buf.length}B  ${url}`,
  )
  return { base64: btoa(bin), mimeType: sniffed }
}

function sniffImageFormat(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return 'image/png'
  }
  // GIF and WebP deliberately not recognized — see ALLOWED_MIME comment.
  return null
}
