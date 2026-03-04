import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.27";

const BODY = `## What's Changed in v1.6.27

### Bug Fixes (Deep Code Review — Round 3)

This release fixes 10 bugs found through an intensive 10-agent parallel code review, including a **critical regression** introduced in v1.6.26.

---

### Critical (1 fix)

#### \`applyRapidgatorCheckResult\` crashes with \`ReferenceError: itemId is not defined\`
- The v1.6.26 fix for recording run outcomes used \`itemId\` instead of \`item.id\` — the method parameter is \`item\`, not \`itemId\`. This would crash at runtime whenever a Rapidgator link was detected as offline during an active run, potentially halting the entire download session.
- **Fix:** Changed \`itemId\` to \`item.id\` in both the \`runItemIds.has()\` check and the \`recordRunOutcome()\` call.

---

### Important (3 fixes)

#### Extraction timeout/exception overwrites already-extracted items' status
- When the extraction process timed out or threw an exception, ALL completed items in the package had their \`fullStatus\` overwritten to \`Entpack-Fehler: ...\`, even items whose archives had already been successfully extracted. This caused items showing "Entpackt - Done (1m 23s)" to suddenly show an error.
- **Fix:** Added an \`isExtractedLabel()\` guard — only items whose \`fullStatus\` does NOT already indicate successful extraction get the error label.

#### Hybrid extraction false error when extracted=0 and failed=0
- In hybrid extraction mode, when \`result.extracted === 0 && result.failed === 0\` (e.g., all archives were already extracted via resume state), the condition fell through and set \`fullStatus = "Entpacken - Error"\` even though nothing actually failed.
- **Fix:** Restructured the condition to only set error status when \`result.failed > 0\`, set done status when \`result.extracted > 0\`, and leave current status unchanged (no-op) when both are 0.

#### \`applyRetroactiveCleanupPolicy\` \`allExtracted\` check doesn't skip failed/cancelled items
- When checking if all items in a package were extracted (to decide whether to clean up), failed and cancelled items were not skipped. A package with 9 extracted items and 1 failed item would never be cleaned up, even though the failed item can never be extracted.
- **Fix:** Skip items with \`status === "failed"\` or \`status === "cancelled"\` in the \`allExtracted\` check.

---

### Medium (6 fixes)

#### \`resetPackage\` missing cleanup for \`runCompletedPackages\`, \`packagePostProcessTasks\`, \`hybridExtractRequeue\`
- When resetting a package (re-downloading all items), the package ID was not removed from \`runCompletedPackages\`, \`packagePostProcessTasks\`, and \`hybridExtractRequeue\` maps. This could cause the reset package's extraction to be skipped (if already in \`runCompletedPackages\`) or the scheduler to wait forever for a stale post-processing task.
- **Fix:** Delete the package ID from all three maps after aborting the post-processing controller.

#### \`freshRetry\` does not call \`dropItemContribution\`
- When an item failed and was retried via the "fresh retry" path (delete file, re-queue), \`dropItemContribution()\` was not called before re-queuing. Session download statistics (\`totalDownloadedBytes\`) remained inflated by the failed item's bytes.
- **Fix:** Call \`this.dropItemContribution(item.id)\` before queuing the retry.

#### JVM extractor layout cache not caching \`null\` result
- When Java was not installed, \`discoverJvmLayout()\` returned \`null\` but didn't cache it. Every extraction attempt re-ran the Java discovery process (spawning processes, checking paths), adding unnecessary latency.
- **Fix:** Cache \`null\` results with a timestamp (\`cachedJvmLayoutNullSince\`). Re-check after 60 seconds in case the user installs Java mid-session.

#### Parallel resume-state writes race condition
- When multiple archives extracted in parallel, each called \`writeExtractResumeState()\` which wrote to the same temp file path. Two concurrent writes could collide: one renames the temp file while the other is still writing to it, causing the second write to silently fail or produce a corrupt resume file.
- **Fix:** Use unique temp file paths with timestamp + random suffix per write operation. On rename failure, clean up the orphaned temp file.

#### Stale closure in Ctrl+O keyboard handler
- The \`useEffect\` with \`[]\` deps captured the initial version of \`onImportDlc\`. When the user changed settings (like download directory) and then pressed Ctrl+O, the keyboard handler called the stale closure which sent outdated settings to the backend, potentially importing DLC files to the wrong directory.
- **Fix:** Added a \`useRef\` (\`onImportDlcRef\`) that always points to the latest \`onImportDlc\` function. The keyboard handler now calls \`onImportDlcRef.current()\`.

#### \`applyCompletedCleanupPolicy\` immediate path leaks \`retryStateByItem\` entries
- (Carried from v1.6.26) The immediate cleanup path cleaned up \`retryAfterByItem\` but not \`retryStateByItem\`, causing a minor memory leak over long sessions.
- **Fix:** Added \`this.retryStateByItem.delete(itemId)\` alongside the existing \`retryAfterByItem\` cleanup.

---

### Files Changed
- \`src/main/download-manager.ts\` — applyRapidgatorCheckResult itemId→item.id; extraction timeout isExtractedLabel guard; hybrid false error restructured; applyRetroactiveCleanupPolicy allExtracted skip failed/cancelled; resetPackage cleanup maps; freshRetry dropItemContribution; retryStateByItem cleanup
- \`src/main/extractor.ts\` — JVM layout null cache; parallel resume-state unique tmp paths
- \`src/renderer/App.tsx\` — Ctrl+O stale closure fix via useRef
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
    { file: "Real-Debrid-Downloader-Setup-1.6.27.exe", name: "Real-Debrid-Downloader-Setup-1.6.27.exe" },
    { file: "Real-Debrid-Downloader 1.6.27.exe", name: "Real-Debrid-Downloader-1.6.27.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.27.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.27.exe.blockmap" },
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
