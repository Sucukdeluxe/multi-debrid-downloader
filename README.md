# Multi Debrid Downloader

Desktop downloader for **Real-Debrid, Mega-Debrid, BestDebrid, and AllDebrid** with fast queue management, automatic extraction, and robust error handling.

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
- Duplicate handling when adding links: keep, skip, or overwrite.
- Session recovery after restart, including optional auto-resume.

### Debrid and link handling

- Supported providers: `realdebrid`, `megadebrid`, `bestdebrid`, `alldebrid`.
- Configurable provider order: primary + secondary + tertiary.
- Optional automatic fallback to alternative providers on failures.
- `.dlc` import via file picker and drag-and-drop.

### Extraction, cleanup, and quality

- Auto-extract with separate target directory and conflict strategies.
- Hybrid extraction, optional removal of link artifacts and sample files.
- Post-download integrity checks (`CRC32`, `MD5`, `SHA1`) with auto-retry on failures.
- Completed-item cleanup policy: `never`, `immediate`, `on_start`, `package_done`.

### Convenience and automation

- Clipboard watcher for automatic link detection.
- Minimize-to-tray with tray menu controls.
- Speed limits globally or per download.
- Bandwidth schedules for time-based speed profiles.
- Built-in update checks via Codeberg Releases.

## Installation

### Option A: prebuilt releases (recommended)

1. Download a release from the Codeberg Releases page.
2. Run the installer or portable build.
3. Add your debrid tokens in Settings.

Releases: `https://codeberg.org/Sucukdeluxe/real-debrid-downloader/releases`

### Option B: build from source

Requirements:

- Node.js `20+` (recommended `22+`)
- npm
- Windows `10/11` (for packaging and regular desktop use)
- Optional: 7-Zip/UnRAR for specific archive formats

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
| `npm run release:codeberg -- <version> [notes]` | One-command version bump + build + tag + Codeberg release upload |

### One-command Codeberg release

```bash
npm run release:codeberg -- 1.4.42 "- Maintenance update"
```

This command will:

1. Bump `package.json` version.
2. Build setup/portable artifacts (`npm run release:win`).
3. Commit and push `main` to your Codeberg remote.
4. Create and push tag `v<version>`.
5. Create/update the Codeberg release and upload required assets.

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

## Data and logs

The app stores runtime files in Electron's `userData` directory, including:

- `rd_downloader_config.json`
- `rd_session_state.json`
- `rd_downloader.log`

## Troubleshooting

- Download does not start: verify token and selected provider in Settings.
- Extraction fails: check archive passwords and extraction tool availability.
- Very slow downloads: check active speed limit and bandwidth schedules.
- Unexpected interruptions: enable reconnect and fallback providers.

## Changelog

Release history is available in `CHANGELOG.md` and on Codeberg Releases.

## License

MIT - see `LICENSE`.
