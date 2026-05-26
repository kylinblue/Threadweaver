export type ProviderId =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'grok'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Base64-encoded image data (no data: prefix) to send with this message
   *  on vision-capable providers. Providers without vision support must
   *  ignore this field. */
  images?: string[]
}

export interface GenerateOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  abortSignal?: AbortSignal
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
}

export interface GenerateResult {
  text: string
  usage: UsageInfo
}

export interface LLMProvider {
  readonly id: ProviderId
  readonly label: string
  readonly defaultModel: string

  listModels(): Promise<string[]>

  generate(messages: ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>

  generateStream(
    messages: ChatMessage[],
    opts?: GenerateOptions,
  ): AsyncIterable<string>

  countTokens(text: string, model?: string): Promise<number>

  /**
   * Optional. True when the (model, provider) pair accepts images on
   * ChatMessage.images. Callers should treat absence as "no" and skip image
   * payloads entirely.
   */
  isVisionCapable?(model?: string): Promise<boolean>

  /**
   * Optional. The effective context window in tokens the provider will use
   * for this model on the next request. Callers use this to size chunks so
   * prompts don't get silently truncated.
   */
  getMaxContextTokens?(model?: string): Promise<number>
}

export class ProviderError extends Error {
  readonly providerId: ProviderId
  readonly cause?: unknown

  constructor(message: string, providerId: ProviderId, cause?: unknown) {
    super(message)
    this.name = 'ProviderError'
    this.providerId = providerId
    this.cause = cause
  }
}
