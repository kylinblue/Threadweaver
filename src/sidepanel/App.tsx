import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLatestSummary, getPostsByThread, searchPostsByThread } from '../lib/db'
import { renderMarkdown } from '../lib/markdown'
import type {
  ContentRequest,
  ContentResponse,
  PaginationInfo,
} from '../lib/messages'
import { derivePageUrls } from '../lib/pagination'
import { buildAnswerQueryMessages } from '../lib/prompts'
import { OllamaProvider, type LoadedModel } from '../lib/providers/ollama'
import type { ChatMessage } from '../lib/providers/types'
import {
  getSettings,
  setSettings,
  subscribeSettings,
  type Settings,
} from '../lib/storage'
import {
  summarizeThread,
  type ProgressEvent,
} from '../lib/summarizer'
import type { ForumPlatform, Post } from '../lib/types'

const MAX_PAGE_CHARS = 16_000

type ConnState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; models: string[] }
  | { kind: 'empty' }
  | { kind: 'origin-blocked'; models: string[] }
  | { kind: 'unreachable'; msg: string }

type Detection =
  | { kind: 'probing' }
  | { kind: 'no-content-script' }
  | {
      kind: 'ready'
      url: string
      title: string
      platform: ForumPlatform
      posts: Post[]
      pagination: PaginationInfo
    }

type Analysis =
  | { kind: 'idle' }
  | { kind: 'fetching'; message: string }
  | { kind: 'page-running' }
  | { kind: 'thread-running'; progress: ProgressEvent[]; rollingSummary: string }
  | { kind: 'done'; finalSummary: string; source: 'thread' | 'page' }
  | { kind: 'error'; msg: string }

type Query =
  | { kind: 'idle' }
  | { kind: 'running'; question: string; answer: string }
  | { kind: 'done'; question: string; answer: string }
  | { kind: 'error'; question: string; msg: string }

