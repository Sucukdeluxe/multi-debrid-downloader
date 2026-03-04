import fs from "node:fs";
import path from "node:path";

const TAG = "v1.6.30";
const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const API = `https://codeberg.org/api/v1/repos/${OWNER}/${REPO}`;

const RELEASE_DIR = path.resolve("release");

const BODY = `## What's Changed in v1.6.30

### Bug Fixes (Round 5 + Round 6 Deep Code Review — 19 fixes total)

#### Critical / High Priority
- **\`removeItem\` double-decrements \`itemCount\`**: When removing an item whose package had no remaining items, the item count was decremented both by \`removePackageFromSession\` (which deletes all items) and again by the caller. Fixed with a \`removedByPackageCleanup\` guard.
- **\`startItems\` missing map clears**: \`itemContributedBytes\`, \`reservedTargetPaths\`, and \`claimedTargetPathByItem\` were not cleared when starting individual items, causing stale data from previous runs to leak through.
- **\`start()\` race condition**: Two concurrent \`start()\` calls could both pass the \`running\` guard due to an \`await\` before \`running = true\` was set. Fixed by setting \`running = true\` before the first async operation.
- **Item-Recovery race condition**: In \`handlePackagePostProcessing\`, the scheduler could start an item during the \`await fs.promises.stat()\` call, but the recovery code would then overwrite the active download status with "completed". Added a post-await status + activeTasks re-check.
- **File-handle leak on Windows**: \`stream.destroy()\` was skipped when \`stream.end()\` threw an error and \`bodyError\` was null, because the \`throw\` exited the finally block before reaching the destroy call. Moved \`stream.destroy()\` into the catch block before the re-throw.

#### Medium Priority
- **\`clearAll\` doesn't clear \`providerFailures\`**: Provider failure tracking persisted across clear-all operations, causing unnecessary fallback to alternate providers on the next run.
- **\`skipItems\` missing \`releaseTargetPath\`**: Skipped items retained their reserved target paths, blocking other items from using those file paths.
- **\`skipItems\` extraction trigger ignores failed items**: The post-skip extraction check only verified no pending items existed, but didn't check for failed items, potentially starting extraction with an incomplete download set.
- **Double "Error:" prefix**: \`compactErrorText()\` wraps \`String(error)\` which adds "Error: " for Error objects. The final \`throw new Error(lastError)\` in RealDebrid, AllDebrid, and MegaDebrid clients then added a second "Error: " prefix. Fixed with \`.replace(/^Error:\\s*/i, "")\`.
- **Zip-bomb false positive on size=0 headers**: Archive entries with \`uncompressedSize === 0\` in the header (common for streaming-compressed files) triggered the zip-bomb heuristic. Fixed to only check when \`maxDeclaredSize > 0\`.
- **\`directoryHasAnyFiles\` treats system files as content**: Files like \`desktop.ini\`, \`Thumbs.db\`, \`.DS_Store\` etc. were counted as real content, causing false "directory not empty" conflicts. Now filters with \`isIgnorableEmptyDirFileName\`.
- **\`setBool\` in Delete-Confirm permanently sets dirty flag**: The generic \`setBool\` helper marked the settings draft as dirty even when only updating the "don't ask again" checkbox, triggering unnecessary save-on-close prompts. Replaced with a direct \`setSettingsDraft\` call.
- **\`item.url\` missing in PackageCard memo comparison**: URL changes (e.g. after unrestrict retry) didn't trigger re-renders because \`item.url\` wasn't in the equality check.
- **Column sort + drag-drop reorder lacking optimistic updates**: \`movePackage\`, \`reorderPackagesByDrop\`, and the column sort handler sent the IPC call but didn't update local state until the next snapshot from main, causing visible lag. Added optimistic state updates with rollback on error.
- **\`updatedAt\` unconditionally set for already-extracted items**: Items with an "Entpackt - Done" label had their \`updatedAt\` bumped on every extraction error/success pass, causing unnecessary re-renders. Added guard to skip already-extracted items.
- **\`normalizeSessionStatuses\` empty fullStatus**: Completed items with an empty \`fullStatus\` stayed blank instead of getting the correct "Entpacken - Ausstehend" or "Fertig" label.
- **\`prepareForShutdown\` mislabels pending items**: Items with "Entpacken - Ausstehend" or "Entpacken - Warten auf Parts" were relabeled to "Entpacken abgebrochen (wird fortgesetzt)" even though they were never actively extracting. Now only relabels items with active extraction status.

### Test Results
- 352 tests passing across 15 test files
`;

async function main() {
  // Create release
  console.log("Creating release...");
  const createRes = await fetch(`${API}/releases`, {
    method: "POST",
    headers: {
      Authorization: `token ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag_name: TAG,
      name: TAG,
      body: BODY,
      draft: false,
      prerelease: false,
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Create release failed: ${createRes.status} ${text}`);
  }
  const release = await createRes.json();
  console.log(`Release created: ${release.html_url}`);

  // Upload assets
  const assets = [
    { file: "Real-Debrid-Downloader-Setup-1.6.30.exe", label: "Setup Installer" },
    { file: "Real-Debrid-Downloader 1.6.30.exe", label: "Portable" },
    { file: "latest.yml", label: "Auto-Update Manifest" },
    { file: "Real-Debrid-Downloader Setup 1.6.30.exe.blockmap", label: "Blockmap" },
  ];

  for (const asset of assets) {
    const filePath = path.join(RELEASE_DIR, asset.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`SKIP (not found): ${asset.file}`);
      continue;
    }
    const data = fs.readFileSync(filePath);
    console.log(`Uploading ${asset.file} (${(data.length / 1024 / 1024).toFixed(1)} MB)...`);
    const uploadRes = await fetch(
      `${API}/releases/${release.id}/assets?name=${encodeURIComponent(asset.file)}`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${TOKEN}`,
          "Content-Type": "application/octet-stream",
        },
        body: data,
      }
    );
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      console.error(`Upload failed for ${asset.file}: ${uploadRes.status} ${text}`);
    } else {
      console.log(`  ✓ ${asset.file}`);
    }
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
