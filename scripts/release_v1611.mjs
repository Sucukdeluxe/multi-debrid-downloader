import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.11";

const BODY = `## What's Changed in v1.6.11

### New Feature: Extract While Stopped
- **New setting "Entpacken auch ohne laufende Session"** (default: enabled): Extractions now continue running even after clicking Stop, and pending extractions are automatically triggered on app startup without needing to click Start
- This means downloaded archives get extracted immediately regardless of session state — no more forgotten pending extractions after restart

### Bug Fixes

#### Update Installation Safety
- **Stop active downloads before installing updates**: Previously, launching an update while downloads were active could cause data corruption. The app now gracefully stops all downloads before spawning the installer
- **Increased quit timeout** from 800ms to 2500ms after launching the update installer, giving the OS more time to start the setup process before the app exits

#### Extraction Resume Progress (v1.6.9 fix)
- **Fixed "Entpacken - Ausstehend" for already-extracted archives**: When resuming extraction (e.g. after a crash), archives that were already successfully extracted in a previous run now correctly show as "Entpackt - Done" immediately, instead of staying stuck as "Entpacken - Ausstehend" until all remaining archives finish
- Root cause: The resume state correctly tracked completed archives, but no UI progress event was emitted for them, leaving their items with a stale "pending" label

#### Extraction Abort Label Accuracy (v1.6.9 fix)
- **"Entpacken abgebrochen" now only applied to actively extracting items**: Previously, clicking Stop would mark ALL extraction-related items as "Entpacken abgebrochen (wird fortgesetzt)" — even items that were just queued ("Ausstehend") or waiting for parts ("Warten auf Parts") and had never started extracting. Now only items with actual extraction progress get the "abgebrochen" label

#### Hybrid Extraction Package Status (v1.6.9 fix)
- **Fixed package status not updating for hybrid extraction recovery**: When recovering pending hybrid extractions on startup or after pause toggle, the package status is now correctly set to "queued" so the UI reflects that extraction work is pending

#### Parallel Extraction Slot Counter (v1.6.10 fix)
- **Fixed multiple packages extracting simultaneously despite maxParallelExtract=1**: The post-processing slot counter could go negative after Stop was clicked (stop resets counter to 0, but aborted tasks still decrement in their finally blocks). On the next session start, the negative counter let multiple packages pass the concurrency check. Added a guard to prevent the counter from going below zero

### Files Changed
- \`src/main/download-manager.ts\` — autoExtractWhenStopped logic in stop(), triggerIdleExtractions(), slot counter guard
- \`src/main/app-controller.ts\` — Stop downloads before update, trigger idle extractions on startup
- \`src/main/main.ts\` — Increased update quit timeout
- \`src/main/extractor.ts\` — Emit progress for resumed archives
- \`src/main/constants.ts\` — New default setting
- \`src/shared/types.ts\` — autoExtractWhenStopped type
- \`src/renderer/App.tsx\` — Settings toggle UI
`;

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "codeberg.org",
      path: `/api/v1${apiPath}`,
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(new Error(`${res.statusCode} ${text}`));
        } else {
          resolve(JSON.parse(text || "{}"));
        }
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
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": data.length,
      },
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
    tag_name: TAG,
    name: TAG,
    body: BODY,
    draft: false,
    prerelease: false,
  });
  console.log(`Release created: ${release.id}`);

  const releaseDir = path.join(__dirname, "..", "release");
  const assets = [
    { file: "Real-Debrid-Downloader-Setup-1.6.11.exe", name: "Real-Debrid-Downloader-Setup-1.6.11.exe" },
    { file: "Real-Debrid-Downloader 1.6.11.exe", name: "Real-Debrid-Downloader-1.6.11.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.11.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.11.exe.blockmap" },
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
