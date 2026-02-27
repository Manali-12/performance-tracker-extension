# Angular Performance Monitor (Chrome Extension)

Scaffolding-only Phase 1 implementation: Manifest V3 + TypeScript (strict) + Vite + `@crxjs/vite-plugin` + IndexedDB (`idb`).

## Prerequisites

- Node.js 18+ (recommended 20+)

## Install

```bash
npm install
```

## Development

Run Vite in watch mode:

```bash
npm run dev
```

Vite will output the built extension into the `dist/` directory.

## Load Unpacked Extension (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the generated `dist/` folder
5. Open your target web app in a tab (currently matches `<all_urls>` during scaffolding)
6. Open DevTools Console:
   - Content script logs: `[PerfMonitor][content] Monitoring started`
   - Background logs: `[PerfMonitor][background] ...`

## Production Build

```bash
npm run build
```

This generates a production `dist/` folder suitable for packaging and Chrome Web Store upload.

## Notes

- Metric collection is intentionally not implemented yet.
- The injected script runs in the page context (MAIN world) via `chrome.scripting.executeScript` triggered from the background service worker.
