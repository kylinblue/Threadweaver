export type ForumPlatform =
  | 'phpbb'
  | 'xenforo'
  | 'vbulletin'
  | 'discourse'
  | 'invision'
  | 'unknown'

export function detectForumPlatform(doc: Document = document): ForumPlatform {
  const html = doc.documentElement
  const body = doc.body

  if (doc.querySelector('meta[name="generator"][content*="phpBB"]')) return 'phpbb'
  if (html?.classList.contains('xenforo') || doc.querySelector('html.xf-')) return 'xenforo'
  if (doc.querySelector('meta[name="generator"][content*="vBulletin"]')) return 'vbulletin'
  if (body?.id === 'vbulletin_html') return 'vbulletin'
  if (doc.querySelector('meta[name="generator"][content*="Discourse"]')) return 'discourse'
  if (doc.querySelector('meta[name="application-name"][content*="Discourse"]')) return 'discourse'
  if (doc.querySelector('meta[name="generator"][content*="Invision"]')) return 'invision'

  return 'unknown'
}
