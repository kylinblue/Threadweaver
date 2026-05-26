import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearAllData,
  clearThread,
  getLatestSummary,
  getPostsByThread,
  searchPostsByThread,
} from '../lib/db'
import { renderMarkdown } from '../lib/markdown'
import type {
  ContentRequest,
  ContentResponse,
  PaginationInfo,
} from '../lib/messages'
import {
  derivePageUrls,
  postsPerPageEstimate,
  resolveScope,
  type AnalysisScope,
} from '../lib/pagination'
import { buildAnswerQueryMessages } from '../lib/prompts'
import {
  activeProviderConfig,
  createProvider,
} from '../lib/providers/factory'
import { OllamaProvider, type LoadedModel } from '../lib/providers/ollama'
import type { ChatMessage, LLMProvider } from '../lib/providers/types'
import {
  attachImagesToLastMessage,
  collectImages,
  collectImagesRoundRobin,
} from '../lib/vision'
import {
  getAutoFollow,
  getHasConnectedBefore,
  getSettings,
  setAutoFollow,
  setHasConnectedBefore,
  setSettings,
  subscribeSettings,
  type AutoFollowState,
  type Settings,
} from '../lib/storage'
import {
  summarizeThread,
  type ProgressEvent,
} from '../lib/summarizer'
import type { ForumPlatform, Post } from '../lib/types'

const MAX_PAGE_CHARS = 16_000
const MAX_QUERY_IMAGES = 5
const BIG_FETCH_CONFIRM_THRESHOLD = 10
const BOOKEND_POSTS_PER_SIDE = 25
const LAST_N_POSTS = 100
const HUGE_THREAD_THRESHOLD_POSTS = 100
/**
 * Minimum dwell time before auto-follow kicks in on a new page. Filters out
 * rapid back-button skimming; gives the user a moment to scroll/read before
 * the model starts crunching. 5s is a guess — tunable from settings later.
 */
