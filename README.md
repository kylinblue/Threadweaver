# ThreadWeaver

Chrome side-panel extension that summarizes long forum threads using a local LLM.

Reads forum posts directly from the page you're viewing — including auth-walled / member-only forums where your existing browser session is doing the work — chunks them, runs them through [Ollama](https://ollama.com), and gives you a rolling summary plus a query box for follow-up questions. All data stays on your machine.

**Status:** early development, local-only. Built on the side-panel API so the summary stays put while you keep reading.

## Supported LLM runtimes

Two local-only options. Pick whichever you already have set up; both are supported and switchable from the settings card without restarting the extension.

| Runtime | Why pick it |
|---|---|
| **Ollama** | Easiest setup, broad model catalog, auto-detects vision capability and context window |
| **LM Studio** | Handles a wider set of quantized / fine-tuned GGUF and MLX models that Ollama doesn't run; OpenAI-compatible API |

Remote providers (OpenAI / Anthropic / Gemini / Grok) are deferred — see [TODO.md](TODO.md).

## Supported forums

| Engine | Status | Verified against |
|---|---|---|
| phpBB | ✅ tested | [f-16.net](https://www.f-16.net/forum/) |
| XenForo | ✅ tested | [xenforo.com/community](https://xenforo.com/community/) |
| MyBB | ✅ tested | [community.mybb.com](https://community.mybb.com/) |
| SMF | ✅ tested | [simplemachines.org/community](https://www.simplemachines.org/community/) |
| vBulletin 4 | ⚠️ selectors present but unverified — couldn't find an accessible live vB4 site in 2026 |
| Invision Community | ⚠️ selectors present but unverified |
| Discourse | ❌ not supported (infinite-scroll SPA; future work via JSON API — see [TODO.md](TODO.md)) |
| Reddit, Hacker News, Stack Exchange, Flarum, NodeBB | ❌ out of scope (different paradigms; see [TODO.md](TODO.md)) |
| anything else | best-effort generic fallback selectors |

Multi-page threads are handled via an opt-in "Include all N pages" toggle that fetches sibling pages using your existing session cookies (works on auth-walled forums).

## Setup

ThreadWeaver depends on a local Ollama daemon. Set that up first, then load the extension.

### 1. Install your local LLM runtime

**Option A — Ollama** (recommended for first-time setup):

Install from [ollama.com](https://ollama.com), then pull at least one chat-capable model. Small fast option for dev:

```powershell
ollama pull llama3.2:3b
```

**Option B — LM Studio**:

Install from [lmstudio.ai](https://lmstudio.ai). Use the Discover tab to download a model (any GGUF works), then open the **Developer** tab and:
- Toggle **Reachable on Local Network** *off* (default; we only need localhost)
- Toggle **Enable CORS** **on** — required so the extension's `chrome-extension://` origin can reach the API
- Toggle the server **On** and note the port (default `1234`)
- Click **Load Model** for the model you want active

### 2. Allow chrome-extension origin (Ollama only)

Ollama's default origin allowlist blocks POSTs from `chrome-extension://` URLs and returns 403. Whitelist them once:

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
```

Then **fully quit Ollama** (tray icon → Quit) and relaunch — the daemon only reads the env var at startup.

The extension's Test Connection button surfaces a clear `blocked (403)` badge with this command if you forget. (LM Studio's `Enable CORS` toggle in step 1 covers the equivalent for that runtime.)

### 3. Build and load the extension

```powershell
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repo's `dist/` folder

Click the ThreadWeaver toolbar icon (or pin it first) to open the side panel.

## Usage

1. Navigate to a forum thread.
2. Open the side panel — current page is auto-detected, showing the platform and post count.
3. Click **Analyze thread** to chunk-summarize all posts on the page. The summary persists across panel reloads.
4. Ask follow-up questions in the **Ask** card — answers stream in and cite specific posts.

## Development

Hot-reload dev server (requires re-loading the unpacked extension after rebuilds):

```powershell
npm run dev
```

Production build (what you load in `chrome://extensions`):

```powershell
npm run build
```

Lint:

```powershell
npm run lint
```

### Architecture

- `src/sidepanel/` — React UI (side panel is the primary surface)
- `src/content/` — content script: forum platform detection + post extraction
- `src/background/` — service worker (just wires the action button to open the panel)
- `src/lib/providers/` — `LLMProvider` interface, `OllamaProvider`, `LMStudioProvider`, and a `createProvider(settings)` factory
- `src/lib/summarizer.ts` — chunk → summarize → meta-summarize loop
- `src/lib/db.ts` — IndexedDB persistence (threads, posts, summaries)

## Roadmap

- Multi-page thread support (see [TODO.md](TODO.md))
- Remote LLM providers (OpenAI / Anthropic / Gemini / xAI Grok)
- Per-provider rate limiting + retry + cost estimates
