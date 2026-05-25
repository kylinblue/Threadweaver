export type ForumPlatform =
  | 'phpbb'
  | 'xenforo'
  | 'vbulletin'
  | 'mybb'
  | 'smf'
  | 'discourse'
  | 'invision'
  | 'generic'
  | 'unknown'

export interface Post {
  id: string
  position: number
  author: string
  timestamp: string
  content: string
  /** Absolute image URLs found inside the post content. Fetched + sent to
   *  the model only when the active model is vision-capable. */
  images?: string[]
}

export interface ThreadInfo {
  url: string
  title: string
  platform: ForumPlatform
  postCount: number
}