export function App() {
  const [settings, setLocalSettings] = useState<Settings | null>(null)
  const [conn, setConn] = useState<ConnState>({ kind: 'idle' })
  const [detection, setDetection] = useState<Detection>({ kind: 'probing' })
  const [analysis, setAnalysis] = useState<Analysis>({ kind: 'idle' })
  const [cachedSummary, setCachedSummary] = useState<string>('')
  const [indexedPostCount, setIndexedPostCount] = useState<number>(0)
  const [loadedModels, setLoadedModels] = useState<LoadedModel[]>([])
  const [unloading, setUnloading] = useState<boolean>(false)
  const [query, setQuery] = useState<Query>({ kind: 'idle' })
  const [includeAllPages, setIncludeAllPages] = useState<boolean>(false)
  const abortRef = useRef<AbortController | null>(null)
  const queryAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    getSettings().then(setLocalSettings)
    return subscribeSettings(setLocalSettings)
  }, [])

  useEffect(() => {
    if (settings) void testConnection(settings, setConn)
  }, [settings?.ollama.baseUrl])

  // Auto-pick: if the configured model isn't installed but others are,
  // silently switch to the first available so the user gets a working setup.
  useEffect(() => {
    if (!settings) return
    if (conn.kind !== 'ok') return
    if (conn.models.includes(settings.ollama.model)) return
    void updateOllama({ model: conn.models[0] })
  }, [conn, settings?.ollama.model])

  useEffect(() => {
    void probeActiveTab(setDetection, setAnalysis)
    const onActivated = () => void probeActiveTab(setDetection, setAnalysis)
    chrome.tabs.onActivated.addListener(onActivated)
    return () => chrome.tabs.onActivated.removeListener(onActivated)
  }, [])

  const updateOllama = useCallback(
    async (patch: Partial<Settings['ollama']>) => {
      if (!settings) return
      const next: Settings = { ...settings, ollama: { ...settings.ollama, ...patch } }
      await setSettings(next)
    },
    [settings],
  )

  const onAnalyze = useCallback(async () => {
    if (!settings || detection.kind !== 'ready') return
    const provider = new OllamaProvider(settings.ollama.baseUrl)
    const model = settings.ollama.model

    if (detection.posts.length === 0) {
      void runPageSummary(provider, model, setAnalysis)
      return
    }

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    try {
      let postsToAnalyze = detection.posts

      if (includeAllPages && detection.pagination.totalPages > 1) {
        postsToAnalyze = await fetchAllPagesPosts(
          detection,
          (msg) => setAnalysis({ kind: 'fetching', message: msg }),
          abort.signal,
        )
      }

      setAnalysis({ kind: 'thread-running', progress: [], rollingSummary: '' })

      const gen = summarizeThread(
        provider,
        {
          url: detection.pagination.canonicalUrl,
          title: detection.title,
          platform: detection.platform,
        },
        postsToAnalyze,
        { model, abortSignal: abort.signal },
      )

      const events: ProgressEvent[] = []
      let rolling = ''
      let finalSummary = ''

      while (true) {
        const next = await gen.next()
        if (next.done) {
          finalSummary = next.value
          break
        }
        const evt = next.value
        events.push(evt)
        if (evt.kind === 'chunk-done') rolling = evt.summary
        if (evt.kind === 'meta-done' || evt.kind === 'final-done') rolling = evt.summary
        setAnalysis({ kind: 'thread-running', progress: [...events], rollingSummary: rolling })
      }

      setAnalysis({ kind: 'done', finalSummary, source: 'thread' })
    } catch (err) {
      setAnalysis({
        kind: 'error',
        msg: err instanceof Error ? err.message : String(err),
      })
    } finally {
      abortRef.current = null
    }
  }, [settings, detection, includeAllPages])

  const onCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const onRefresh = useCallback(() => {
    void probeActiveTab(setDetection, setAnalysis)
  }, [])

  const refreshLoadedModels = useCallback(async () => {
    if (!settings || conn.kind !== 'ok') {
      setLoadedModels([])
      return
    }
    try {
      const provider = new OllamaProvider(settings.ollama.baseUrl)
      const loaded = await provider.listLoadedModels()
      setLoadedModels(loaded)
    } catch {
      setLoadedModels([])
    }
  }, [settings, conn.kind])

  // Refresh loaded models on natural events: connection becomes ok, analysis
  // finishes (a model just got loaded), settings change.
  useEffect(() => {
    void refreshLoadedModels()
  }, [conn.kind, analysis.kind === 'done', settings?.ollama.baseUrl])

  const onUnloadAll = useCallback(async () => {
    if (!settings || loadedModels.length === 0) return
    setUnloading(true)
    // Optimistic clear — Ollama's /api/ps lags ~100-300ms behind the unload
    // call, so the re-fetch would otherwise read back the still-listed model.
    setLoadedModels([])
    try {
      const provider = new OllamaProvider(settings.ollama.baseUrl)
      for (const m of loadedModels) {
        await provider.unloadModel(m.name).catch(() => { /* best-effort */ })
      }
      await new Promise((r) => setTimeout(r, 250))
      await refreshLoadedModels()
    } finally {
      setUnloading(false)
    }
  }, [settings, loadedModels, refreshLoadedModels])

  // Load the cached summary whenever the active thread changes or a new
  // analysis completes (writes a new 'final' record to IndexedDB).
  // Keyed by canonical thread URL so different pages of the same thread share.
  const canonicalUrl =
    detection.kind === 'ready' ? detection.pagination.canonicalUrl : null
  useEffect(() => {
    if (!canonicalUrl) {
      setCachedSummary('')
      setIndexedPostCount(0)
      return
    }
    void getLatestSummary(canonicalUrl).then((s) => setCachedSummary(s?.content ?? ''))
    void getPostsByThread(canonicalUrl).then((posts) => setIndexedPostCount(posts.length))
  }, [canonicalUrl, analysis.kind === 'done'])

  // Reset query state when the thread changes.
  useEffect(() => {
    setQuery({ kind: 'idle' })
  }, [canonicalUrl])

  const onAsk = useCallback(
    async (question: string) => {
      if (!settings || detection.kind !== 'ready') return
      const trimmed = question.trim()
      if (!trimmed) return

      queryAbortRef.current?.abort()
      const abort = new AbortController()
      queryAbortRef.current = abort
      setQuery({ kind: 'running', question: trimmed, answer: '' })

      try {
        const relevantPosts = await searchPostsByThread(
          detection.pagination.canonicalUrl,
          trimmed,
        )
        const messages = buildAnswerQueryMessages(trimmed, cachedSummary, relevantPosts)
        const provider = new OllamaProvider(settings.ollama.baseUrl)

        let acc = ''
        for await (const chunk of provider.generateStream(messages, {
          model: settings.ollama.model,
          abortSignal: abort.signal,
        })) {
          acc += chunk
          setQuery({ kind: 'running', question: trimmed, answer: acc })
        }
        setQuery({ kind: 'done', question: trimmed, answer: acc })
      } catch (err) {
        setQuery({
          kind: 'error',
          question: trimmed,
          msg: err instanceof Error ? err.message : String(err),
        })
      } finally {
        queryAbortRef.current = null
      }
    },
    [settings, detection, cachedSummary],
  )

  const onCancelQuery = useCallback(() => {
    queryAbortRef.current?.abort()
  }, [])

  if (!settings) return <main><p className="hint">Loading…</p></main>

  return (
    <main>
      <header>
        <h1>ThreadWeaver</h1>
      </header>

      <SettingsCard
        settings={settings}
        conn={conn}
        loadedModels={loadedModels}
        unloading={unloading}
        onChange={updateOllama}
        onTest={() => {
          void testConnection(settings, setConn)
          void refreshLoadedModels()
        }}
        onRefreshLoaded={() => void refreshLoadedModels()}
        onUnloadAll={onUnloadAll}
      />

      <ThreadCard
        detection={detection}
        analysis={analysis}
        connReady={conn.kind === 'ok'}
        includeAllPages={includeAllPages}
        onIncludeAllPagesChange={setIncludeAllPages}
        onAnalyze={onAnalyze}
        onCancel={onCancel}
        onRefresh={onRefresh}
      />

      <SummaryCard analysis={analysis} cachedSummary={cachedSummary} />

      <QueryCard
        query={query}
        canAsk={
          conn.kind === 'ok' &&
          detection.kind === 'ready' &&
          (cachedSummary.length > 0 || analysis.kind === 'done')
        }
        indexedPostCount={indexedPostCount}
        postsOnPage={detection.kind === 'ready' ? detection.posts.length : 0}
        totalPages={detection.kind === 'ready' ? detection.pagination.totalPages : 1}
        hasSummary={cachedSummary.length > 0}
        onAsk={onAsk}
        onCancel={onCancelQuery}
      />
    </main>
  )
}

