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
    return undefined
  },
)
