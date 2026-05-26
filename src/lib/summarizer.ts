import { addSummary, getPostsByThread, putPosts, upsertThread } from './db'
import {
  buildMetaSummarizeMessages,
  buildSummarizePostsMessages,
} from './prompts'
import type { LLMProvider } from './providers/types'
import type { ForumPlatform, Post } from './types'
import {
  attachImagesToLastMessage,
  collectImages,
  collectImagesRoundRobin,
} from './vision'

export const DEFAULT_CHUNK_SIZE = 10
export const DEFAULT_META_THRESHOLD = 8
export const MAX_IMAGES_PER_CHUNK = 10
export const MAX_IMAGES_PER_META = 10
export const DEFAULT_CONCURRENCY = 1

/**
 * Token budgeting constants for adaptive chunking (Context Layer 3).
 *
 * INPUT_BUDGET_CAP — even when a model has 128K context, packing one giant
 * chunk degrades summary quality (long-context attention falls off). Cap
 * input per chunk to a sweet-spot value regardless of model size.
 *
 * OUTPUT_RESERVE — context the model needs for its response. Bullet
 * summaries are typically 200-500 tokens; 1024 is comfortable.
 *
 * PROMPT_OVERHEAD — system prompt + thread title + batch marker + safety
 * margin. Roughly measured at ~200 tokens; pad to 700.
 *
 * IMAGE_TOKEN_BUDGET — Ollama vision models budget ~256 tokens per image
 * (varies by model and tile count). We reserve this when vision is on.
 */
const INPUT_BUDGET_CAP = 8192
const OUTPUT_RESERVE = 1024
const PROMPT_OVERHEAD = 700
const IMAGE_TOKEN_BUDGET = 256

export interface SummarizeOptions {
  chunkSize?: number
  metaThreshold?: number
  model?: string
  abortSignal?: AbortSignal
  /** When set and the active model is vision-capable, called per image URL
   *  to retrieve base64-encoded bytes. Returns null/throws to skip an image. */
  fetchImage?: (url: string) => Promise<string | null>
  /**
   * Number of chunk requests in flight at once. Default 1 (serial).
   * LM Studio with Parallel ≥ 2 benefits from higher concurrency; Ollama by
   * default serializes per-model so concurrency > 1 just queues.
   */
  concurrency?: number
}

export type ProgressEvent =
  | { kind: 'started'; totalPosts: number; totalChunks: number }
  | {
      kind: 'chunk-started'
      chunkIndex: number
      totalChunks: number
      posts: number
      images?: number
    }
  | {
      kind: 'chunk-done'
      chunkIndex: number
      totalChunks: number
      summary: string
      postRangeStart: number
      postRangeEnd: number
    }
  | { kind: 'meta-started'; summaryCount: number }
  | { kind: 'meta-done'; summary: string }
  | { kind: 'final-started' }
  | { kind: 'final-done'; summary: string }

export interface ThreadContext {
  url: string
  title: string
  platform: ForumPlatform
}

