import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.20";

const BODY = `## What's Changed in v1.6.20

### Bug Fixes (Deep Code Review — Round 5)

This release fixes 8 bugs found through a fifth comprehensive code review covering the extractor, download manager, renderer, and JVM integration.

#### Critical: \`extractSingleArchive\` inflates \`failed\` counter on abort
- When extraction was aborted (e.g. by user or signal), the catch block incremented \`failed += 1\` **before** checking if the error was an abort error and re-throwing. This inflated the failed counter, potentially causing the extraction summary to report more failures than actually occurred, and preventing nested extraction (\`failed === 0\` guard)
- **Fix:** Moved the abort error check before \`failed += 1\` so aborted archives are re-thrown without incrementing the failure count

#### Important: \`requestReconnect()\` — \`consecutiveReconnects\` inflated by parallel downloads
- When multiple parallel downloads encountered HTTP 429/503 simultaneously, each one called \`requestReconnect()\`, incrementing \`consecutiveReconnects\` once per download. With 10 parallel downloads, a single rate-limit event could immediately push the backoff multiplier to its maximum (5x), causing unnecessarily long reconnect waits
- **Fix:** Only increment \`consecutiveReconnects\` when not already inside an active reconnect window (\`reconnectUntil <= now\`). Subsequent calls during the same window still trigger the abort/reconnect flow but don't inflate the backoff

#### Important: Stale \`snapshot\` closure in \`onAddLinks\`/\`onImportDlc\`/\`onDrop\`
- The \`existingIds\` baseline (used to identify newly added packages for auto-collapse) was computed from the stale \`snapshot\` variable captured at render time, not the current ref. If the user added links in quick succession, previously added packages could also be collapsed because \`existingIds\` didn't include them yet
- **Fix:** Changed all three functions to read from \`snapshotRef.current.session.packages\` instead of \`snapshot.session.packages\`

#### Important: \`downloadToFile()\` HTTP 429/503 bypasses inner retry loop
- On receiving HTTP 429 (Too Many Requests) or 503 (Service Unavailable), the download handler immediately called \`requestReconnect()\` and threw, even on the first attempt. This bypassed the inner retry loop entirely, escalating a potentially transient error into a full reconnect cycle that aborted all active downloads
- **Fix:** Moved the reconnect escalation after the inner retry loop. The download now retries normally first (with backoff), and only triggers a full reconnect if all retry attempts are exhausted with a 429/503

#### Important: \`PackageCard\` memo comparator missing \`onlineStatus\`
- The custom \`memo\` comparator for \`PackageCard\` checked item fields like \`status\`, \`fileName\`, \`progressPercent\`, \`speedBps\`, etc., but did not include \`onlineStatus\`. When a Rapidgator link's online status changed (online/offline/checking), the status dot indicator would not update until some other prop triggered a re-render
- **Fix:** Added \`a.onlineStatus !== b.onlineStatus\` to the item comparison in the memo comparator

#### Important: \`noExtractorEncountered\` throws \`"aborted:extract"\` — wrong error classification
- When no extractor was available (e.g. 7z/WinRAR not installed), subsequent archive processing threw \`new Error("aborted:extract")\`. This was caught by \`isExtractAbortError()\` and treated identically to user cancellation, masking the real problem (missing extractor) in logs and error reporting
- **Fix:** Changed the error message to \`"noextractor:skipped"\` and updated \`isExtractAbortError()\` to recognize it, so it's still re-thrown (not counted as a normal failure) but carries the correct classification

#### Minor: \`formatDateTime(0)\` displays "01.01.1970"
- The \`formatDateTime\` utility formatted timestamp \`0\` as \`"01.01.1970 - 01:00"\` instead of an empty string. Timestamps of 0 are used as "not set" in various places (e.g. \`createdAt\` before initialization), resulting in nonsensical 1970 dates in the UI
- **Fix:** Added an early return of \`""\` when \`ts\` is falsy (0, null, undefined)

#### Minor: \`cachedJvmLayout = null\` permanently prevents JVM extractor discovery
- When the JVM extractor layout resolution failed (Java not found), the result \`null\` was cached permanently. If the user installed Java after app startup, the JVM extractor would never be discovered until the app was restarted
- **Fix:** Added a 5-minute TTL for \`null\` cache entries. After the TTL expires, the next extraction attempt re-probes for Java

### Files Changed
- \`src/main/extractor.ts\` — Abort check before \`failed\` increment; \`noExtractorEncountered\` distinct error message; JVM layout null cache TTL
- \`src/main/download-manager.ts\` — \`requestReconnect\` single-increment guard; HTTP 429/503 inner retry before reconnect escalation
- \`src/renderer/App.tsx\` — Stale snapshot closure fix; PackageCard memo \`onlineStatus\` check; \`formatDateTime(0)\` guard
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
    { file: "Real-Debrid-Downloader-Setup-1.6.20.exe", name: "Real-Debrid-Downloader-Setup-1.6.20.exe" },
    { file: "Real-Debrid-Downloader 1.6.20.exe", name: "Real-Debrid-Downloader-1.6.20.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.20.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.20.exe.blockmap" },
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