function SettingsCard({
  settings,
  conn,
  loadedModels,
  unloading,
  onChange,
  onTest,
  onRefreshLoaded,
  onUnloadAll,
}: {
  settings: Settings
  conn: ConnState
  loadedModels: LoadedModel[]
  unloading: boolean
  onChange: (patch: Partial<Settings['ollama']>) => Promise<void>
  onTest: () => void
  onRefreshLoaded: () => void
  onUnloadAll: () => void
}) {
  return (
    <section className="card">
      <h2>Settings</h2>
      <label>
        Provider
        <select value={settings.providerId} disabled>
          <option value="ollama">Ollama (local)</option>
        </select>
      </label>
      <label>
        Base URL
        <input
          type="text"
          value={settings.ollama.baseUrl}
          onChange={(e) => void onChange({ baseUrl: e.target.value })}
          spellCheck={false}
        />
      </label>
      <label>
        Model
        <select
          value={settings.ollama.model}
          onChange={(e) => void onChange({ model: e.target.value })}
          disabled={conn.kind !== 'ok'}
        >
          {conn.kind === 'ok' && !conn.models.includes(settings.ollama.model) && (
            <option value={settings.ollama.model}>
              {settings.ollama.model} (not installed)
            </option>
          )}
          {conn.kind === 'ok'
            ? conn.models.map((m) => <option key={m} value={m}>{m}</option>)
            : <option value={settings.ollama.model}>{settings.ollama.model}</option>}
        </select>
      </label>
      <div className="row">
        <button onClick={onTest}>
          {conn.kind === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <ConnBadge state={conn} />
      </div>
      {conn.kind === 'empty' && (
        <p className="hint">
          Ollama is running but no models are installed. Pull one in a terminal:
          <code className="block">ollama pull llama3.2:3b</code>
          then click <strong>Test connection</strong> again.
        </p>
      )}
      {conn.kind === 'origin-blocked' && (
        <p className="hint error">
          Ollama is running but blocks requests from this extension's origin (returned 403).
          Set <code>OLLAMA_ORIGINS</code> and restart Ollama from the tray:
          <code className="block">[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")</code>
        </p>
      )}
      {conn.kind === 'unreachable' && <p className="hint error">{conn.msg}</p>}
      {conn.kind === 'ok' && (
        <div className="loaded-models">
          <div className="row between">
            <span className="loaded-label">Loaded models</span>
            <button
              className="link"
              onClick={onRefreshLoaded}
              disabled={unloading}
              title="Refresh loaded models"
            >↻ Refresh</button>
          </div>
          {loadedModels.length === 0 ? (
            <span className="hint">None loaded.</span>
          ) : (
            <>
              <ul className="loaded-list">
                {loadedModels.map((m) => (
                  <li key={m.name}>
                    <code>{m.name}</code> — {formatBytes(m.sizeBytes)}
                    {m.sizeVramBytes > 0 && <span className="badge"> GPU </span>}
                  </li>
                ))}
              </ul>
              <button onClick={onUnloadAll} disabled={unloading}>
                {unloading ? 'Unloading…' : `Unload all (${loadedModels.length})`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function ThreadCard({
  detection,
  analysis,
  connReady,
  includeAllPages,
  onIncludeAllPagesChange,
  onAnalyze,
  onCancel,
  onRefresh,
}: {
  detection: Detection
  analysis: Analysis
  connReady: boolean
  includeAllPages: boolean
  onIncludeAllPagesChange: (b: boolean) => void
  onAnalyze: () => void
  onCancel: () => void
  onRefresh: () => void
}) {
  const running =
    analysis.kind === 'thread-running' ||
    analysis.kind === 'page-running' ||
    analysis.kind === 'fetching'

  const isMultiPage =
    detection.kind === 'ready' && detection.pagination.totalPages > 1

  const totalPosts =
    detection.kind === 'ready'
      ? detection.pagination.totalPosts ??
        detection.posts.length * detection.pagination.totalPages
      : 0
  const totalIsExact =
    detection.kind === 'ready' && detection.pagination.totalPosts != null

  return (
    <section className="card">
      <div className="row between">
        <h2>Current page</h2>
        <button className="link" onClick={onRefresh} disabled={running}>Refresh</button>
      </div>

      {detection.kind === 'probing' && <p className="hint">Detecting…</p>}
      {detection.kind === 'no-content-script' && (
        <p className="hint">
          Content scripts don't run on this page (e.g. <code>chrome://</code> or the extension itself).
          Navigate to a regular web page.
        </p>
      )}
      {detection.kind === 'ready' && (
        <>
          <p className="hint">
            <strong>{detection.title}</strong>
          </p>
          <p className="hint">
            <span className={`badge ${detection.posts.length > 0 ? 'ok' : 'warn'}`}>
              {detection.platform}
            </span>
            {' '}
            {detection.posts.length > 0
              ? <>{detection.posts.length} posts on this page</>
              : <>no posts detected — will fall back to summarizing page text</>}
            {isMultiPage && (
              <> · page {detection.pagination.currentPage} of {detection.pagination.totalPages}</>
            )}
            {isMultiPage && detection.posts.length > 0 && (
              <> · {totalIsExact ? '' : '~'}{totalPosts} total</>
            )}
          </p>
          {isMultiPage && (
            <label className="row">
              <input
                type="checkbox"
                checked={includeAllPages}
                onChange={(e) => onIncludeAllPagesChange(e.target.checked)}
                disabled={running}
              />
              <span>Include all {detection.pagination.totalPages} pages</span>
            </label>
          )}
        </>
      )}

      <div className="row">
        <button
          className="primary"
          onClick={onAnalyze}
          disabled={!connReady || detection.kind !== 'ready' || running}
        >
          {analysis.kind === 'fetching'
            ? analysis.message
            : analysis.kind === 'thread-running'
            ? `Summarizing… (chunk ${currentChunk(analysis.progress)} / ${totalChunks(analysis.progress)})`
            : analysis.kind === 'page-running'
            ? 'Summarizing page…'
            : detection.kind === 'ready' && detection.posts.length > 0
            ? includeAllPages && isMultiPage
              ? `Analyze full thread (${totalIsExact ? '' : '~'}${totalPosts} posts)`
              : `Analyze thread (${detection.posts.length} posts)`
            : 'Summarize page'}
        </button>
        {running && (
          <button onClick={onCancel}>Cancel</button>
        )}
      </div>

      {analysis.kind === 'thread-running' && analysis.progress.length > 0 && (
        <ProgressList events={analysis.progress} />
      )}
    </section>
  )
}

function ProgressList({ events }: { events: ProgressEvent[] }) {
  const lines = events
    .map((e) => {
      switch (e.kind) {
        case 'started':
          return `Starting: ${e.totalPosts} posts in ${e.totalChunks} chunk${e.totalChunks === 1 ? '' : 's'}`
        case 'chunk-started':
          return `Chunk ${e.chunkIndex + 1}/${e.totalChunks}: summarizing ${e.posts} posts…`
        case 'chunk-done':
          return `Chunk ${e.chunkIndex + 1}/${e.totalChunks}: done (posts ${e.postRangeStart}–${e.postRangeEnd})`
        case 'meta-started':
          return `Condensing ${e.summaryCount} chunk summaries…`
        case 'meta-done':
          return `Meta-summary updated`
        case 'final-started':
          return `Final pass over chunk summaries…`
        case 'final-done':
          return `Final summary ready`
      }
    })
  return (
    <ul className="progress">
      {lines.map((l, i) => <li key={i}>{l}</li>)}
    </ul>
  )
}

function SummaryCard({
  analysis,
  cachedSummary,
}: {
  analysis: Analysis
  cachedSummary: string
}) {
  const live =
    analysis.kind === 'thread-running' ? analysis.rollingSummary
    : analysis.kind === 'done' ? analysis.finalSummary
    : analysis.kind === 'error' ? ''
    : ''

  const display = live || cachedSummary
  if (!display && analysis.kind !== 'error') return null

  return (
    <section className="card">
      <div className="row between">
        <h2>Summary</h2>
        {analysis.kind === 'thread-running' && <span className="badge">live</span>}
        {analysis.kind === 'done' && <span className="badge ok">final</span>}
        {!live && cachedSummary && <span className="badge">cached</span>}
      </div>
      {analysis.kind === 'error' && <p className="hint error">{analysis.msg}</p>}
      {display && <Markdown text={display} />}
    </section>
  )
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

function QueryCard({
  query,
  canAsk,
  indexedPostCount,
  postsOnPage,
  totalPages,
  hasSummary,
  onAsk,
  onCancel,
}: {
  query: Query
  canAsk: boolean
  indexedPostCount: number
  postsOnPage: number
  totalPages: number
  hasSummary: boolean
  onAsk: (q: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState('')
  const running = query.kind === 'running'

  const submit = () => {
    if (!canAsk || running) return
    if (!draft.trim()) return
    onAsk(draft)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  // A multi-page thread whose indexed count doesn't exceed current page posts
  // means the user analyzed without "Include all pages" — answers will be
  // current-page-only and they may want to re-analyze with all pages.
  const isCurrentPageOnly = totalPages > 1 && indexedPostCount <= postsOnPage

  return (
    <section className="card">
      <h2>Ask</h2>
      {!hasSummary && (
        <p className="hint">Analyze the thread first to enable query mode.</p>
      )}
      {hasSummary && (
        <p className="hint">
          Answering based on <strong>{indexedPostCount}</strong> indexed post{indexedPostCount === 1 ? '' : 's'}.
          {isCurrentPageOnly && (
            <> Re-analyze with <em>Include all pages</em> for full-thread context.</>
          )}
        </p>
      )}
      <textarea
        rows={3}
        placeholder="Ask a question about this thread… (Ctrl+Enter to submit)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={!canAsk || running}
      />
      <div className="row">
        <button
          className="primary"
          onClick={submit}
          disabled={!canAsk || running || !draft.trim()}
        >
          {running ? 'Thinking…' : 'Ask'}
        </button>
        {running && <button onClick={onCancel}>Cancel</button>}
      </div>
      {query.kind === 'error' && <p className="hint error">{query.msg}</p>}
      {(query.kind === 'running' || query.kind === 'done') && query.answer && (
        <Markdown text={query.answer} />
      )}
    </section>
  )
}

function ConnBadge({ state }: { state: ConnState }) {
  switch (state.kind) {
    case 'idle': return <span className="badge">—</span>
    case 'testing': return <span className="badge">…</span>
    case 'ok': return <span className="badge ok">connected · {state.models.length} model{state.models.length === 1 ? '' : 's'}</span>
    case 'empty': return <span className="badge warn">no models</span>
    case 'origin-blocked': return <span className="badge error">blocked (403)</span>
    case 'unreachable': return <span className="badge error">unreachable</span>
  }
}

function currentChunk(events: ProgressEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'chunk-started') return e.chunkIndex + 1
  }
  return 0
}

function totalChunks(events: ProgressEvent[]): number {
  for (const e of events) {
    if (e.kind === 'started') return e.totalChunks
  }
  return 0
}

async function testConnection(
  settings: Settings,
  setConn: (s: ConnState) => void,
) {
  setConn({ kind: 'testing' })
  const provider = new OllamaProvider(settings.ollama.baseUrl)
  const result = await provider.verifyAccess()
  setConn(result)
}

async function probeActiveTab(
  setDetection: (d: Detection) => void,
  setAnalysis: (a: Analysis) => void,
) {
  setDetection({ kind: 'probing' })
  setAnalysis({ kind: 'idle' })
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    setDetection({ kind: 'no-content-script' })
    return
  }
  const req: ContentRequest = { type: 'GET_POSTS' }
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, req)) as ContentResponse
    if (!res || res.type !== 'POSTS') {
      setDetection({ kind: 'no-content-script' })
      return
    }
    setDetection({
      kind: 'ready',
      url: res.url,
      title: res.title,
      platform: res.platform,
      posts: res.posts,
      pagination: res.pagination,
    })
  } catch {
    setDetection({ kind: 'no-content-script' })
  }
}

type DetectionReady = Extract<Detection, { kind: 'ready' }>

const POLITENESS_DELAY_MS = 200

/**
 * Walk all pages of the current thread via the page's content script (uses
 * the user's session cookies), merge posts in page order, dedupe by
 * (author + content snippet), renumber positions globally.
 */
async function fetchAllPagesPosts(
  detection: DetectionReady,
  onProgress: (msg: string) => void,
  signal: AbortSignal,
): Promise<Post[]> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')

  const urls = derivePageUrls(detection.pagination)
  const currentIdx = detection.pagination.currentPage - 1
  const fetched: (Post[] | null)[] = new Array(urls.length).fill(null)
  fetched[currentIdx] = detection.posts

  for (let i = 0; i < urls.length; i++) {
    if (i === currentIdx) continue
    if (signal.aborted) throw new Error('Aborted')

    onProgress(`Fetching page ${i + 1} of ${urls.length}…`)
    const req: ContentRequest = { type: 'FETCH_PAGE_POSTS', url: urls[i] }
    const res = (await chrome.tabs.sendMessage(tab.id, req)) as ContentResponse
    if (!res || res.type !== 'FETCHED_POSTS') {
      throw new Error(`Unexpected response from content script for page ${i + 1}`)
    }
    if (res.error) throw new Error(`Page ${i + 1}: ${res.error}`)
    fetched[i] = res.posts
    await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS))
  }

  const merged: Post[] = []
  for (const pagePosts of fetched) {
    if (pagePosts) merged.push(...pagePosts)
  }

  const seen = new Set<string>()
  const out: Post[] = []
  for (const p of merged) {
    const key = `${p.author}::${p.content.slice(0, 80)}`
    if (seen.has(key)) continue
    seen.add(key)
    const position = out.length + 1
    out.push({
      ...p,
      position,
      id: `post_${position}_${p.author.slice(0, 30)}_${p.content.slice(0, 50)}`,
    })
  }
  return out
}

async function runPageSummary(
  provider: OllamaProvider,
  model: string,
  setAnalysis: (a: Analysis) => void,
) {
  setAnalysis({ kind: 'page-running' })
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('No active tab')
    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_PAGE_TEXT',
    })) as ContentResponse
    if (res.type !== 'PAGE_TEXT') throw new Error('Bad response')
    const text = res.text.length > MAX_PAGE_CHARS ? res.text.slice(0, MAX_PAGE_CHARS) : res.text
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a concise summarizer. Produce a short bullet-point summary of the page content the user provides.',
      },
      { role: 'user', content: text },
    ]
    const result = await provider.generate(messages, { model })
    setAnalysis({ kind: 'done', finalSummary: result.text, source: 'page' })
  } catch (err) {
    setAnalysis({
      kind: 'error',
      msg: err instanceof Error ? err.message : String(err),
    })
  }
}
