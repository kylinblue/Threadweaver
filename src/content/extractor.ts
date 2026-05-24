import type { ContentRequest, ContentResponse } from '../lib/messages'
import { extractPosts } from './extract'
import { extractPagination } from './pagination'
import { detectForumPlatform } from './platform'

const platform = detectForumPlatform()
console.log(`[ThreadWeaver] forum platform: ${platform} (${location.host})`)

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
