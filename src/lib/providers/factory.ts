import type { Settings } from '../storage'
import { LMStudioProvider } from './lmstudio'
import { OllamaProvider } from './ollama'
import type { LLMProvider } from './types'

/**
 * Instantiate the configured provider. Call sites should use this rather than
 * `new OllamaProvider(...)` directly so adding a new provider only requires
 * updating one place.
 */
export function createProvider(settings: Settings): LLMProvider {
  switch (settings.providerId) {
    case 'lmstudio':
      return new LMStudioProvider(settings.lmstudio.baseUrl)
    case 'ollama':
    default:
      return new OllamaProvider(settings.ollama.baseUrl)
  }
}

/**
 * Resolve the (baseUrl, model) pair currently in use. Settings stores per-
 * provider config; this picks the one matching providerId.
 */
export function activeProviderConfig(settings: Settings): {
  baseUrl: string
  model: string
} {
  switch (settings.providerId) {
    case 'lmstudio':
      return settings.lmstudio
    case 'ollama':
    default:
      return settings.ollama
  }
}
