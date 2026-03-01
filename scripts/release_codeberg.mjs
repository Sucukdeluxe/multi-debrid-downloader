import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const NPM_EXECUTABLE = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit"
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? String(result.stderr).trim() : "";
    const stdout = result.stdout ? String(result.stdout).trim() : "";
    const details = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${command} ${args.join(" ")}${details ? `\n${details}` : ""}`);
  }
  return options.capture ? String(result.stdout || "") : "";
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(stderr || `Command failed: ${command} ${args.join(" ")}`);
  }
  return String(result.stdout || "").trim();
}

function runWithInput(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(stderr || `Command failed: ${command} ${args.join(" ")}`);
  }
  return String(result.stdout || "");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  const dryRun = args.includes("--dry-run");
  const cleaned = args.filter((arg) => arg !== "--dry-run");
  const version = cleaned[0] || "";
  const notes = cleaned.slice(1).join(" ").trim();
  return { help: false, dryRun, version, notes };
}

function parseCodebergRemote(url) {
  const raw = String(url || "").trim();
  const httpsMatch = raw.match(/^https?:\/\/(?:www\.)?codeberg\.org\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = raw.match(/^git@codeberg\.org:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  throw new Error(`Cannot parse Codeberg remote URL: ${raw}`);
}

function getCodebergRepo() {
  const remotes = ["codeberg", "origin"];
  for (const remote of remotes) {
    try {
      const remoteUrl = runCapture("git", ["remote", "get-url", remote]);
      if (/codeberg\.org/i.test(remoteUrl)) {
        const parsed = parseCodebergRemote(remoteUrl);
        return { remote, ...parsed };
      }
    } catch {
      // try next remote
    }
  }
  throw new Error("No Codeberg remote found. Add one with: git remote add codeberg https://codeberg.org/<owner>/<repo>.git");
}

function getCodebergAuthHeader() {
  const credentialText = runWithInput("git", ["credential", "fill"], "protocol=https\nhost=codeberg.org\n\n");
  const map = new Map();
  for (const line of credentialText.split(/\r?\n/)) {
    if (!line.includes("=")) {
      continue;
    }
    const [key, value] = line.split("=", 2);
    map.set(key, value);
  }
  const username = map.get("username") || "";
  const password = map.get("password") || "";
  if (!username || !password) {
    throw new Error("Missing Codeberg credentials in git credential helper");
  }
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function apiRequest(method, url, authHeader, body, contentType = "application/json") {
  const headers = {
    Accept: "application/json",
    Authorization: authHeader
  };
  if (body !== undefined) {
    headers["Content-Type"] = contentType;
  }
  const response = await fetch(url, {
    method,
    headers,
    body
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

function ensureVersionString(version) {
  const trimmed = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new Error("Invalid version format. Expected e.g. 1.4.42");
  }
  return trimmed;
}

function updatePackageVersion(rootDir, version) {
  const packagePath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (String(packageJson.version || "") === version) {
    throw new Error(`package.json is already at version ${version}`);
  }
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function ensureAssetsExist(rootDir, version) {
  const releaseDir = path.join(rootDir, "release");
  const files = [
    `Real-Debrid-Downloader Setup ${version}.exe`,
    `Real-Debrid-Downloader ${version}.exe`,
    "latest.yml",
    `Real-Debrid-Downloader Setup ${version}.exe.blockmap`
  ];
  for (const fileName of files) {
    const fullPath = path.join(releaseDir, fileName);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing release artifact: ${fullPath}`);
    }
  }
  return { releaseDir, files };
}

function ensureNoTrackedChanges() {
  const output = runCapture("git", ["status", "--porcelain"]);
  const lines = output.split(/\r?\n/).filter(Boolean);
  const tracked = lines.filter((line) => !line.startsWith("?? "));
  if (tracked.length > 0) {
    throw new Error(`Working tree has tracked changes:\n${tracked.join("\n")}`);
  }
}

function ensureTagMissing(tag) {
  const result = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
    cwd: process.cwd(),
    stdio: "ignore"
  });
  if (result.status === 0) {
    throw new Error(`Tag already exists: ${tag}`);
  }
}

async function createOrGetRelease(owner, repo, tag, authHeader, notes) {
  const baseApi = `https://codeberg.org/api/v1/repos/${owner}/${repo}`;
  const byTag = await apiRequest("GET", `${baseApi}/releases/tags/${encodeURIComponent(tag)}`, authHeader);
  if (byTag.ok) {
    return byTag.body;
  }
  const payload = {
    tag_name: tag,
    target_commitish: "main",
    name: tag,
    body: notes || `Release ${tag}`,
    draft: false,
    prerelease: false
  };
  const created = await apiRequest("POST", `${baseApi}/releases`, authHeader, JSON.stringify(payload));
  if (!created.ok) {
    throw new Error(`Failed to create release (${created.status}): ${JSON.stringify(created.body)}`);
  }
  return created.body;
}

async function uploadReleaseAssets(owner, repo, releaseId, authHeader, releaseDir, files) {
  const baseApi = `https://codeberg.org/api/v1/repos/${owner}/${repo}`;
  for (const fileName of files) {
    const filePath = path.join(releaseDir, fileName);
    const fileData = fs.readFileSync(filePath);
    const uploadUrl = `${baseApi}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;
    const response = await apiRequest("POST", uploadUrl, authHeader, fileData, "application/octet-stream");
    if (response.ok) {
      process.stdout.write(`Uploaded: ${fileName}\n`);
      continue;
    }
    if (response.status === 409 || response.status === 422) {
      process.stdout.write(`Skipped existing asset: ${fileName}\n`);
      continue;
    }
    throw new Error(`Asset upload failed for ${fileName} (${response.status}): ${JSON.stringify(response.body)}`);
  }
}

async function main() {
  const rootDir = process.cwd();
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write("Usage: npm run release:codeberg -- <version> [release notes] [--dry-run]\n");
    process.stdout.write("Example: npm run release:codeberg -- 1.4.42 \"- Small fixes\"\n");
    return;
  }

  const version = ensureVersionString(args.version);
  const tag = `v${version}`;
  const releaseNotes = args.notes || `- Release ${tag}`;
  const { remote, owner, repo } = getCodebergRepo();

  ensureNoTrackedChanges();
  ensureTagMissing(tag);
  updatePackageVersion(rootDir, version);

  process.stdout.write(`Building release artifacts for ${tag}...\n`);
  run(NPM_EXECUTABLE, ["run", "release:win"]);
  const assets = ensureAssetsExist(rootDir, version);

  if (args.dryRun) {
    process.stdout.write(`Dry run complete. Assets exist for ${tag}.\n`);
    return;
  }

  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `Release ${tag}`]);
  run("git", ["push", remote, "main"]);
  run("git", ["tag", tag]);
  run("git", ["push", remote, tag]);

  const authHeader = getCodebergAuthHeader();
  const baseRepoApi = `https://codeberg.org/api/v1/repos/${owner}/${repo}`;
  const patchReleaseEnabled = await apiRequest("PATCH", baseRepoApi, authHeader, JSON.stringify({ has_releases: true }));
  if (!patchReleaseEnabled.ok) {
    throw new Error(`Failed to enable releases (${patchReleaseEnabled.status}): ${JSON.stringify(patchReleaseEnabled.body)}`);
  }

  const release = await createOrGetRelease(owner, repo, tag, authHeader, releaseNotes);
  await uploadReleaseAssets(owner, repo, release.id, authHeader, assets.releaseDir, assets.files);

  process.stdout.write(`Release published: ${release.html_url}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
