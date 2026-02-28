# Changelog

Alle nennenswerten Aenderungen werden in dieser Datei dokumentiert.

## 1.4.31 - 2026-03-01

Diese Version schliesst die komplette Bug-Audit-Runde (156 Punkte) ab und fokussiert auf Stabilitaet, Datenintegritaet, sauberes Abbruchverhalten und reproduzierbares Release-Verhalten.

### Audit-Abschluss

- Vollstaendige Abarbeitung der Audit-Liste `Bug-Audit-Komplett-156-Bugs.txt` ueber Main-Process, Renderer, Storage, Update, Integrity und Logger.
- Vereinheitlichte Fehlerbehandlung fuer Netzwerk-, Abort-, Retry- und Timeout-Pfade.
- Harte Regression-Absicherung ueber Typecheck, Unit-Tests und Release-Build.

### Download-Manager (Queue, Retry, Stop/Start, Post-Processing)

- Retry-Status ist jetzt item-gebunden statt call-lokal (kein Retry-Reset bei Requeue, keine Endlos-Retry-Schleifen mehr).
- Stop-zu-Start-Resume in derselben Session repariert (gestoppte Items werden wieder sauber gequeued).
- HTTP-416-Pfade gehaertet (Body-Konsum, korrektes Fehlerbild im letzten Attempt, Contribution-Reset bei Datei-Neustart).
- Target-Path-Reservierung gegen Race-Fenster verbessert (kein verfruehtes Release waehrend Retry-Delay).
- Scheduler-Verhalten bei Reconnect/Abort bereinigt, inklusive Status- und Speed-Resets in Abbruchpfaden.
- Post-Processing/Extraction-Abbruch und Paket-Lifecycle synchronisiert (inkl. Cleanup und Run-Finish-Konsistenz).
- `prepareForShutdown()` raeumt Persist- und State-Emitter-Timer jetzt vollstaendig auf.
- Read-only Queue-Checks entkoppelt von mutierenden Seiteneffekten.

### Extractor

- Cleanup-Modus `trash` ueberarbeitet (keine permanente Loeschung mehr im Trash-Pfad).
- Konfliktmodus-Weitergabe in ZIP- und External-Fallback-Pfaden konsistent gemacht.
- Fortschritts-Puls robust gegen callback-exceptions (kein unhandled crash durch `onProgress`).
- ZIP/Volume-Erkennung und Cleanup-Targets fuer Multi-Part-Archive erweitert.
- Schutz gegen gefaehrliche ZIP-Eintraege und Problemarchive weiter gehaertet.

### Debrid / RealDebrid

- Abort-signale werden in Filename-Resolution und Provider-Fallback konsequent respektiert.
- Provider-Fallback bricht bei Abort sofort ab statt weitere Provider zu probieren.
- Rapidgator-Filename-Resolution auf Content-Type, Retry-Klassen und Body-Handling gehaertet.
- AllDebrid/BestDebrid URL-Validierung verbessert (nur gueltige HTTP(S)-direct URLs).
- User-Agent-Versionsdrift beseitigt (nun zentral ueber `APP_VERSION`).
- RealDebrid-Retry-Backoff ist abort-freundlich (kein unnoetiges Warten nach Stop/Abort).

### Storage / Session / Settings

- Temp-Dateipfade fuer Session-Save gegen Race/Kollision gehaertet.
- Session-Normalisierung und PackageOrder-Deduplizierung stabilisiert.
- Settings-Normalisierung tightened (kein unkontrolliertes Property-Leaking).
- Import- und Update-Pfade robust gegen invalides Input-Shape.

### Main / App-Controller / IPC

- IPC-Validierung erweitert (Payload-Typen, String-Laengen, Import-Size-Limits).
- Auto-Resume Start-Reihenfolge korrigiert, damit der Renderer initiale States sicher erhaelt.
- Fenster-Lifecycle-Handler fuer neu erstellte Fenster vereinheitlicht (macOS activate-recreate eingeschlossen).
- Clipboard-Normalisierung unicode-sicher (kein Surrogate-Split bei Truncation).
- Container-Path-Filter so korrigiert, dass legitime Dateinamen mit `..` nicht falsch verworfen werden.

### Update-System

- Dateinamenhygiene fuer Setup-Assets gehaertet (`basename` + sanitize gegen Traversal/RCE-Pfade).
- Zielpfad-Kollisionen beseitigt (Timestamp + PID + UUID).
- `spawn`-Error-Handling hinzugefuegt (kein unhandled EventEmitter crash beim Installer-Start).
- Download-Pipeline auf Shutdown-abort vorbereitet; aktive Update-Downloads koennen sauber abgebrochen werden.
- Stream/Timeout/Retry-Handling bei Download und Release-Fetch konsolidiert.

### Integrity

- CRC32-Berechnung optimiert (Lookup-Table + Event-Loop-Yield), deutlich weniger UI-/Loop-Blockade bei grossen Dateien.
- Hash-Manifest-Lesen gecacht (reduzierte Disk-I/O bei Multi-File-Validierung).
- Manifest-Key-Matching fuer relative Pfade und Basenamen vereinheitlicht.

### Logger

- Rotation im async- und fallback-Pfad vervollstaendigt.
- Rotate-Checks pro Datei getrennt statt global geteilt.
- Async-Flush robust gegen Log-Loss bei Write-Fehlern (pending Lines werden erst nach erfolgreichem Write entfernt).

### Renderer (App.tsx)

- Theme-Toggle, Sortier-Optimismus und Picker-Busy-Lifecycle gegen Race Conditions gehaertet.
- Mounted-Guards fuer fruehe Unmount-Pfade ergaenzt.
- Drag-and-Drop nutzt aktive Tab-Referenz robust ueber async Grenzen.
- Confirm-Dialog-Text rendert Zeilenumbrueche korrekt.
- PackageCard-Memovergleich erweitert (inkl. Dateiname) fuer korrekte Re-Renders.
- Human-size Anzeige gegen negative/NaN Inputs gehaertet.

### QA / Build / Release

- TypeScript Typecheck erfolgreich.
- Voller Vitest Lauf erfolgreich (`262/262`).
- Windows Release-Build erfolgreich (NSIS + Portable).
