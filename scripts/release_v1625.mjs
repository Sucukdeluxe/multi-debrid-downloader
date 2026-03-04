import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.25";

const BODY = `## What's Changed in v1.6.25

### Bug Fixes (Deep Code Review — Round 11)

This release fixes 12 bugs found through an intensive 10-agent parallel code review covering every line of the codebase.

---

### Critical (2 fixes)

#### Critical: In-flight async session save can overwrite restored backup or shutdown state
- \\\`importBackup()\\\` called \\\`cancelPendingAsyncSaves()\\\` which only nullified queued saves, but an already-executing async save could complete its \\\`rename()\\\` after the synchronous backup restore, silently overwriting the restored session. Same race existed during shutdown.
- **Fix:** Added a \\\`syncSaveGeneration\\\` counter to \\\`storage.ts\\\`. Synchronous saves and \\\`cancelPendingAsyncSaves()\\\` increment the counter. Async writes check the generation before \\\`rename()\\\` and discard stale writes.

#### Critical: Menu bar quick-settings silently discard unsaved settings panel changes
- When using the speed limit or max-parallel spinners in the menu bar, the \\\`.finally()\\\` callback falsely reset \\\`settingsDirtyRef\\\` to \\\`false\\\`. If the user had unsaved changes in the Settings panel (e.g. a new API token), the next backend state update would overwrite the draft, silently losing those changes.
- **Fix:** Added a separate \\\`panelDirtyRevisionRef\\\` counter. Panel changes (setBool, setText, setNum, schedules, theme) increment it. Quick-settings only clear \\\`settingsDirtyRef\\\` when \\\`panelDirtyRevisionRef === 0\\\`. Reset to 0 on save and init.

---

### Important (10 fixes)

#### \\\`skipItems()\\\` does not refresh parent package status
- After setting items to cancelled/skipped, the parent package's status was never recalculated. Packages showed as "queued" despite all items being skipped. The scheduler kept checking these packages unnecessarily.
- **Fix:** Collect affected package IDs and call \\\`refreshPackageStatus()\\\` for each.

#### \\\`getSessionStats()\\\` shows non-zero speed after session stops
- \\\`currentSpeedBps\\\` only checked \\\`paused\\\` but not \\\`!session.running\\\`, unlike \\\`emitState()\\\`. After stopping a run, the stats API briefly returned stale speed values.
- **Fix:** Added \\\`!this.session.running\\\` check, matching \\\`emitState()\\\` logic.

#### Hybrid extraction catch leaves items with frozen progress labels
- The catch block only marked items with "Ausstehend" or "Warten auf Parts" as Error. Items showing active progress (e.g. "Entpacken 45%...") were left with a frozen label permanently.
- **Fix:** Extended the check to match any \\\`fullStatus\\\` starting with "Entpacken" (excluding already-extracted items).

#### \\\`normalizeHistoryEntry()\\\` drops \\\`urls\\\` field on load
- The history normalization function never read or included the \\\`urls\\\` property. After a save-load cycle, all URL data was permanently lost.
- **Fix:** Parse and include \\\`urls\\\` array from the raw entry.

#### "Immediate" retroactive cleanup creates no history entry
- When the cleanup policy removed all items from a package, \\\`removePackageFromSession()\\\` was called with an empty array, so no history entry was recorded. Packages silently vanished from the download log.
- **Fix:** Pass \\\`completedItemIds\\\` to \\\`removePackageFromSession()\\\` for history recording. Delete items from session only after the history call. Also fixed missing \\\`retryStateByItem\\\` cleanup.

#### Skipped generic split files counted as extracted but not tracked for resume
- When a generic \\\`.001\\\` file had no archive signature and was skipped, it was counted in \\\`extracted\\\` but not added to \\\`resumeCompleted\\\` or \\\`extractedArchives\\\`. On resume, it would be re-processed; cleanup wouldn't find it.
- **Fix:** Add skipped files to both \\\`resumeCompleted\\\` and \\\`extractedArchives\\\`.

#### \\\`noextractor:skipped\\\` treated as abort in parallel extraction mode
- In the parallel worker pool, \\\`noextractor:skipped\\\` was caught by \\\`isExtractAbortError()\\\` and set as \\\`abortError\\\`. The error was then re-thrown as "aborted:extract", preventing the correct no-extractor counting logic from running.
- **Fix:** Check for "noextractor:skipped" before the abort check and break without setting \\\`abortError\\\`.

#### \\\`collectArchiveCleanupTargets\\\` missing tar.gz/bz2/xz
- Tar compound archives (.tar.gz, .tar.bz2, .tar.xz, .tgz, .tbz2, .txz) were not recognized by the cleanup function. After successful extraction, the source archive was never deleted.
- **Fix:** Added a tar compound archive pattern before the generic split check.

#### \\\`runWithConcurrency\\\` continues dispatching after first error
- When one worker threw an error (e.g. abort), \\\`firstError\\\` was set but \\\`next()\\\` kept returning items. Other workers started new requests unnecessarily, delaying the abort.
- **Fix:** Check \\\`firstError\\\` in \\\`next()\\\` and return \\\`undefined\\\` to stop dispatching.

#### Side effect inside React state updater in \\\`onPackageFinishEdit\\\`
- The \\\`setEditingPackageId\\\` updater function contained an IPC call (\\\`renamePackage\\\`) as a side effect. React may call updater functions multiple times (e.g. StrictMode), causing duplicate rename RPCs.
- **Fix:** Moved the IPC call outside the updater. The updater now only returns the new state; the rename fires after based on a flag.

---

### Minor

- Fixed typo "Session-Ubersicht" -> "Session-\\u00dcbersicht" in statistics tab

---

### Files Changed
- \\\`src/main/storage.ts\\\` — syncSaveGeneration counter for async save race protection; normalizeHistoryEntry urls field
- \\\`src/main/download-manager.ts\\\` — skipItems refreshPackageStatus; currentSpeedBps running check; hybrid extraction catch broadened; immediate cleanup history fix + retryStateByItem cleanup
- \\\`src/main/extractor.ts\\\` — skipped generic splits resume/cleanup tracking; noextractor parallel mode fix; tar.gz/bz2/xz cleanup targets
- \\\`src/main/debrid.ts\\\` — runWithConcurrency stops on first error
- \\\`src/renderer/App.tsx\\\` — panelDirtyRevisionRef for settings dirty tracking; onPackageFinishEdit side effect fix; Session-\\u00dcbersicht typo
`;

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "codeberg.org",
      path: `/api/v1${apiPath}`,
      method,
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${text}`));
        else resolve(JSON.parse(text || "{}"));
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function uploadAsset(releaseId, filePath, fileName) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(filePath);
    const opts = {
      hostname: "codeberg.org",
      path: `/api/v1/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/octet-stream", "Content-Length": data.length },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) reject(new Error(`Upload ${fileName}: ${res.statusCode} ${text}`));
        else resolve(JSON.parse(text || "{}"));
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("Creating release...");
  const release = await apiRequest("POST", `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG, name: TAG, body: BODY, draft: false, prerelease: false,
  });
  console.log(`Release created: ${release.id}`);
  const releaseDir = path.join(__dirname, "..", "release");
  const assets = [
    { file: "Real-Debrid-Downloader-Setup-1.6.25.exe", name: "Real-Debrid-Downloader-Setup-1.6.25.exe" },
    { file: "Real-Debrid-Downloader 1.6.25.exe", name: "Real-Debrid-Downloader-1.6.25.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.25.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.25.exe.blockmap" },
  ];
  for (const a of assets) {
    const p = path.join(releaseDir, a.file);
    if (!fs.existsSync(p)) { console.warn(`SKIP ${a.file}`); continue; }
    console.log(`Uploading ${a.name} ...`);
    await uploadAsset(release.id, p, a.name);
    console.log(`  done.`);
  }
  console.log("Release complete!");
}
main().catch((e) => { console.error(e); process.exit(1); });
