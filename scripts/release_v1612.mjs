import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.12";

const BODY = `## What's Changed in v1.6.12

### Bug Fixes (found via code review)

#### Package status incorrectly set to "downloading" during idle extraction
- When extraction ran while the session was stopped (via the new \`autoExtractWhenStopped\` feature), \`handlePackagePostProcessing\` would set \`pkg.status = "downloading"\` after hybrid extraction completed — even though no downloads were active
- This caused packages to appear as "downloading" in the UI when the session was stopped, which was confusing and semantically incorrect
- **Fix:** The status derivation now checks \`this.session.running\` in addition to \`pkg.enabled\` and \`!this.session.paused\`. When the session is stopped, packages are set to \`"queued"\` instead of \`"downloading"\`

#### Backup import leaves orphan extraction tasks running
- When importing a backup with \`autoExtractWhenStopped = true\`, the \`importBackup()\` method called \`stop()\` which no longer aborts extraction tasks (by design). This meant extraction tasks from the **old** session continued running in the background, potentially mutating stale in-memory state while the restored session was being saved to disk
- **Fix:** \`importBackup()\` now explicitly calls \`abortAllPostProcessing()\` after \`stop()\` to ensure all extraction tasks from the old session are terminated before the new session is loaded
- Added public \`abortAllPostProcessing()\` method to DownloadManager for external callers that need a full extraction abort regardless of settings

#### Corrected misleading comment in installUpdate()
- The comment in \`installUpdate()\` claimed it stops "downloads/extractions" but with \`autoExtractWhenStopped\`, extractions may continue briefly until \`prepareForShutdown()\` runs during app quit. Updated comment to reflect actual behavior.

### Files Changed
- \`src/main/download-manager.ts\` — Fixed \`pkg.status\` derivation in \`handlePackagePostProcessing\`, added \`abortAllPostProcessing()\`
- \`src/main/app-controller.ts\` — \`importBackup()\` now aborts all post-processing, updated \`installUpdate()\` comment
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
    { file: "Real-Debrid-Downloader-Setup-1.6.12.exe", name: "Real-Debrid-Downloader-Setup-1.6.12.exe" },
    { file: "Real-Debrid-Downloader 1.6.12.exe", name: "Real-Debrid-Downloader-1.6.12.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.12.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.12.exe.blockmap" },
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
