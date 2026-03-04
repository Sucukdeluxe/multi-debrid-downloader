# Multi Debrid Downloader

Desktop downloader with fast queue management, automatic extraction, and robust error handling.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Electron](https://img.shields.io/badge/Electron-31.x-47848F)
![React](https://img.shields.io/badge/React-18.x-149ECA)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)
![License](https://img.shields.io/badge/license-MIT-green)

## Why this tool?

- Familiar download-manager workflow: collect links, start, pause, resume, and finish cleanly.
- Multiple debrid providers in one app, including automatic fallback.
- Built for stability with large queues: session persistence, reconnect handling, resume support, and integrity verification.

## Core features

### Queue and download engine

- Package-based queue with file status, progress, ETA, speed, and retry counters.
- Start, pause, stop, and cancel for both single items and full packages.
- Multi-select via Ctrl+Click for batch operations on packages and items.
- Duplicate handling when adding links: keep, skip, or overwrite.
- Session recovery after restart, including optional auto-resume.
- Circuit breaker with escalating backoff cooldowns to handle provider outages gracefully.

### Debrid and link handling

- Supported providers: `realdebrid`, `megadebrid`, `bestdebrid`, `alldebrid`.
- Configurable provider order: primary + secondary + tertiary.
- Optional automatic fallback to alternative providers on failures.
- `.dlc` import via file picker and drag-and-drop.

### Extraction, cleanup, and quality

- JVM-based extraction backend using SevenZipJBinding + Zip4j (supports RAR, 7z, ZIP, and more).
- Automatic fallback to legacy UnRAR/7z CLI tools when JVM is unavailable.
- Auto-extract with separate target directory and conflict strategies.
- Hybrid extraction: simultaneous downloading and extracting with smart I/O priority throttling.
- Nested extraction: archives within archives are automatically extracted (one level deep).
- Pre-extraction disk space validation to prevent incomplete extracts.
- Right-click "Extract now" on any package with at least one completed item.
- Post-download integrity checks (`CRC32`, `MD5`, `SHA1`) with auto-retry on failures.
- Completed-item cleanup policy: `never`, `immediate`, `on_start`, `package_done`.
- Optional removal of link artifacts and sample files after extraction.

### Auto-rename

- Automatic renaming of extracted files based on series/episode patterns.
- Multi-episode token parsing for batch renames.

### UI and progress

- Visual progress bars with percentage overlay for packages and individual items.
- Real-time bandwidth chart showing current download speeds.
- Persistent download counters: all-time totals and per-session statistics.
- Download history for completed packages.
- Vertical sidebar with organized settings tabs.
- Hoster display showing both the original source and the debrid provider used.

### Convenience and automation

- Clipboard watcher for automatic link detection.
- Minimize-to-tray with tray menu controls.
- Speed limits globally or per download.
- Bandwidth schedules for time-based speed profiles.
- Built-in auto-updater via `git.24-music.de` Releases.
- Long path support (>260 characters) on Windows.

## Installation

### Option A: prebuilt releases (recommended)

1. Download a release from the `git.24-music.de` Releases page.
2. Run the installer or portable build.
3. Add your debrid tokens in Settings.

Releases: `https://git.24-music.de/Administrator/real-debrid-downloader/releases`

### Option B: build from source

Requirements:

- Node.js `20+` (recommended `22+`)
- npm
- Windows `10/11` (for packaging and regular desktop use)
- Java Runtime `8+` (for SevenZipJBinding sidecar backend)
- Optional fallback: 7-Zip/UnRAR if you force legacy extraction mode

```bash
npm install
npm run dev
```

## NPM scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts main process, renderer, and Electron in dev mode |
| `npm run build` | Builds main and renderer bundles |
| `npm run start` | Starts the app locally in production mode |
| `npm test` | Runs Vitest unit tests |
| `npm run self-check` | Runs integrated end-to-end self-checks |
| `npm run release:win` | Creates Windows installer and portable build |
| `npm run release:gitea -- <version> [notes]` | One-command version bump + build + tag + release upload to `git.24-music.de` |
| `npm run release:codeberg -- <version> [notes]` | Legacy path for old Codeberg workflow |

### One-command git.24-music release

```bash
npm run release:gitea -- 1.6.31 "- Maintenance update"
```

This command will:

1. Bump `package.json` version.
2. Build setup/portable artifacts (`npm run release:win`).
3. Commit and push `main` to your `git.24-music.de` remote.
4. Create and push tag `v<version>`.
5. Create/update the Gitea release and upload required assets.

Required once before release:

```bash
git remote add gitea https://git.24-music.de/<user>/<repo>.git
```

PowerShell token setup:

```powershell
$env:GITEA_TOKEN="<dein-token>"
```

## Typical workflow

1. Add provider tokens in Settings.
2. Paste/import links or `.dlc` containers.
3. Optionally set package names, target folders, extraction, and cleanup rules.
4. Start the queue and monitor progress in the Downloads tab.
5. Review integrity results and summary after completion.

## Project structure

- `src/main` - Electron main process, queue/download/provider logic
- `src/preload` - secure IPC bridge between main and renderer
- `src/renderer` - React UI
- `src/shared` - shared types and IPC contracts
- `tests` - unit tests and self-check tests
- `resources/extractor-jvm` - SevenZipJBinding + Zip4j sidecar JAR and native libraries

## Data and logs

The app stores runtime files in Electron's `userData` directory, including:

- `rd_downloader_config.json`
- `rd_session_state.json`
- `rd_downloader.log`

## Troubleshooting

- Download does not start: verify token and selected provider in Settings.
- Extraction fails: check archive passwords, JVM runtime (`resources/extractor-jvm`), or force legacy mode with `RD_EXTRACT_BACKEND=legacy`.
- Very slow downloads: check active speed limit and bandwidth schedules.
- Unexpected interruptions: enable reconnect and fallback providers.
- Stalled downloads: the app auto-detects stalls within 10 seconds and retries automatically.

## Changelog

Release history is available on [git.24-music.de Releases](https://git.24-music.de/Administrator/real-debrid-downloader/releases).

## License

MIT - see `LICENSE`.
