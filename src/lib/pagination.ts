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

export type AnalysisScope =
  | { kind: 'this-page' }
  | { kind: 'bookend'; postsPerSide: number }
  | { kind: 'last'; postCount: number }
  | { kind: 'all' }
  | { kind: 'manual'; startPost: number; endPost: number }

export interface ScopeSelection {
  /** 1-based page numbers we'll fetch (excluding the current page, which we
   *  already have rendered). May be empty for 'this-page'. */
  pages: number[]
  /** Indicates the result skips the middle of the thread, so the summarizer
   *  can tell the model about the gap. */
  hasMiddleGap: boolean
  /** For 'manual' scope, the requested post-number range (1-based, thread-
   *  global). Caller uses this to filter+renumber the merged fetch result. */
  manualRange?: { startPost: number; endPost: number; pageOffset: number }
}

/**
 * Map an AnalysisScope to a concrete set of page numbers to fetch. Caller
 * provides current page so we don't re-fetch what's already in the DOM.
 */
export function resolveScope(
  scope: AnalysisScope,
  pagination: Pagination,
  postsOnCurrentPage: number,
): ScopeSelection {
  const { totalPages, currentPage } = pagination

  if (scope.kind === 'this-page' || totalPages <= 1) {
    return { pages: [], hasMiddleGap: false }
  }
  if (scope.kind === 'all') {
    const pages: number[] = []
    for (let p = 1; p <= totalPages; p++) if (p !== currentPage) pages.push(p)
    return { pages, hasMiddleGap: false }
  }

  // Derive posts-per-page from current page count (estimate). Works for the
  // common case where current page is a "full" page; degrades to ~15
  // (phpBB-default) for last-page-only views.
  const ppp = Math.max(1, postsOnCurrentPage || 15)

  if (scope.kind === 'last') {
    const pagesNeeded = Math.ceil(scope.postCount / ppp)
    const firstWanted = Math.max(1, totalPages - pagesNeeded + 1)
    const pages: number[] = []
    for (let p = firstWanted; p <= totalPages; p++) if (p !== currentPage) pages.push(p)
    return { pages, hasMiddleGap: firstWanted > 1 }
  }

  if (scope.kind === 'manual') {
    // Clamp the requested range to sensible bounds. ppp-based math means we
    // overshoot slightly in either direction (fetch a page even if only one
    // post of it is in range) — caller filters precisely after fetch.
    const start = Math.max(1, Math.min(scope.startPost, scope.endPost))
    const end = Math.max(start, scope.endPost)
    const startPage = Math.max(1, Math.min(totalPages, Math.ceil(start / ppp)))
    const endPage = Math.max(startPage, Math.min(totalPages, Math.ceil(end / ppp)))
    const pages: number[] = []
    for (let p = startPage; p <= endPage; p++) {
      if (p !== currentPage) pages.push(p)
    }
    return {
      pages,
      hasMiddleGap: startPage > 1 || endPage < totalPages,
      manualRange: {
        startPost: start,
        endPost: end,
        pageOffset: (startPage - 1) * ppp,
      },
    }
  }

  // bookend: first M + last M pages
  const m = Math.max(1, Math.ceil(scope.postsPerSide / ppp))
  const wanted = new Set<number>()
  for (let p = 1; p <= Math.min(m, totalPages); p++) wanted.add(p)
  for (let p = Math.max(1, totalPages - m + 1); p <= totalPages; p++) wanted.add(p)
  wanted.delete(currentPage)
  const pages = [...wanted].sort((a, b) => a - b)
  // Gap exists when the middle isn't covered.
  const hasMiddleGap = m * 2 < totalPages
  return { pages, hasMiddleGap }
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
