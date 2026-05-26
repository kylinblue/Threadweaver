# TODO

Out-of-scope items captured during development. Not blockers for the current phase.

## Page/post-aware "Auto-follow" mode

As the user navigates pages within the same canonical thread URL, auto-trigger a per-page summarize that accumulates into a rolling cross-page meta — they "weave" through a thread and get a continuously-updating summary without clicking Analyze each page. Should keep the model hot (Ollama's `keep_alive` default 5min handles this naturally if pages are visited promptly).

Implementation pointers:
- **Toggle.** Add an `Auto-follow this thread` checkbox to ThreadCard, defaulting OFF (auto-summarizing on every navigation is disruptive when reading casually).
- **Trigger.** `chrome.tabs.onUpdated` listener that fires when the URL changes within the same canonical URL (compare derived canonical of new URL vs current `detection.pagination.canonicalUrl`). Debounce to avoid double-fires on phpBB redirects.
- **Global post position.** Currently `extractPosts` numbers posts 1..N per page. For auto-follow, we want global thread positions (page 2 of phpBB at start=15 with 15/page → posts numbered 16..30). Use pagination scheme + currentPage offset.
- **Accumulation.** Each page-analyze adds posts + chunk-summary to IndexedDB keyed by canonical URL. Maintain a "rolling meta" that re-runs meta-summarize over all current chunks each time a new page lands.
- **UX.** Show a small "Following thread (page N of M analyzed)" status in ThreadCard; SummaryCard reflects rolling meta in near-real-time.
- **Edge cases.** User clicks back-button rapidly → don't analyze pages they're just skimming through. Minimum dwell time (~5s) before triggering.

Related: [src/sidepanel/App.tsx](src/sidepanel/App.tsx), [src/lib/summarizer.ts](src/lib/summarizer.ts), [src/content/extract.ts](src/content/extract.ts).

## Context length: settings override + better token counting

Layers 1.5 and 3 are shipped (model context discovery + adaptive token-budget
chunking). Remaining followups:

- **Layer 4 — Settings override.** Expose the `INPUT_BUDGET_CAP` (currently 8K) and `MAX_CTX_REQUEST` (currently 32K) in settings UI for advanced users who want to push past on big-context models (at VRAM cost). Default stays as-is.
- **Better token counting.** Current chars/4 estimate is wildly off for code, lists, non-English text — leading to either wasted budget (over-estimate) or silent truncation (under-estimate). Investigate: Ollama could expose a count endpoint via `/api/generate {prompt, keep_alive: 0}` which returns `prompt_eval_count` without generating. Calibrate per model and persist.
- **Meta-summarize budget enforcement.** Current code adaptive-chunks the per-post pass but meta-summarize concatenates N chunk summaries blindly. If N is large, can blow context. Add recursive halving fallback or just surface a warning when meta input exceeds budget.

Related: [src/lib/providers/ollama.ts](src/lib/providers/ollama.ts), [src/lib/summarizer.ts](src/lib/summarizer.ts).

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
