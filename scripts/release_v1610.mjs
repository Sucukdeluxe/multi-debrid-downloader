import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.10";

const BODY = `## What's Changed in v1.6.10

### Critical Bug Fixes

#### Post-Process Slot Counter Race Condition (multiple packages extracting simultaneously)
- **Bug:** After stopping and restarting a session, the internal post-processing slot counter could go **negative**. This allowed multiple packages to extract simultaneously instead of the intended one-at-a-time sequential extraction.
- **Root cause:** \`stop()\` resets the active counter to 0 and resolves all waiting promises. The resolved waiters then increment the counter (+N), but ALL tasks (including the original active one) still decrement it in their cleanup (-(N+1)), resulting in a negative value. On the next session start, multiple packages pass the \`active < maxConcurrent\` check.
- **Fix:** Added a guard in \`releasePostProcessSlot()\` to prevent the counter from going below zero.

#### Extraction Resume State / Progress Sync Bug (first episode stays "Entpacken - Ausstehend")
- **Bug:** When an archive was previously extracted in a hybrid extraction round and recorded in the resume state, but the app was stopped before the item's "Entpackt - Done" label was persisted, the next full extraction would skip the archive (correctly, via resume state) but never update the item's UI label. The item would permanently show "Entpacken - Ausstehend" while all other episodes showed "Entpackt - Done".
- **Fix:** \`extractPackageArchives()\` now emits progress events with \`archivePercent: 100\` for archives that are already in the resume state, so the caller's \`onProgress\` handler marks those items as "Entpackt - Done" immediately.

#### Abort Labels Applied to Non-Extracting Items
- **Bug:** When stopping a session, \`abortPostProcessing()\` set ALL completed items with any "Entpacken" label to "Entpacken abgebrochen (wird fortgesetzt)" — including items that were merely "Entpacken - Ausstehend" or "Entpacken - Warten auf Parts" and had never started extracting.
- **Fix:** The abort label is now only applied to items with active extraction progress (e.g., "Entpacken 64%"), not to pending items.

#### Missing Package Status Update in Hybrid Extraction Branches
- **Bug:** \`triggerPendingExtractions()\` and \`recoverPostProcessingOnStartup()\` did not set \`pkg.status = "queued"\` in their hybrid extraction branches, unlike the full extraction branches. This could cause the package status bar to show incorrect state during hybrid extraction.
- **Fix:** Both hybrid branches now correctly set \`pkg.status = "queued"\` before triggering extraction.

### Files Changed
- \`src/main/download-manager.ts\` — Slot counter guard, abort label fix, hybrid pkg.status
- \`src/main/extractor.ts\` — Resume state progress emission
- \`package.json\` — Version bump to 1.6.10
`;

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "codeberg.org",
      path: `/api/v1/repos/${OWNER}/${REPO}${apiPath}`,
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
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
    const fileBuffer = fs.readFileSync(filePath);
    const options = {
      hostname: "codeberg.org",
      path: `/api/v1/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      method: "POST",
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": fileBuffer.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Upload ${fileName}: ${res.statusCode}: ${data}`));
        } else {
          console.log(`  Uploaded: ${fileName}`);
          resolve(JSON.parse(data));
        }
      });
    });
    req.on("error", reject);
    req.write(fileBuffer);
    req.end();
  });
}

async function main() {
  console.log("Creating release...");
  const release = await apiRequest("POST", "/releases", {
    tag_name: TAG,
    name: TAG,
    body: BODY,
    draft: false,
    prerelease: false,
  });
  console.log(`Release created: ${release.html_url}`);

  const releaseDir = path.resolve("release");
  const assets = [
    { file: `Real-Debrid-Downloader-Setup-1.6.10.exe`, name: `Real-Debrid-Downloader-Setup-1.6.10.exe` },
    { file: `Real-Debrid-Downloader 1.6.10.exe`, name: `Real-Debrid-Downloader-1.6.10.exe` },
    { file: `latest.yml`, name: `latest.yml` },
    { file: `Real-Debrid-Downloader Setup 1.6.10.exe.blockmap`, name: `Real-Debrid-Downloader-Setup-1.6.10.exe.blockmap` },
  ];

  for (const asset of assets) {
    const filePath = path.join(releaseDir, asset.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  SKIP (not found): ${asset.file}`);
      continue;
    }
    await uploadAsset(release.id, filePath, asset.name);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
