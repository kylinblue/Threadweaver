import type { Pagination } from '../lib/pagination'
import type { ForumPlatform } from '../lib/types'

export function extractPagination(
  platform: ForumPlatform,
  doc: Document = document,
  loc: { href: string } = location,
): Pagination {
  const url = new URL(loc.href)
  switch (platform) {
    case 'phpbb': return phpbb(doc, url)
    case 'xenforo': return xenforo(doc, url)
    case 'vbulletin': return vbulletin(doc, url)
    case 'invision': return invision(doc, url)
    case 'mybb': return mybb(doc, url)
    case 'smf': return smf(doc, url)
    // Discourse uses infinite scroll, not paginated URLs. Treat as single page.
    case 'discourse':
    case 'generic':
    case 'unknown':
    default:
      return {
        currentPage: 1,
        totalPages: 1,
        canonicalUrl: url.toString(),
        scheme: { kind: 'none' },
      }
  }
}

// ---------- phpBB ----------
// URL: viewtopic.php?f=2&t=60254[&start=15]   start = (page-1) * postsPerPage
function phpbb(doc: Document, url: URL): Pagination {
  const canonical = new URL(url.toString())
  canonical.searchParams.delete('start')

  const currentStart = intParam(url, 'start', 0)
  const starts = collectStartValues(doc, url, [0, currentStart])

  // Derive postsPerPage from the smallest non-zero start; fall back to 15.
  const sorted = [...starts].sort((a, b) => a - b)
  const postsPerPage = sorted.find((s) => s > 0) ?? 15
  const maxStart = sorted[sorted.length - 1]

  // phpBB shows "31 posts" inside .topic-actions .pagination (direct text).
  const actionsText =
    doc.querySelector('.topic-actions .pagination')?.textContent ?? ''
  const postsMatch = actionsText.match(/(\d+)\s+posts?\b/i)
  const totalPosts = postsMatch ? parseInt(postsMatch[1], 10) : undefined

  return {
    currentPage: Math.floor(currentStart / postsPerPage) + 1,
    totalPages: Math.floor(maxStart / postsPerPage) + 1,
    canonicalUrl: canonical.toString(),
    scheme: { kind: 'phpbb-start', postsPerPage },
    totalPosts,
  }
}

function collectStartValues(doc: Document, base: URL, seed: number[]): Set<number> {
  const out = new Set<number>(seed)
  doc
    .querySelectorAll<HTMLAnchorElement>(
      '.pagination a, ul.pagination a, .pagination li a',
    )
    .forEach((a) => {
      try {
        const u = new URL(a.getAttribute('href') ?? '', base)
        const s = u.searchParams.get('start')
        if (s != null) out.add(parseInt(s, 10))
      } catch { /* ignore malformed hrefs */ }
    })
  return out
}

// ---------- XenForo ----------
// URL: /threads/foo.123/ (page 1) or /threads/foo.123/page-2
function xenforo(doc: Document, url: URL): Pagination {
  const canonical = new URL(url.toString())
  canonical.pathname = canonical.pathname.replace(/\/page-\d+\/?$/, '/')

  const match = url.pathname.match(/\/page-(\d+)\/?$/)
  const currentPage = match ? parseInt(match[1], 10) : 1

  let maxPage = currentPage
  doc
    .querySelectorAll<HTMLAnchorElement>(
      'nav.pageNav a, .pageNav-page a, .pageNav a',
    )
    .forEach((a) => {
      const m = (a.getAttribute('href') ?? '').match(/\/page-(\d+)/)
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10))
    })

  return {
    currentPage,
    totalPages: maxPage,
    canonicalUrl: canonical.toString(),
    scheme: { kind: 'xenforo-path' },
  }
}

// ---------- vBulletin (4.x) ----------
// URL: showthread.php?t=123[&page=2]
function vbulletin(doc: Document, url: URL): Pagination {
  const canonical = new URL(url.toString())
  canonical.searchParams.delete('page')

  const currentPage = intParam(url, 'page', 1)

  let maxPage = currentPage
  doc
    .querySelectorAll<HTMLAnchorElement>(
      '.threadpagenav a, .pagenav a, .pagination a',
    )
    .forEach((a) => {
      try {
        const u = new URL(a.getAttribute('href') ?? '', url)
        const p = intParam(u, 'page', 1)
        if (p > maxPage) maxPage = p
      } catch { /* ignore */ }
    })

  return {
    currentPage,
    totalPages: maxPage,
    canonicalUrl: canonical.toString(),
    scheme: { kind: 'vbulletin-page' },
  }
}

