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
}

export interface ThreadInfo {
  url: string
  title: string
  platform: ForumPlatform
  postCount: number
}
