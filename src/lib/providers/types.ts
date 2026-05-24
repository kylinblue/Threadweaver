export type ProviderId = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'grok'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
