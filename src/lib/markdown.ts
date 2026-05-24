import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: true,
})

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr',
  'strong', 'em', 'del', 'code', 'pre',
  'ul', 'ol', 'li',
  'blockquote',
  'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

const ALLOWED_ATTR = ['href', 'title']

// Ensure any anchor links open in a new tab without leaking opener context.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/**
 * Render trusted-ish LLM markdown to sanitised HTML.
 *
 * Tag/attr allowlist is intentionally narrow: no script, no style, no event
 * handlers, no img (LLM-supplied URLs aren't worth the request-leak risk).
 * Links keep href but rely on DOMPurify's default URI scheme allowlist
 * (http/https/mailto/tel) — that blocks javascript: out of the box.
 */
export function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR: ['target', 'rel'],
  })
}
