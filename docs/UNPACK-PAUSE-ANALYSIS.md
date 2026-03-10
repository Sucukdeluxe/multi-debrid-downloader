# Intensive Analyse: Pausen zwischen Pack-Entpackungen (10–15 Sekunden)

**Nur Analyse – keine Code-Änderungen.**

---

## 1. Problem

Nach dem Entpacken eines Packs (z.B. 3 Parts einer Serie) passiert ca. 10–15 Sekunden lang scheinbar nichts, bevor das nächste Pack mit dem Entpacken beginnt.

---

## 2. Steuerungslogik: Ein Slot für alle Packs

- **Nur ein Pack** darf gleichzeitig Post-Processing (inkl. Entpacken) machen.
- Steuerung: `acquirePostProcessSlot(packageId)` / `releasePostProcessSlot()` in `download-manager.ts`.
- Weitere Packs warten in `packagePostProcessWaiters` und kommen erst dran, wenn der aktive Task im **finally**-Block `releasePostProcessSlot()` aufruft.

```3761:3804:src/main/download-manager.ts
  private async acquirePostProcessSlot(packageId: string): Promise<void> {
    const maxConcurrent = 1;
    // ...
  }
  private releasePostProcessSlot(): void {
    // ...
  }
```

- Der Slot wird **erst** freigegeben, wenn die gesamte `runPackagePostProcessing`-Task-Funktion durch ist – genauer: wenn ihr **finally**-Block läuft (dort `releasePostProcessSlot()`). Alles, was vorher im gleichen Task **synchron** (await) läuft, blockiert den Slot und damit das nächste Pack.

---

## 3. Zwei relevante Code-Pfade

### 3.1 Pfad A: Hybrid-Extract (Pack noch nicht fertig)

- Bedingung: `!allDone && settings.hybridExtract && autoExtract && failed === 0 && success > 0`.
- Es werden nur die **bereits fertigen** Archive des Packs entpackt (`onlyArchives: readyArchives`), mit `skipPostCleanup: true` (kein Post-Cleanup im Extractor).
- Ablauf:
  1. `handlePackagePostProcessing` → `runHybridExtraction`.
  2. `await extractPackageArchives(..., onlyArchives, skipPostCleanup: true)`.
  3. **Direkt danach (im gleichen Callstack, vor Rückkehr):**  
     `await this.autoRenameExtractedVideoFiles(pkg.extractDir, pkg)` (Zeile 6490).
  4. Dann return aus `handlePackagePostProcessing` → **finally** → `releasePostProcessSlot()`.

**Folge:** Im Hybrid-Pfad blockiert **Auto-Rename** den Slot. Solange Rename läuft (rekursives Scannen + Umbenennen), kann das nächste Pack nicht starten. Das kann gut 10–15 Sekunden ausmachen.

---

### 3.2 Pfad B: Finales Post-Processing (Pack komplett, alle Items fertig)

- Bedingung: `allDone` (alle Items completed/failed/cancelled).
- Es wird das **gesamte** Pack entpackt (`extractPackageArchives` ohne `onlyArchives`), **ohne** `skipPostCleanup`.
- Ablauf:
  1. `await extractPackageArchives(...)` – **inklusive allem, was der Extractor danach noch macht** (siehe Abschnitt 4).
  2. Status-Updates, `recordPackageHistory(...)` (synchron, schnell).
  3. `void this.runDeferredPostExtraction(...)` – wird **nicht** awaitet; Rename, MKV-Sammlung, Cleanup laufen im Hintergrund.
  4. `handlePackagePostProcessing` kehrt zurück → **finally** → `releasePostProcessSlot()`.

**Folge:** Im Final-Pfad blockieren **nicht** mehr Rename/MKV/Cleanup im Download-Manager den Slot – die sind in `runDeferredPostExtraction` ausgelagert. Was den Slot aber **noch** blockiert, ist alles, was **innerhalb** von `extractPackageArchives` **nach** dem eigentlichen Entpacken passiert (Post-Cleanup und ggf. Nested-Extraction im Extractor).

---

## 4. Was passiert INNERHALB von `extractPackageArchives` (Extractor) – und blockiert

Nach dem Durchlauf über alle Kandidaten-Archive folgt im Extractor (`extractor.ts`) noch:

### 4.1 Nested-Extraction (Zeilen 2208–2284)

- Wenn `extracted > 0 && !skipPostCleanup && !onlyArchives`: Es werden Archive **im Zielordner** gesucht (`findArchiveCandidates(options.targetDir)`) und nacheinander entpackt.
- Pro nested-Archiv: Entpacken, ggf. `cleanupArchives([nestedArchive], ...)`.
- Kann bei vielen/vollen Archiven deutlich Zeit kosten und den Slot blockieren.

### 4.2 Post-Cleanup (Zeilen 2286–2328)

