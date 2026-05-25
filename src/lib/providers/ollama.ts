import {
  type ChatMessage,
  type GenerateOptions,
  type GenerateResult,
  type LLMProvider,
  ProviderError,
} from './types'

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434'
export const OLLAMA_DEFAULT_MODEL = 'llama3.2:3b'

interface OllamaTagsResponse {
  models?: Array<{ name: string }>
}

interface OllamaPSResponse {
  models?: Array<{
    name?: string
    model?: string
    size?: number
    size_vram?: number
  }>
}

export interface LoadedModel {
  name: string
  /** Total model size in bytes (sum of RAM + VRAM). */
  sizeBytes: number
  /** Bytes resident in VRAM. 0 means CPU-only. */
  sizeVramBytes: number
}

interface OllamaChatResponse {
  message?: { content?: string }
  prompt_eval_count?: number
  eval_count?: number
  done?: boolean
}

/**
 * Cap context window we'll request. Avoids VRAM blow-up on 128K-context models
 * while still being plenty for chunked forum summaries. Raise via settings
 * later if needed.
 */
const MAX_CTX_REQUEST = 32768
const FALLBACK_CTX = 4096

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama' as const
  readonly label = 'Ollama (local)'
  readonly defaultModel = OLLAMA_DEFAULT_MODEL

  private baseUrl: string
  // Per-base-URL cache lives on the instance; in practice we new up a provider
  // per request so this is short-lived, but the cost of /api/show per model
  // call is low.
  private ctxCache = new Map<string, number>()

  constructor(baseUrl: string = OLLAMA_DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  /**
   * Read the model's architectural max context from /api/show. Returns 4096
   * if discovery fails (covers ancient Ollama / weird model shapes). Cached.
   */
  private async getModelMaxContext(model: string): Promise<number> {
    const cached = this.ctxCache.get(model)
    if (cached !== undefined) return cached

    let ctx = FALLBACK_CTX
    try {
      const res = await fetch(this.url('/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          model_info?: Record<string, unknown>
          parameters?: string
        }
        const info = data.model_info
        if (info) {
          for (const k of Object.keys(info)) {
            if (k.endsWith('.context_length')) {
              const v = info[k]
              if (typeof v === 'number' && v > 0) { ctx = v; break }
            }
          }
        }
        // Fall back to PARAMETER num_ctx in the Modelfile if model_info missed.
        if (ctx === FALLBACK_CTX && typeof data.parameters === 'string') {
          const m = data.parameters.match(/^\s*num_ctx\s+(\d+)/m)
          if (m) ctx = parseInt(m[1], 10)
        }
      }
    } catch {
      // network or parse failure — keep FALLBACK_CTX
    }
    this.ctxCache.set(model, ctx)
    return ctx
  }

  /** Resolved num_ctx for the request: model's max, clamped to MAX_CTX_REQUEST. */
  private async resolveCtx(model: string): Promise<number> {
    return Math.min(await this.getModelMaxContext(model), MAX_CTX_REQUEST)
  }

  async listModels(): Promise<string[]> {
    let res: Response
    try {
      res = await fetch(this.url('/api/tags'))
    } catch (err) {
      throw new ProviderError(
        `Cannot reach Ollama at ${this.baseUrl}. Is the daemon running?`,
        this.id,
        err,
      )
    }
    if (!res.ok) {
      throw new ProviderError(
        `Ollama /api/tags returned ${res.status}`,
        this.id,
      )
    }
    const data = (await res.json()) as OllamaTagsResponse
    return (data.models ?? []).map((m) => m.name)
  }

  async generate(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const model = opts.model ?? this.defaultModel
    const num_ctx = await this.resolveCtx(model)
    const body = {
      model,
      messages,
      stream: false,
      // Ollama 0.5+: native suppression of reasoning channel on thinking models
      // (deepseek-r1, qwen3, gpt-oss, qwq). Older Ollama silently ignores the
      // field, so we still post-process for inline <think>...</think> tags.
      think: false,
      options: {
        num_ctx,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
      },
    }

    let res: Response
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.abortSignal,
      })
    } catch (err) {
      throw new ProviderError(
        `Cannot reach Ollama at ${this.baseUrl}`,
        this.id,
        err,
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(
        `Ollama /api/chat returned ${res.status}: ${detail}`,
        this.id,
      )
    }

    const data = (await res.json()) as OllamaChatResponse
    return {
      text: stripThinkTags(data.message?.content ?? ''),
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
      },
    }
  }

  async *generateStream(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): AsyncIterable<string> {
    const model = opts.model ?? this.defaultModel
    const num_ctx = await this.resolveCtx(model)
    const body = {
      model,
      messages,
      stream: true,
      think: false,
      options: {
        num_ctx,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
      },
    }

    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    })

    if (!res.ok || !res.body) {
      throw new ProviderError(
        `Ollama /api/chat stream returned ${res.status}`,
        this.id,
      )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const filter = new ThinkFilter()

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const chunk = JSON.parse(line) as OllamaChatResponse
        const piece = chunk.message?.content
        if (piece) {
          const filtered = filter.push(piece)
          if (filtered) yield filtered
        }
        if (chunk.done) {
          const tail = filter.flush()
          if (tail) yield tail
          return
        }
      }
    }
    const tail = filter.flush()
    if (tail) yield tail
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4)
  }

  /**
   * List models currently resident in memory (RAM or VRAM). Distinct from
   * listModels(), which enumerates everything `ollama pull`'d.
   */
  async listLoadedModels(): Promise<LoadedModel[]> {
    let res: Response
    try {
      res = await fetch(this.url('/api/ps'))
    } catch (err) {
      throw new ProviderError(
        `Cannot reach Ollama at ${this.baseUrl}`,
        this.id,
        err,
      )
    }
    if (!res.ok) {
      throw new ProviderError(
        `Ollama /api/ps returned ${res.status}`,
        this.id,
      )
    }
    const data = (await res.json()) as OllamaPSResponse
    return (data.models ?? []).map((m) => ({
      name: m.name ?? m.model ?? '(unknown)',
      sizeBytes: m.size ?? 0,
      sizeVramBytes: m.size_vram ?? 0,
    }))
  }

  /**
   * Request Ollama to evict a model from memory immediately. Implemented by
   * POSTing a no-op generate with keep_alive:0; the daemon unloads and returns.
   * Best-effort — errors are surfaced but unlikely to be actionable.
   */
  async unloadModel(name: string): Promise<void> {
    const res = await fetch(this.url('/api/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0 }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(
        `Ollama unload of ${name} returned ${res.status}: ${detail}`,
        this.id,
      )
    }
  }

  /**
   * Probe the daemon to discover models AND verify the origin allowlist.
   *
   * GET /api/tags can succeed when POSTs are 403'd (Ollama's origin check is
   * only applied to mutating methods). To catch that case in "Test connection",
   * we follow up with a POST to /api/show — lightweight (no model load),
   * but exercises the same origin enforcement path as /api/chat.
   */
  async verifyAccess(): Promise<VerifyResult> {
    let models: string[]
    try {
      models = await this.listModels()
    } catch (err) {
      const msg = err instanceof ProviderError ? err.message
        : err instanceof Error ? err.message
        : String(err)
      return { kind: 'unreachable', msg }
    }

    if (models.length === 0) return { kind: 'empty' }

    let probe: Response
    try {
      probe = await fetch(this.url('/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: models[0] }),
      })
    } catch (err) {
      return {
        kind: 'unreachable',
        msg: err instanceof Error ? err.message : String(err),
      }
    }

    if (probe.status === 403) return { kind: 'origin-blocked', models }
    if (!probe.ok) {
      const detail = await probe.text().catch(() => '')
      return {
        kind: 'unreachable',
        msg: `Ollama /api/show returned ${probe.status}: ${detail}`,
      }
    }

    return { kind: 'ok', models }
  }
}

