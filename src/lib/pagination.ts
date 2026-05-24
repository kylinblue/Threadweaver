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

export interface Pagination {
  currentPage: number
  totalPages: number
  /** URL with the page indicator stripped — used as IndexedDB key. */
  canonicalUrl: string
  scheme: PageScheme
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
  }
}
