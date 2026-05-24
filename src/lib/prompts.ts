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

Provide a concise summary highlighting the most important information.`

const META_SUMMARIZE_SYSTEM = `You are condensing multiple summaries of a forum thread into a single coherent summary.

Produce a unified summary that:
- Maintains all key information
- Removes redundancy
- Preserves chronological flow if relevant
- Highlights main themes and conclusions`

export function buildSummarizePostsMessages(
  posts: Post[],
  guidance: string = '',
): ChatMessage[] {
  const postsText = posts
    .map(
      (p) =>
        `Post #${p.position} by ${p.author}${p.timestamp ? ` (${p.timestamp})` : ''}:\n${p.content}`,
    )
    .join('\n\n')

  const userParts = [
    guidance ? `User guidance: ${guidance}\n` : '',
    `Posts to summarize:\n\n${postsText}`,
  ].filter(Boolean)

  return [
    { role: 'system', content: SUMMARIZE_SYSTEM },
    { role: 'user', content: userParts.join('\n') },
  ]
}

export function buildMetaSummarizeMessages(summaries: string[]): ChatMessage[] {
  const text = summaries
    .map((s, i) => `Summary ${i + 1}:\n${s}`)
    .join('\n\n---\n\n')

  return [
    { role: 'system', content: META_SUMMARIZE_SYSTEM },
    { role: 'user', content: `Previous summaries:\n\n${text}\n\nUnified summary:` },
  ]
}
