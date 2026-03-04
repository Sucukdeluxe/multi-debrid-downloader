import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.18";

const BODY = `## What's Changed in v1.6.18

### Bug Fixes (Deep Code Review — Round 3)

This release fixes 6 bugs found through a third comprehensive code review covering the download manager, renderer, CSS layer, and test fixtures.

#### Important: \`resolveStartConflict("skip")\` ineffective during running session
- When the session was running and a start conflict was resolved with "skip", items were removed from \`runItemIds\` only when \`!session.running\`. This meant skipped items stayed in the run set and the scheduler would re-download them, defeating the skip entirely
- **Fix:** Items and packages are now unconditionally removed from \`runItemIds\`/\`runPackageIds\` regardless of session state

#### Important: \`skipItems()\` corrupts run summary totals
- \`skipItems()\` set items to "cancelled" but never called \`recordRunOutcome()\`. Skipped items were invisible to the run summary, causing inaccurate completion statistics
- **Fix:** Added \`recordRunOutcome(itemId, "cancelled")\` for each skipped item

#### Important: \`handleUpdateResult\` holds \`actionBusy\` lock across user confirm dialog
- When manually checking for updates, the entire \`handleUpdateResult\` (including the "Install update?" confirmation dialog) ran inside \`performQuickAction\`. While the dialog was open, all UI buttons were disabled since \`actionBusy\` was held
- **Fix:** The update check API call is now separated from the result handling — \`actionBusy\` is released after the API call completes, before the confirm dialog is shown

#### Minor: Drop overlay missing z-index
- \`.drop-overlay\` had \`position: fixed\` but no \`z-index\`, so it could render behind context menus (\`z-index: 100\`) or modals (\`z-index: 20\`) when dragging files
- **Fix:** Added \`z-index: 200\` to \`.drop-overlay\`

#### Minor: \`etaText.split(": ")\` fragile ETA parsing
- The statistics tab split \`etaText\` on \`": "\`, which broke for ETAs containing colons (e.g., "ETA: 2:30:15" would show just "2" instead of "2:30:15")
- **Fix:** Replaced \`split(": ")\` with \`indexOf(": ")\`/\`slice()\` to split only on the first occurrence

#### Minor: Test fixtures missing required \`priority\` field
- \`PackageEntry\` requires a \`priority\` field since v1.5.x, but test fixtures in \`app-order.test.ts\` omitted it, causing a type mismatch (vitest doesn't type-check by default so this was silent)
- **Fix:** Added \`priority: "normal"\` to all test fixtures

### Files Changed
- \`src/main/download-manager.ts\` — \`skipItems()\` calls \`recordRunOutcome()\`; \`resolveStartConflict("skip")\` removes items/packages from run sets unconditionally
- \`src/renderer/App.tsx\` — \`onCheckUpdates\` releases \`actionBusy\` before confirm dialog; ETA text split fix
- \`src/renderer/styles.css\` — \`drop-overlay\` z-index
- \`tests/app-order.test.ts\` — Added \`priority: "normal"\` to PackageEntry fixtures
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
    { file: "Real-Debrid-Downloader-Setup-1.6.18.exe", name: "Real-Debrid-Downloader-Setup-1.6.18.exe" },
    { file: "Real-Debrid-Downloader 1.6.18.exe", name: "Real-Debrid-Downloader-1.6.18.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.18.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.18.exe.blockmap" },
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
