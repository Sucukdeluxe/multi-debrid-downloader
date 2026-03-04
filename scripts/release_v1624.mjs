import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.24";

const BODY = `## What's Changed in v1.6.24

### Bug Fixes (Cross-Review Validation)

This release fixes 2 bugs found by cross-validating the codebase against an independent external review.

#### Important: Startup auto-retry recovery does not emit state update to UI
- \\\`recoverRetryableItems()\\\` mutated item statuses (failed -> queued) and refreshed package statuses on app startup, but never called \\\`emitState()\\\` or \\\`persistSoon()\\\`. The UI showed stale item statuses until the next periodic state emission or user interaction
- **Fix:** Added \\\`persistSoon()\\\` and \\\`emitState()\\\` after recovery completes

#### Minor: Rapidgator offline check does not refresh parent package status
- When \\\`applyRapidgatorCheckResult()\\\` set an item to \\\`status="failed"\\\` (offline), the parent package's status was not recalculated. The package could show as "queued" while containing failed items
- **Fix:** Call \\\`refreshPackageStatus(pkg)\\\` after marking an item as offline

### Files Changed
- \\\`src/main/download-manager.ts\\\` — recoverRetryableItems emitState/persistSoon; Rapidgator offline package status refresh
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
    { file: "Real-Debrid-Downloader-Setup-1.6.24.exe", name: "Real-Debrid-Downloader-Setup-1.6.24.exe" },
    { file: "Real-Debrid-Downloader 1.6.24.exe", name: "Real-Debrid-Downloader-1.6.24.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.24.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.24.exe.blockmap" },
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
