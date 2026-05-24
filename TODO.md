# TODO

Out-of-scope items captured during development. Not blockers for the current phase.

## Vision models: send post images alongside text

When the selected Ollama model supports image input (e.g. `gemma4`, `llava`, `llama3.2-vision`, `qwen2.5-vl`), include images from posts in the prompt rather than dropping them. (Gemma 4 confirmed solid as a vision model during 2026-05 testing.) Many forum posts carry meaningful information in images — technical diagrams, screenshots, photos — that's currently invisible to the summarizer.

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

## vBulletin 4 + Invision Community — verify selectors

Selectors are present in [src/content/selectors.ts](src/content/selectors.ts) but never verified against live sites in v2:

- **vBulletin 4** — couldn't find an accessible vB4 site in 2026 (forum.vbulletin.com is behind Cloudflare and now vB6; most vB4 communities have migrated or are private). If a representative site surfaces, verify the post selector against ad/widget phantoms (phpBB needed `div.post[id^="p"]`; vB4 likely needs `[id^="post_"]` or `[id^="post"]`).
- **Invision Community** — selectors ported from v1 untested. ipsApp/ipsPagination structure has likely shifted across IPS 4.x → 5.x. Verify on a real site (xenforo.com sometimes mentions IPS reference forums).

For both: populate `Pagination.totalPosts` once on a live site so the UI shows exact totals instead of `~estimate`.

## Discourse via JSON API

Discourse is infinite-scroll, so our current "fetch sibling URLs" architecture doesn't apply. The clean path is its public JSON API: `GET /t/<slug>/<id>.json` returns the full topic including all posts and metadata in one response. Worth a dedicated `DiscourseAdapter` (parallel to the current DOM extractor path) — would unlock summarizing official communities (Rust, Elm, Hugging Face, many OSS projects).

Implementation pointers:
- Detect Discourse via `meta[name="generator"][content*="Discourse"]` (already done) AND `window.Discourse` global (not accessible from content script's isolated world, so meta tag is what we use).
- Adapter sends `fetch('/t/<slug>/<id>.json', { credentials: 'include', headers: { 'Accept': 'application/json' } })` from content script.
- Map response `.post_stream.posts[]` to our `Post` type. Topic title from `.title`, author from `post.username`, content from `post.cooked` (HTML — needs sanitization or text extraction).
- Pagination doesn't apply — single fetch returns everything.

Related: [src/content/](src/content/), [src/lib/](src/lib/).

## Out of scope (explicitly not supported)

These were considered and rejected for v2 because they don't fit the "linear thread of posts" model:

- **Reddit, Lemmy** — tree-threaded comment forests with voting and collapsing. Different problem; would need a new Post model.
- **Stack Exchange, Hacker News** — Q&A and ranked-comment formats, not threads.
- **Flarum, NodeBB** — modern infinite-scroll forums with small installed bases. Cost > benefit.
- **GitHub Discussions / Issues** — better served by the GitHub API than by scraping.
