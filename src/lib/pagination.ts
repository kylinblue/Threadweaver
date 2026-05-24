/**
 * Per-platform pagination metadata + URL derivation.
 *
 * The DOM-bound extractor (src/content/pagination.ts) produces a Pagination
 * with one of the schemes below. derivePageUrls turns it into the ordered URL
 * list a cross-page fetcher can walk.
 */

export type PageScheme =
  | { kind: 'none' }
  | { kind: 'phpbb-start'; postsPerPage: number }
  | { kind: 'xenforo-path' }
  | { kind: 'vbulletin-page' }
  | { kind: 'invision-path' }
  | { kind: 'mybb-path' }
  | { kind: 'smf-topic-offset'; postsPerPage: number }

export interface Pagination {
  currentPage: number
  totalPages: number
  /** URL with the page indicator stripped — used as IndexedDB key. */
  canonicalUrl: string
  scheme: PageScheme
  /**
   * Exact total post count if the platform exposes it in the DOM. Some forums
   * (phpBB) display "31 posts" in the topic action bar; others bury it. Falls
   * back to undefined — UI should estimate from posts × totalPages.
   */
  totalPosts?: number
}

/**
 * Return URLs for pages 1..totalPages in order. Page 1 is always canonicalUrl.
 */
export function derivePageUrls(pagination: Pagination): string[] {
  const { canonicalUrl, totalPages, scheme } = pagination
  if (totalPages <= 1 || scheme.kind === 'none') return [canonicalUrl]

  const urls: string[] = []
  for (let page = 1; page <= totalPages; page++) {
    urls.push(buildPageUrl(canonicalUrl, page, scheme))
  }
  return urls
}

function buildPageUrl(canonicalUrl: string, page: number, scheme: PageScheme): string {
  if (page === 1) return canonicalUrl
  const url = new URL(canonicalUrl)

  switch (scheme.kind) {
    case 'none':
      return canonicalUrl
    case 'phpbb-start': {
      url.searchParams.set('start', String((page - 1) * scheme.postsPerPage))
      return url.toString()
    }
    case 'xenforo-path': {
      const path = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'
      url.pathname = `${path}page-${page}`
      return url.toString()
    }
    case 'vbulletin-page': {
      url.searchParams.set('page', String(page))
      return url.toString()
    }
    case 'invision-path': {
      const path = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'
      url.pathname = `${path}page/${page}/`
      return url.toString()
    }
    case 'mybb-path': {
      // thread-NNN.html (page 1) → thread-NNN-page-N.html (page N).
      url.pathname = url.pathname.replace(/(thread-\d+)(\.html)$/, `$1-page-${page}$2`)
      return url.toString()
    }
    case 'smf-topic-offset': {
      // topic=594037.0 (page 1) → topic=594037.OFFSET where OFFSET = (page-1) * postsPerPage
      const topic = url.searchParams.get('topic')
      if (!topic) return canonicalUrl
      const baseTopic = topic.split('.')[0]
      url.searchParams.set('topic', `${baseTopic}.${(page - 1) * scheme.postsPerPage}`)
      return url.toString()
    }
  }
}
