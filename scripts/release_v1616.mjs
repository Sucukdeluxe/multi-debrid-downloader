import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.16";

const BODY = `## What's Changed in v1.6.16

### Bug Fixes (Code Review)

This release fixes 11 bugs found through a comprehensive code review of the download manager, renderer, IPC layer, and app controller.

#### Critical: \`finishRun()\` clears state needed by still-running extraction tasks
- When \`autoExtractWhenStopped\` is enabled, the scheduler calls \`finishRun()\` as soon as downloads complete. \`finishRun()\` was clearing \`runPackageIds\` and \`runCompletedPackages\` immediately, but still-running extraction tasks needed those sets to update \`runCompletedPackages\` when they finish
- **Fix:** \`runPackageIds\` and \`runCompletedPackages\` are now only cleared when no post-processing tasks are running. Otherwise they are preserved until the next \`start()\` call

#### Critical: Post-process slot counter corrupted after stop+restart
- \`acquirePostProcessSlot()\` increments \`packagePostProcessActive\` after the awaited promise resolves. But \`stop()\` resets the counter to 0 while waiters are pending. When \`stop()\` resolves all waiters, the increment fires afterward, pushing the counter from 0→1 before any new task runs — causing the first extraction in the next session to unnecessarily queue
- **Fix:** Added a guard that only increments if below \`maxConcurrent\` after the await, matching the existing guard in \`releasePostProcessSlot()\`

#### Important: \`resetPackage()\` skips history on re-completion
- \`historyRecordedPackages\` was never cleared for a package when it was reset. If a user reset a package and it completed again, \`recordPackageHistory()\` would find it already in the set and skip recording — no history entry was created for the second run
- **Fix:** \`resetPackage()\` now calls \`this.historyRecordedPackages.delete(packageId)\`

#### Important: Context menu "Ausgewählte Downloads starten" sends non-startable items
- The context menu button filtered items by startable status (\`queued\`/\`cancelled\`/\`reconnect_wait\`) only for the visibility check, but the click handler sent ALL selected item IDs to \`startItems()\`, including items already downloading or completed
- **Fix:** Click handler now filters item IDs to only startable statuses before sending to \`startItems()\`

#### Important: \`importBackup\` persist race condition
- After calling \`stop()\` + \`abortAllPostProcessing()\`, deferred \`persistSoon()\` timers from those operations could fire and overwrite the restored session file on disk with the old in-memory session
- **Fix:** \`clearPersistTimer()\` is now called after abort to cancel any pending persist timers. Made it a public method for this purpose

#### Important: Auto-Resume on start never fires
- \`autoResumePending\` was set in an async \`getStartConflicts().then()\` callback, but the \`onState\` setter (which checks the flag) always ran synchronously before the promise resolved. The flag was always \`false\` when checked, so auto-resume never triggered
- **Fix:** The \`.then()\` callback now checks if \`onStateHandler\` is already set and starts the download directly in that case, instead of just setting a flag

#### IPC validation hardening
- \`START_PACKAGES\`, \`SKIP_ITEMS\`, \`RESET_ITEMS\` handlers used only \`Array.isArray()\` instead of \`validateStringArray()\`, missing element-type validation and null guards
- \`SET_PACKAGE_PRIORITY\` accepted any string value instead of validating against \`"high" | "normal" | "low"\`
- **Fix:** All handlers now use \`validateStringArray()\` with null guards, and priority is enum-validated

#### History context menu stale closure
- \`removeSelected()\` in the history context menu read \`selectedHistoryIds\` directly in the \`.then()\` callback instead of using a captured snapshot. If selection changed during the async IPC round-trip, the wrong entries could be filtered
- **Fix:** Captured the set into a local \`idSet\` before the async call, matching the pattern already used by the toolbar delete button

#### Update quit timer not cancellable
- \`installUpdate\` set a 2.5-second \`setTimeout\` for \`app.quit()\` but stored no reference to it. If the user manually closed the window during that time, \`before-quit\` would fire normally, then the timer would call \`app.quit()\` again, potentially causing double shutdown cleanup
- **Fix:** Timer reference is now stored and cleared in the \`before-quit\` handler

### Files Changed
- \`src/main/download-manager.ts\` — \`finishRun()\` conditional clear, \`acquirePostProcessSlot()\` guard, \`resetPackage()\` history fix, \`clearPersistTimer()\` public
- \`src/main/app-controller.ts\` — \`importBackup\` persist timer cancel, \`autoResumePending\` race fix
- \`src/main/main.ts\` — IPC validation hardening, update quit timer cancel, priority enum validation
- \`src/renderer/App.tsx\` — Context menu item filter, history stale closure fix
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
    { file: "Real-Debrid-Downloader-Setup-1.6.16.exe", name: "Real-Debrid-Downloader-Setup-1.6.16.exe" },
    { file: "Real-Debrid-Downloader 1.6.16.exe", name: "Real-Debrid-Downloader-1.6.16.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.16.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.16.exe.blockmap" },
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
