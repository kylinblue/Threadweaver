import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from './providers/ollama'
import type { ProviderId } from './providers/types'

export interface OllamaSettings {
  baseUrl: string
  model: string
}

export interface Settings {
  providerId: ProviderId
  ollama: OllamaSettings
}

const STORAGE_KEY = 'tw.settings'

const DEFAULT_SETTINGS: Settings = {
  providerId: 'ollama',
  ollama: {
    baseUrl: OLLAMA_DEFAULT_BASE_URL,
    model: OLLAMA_DEFAULT_MODEL,
  },
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const raw = stored[STORAGE_KEY] as Partial<Settings> | undefined
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    ollama: { ...DEFAULT_SETTINGS.ollama, ...raw?.ollama },
  }
}

export async function setSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
}

export function subscribeSettings(cb: (s: Settings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !(STORAGE_KEY in changes)) return
    getSettings().then(cb)
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
