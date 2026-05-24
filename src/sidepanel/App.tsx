import { useCallback, useEffect, useState } from 'react'
import { OllamaProvider } from '../lib/providers/ollama'
import type { ChatMessage } from '../lib/providers/types'
import { ProviderError } from '../lib/providers/types'
import {
  getSettings,
  setSettings,
  subscribeSettings,
  type Settings,
} from '../lib/storage'
import type { ContentRequest, ContentResponse } from '../lib/messages'

const MAX_PAGE_CHARS = 16_000

type ConnState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; models: string[] }
  | { kind: 'empty' }
  | { kind: 'unreachable'; msg: string }

export function App() {
  const [settings, setLocalSettings] = useState<Settings | null>(null)
  const [conn, setConn] = useState<ConnState>({ kind: 'idle' })
  const [summary, setSummary] = useState<string>('')
  const [summarizing, setSummarizing] = useState(false)
  const [sumError, setSumError] = useState<string | null>(null)
  const [pageInfo, setPageInfo] = useState<{ title: string; truncated: boolean } | null>(null)

  useEffect(() => {
    getSettings().then(setLocalSettings)
    const unsub = subscribeSettings(setLocalSettings)
    return unsub
  }, [])

  useEffect(() => {
    if (settings) void testConnection(settings, setConn)
  }, [settings?.ollama.baseUrl])

  const updateOllama = useCallback(
    async (patch: Partial<Settings['ollama']>) => {
      if (!settings) return
      const next: Settings = { ...settings, ollama: { ...settings.ollama, ...patch } }
      await setSettings(next)
    },
    [settings],
  )

  const onSummarize = useCallback(async () => {
    if (!settings) return
    setSummarizing(true)
    setSumError(null)
    setSummary('')
    setPageInfo(null)
    try {
      const page = await fetchActiveTabText()
      const truncated = page.text.length > MAX_PAGE_CHARS
      const text = truncated ? page.text.slice(0, MAX_PAGE_CHARS) : page.text
      setPageInfo({ title: page.title, truncated })

      const provider = new OllamaProvider(settings.ollama.baseUrl)
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You are a concise summarizer. Produce a short bullet-point summary of the page content the user provides. Focus on the key claims and conclusions.',
        },
        { role: 'user', content: text },
      ]
      const result = await provider.generate(messages, { model: settings.ollama.model })
      setSummary(result.text)
    } catch (err) {
      setSumError(err instanceof Error ? err.message : String(err))
    } finally {
      setSummarizing(false)
    }
  }, [settings])

  if (!settings) return <main><p className="hint">Loading…</p></main>

  return (
    <main>
      <header>
        <h1>ThreadWeaver</h1>
      </header>

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
            onChange={(e) => void updateOllama({ baseUrl: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label>
          Model
          <select
            value={settings.ollama.model}
            onChange={(e) => void updateOllama({ model: e.target.value })}
            disabled={conn.kind !== 'ok'}
          >
            {conn.kind === 'ok' && !conn.models.includes(settings.ollama.model) && (
              <option value={settings.ollama.model}>{settings.ollama.model} (not installed)</option>
            )}
            {conn.kind === 'ok'
              ? conn.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))
              : <option value={settings.ollama.model}>{settings.ollama.model}</option>}
          </select>
        </label>
        <div className="row">
          <button onClick={() => void testConnection(settings, setConn)}>
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
        {conn.kind === 'unreachable' && (
          <p className="hint error">{conn.msg}</p>
        )}
      </section>

      <section className="card">
        <h2>Summarize page</h2>
        <button
          className="primary"
          onClick={() => void onSummarize()}
          disabled={summarizing || conn.kind !== 'ok'}
        >
          {summarizing ? 'Summarizing…' : 'Summarize current page'}
        </button>
        {pageInfo && (
          <p className="hint">
            <strong>{pageInfo.title}</strong>
            {pageInfo.truncated && ` — truncated to first ${MAX_PAGE_CHARS.toLocaleString()} chars`}
          </p>
        )}
        {sumError && <p className="hint error">{sumError}</p>}
        {summary && <pre className="summary">{summary}</pre>}
      </section>
    </main>
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
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
        ? err.message
        : String(err)
    setConn({ kind: 'unreachable', msg })
  }
}

async function fetchActiveTabText(): Promise<ContentResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  const req: ContentRequest = { type: 'GET_PAGE_TEXT' }
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, req)) as ContentResponse
    if (!res || res.type !== 'PAGE_TEXT') throw new Error('Bad response from content script')
    return res
  } catch (err) {
    throw new Error(
      `Could not read this page — content scripts don't run on chrome:// or extension pages. ${err instanceof Error ? err.message : ''}`,
    )
  }
}
