import type { ForumPlatform, Post } from '../lib/types'
import { FORUM_SELECTORS, type ForumSelectors } from './selectors'

const MIN_POST_LENGTH = 10

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

  const id = `post_${position}_${author.slice(0, 30)}_${content.slice(0, 50)}`
  return { id, position, author, timestamp, content }
}
