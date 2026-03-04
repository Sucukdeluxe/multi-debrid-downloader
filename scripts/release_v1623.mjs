import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.23";

const BODY = `## What's Changed in v1.6.23

### Bug Fixes (Deep Code Review — Rounds 8, 9 & 10)

This release fixes 24 bugs found through three comprehensive code review rounds covering the download manager, extractor, debrid clients, storage layer, app controller, and renderer UI.

---

### Round 8: Download Manager Core Logic (8 fixes)

#### Critical: \\\`resetItems()\\\` does not re-add packages to \\\`runPackageIds\\\`
- When \\\`resetItems\\\` was called during a "Start Selected" run, it re-added item IDs to \\\`runItemIds\\\` but never re-added the parent package to \\\`runPackageIds\\\`. The scheduler's \\\`findNextQueuedItem()\\\` checks \\\`runPackageIds\\\` and would permanently skip those items
- **Fix:** After resetting items, add all affected package IDs to \\\`runPackageIds\\\`

#### Critical: \\\`resolveStartConflict("overwrite")\\\` missing \\\`runPackageIds\\\` re-add
- Same issue: overwrite conflict resolution reset items and re-added to \\\`runItemIds\\\` but not \\\`runPackageIds\\\`. The overwritten items would never be picked up by the scheduler
- **Fix:** Added \\\`runPackageIds.add(packageId)\\\` after the overwrite reset

#### Critical: \\\`resolveStartConflict\\\`/\\\`resetPackage\\\`/\\\`resetItems\\\` don't call \\\`ensureScheduler()\\\`
- After resetting items to "queued", neither method kicked the scheduler. If the scheduler had already detected all downloads complete and was about to call \\\`finishRun()\\\`, the newly queued items would be stranded
- **Fix:** Added \\\`ensureScheduler()\\\` calls after reset operations when the session is running

#### Important: \\\`sessionDownloadedBytes\\\` not subtracted on retry fresh-start
- When the server ignored the Range header (HTTP 200 instead of 206), the code subtracted bytes from \\\`session.totalDownloadedBytes\\\` but not from \\\`sessionDownloadedBytes\\\`. The session speed stats drifted upward with each retry
- **Fix:** Added \\\`sessionDownloadedBytes\\\` subtraction alongside \\\`totalDownloadedBytes\\\`

#### Important: Failed packages with \\\`autoExtract\\\` + \\\`package_done\\\` policy never cleaned up
- The \\\`allExtracted\\\` check required ALL items (including failed/cancelled ones) to have extraction labels. Failed items never get extracted, so the guard blocked cleanup forever. Packages with any failures accumulated in the UI permanently
- **Fix:** Skip failed/cancelled items in the \\\`allExtracted\\\` check — only completed items need extraction

#### Important: \\\`on_start\\\` cleanup removes completed items ignoring extraction status
- At app startup, the \\\`on_start\\\` cleanup policy deleted all completed items without checking whether they had been extracted. If the app was closed mid-download before extraction ran, completed items were silently removed and extraction could never happen
- **Fix:** Added \\\`autoExtract\\\` guard: keep completed items that haven't been extracted yet

#### Important: History \\\`totalBytes\\\` inflated by non-completed items
- When deleting a package, the history entry summed \\\`downloadedBytes\\\` from ALL items (including failed/cancelled with partial data) but \\\`fileCount\\\` only counted completed items. This created a mismatch between reported size and file count
- **Fix:** Filter to completed items before summing bytes

#### Minor: Status mismatch for cancelled+success packages between startup and runtime
- On app restart, a package with some completed and some cancelled items got status "failed". During runtime, the same scenario correctly got "completed"
- **Fix:** Aligned startup logic with runtime: \\\`cancelled > 0 && success > 0\\\` now produces "completed" consistently

---

### Round 9: Debrid, Extractor, Storage & Main (8 fixes)

#### Critical: Real-Debrid "HTML statt JSON" error not retryable
- When Real-Debrid returned an HTML response (Cloudflare challenge, maintenance page), \\\`realdebrid.ts\\\` threw immediately without retrying. The equivalent check in \\\`debrid.ts\\\` (for AllDebrid/BestDebrid) already included this case
- **Fix:** Added \\\`"html statt json"\\\` to \\\`isRetryableErrorText\\\` in \\\`realdebrid.ts\\\`

#### Critical: Real-Debrid no URL protocol validation for download URLs
- The direct download URL from Real-Debrid was used without validating the protocol. BestDebrid and AllDebrid both validate for \\\`http:\\\`/\\\`https:\\\` only. An unexpected protocol (e.g., \\\`ftp:\\\`, \\\`file:\\\`) would cause cryptic fetch errors
- **Fix:** Added URL parsing and protocol validation matching the other clients

#### Important: BestDebrid outer loop swallows abort errors
- The outer request loop in \\\`BestDebridClient.unrestrictLink\\\` caught ALL errors including abort errors. If \\\`buildBestDebridRequests\\\` returned multiple requests, a user abort would be caught and the next request attempted
- **Fix:** Re-throw abort errors before continuing the loop

#### Important: Shutdown persists session asynchronously — data loss on fast exit
- \\\`prepareForShutdown()\\\` called \\\`persistNow()\\\` which starts an async write. The process could exit before the write completed, losing the final session state. Items could be stuck in "downloading" status on next startup
- **Fix:** Replaced async \\\`persistNow()\\\` with synchronous \\\`saveSession()\\\` + \\\`saveSettings()\\\` during shutdown

#### Important: \\\`importBackup\\\` race condition with in-flight async save
- If an async save was in-flight when the user imported a backup, the async save's \\\`finally\\\` clause would process its queued payload AFTER the backup was written, silently overwriting the restored session
- **Fix:** Added \\\`cancelPendingAsyncSaves()\\\` that clears both session and settings async queues before writing the backup

#### Important: Serial extraction path missing \\\`failed\\\` count for skipped archives
- When no extractor was available, the serial extraction loop broke early but didn't count remaining archives as failed. The parallel path already had this counting. Progress never reached 100% and the extraction summary understated failures
- **Fix:** Added remaining archive counting after the serial loop, matching the parallel path

#### Minor: \\\`"reset"\\\` not in \\\`abortReason\\\` union type
- The TypeScript type for \\\`ActiveTask.abortReason\\\` listed 7 values but omitted \\\`"reset"\\\`, which was assigned in 3 locations and handled in the catch block. The code worked at runtime but lacked type safety
- **Fix:** Added \\\`"reset"\\\` to the union type

#### Minor: \\\`skipItems\\\` doesn't clear \\\`retryAfterByItem\\\`/\\\`retryStateByItem\\\`
- When items in retry-delay were skipped, their \\\`retryAfterByItem\\\` entries leaked until \\\`finishRun()\\\`. While not causing functional issues (the status check filters them), it's unnecessary memory retention
- **Fix:** Delete both retry entries when skipping items

---

### Round 10: Renderer UI (8 fixes)

#### Critical: \\\`Ctrl+A\\\` hijacks native select-all in text inputs
- The \\\`Ctrl+A\\\` handler selected all packages/history entries without checking if the focused element was an input or textarea. Users pressing \\\`Ctrl+A\\\` in the search bar or collector textarea lost their text selection
- **Fix:** Added input/textarea guard before handling \\\`Ctrl+A\\\`

#### Important: \\\`Ctrl+Q\\\`/\\\`Ctrl+Shift+R\\\` fire inside text inputs — accidental quit/restart
- The app quit and restart shortcuts fired regardless of focus. A user typing in an input field could accidentally trigger app quit/restart
- **Fix:** Added input/textarea guard for all keyboard shortcuts (\\\`Ctrl+Q\\\`, \\\`Ctrl+Shift+R\\\`, \\\`Ctrl+L\\\`, \\\`Ctrl+P\\\`, \\\`Ctrl+O\\\`)

#### Important: \\\`onAddLinks\\\`/\\\`onImportDlc\\\`/\\\`onDrop\\\` read stale \\\`collapseNewPackages\\\` setting
- These async functions read \\\`snapshot.settings.collapseNewPackages\\\` via closure, but after multiple \\\`await\\\` calls the value could be stale. If the user toggled the setting during the async operation, the old value was used
- **Fix:** Changed to read from \\\`snapshotRef.current.settings.collapseNewPackages\\\`

#### Important: \\\`showLinksPopup\\\` captures stale \\\`snapshot.session\\\`
- The link popup callback closed over \\\`snapshot.session.packages\\\` and \\\`snapshot.session.items\\\`. If a state update arrived while the context menu was open, the callback used stale data, potentially showing empty or incomplete link lists
- **Fix:** Changed to read from \\\`snapshotRef.current.session\\\` and removed snapshot dependencies from \\\`useCallback\\\`

#### Important: \\\`dragDidMoveRef\\\` never reset after mouseup — blocks next click
- After a \\\`Ctrl+drag-select\\\` operation, \\\`dragDidMoveRef.current\\\` stayed \\\`true\\\`. The next single click was silently swallowed because \\\`onSelectId\\\` checked \\\`if (dragDidMoveRef.current) return\\\`
- **Fix:** Reset \\\`dragDidMoveRef.current = false\\\` in the mouseup handler

#### Important: Rename \\\`onBlur\\\` fires after Enter key — double rename RPC
- Pressing Enter to confirm a rename triggered \\\`onFinishEdit\\\` from the keydown handler. React then removed the input, which fired a blur event that called \\\`onFinishEdit\\\` again. The \\\`renamePackage\\\` RPC was sent twice
- **Fix:** Added idempotency guard: \\\`setEditingPackageId\\\` only processes the rename if the package ID still matches

#### Important: Escape key clears selection when overlay is open
- Pressing Escape while a context menu, modal, or link popup was visible both closed the overlay AND cleared the package selection. Users expected Escape to only dismiss the overlay
- **Fix:** Check for visible overlays before clearing selection

#### Minor: \\\`packageOrder\\\` normalization O(n\\\\u00B2) via \\\`Array.includes\\\`
- The session normalization loop used \\\`packageOrder.includes(id)\\\` (O(n)) when \\\`seenOrder.has(id)\\\` (O(1)) was already available. With hundreds of packages, this caused measurable startup slowdown
- **Fix:** Use \\\`seenOrder.has()\\\` instead of \\\`packageOrder.includes()\\\`

---

### Files Changed
- \\\`src/main/download-manager.ts\\\` — resetItems/resolveStartConflict runPackageIds fix; ensureScheduler calls; sessionDownloadedBytes retry fix; cleanup policy extraction guards; history bytes filter; startup status alignment; shutdown sync persist; skipItems cleanup
- \\\`src/main/extractor.ts\\\` — Serial path noExtractor remaining count
- \\\`src/main/realdebrid.ts\\\` — HTML retry; URL protocol validation
- \\\`src/main/debrid.ts\\\` — BestDebrid abort propagation in outer loop
- \\\`src/main/storage.ts\\\` — cancelPendingAsyncSaves; packageOrder O(1) lookup
- \\\`src/main/app-controller.ts\\\` — importBackup cancels async saves
- \\\`src/renderer/App.tsx\\\` — Keyboard shortcut input guards; stale closure fixes (collapseNewPackages, showLinksPopup); dragDidMoveRef reset; rename double-call guard; Escape overlay check
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
    { file: "Real-Debrid-Downloader-Setup-1.6.23.exe", name: "Real-Debrid-Downloader-Setup-1.6.23.exe" },
    { file: "Real-Debrid-Downloader 1.6.23.exe", name: "Real-Debrid-Downloader-1.6.23.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.23.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.23.exe.blockmap" },
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
