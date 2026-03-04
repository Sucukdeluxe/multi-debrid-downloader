import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.17";

const BODY = `## What's Changed in v1.6.17

### Bug Fixes (Deep Code Review — Round 2)

This release fixes 9 additional bugs found through a second comprehensive code review covering the download manager, renderer, extractor, and storage layer.

#### Critical: \\\`autoExtractWhenStopped\\\` setting silently dropped on save/load
- \\\`normalizeSettings()\\\` in \\\`storage.ts\\\` was missing the \\\`autoExtractWhenStopped\\\` field. Every time settings were saved or loaded, the field was stripped — effectively hardcoding the feature to "off" after the first persistence cycle
- **Fix:** Added \\\`autoExtractWhenStopped\\\` to \\\`normalizeSettings()\\\` with proper boolean coercion and default fallback

#### Critical: Parallel extraction password data race
- When \\\`maxParallelExtract > 1\\\`, multiple concurrent workers read/wrote the shared \\\`passwordCandidates\\\` variable without synchronization, causing lost password promotions
- **Fix:** Password list is frozen before parallel extraction; concurrent mutations discarded

#### Important: \\\`start()\\\` does not clear \\\`retryStateByItem\\\` — premature shelving after stop/restart
- \\\`start()\\\` cleared retry delays but NOT failure counters. Items inherited stale counts from previous runs, getting shelved prematurely (threshold 15, old run had 10 = shelved after 5 errors)
- **Fix:** Added \\\`retryStateByItem.clear()\\\` to \\\`start()\\\`

#### Important: \\\`SUBST_THRESHOLD\\\` too low — subst drive mapped on nearly every extraction
- Triggered at path length >= 100 chars, but most real paths exceed that. Raised to 200 (MAX_PATH is 260)

#### Important: Settings quicksave race condition
- Menu quicksaves cleared \\\`settingsDirtyRef\\\` unconditionally in \\\`.finally()\\\`, overriding concurrent settings changes
- **Fix:** All 7 quicksave paths now use a revision counter guard

#### Important: \\\`removeCollectorTab\\\` side effect in setState callback
- Mutated outer-scope variable inside setState updater (unsafe in React Strict/Concurrent Mode)
- **Fix:** Refactored to avoid side effects in the render callback

#### Minor: Escape key clears selection during text input
- Added input focus guard matching the existing Delete key guard

#### Minor: Debug console.log in production removed
#### Minor: maxParallel input missing clamp in settings tab

### Files Changed
- \\\`src/main/storage.ts\\\` — \\\`autoExtractWhenStopped\\\` in \\\`normalizeSettings()\\\`
- \\\`src/main/download-manager.ts\\\` — \\\`start()\\\` clears \\\`retryStateByItem\\\`
- \\\`src/main/extractor.ts\\\` — \\\`SUBST_THRESHOLD\\\` 100 to 200, parallel password race fix
- \\\`src/renderer/App.tsx\\\` — Quicksave revision guard, collector tab fix, Escape guard, console.log removal, maxParallel clamp
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
    { file: "Real-Debrid-Downloader-Setup-1.6.17.exe", name: "Real-Debrid-Downloader-Setup-1.6.17.exe" },
    { file: "Real-Debrid-Downloader 1.6.17.exe", name: "Real-Debrid-Downloader-1.6.17.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.17.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.17.exe.blockmap" },
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
