# Releasing

How to cut a ThreadWeaver release. Targets sideload (Load unpacked from zip), not the Chrome Web Store.

## Cutting a release

1. **Bump the version** in [package.json](package.json). `manifest.config.ts` reads `pkg.version` automatically.
2. **Update [CHANGELOG.md](CHANGELOG.md)**. Add a new section header for the version with the release date, grouped by Added / Changed / Fixed. Move the previous version's link reference to the bottom.
3. **Build**:
   ```sh
   npm run build
   ```
   Output lands in `dist/`. Verify there are no warnings beyond the known crxjs `rollupOptions`/`rolldownOptions` notice.
4. **Smoke test the unpacked build** before zipping:
   - `chrome://extensions` → Developer mode → Load unpacked → pick `dist/`
   - Open a known-good thread (f-16.net, xenforo.com/community, community.mybb.com, simplemachines.org/community) and run a summary end-to-end.
5. **Zip the dist folder** (PowerShell):
   ```powershell
   Compress-Archive -Path dist\* -DestinationPath threadweaver-v0.3.0.zip
   ```
   Or with Git Bash / WSL:
   ```sh
   cd dist && zip -r ../threadweaver-v0.3.0.zip . && cd ..
   ```
6. **Tag and push**:
   ```sh
   git tag v0.3.0
   git push --tags
   ```
7. **Create the GitHub release** for the tag and attach the zip. Paste the new CHANGELOG section as the release notes body.

## Versioning

Semantic versioning. Breaking changes to stored data (IndexedDB schema, settings shape) bump minor while we're pre-1.0; once 1.0 ships they bump major.

## What "1.0" looks like

Remote LLM providers (OpenAI, Anthropic, Gemini, Grok) implemented and shipped. Until then we stay on 0.x.
