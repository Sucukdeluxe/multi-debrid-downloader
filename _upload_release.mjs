import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const credResult = spawnSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=codeberg.org\n\n",
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"]
});
const creds = new Map();
for (const line of credResult.stdout.split(/\r?\n/)) {
  if (line.includes("=")) {
    const [k, v] = line.split("=", 2);
    creds.set(k, v);
  }
}
const auth = "Basic " + Buffer.from(creds.get("username") + ":" + creds.get("password")).toString("base64");
const owner = "Sucukdeluxe";
const repo = "real-debrid-downloader";
const tag = "v1.5.27";
const baseApi = `https://codeberg.org/api/v1/repos/${owner}/${repo}`;

async function main() {
  await fetch(baseApi, {
    method: "PATCH",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ has_releases: true })
  });

  const createRes = await fetch(`${baseApi}/releases`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: "main",
      name: tag,
      body: "- Increase column spacing for Fortschritt/Größe/Geladen",
      draft: false,
      prerelease: false
    })
  });
  const release = await createRes.json();
  if (!createRes.ok) {
    console.error("Create failed:", JSON.stringify(release));
    process.exit(1);
  }
  console.log("Release created:", release.id);

  const files = [
    "Real-Debrid-Downloader Setup 1.5.27.exe",
    "Real-Debrid-Downloader 1.5.27.exe",
    "latest.yml",
    "Real-Debrid-Downloader Setup 1.5.27.exe.blockmap"
  ];
  for (const f of files) {
    const filePath = path.join("release", f);
    const data = fs.readFileSync(filePath);
    const uploadUrl = `${baseApi}/releases/${release.id}/assets?name=${encodeURIComponent(f)}`;
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/octet-stream" },
      body: data
    });
    if (res.ok) {
      console.log("Uploaded:", f);
    } else if (res.status === 409 || res.status === 422) {
      console.log("Skipped existing:", f);
    } else {
      console.error("Upload failed for", f, ":", res.status);
    }
  }
  console.log(`Done! https://codeberg.org/${owner}/${repo}/releases/tag/${tag}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
