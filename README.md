# ThreadWeaver

A Chrome side-panel extension that reads long forum threads for you, using a local LLM you control. Your data stays on your machine.

![ThreadWeaver running on a XenForo thread, side panel showing a streamed summary alongside the original page](docs/screenshots/Screenshot%202026-05-25%20220048.png)

## What it does

- **Chunked summarization** with a rolling summary that updates as it processes. Handles multi-thousand-post threads via recursive meta-summary.
- **Auto-follow mode.** Toggle it on and the summary updates page-by-page as you read; no clicking Analyze on every page.
- **Ask follow-up questions** of a thread you've indexed — answers stream in and cite specific posts.
- **Vision-capable** when your model supports it: image content in posts is sent alongside text on summarize and ask.
- **Cross-page fetch** for paginated threads. Pulls sibling pages using your existing browser session, so auth-walled forums work.

## Why

Long forum threads (aircraft enthusiast sites, hobbyist communities, support forums, kayak-fishing 30-pagers) buried interesting information in 2000-comment haystacks. Threadweaver gives you a TL;DR + a query box, and runs entirely against a local model so your reading habits stay private.

## Supported forums

| Engine | Status | Verified against |
|---|---|---|
| phpBB | tested | [f-16.net](https://www.f-16.net/forum/) |
| XenForo | tested | [xenforo.com/community](https://xenforo.com/community/) |
| MyBB | tested | [community.mybb.com](https://community.mybb.com/) |
| SMF | tested | [simplemachines.org/community](https://www.simplemachines.org/community/) |
| vBulletin 4 | selectors present, unverified — couldn't find an accessible live vB4 site in 2026 |
| Invision Community | selectors present, unverified |
| Discourse | not supported (infinite-scroll SPA; future work via JSON API, see [TODO.md](TODO.md)) |
| Reddit, Hacker News, Stack Exchange, Flarum, NodeBB | out of scope (different paradigms; see [TODO.md](TODO.md)) |
| anything else | best-effort generic fallback selectors |

Multi-page threads use an "Include all N pages" toggle that fetches via your existing session cookies.

## Install (sideload)

ThreadWeaver isn't on the Chrome Web Store. You install it by loading the unpacked dist.

> **Trust note:** you're loading unverified code. The source is in this repo — inspect [src/](src/) and [manifest.config.ts](manifest.config.ts) before installing. See the [Privacy + permissions](#privacy--permissions) section for a permission-by-permission justification.

1. Download `threadweaver-vX.Y.Z.zip` from the [Releases page](https://github.com/) (or build from source — see [Development](#development) below).
2. Unzip somewhere durable (don't put it in your Downloads folder; Chrome will lose it when you clean up).
3. Open `chrome://extensions`, enable **Developer mode** (top right).
4. Click **Load unpacked**, pick the unzipped folder.
5. Pin the toolbar icon. Click it to open the side panel.

## Setup your local LLM

You need one of these running locally. Pick whichever you already have, or whichever sounds simpler to install. Both are switchable from the Settings card without reloading.

### Option A — Ollama (recommended for first-time setup)

1. Install from [ollama.com](https://ollama.com).
2. Pull a chat-capable model:
   ```powershell
   ollama pull llama3.2:3b
   ```
3. **Allow chrome-extension origins.** Ollama blocks POSTs from `chrome-extension://` URLs by default (returns 403). Whitelist them once:
   ```powershell
   [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
   ```
   Then fully quit Ollama (tray icon → Quit) and relaunch. The daemon only reads the env var at startup.

The extension's Test Connection button surfaces a `blocked (403)` badge with this command if you forget.

### Option B — LM Studio

1. Install from [lmstudio.ai](https://lmstudio.ai).
2. Discover tab → download a model (any GGUF works).
3. Developer tab:
   - Toggle **Enable CORS** **on** — required so the extension can reach the API.
   - Click **Load Model** for the model you want active.
   - Set **Context Length** as high as your hardware allows when loading. Bigger context = fewer chunks = faster, sharper summaries.
   - Set **Parallel ≥ 2** to let the extension run chunks concurrently.
   - Toggle the server **On** (default port `1234`).

## Privacy + permissions

ThreadWeaver runs entirely on your machine. There is no telemetry, no analytics, no remote server. The extension only talks to:

- The forum tab you're actively viewing (extracting posts)
- Your local LLM at `http://localhost:11434` (Ollama) or `http://localhost:1234` (LM Studio)
- Image URLs referenced in forum posts (only when you enable "Include images" — fetched as `image/jpeg` or `image/png` and forwarded to your local model)

All thread data — posts, summaries, settings — lives in IndexedDB on your machine. You can wipe it all with the **Clear all data** button in Settings.

### Permission-by-permission justification

| Permission | Why we need it |
|---|---|
| `sidePanel` | The extension's UI is a side panel — no permission, no UI. |
| `storage` | Persists settings (chosen runtime, base URL, model) in `chrome.storage.local`. |
| `activeTab` | Reads the current tab's posts when you click Analyze. Scoped to the tab you're looking at. |
| `scripting` | Cross-page fetch: the content script extracts posts from sibling pages you ask us to load. |
| `host_permissions: <all_urls>` | Forums live on every domain; we don't know which one you'll visit. The content script only activates on tabs you navigate to. |
| `host_permissions: localhost:11434, localhost:1234` | Outbound requests to your Ollama / LM Studio server. |

Remote-provider hosts (OpenAI, Anthropic, Gemini, xAI) are *not* in the manifest right now — they were scoped out for v0.3.0 and will be added back when those providers are implemented (see [CHANGELOG.md](CHANGELOG.md)).

## Development

```powershell
npm install
npm run build      # production build into dist/
npm run dev        # hot-reload dev server
npm run lint
```

Load the `dist/` folder via `chrome://extensions` → Load unpacked, same as the sideload install above. Reload the extension after each rebuild.

### Architecture

- [src/sidepanel/](src/sidepanel/) — React UI (the primary surface).
- [src/content/](src/content/) — content script: forum platform detection + post extraction.
- [src/background/](src/background/) — service worker (wires the action button to open the panel).
- [src/lib/providers/](src/lib/providers/) — `LLMProvider` interface + `OllamaProvider` / `LMStudioProvider` + `createProvider(settings)` factory.
- [src/lib/summarizer.ts](src/lib/summarizer.ts) — chunk → summarize → meta-summarize loop with worker pool and recursive halving.
- [src/lib/db.ts](src/lib/db.ts) — IndexedDB persistence (threads, posts, summaries).

See [RELEASING.md](RELEASING.md) for how to cut a release.

## Roadmap

- Remote LLM providers (OpenAI / Anthropic / Gemini / xAI Grok) — the 1.0 marker.
- Discourse adapter via JSON API.
- Firefox port.

## License

MIT — see [LICENSE](LICENSE).
