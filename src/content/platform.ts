import type { ForumPlatform } from '../lib/types'

export function detectForumPlatform(
  doc: Document = document,
  loc: { hostname: string } = location,
): ForumPlatform {
  if (loc.hostname.includes('f-16.net')) return 'phpbb'

  if (doc.querySelector('html[data-template]') || doc.querySelector('.p-body-inner')) {
    return 'xenforo'
  }

  // MyBB before phpBB: MyBB also uses div.post wrappers but with id="post_N"
  // and distinctive .post_author + .post_body class names.
  if (doc.querySelector('.post_author') && doc.querySelector('.post_body')) return 'mybb'

  // SMF: body class is always action_<page> + a #forumposts wrapper.
  const bodyClass = doc.body?.className ?? ''
  if (/\baction_/.test(bodyClass) && doc.querySelector('#forumposts')) return 'smf'

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
  if (doc.querySelector('meta[name="generator"][content*="MyBB"]')) return 'mybb'
  if (doc.querySelector('meta[name="generator"][content*="SMF"]')) return 'smf'
  if (doc.querySelector('meta[name="generator"][content*="Discourse"]')) return 'discourse'
  if (doc.querySelector('meta[name="generator"][content*="Invision"]')) return 'invision'

  return 'generic'
}
