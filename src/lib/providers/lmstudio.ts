import {
  type ChatMessage,
  type GenerateOptions,
  type GenerateResult,
  type LLMProvider,
  ProviderError,
} from './types'

export const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234'

interface LMStudioModelsResponse {
  data?: Array<{ id?: string }>
}

/**
 * LM Studio's non-OpenAI v0 endpoint (introduced in 0.3.x) returns richer
 * per-model metadata than /v1/models. We use it for vision detection and
 * loaded-context-length introspection — both essential for adaptive
 * chunking and the Include images toggle UX.
 */
interface LMStudioV0Model {
  id?: string
  type?: string // 'llm' | 'vlm' | 'embeddings' (vlm == vision-language)
  state?: string // 'loaded' | 'not-loaded'
  /** User-configured context size for the currently-loaded model. */
  loaded_context_length?: number
  /** Maximum supported by the model architecture. */
  max_context_length?: number
}

interface LMStudioV0ModelsResponse {
  data?: LMStudioV0Model[]
}

interface CachedModelInfo {
  contextLength: number
  visionCapable: boolean
}

interface LMStudioChatResponse {
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface LMStudioStreamChunk {
  choices?: Array<{
    delta?: { content?: string }
    finish_reason?: string | null
  }>
}

type OpenAIMessage =
  | { role: string; content: string }
  | {
      role: string
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
    }

/**
 * Adapter for LM Studio's OpenAI-compatible server (default http://localhost:1234).
 *
 * Why we have it: LM Studio handles a much wider set of quantized / fine-tuned
 * GGUF and MLX models than Ollama does. Users who want to drive an unusual
 * model through ThreadWeaver point at LM Studio instead.
 *
 * Notable differences from OllamaProvider that flow through the abstraction:
 * - Streaming is OpenAI SSE (data: <json>\n, terminated by data: [DONE])
 * - Vision is OpenAI multipart content: messages[].content becomes an array
 *   of {type: text|image_url} parts instead of a flat string + images: [...]
 * - No /api/show equivalent — capability + context introspection isn't
 *   available, so isVisionCapable / getMaxContextTokens are deliberately
 *   omitted; callers treat absence as "unknown" and use safe defaults.
 *
 * Cross-Origin: LM Studio's server requires Enable CORS in its Developer
 * settings to accept chrome-extension origins. Failure presents as a network
 * error, not a 403 — see README troubleshooting.
 */
export class LMStudioProvider implements LLMProvider {
  readonly id = 'lmstudio' as const
  readonly label = 'LM Studio (local)'
  /** No sensible default — user must select a loaded model in LM Studio first. */
  readonly defaultModel = ''

  private baseUrl: string
  private infoCache = new Map<string, CachedModelInfo>()

  constructor(baseUrl: string = LM_STUDIO_DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  /**
   * Discover per-model metadata via LM Studio's v0 endpoint. Cached.
   * Returns null if v0 isn't available (older LM Studio) — callers degrade
   * to safe defaults (4096 context, no vision).
   */
  private async getModelInfo(modelId: string): Promise<CachedModelInfo | null> {
    const cached = this.infoCache.get(modelId)
    if (cached) return cached

    let res: Response
    try {
      res = await fetch(this.url('/api/v0/models'))
    } catch {
      return null
    }
    if (!res.ok) return null

    const data = (await res.json().catch(() => null)) as
      | LMStudioV0ModelsResponse
      | null
    if (!data) return null

    const model = data.data?.find((m) => m.id === modelId)
    if (!model) return null

    const info: CachedModelInfo = {
      // Prefer the loaded value — that's what the running model is actually
      // configured for. Fall back to the architectural max, then a floor.
      contextLength:
        model.loaded_context_length ?? model.max_context_length ?? 4096,
      visionCapable: model.type === 'vlm',
    }
    this.infoCache.set(modelId, info)
    return info
  }

  async listModels(): Promise<string[]> {
    let res: Response
    try {
      res = await fetch(this.url('/v1/models'))
    } catch (err) {
      throw new ProviderError(
        `Cannot reach LM Studio at ${this.baseUrl}. Is the Server tab running?`,
        this.id,
        err,
      )
    }
    if (!res.ok) {
      throw new ProviderError(
        `LM Studio /v1/models returned ${res.status}`,
        this.id,
      )
    }
    const data = (await res.json()) as LMStudioModelsResponse
    return (data.data ?? [])
      .map((m) => m.id ?? '')
      .filter((id): id is string => Boolean(id))
  }

  async generate(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const model = opts.model ?? this.defaultModel
    if (!model) throw new ProviderError('No model selected', this.id)

    const body = {
      model,
      messages: serializeMessages(messages),
      stream: false,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
    }

    let res: Response
    try {
      res = await fetch(this.url('/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.abortSignal,
      })
    } catch (err) {
      throw new ProviderError(
        `Cannot reach LM Studio at ${this.baseUrl} (CORS not enabled in Developer settings?)`,
        this.id,
        err,
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderError(friendlyChatError(res.status, detail), this.id)
    }

    const data = (await res.json()) as LMStudioChatResponse
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    }
  }

  async *generateStream(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): AsyncIterable<string> {
    const model = opts.model ?? this.defaultModel
    if (!model) throw new ProviderError('No model selected', this.id)

    const body = {
      model,
      messages: serializeMessages(messages),
      stream: true,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
    }

    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    })

