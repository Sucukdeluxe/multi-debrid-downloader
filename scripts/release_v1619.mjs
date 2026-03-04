import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.19";

const BODY = `## What's Changed in v1.6.19

### Bug Fixes (Deep Code Review — Round 4)

This release fixes 8 bugs found through a fourth comprehensive code review covering the download manager, renderer, storage layer, and IPC handlers.

#### Critical: \`resetItems()\`/\`resetPackage()\` abort race corrupts item state
- When resetting an item that is actively downloading, the abort was sent with reason \`"cancel"\`. The async \`processItem\` catch block then overwrote the freshly-reset item state back to \`status="cancelled"\`, \`fullStatus="Entfernt"\` — making the item permanently stuck
- The identity guard (\`session.items[id] !== item\`) did not protect against this because reset keeps the same item object reference
- **Fix:** Introduced a new abort reason \`"reset"\` for \`resetItems()\`/\`resetPackage()\`. The \`processItem\` catch block now handles \`"reset"\` as a no-op, preserving the already-correct state set by the reset function

#### Important: \`resolveStartConflict("skip")\` fullStatus race condition
- When skipping a package during a running session, active items were aborted with reason \`"package_toggle"\`. The async catch block then overwrote \`fullStatus\` from \`"Wartet"\` to \`"Paket gestoppt"\`, showing a confusing UI state for items that were skipped (not toggled off)
- **Fix:** Added a \`queueMicrotask()\` callback after the abort loop that re-corrects any items whose \`fullStatus\` was overwritten to \`"Paket gestoppt"\`

#### Important: "Don't ask again" delete confirmation not persisted to server
- Clicking "Nicht mehr anzeigen" in the delete confirmation dialog only updated the local draft state via \`setBool()\`, but never called \`window.rd.updateSettings()\`. On app restart, the setting reverted to \`true\`
- **Fix:** Added an immediate \`window.rd.updateSettings({ confirmDeleteSelection: false })\` call alongside the draft state update

#### Important: Storage \`writeFileSync\` leaves corrupt \`.tmp\` file on disk-full/permission error
- \`saveSettings()\`, \`saveSession()\`, and \`saveHistory()\` wrote to a \`.tmp\` file then renamed. If \`writeFileSync\` threw (disk full, permission denied), the partially-written \`.tmp\` file was left on disk without cleanup
- **Fix:** Wrapped write+rename in try/catch with \`.tmp\` cleanup in the catch block for all three sync save functions

#### Important: Tray "Start" click — unhandled Promise rejection
- The tray context menu's "Start" handler called \`controller.start()\` without \`.catch()\` or \`void\`. If \`start()\` threw (e.g., network error during conflict check), it resulted in an unhandled Promise rejection
- **Fix:** Added \`void controller.start().catch(...)\` with a logger warning

#### Important: \`resetItems()\` removes item from \`runItemIds\` without re-adding — session summary incomplete
- When an item was reset during a running session, it was removed from \`runItemIds\` but never re-added. The scheduler would still pick it up (via package membership), but \`recordRunOutcome()\` would skip it since \`runItemIds.has(itemId)\` returned false. Session summary counts were therefore inaccurate
- **Fix:** After resetting an item, re-add it to \`runItemIds\` if the session is running

#### Minor: \`importBackup\` no file size limit
- The backup import handler read files into memory without any size guard. A user accidentally selecting a multi-GB file could crash the Electron process
- **Fix:** Added a 50 MB file size check before reading

#### Minor: Bandwidth schedule inputs accept NaN
- The start/end hour inputs for bandwidth schedules passed \`Number(e.target.value)\` directly without NaN guard. Clearing the field produced \`NaN\` in the settings draft, which could be serialized and sent to the server
- **Fix:** Added \`Number.isNaN()\` guard with \`Math.max(0, Math.min(23, v))\` clamping

### Files Changed
- \`src/main/download-manager.ts\` — New \`"reset"\` abort reason for \`resetItems()\`/\`resetPackage()\`; \`processItem\` handles \`"reset"\` as no-op; \`resolveStartConflict("skip")\` queueMicrotask fix; \`resetItems()\` re-adds to \`runItemIds\` when running
- \`src/main/main.ts\` — Tray Start \`.catch()\`; \`importBackup\` file size guard
- \`src/main/storage.ts\` — \`.tmp\` cleanup on write failure for \`saveSettings\`, \`saveSession\`, \`saveHistory\`
- \`src/renderer/App.tsx\` — Delete confirmation persists to server; bandwidth schedule NaN guard
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
    { file: "Real-Debrid-Downloader-Setup-1.6.19.exe", name: "Real-Debrid-Downloader-Setup-1.6.19.exe" },
    { file: "Real-Debrid-Downloader 1.6.19.exe", name: "Real-Debrid-Downloader-1.6.19.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.19.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.19.exe.blockmap" },
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