export async function* summarizeThread(
  provider: LLMProvider,
  thread: ThreadContext,
  posts: Post[],
  opts: SummarizeOptions = {},
): AsyncGenerator<ProgressEvent, string, void> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  const metaThreshold = opts.metaThreshold ?? DEFAULT_META_THRESHOLD
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const model = opts.model ?? provider.defaultModel

  await upsertThread({
    url: thread.url,
    title: thread.title,
    platform: thread.platform,
    postCount: posts.length,
  })
  await putPosts(thread.url, posts)

  // One capability check per run — provider caches subsequent calls.
  const visionCapable =
    !!opts.fetchImage && !!(await provider.isVisionCapable?.(model))

  // Adaptive chunking by token budget — falls back to fixed chunkSize when
  // the provider doesn't expose context size.
  const maxCtx = await provider.getMaxContextTokens?.(model)
  const chunks = maxCtx
    ? await chunkPostsByBudget(
        posts,
        perChunkPostBudget(maxCtx, visionCapable),
        (text) => provider.countTokens(text, model),
      )
    : chunkPosts(posts, chunkSize)
  yield { kind: 'started', totalPosts: posts.length, totalChunks: chunks.length }

  // ---- Phase 1: per-chunk summaries (parallel-capable) -----------------
  //
  // Worker pool with concurrency limit. Each worker pulls the next chunk
  // index, runs the per-chunk summary, and pushes started/done events into
  // a queue that the outer async generator drains. We deliberately don't
  // do interleaved meta-summarize here — see Phase 2.
  const chunkSummaries: (string | null)[] = new Array(chunks.length).fill(null)

  const queue: ProgressEvent[] = []
  let queueResolver: (() => void) | null = null
  const emit = (e: ProgressEvent) => {
    queue.push(e)
    if (queueResolver) {
      const r = queueResolver
      queueResolver = null
      r()
    }
  }

  let nextIdx = 0
  let firstError: Error | null = null

  const runChunk = async (i: number): Promise<void> => {
    if (opts.abortSignal?.aborted) {
      throw new Error('Aborted')
    }
    const chunk = chunks[i]

    const imageBase64s =
      visionCapable && opts.fetchImage
        ? await collectImages(
            chunk,
            opts.fetchImage,
            MAX_IMAGES_PER_CHUNK,
            opts.abortSignal,
          )
        : []

    emit({
      kind: 'chunk-started',
      chunkIndex: i,
      totalChunks: chunks.length,
      posts: chunk.length,
      ...(imageBase64s.length > 0 && { images: imageBase64s.length }),
    })

    const baseMessages = buildSummarizePostsMessages(
      chunk,
      '',
      { index: i, total: chunks.length },
      thread.title,
    )
    const messages = attachImagesToLastMessage(baseMessages, imageBase64s)

    const res = await provider.generate(messages, {
      model,
      abortSignal: opts.abortSignal,
    })

    const postRangeStart = chunk[0].position
    const postRangeEnd = chunk[chunk.length - 1].position

    await addSummary({
      threadUrl: thread.url,
      kind: 'chunk',
      postRangeStart,
      postRangeEnd,
      content: res.text,
      model,
      providerId: provider.id,
    })

    chunkSummaries[i] = res.text
    emit({
      kind: 'chunk-done',
      chunkIndex: i,
      totalChunks: chunks.length,
      summary: res.text,
      postRangeStart,
      postRangeEnd,
    })
  }

  const worker = async (): Promise<void> => {
    while (true) {
      if (firstError) return
      const i = nextIdx++
      if (i >= chunks.length) return
      try {
        await runChunk(i)
      } catch (err) {
        firstError = err instanceof Error ? err : new Error(String(err))
        return
      }
    }
  }

  const workerCount = Math.min(concurrency, chunks.length)
  const workerPromises = Array.from({ length: workerCount }, worker)
  // Atomic teardown: flip workersDone BEFORE waking the queue resolver, so
  // the drain loop's next iteration sees the new value. Splitting these into
  // separate .finally and .then handlers caused the loop to wake while
  // workersDone was still false and re-await forever — single-chunk runs
  // would emit both events, drain, then deadlock waiting for a resolver
  // that had already fired.
  let workersDone = false
  void Promise.all(workerPromises).finally(() => {
    workersDone = true
    if (queueResolver) {
      const r = queueResolver
      queueResolver = null
      r()
    }
  })

  while (!workersDone || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!
    if (!workersDone) {
      await new Promise<void>((r) => {
        queueResolver = r
      })
    }
  }

  if (firstError) throw firstError

  // ---- Phase 2: meta-summarize (sequential, recursive halving) ---------
  //
  // All per-chunk summaries are in chunkSummaries (in original order).
  // If we only have one chunk, that's our final summary. Otherwise we
  // reduce via meta-summarize. For very long threads where N > metaThreshold,
  // recurse: split into groups of metaThreshold, meta each, then meta the
  // group-metas. Avoids stuffing too many summaries into one prompt.
  const summaries = chunkSummaries.filter((s): s is string => s !== null)

  if (summaries.length <= 1) {
    const final = summaries[0] ?? ''
    await addSummary({
      threadUrl: thread.url,
      kind: 'final',
      content: final,
      model,
      providerId: provider.id,
    })
    return final
  }

  // Pre-fetch images once for any meta passes that need them (Phase 2 doesn't
  // re-iterate posts; images are sampled across the whole thread).
  const metaImagesPromise =
    visionCapable && opts.fetchImage
      ? collectImagesRoundRobin(
          await getPostsByThread(thread.url),
          opts.fetchImage,
          MAX_IMAGES_PER_META,
          opts.abortSignal,
        )
      : Promise.resolve<string[]>([])

  const doMetaPass = async (
    inputs: string[],
    isFinal: boolean,
  ): Promise<string> => {
    const images = isFinal ? await metaImagesPromise : []
    const messages = attachImagesToLastMessage(
      buildMetaSummarizeMessages(inputs, thread.title),
      images,
    )
    const res = await provider.generate(messages, {
      model,
      abortSignal: opts.abortSignal,
    })
    return res.text
  }

  // Recursive halving: each pass groups summaries by metaThreshold, runs
  // meta-summarize on each group, and recurses until only one summary remains.
  let current = summaries
  while (current.length > metaThreshold) {
    yield { kind: 'meta-started', summaryCount: current.length }
    const groups: string[][] = []
    for (let i = 0; i < current.length; i += metaThreshold) {
      groups.push(current.slice(i, i + metaThreshold))
    }
    const groupMetas: string[] = []
    for (const g of groups) {
      const meta = await doMetaPass(g, false)
      groupMetas.push(meta)
      await addSummary({
        threadUrl: thread.url,
        kind: 'meta',
        content: meta,
        model,
        providerId: provider.id,
      })
    }
    current = groupMetas
    yield { kind: 'meta-done', summary: current[current.length - 1] ?? '' }
  }

  // Final meta over remaining summaries — also where vision images attach.
  yield { kind: 'final-started' }
  const finalText = await doMetaPass(current, true)
  await addSummary({
    threadUrl: thread.url,
    kind: 'final',
    content: finalText,
    model,
    providerId: provider.id,
  })
  yield { kind: 'final-done', summary: finalText }
  return finalText
}

