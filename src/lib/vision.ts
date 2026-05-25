import type { ChatMessage } from './providers/types'
import type { Post } from './types'

/**
 * Image-collection helpers shared by all summarize/query paths that send
 * vision-capable models image data. Both helpers fetch base64-encoded bytes
 * via the caller-supplied `fetchImage` (typically routed through the active
 * tab's content script so forum session cookies attach).
 *
 * Both silently skip URLs whose fetch fails — bad images shouldn't break a
 * summary/answer; the model gets fewer images and continues.
 */

export type FetchImage = (url: string) => Promise<string | null>

/**
 * Walk posts in order, take images in their per-post order, stop at `cap`.
 * Use for chunk-summarize (posts already form the natural ordering) and Ask
 * (relevant posts already ranked by relevance).
 */
export async function collectImages(
  posts: Post[],
  fetchImage: FetchImage,
  cap: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = []
  outer: for (const p of posts) {
    for (const url of p.images ?? []) {
      if (out.length >= cap) break outer
      if (signal?.aborted) return out
      try {
        const b64 = await fetchImage(url)
        if (b64) out.push(b64)
      } catch { /* skip */ }
    }
  }
  return out
}

/**
 * Round-robin one image per post per "lap" until `cap` reached. Use for
 * meta-summarize where there's no natural post-level ordering and breadth
 * across the thread matters more than depth into any single post.
 *
 * Lap 0 takes the first image from each post that has one; lap 1 takes the
 * second; etc. Exits early when the cap is reached or no post has more images.
 */
/**
 * Attach base64 images to the last message in the array, and append a count
 * marker to its content text. The marker ("[N images attached for context]")
 * gives the model an explicit count so it doesn't have to enumerate them
 * itself — LLMs are notoriously bad at counting visual items.
 *
 * No-op when images is empty.
 */
export function attachImagesToLastMessage(
  messages: ChatMessage[],
  images: string[],
): ChatMessage[] {
  if (images.length === 0) return messages
  const marker = `\n\n[${images.length} image${images.length === 1 ? '' : 's'} attached for context]`
  return messages.map((m, idx) =>
    idx === messages.length - 1
      ? { ...m, content: m.content + marker, images }
      : m,
  )
}

export async function collectImagesRoundRobin(
  posts: Post[],
  fetchImage: FetchImage,
  cap: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = []
  const maxPerPost = posts.reduce(
    (m, p) => Math.max(m, p.images?.length ?? 0),
    0,
  )
  for (let lap = 0; lap < maxPerPost && out.length < cap; lap++) {
    for (const p of posts) {
      if (out.length >= cap) break
      if (signal?.aborted) return out
      const url = p.images?.[lap]
      if (!url) continue
      try {
        const b64 = await fetchImage(url)
        if (b64) out.push(b64)
      } catch { /* skip */ }
    }
  }
  return out
}
