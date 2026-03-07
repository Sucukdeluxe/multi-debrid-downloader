# Multi Debrid Downloader

Desktop downloader for Windows with package-based queue management, multi-provider fallback, automatic extraction, auto-rename, provider statistics, and built-in updates.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Electron](https://img.shields.io/badge/Electron-31.x-47848F)
![React](https://img.shields.io/badge/React-18.x-149ECA)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)
![License](https://img.shields.io/badge/license-MIT-green)

## Why this tool?

- JDownloader-style workflow with packages, progress, extraction, history, and clean post-processing.
- Multiple debrid accounts in one app, including provider order, automatic fallback, and per-hoster routing.
- Built for large queues with session persistence, retries, reconnect handling, resume support, and integrity checks.
- Includes an in-app updater for releases published on `git.24-music.de`.

## Supported providers

- AllDebrid API
- AllDebrid Web via browser login
- BestDebrid API
- BestDebrid Web via cookie import
- Debrid-Link with multi-key support
- DDownload login
- 1fichier API
- LinkSnappy login
- Mega-Debrid API
- Mega-Debrid Web
- Real-Debrid

## Core features

### Queue and package handling

- Package-based queue with item status, retries, ETA, speed, provider, and account label.
- Start, pause, stop, cancel, reset, rename, and delete for packages and items.
- Ctrl+Click multi-select and bulk actions.
- Queue import/export.
- Duplicate handling when adding links: keep, skip, or overwrite.
- Optional start scheduling for a specific time.
- Session recovery after restart with optional auto-resume.
- Optional auto-sorting by progress.

### Link collection

- Paste links directly into the collector.
- Clipboard watcher with automatic link detection.
- `.dlc` import via file picker and drag-and-drop.
- Drag-and-drop of plain links and supported container files.

### Provider routing and fallback

- Configurable provider order with primary, secondary, and tertiary fallback.
- Optional automatic provider fallback on unrestrict/download failures.
- Per-hoster routing override, so specific hosters can always use a specific provider.
- Providers can be disabled without deleting stored account data.
- Daily traffic limits per provider.
- Debrid-Link per-key daily limits and per-key daily usage tracking.

### Accounts and provider tools

- Central Accounts view with account type, status, info, access data, and actions.
- BestDebrid cookie import directly from a Netscape cookies file.
- AllDebrid browser-login flow and in-app Rapidgator host status display.
- Debrid-Link multi-key management with optional detailed line-by-line key display.
- Debrid-Link API-key statistics popup with per-key Rapidgator traffic quota, link quota, reset, activate/deactivate, and click-to-copy masked keys.
- Reset button for stored account column widths in the Accounts table.

### Download engine

- Parallel downloads with resumable transfers when supported.
- Reconnect handling with configurable wait time.
- Circuit-breaker style cooldown and retry handling for provider issues.
- Global speed limit or per-download speed limit mode.
- Bandwidth schedules with time windows and speed caps.
- Live bandwidth chart and session statistics.
- Persistent all-time download counter.

### Extraction and post-processing

- Automatic extraction after download.
- Extraction can continue even when the session is stopped or after app restart.
- Hybrid download + extract workflow.
- Extraction backend using native tools by default, with JVM sidecar support available.
- Supports common archive formats including RAR, ZIP, and 7z.
- Nested extraction for archives found inside extracted output.
- Conflict handling: overwrite, skip, rename, or ask.
- Disk-space validation before extraction.
- Package-scoped password reuse for multi-archive sets.
- Optional cleanup of downloaded archives after extraction.
- Optional cleanup of link artifacts and sample files after extraction.
- Optional flat MKV collection folder after package completion.

### Auto-rename and media cleanup

- Auto-rename for extracted scene-style files based on folder/source naming.
- Multi-episode token parsing.
- Handles compact episode tokens like `s02e01` directly attached to the title.
- Optional skip of already extracted packages on start.

### Integrity, history, and backup

- Optional integrity verification with `CRC32`, `MD5`, and `SHA1`.
- Download history with package details, duration, size, provider, and target folder.
- Backup export/import for restoring app state.
- Persistent config, session, and history files in the Electron `userData` directory.

### UI and desktop integration

- Downloads, history, statistics, and settings tabs.
- Progress bars for packages and single items.
- Hoster/provider display showing both source and effective debrid account.
- Minimize-to-tray support.
- Dark/light theme setting.
- Long path support on Windows.
- Default startup window size of `1920x1080`.

## Installation

### Prebuilt releases

1. Download the latest installer or portable build from the releases page.
2. Start the app.
3. Add your provider credentials in `Settings > Accounts`.

Releases: [git.24-music.de Releases](https://git.24-music.de/Administrator/real-debrid-downloader/releases)

### Build from source

Requirements:

- Node.js `20+`
- npm
- Windows `10/11`
- Java Runtime `8+` for the optional JVM extraction backend
- Optional native extraction tools: 7-Zip / WinRAR / UnRAR

```bash
npm install
npm run dev
```

## NPM scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts Vite, tsup watchers, and Electron in development mode |
| `npm run build` | Builds main and renderer bundles |
| `npm run start` | Starts the built app in production mode |
| `npm test` | Runs Vitest unit tests |
| `npm run self-check` | Runs integrated self-checks |
| `npm run release:win` | Builds Windows installer and portable EXE |
| `npm run release:gitea -- <version> [notes]` | Builds, tags, and uploads a release to `git.24-music.de` |
| `npm run release:forgejo -- <version> [notes]` | Alias for the same release workflow |

## Typical workflow

1. Add one or more provider accounts in `Settings > Accounts`.
2. Configure provider order, fallback, and optional hoster routing.
3. Paste links or import `.dlc` files.
4. Adjust package names, target folders, extraction, and cleanup settings if needed.
5. Start the queue and monitor downloads, extraction, and provider status.
6. Review history and statistics after completion.

## Project structure

- `src/main` - Electron main process, download engine, provider clients, updater, storage
- `src/preload` - secure IPC bridge
- `src/renderer` - React UI
- `src/shared` - shared types and IPC contracts
- `tests` - unit and integration-style tests
- `resources/extractor-jvm` - optional JVM extraction runtime
- `scripts` - release and build helpers

## Data and logs

Runtime files are stored in Electron's `userData` directory, including:

- `rd_downloader_config.json`
- `rd_session_state.json`
- `rd_history.json`
- `rd_downloader.log`

## Troubleshooting

- Provider does not work: verify credentials, enabled state, provider order, and daily limits.
- Debrid-Link quota looks wrong: open the API-key statistics popup and check the Rapidgator quota for the affected key.
- Extraction fails: verify passwords and installed extraction tools. The native backend is the default; JVM extraction is optional.
- Downloads stall: check active speed limits, bandwidth schedules, reconnect settings, and provider health.
- Accounts table looks misaligned on one machine: use `Spalten zuruecksetzen` in the Accounts view to clear the locally stored column widths.

## Changelog

Detailed release history is published on [git.24-music.de Releases](https://git.24-music.de/Administrator/real-debrid-downloader/releases).

## License

MIT - see `LICENSE`.
