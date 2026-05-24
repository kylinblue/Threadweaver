# TODO

Out-of-scope items captured during development. Not blockers for the current phase.

## Multi-page threads

The Phase 2 extractor only sees posts on the currently rendered page. Long forum threads paginate (phpBB: typically 10-25 posts/page; XenForo: 20/page; vBulletin: 10/page) or lazy-load (Discourse, modern XenForo with infinite scroll). A 100-reply thread split across 4 pages currently gets only the visible page summarized.

Design notes for when this is picked up:

- **Pagination link detection per platform.** Each FORUM_SELECTORS entry needs a `pagination` selector (e.g. phpBB: `.pagination a`, XenForo: `nav.pageNav a`). Walking those gives the full page list.
- **Background fetch with credentials.** Content scripts can `fetch(otherPageUrl, { credentials: 'include' })` to pull additional pages using the user's existing session cookies — required for auth-walled forums. Parse the returned HTML with `new DOMParser().parseFromString()` and re-run `extractPosts()` on it.
- **Infinite scroll vs paginated.** Discourse and modern XenForo use lazy-loading inside the same DOM. v1 used a MutationObserver to catch these. For v2, either restore the observer or trigger scroll programmatically and wait for new posts.
- **UX:** show "Found N posts on this page · X more pages available" with a "Include all pages" toggle. Don't auto-fetch — extra pages = extra LLM cost.
- **Ordering:** posts from fetched pages must merge with current-page posts in the right order (typically by URL pagination param, but watch for "newest first" forums).

Related: [src/content/extract.ts](src/content/extract.ts), [src/content/selectors.ts](src/content/selectors.ts).