- Nur wenn `!options.skipPostCleanup`:
  - **cleanupArchives(cleanupSources, cleanupMode):** Entfernen/Trash der entpackten Quell-Archive (readdir pro Verzeichnis, ggf. viele `rm`/rename).
  - **removeDownloadLinkArtifacts(targetDir):** Link-Artefakte im Zielordner entfernen.
  - **removeSampleArtifacts(targetDir):** Rekursives Durchlaufen des kompletten Extract-Ordners, Erkennung von Sample-Dateien/Ordnern, Löschen.
  - **removeEmptyDirectoryTree(packageDir):** Rekursives Auflisten aller Unterordner, dann sortiert leere Ordner von tief nach flach löschen.

All das läuft **vor** dem Return von `extractPackageArchives`. Erst danach kommt im Download-Manager noch `recordPackageHistory` und `void runDeferredPostExtraction`. Der Slot wird also erst nach dem **gesamten** `extractPackageArchives`-Lauf (inkl. Nested + Post-Cleanup) freigegeben.

**Typische Zeitfresser (10–15 s):**

- `cleanupArchives`: viele Dateien/Archive → viele I/O-Ops.
- `removeSampleArtifacts`: vollständiger rekursiver Scan des Extract-Ordners.
- `removeEmptyDirectoryTree`: rekursives readdir über die ganze Verzeichnisstruktur.
- Nested-Extraction: zusätzliches Entpacken und ggf. weiteres Cleanup.

---

## 5. Was im Download-Manager NACH dem Extractor noch passiert (Final-Pfad)

- **recordPackageHistory:** synchron, in-memory + Callback – vernachlässigbar.
- **runDeferredPostExtraction:** wird mit `void` gestartet, blockiert den Slot **nicht**. Darin laufen (im Hintergrund):
  - `autoRenameExtractedVideoFiles`
  - `cleanupRemainingArchiveArtifacts` (bei Hybrid-Szenario/cleanupMode)
  - `collectMkvFilesToLibrary`
  - `applyPackageDoneCleanup`

Diese Schritte verursachen **keine** Pause mehr zwischen zwei Packs im Final-Pfad, weil der Slot schon vorher freigegeben wird.

---

## 6. Zusammenfassung: Wo entstehen die 10–15 Sekunden Pause?

| Szenario | Was blockiert den Slot (Pause bis zum nächsten Pack)? |
|----------|--------------------------------------------------------|
| **Hybrid-Extract** (Pack hat noch offene Items) | `await autoRenameExtractedVideoFiles` **direkt nach** `extractPackageArchives` in `runHybridExtraction` (Zeile 6490). Rekursives Scannen + Umbenennen aller Video-Dateien. |
| **Finales Post-Processing** (Pack fertig) | Alles **innerhalb** von `extractPackageArchives`: Nested-Extraction (falls vorhanden) + Post-Cleanup (`cleanupArchives`, `removeDownloadLinkArtifacts`, `removeSampleArtifacts`, `removeEmptyDirectoryTree`). Rekursive Scans und viele I/O-Ops. |

In beiden Fällen ist die Pause also die Zeit **vor** `releasePostProcessSlot()` – einmal durch Rename im Manager (Hybrid), einmal durch Post-Cleanup und Nested-Extraction im Extractor (Final).

---

## 7. Mögliche Verbesserungen (nur Konzept, keine Änderung)

- **Hybrid-Pfad:**  
  `autoRenameExtractedVideoFiles` nach dem Hybrid-Extract **nicht** mehr awaiten, sondern (analog zu `runDeferredPostExtraction`) im Hintergrund starten und sofort aus `runHybridExtraction` zurückkehren. Dann wird der Slot direkt nach `extractPackageArchives` freigegeben; Rename läuft parallel.

- **Final-Pfad / Extractor:**  
  Post-Cleanup (und ggf. Nested-Extraction) **nicht** mehr synchron am Ende von `extractPackageArchives` ausführen, sondern:
  - Entweder: Extractor gibt nach dem letzten „eigentlichen“ Entpacken sofort zurück und eine andere Komponente (z. B. Download-Manager oder eine Queue) übernimmt Cleanup/Nested im Hintergrund; oder
  - Extractor bekommt eine Option (z. B. `deferPostCleanup: true`), liefert die nötigen Daten (z. B. Liste der zu löschenden Archive) zurück, und der Aufrufer führt Cleanup/Nested asynchron aus.

- **Slot-Logik unverändert:**  
  Ein Slot bleibt sinnvoll, um I/O und CPU beim Entpacken zu bündeln. Durch die Entkopplung der „teuren“ Schritte (Rename, Cleanup, Nested) von der Slot-Holding-Zeit verkürzt sich die Pause zwischen zwei Packs ohne Parallel-Entpacken mehrerer Packs.

---

## 8. Relevante Stellen im Code (Orientierung)