function chunkPosts(posts: Post[], size: number): Post[][] {
  const chunks: Post[][] = []
  for (let i = 0; i < posts.length; i += size) {
    chunks.push(posts.slice(i, i + size))
  }
  return chunks
}

/**
 * Tokens we'll spend on post content per chunk. Total chunk budget is the
 * model's effective context minus reserves for output, prompt scaffolding,
 * and image payload tokens (when vision is on).
 */
function perChunkPostBudget(maxCtx: number, visionCapable: boolean): number {
  const inputBudget = Math.min(INPUT_BUDGET_CAP, maxCtx - OUTPUT_RESERVE)
  const imagesReserve = visionCapable ? MAX_IMAGES_PER_CHUNK * IMAGE_TOKEN_BUDGET : 0
  // Floor so a tiny-context model still gets *something*.
  return Math.max(512, inputBudget - PROMPT_OVERHEAD - imagesReserve)
}

/**
 * Pack posts into chunks that each fit a token budget. A single oversized
 * post still becomes its own chunk (Ollama's sliding window may truncate it,
 * which is no worse than today's behavior).
 */
async function chunkPostsByBudget(
  posts: Post[],
  budget: number,
  countTokens: (text: string) => Promise<number>,
): Promise<Post[][]> {
  const chunks: Post[][] = []
  let current: Post[] = []
  let currentTokens = 0

  for (const post of posts) {
    const text =
      `Post #${post.position} by ${post.author}${post.timestamp ? ` (${post.timestamp})` : ''}:\n${post.content}`
    const tokens = await countTokens(text)

    if (current.length === 0) {
      current.push(post)
      currentTokens = tokens
    } else if (currentTokens + tokens > budget) {
      chunks.push(current)
      current = [post]
      currentTokens = tokens
    } else {
      current.push(post)
      currentTokens += tokens
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
