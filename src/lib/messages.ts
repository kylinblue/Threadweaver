import type { Pagination } from './pagination'
import type { ForumPlatform, Post } from './types'

/** Re-export for legacy import paths. */
export type PaginationInfo = Pagination

export type ContentRequest =
  | { type: 'GET_PAGE_TEXT' }
  | { type: 'GET_POSTS' }
  | { type: 'FETCH_PAGE_POSTS'; url: string }
  | { type: 'FETCH_IMAGE_BASE64'; url: string }

export type ContentResponse =
  | { type: 'PAGE_TEXT'; url: string; title: string; text: string }
  | {
      type: 'POSTS'
      url: string
      title: string
      platform: ForumPlatform
      posts: Post[]
      pagination: Pagination
    }
  | {
      type: 'FETCHED_POSTS'
      url: string
      posts: Post[]
      error?: string
    }
  | {
      type: 'FETCHED_IMAGE'
      url: string
      /** Base64-encoded image bytes (no data: prefix). Undefined on error. */
      base64?: string
      mimeType?: string
      error?: string
    }