// ---------- Invision Community ----------
// URL: /topic/123-foo/page/2/  OR  ?page=2
function invision(doc: Document, url: URL): Pagination {
  const canonical = new URL(url.toString())
  canonical.pathname = canonical.pathname.replace(/\/page\/\d+\/?$/, '/')
  canonical.searchParams.delete('page')

  let currentPage = 1
  const pathMatch = url.pathname.match(/\/page\/(\d+)\/?$/)
  if (pathMatch) currentPage = parseInt(pathMatch[1], 10)
  else currentPage = intParam(url, 'page', 1)

  let maxPage = currentPage
  doc
    .querySelectorAll<HTMLAnchorElement>('.ipsPagination a, ul.ipsPagination a')
    .forEach((a) => {
      try {
        const u = new URL(a.getAttribute('href') ?? '', url)
        const m = u.pathname.match(/\/page\/(\d+)/)
        const p = m ? parseInt(m[1], 10) : intParam(u, 'page', 1)
        if (p > maxPage) maxPage = p
      } catch { /* ignore */ }
    })

  return {
    currentPage,
    totalPages: maxPage,
    canonicalUrl: canonical.toString(),
    scheme: { kind: 'invision-path' },
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const v = url.searchParams.get(name)
  if (v == null) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

// ---------- MyBB ----------
// URL: thread-NNN.html (page 1) or thread-NNN-page-N.html (page N).
function mybb(doc: Document, url: URL): Pagination {
  const canonical = new URL(url.toString())
  canonical.pathname = canonical.pathname.replace(/(thread-\d+)-page-\d+(\.html)$/, '$1$2')

  const pageMatch = url.pathname.match(/thread-\d+-page-(\d+)\.html$/)
  const currentPage = pageMatch ? parseInt(pageMatch[1], 10) : 1

  // MyBB renders thread pagination inside <span class="pages">Pages (N):</span>
  // followed by .pagination links. Both are duplicated near forum-level pagination,
  // so we scope by href pattern instead.
  let maxPage = currentPage
  doc
    .querySelectorAll<HTMLAnchorElement>('a[href*="thread-"][href*="-page-"]')
    .forEach((a) => {
      const m = (a.getAttribute('href') ?? '').match(/thread-\d+-page-(\d+)\.html/)
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10))
    })

  // Fallback to "Pages (N):" label text if no page-N links were found.
  if (maxPage === currentPage) {
    const pagesLabel = Array.from(doc.querySelectorAll('span.pages'))
      .map((el) => el.textContent ?? '')
      .find((t) => /Pages?\s*\(\d+\)/i.test(t))
    const m = pagesLabel?.match(/Pages?\s*\((\d+)\)/i)
    if (m) maxPage = parseInt(m[1], 10)
  }

  return {
    currentPage,
    totalPages: maxPage,
    canonicalUrl: canonical.toString(),
    scheme: { kind: 'mybb-path' },
  }
}

// ---------- Simple Machines Forum (SMF) ----------
// URL: index.php?topic=NNN.OFFSET where OFFSET = (page-1) * postsPerPage.
// Page 1 is topic=NNN.0. Default postsPerPage is 20.
function smf(doc: Document, url: URL): Pagination {
  const topicRaw = url.searchParams.get('topic') ?? ''
  const [tidPart, offsetPart] = topicRaw.split('.')
  const currentOffset = parseInt(offsetPart ?? '0', 10) || 0

  const canonical = new URL(url.toString())
  if (tidPart) canonical.searchParams.set('topic', `${tidPart}.0`)

  // Collect all topic=NNN.OFFSET values from pagination links to derive
  // postsPerPage (smallest non-zero offset) and totalPages (max).
  const offsets = new Set<number>([0, currentOffset])
  doc.querySelectorAll<HTMLAnchorElement>('.pagelinks a, .pagesection a').forEach((a) => {
    try {
      const u = new URL(a.getAttribute('href') ?? '', url)
      const t = u.searchParams.get('topic') ?? ''
      const off = parseInt(t.split('.')[1] ?? '0', 10)
      if (Number.isFinite(off)) offsets.add(off)
    } catch { /* ignore */ }
  })

  const sorted = [...offsets].sort((a, b) => a - b)
  const postsPerPage = sorted.find((o) => o > 0) ?? 20
  const maxOffset = sorted[sorted.length - 1]

  return {
    currentPage: Math.floor(currentOffset / postsPerPage) + 1,
    totalPages: Math.floor(maxOffset / postsPerPage) + 1,
    canonicalUrl: canonical.toString(),
    scheme: { kind: 'smf-topic-offset', postsPerPage },
  }
}
