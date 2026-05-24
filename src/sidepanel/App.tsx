import { useCallback, useEffect, useRef, useState } from 'react'
import { getLatestSummary } from '../lib/db'
import type { ContentRequest, ContentResponse } from '../lib/messages'
import { OllamaProvider } from '../lib/providers/ollama'
import { ProviderError, type ChatMessage } from '../lib/providers/types'
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
    }

type Analysis =
  | { kind: 'idle' }
  | { kind: 'page-running' }
  | { kind: 'thread-running'; progress: ProgressEvent[]; rollingSummary: string }
  | { kind: 'done'; finalSummary: string; source: 'thread' | 'page' }
  | { kind: 'error'; msg: string }

export function App() {
  const [settings, setLocalSettings] = useState<Settings | null>(null)
  const [conn, setConn] = useState<ConnState>({ kind: 'idle' })
  const [detection, setDetection] = useState<Detection>({ kind: 'probing' })
  const [analysis, setAnalysis] = useState<Analysis>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    getSettings().then(setLocalSettings)
    return subscribeSettings(setLocalSettings)
  }, [])

  useEffect(() => {
    if (settings) void testConnection(settings, setConn)
  }, [settings?.ollama.baseUrl])

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
    setAnalysis({ kind: 'thread-running', progress: [], rollingSummary: '' })

    try {
      const gen = summarizeThread(
        provider,
        { url: detection.url, title: detection.title, platform: detection.platform },
        detection.posts,
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
  }, [settings, detection])

  const onCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const onRefresh = useCallback(() => {
    void probeActiveTab(setDetection, setAnalysis)
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
        onChange={updateOllama}
        onTest={() => void testConnection(settings, setConn)}
      />

      <ThreadCard
        detection={detection}
        analysis={analysis}
        connReady={conn.kind === 'ok'}
        onAnalyze={onAnalyze}
        onCancel={onCancel}
        onRefresh={onRefresh}
      />

      <SummaryCard analysis={analysis} detectionUrl={detection.kind === 'ready' ? detection.url : null} />
    </main>
  )
}

function SettingsCard({
  settings,
  conn,
  onChange,
  onTest,
}: {
  settings: Settings
  conn: ConnState
  onChange: (patch: Partial<Settings['ollama']>) => Promise<void>
  onTest: () => void
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
      {conn.kind === 'unreachable' && <p className="hint error">{conn.msg}</p>}
    </section>
  )
}

function ThreadCard({
  detection,
  analysis,
  connReady,
  onAnalyze,
  onCancel,
  onRefresh,
}: {
  detection: Detection
  analysis: Analysis
  connReady: boolean
  onAnalyze: () => void
  onCancel: () => void
  onRefresh: () => void
}) {
  const running =
    analysis.kind === 'thread-running' || analysis.kind === 'page-running'

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
              ? <>{detection.posts.length} posts detected</>
              : <>no posts detected — will fall back to summarizing page text</>}
          </p>
        </>
      )}

      <div className="row">
        <button
          className="primary"
          onClick={onAnalyze}
          disabled={!connReady || detection.kind !== 'ready' || running}
        >
          {analysis.kind === 'thread-running'
            ? `Summarizing… (chunk ${currentChunk(analysis.progress)} / ${totalChunks(analysis.progress)})`
            : analysis.kind === 'page-running'
            ? 'Summarizing page…'
            : detection.kind === 'ready' && detection.posts.length > 0
            ? `Analyze thread (${detection.posts.length} posts)`
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
  detectionUrl,
}: {
  analysis: Analysis
  detectionUrl: string | null
}) {
  const [cached, setCached] = useState<string>('')

  useEffect(() => {
    if (!detectionUrl) { setCached(''); return }
    getLatestSummary(detectionUrl).then((s) => setCached(s?.content ?? ''))
  }, [detectionUrl])

  const live =
    analysis.kind === 'thread-running' ? analysis.rollingSummary
    : analysis.kind === 'done' ? analysis.finalSummary
    : analysis.kind === 'error' ? ''
    : ''

  const display = live || cached
  if (!display && analysis.kind !== 'error') return null

  return (
    <section className="card">
      <div className="row between">
        <h2>Summary</h2>
        {analysis.kind === 'thread-running' && <span className="badge">live</span>}
        {analysis.kind === 'done' && <span className="badge ok">final</span>}
        {!live && cached && <span className="badge">cached</span>}
      </div>
      {analysis.kind === 'error' && <p className="hint error">{analysis.msg}</p>}
      {display && <pre className="summary">{display}</pre>}
    </section>
  )
}

function ConnBadge({ state }: { state: ConnState }) {
  switch (state.kind) {
    case 'idle': return <span className="badge">—</span>
    case 'testing': return <span className="badge">…</span>
    case 'ok': return <span className="badge ok">connected · {state.models.length} model{state.models.length === 1 ? '' : 's'}</span>
    case 'empty': return <span className="badge warn">no models</span>
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
  try {
    const models = await provider.listModels()
    setConn(models.length === 0 ? { kind: 'empty' } : { kind: 'ok', models })
  } catch (err) {
    const msg =
      err instanceof ProviderError ? err.message
      : err instanceof Error ? err.message
      : String(err)
    setConn({ kind: 'unreachable', msg })
  }
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
    })
  } catch {
    setDetection({ kind: 'no-content-script' })
  }
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
