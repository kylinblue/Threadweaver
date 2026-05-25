import { addSummary, putPosts, upsertThread } from './db'
import {
  buildMetaSummarizeMessages,
  buildSummarizePostsMessages,
} from './prompts'
import type { LLMProvider } from './providers/types'
import type { ForumPlatform, Post } from './types'

export const DEFAULT_CHUNK_SIZE = 10
export const DEFAULT_META_THRESHOLD = 8

export interface SummarizeOptions {
  chunkSize?: number
  metaThreshold?: number
  model?: string
  abortSignal?: AbortSignal
}

export type ProgressEvent =
  | { kind: 'started'; totalPosts: number; totalChunks: number }
  | {
      kind: 'chunk-started'
      chunkIndex: number
      totalChunks: number
      posts: number
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
  const model = opts.model ?? provider.defaultModel

  await upsertThread({
    url: thread.url,
    title: thread.title,
    platform: thread.platform,
    postCount: posts.length,
  })
  await putPosts(thread.url, posts)

  const chunks = chunkPosts(posts, chunkSize)
  yield { kind: 'started', totalPosts: posts.length, totalChunks: chunks.length }

  let chunkSummaries: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    if (opts.abortSignal?.aborted) throw new Error('Aborted')

    const chunk = chunks[i]
    yield {
      kind: 'chunk-started',
      chunkIndex: i,
      totalChunks: chunks.length,
      posts: chunk.length,
    }

    const messages = buildSummarizePostsMessages(
      chunk,
      '',
      { index: i, total: chunks.length },
      thread.title,
    )
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

    chunkSummaries.push(res.text)
    yield {
      kind: 'chunk-done',
      chunkIndex: i,
      totalChunks: chunks.length,
      summary: res.text,
      postRangeStart,
      postRangeEnd,
    }

    if (chunkSummaries.length >= metaThreshold) {
      yield { kind: 'meta-started', summaryCount: chunkSummaries.length }
      const meta = await provider.generate(
        buildMetaSummarizeMessages(chunkSummaries, thread.title),
        { model, abortSignal: opts.abortSignal },
      )
      await addSummary({
        threadUrl: thread.url,
        kind: 'meta',
        content: meta.text,
        model,
        providerId: provider.id,
      })
      chunkSummaries = [meta.text]
      yield { kind: 'meta-done', summary: meta.text }
    }
  }

  if (chunkSummaries.length <= 1) {
    const final = chunkSummaries[0] ?? ''
    await addSummary({
      threadUrl: thread.url,
      kind: 'final',
      content: final,
      model,
      providerId: provider.id,
    })
    return final
  }

  yield { kind: 'final-started' }
  const finalRes = await provider.generate(
    buildMetaSummarizeMessages(chunkSummaries, thread.title),
    { model, abortSignal: opts.abortSignal },
  )
  await addSummary({
    threadUrl: thread.url,
    kind: 'final',
    content: finalRes.text,
    model,
    providerId: provider.id,
  })
  yield { kind: 'final-done', summary: finalRes.text }
  return finalRes.text
}

function chunkPosts(posts: Post[], size: number): Post[][] {
  const chunks: Post[][] = []
  for (let i = 0; i < posts.length; i += size) {
    chunks.push(posts.slice(i, i + size))
  }
  return chunks
}
