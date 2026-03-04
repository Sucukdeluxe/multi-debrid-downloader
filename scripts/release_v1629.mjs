import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.6.29";

const BODY = `## What's Changed in v1.6.29

### Bug Fixes (Deep Code Review — Round 5)

This release fixes 10 bugs found through an intensive 10-agent parallel code review covering every line of the codebase.

---

### Critical (1 fix — regression from v1.6.28)

#### \`finishRun()\` zeroed \`runStartedAt\` before calculating run duration
- The v1.6.28 fix that added \`this.session.runStartedAt = 0\` placed the reset **before** the code that reads \`runStartedAt\` to calculate session duration. This made \`runStartedAt > 0\` always false, so \`duration\` defaulted to 1 second. The run summary then showed absurdly high average speeds (total bytes / 1 second).
- **Fix:** Save \`runStartedAt\` to a local variable before zeroing, then use the local variable for the duration calculation.

---

### Important (2 fixes)

#### \`importBackup\` restored session overwritten by \`prepareForShutdown()\`
- When a user restored a backup via import, \`saveSession()\` correctly wrote the restored session to disk. However, when the app quit (as instructed by "Bitte App neustarten"), \`prepareForShutdown()\` saved the **old in-memory session** back to disk, overwriting the restored backup. The restore appeared to succeed but was silently lost on restart.
- **Fix:** Added a \`skipShutdownPersist\` flag to \`DownloadManager\`. After \`importBackup\` saves the restored session, it sets this flag to \`true\`. \`prepareForShutdown()\` checks the flag and skips the session/settings write when set.

#### \`normalizeLoadedSessionTransientFields()\` missing package-level and session-level reset
- On startup, item statuses like "downloading" and "paused" were correctly reset to "queued", but **package statuses** in the same active states were left unchanged. Similarly, \`session.running\` and \`session.paused\` were not cleared. After a crash during an active download, packages could appear stuck in "downloading" status on restart, and the session could appear to be "running" with no active tasks.
- **Fix:** Added package status reset (active statuses → "queued") and \`session.running = false\` / \`session.paused = false\` to the normalization function.

---

### Medium (7 fixes)

#### Stale \`itemContributedBytes\` / \`reservedTargetPaths\` / \`claimedTargetPathByItem\` across runs
- When the user manually stopped a download run, \`stop()\` did not call \`finishRun()\`, so \`itemContributedBytes\`, \`reservedTargetPaths\`, and \`claimedTargetPathByItem\` retained stale values from the previous run. On the next \`start()\` or \`resume()\`, these maps were not cleared. This caused: (1) inflated byte contributions subtracted from the reset \`totalDownloadedBytes\`, corrupting speed/progress calculations, (2) orphan path reservations preventing new items from claiming the same filenames, (3) stale target path claims causing unnecessary filename suffixing (\`file (1).rar\`).
- **Fix:** Added \`.clear()\` calls for all three maps in both \`startSelected()\` and the normal \`resume()\` path, matching \`finishRun()\`'s cleanup.

#### Hybrid extraction abort leaves stale progress labels on items
- When hybrid extraction was aborted (\`"aborted:extract"\`), the catch handler returned immediately without resetting item labels. Items could be left permanently showing mid-progress labels like \`"Entpacken 47% - movie.part01.rar - 12s"\` or \`"Passwort knacken: 30% (3/10) - archive.rar"\`. If the session was stopped or paused after the abort, these stale labels persisted in the UI and in the saved session.
- **Fix:** Added label cleanup loop before the return in the abort handler, resetting extraction/password labels to \`"Entpacken abgebrochen (wird fortgesetzt)"\`, consistent with the full extraction abort handler.

#### RAR5 multipart \`.rev\` recovery volumes not cleaned up after extraction
- \`collectArchiveCleanupTargets()\` matched RAR5 multipart data files (\`movie.part01.rar\`, \`movie.part02.rar\`) and a single legacy recovery file (\`movie.rev\`), but NOT RAR5 multipart recovery volumes (\`movie.part01.rev\`, \`movie.part02.rev\`). After extraction with cleanup enabled, recovery volumes were left on disk, wasting space.
- **Fix:** Added regex \`^prefix\\.part\\d+\\.rev$\` to the multipart RAR cleanup targets.

#### \`findReadyArchiveSets\` missed queued items without \`targetPath\` in pending check
- The archive-readiness check built \`pendingPaths\` from items with \`targetPath\` set, but items that hadn't started downloading yet (no \`targetPath\`, only \`fileName\`) were excluded. If all on-disk archive parts were completed but additional parts were still queued (never started), the archive could be prematurely marked as ready for extraction, leading to incomplete extraction.
- **Fix:** Also add \`path.join(pkg.outputDir, item.fileName)\` to \`pendingPaths\` for items without \`targetPath\`.

#### \`buildUniqueFlattenTargetPath\` unbounded loop
- The MKV library flatten function used an unbounded \`while(true)\` loop to find a unique filename, incrementing a suffix counter. In pathological cases (e.g., thousands of existing files or reserved names), this could run indefinitely, blocking the main process.
- **Fix:** Added a \`MAX_ATTEMPTS = 10000\` bound with a timestamp-based fallback filename to guarantee termination.

#### Redundant regex conditions in hybrid extraction error handler
- The error handler for hybrid extraction checked \`entry.fullStatus === "Entpacken - Ausstehend"\` and \`"Entpacken - Warten auf Parts"\` as separate conditions alongside the regex \`/^Entpacken\\b/i\`, which already matches both strings. The redundant conditions obscured the intent and added confusion.
- **Fix:** Removed the redundant explicit string comparisons, keeping only the regex checks.

---

### Files Changed
- \`src/main/download-manager.ts\` — finishRun runStartedAt local var; start/resume clear itemContributedBytes + reservedTargetPaths + claimedTargetPathByItem; hybrid abort label cleanup; findReadyArchiveSets pendingPaths fileName fallback; buildUniqueFlattenTargetPath loop bound; hybrid error handler simplify redundant regex
- \`src/main/app-controller.ts\` — importBackup sets skipShutdownPersist flag
- \`src/main/storage.ts\` — normalizeLoadedSessionTransientFields resets package statuses and session.running/paused
- \`src/main/extractor.ts\` — RAR5 multipart .rev recovery volume cleanup
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
    { file: "Real-Debrid-Downloader-Setup-1.6.29.exe", name: "Real-Debrid-Downloader-Setup-1.6.29.exe" },
    { file: "Real-Debrid-Downloader 1.6.29.exe", name: "Real-Debrid-Downloader-1.6.29.exe" },
    { file: "latest.yml", name: "latest.yml" },
    { file: "Real-Debrid-Downloader Setup 1.6.29.exe.blockmap", name: "Real-Debrid-Downloader-Setup-1.6.29.exe.blockmap" },
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
