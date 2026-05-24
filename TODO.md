# TODO

Out-of-scope items captured during development. Not blockers for the current phase.

## Vision models: send post images alongside text

When the selected Ollama model supports image input (e.g. `llava`, `llama3.2-vision`, `gemma3`), include images from posts in the prompt rather than dropping them. Many forum posts carry meaningful information in images — technical diagrams, screenshots, photos — that's currently invisible to the summarizer.

Implementation pointers:
- **Capability detection.** `POST /api/show {"model": "<name>"}` returns a `capabilities` array; check for `"vision"`. Cache result per model. Surface as a small badge in settings ("vision capable").
- **Image extraction.** Extend `extractPosts` to also collect `img` URLs from inside the content selector (skipping emoji/avatar/sig images via the existing ignore selector, plus size threshold — avoid 16×16 icons). Store on `Post` as `images: string[]`.
- **Image payload.** Ollama's `/api/chat` accepts `messages[].images: string[]` of **base64-encoded** image data (not URLs). So we'd `fetch(imageUrl, { credentials: 'include' })` from the content script (cookies needed for member-only forums), convert to base64, and attach.
- **Prompt update.** In `buildSummarizePostsMessages`, when vision-capable, emit one user message per post with `images` populated, rather than the current single concatenated user message. Or interleave — needs prompt experimentation.
- **Token / size budget.** Images eat context fast; cap per-post image count and add a max-bytes filter. The summarizer chunk size may need tuning down to compensate.

Related: [src/content/extract.ts](src/content/extract.ts), [src/lib/providers/ollama.ts](src/lib/providers/ollama.ts), [src/lib/prompts.ts](src/lib/prompts.ts), [src/lib/types.ts](src/lib/types.ts).

## Cross-page fetch — rate-limit and politeness

Phase 3b's "Include all pages" toggle issues real HTTP `fetch()` requests for pages 2..N (page 1 is reused from the already-rendered DOM). On long threads or strict forums this can trip rate limits, view-count limits, or bot detection — even though requests carry the user's session cookies.

Mitigations to consider:
- **Cache fetched pages in IndexedDB** keyed by URL+timestamp; only refetch if older than some TTL. Repeated Analyze runs on the same thread wouldn't re-pound the server.
- **User-driven accumulation.** Instead of auto-fetching siblings, accumulate posts as the user manually navigates pages — each visit adds to the same canonical-URL record. No background fetch, no rate-limit risk, but slower UX.
- **Tunable politeness delay.** 200ms hardcoded today ([src/sidepanel/App.tsx](src/sidepanel/App.tsx)). Could be settings-driven.
- **Surface ToS warning.** Some forums explicitly disallow automated requests in robots.txt / ToS even when session-authenticated. A one-time confirmation before first all-pages fetch would be honest.
- **Hard cap.** Refuse all-pages for threads beyond N pages without explicit re-confirmation.

Related: [src/sidepanel/App.tsx](src/sidepanel/App.tsx) `fetchAllPagesPosts`.

## phpBB phantom post (extractor overcount)

On f-16.net (phpBB), `extractPosts` finds ~1 extra "post" per page beyond what the forum actually has — observed 2026-05-24 on a 31-post / 3-page thread reporting 16 + 16 + 2 = 34 detected. The phantom has enough text to clear `MIN_POST_LENGTH=10`, so it reaches the summarizer.

Hypothesis: the `.post` selector matches an element that isn't a real post (likely the "Post a reply" form region, a topic-header wrapper, or a hidden preview template). Confirm by inspecting DOM on f-16.net and tightening the selector — e.g. require `.post.bg1, .post.bg2` (alternating-row classes phpBB applies to real posts in most themes) or `div.post[id^="p"]` (real posts have `id="p<post_id>"`).

Related: [src/content/selectors.ts](src/content/selectors.ts), [src/content/extract.ts](src/content/extract.ts).

## Multi-page threads

The Phase 2 extractor only sees posts on the currently rendered page. Long forum threads paginate (phpBB: typically 10-25 posts/page; XenForo: 20/page; vBulletin: 10/page) or lazy-load (Discourse, modern XenForo with infinite scroll). A 100-reply thread split across 4 pages currently gets only the visible page summarized.

Design notes for when this is picked up:

- **Pagination link detection per platform.** Each FORUM_SELECTORS entry needs a `pagination` selector (e.g. phpBB: `.pagination a`, XenForo: `nav.pageNav a`). Walking those gives the full page list.
- **Background fetch with credentials.** Content scripts can `fetch(otherPageUrl, { credentials: 'include' })` to pull additional pages using the user's existing session cookies — required for auth-walled forums. Parse the returned HTML with `new DOMParser().parseFromString()` and re-run `extractPosts()` on it.
- **Infinite scroll vs paginated.** Discourse and modern XenForo use lazy-loading inside the same DOM. v1 used a MutationObserver to catch these. For v2, either restore the observer or trigger scroll programmatically and wait for new posts.
- **UX:** show "Found N posts on this page · X more pages available" with a "Include all pages" toggle. Don't auto-fetch — extra pages = extra LLM cost.
- **Ordering:** posts from fetched pages must merge with current-page posts in the right order (typically by URL pagination param, but watch for "newest first" forums).

Related: [src/content/extract.ts](src/content/extract.ts), [src/content/selectors.ts](src/content/selectors.ts).
