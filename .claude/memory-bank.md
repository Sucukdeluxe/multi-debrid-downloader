# Memory Bank - Multi Debrid Downloader

## Projekt-Überblick

**Name:** Multi Debrid Downloader (MDD)  
**Typ:** Electron Desktop App für Windows 10/11  
**Repository:** 
- Codeberg: https://codeberg.org/Sucukdeluxe/real-debrid-downloader.git
- GitHub: https://github.com/Sucukdeluxe/real-debrid-downloader.git

## Technologie-Stack

- **Runtime:** Electron 31.x
- **Frontend:** React 18.x + TypeScript 5.x
- **Build:** Vite (Renderer) + tsup (Main/Preload)
- **Tests:** Vitest (262+ Tests)
- **Installer:** NSIS via electron-builder

## Unterstützte Debrid-Provider

| Provider | Auth | Priorität |
|----------|------|-----------|
| Real-Debrid | API Token | Primär |
| Mega-Debrid | Login + Passwort | Fallback 1 |
| BestDebrid | API Token | Fallback 2 |
| AllDebrid | API Key | Fallback 3 |

## Kernfeatures

- **Queue-Management:** Package-basierte Organisation mit Drag & Drop
- **Auto-Extract:** RAR, ZIP, 7z mit Passwortliste
- **Auto-Rename:** Scene-Release Muster (4sf/4sj) → saubere Namen
- **Integritätsprüfung:** CRC32, MD5, SHA1 via SFV-Dateien
- **Provider-Fallback:** Automatischer Wechsel bei Fehlern/Fair-Use
- **Session-Persistenz:** Queue überlebt App-Neustart
- **Clipboard-Watcher:** Automatische Link-Erkennung
- **System-Tray:** Minimize to Tray
- **Speed-Limit:** Global oder per Download + Bandwidth-Schedules
- **MKV-Sammelordner:** Automatisches Verschieben nach Paketabschluss
- **Update-System:** Automatische Updates via Codeberg Releases

## Projektstruktur

```
src/
├── main/           # Electron Main Process
│   ├── main.ts           # Entry Point, IPC Handler, Window Management
│   ├── app-controller.ts # Koordiniert DownloadManager + Settings
│   ├── download-manager.ts # Core: Queue, Downloads, Retry-Logic
│   ├── debrid.ts         # Debrid-Service Abstraktion
│   ├── realdebrid.ts     # Real-Debrid API Client
│   ├── extractor.ts      # Archiv-Entpackung
│   ├── integrity.ts      # CRC32/Hash-Validierung
│   ├── storage.ts        # Session/Settings Persistenz
│   ├── update.ts         # Update-Check & Installation
│   └── ...
├── renderer/       # React UI
│   ├── App.tsx           # Hauptkomponente mit allen Tabs
│   └── styles.css        # Styling
├── preload/        # Preload Script (IPC Bridge)
│   └── preload.ts
└── shared/         # Geteilte Types
    ├── types.ts          # Alle TypeScript Interfaces
    ├── ipc.ts            # IPC Channel Konstanten
    └── preload-api.ts    # window.rd API Definition
```

## Wichtige Types (src/shared/types.ts)

- `DownloadItem`: Einzelner Download mit Status, Progress, Speed
- `PackageEntry`: Gruppe von Downloads mit OutputDir, ExtractDir
- `SessionState`: Gesamter Queue-Zustand (persistiert)
- `AppSettings`: Alle Einstellungen
- `UiSnapshot`: Kompletter UI-State für Renderer

## IPC Channels (src/shared/ipc.ts)

Hauptchannels für Renderer ↔ Main Kommunikation:
- `GET_SNAPSHOT`, `STATE_UPDATE`: State-Sync
- `ADD_LINKS`, `ADD_CONTAINERS`: Queue befüllen
- `START`, `STOP`, `TOGGLE_PAUSE`: Download-Kontrolle
- `UPDATE_SETTINGS`: Einstellungen ändern

## Aktuelle Version

**Version:** 1.5.27  
**Letztes Release:** 1.4.68 (2026-03-01)

### Letzte Änderungen (CHANGELOG)
- Session-Backup für Queue-Zustand
- Start-Konflikt-Behandlung verbessert
- Mega-Web Unrestrict abort-fähig
- DLC-Import gehärtet
- Auto-Renamer erweitert

## Offene Pläne

1. **Native Menüleiste** (`.claude/plans/agile-watching-lampson.md`)
   - JDownloader 2 Style Menü
   - Electron Menu API nutzen
   - Bestehende React Menu-Bar ersetzen

## Coding-Conventions

- TypeScript strict mode
- Async/Await über Promises
- Deutsche UI-Texte
- Ausführliche Error-Logs via `logger`
- Retry-Logic mit exponential backoff
- AbortController für abbrechbare Operationen

## Build & Release

```bash
npm run build        # TypeScript + Vite Build
npm run dist         # electron-builder (NSIS + Portable)
npm test             # Vitest Tests
npm run self-check   # Vollständiger Check (Typecheck + Tests)
```

## Wichtige Dateien

- `CHANGELOG.md` - Detaillierte Versionshistorie
- `.claude/plans/` - Feature-Pläne
- `tests/` - Umfangreiche Test-Suite
- `installer/RealDebridDownloader.iss` - Inno Setup Script