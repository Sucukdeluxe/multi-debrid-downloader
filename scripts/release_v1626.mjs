import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.26";

const BODY = `## What's Changed in v1.6.26

### Bug Fixes (Deep Code Review — Round 2)

This release fixes 13 bugs found through an intensive 10-agent parallel code review covering every line of the codebase.

---

### Important (4 fixes)

#### \`applyRapidgatorCheckResult\` sets items to "failed" without recording run outcome
- When an asynchronous Rapidgator online-check returned "offline" during a running session, the item was set to \`status: "failed"\` but \`recordRunOutcome()\` was never called. The scheduler kept the item in \`runItemIds\` without an outcome, causing incorrect summary statistics and potentially preventing the session from finishing.
- **Fix:** Call \`recordRunOutcome(itemId, "failed")\` when the item is in \`runItemIds\`.

#### \`skipItems()\` does not trigger extraction when package becomes fully resolved
- After skipping the last queued/pending items in a package, \`refreshPackageStatus()\` correctly set the package to "completed", but no extraction was triggered. Items that were already downloaded sat with "Entpacken - Ausstehend" forever.
- **Fix:** After refreshing package statuses, check if all items are in a terminal state and trigger \`runPackagePostProcessing()\` for packages with unextracted completed items.

#### \`applyOnStartCleanupPolicy\` creates no history entries for cleaned-up packages
- The on_start cleanup deleted completed items from \`session.items\` inside the filter callback, then called \`removePackageFromSession(pkgId, [])\` with an empty array. Since \`removePackageFromSession\` uses the item IDs to build the history entry, no history was recorded. Packages silently vanished from the download log.
- **Fix:** Collect completed item IDs separately. Pass them to \`removePackageFromSession()\` for history recording. Delete items from \`session.items\` only in the non-empty-package branch.

#### \`cancelPackage\` overwrites completed items' run outcomes to "cancelled"
- When cancelling a package, \`recordRunOutcome(itemId, "cancelled")\` was called for ALL items including already-completed ones. This overwrote the "completed" outcome, causing the run summary to show incorrect numbers (e.g., "0 erfolgreich, 10 abgebrochen" instead of "8 erfolgreich, 2 abgebrochen").
- **Fix:** Only record "cancelled" outcome for items whose status is not "completed".

---

### Medium (8 fixes)

#### \`looksLikeArchivePart\` missing generic \`.NNN\` split file pattern
- The function recognized multipart RAR (\`.partNN.rar\`), old-style RAR (\`.rNN\`), split ZIP (\`.zip.NNN\`), and split 7z (\`.7z.NNN\`), but NOT generic \`.NNN\` split files (e.g., \`movie.001\`, \`movie.002\`). In hybrid extraction mode, this caused the system to incorrectly conclude that all parts of a generic split archive were ready, potentially triggering extraction before all parts were downloaded.
- **Fix:** Added a generic \`.NNN\` pattern that matches when the entry point ends with \`.001\` (excluding .zip/.7z variants).

#### \`resolveArchiveItemsFromList\` missing split ZIP/7z/generic patterns
- Only multipart RAR and old-style RAR patterns were recognized. Split ZIP (\`.zip.001\`), split 7z (\`.7z.001\`), and generic split (\`.001\`) archives fell through to exact-name matching, so only the entry-point file received per-archive progress labels while other parts showed stale "Ausstehend" during extraction.
- **Fix:** Added matching patterns for split ZIP, split 7z, and generic \`.NNN\` splits before the fallback exact-name match.

#### \`normalizeSessionStatuses\` does not update \`updatedAt\` for modified items
- When item statuses were normalized on app startup (e.g., \`cancelled/Gestoppt\` → \`queued\`, \`extracting\` → \`completed\`, \`downloading\` → \`queued\`), \`item.updatedAt\` was not updated. This left stale timestamps from the previous session, causing the unpause stall detector to prematurely abort freshly recovered items.
- **Fix:** Added \`item.updatedAt = nowMs()\` after each status change in \`normalizeSessionStatuses\`.

#### \`applyRetroactiveCleanupPolicy\` package_done check ignores failed/cancelled items
- The \`package_done\` retroactive cleanup only considered items with \`status === "completed"\` as "done". Packages with mixed outcomes (some completed, some failed/cancelled) were never cleaned up, even though the inline \`applyCompletedCleanupPolicy\` correctly treats failed/cancelled items as terminal.
- **Fix:** Extended the \`allCompleted\` check to include \`"failed"\` and \`"cancelled"\` statuses, matching the inline policy logic.

#### \`.tgz\`/\`.tbz2\`/\`.txz\` missing from \`findArchiveCandidates\`
- Tar compound archives with short-form extensions (.tgz, .tbz2, .txz) were not recognized as archive candidates by \`findArchiveCandidates()\`. They were silently skipped during extraction, even though \`collectArchiveCleanupTargets\` correctly recognized them.
- **Fix:** Extended the tar compressed filter regex to include short-form extensions. Also updated \`archiveSortKey\`, \`archiveTypeRank\`, and \`archiveFilenamePasswords\` for consistency.

#### \`subst\` drive mapping uses \`"Z:"\` instead of \`"Z:\\\\"\`
- When creating a subst drive for long-path workaround, \`effectiveTargetDir\` was set to \`"Z:"\` (without trailing backslash). On Windows, \`Z:\` without a backslash references the current directory on drive Z rather than the root. For 7z extractions, \`-oZ:\` could extract files to an unexpected location.
- **Fix:** Changed to \`"Z:\\\\"\` to explicitly reference the root of the subst drive.

#### Pre-allocated sparse file after crash marked as complete
- On Windows, downloads use sparse file pre-allocation (\`truncate(totalBytes)\`). If the process crashed hard (kill, power loss), the truncation cleanup never ran. On next startup, \`stat.size === totalBytes\` (pre-allocated zeros), and the HTTP 416 handler falsely treated the file as complete.
- **Fix:** Before resuming, compare \`stat.size\` with persisted \`item.downloadedBytes\`. If the file is >1MB larger than the persisted count, truncate to the persisted value.

#### Integrity-check retry does not call \`dropItemContribution\`
- When a file failed integrity validation and was deleted for re-download, \`item.downloadedBytes\` was reset to 0 but \`dropItemContribution()\` was not called. Session statistics (\`totalDownloadedBytes\`) remained inflated until the next download started.
- **Fix:** Call \`this.dropItemContribution(item.id)\` before resetting \`downloadedBytes\`.

---

### Low (1 fix)

#### \`applyCompletedCleanupPolicy\` (immediate path) leaks \`retryStateByItem\` entries
- The immediate cleanup path cleaned up \`retryAfterByItem\` but not \`retryStateByItem\`, causing a minor memory leak over long sessions.
- **Fix:** Added \`this.retryStateByItem.delete(itemId)\` alongside the existing \`retryAfterByItem\` cleanup.

---

### Files Changed
- \`src/main/download-manager.ts\` — resolveArchiveItemsFromList split patterns; looksLikeArchivePart generic .NNN; Rapidgator recordRunOutcome; skipItems triggers extraction; normalizeSessionStatuses updatedAt; applyRetroactiveCleanupPolicy failed/cancelled; applyOnStartCleanupPolicy history; cancelPackage outcome fix; pre-allocation crash guard; integrity-check dropItemContribution; immediate cleanup retryStateByItem
- \`src/main/extractor.ts\` — findArchiveCandidates .tgz/.tbz2/.txz; archiveSortKey/archiveTypeRank/archiveFilenamePasswords .tgz support; subst drive trailing backslash
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
    { file: "Real-Debrid-Downloader-Setup-1.6.26.exe", name: "Real-Debrid-Downloader-Setup-1.6.26.exe" },
    { file: "Real-Debrid-Downloader 1.6.26.exe", name: "Real-Debrid-Downloader-1.6.26.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.26.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.26.exe.blockmap" },
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
