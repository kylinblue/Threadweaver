import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest({
  manifest_version: 3,
  name: 'ThreadWeaver',
  version: pkg.version,
  description: 'Read long forum threads with AI assistance, in a side panel.',
  minimum_chrome_version: '114',
  permissions: ['sidePanel', 'storage', 'activeTab', 'scripting'],
  host_permissions: [
    '<all_urls>',
    'http://localhost:11434/*',
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://generativelanguage.googleapis.com/*',
    'https://api.x.ai/*',
  ],
  side_panel: { default_path: 'src/sidepanel/index.html' },
  action: { default_title: 'Open ThreadWeaver' },
  background: { service_worker: 'src/background/sw.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/extractor.ts'],
      run_at: 'document_idle',
    },
  ],
})
