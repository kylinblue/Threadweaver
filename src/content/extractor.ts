import type { ContentRequest, ContentResponse } from '../lib/messages'
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
    return undefined
  },
)
