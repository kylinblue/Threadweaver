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

## Non-phpBB platform support (decide scope, then verify)

The selectors for XenForo, vBulletin, Discourse, and Invision were ported from v1 and **have not been re-verified on real sites in v2**. README.md currently advertises support for all five platforms but the only one we've tested is phpBB (f-16.net). Before claiming broader compatibility we should decide whether that breadth is worth the maintenance cost.

If we commit to supporting them, the followup work is:

- **Verify post extraction** on a live thread of each platform. Likely need selector adjustments — forum themes vary widely and the v1 selectors are 2+ years old.
- **Tighten post selectors against ad/template phantoms.** PhpBB needed `div.post[id^="p"]` to exclude googletag wrappers ([src/content/selectors.ts](src/content/selectors.ts)); other platforms probably have analogous noise.
- **Populate `Pagination.totalPosts` per platform.** Phase 3a/b added the field; currently only phpBB fills it. XenForo shows "Replies: N" in `.p-description`; vBulletin in `.threadmeta`; Invision in a topic-stats block. Without it the UI estimates from `posts × totalPages`, which over-counts when the last page is partial.
- **Infinite-scroll platforms (Discourse, modern XenForo).** These don't have sibling page URLs, so the Phase 3b cross-page fetch doesn't apply. Would need scroll automation or a different extraction strategy. Likely out of scope.

If we don't commit, narrow README.md to "phpBB only (others experimental)" so we don't oversell.

Related: [src/content/selectors.ts](src/content/selectors.ts), [src/content/pagination.ts](src/content/pagination.ts), [src/lib/pagination.ts](src/lib/pagination.ts), [README.md](README.md).
