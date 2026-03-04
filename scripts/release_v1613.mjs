import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.13";

const BODY = `## What's Changed in v1.6.13

### Bug Fixes

#### History entries not being created
- **Fixed: Nothing was being added to the download history** regardless of whether using Start or Stop mode
- Root cause: History entries were only created inside \`removePackageFromSession()\`, which only runs when the cleanup policy removes the package from the session. With \`completedCleanupPolicy = "never"\` (the default), packages are never removed, so history was never populated. With \`"immediate"\` policy, items were removed one-by-one leaving an empty array when the package itself was removed — also resulting in no history entry
- **Fix:** History entries are now recorded directly in \`handlePackagePostProcessing()\` when a package completes extraction (or download without extraction). A deduplication Set (\`historyRecordedPackages\`) prevents double entries when the cleanup policy also removes the package
- The \`removePackageFromSession()\` history logic now only fires for manual deletions (reason = "deleted"), not for completions which are already tracked

#### UI delay after extraction completes (20-30 seconds)
- **Fixed: Package stayed visible for 20-30 seconds after extraction finished** before disappearing or showing "Done" status
- Root cause: After extraction set \`pkg.status = "completed"\`, there was no \`emitState()\` call. The next UI update only happened after \`autoRenameExtractedVideoFiles()\`, \`collectMkvFilesToLibrary()\`, and \`applyPackageDoneCleanup()\` all completed — which could take 20-30 seconds for large packages with MKV collection or renaming
- **Fix:** Added an \`emitState()\` call immediately after the package status is set (completed/failed), before the rename and MKV collection steps. The UI now reflects the extraction result instantly while post-extraction steps run in the background

### Files Changed
- \`src/main/download-manager.ts\` — New \`recordPackageHistory()\` method, \`historyRecordedPackages\` deduplication Set, \`emitState()\` after extraction completion, refactored \`removePackageFromSession()\` history logic
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
    { file: "Real-Debrid-Downloader-Setup-1.6.13.exe", name: "Real-Debrid-Downloader-Setup-1.6.13.exe" },
    { file: "Real-Debrid-Downloader 1.6.13.exe", name: "Real-Debrid-Downloader-1.6.13.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.13.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.13.exe.blockmap" },
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