- Slot: `acquirePostProcessSlot` / `releasePostProcessSlot` (download-manager.ts, ca. 3761–3804).
- Post-Processing-Task: `runPackagePostProcessing` → `handlePackagePostProcessing` (ca. 3806–3854, 6544–6916).
- Hybrid: `runHybridExtraction` (ca. 6374–6542), inkl. `await autoRenameExtractedVideoFiles` (6490).
- Final: `handlePackagePostProcessing` nach `extractPackageArchives` (6697–6916): `recordPackageHistory`, `void runDeferredPostExtraction`, dann return.
- Extractor: `extractPackageArchives` (extractor.ts, ca. 1880–2353), Nested 2208–2284, Post-Cleanup 2286–2328.
- Rename: `autoRenameExtractedVideoFiles` (download-manager.ts, 2173–2312), nutzt `collectVideoFiles` (rekursiv).
- MKV/Cleanup: `collectMkvFilesToLibrary` (2448), `cleanupRemainingArchiveArtifacts` (2353), `runDeferredPostExtraction` (6922–6965).

---

## 9. Vergleich: JDownloader (jdownloader-source)

Im JDownloader-Quellcode (z. B. `C:\Users\ploet\Desktop\jdownloader-source`) ist das Entpacken so aufgebaut, dass **pro Pack (3 Parts = 1 Folge) kaum schwere Arbeit nach dem eigentlichen Entpacken** im gleichen Queue-Job läuft – deshalb wirkt es „ohne Pause“.

### Ablauf bei JDownloader

- **Ein Archiv = ein Pack** (z. B. 3 RAR-Parts = 1 Archive mit `archive.getArchiveFiles()`).
- **Eine Queue** (`ExtractionQueue`), ein Job pro Archiv (`ExtractionController` extends `QueueAction`).
- Pro Job passiert in `ExtractionController.run()`:
  1. `extractor.extract(this)` – reines Entpacken.
  2. `extractor.close()`.
  3. Je nach Exit-Code: `fireEvent(ExtractionEvent.Type.FINISHED)` (inkl. `FileCreationEvent(NEW_FILES, files)` – die Dateiliste kommt vom Extractor, **kein** rekursives Scannen).
  4. Im **finally**: `fireEvent(Type.CLEANUP)` → `archive.onCleanUp()`.
  5. Listener bei `CLEANUP`: `controller.removeArchiveFiles()`.

### Was `removeArchiveFiles()` bei JDownloader macht

- Holt die **bereits bekannten** Archive-Dateien: `archive.getArchiveFiles()` (die 3 Parts sind dem Archiv von Anfang an zugeordnet).
- Löscht nur diese Dateien (z. B. `link.deleteFile(remove)` pro Part).
- **Kein** rekursives Durchsuchen von Ordnern, **kein** `findArchiveCandidates`, **kein** Scannen des Extract-Ordners.
- Aufwand: O(Anzahl Parts) Datei-Löschungen, typisch sehr schnell.

### Was JDownloader in diesem Pfad nicht macht

- **Kein** Auto-Rename der entpackten Dateien im Extraction-Queue-Job (LinknameCleaner wird an anderer Stelle für Pfadsegmente genutzt, nicht als Blockierung nach Extract).
- **Kein** „Collect MKV to Library“ (rekursives Scannen + Verschieben) im gleichen Job.
- **Kein** `removeSampleArtifacts` (rekursiver Scan des Extract-Ordners).
- **Kein** `removeEmptyDirectoryTree` (rekursives Auflisten aller Unterordner).
- Nested-Archive (Deep-Extraction) werden als **neue** Archive in die Queue gestellt (`addToQueue(..., newArchive, false)`), also **separate Jobs**, die nacheinander laufen – der aktuelle Job ist sofort fertig.

### Warum es sich „flawless“ anfühlt

- Der kritische Pfad pro Pack ist: **Entpacken → Event FINISHED → Event CLEANUP → nur die bekannten Archive-Dateien löschen → `run()` endet**.
- Keine rechen- oder I/O-intensiven Schritte (keine rekursiven Scans, kein Rename, keine MKV-Sammlung) im gleichen Queue-Job.
- Das nächste Pack (nächster `ExtractionController` in der Queue) startet direkt nach `run()` return – die spürbare Pause entfällt.

### Übertrag auf unser Projekt

- Um ein ähnlich „flüssiges“ Verhalten zu erreichen, sollten **alle** zeitaufwändigen Schritte (Rename, MKV-Sammlung, Sample-Cleanup, leere Ordner entfernen, ggf. Post-Cleanup im Extractor) **nicht** den Post-Process-Slot blockieren.
- Konkret: Sie entweder **nach** `releasePostProcessSlot()` im Hintergrund ausführen (wie beim Final-Pfad bereits für Rename/MKV/Cleanup im Manager) **oder** den Extractor so auslegen, dass er direkt nach dem letzten eigentlichen Entpacken zurückkehrt und Cleanup/Nested in einem separaten, asynchronen Schritt erledigt wird (siehe Abschnitt 7).