    if (!res.ok || !res.body) {
      const detail = res.body ? await res.text().catch(() => '') : ''
      throw new ProviderError(friendlyChatError(res.status, detail), this.id)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by blank lines, but in practice OpenAI
      // emits one "data: <json>\n" per chunk. Split on \n and process each
      // data: line independently. [DONE] terminates the stream.
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line || !line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        try {
          const chunk = JSON.parse(payload) as LMStudioStreamChunk
          const piece = chunk.choices?.[0]?.delta?.content
          if (piece) yield piece
        } catch {
          /* skip malformed frames */
        }
      }
    }
  }

  async countTokens(text: string): Promise<number> {
    // LM Studio doesn't expose a token-count endpoint. chars/4 is good enough
    // for budgeting heuristics.
    return Math.ceil(text.length / 4)
  }

  /** True for vision-language models (type==='vlm' in /api/v0/models). */
  async isVisionCapable(model?: string): Promise<boolean> {
    const m = model ?? this.defaultModel
    if (!m) return false
    const info = await this.getModelInfo(m)
    return info?.visionCapable ?? false
  }

  /**
   * Returns the loaded model's configured context length. Critical: LM Studio
   * users can load a 32K-context model with only 4K configured at load time,
   * and our adaptive chunker needs to respect that or we get "n_keep > n_ctx"
   * errors. v0 reports loaded_context_length, which is what we want.
   */
  async getMaxContextTokens(model?: string): Promise<number> {
    const m = model ?? this.defaultModel
    if (!m) return 4096
    const info = await this.getModelInfo(m)
    return info?.contextLength ?? 4096
  }
}

/**
 * Map an LM Studio chat-endpoint HTTP error to actionable text. The 400s from
 * llama.cpp's "n_keep > n_ctx" / context-overflow case are the user-facing
 * ones we care most about — they happen when the loaded model's context
 * length is smaller than a chunk plus prompt.
 */
function friendlyChatError(status: number, detail: string): string {
  const inner = extractErrorMessage(detail)
  const lower = inner.toLowerCase()

  if (
    status === 400 &&
    (lower.includes('n_keep') || lower.includes('context'))
  ) {
    return `Loaded context too small for this batch.\nIn LM Studio, reload the model with a larger Context Length (Developer tab → model settings).\n\nLM Studio said: ${inner}`
  }
  if (status === 500 && lower.includes('image')) {
    return `The model couldn't process an attached image.\nToggle off "Include images", or load a vision-capable (vlm) model.\n\nLM Studio said: ${inner}`
  }
  if (status === 404 && lower.includes('model')) {
    return `Model not loaded.\nLoad it in LM Studio (Developer tab → load model), or pick a loaded one from Settings.\n\nLM Studio said: ${inner}`
  }
  return `LM Studio error (HTTP ${status}): ${inner || '(no detail)'}\nCheck the LM Studio Server log (Server tab).`
}

function extractErrorMessage(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } }
    if (parsed && typeof parsed.error === 'string') return parsed.error
    if (
      parsed &&
      typeof parsed.error === 'object' &&
      typeof parsed.error.message === 'string'
    ) {
      return parsed.error.message
    }
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500)
}

/**
 * Map our ChatMessage[] to OpenAI's wire format. For text-only messages this
 * is a 1:1 shape match. For messages with images, the content field becomes
 * an array of typed parts ({type: text|image_url}) per OpenAI's vision spec.
 *
 * MIME is hardcoded to image/jpeg in the data URL — most fetched images are
 * JPEG and OpenAI/LM Studio sniff actual bytes, so claimed MIME doesn't have
 * to be precise. If this becomes an issue, plumb mimeType through
 * ChatMessage.images (currently string[] of base64).
 */
function serializeMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (m.images && m.images.length > 0) {
      return {
        role: m.role,
        content: [
          { type: 'text' as const, text: m.content },
          ...m.images.map((b64) => ({
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${b64}` },
          })),
        ],
      }
    }
    return { role: m.role, content: m.content }
  })
}
