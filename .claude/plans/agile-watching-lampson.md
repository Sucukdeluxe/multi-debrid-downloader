# Native Menüleiste (JDownloader 2 Style)

## Context
Die App hat aktuell keine native Menüleiste (nur ein Tray-Kontextmenü). Der User möchte eine Menüleiste oben links wie bei JDownloader 2 mit Datei-Menü, Shortcuts und Sicherungs-Funktion.

## Features

### "Datei"-Menü (oben links)
| Menüpunkt | Shortcut | Aktion |
|-----------|----------|--------|
| Text mit Links analysieren | Ctrl+L | Wechselt zum Linksammler-Tab |
| Linkcontainer laden | Ctrl+O | Öffnet DLC-Dateiauswahl (existiert bereits) |
| --- Separator --- | | |
| Sicherung → Backup erstellen | | Exportiert Queue als JSON (existiert: `exportQueue`) |
| Sicherung → Backup laden | | Importiert Queue-JSON (existiert: `importQueue`) |
| --- Separator --- | | |
| Neustart | Ctrl+Shift+R | `app.relaunch()` + `app.quit()` |
| Beenden | Ctrl+Q | `app.quit()` |

## Implementation

### Step 1: Neue IPC-Channels
**Datei:** `src/shared/ipc.ts`
- `NAVIGATE_TAB: "app:navigate-tab"` — Renderer wechselt Tab
- `RESTART: "app:restart"` — App neustarten
- `SAVE_BACKUP: "dialog:save-backup"` — Save-Dialog + Export
- `LOAD_BACKUP: "dialog:load-backup"` — Open-Dialog + Import

### Step 2: Preload-API erweitern
**Datei:** `src/shared/preload-api.ts` + `src/preload/preload.ts`
- `onNavigateTab(callback)` — Event-Listener für Tab-Wechsel
- `saveBackup()` — Backup über nativen Save-Dialog speichern
- `loadBackup()` — Backup über nativen Open-Dialog laden

### Step 3: Menüleiste erstellen
**Datei:** `src/main/main.ts`

Neue Funktion `createApplicationMenu()` nach `createTray()`:
- Nutzt `Menu.buildFromTemplate()` + `Menu.setApplicationMenu()`
- "Datei"-Menü mit allen Punkten aus der Tabelle
- Accelerators für Shortcuts (Electron handelt die automatisch)
- Menü-Clicks senden IPC-Events an den Renderer oder rufen direkt Main-Process-Funktionen auf

**Backup erstellen:** `dialog.showSaveDialog()` → `controller.exportQueue()` → `fs.writeFile()`
**Backup laden:** `dialog.showOpenDialog()` → `fs.readFile()` → `controller.importQueue()`
**Neustart:** `app.relaunch()` → `app.quit()`
**Beenden:** `app.quit()`
**Linksammler/DLC:** IPC-Event an Renderer senden

### Step 4: Renderer reagiert auf Menü-Events
**Datei:** `src/renderer/App.tsx`
- `onNavigateTab` Listener registrieren im `useEffect`
- Bei `"collector"` → `setTab("collector")`
- DLC-Import: `pickContainers` + `addContainers` (bestehendes Pattern)

## Dateien
- `src/shared/ipc.ts` — Neue Channels
- `src/shared/preload-api.ts` — Neue API-Methoden
- `src/preload/preload.ts` — IPC-Bridge
- `src/main/main.ts` — Menüleiste + IPC-Handler + Backup-Logik
- `src/renderer/App.tsx` — Tab-Navigation Listener

## Verification
1. `npm run build`
2. `npx vitest run` (schnelle Tests)
3. Manuell: App starten, Datei-Menü prüfen, Shortcuts testen
