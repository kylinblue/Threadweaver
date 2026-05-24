import type { ForumPlatform } from '../lib/types'

export function detectForumPlatform(
  doc: Document = document,
  loc: { hostname: string } = location,
): ForumPlatform {
  if (loc.hostname.includes('f-16.net')) return 'phpbb'

  if (doc.querySelector('html[data-template]') || doc.querySelector('.p-body-inner')) {
    return 'xenforo'
  }

  if (doc.querySelector('#phpbb') || (doc.querySelector('.post') && doc.querySelector('p.author'))) {
    return 'phpbb'
  }

  if (doc.querySelector('.vbulletin-body')) return 'vbulletin'
  if (doc.querySelector('.ember-application')) return 'discourse'

  if (doc.querySelector('body[data-controller]') && doc.querySelector('.ipsApp')) {
    return 'invision'
  }

  if (doc.querySelector('meta[name="generator"][content*="phpBB"]')) return 'phpbb'
  if (doc.querySelector('meta[name="generator"][content*="vBulletin"]')) return 'vbulletin'
  if (doc.querySelector('meta[name="generator"][content*="Discourse"]')) return 'discourse'
  if (doc.querySelector('meta[name="generator"][content*="Invision"]')) return 'invision'

  return 'generic'
}
