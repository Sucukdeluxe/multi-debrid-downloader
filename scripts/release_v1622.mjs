import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.22";

const BODY = `## What's Changed in v1.6.22

### Bug Fixes (Deep Code Review — Round 7)

This release fixes 8 bugs found through a seventh comprehensive code review covering the debrid service layer, download manager, and renderer UI.

#### Critical: Per-request timeout treated as user abort — breaks retry loops and provider fallback
- All debrid API clients (Real-Debrid, BestDebrid, AllDebrid) used \`/aborted/i.test(errorText)\` to detect user cancellation. However, when a per-request timeout fired (via \`AbortSignal.timeout(30000)\`), Node.js threw an error containing "aborted due to timeout" — matching the regex and breaking out of the retry loop on the first timeout
- This had three severe consequences: (1) no retries on slow API responses, (2) provider fallback chain aborted entirely if the primary provider timed out (AllDebrid never tried even when configured), (3) Rapidgator online checks failed permanently on timeout
- **Fix:** Narrowed the abort detection regex to exclude timeout errors: \`/aborted/i.test(text) && !/timeout/i.test(text)\`. Applied across 10 catch blocks in \`realdebrid.ts\` and \`debrid.ts\`

#### Critical: \`resolveStartConflict("overwrite")\` uses "cancel" abort reason — race condition corrupts item state
- The overwrite conflict resolution path aborted active downloads with \`abortReason = "cancel"\`. The \`processItem\` catch handler then saw "cancel" and overwrote the freshly-reset item state back to \`status="cancelled"\`, \`fullStatus="Entfernt"\` — the same race condition that was fixed for \`resetItems()\` in v1.6.19
- Items became permanently stuck as "cancelled" and the scheduler would never pick them up
- **Fix:** Changed the abort reason from \`"cancel"\` to \`"reset"\`, whose catch handler is a no-op that preserves the already-correct state

#### Important: \`checkRapidgatorLinks\` — single failure aborts entire batch, stranding items in "checking" state
- All items were set to \`onlineStatus = "checking"\` before the loop. The \`checkRapidgatorOnline()\` call had no try-catch wrapper. If one URL check threw (e.g., due to the timeout-as-abort bug above), all subsequent items remained in "checking" state indefinitely
- **Fix:** Wrapped the check in try-catch. On error, the item's \`onlineStatus\` is reset to \`undefined\` and the loop continues

#### Important: \`applyCompletedCleanupPolicy("immediate")\` deletes non-completed items
- When \`autoExtract\` was disabled and cleanup policy was "immediate", the method blindly removed whatever item was specified — including \`failed\` or \`cancelled\` items. For a failed package (which has at least one failed item), the failed items got deleted from the session without the user ever seeing them
- **Fix:** Added \`item.status !== "completed"\` guard before the deletion logic

#### Important: \`visiblePackages\` reorders packages but \`isFirst\`/\`isLast\` use original order
- When downloads are running, active packages are sorted to the top. But \`isFirst\`/\`isLast\` were computed from the original \`packageOrder\`, not the rendered order. This meant the "move up" button was enabled on visually-first packages and "move down" on visually-last ones, causing confusing reordering behavior
- **Fix:** Changed to use the rendered index (\`idx === 0\` / \`idx === visiblePackages.length - 1\`)

#### Important: \`sessionDownloadedBytes\` never subtracted on retry — inflated session stats
- When a download failed and retried, \`dropItemContribution\` correctly subtracted bytes from \`session.totalDownloadedBytes\` but not from \`sessionDownloadedBytes\` (the UI stats counter). The "Session Downloaded" display became inflated by the sum of all discarded retry bytes
- Also, \`resetSessionTotalsIfQueueEmpty\` forgot to reset \`sessionDownloadedBytes\`, leaving ghost totals after clearing the queue
- **Fix:** Added \`sessionDownloadedBytes\` subtraction in \`dropItemContribution\` and reset in \`resetSessionTotalsIfQueueEmpty\`

#### Important: Escape key doesn't clear history selection
- Pressing Escape cleared download selection (\`selectedIds\`) but did nothing for history selection (\`selectedHistoryIds\`). Already partially addressed in v1.6.21 (tab guard), this release ensures the Escape handler also clears the correct selection per tab

#### Minor: \`removeCollectorTab\` defers tab switch via \`setTimeout\` — stale active tab for one render tick
- When removing a collector tab, the fallback tab activation was deferred with \`setTimeout(..., 0)\`. During the intervening render, \`activeCollectorTab\` pointed to the removed tab, causing the textarea to show the wrong tab's content and clipboard detection to append to the wrong tab
- **Fix:** Moved \`setActiveCollectorTab\` outside the \`setCollectorTabs\` updater so both state updates batch in the same render

### Files Changed
- \`src/main/debrid.ts\` — Timeout-aware abort detection in all catch blocks (8 locations)
- \`src/main/realdebrid.ts\` — Timeout-aware abort detection in unrestrict retry loop
- \`src/main/download-manager.ts\` — Overwrite conflict uses "reset" abort reason; Rapidgator check per-item try-catch; cleanup policy completed guard; sessionDownloadedBytes fix
- \`src/renderer/App.tsx\` — \`isFirst\`/\`isLast\` from rendered order; \`removeCollectorTab\` synchronous tab switch
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
    { file: "Real-Debrid-Downloader-Setup-1.6.22.exe", name: "Real-Debrid-Downloader-Setup-1.6.22.exe" },
    { file: "Real-Debrid-Downloader 1.6.22.exe", name: "Real-Debrid-Downloader-1.6.22.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.22.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.22.exe.blockmap" },
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
