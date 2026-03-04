import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.28";

const BODY = `## What's Changed in v1.6.28

### Bug Fixes (Deep Code Review — Round 4)

This release fixes 11 bugs found through an intensive 10-agent parallel code review covering every line of the codebase.

---

### Important (3 fixes)

#### Extraction blocked after app restart when skipped items exist (\`cancelled > 0\`)
- \`recoverPostProcessingOnStartup()\` and \`triggerPendingExtractions()\` both required \`cancelled === 0\` to trigger extraction. When items were skipped (status: "cancelled") and the app was restarted before extraction finished, the extraction was never re-triggered. Items hung permanently on "Entpacken - Ausstehend".
- **Fix:** Removed the \`cancelled === 0\` check from both functions, consistent with \`handlePackagePostProcessing()\` which correctly proceeds with extraction despite cancelled items.

#### \`resetItems\` missing cleanup for package-level state maps
- When individual items were reset (re-download), the package was not removed from \`runCompletedPackages\`, \`historyRecordedPackages\`, \`packagePostProcessTasks\`, and \`hybridExtractRequeue\`. This caused: (1) inflated extraction counts in run summaries, (2) missing history entries when the package re-completed, (3) extraction continuing with now-deleted files if reset during active extraction.
- **Fix:** Added full package-level cleanup (abort post-processing controller, delete from all state maps) for each affected package, matching the behavior of \`resetPackage()\`.

#### Generic split-file skip does not persist resume state to disk
- When a generic \`.001\` split file was skipped (no archive signature detected), it was added to the in-memory \`resumeCompleted\` set but \`writeExtractResumeState()\` was never called. If the app crashed or was restarted before the next archive wrote resume state, the skipped file would be reprocessed on the next run. For packages consisting entirely of unrecognized generic splits, resume state was NEVER written.
- **Fix:** Call \`writeExtractResumeState()\` after adding the skipped archive to \`resumeCompleted\`.

---

### Medium (8 fixes)

#### \`removeItem\` loses history for last item of a package
- When removing the last item from a package, \`removePackageFromSession()\` was called with an empty \`itemIds\` array. Since history entries are built from item IDs, no history was recorded and the package silently vanished from the download log.
- **Fix:** Pass \`[itemId]\` instead of \`[]\` to \`removePackageFromSession()\` so the deleted item is included in the history entry.

#### \`sortPackageOrderByHoster\` sorts by debrid provider instead of file hoster
- Clicking the "Hoster" column header sorted packages by \`item.provider\` (the debrid service like "realdebrid") instead of the actual file hoster extracted from the URL (like "uploaded", "rapidgator"). The sort order did not match what the column displayed.
- **Fix:** Changed to use \`extractHoster(item.url)\` for sorting, matching the column display logic.

#### Abort error in single-provider mode triggers false provider cooldown
- When a user cancelled a download during the unrestrict phase with auto-fallback disabled, the abort error was wrapped as \`"Unrestrict fehlgeschlagen: ..."\`. Downstream code detected the "unrestrict" keyword and called \`recordProviderFailure()\`, putting the provider into an unnecessary cooldown that delayed subsequent downloads.
- **Fix:** Added an abort signal check before wrapping the error, consistent with the fallback code path. Abort errors are now re-thrown directly without the "Unrestrict fehlgeschlagen" prefix.

#### \`START_ITEMS\` IPC handler missing null-safe fallback
- The \`START_ITEMS\` handler validated \`itemIds ?? []\` but passed the raw \`itemIds\` (potentially \`null\`) to \`controller.startItems()\`. All other similar handlers (\`START_PACKAGES\`, \`SKIP_ITEMS\`, \`RESET_ITEMS\`) correctly used \`?? []\` for both validation and the controller call.
- **Fix:** Changed to \`controller.startItems(itemIds ?? [])\`.

#### \`finishRun()\` does not reset \`runStartedAt\`, causing stale session duration
- When a download run completed naturally, \`finishRun()\` set \`running = false\` but did not reset \`runStartedAt\` to 0. This caused \`getSessionStats()\` to report an ever-growing \`sessionDurationSeconds\` (wall clock time since run start) while \`totalDownloadedBytes\` stayed fixed, making \`averageSpeedBps\` decay toward 0 over time. In contrast, \`stop()\` correctly reset \`runStartedAt = 0\`.
- **Fix:** Added \`this.session.runStartedAt = 0\` to \`finishRun()\`.

#### Package status stuck at "downloading" when all items fail
- When all items in a package failed and none completed, the package status was never updated from "downloading" because \`refreshPackageStatus()\` was only called on item completion, not on item failure. The package remained in "downloading" state until the next app restart.
- **Fix:** Call \`refreshPackageStatus()\` after recording a failed item outcome in the error handler.

#### Shelve check preempts permanent link error detection
- The shelve check (\`totalNonStallFailures >= 15\`) ran before the \`isPermanentLinkError\` check. After accumulating 15+ failures, a permanent link error (dead link, file removed) would be shelved for a 5-minute retry pause instead of failing immediately, wasting time on irrecoverable errors.
- **Fix:** Moved the \`isPermanentLinkError\` check before the shelve check so permanent errors are detected immediately regardless of failure count.

#### Password-cracking labels not cleared on extraction error/abort/completion
- When extraction set item labels to "Passwort knacken: ..." or "Passwort gefunden ...", the error/completion handlers used \`/^Entpacken/\` regex to match items for status updates. This regex did not match password-related labels, leaving items permanently stuck with stale "Passwort knacken" or "Passwort gefunden" status after extraction errors, timeouts, or even successful completion.
- **Fix:** Extended the regex checks in hybrid success, hybrid error, and abort handlers to also match \`/^Passwort/\` labels.

---

### Files Changed
- \`src/main/download-manager.ts\` — recoverPostProcessingOnStartup/triggerPendingExtractions remove cancelled===0; resetItems package cleanup; removeItem history fix; finishRun runStartedAt; refreshPackageStatus on item failure; shelve vs permanent link error order; password label cleanup in hybrid/error/abort handlers
- \`src/main/extractor.ts\` — generic split-skip writeExtractResumeState
- \`src/main/debrid.ts\` — abort error passthrough in single-provider mode
- \`src/main/main.ts\` — START_ITEMS itemIds ?? []
- \`src/renderer/App.tsx\` — sortPackageOrderByHoster uses extractHoster
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
    { file: "Real-Debrid-Downloader-Setup-1.6.28.exe", name: "Real-Debrid-Downloader-Setup-1.6.28.exe" },
    { file: "Real-Debrid-Downloader 1.6.28.exe", name: "Real-Debrid-Downloader-1.6.28.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.28.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.28.exe.blockmap" },
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
