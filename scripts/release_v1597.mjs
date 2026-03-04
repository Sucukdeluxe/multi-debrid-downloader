import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const TOKEN = "36034f878a07e8705c577a838e5186b3d6010d03";
const OWNER = "Sucukdeluxe";
const REPO = "real-debrid-downloader";
const TAG = "v1.5.97";

const RELEASE_BODY = `## What's Changed in v1.5.97

### Bug Fixes
- **Fix "Ausstehend" / "Warten auf Parts" label flicker during hybrid extraction**: Previously, every hybrid extraction run would reset ALL non-extracted completed items to either "Entpacken - Ausstehend" or "Entpacken - Warten auf Parts", causing visible flickering between status labels. Now only items whose archives are actually in the current \`readyArchives\` set get "Ausstehend"; all other items correctly show "Warten auf Parts" until their archive is genuinely ready for extraction. This eliminates the misleading "Ausstehend" label on items that aren't being extracted in the current run.
`;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "codeberg.org",
      path: `/api/v1${urlPath}`,
      method,
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${data}`));
        else resolve(JSON.parse(data || "{}"));
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function uploadAsset(releaseId, filePath, name) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath);
    const opts = {
      hostname: "codeberg.org",
      path: `/api/v1/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/octet-stream", "Content-Length": fileBuffer.length },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${data}`));
        else resolve(JSON.parse(data || "{}"));
      });
    });
    req.on("error", reject);
    req.write(fileBuffer);
    req.end();
  });
}

async function main() {
  console.log("Creating release...");
  const release = await request("POST", `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG, name: TAG, body: RELEASE_BODY, draft: false, prerelease: false,
  });
  console.log(`Release created: id=${release.id}`);
  const releaseDir = path.resolve("release");
  const assets = [
    { file: `Real-Debrid-Downloader-Setup-1.5.97.exe`, name: `Real-Debrid-Downloader-Setup-1.5.97.exe` },
    { file: `Real-Debrid-Downloader 1.5.97.exe`, name: `Real-Debrid-Downloader-1.5.97.exe` },
    { file: `latest.yml`, name: `latest.yml` },
    { file: `Real-Debrid-Downloader Setup 1.5.97.exe.blockmap`, name: `Real-Debrid-Downloader-Setup-1.5.97.exe.blockmap` },
  ];
  for (const asset of assets) {
    const filePath = path.join(releaseDir, asset.file);
    if (!fs.existsSync(filePath)) { console.warn(`SKIP: ${asset.file}`); continue; }
    console.log(`Uploading ${asset.name} (${(fs.statSync(filePath).size / 1048576).toFixed(1)} MB)...`);
    await uploadAsset(release.id, filePath, asset.name);
    console.log(`  done`);
  }
  console.log("Done!");
}
main().catch((err) => { console.error(err); process.exit(1); });
