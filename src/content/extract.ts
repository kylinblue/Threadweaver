import type { ForumPlatform, Post } from '../lib/types'
import { FORUM_SELECTORS, type ForumSelectors } from './selectors'

const MIN_POST_LENGTH = 10
const MIN_IMAGE_DIM = 100
const MAX_IMAGES_PER_POST = 3

export function extractPosts(platform: ForumPlatform, doc: Document = document): Post[] {
  const selectors = FORUM_SELECTORS[platform === 'unknown' ? 'generic' : platform]
  const elements = Array.from(doc.querySelectorAll(selectors.post))

  const posts: Post[] = []
  const seenKeys = new Set<string>()

  elements.forEach((el, idx) => {
    const post = extractOne(el, idx + 1, selectors)
    if (!post) return
    if (post.content.length < MIN_POST_LENGTH) return
    const key = `${post.author}::${post.content.slice(0, 80)}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    posts.push(post)
  })

  return posts
}

function extractOne(
  el: Element,
  position: number,
  selectors: ForumSelectors,
): Post | null {
  const authorEl = el.querySelector(selectors.author)
  const author = authorEl?.textContent?.trim() || 'Unknown'

  const tsEl = el.querySelector(selectors.timestamp)
  const timestamp = tsEl?.getAttribute('datetime') || tsEl?.textContent?.trim() || ''

  const contentEl = el.querySelector(selectors.content) ?? el
  const clone = contentEl.cloneNode(true) as Element
  if (selectors.ignore) {
    clone.querySelectorAll(selectors.ignore).forEach((node) => node.remove())
  }
  const content = (clone.textContent ?? '').trim()
  if (!content) return null

  // Image URLs come from the LIVE DOM (clone loses dimensions). Re-scope to the
  // original content element and skip anything inside the ignore selector.
  const images = extractImages(contentEl, selectors.ignore)

  const id = `post_${position}_${author.slice(0, 30)}_${content.slice(0, 50)}`
  return {
    id,
    position,
    author,
    timestamp,
    content,
    ...(images.length > 0 && { images }),
  }
}

function extractImages(contentEl: Element, ignoreSelector: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  // Build ignore-element set so we can skip imgs nested inside (e.g. signature).
  const ignoreEls = new Set<Element>()
  if (ignoreSelector) {
    contentEl.querySelectorAll(ignoreSelector).forEach((el) => {
      ignoreEls.add(el)
      el.querySelectorAll('*').forEach((child) => ignoreEls.add(child))
    })
  }

  const imgs = contentEl.querySelectorAll<HTMLImageElement>('img')
  for (const img of imgs) {
    if (out.length >= MAX_IMAGES_PER_POST) break
    if (ignoreEls.has(img)) continue

    // Skip avatars/emoji/icons: when natural dimensions are available, both
    // must clear the threshold. Fall back to width/height attrs when not loaded.
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (w > 0 && h > 0 && (w < MIN_IMAGE_DIM || h < MIN_IMAGE_DIM)) continue

    const src = img.currentSrc || img.src
    if (!src) continue
    if (src.startsWith('data:')) continue // already inline; not worth re-fetching
    if (seen.has(src)) continue
    seen.add(src)
    out.push(src)
  }

  return out
}
