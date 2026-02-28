# Real-Debrid Download Manager (Node/Electron)

Desktop-App auf **Node.js + Electron + React + TypeScript** mit JDownloader-Style Workflow, optimiert fuer Real-Debrid.

## Highlights

- Modernes, dunkles UI mit Header-Steuerung (Start, Pause, Stop, Speed, ETA)
- Tabs: **Linksammler**, **Downloads**, **Settings**
- Paketbasierte Queue mit Datei-Status, Progress, Speed, Retries
- Paket-Abbruch waehrend laufender Downloads inklusive sicherem Archiv-Cleanup
- `.dlc` Import (Dateidialog und Drag-and-Drop)
- Session-Persistenz (robustes JSON-State-Management)
- Auto-Resume beim Start (optional)
- Reconnect-Basislogik (429/503, Wartefenster, resumable priorisiert)
- Integritaetscheck (SFV/CRC32/MD5/SHA1) nach Download
- Auto-Retry bei Integritaetsfehlern
- Cleanup-Trigger fuer fertige Tasks:
  - Nie
  - Sofort
  - Beim App-Start
  - Sobald Paket fertig ist

## Voraussetzungen

- Node.js 20+ (empfohlen 22+)
- Windows 10/11 (fuer Release-Build)
- Optional: 7-Zip/UnRAR fuer RAR/7Z Entpacken

## Installation

```bash
npm install
```

## Entwicklung

```bash
npm run dev
```

## Build

```bash
npm run build
```

Danach liegen die Artefakte in:

- `build/main`
- `build/renderer`

## Start (Production lokal)

```bash
npm run start
```

## Tests

```bash
npm test
npm run self-check
```

- `npm test`: Unit-Tests fuer Parser/Cleanup/Integrity
- `npm run self-check`: End-to-End-Checks mit lokalem Mock-Server (Queue, Pause/Resume, Reconnect, Paket-Cancel)

## Changelog

- Detaillierte Release-Historie: `CHANGELOG.md`

## Projektstruktur

- `src/main`: Electron Main Process + Download/Queue Logik
- `src/preload`: sichere IPC Bridge
- `src/renderer`: React UI
- `src/shared`: gemeinsame Typen und IPC-Channel
- `tests`: Unit- und Self-Check Tests

## Hinweise

- Runtime-Dateien liegen im Electron `userData` Verzeichnis:
  - `rd_downloader_config.json`
  - `rd_session_state.json`
  - `rd_downloader.log`

- Das Repository enthält jetzt nur noch die aktive Node/Electron-Codebasis.
