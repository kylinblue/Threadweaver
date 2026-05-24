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

interface OllamaChatResponse {
  message?: { content?: string }
  prompt_eval_count?: number
  eval_count?: number
  done?: boolean
}

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama' as const
  readonly label = 'Ollama (local)'
  readonly defaultModel = OLLAMA_DEFAULT_MODEL

  private baseUrl: string

  constructor(baseUrl: string = OLLAMA_DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
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
    const body = {
      model: opts.model ?? this.defaultModel,
      messages,
      stream: false,
      options: {
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
      text: data.message?.content ?? '',
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
    const body = {
      model: opts.model ?? this.defaultModel,
      messages,
      stream: true,
      options: {
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
        if (piece) yield piece
        if (chunk.done) return
      }
    }
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4)
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
