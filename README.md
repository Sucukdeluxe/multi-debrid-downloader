# Multi Debrid Downloader

Desktop-Downloader fuer **Real-Debrid, Mega-Debrid, BestDebrid und AllDebrid** mit schneller Queue-Verwaltung, automatischem Entpacken und robuster Fehlerbehandlung.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Electron](https://img.shields.io/badge/Electron-31.x-47848F)
![React](https://img.shields.io/badge/React-18.x-149ECA)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)
![License](https://img.shields.io/badge/license-MIT-green)

## Warum dieses Tool?

- Ein Workflow wie bei klassischen Download-Managern: sammeln, starten, pausieren, fortsetzen, sauber abschliessen.
- Mehrere Debrid-Provider in einer App, inklusive automatischem Provider-Fallback.
- Fokus auf Stabilitaet bei grossen Queues: Session-Persistenz, Reconnect-Handling, Resume und Integritaetspruefung.

## Kernfunktionen

### Queue und Download-Engine

- Paketbasierte Queue mit Datei-Status, Fortschritt, ETA, Speed und Retry-Zaehlern.
- Start, Pause, Stop und Einzel-/Paket-Abbruch waehrend laufender Downloads.
- Duplicate-Strategien beim Hinzufuegen: behalten, ueberspringen oder ueberschreiben.
- Session-Wiederherstellung beim Neustart inkl. optionalem Auto-Resume.

### Debrid und Link-Handling

- Unterstuetzte Provider: `realdebrid`, `megadebrid`, `bestdebrid`, `alldebrid`.
- Konfigurierbare Reihenfolge: Primary + Secondary + Tertiary.
- Optionaler automatischer Fallback auf alternative Provider bei Fehlern.
- `.dlc`-Import per Datei-Dialog und Drag-and-Drop.

### Entpacken, Cleanup und Qualitaet

- Auto-Extract mit separatem Zielordner und Konflikt-Strategien.
- Hybrid-Extract, optionale Bereinigung von Link-Dateien und Sample-Dateien.
- Integritaetspruefung nach Download (`CRC32`, `MD5`, `SHA1`) mit Auto-Retry bei Fehlern.
- Cleanup-Policy fuer fertige Downloads: `never`, `immediate`, `on_start`, `package_done`.

### Komfort und Automatisierung

- Clipboard-Watcher zum automatischen Erkennen neuer Links.
- Minimize-to-Tray mit Tray-Menue.
- Geschwindigkeitslimit global oder pro Download.
- Bandwidth-Schedules fuer zeitgesteuerte Geschwindigkeitsprofile.
- Integrierte Update-Pruefung ueber GitHub Releases.

## Installation

### Option A: Fertige Releases (empfohlen)

1. Release von der GitHub-Release-Seite herunterladen.
2. Setup oder Portable-Version starten.
3. Debrid-Tokens in den Settings eintragen.

Releases: `https://github.com/Sucukdeluxe/real-debrid-downloader/releases`

### Option B: Aus dem Source bauen

Voraussetzungen:

- Node.js `20+` (empfohlen `22+`)
- npm
- Windows `10/11` (fuer Packaging und regulaeren Desktop-Betrieb)
- Optional: 7-Zip/UnRAR fuer bestimmte Archive

```bash
npm install
npm run dev
```

## NPM-Skripte

| Befehl | Beschreibung |
| --- | --- |
| `npm run dev` | Startet Main, Renderer und Electron im Dev-Modus |
| `npm run build` | Baut Main- und Renderer-Bundles |
| `npm run start` | Startet die App lokal im Production-Modus |
| `npm test` | Fuehrt Vitest-Unit-Tests aus |
| `npm run self-check` | Fuehrt integrierten End-to-End-Self-Check aus |
| `npm run release:win` | Erstellt Windows-Installer + Portable-Build |

## Typischer Workflow

1. Provider-Tokens in den Settings hinterlegen.
2. Links oder `.dlc` einfuegen/importieren.
3. Optional Paketnamen, Zielordner, Entpack- und Cleanup-Regeln setzen.
4. Queue starten und Fortschritt in der Downloads-Ansicht ueberwachen.
5. Nach Abschluss Integritaetsstatus und Zusammenfassung pruefen.

## Projektstruktur

- `src/main` - Electron Main Process, Queue/Download/Provider-Logik
- `src/preload` - sichere IPC-Bridge zwischen Main und Renderer
- `src/renderer` - React-Oberflaeche
- `src/shared` - gemeinsame Typen und IPC-Vertraege
- `tests` - Unit- und Self-Check-Tests

## Daten und Logs

Die App speichert Runtime-Daten im Electron-`userData`-Verzeichnis, u.a.:

- `rd_downloader_config.json`
- `rd_session_state.json`
- `rd_downloader.log`

## Troubleshooting

- Download startet nicht: Token/Provider in den Settings pruefen.
- Entpacken schlaegt fehl: Archive-Passwoerter und Entpack-Tool-Verfuegbarkeit pruefen.
- Sehr langsame Downloads: Speed-Limit und aktive Bandwidth-Schedules kontrollieren.
- Unerwartete Unterbrechungen: Reconnect-Option und Fallback-Provider aktivieren.

## Changelog

Die Release-Historie findest du in `CHANGELOG.md` und unter GitHub Releases.

## Lizenz

MIT - siehe `LICENSE`.
