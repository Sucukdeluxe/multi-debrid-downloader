# Changelog

Alle nennenswerten Aenderungen werden in dieser Datei dokumentiert.

## 1.4.66 - 2026-03-01

Hotfix fuer haengende "Link wird umgewandelt"-Faelle (insbesondere Mega-Web-Pfad), bei denen nur ein App-Neustart geholfen hat.

### Fixes

- Mega-Web-Unrestrict ist jetzt komplett abort-/timeout-faehig:
  - Abort-Signale werden bis in den Mega-Web-Fallback durchgereicht.
  - Laufende Polling-/Fetch-Schritte respektieren Stop/Timeout sofort.
  - Wartende Jobs in der exklusiven Mega-Web-Queue koennen bei Abort sauber abbrechen.
- Download-Manager kann haengende Unrestrict-Phasen dadurch wieder automatisch per Timeout + Retry aufloesen, statt dauerhaft in "Link wird umgewandelt" zu bleiben.

### Tests

- Neue Tests sichern den Fix ab:
  - Abort-Weitergabe bei Mega-Web-Unrestrict in `tests/debrid.test.ts`.
  - Abort waehrend Mega-Web-Polling in `tests/mega-web-fallback.test.ts`.

## 1.4.33 - 2026-03-02

Hotfix-Release fuer zwei reale Produktionsprobleme: falsche Gesamt-Statistik bei leerer Queue und stilles DLC-Import-Failure bei Drag-and-Drop.

### Fixes

- **Stats-Anzeige korrigiert ("Gesamt" bei leerer Queue):**
  - Wenn keine Pakete/Items mehr vorhanden sind, werden persistierte Run-Bytes und Run-Timestamps jetzt sauber auf 0 zurueckgesetzt.
  - Dadurch verschwindet die Ghost-Anzeige wie z. B. `Gesamt: 19.99 GB` bei `Pakete: 0 / Dateien: 0`.
  - Reset greift in den relevanten Pfaden (`getStats`, `clearAll`, Paket-Entfernung, Startup-Normalisierung).

- **DLC Drag-and-Drop Import gehaertet:**
  - Lokale DLC-Fehler wie `Ungültiges DLC-Padding` blockieren den Fallback zu dcrypt nicht mehr.
  - Oversize/invalid-size DLCs werden weiterhin defensiv behandelt, aber valide Dateien im gleichen Batch werden nicht mehr still geschluckt.
  - Wenn alle DLC-Imports fehlschlagen, wird jetzt ein klarer Fehler mit Ursache geworfen statt still `0 Paket(e), 0 Link(s)` zu melden.

- **UI-Rueckmeldung verbessert:**
  - Bei DLC-Import mit `0` Treffern zeigt die UI jetzt eine klare Meldung (`Keine gültigen Links in den DLC-Dateien gefunden`) statt eines irrefuehrenden Erfolgs-Toast.

### Tests

- Neue/erweiterte Tests fuer:
  - Reset von `totalDownloadedBytes`/Stats bei leerer Queue.
  - DLC-Fallback-Pfad bei lokalen Decrypt-Exceptions.
  - Fehlerausgabe bei vollstaendig fehlgeschlagenem DLC-Import.
- Validierung:
  - `npx tsc --noEmit` erfolgreich
  - `npm test` erfolgreich (`283/283`)
  - `npm run self-check` erfolgreich

## 1.4.32 - 2026-03-01

Diese Version erweitert den Auto-Renamer stark fuer reale Scene-/TV-Release-Strukturen (nested und flat) und fuehrt eine intensive Renamer-Regression mit zusaetzlichen Edge-Case- und Stress-Checks ein.

### Renamer (Download-Manager)

- Erweiterte Mustererkennung fuer nested und flat Staffel-Ordner mit Group-Suffix (z. B. `-TMSF`, `-TVS`, `-TvR`, `-ZZGtv`, `-SunDry`).
- Episode-Token kann jetzt auch aus kompakten Codes im Source-Namen abgeleitet werden (z. B. `301` -> `S03E01`, `211` -> `S02E11`, `101` -> `S01E01`), sofern Staffel-Hinweise vorhanden sind.
- `Teil1/Teil2` bzw. `Part1/Part2` wird auf `SxxExx` gemappt, inklusive Staffel-Ableitung aus der Ordnerstruktur.
- Repack-Handling ueber Dateiname und Ordnerstruktur vereinheitlicht (`rp`/`repack` -> `REPACK`-Token konsistent im Zielnamen).
- Flat-Season-Ordner (Dateien direkt im Staffelordner) bekommen jetzt sauberes Episode-Inlining statt unspezifischer Season-Dateinamen.
- Pfadlaengen-Schutz auf Windows gehaertet: erst normaler Zielname, dann deterministischer Paket-Fallback (z. B. `Show.S08E20`), danach sicherer Skip mit Warnlog statt fehlerhaftem Rename.

### Abgedeckte reale Muster (Beispiele)

- Arrow / Gotham / Britannia / Legion / Lethal.Weapon / Agent.X / Last.Impact
- Nested Unterordner mit Episodentiteln und flache Staffelordner mit vielen Episoden-Dateien
- Uneinheitliche Source-Namen wie `tvs-...-301`, `...-211`, `...teil1...`, `...rp...`

### Intensive Bugtests

- Unit-Tests fuer Renamer deutlich ausgebaut (`tests/auto-rename.test.ts`) mit zusaetzlichen realen Pattern- und Compact-Code-Faellen.
- Zusätzliche intensive Szenario- und Stress-Checks mit temporaeren Testdateien ausgefuehrt (nested/flat, Repack, Teil/Part, Compact-Code, Pfadlaenge, Kollisionsschutz).
- TypeScript Typecheck erfolgreich.
- Voller Vitest Lauf erfolgreich (`279/279`).
- End-to-End Self-Check erfolgreich.

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