export type VerifyResult =
  | { kind: 'ok'; models: string[] }
  | { kind: 'empty' }
  | { kind: 'origin-blocked'; models: string[] }
  | { kind: 'unreachable'; msg: string }

/**
 * Strip <think>...</think> and <thinking>...</thinking> reasoning blocks
 * emitted inline by deepseek-r1, qwen3, qwq, and similar thinking models.
 * Multiple blocks supported. Trims leading whitespace left behind.
 */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
    .trimStart()
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/**
 * Stateful streaming filter for <think>...</think> blocks. Three states:
 *   - 'pre'      : haven't decided yet, may start with <think>; buffer
 *   - 'thinking' : inside a think block; discard until </think>
 *   - 'output'   : passthrough mode
 *
 * Holds back trailing chars that could be the start of an open/close tag so
 * we never yield a partial tag. Multiple think blocks aren't expected in
 * practice (Ollama emits one per turn) and aren't supported.
 */
class ThinkFilter {
  private state: 'pre' | 'thinking' | 'output' = 'pre'
  private buf = ''
  private readonly preLookahead = 32

  push(piece: string): string {
    if (this.state === 'output') return piece
    this.buf += piece

    if (this.state === 'pre') {
      const trimmed = this.buf.trimStart()
      if (trimmed.startsWith(THINK_OPEN)) {
        const start = this.buf.indexOf(THINK_OPEN)
        this.buf = this.buf.slice(start + THINK_OPEN.length)
        this.state = 'thinking'
      } else if (this.buf.length < this.preLookahead) {
        // wait for more — could still resolve to <think>
        return ''
      } else if (mightStartThink(this.buf)) {
        // we've seen <th... or similar — could still complete to <think>
        return ''
      } else {
        // definitely no think block — flush + passthrough
        this.state = 'output'
        const out = this.buf
        this.buf = ''
        return out
      }
    }

    if (this.state === 'thinking') {
      const closeIdx = this.buf.indexOf(THINK_CLOSE)
      if (closeIdx === -1) {
        // Could end mid-closing-tag; hold back enough chars to be safe.
        const holdBack = Math.min(THINK_CLOSE.length - 1, this.buf.length)
        this.buf = this.buf.slice(this.buf.length - holdBack)
        return ''
      }
      const after = this.buf.slice(closeIdx + THINK_CLOSE.length).replace(/^\s+/, '')
      this.buf = ''
      this.state = 'output'
      return after
    }

    return ''
  }

  flush(): string {
    if (this.state === 'output') {
      const out = this.buf
      this.buf = ''
      return out
    }
    // Still 'pre' (never crossed lookahead) or 'thinking' (never saw close).
    // If 'pre', buffered content is real output that we held back — emit it.
    if (this.state === 'pre') {
      const out = this.buf
      this.buf = ''
      this.state = 'output'
      return out
    }
    // 'thinking' without close: discard, model presumably aborted mid-reasoning.
    this.buf = ''
    return ''
  }
}

function mightStartThink(s: string): boolean {
  // Returns true if the tail of `s` could be the start of "<think>"
  const tail = s.slice(-THINK_OPEN.length)
  for (let i = 1; i <= tail.length; i++) {
    if (THINK_OPEN.startsWith(tail.slice(-i))) return true
  }
  return false
}
