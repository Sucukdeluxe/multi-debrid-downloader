import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.21";

const BODY = `## What's Changed in v1.6.21

### Bug Fixes (Deep Code Review — Round 6)

This release fixes 8 bugs found through a sixth comprehensive code review covering the extractor, download manager, storage layer, renderer UI, and app controller.

#### Critical: Nested extraction ignores "trash" cleanup mode
- The main extraction path properly handles all cleanup modes via \`cleanupArchives()\`. However, the nested extraction path (archives found inside extracted output) had its own inline cleanup that only checked for \`"delete"\`, completely ignoring the \`"trash"\` mode
- Users with cleanup mode set to "trash" would find nested archive files left behind in the target directory alongside extracted content
- **Fix:** Replaced the inline \`if (cleanupMode === "delete") { unlink(...) }\` with a call to the existing \`cleanupArchives()\` function that handles all modes

#### Critical: \`resetPackage()\` does not re-add items to \`runItemIds\`/\`runPackageIds\` when session is running
- \`resetItems()\` was fixed in v1.6.19 to re-add items to \`runItemIds\` when the session is running. However, the parallel method \`resetPackage()\` was not updated — it removed items from \`runItemIds\` but never re-added them
- This caused \`recordRunOutcome()\` to silently discard outcomes for reset items, producing inaccurate session summaries
- **Fix:** After resetting all items, re-add them to \`runItemIds\` and re-add the package to \`runPackageIds\` if the session is running

#### Important: \`importBackup\` writes session without normalization
- The backup import handler cast the session JSON directly to \`SessionState\` and wrote it to disk without passing through \`normalizeLoadedSession()\` or \`normalizeLoadedSessionTransientFields()\`. Items with stale active statuses, non-zero \`speedBps\`, or invalid field values from a crafted backup were persisted verbatim
- **Fix:** Added normalization before saving. Exported both normalization functions from storage module

#### Important: \`sanitizeCredentialPersistence\` clears archive passwords
- When \`rememberToken\` was disabled, the sanitization function also wiped \`archivePasswordList\`. Archive passwords are NOT authentication credentials — they are extraction passwords for unpacking downloaded archives
- Users who disabled "Remember Token" lost all their custom archive passwords on every app restart
- **Fix:** Removed \`archivePasswordList\` from the credential sanitization

#### Important: Delete key fires regardless of active tab — data loss risk
- The Delete key handler checked \`selectedIds.size > 0\` but did NOT check which tab was active. If the user selected packages on Downloads tab, switched to Settings, and pressed Delete, the packages would be silently deleted
- **Fix:** Added \`tabRef.current === "downloads"\` guard

#### Important: Escape key inconsistency + no tab guard
- Pressing Escape cleared download selection but never cleared history selection. Also fired on every tab causing unnecessary re-renders
- **Fix:** Escape now checks active tab — clears \`selectedIds\` on Downloads tab, \`selectedHistoryIds\` on History tab

#### Important: Generic split file skip not counted in progress
- When a generic \`.001\` split file was skipped (no archive signature), the function returned early without incrementing \`extracted\` or \`failed\`, causing extraction progress to never reach 100%
- **Fix:** Increment \`extracted\` before returning for skipped generic splits

#### Important: Mousedown deselection fires inside modals
- The mousedown handler that clears package selection checked for \`.package-card\` and \`.ctx-menu\` but not modals. Clicking inside any modal cleared the selection
- **Fix:** Added \`.modal-backdrop\` and \`.modal-card\` to the exclusion list

#### Minor: \`PackageCard\` memo comparator missing multiple fields
- Missing: \`pkg.priority\`, \`pkg.createdAt\`, \`item.downloadedBytes\`, \`item.totalBytes\`. Changes to these fields would not trigger re-renders
- **Fix:** Added all four missing field comparisons

### Files Changed
- \`src/main/extractor.ts\` — Nested extraction uses \`cleanupArchives()\` for all modes; generic split skip increments \`extracted\`
- \`src/main/download-manager.ts\` — \`resetPackage()\` re-adds to \`runItemIds\`/\`runPackageIds\` when running
- \`src/main/app-controller.ts\` — \`importBackup\` normalizes session before save
- \`src/main/storage.ts\` — Exported normalization functions; removed \`archivePasswordList\` from credential sanitization
- \`src/renderer/App.tsx\` — Delete/Escape key tab guards; mousedown modal exclusions; PackageCard memo field additions
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
    { file: "Real-Debrid-Downloader-Setup-1.6.21.exe", name: "Real-Debrid-Downloader-Setup-1.6.21.exe" },
    { file: "Real-Debrid-Downloader 1.6.21.exe", name: "Real-Debrid-Downloader-1.6.21.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.21.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.21.exe.blockmap" },
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
