import type { Post } from './types'
import type { ChatMessage } from './providers/types'

const SUMMARIZE_SYSTEM = `You are analyzing a forum thread. Summarize the posts the user provides concisely.

Focus on:
- Key information, solutions, and insights
- Technical details and recommendations
- Problems identified and approaches discussed
- Consensus or disagreements

Ignore:
- Off-topic banter
- "+1" or "thanks" posts without substance
- Duplicate information

Provide a concise summary highlighting the most important information. Do not editorialize about whether the thread looks complete or whether more context would help — just summarize what you are given. Begin your response directly with the summary content; do not include preambles like "Okay, let me analyze" or "Here's the summary".`

const META_SUMMARIZE_SYSTEM = `You are condensing multiple summaries of a forum thread into a single coherent summary.

Produce a unified summary that:
- Maintains all key information
- Removes redundancy
- Preserves chronological flow if relevant
- Highlights main themes and conclusions

Begin your response directly with the unified summary; do not include preambles.`

export interface BatchInfo {
  /** 0-based index of this batch. */
  index: number
  /** Total number of batches the thread will be split into. */
  total: number
}

function titleLine(title?: string): string {
  return title ? `Thread title: "${title}"\n` : ''
}

export function buildSummarizePostsMessages(
  posts: Post[],
  guidance: string = '',
  batch?: BatchInfo,
  threadTitle?: string,
): ChatMessage[] {
  const postsText = posts
    .map(
      (p) =>
        `Post #${p.position} by ${p.author}${p.timestamp ? ` (${p.timestamp})` : ''}:\n${p.content}`,
    )
    .join('\n\n')

  // Tell the model when it's seeing a chunk so it doesn't editorialize about
  // missing context ("unfortunately the thread is incomplete..."). A separate
  // meta-summarization pass will combine the per-batch summaries later.
  const batchLine =
    batch && batch.total > 1
      ? `This is batch ${batch.index + 1} of ${batch.total} from a longer thread. Summarize only these posts faithfully — earlier and later batches are handled separately.\n`
      : ''

  const userParts = [
    titleLine(threadTitle),
    batchLine,
    guidance ? `User guidance: ${guidance}\n` : '',
    `Posts to summarize:\n\n${postsText}`,
  ].filter(Boolean)

  return [
    { role: 'system', content: SUMMARIZE_SYSTEM },
    { role: 'user', content: userParts.join('\n') },
  ]
}

export function buildMetaSummarizeMessages(
  summaries: string[],
  threadTitle?: string,
): ChatMessage[] {
  const text = summaries
    .map((s, i) => `Summary ${i + 1}:\n${s}`)
    .join('\n\n---\n\n')

  return [
    { role: 'system', content: META_SUMMARIZE_SYSTEM },
    {
      role: 'user',
      content: `${titleLine(threadTitle)}Previous summaries:\n\n${text}\n\nUnified summary:`,
    },
  ]
}

const ANSWER_QUERY_SYSTEM = `You are helping a user understand a forum thread.

Use the thread summary and the supplied relevant posts to answer the user's question. Cite specific posts when relevant (e.g., "In post #42, user X mentioned…"). If the answer is not present in the supplied context, say so plainly rather than guessing. Begin your response directly with the answer; do not include preambles like "Okay, let me think about this" or "Sure, here's the answer".`

export function buildAnswerQueryMessages(
  query: string,
  summary: string,
  relevantPosts: Post[],
  threadTitle?: string,
): ChatMessage[] {
  const postsBlock = relevantPosts.length
    ? '\n\nRelevant posts:\n' +
      relevantPosts
        .map(
          (p) =>
            `Post #${p.position} by ${p.author}${p.timestamp ? ` (${p.timestamp})` : ''}:\n${p.content}`,
        )
        .join('\n\n')
    : ''

  const userContent = `${titleLine(threadTitle)}Thread summary:
${summary || '(no summary available yet)'}${postsBlock}

User question: ${query}`

  return [
    { role: 'system', content: ANSWER_QUERY_SYSTEM },
    { role: 'user', content: userContent },
  ]
}
