import type { ForumPlatform, Post } from './types'

export type ContentRequest =
  | { type: 'GET_PAGE_TEXT' }
  | { type: 'GET_POSTS' }

export type ContentResponse =
  | { type: 'PAGE_TEXT'; url: string; title: string; text: string }
  | {
      type: 'POSTS'
      url: string
      title: string
      platform: ForumPlatform
      posts: Post[]
    }