const AUTO_FOLLOW_DWELL_MS = 5_000

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
  const [scope, setScope] = useState<AnalysisScope>({ kind: 'this-page' })
  const [useImages, setUseImages] = useState<boolean>(true)
  const [visionModel, setVisionModel] = useState<boolean>(false)
  const [hasConnected, setHasConnected] = useState<boolean>(true)
  const [autoFollow, setAutoFollowLocal] = useState<AutoFollowState>({
    enabled: false,
    canonicalUrl: null,
    processedPages: [],
  })
  const abortRef = useRef<AbortController | null>(null)
  const queryAbortRef = useRef<AbortController | null>(null)
  const dwellTimerRef = useRef<number | null>(null)
  /**
   * Set when a tab-update event arrives while a summary is still running.
   * We re-probe once the current run completes so the next page isn't lost.
   */
  const pendingProbeRef = useRef<boolean>(false)

  useEffect(() => {
    getSettings().then(setLocalSettings)
    getHasConnectedBefore().then(setHasConnected)
    getAutoFollow().then(setAutoFollowLocal)
    return subscribeSettings(setLocalSettings)
  }, [])

  // Mark first-run complete the first time we see a successful connection.
  // Persists across sessions; only "Clear all data" resets it.
  useEffect(() => {
    if (conn.kind === 'ok' && !hasConnected) {
      void setHasConnectedBefore().then(() => setHasConnected(true))
    }
  }, [conn.kind, hasConnected])

  // Re-test connection whenever the active provider's base URL changes (or
  // provider switches entirely).
  useEffect(() => {
    if (settings) void testConnection(settings, setConn)
  }, [settings?.providerId, settings?.ollama.baseUrl, settings?.lmstudio.baseUrl])

  // Auto-pick: if the configured model isn't installed but others are,
  // silently switch to the first available so the user gets a working setup.
  useEffect(() => {
    if (!settings) return
    if (conn.kind !== 'ok') return
    const currentModel = activeProviderConfig(settings).model
    if (currentModel && conn.models.includes(currentModel)) return
    if (conn.models.length === 0) return
    void updateProviderConfig({ model: conn.models[0] })
  }, [conn, settings?.providerId])

  useEffect(() => {
    void probeActiveTab(setDetection, setAnalysis)
    const onActivated = () => void probeActiveTab(setDetection, setAnalysis)
    chrome.tabs.onActivated.addListener(onActivated)
    return () => chrome.tabs.onActivated.removeListener(onActivated)
  }, [])

  /**
   * Update the active provider's (baseUrl, model). Routes the patch into
   * settings.ollama or settings.lmstudio based on settings.providerId.
   */
  const updateProviderConfig = useCallback(
    async (patch: Partial<{ baseUrl: string; model: string }>) => {
      if (!settings) return
      const current = activeProviderConfig(settings)
      const updated = { ...current, ...patch }
      const next: Settings =
        settings.providerId === 'lmstudio'
          ? { ...settings, lmstudio: updated }
          : { ...settings, ollama: updated }
      await setSettings(next)
    },
    [settings],
  )

  const setProviderId = useCallback(
    async (providerId: Settings['providerId']) => {
      if (!settings) return
      await setSettings({ ...settings, providerId })
    },
    [settings],
  )

  const onAnalyze = useCallback(async () => {
    if (!settings || detection.kind !== 'ready') return
    const provider = createProvider(settings)
    const model = activeProviderConfig(settings).model

    if (detection.posts.length === 0) {
      void runPageSummary(provider, model, setAnalysis)
      return
    }

    // Resolve scope → set of page numbers to fetch beyond what we already have.
    const selection = resolveScope(scope, detection.pagination, detection.posts.length)

    // Big-fetch guardrail: confirm before pulling a lot of pages.
    if (selection.pages.length > BIG_FETCH_CONFIRM_THRESHOLD) {
      const ok = window.confirm(
        `This will fetch ${selection.pages.length} additional pages from the forum (~${Math.ceil(selection.pages.length * 0.5)}s at minimum, possibly tripping rate limits on big threads). Continue?`,
      )
      if (!ok) return
    }

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    try {
      let postsToAnalyze = detection.posts
      let hasMiddleGap = false

      if (selection.pages.length > 0) {
        postsToAnalyze = await fetchSpecificPagesPosts(
          detection,
          selection.pages,
          (msg) => setAnalysis({ kind: 'fetching', message: msg }),
          abort.signal,
        )
        hasMiddleGap = selection.hasMiddleGap
      }

      // Manual scope: filter to the requested [startPost, endPost] range and
      // renumber positions to be thread-global (so the model sees "Post #25"
      // instead of position-within-fetched-batch).
      if (selection.manualRange) {
        const { startPost, endPost, pageOffset } = selection.manualRange
        postsToAnalyze = postsToAnalyze
          .map((p, i) => ({ ...p, position: pageOffset + i + 1 }))
          .filter((p) => p.position >= startPost && p.position <= endPost)
          .map((p) => ({
            ...p,
            id: `post_${p.position}_${p.author.slice(0, 30)}_${p.content.slice(0, 50)}`,
          }))
      }

      setAnalysis({ kind: 'thread-running', progress: [], rollingSummary: '' })

      const gen = summarizeThread(
        provider,
        {
          url: detection.pagination.canonicalUrl,
          title: hasMiddleGap
            ? `${detection.title} (selected slice of a larger thread)`
            : detection.title,
          platform: detection.platform,
        },
        postsToAnalyze,
        {
          model,
          abortSignal: abort.signal,
          // LM Studio defaults Parallel=4 in newer releases; match it. Ollama
          // serializes per-model unless OLLAMA_NUM_PARALLEL is set, so we
          // stay at 1 (queued requests would just sit waiting).
          concurrency: settings.providerId === 'lmstudio' ? 4 : 1,
          // Vision toggle: only pass fetchImage when user has it enabled AND
          // we're not on a non-vision model. The latter check is also done
          // inside the summarizer, but skipping the callback early saves cycles.
          ...(useImages && { fetchImage: fetchImageFromActiveTab }),
        },
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
  }, [settings, detection, scope, useImages])

  const onCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const onRefresh = useCallback(() => {
    void probeActiveTab(setDetection, setAnalysis)
  }, [])

  /**
   * Loaded-models list is Ollama-specific (LM Studio doesn't expose hot model
   * state via its public API). Gate the whole feature to providerId='ollama'.
   */
  const refreshLoadedModels = useCallback(async () => {
    if (!settings || settings.providerId !== 'ollama' || conn.kind !== 'ok') {
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

  useEffect(() => {
    void refreshLoadedModels()
  }, [conn.kind, analysis.kind === 'done', settings?.providerId, settings?.ollama.baseUrl])

  /**
   * Vision capability: drives whether the "Include images" toggle appears
   * in ThreadCard. Providers without an isVisionCapable method (LM Studio)
   * can't introspect, so we show the toggle and let the user decide.
   */
  useEffect(() => {
    if (!settings || conn.kind !== 'ok') { setVisionModel(false); return }
    const provider = createProvider(settings)
    const model = activeProviderConfig(settings).model
    let cancelled = false
    if (provider.isVisionCapable) {
      void provider.isVisionCapable(model).then((v) => {
        if (!cancelled) setVisionModel(v)
      })
    } else {
      setVisionModel(true)
    }
    return () => { cancelled = true }
  }, [
    settings?.providerId,
    settings?.ollama.baseUrl,
    settings?.ollama.model,
    settings?.lmstudio.baseUrl,
    settings?.lmstudio.model,
    conn.kind,
  ])

  const onUnloadAll = useCallback(async () => {
    if (!settings || settings.providerId !== 'ollama' || loadedModels.length === 0) return
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

  // When a thread is detected, pick a sensible default scope: bookend for
  // anything over the "huge" threshold so users get a rough idea quickly
  // rather than accidentally fetching 100 pages. This-page otherwise.
  // Only fires when canonical URL changes, so user's manual scope choice
  // sticks while they stay on the same thread.
  useEffect(() => {
    if (detection.kind !== 'ready') return
    const totalPosts =
      detection.pagination.totalPosts ??
      detection.posts.length * detection.pagination.totalPages
    if (totalPosts > HUGE_THREAD_THRESHOLD_POSTS) {
      setScope({ kind: 'bookend', postsPerSide: BOOKEND_POSTS_PER_SIDE })
    } else {
      setScope({ kind: 'this-page' })
    }
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
        const provider = createProvider(settings)
        const model = activeProviderConfig(settings).model

        // If the model takes images, prefer images from keyword-relevant posts.
        // But — keyword search may miss image-bearing posts entirely (a query
        // like "describe the images" matches text content, not <img> tags).
        // Supplement with round-robin from the rest of the indexed thread so
        // the model always gets something to look at when we have something
        // to show. Tighter cap than summarize paths — query mode is interactive.
        //
        // Vision gate honors the user's Include images toggle: when off, we
        // skip fetching entirely. When on, we ask the provider whether the
        // model supports images (absent method = unknown → trust the toggle).
        const providerSaysVision =
          provider.isVisionCapable
            ? await provider.isVisionCapable(model)
            : true
        const visionCapable = useImages && providerSaysVision
        let queryImages: string[] = []
        if (visionCapable) {
          queryImages = await collectImages(
            relevantPosts,
            fetchImageFromActiveTab,
            MAX_QUERY_IMAGES,
            abort.signal,
          )
          if (queryImages.length < MAX_QUERY_IMAGES) {
            const allPosts = await getPostsByThread(detection.pagination.canonicalUrl)
            const relevantIds = new Set(relevantPosts.map((p) => p.id))
            const supplementary = allPosts.filter((p) => !relevantIds.has(p.id))
            const more = await collectImagesRoundRobin(
              supplementary,
              fetchImageFromActiveTab,
              MAX_QUERY_IMAGES - queryImages.length,
              abort.signal,
            )
            queryImages = [...queryImages, ...more]
          }
        }

        const baseMessages = buildAnswerQueryMessages(
          trimmed,
          cachedSummary,
          relevantPosts,
          detection.title,
        )
        const messages = attachImagesToLastMessage(baseMessages, queryImages)

        let acc = ''
        for await (const chunk of provider.generateStream(messages, {
          model,
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

  const onDropThreadCache = useCallback(async () => {
    if (!canonicalUrl) return
    await clearThread(canonicalUrl)
    setCachedSummary('')
    setIndexedPostCount(0)
    setQuery({ kind: 'idle' })
    setAnalysis({ kind: 'idle' })
  }, [canonicalUrl])

  /**
   * Auto-follow: when the user navigates within the same thread (same canonical
   * URL), summarize the new page and roll the meta over all chunks. Renumbers
   * posts to thread-global positions using the page-offset so the model sees
   * "Post #41" instead of "Post #1" on page 3 of a 20-per-page forum.
   */
  const runAutoFollowSummary = useCallback(async () => {
    if (!settings || detection.kind !== 'ready') return
    if (detection.posts.length === 0) return

    const provider = createProvider(settings)
    const model = activeProviderConfig(settings).model

    const ppp = postsPerPageEstimate(detection.pagination, detection.posts.length)
    const globalOffset = (detection.pagination.currentPage - 1) * ppp
    const posts = detection.posts.map((p, i) => {
      const position = globalOffset + i + 1
      return {
        ...p,
        position,
        id: `post_${position}_${p.author.slice(0, 30)}_${p.content.slice(0, 50)}`,
      }
    })

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    try {
      setAnalysis({ kind: 'thread-running', progress: [], rollingSummary: '' })
      const gen = summarizeThread(
        provider,
        {
          url: detection.pagination.canonicalUrl,
          title: detection.title,
          platform: detection.platform,
        },
        posts,
        {
          model,
          abortSignal: abort.signal,
          concurrency: settings.providerId === 'lmstudio' ? 4 : 1,
          ...(useImages && { fetchImage: fetchImageFromActiveTab }),
          mode: 'incremental',
        },
      )

      const events: ProgressEvent[] = []
      let rolling = ''
      let final = ''
      while (true) {
        const next = await gen.next()
        if (next.done) {
          final = next.value
          break
        }
        const evt = next.value
        events.push(evt)
        if (evt.kind === 'chunk-done') rolling = evt.summary
        if (evt.kind === 'meta-done' || evt.kind === 'final-done') {
          rolling = evt.summary
        }
        setAnalysis({
          kind: 'thread-running',
          progress: [...events],
          rollingSummary: rolling,
        })
      }
      setAnalysis({ kind: 'done', finalSummary: final, source: 'thread' })

      const currentPage = detection.pagination.currentPage
      setAutoFollowLocal((prev) => {
        if (!prev.enabled) return prev
        const next: AutoFollowState = {
          ...prev,
          processedPages: [...new Set([...prev.processedPages, currentPage])].sort(
            (a, b) => a - b,
          ),
        }
        void setAutoFollow(next)
        return next
      })
    } catch (err) {
      setAnalysis({
        kind: 'error',
        msg: err instanceof Error ? err.message : String(err),
      })
    } finally {
      abortRef.current = null
    }
  }, [settings, detection, useImages])

  /**
   * Toggle handler. Enabling captures the current detection's canonical URL as
   * the followed thread. Switching threads (toggling on while looking at a
   * different thread than previously followed) clears prior processedPages.
   * Disabling clears the followed thread.
   */
  const onAutoFollowToggle = useCallback(
    async (enabled: boolean) => {
      if (enabled && detection.kind !== 'ready') return
      const next: AutoFollowState = enabled
        ? {
            enabled: true,
            canonicalUrl: (detection as DetectionReady).pagination.canonicalUrl,
            processedPages:
              autoFollow.canonicalUrl ===
              (detection as DetectionReady).pagination.canonicalUrl
                ? autoFollow.processedPages
                : [],
          }
        : { enabled: false, canonicalUrl: null, processedPages: [] }
      setAutoFollowLocal(next)
      await setAutoFollow(next)
    },
    [detection, autoFollow],
  )

  // Re-probe on tab page-loads so detection stays current. During an in-flight
  // analysis we defer the probe — running setAnalysis(idle) under our feet
  // would clobber progress state. The pending flag triggers a probe once the
  // run completes.
  useEffect(() => {
    const onUpdated = (
      _tabId: number,
      changeInfo: { status?: string },
    ) => {
      if (changeInfo.status !== 'complete') return
      if (
        analysis.kind === 'thread-running' ||
        analysis.kind === 'fetching' ||
        analysis.kind === 'page-running'
      ) {
        pendingProbeRef.current = true
        return
      }
      void probeActiveTab(setDetection, setAnalysis)
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => chrome.tabs.onUpdated.removeListener(onUpdated)
  }, [analysis.kind])

  // Drain pending probe once we exit a running state.
  useEffect(() => {
    if (
      pendingProbeRef.current &&
      analysis.kind !== 'thread-running' &&
      analysis.kind !== 'fetching' &&
      analysis.kind !== 'page-running'
    ) {
      pendingProbeRef.current = false
      void probeActiveTab(setDetection, setAnalysis)
    }
  }, [analysis.kind])

  // Schedule the dwell-debounced auto-follow run. Cleared on detection change
  // (new URL = new schedule), on toggle off, on running, or on unmount.
  useEffect(() => {
    if (dwellTimerRef.current) {
      window.clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = null
    }
    if (!autoFollow.enabled) return
    if (detection.kind !== 'ready') return
    if (detection.pagination.canonicalUrl !== autoFollow.canonicalUrl) return
    if (detection.posts.length === 0) return
    const page = detection.pagination.currentPage
    if (autoFollow.processedPages.includes(page)) return
    if (
      analysis.kind === 'thread-running' ||
      analysis.kind === 'fetching' ||
      analysis.kind === 'page-running'
    ) {
      return
    }

    dwellTimerRef.current = window.setTimeout(() => {
      dwellTimerRef.current = null
      void runAutoFollowSummary()
    }, AUTO_FOLLOW_DWELL_MS)

    return () => {
      if (dwellTimerRef.current) {
        window.clearTimeout(dwellTimerRef.current)
        dwellTimerRef.current = null
      }
    }
  }, [autoFollow, detection, analysis.kind, runAutoFollowSummary])

  const onClearAllData = useCallback(async () => {
    const ok = window.confirm(
      'Delete all cached threads, posts, summaries, and settings? This can\'t be undone.',
    )
    if (!ok) return
    await clearAllData()
    await chrome.storage.local.clear()
    setCachedSummary('')
    setIndexedPostCount(0)
    setQuery({ kind: 'idle' })
    setAnalysis({ kind: 'idle' })
    setLoadedModels([])
    setHasConnected(false)
    setAutoFollowLocal({ enabled: false, canonicalUrl: null, processedPages: [] })
    const fresh = await getSettings()
    setLocalSettings(fresh)
    void testConnection(fresh, setConn)
  }, [])

  if (!settings) return <main><p className="hint">Loading…</p></main>

  const showWelcome = !hasConnected && conn.kind !== 'ok'

  return (
    <main>
      <header>
        <h1>ThreadWeaver</h1>
      </header>

      {showWelcome && (
        <WelcomeCard
          currentProvider={settings.providerId}
          onPickProvider={(id) => void setProviderId(id)}
        />
      )}

      <SettingsCard
        settings={settings}
        conn={conn}
        loadedModels={loadedModels}
        unloading={unloading}
        onProviderChange={(id) => void setProviderId(id)}
        onChange={updateProviderConfig}
        onTest={() => {
          void testConnection(settings, setConn)
          void refreshLoadedModels()
        }}
        onRefreshLoaded={() => void refreshLoadedModels()}
        onUnloadAll={onUnloadAll}
        onClearAllData={() => void onClearAllData()}
      />

      <ThreadCard
        detection={detection}
        analysis={analysis}
        connReady={conn.kind === 'ok'}
        scope={scope}
        onScopeChange={setScope}
        visionModel={visionModel}
        useImages={useImages}
        onUseImagesChange={setUseImages}
        onAnalyze={onAnalyze}
        onCancel={onCancel}
        onRefresh={onRefresh}
        autoFollow={autoFollow}
        onAutoFollowToggle={(b) => void onAutoFollowToggle(b)}
      />

      <SummaryCard
        analysis={analysis}
        cachedSummary={cachedSummary}
        indexedPostCount={indexedPostCount}
        onDrop={() => void onDropThreadCache()}
      />

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

function WelcomeCard({
  currentProvider,
  onPickProvider,
}: {
  currentProvider: Settings['providerId']
  onPickProvider: (id: Settings['providerId']) => void
}) {
  const [detected, setDetected] = useState<{
    ollama: boolean
    lmstudio: boolean
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void probeBothRuntimes().then((r) => {
      if (!cancelled) setDetected(r)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="card welcome">
      <h2>Welcome to ThreadWeaver</h2>
      <p className="hint">
        Pick a local LLM runtime to get started. Both run on your machine —
        your forum threads never leave it.
      </p>
      <div className="welcome-options">
        <button
          className={`welcome-option ${currentProvider === 'ollama' ? 'active' : ''}`}
          onClick={() => onPickProvider('ollama')}
        >
          <div className="welcome-option-title">
            Ollama
            {detected?.ollama && <span className="badge ok"> detected </span>}
          </div>
          <div className="welcome-option-desc">
            Simple CLI install. Pull a model with{' '}
            <code>ollama pull llama3.2:3b</code>.
          </div>
        </button>
        <button
          className={`welcome-option ${currentProvider === 'lmstudio' ? 'active' : ''}`}
          onClick={() => onPickProvider('lmstudio')}
        >
          <div className="welcome-option-title">
            LM Studio
            {detected?.lmstudio && <span className="badge ok"> detected </span>}
          </div>
          <div className="welcome-option-desc">
            GUI app. Wider model selection (GGUF + MLX).{' '}
            <strong>Enable CORS</strong> in Developer settings.
          </div>
        </button>
      </div>
      <p className="hint">
        Then click <strong>Test connection</strong> below.
      </p>
    </section>
  )
}

async function probeBothRuntimes(): Promise<{
  ollama: boolean
  lmstudio: boolean
}> {
  const ping = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { method: 'GET' })
      return res.ok
    } catch {
      return false
    }
  }
  const [ollama, lmstudio] = await Promise.all([
    ping('http://localhost:11434/api/tags'),
    ping('http://localhost:1234/v1/models'),
  ])
  return { ollama, lmstudio }
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
  onProviderChange,
  onClearAllData,
}: {
  settings: Settings
  conn: ConnState
  loadedModels: LoadedModel[]
  unloading: boolean
  onProviderChange: (id: Settings['providerId']) => void
  onChange: (patch: Partial<{ baseUrl: string; model: string }>) => Promise<void>
  onTest: () => void
  onRefreshLoaded: () => void
  onUnloadAll: () => void
  onClearAllData: () => void
}) {
  const current = activeProviderConfig(settings)
  const isOllama = settings.providerId === 'ollama'
  const isLMStudio = settings.providerId === 'lmstudio'

  return (
    <section className="card">
      <h2>Settings</h2>
      <label>
        Provider
        <select
          value={settings.providerId}
          onChange={(e) => onProviderChange(e.target.value as Settings['providerId'])}
        >
          <option value="ollama">Ollama (local)</option>
          <option value="lmstudio">LM Studio (local)</option>
        </select>
      </label>
      <label>
        Base URL
        <input
          type="text"
          value={current.baseUrl}
          onChange={(e) => void onChange({ baseUrl: e.target.value })}
          spellCheck={false}
        />
      </label>
      {isLMStudio && (
        <p className="hint">
          LM Studio: <strong>Enable CORS</strong> in the Developer panel.
          Crank <strong>Context Length</strong> when loading a model —
          bigger context = fewer chunks = faster, sharper summaries. Most
          modern models support 32K-128K; push it. Set{' '}
          <strong>Parallel ≥ 2</strong> in LM Studio to let the extension run
          chunks concurrently for a real speedup on multi-chunk threads.
        </p>
      )}
      <label>
        Model
        <select
          value={current.model}
          onChange={(e) => void onChange({ model: e.target.value })}
          disabled={conn.kind !== 'ok'}
        >
          {conn.kind === 'ok' && current.model && !conn.models.includes(current.model) && (
            <option value={current.model}>
              {current.model} (not available)
            </option>
          )}
          {conn.kind === 'ok' && !current.model && (
            <option value="">— pick a model —</option>
          )}
          {conn.kind === 'ok'
            ? conn.models.map((m) => <option key={m} value={m}>{m}</option>)
            : <option value={current.model}>{current.model || '(not connected)'}</option>}
        </select>
      </label>
      <div className="row">
        <button onClick={onTest}>
          {conn.kind === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <ConnBadge state={conn} />
      </div>
      {conn.kind === 'empty' && isOllama && (
        <p className="hint">
          Ollama is running but no models are installed. Pull one in a terminal:
          <code className="block">ollama pull llama3.2:3b</code>
          then click <strong>Test connection</strong> again.
        </p>
      )}
      {conn.kind === 'empty' && isLMStudio && (
        <p className="hint">
          LM Studio server is up but reports no models. Download one in LM Studio's
          Search/Discover tab and load it via the Server tab, then click
          <strong> Test connection</strong>.
        </p>
      )}
      {conn.kind === 'origin-blocked' && (
        <p className="hint error">
          Ollama is running but blocks requests from this extension's origin (returned 403).
          Set <code>OLLAMA_ORIGINS</code> and restart Ollama from the tray:
          <code className="block">[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")</code>
        </p>
      )}
      {conn.kind === 'unreachable' && (
        <p className="hint error">
          {conn.msg}
          {isLMStudio && (
            <>
              {' '}LM Studio also needs <strong>Enable CORS</strong> toggled on in
              the Developer panel to accept requests from the extension.
            </>
          )}
        </p>
      )}
      {conn.kind === 'ok' && isOllama && (
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
      <div className="data-section">
        <span className="loaded-label">Data</span>
        <button
          className="link danger"
          onClick={onClearAllData}
          title="Wipe all cached threads, posts, summaries, and settings"
        >Clear all data</button>
      </div>
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
  scope,
  onScopeChange,
  visionModel,
  useImages,
  onUseImagesChange,
  onAnalyze,
  onCancel,
  onRefresh,
  autoFollow,
  onAutoFollowToggle,
}: {
  detection: Detection
  analysis: Analysis
  connReady: boolean
  scope: AnalysisScope
  onScopeChange: (s: AnalysisScope) => void
  visionModel: boolean
  useImages: boolean
  onUseImagesChange: (b: boolean) => void
  onAnalyze: () => void
  onCancel: () => void
  onRefresh: () => void
  autoFollow: AutoFollowState
  onAutoFollowToggle: (enabled: boolean) => void
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
  const isHuge = totalPosts > HUGE_THREAD_THRESHOLD_POSTS

  const scopeKey: string = (() => {
    switch (scope.kind) {
      case 'this-page': return 'this-page'
      case 'bookend': return 'bookend'
      case 'last': return 'last'
      case 'all': return 'all'
      case 'manual': return 'manual'
    }
  })()

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
            <>
              <label>
                Scope
                <select
                  value={scopeKey}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'this-page') onScopeChange({ kind: 'this-page' })
                    else if (v === 'bookend') onScopeChange({ kind: 'bookend', postsPerSide: BOOKEND_POSTS_PER_SIDE })
                    else if (v === 'last') onScopeChange({ kind: 'last', postCount: LAST_N_POSTS })
                    else if (v === 'all') onScopeChange({ kind: 'all' })
                    else if (v === 'manual') onScopeChange({
                      kind: 'manual',
                      startPost: 1,
                      endPost: Math.min(totalPosts, 50),
                    })
                  }}
                  disabled={running}
                >
                  <option value="this-page">This page only ({detection.posts.length} posts)</option>
                  <option value="bookend">
                    Bookend (first {BOOKEND_POSTS_PER_SIDE} + last {BOOKEND_POSTS_PER_SIDE})
                  </option>
                  <option value="last">Last {LAST_N_POSTS} posts</option>
                  <option value="manual">Manual range…</option>
                  <option value="all">
                    Full thread ({totalIsExact ? '' : '~'}{totalPosts} posts{isHuge ? ' — confirm needed' : ''})
                  </option>
                </select>
              </label>

              {scope.kind === 'manual' && (
                <div className="manual-range">
                  <label>
                    From post #
                    <input
                      type="number"
                      min={1}
                      max={totalPosts}
                      value={scope.startPost}
                      onChange={(e) => {
                        const v = Math.max(1, parseInt(e.target.value, 10) || 1)
                        onScopeChange({ ...scope, startPost: v })
                      }}
                      disabled={running}
                    />
                  </label>
                  <label>
                    To post #
                    <input
                      type="number"
                      min={scope.startPost}
                      max={totalPosts}
                      value={scope.endPost}
                      onChange={(e) => {
                        const v = Math.max(
                          scope.startPost,
                          parseInt(e.target.value, 10) || scope.startPost,
                        )
                        onScopeChange({ ...scope, endPost: v })
                      }}
                      disabled={running}
                    />
                  </label>
                  <span className="hint">
                    {scope.endPost - scope.startPost + 1} posts requested. Post
                    numbering is thread-global; we'll fetch only the pages
                    covering this range.
                  </span>
                </div>
              )}
            </>
          )}

          {visionModel && (
            <label className="row">
              <input
                type="checkbox"
                checked={useImages}
                onChange={(e) => onUseImagesChange(e.target.checked)}
                disabled={running}
              />
              <span>Include images (vision-capable model)</span>
            </label>
          )}

          {isMultiPage && (
            <label className="row auto-follow-row">
              <input
                type="checkbox"
                checked={
                  autoFollow.enabled &&
                  autoFollow.canonicalUrl === detection.pagination.canonicalUrl
                }
                onChange={(e) => onAutoFollowToggle(e.target.checked)}
              />
              <span>
                Auto-follow this thread
                {autoFollow.enabled &&
                  autoFollow.canonicalUrl ===
                    detection.pagination.canonicalUrl && (
                    <>
                      {' '}— <em>
                        {autoFollow.processedPages.length} of{' '}
                        {detection.pagination.totalPages} page
                        {detection.pagination.totalPages === 1 ? '' : 's'}{' '}
                        summarized
                      </em>
                    </>
                  )}
              </span>
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
            ? analyzeButtonLabel(scope, detection.posts.length, totalPosts, totalIsExact)
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

function analyzeButtonLabel(
  scope: AnalysisScope,
  postsOnPage: number,
  totalPosts: number,
  totalIsExact: boolean,
): string {
  const approx = totalIsExact ? '' : '~'
  switch (scope.kind) {
    case 'this-page': return `Analyze this page (${postsOnPage} posts)`
    case 'bookend': return `Analyze bookend (${scope.postsPerSide * 2} posts)`
    case 'last': return `Analyze last ${scope.postCount} posts`
    case 'all': return `Analyze full thread (${approx}${totalPosts} posts)`
    case 'manual': return `Analyze posts ${scope.startPost}–${scope.endPost}`
  }
}

function ProgressList({ events }: { events: ProgressEvent[] }) {
  const lines = events
    .map((e) => {
      switch (e.kind) {
        case 'started':
          return `Starting: ${e.totalPosts} posts in ${e.totalChunks} chunk${e.totalChunks === 1 ? '' : 's'}`
        case 'chunk-started':
          return `Chunk ${e.chunkIndex + 1}/${e.totalChunks}: summarizing ${e.posts} posts${e.images ? ` + ${e.images} image${e.images === 1 ? '' : 's'}` : ''}…`
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
  indexedPostCount,
  onDrop,
}: {
  analysis: Analysis
  cachedSummary: string
  indexedPostCount: number
  onDrop: () => void
}) {
  const live =
    analysis.kind === 'thread-running' ? analysis.rollingSummary
    : analysis.kind === 'done' ? analysis.finalSummary
    : analysis.kind === 'error' ? ''
    : ''

  const display = live || cachedSummary
  if (!display && analysis.kind !== 'error') return null

  // Show Drop affordance whenever there's anything in the DB for this thread.
  // Disable mid-run so users don't yank state out from under the summarizer.
  const canDrop =
    (cachedSummary.length > 0 || indexedPostCount > 0) &&
    analysis.kind !== 'thread-running' &&
    analysis.kind !== 'fetching' &&
    analysis.kind !== 'page-running'

  return (
    <section className="card">
      <div className="row between">
        <div className="row">
          <h2>Summary</h2>
          {analysis.kind === 'thread-running' && <span className="badge">live</span>}
          {analysis.kind === 'done' && <span className="badge ok">final</span>}
          {!live && cachedSummary && <span className="badge">cached</span>}
        </div>
        {canDrop && (
          <button
            className="link"
            onClick={onDrop}
            title="Delete cached posts + summary for this thread"
          >Drop cache</button>
        )}
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
  const provider = createProvider(settings)

  // Ollama has a richer probe (distinguishes origin-blocked from unreachable
  // via a follow-up POST). Generic providers just do listModels and report
  // ok / empty / unreachable.
  if (provider instanceof OllamaProvider) {
    setConn(await provider.verifyAccess())
    return
  }
  try {
    const models = await provider.listModels()
    setConn(models.length === 0 ? { kind: 'empty' } : { kind: 'ok', models })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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
      pagination: res.pagination,
    })
  } catch {
    setDetection({ kind: 'no-content-script' })
  }
}

type DetectionReady = Extract<Detection, { kind: 'ready' }>

const POLITENESS_DELAY_MS = 200

/**
 * Fetch a specific set of pages (1-based numbers) via the active tab's content
 * script, merge with the already-rendered current page in order, dedupe by
 * (author + content snippet), renumber positions globally.
 *
 * Empty `extraPages` returns the current page's posts unchanged.
 */
async function fetchSpecificPagesPosts(
  detection: DetectionReady,
  extraPages: number[],
  onProgress: (msg: string) => void,
  signal: AbortSignal,
): Promise<Post[]> {
  if (extraPages.length === 0) return detection.posts

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')

  const allUrls = derivePageUrls(detection.pagination)
  const currentPage = detection.pagination.currentPage
  // Build ordered (page → posts) map. Pre-fill current page; fetch the rest.
  const fetched = new Map<number, Post[]>()
  fetched.set(currentPage, detection.posts)

  for (let i = 0; i < extraPages.length; i++) {
    const page = extraPages[i]
    if (page === currentPage) continue
    if (signal.aborted) throw new Error('Aborted')

    onProgress(
      `Fetching page ${page}${extraPages.length > 1 ? ` (${i + 1} of ${extraPages.length})` : ''}…`,
    )
    const req: ContentRequest = { type: 'FETCH_PAGE_POSTS', url: allUrls[page - 1] }
    const res = (await chrome.tabs.sendMessage(tab.id, req)) as ContentResponse
    if (!res || res.type !== 'FETCHED_POSTS') {
      throw new Error(`Unexpected response from content script for page ${page}`)
    }
    if (res.error) throw new Error(`Page ${page}: ${res.error}`)
    fetched.set(page, res.posts)
    await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS))
  }

  // Reassemble in page order.
  const orderedPages = [...fetched.keys()].sort((a, b) => a - b)
  const merged: Post[] = []
  for (const p of orderedPages) {
    const arr = fetched.get(p)
    if (arr) merged.push(...arr)
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

/**
 * Asks the active tab's content script to fetch and base64-encode an image
 * URL using the page's session cookies. Returns null on any failure so the
 * summarizer can silently skip uncooperative images.
 */
async function fetchImageFromActiveTab(url: string): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return null
    const req: ContentRequest = { type: 'FETCH_IMAGE_BASE64', url }
    const res = (await chrome.tabs.sendMessage(tab.id, req)) as ContentResponse
    if (!res || res.type !== 'FETCHED_IMAGE') return null
    if (res.error || !res.base64) return null
    return res.base64
  } catch {
    return null
  }
}

async function runPageSummary(
  provider: LLMProvider,
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
