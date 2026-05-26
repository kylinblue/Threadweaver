# Changelog

All notable changes to ThreadWeaver are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-25

First public release. Sideload-ready (Load unpacked from a release zip); not on the Chrome Web Store.

### Added

- **Auto-follow mode.** Toggle in ThreadCard; as you navigate pages of a thread, each new page is summarized (after a 5s dwell) and folded into a rolling meta over all chunks. Posts are numbered thread-global using the page-offset so the model sees consistent post numbers across pages. Status shows "N of M pages summarized."
- **Multi-provider LLM support.** Ollama (default) and LM Studio, behind a common `Provider` interface. New providers can be added by implementing the same shape.
- **Vision support.** Image-capable models receive selected post images on summarize, meta, and ask. Per-path image selection: in-order for chunk summaries, round-robin for meta summaries, keyword-relevant first for ask. JPEG and PNG only; magic-byte sniffing rejects malformed payloads before they reach the model.
- **Parallel summarization.** Worker pool processes chunk summaries concurrently when the provider supports it (LM Studio defaults to 4, Ollama stays at 1 due to per-model serialization).
- **Recursive halving meta-summary.** Threads with more than 8 chunks cascade meta-summaries in groups of 8 until a single summary remains, handling arbitrarily long threads without busting context.
- **Adaptive token-budget chunking.** Chunks pack posts up to the provider's reported context window minus prompt overhead and image-payload reserve. Falls back to fixed chunking when the provider can't report context.
- **Analysis scope selector.** Four variants — current page, bookend (first 25 + last 25), last N, and full thread. Plus a manual variant taking explicit start/end post numbers. Threads larger than 100 posts default to bookend; full-thread on long threads requires a confirm.
- **Cross-page fetch.** "Include all pages" toggle pulls every page of a thread; per-platform pagination detection finds page links and counts.
- **Forum support: phpBB, XenForo, MyBB, SMF.** Per-platform selectors and canonical-URL derivation. Pagination handling per platform.
- **Query mode.** Ask a question of an indexed thread; keyword-relevant post search seeds context, then streams an answer.
- **Markdown rendering** for summaries and answers via `marked` + DOMPurify.
- **IndexedDB persistence.** Posts and summaries cached per canonical thread URL; survives side-panel closes.
- **Loaded-models UI (Ollama).** Settings card lists currently loaded models with size and GPU badge, manual refresh, and an Unload-all button.
- **Per-model context-window detection (Ollama).** `/api/show` cached per model; `num_ctx` clamped to `min(model_max, 32768)` on each request, preventing silent sliding-window truncation.
- **LM Studio per-model introspection** via `/api/v0/models`: vision capability (`type === 'vlm'`) and loaded context length feed adaptive chunking.
- **Thread-title threading.** Summarize, meta, and answer-query prompts all receive the thread title — keeps early-post topic context alive for chunks 2+.
- **Thinking-model handling.** `<think>` reasoning blocks stripped from generate output; `think:false` passed to newer Ollama to suppress at the source.
- **Drop-cache button** on the summary card; wipes posts, summaries, and the thread record for the current canonical URL.
- **Origin-aware test connection** with model auto-pick on first successful connect.

### Changed

- **README**: setup instructions for both Ollama and LM Studio, condensed.
- **Default scope** is bookend for long threads, not full-thread, to avoid accidental mass page fetches.

### Fixed

- **Worker pool race** where the drain loop could wake before `workersDone` flipped, re-awaiting forever. Flag-flip and queue-wake are now atomic in a single `.finally()`.
- **Chunk-2+ "incomplete summary" editorial chatter** — batch context now passed to the summarize prompt so it knows it's processing a slice.
- **Ollama 500s on animated GIF/WebP, SVG, HEIC, AVIF.** Image allowlist narrowed to JPEG + PNG.
- **QueryCard "indexed posts" hint** now reads from IndexedDB, not just the current page's post count, so multi-page threads with single-page indexing get the right "Include all pages" prompt.
- **phpBB selector** tightened; exact post counts now surface.

### Why no 1.0?

Remote LLM providers (OpenAI, Anthropic, Gemini, Grok) are scaffolded in `host_permissions` but not implemented. 1.0 lands when those work.

[0.3.0]: https://github.com/USER/threadweaver/releases/tag/v0.3.0
