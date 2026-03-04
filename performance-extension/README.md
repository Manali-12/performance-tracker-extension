# Web Performance Monitor (Chrome Extension)

`Web Performance Monitor` is a Manifest V3 Chrome extension that captures performance sessions for configured domains, stores them locally (IndexedDB), and visualizes trends and regressions in a built-in analytics dashboard.

Built with TypeScript (strict) + Vite + `@crxjs/vite-plugin`, and uses `idb` for local persistence.

## Features

- **Domain allowlist**
  Only injects into domains you explicitly allow (optional host permissions).
- **Optional URL path filtering**
  Restrict capture to specific routes using path patterns.
- **Local-first data**
  Sessions and historical results are stored locally in the browser (IndexedDB).
- **Analytics dashboard**
  View session tables, KPI summaries, and charts (Chart.js) including Web Vitals trends.
- **Tag-based comparison**
  Compare two tags (e.g. release versions) and see deltas / regression analysis.
- **Exports**
  Export reports (HTML / Excel) and download raw data.

## How it works (high level)

- **Background service worker**
  Watches tab updates and injects the content script only when the active tab matches an allowed domain (and optional path rules).
- **Content script (isolated world)**
  Bootstraps the session and requests injection of a page-context script.
- **Injected script (MAIN world)**
  Runs in the page context (needed for certain performance APIs) and posts session messages back to the content script.
- **Storage**
  Captured sessions are persisted in IndexedDB and surfaced in the dashboard UI.

## Permissions

The extension uses:

- `storage`, `unlimitedStorage`
  Persist settings and session data.
- `alarms`
  Periodic retention cleanup.
- `scripting`
  Inject content/injected scripts when a tab matches your allowed scopes.
- `tabs`, `activeTab`
  Detect navigation completion and target script injection.
- Optional host permissions (`https://*/*`)
  You grant access per-domain; the extension checks permission before injecting.

## Prerequisites

- Node.js 18+ (recommended 20+)

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

Vite outputs the built extension into `dist/`.

## Build

```bash
npm run build
```

## Load unpacked (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the generated `dist/` folder

## Usage

1. Load the extension.
2. Open the extension UI and add a **Domain** in the dashboard.
3. When you browse pages under an allowed domain (and allowed paths, if configured), the extension injects and captures sessions.
4. Open the **Analytics Dashboard** to view:
   - Session tables (raw data)
   - Trend charts (e.g. LCP / FCP / CLS)
   - Tag comparisons and regression analysis
   - Export tools

## Troubleshooting

- If you don’t see data, confirm:
  - The domain is added to the allowlist.
  - Chrome host permission is granted for that domain.
  - The URL path matches any configured `urlPatterns`.
- Useful logs:
  - Content script: `[PerfMonitor][content] ...`
  - Background: `[PerfMonitor][background] ...`
  - Injection: `[PerfMonitor][inject] ...`

## Scripts

- `npm run dev`
  Start Vite in watch mode.
- `npm run build`
  Production build into `dist/`.
- `npm run lint`
  Lint the codebase.
- `npm run test`
  Run unit tests (Vitest).

## Privacy

- Data is stored locally in your browser.
- Domain scoping + optional path filtering limits where injection occurs.

## License

Add your preferred license (MIT/Apache-2.0/etc.) before publishing.
