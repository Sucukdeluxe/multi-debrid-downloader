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
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000
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

function parseRemoteUrl(url) {
  const raw = String(url || "").trim();
  const httpsMatch = raw.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] };
  }
  const sshMatch = raw.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };
  }
  const sshAltMatch = raw.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshAltMatch) {
    return { host: sshAltMatch[1], owner: sshAltMatch[2], repo: sshAltMatch[3] };
  }
  throw new Error(`Cannot parse remote URL: ${raw}`);
}

function normalizeBaseUrl(url) {
  const raw = String(url || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return "";
  }
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("GITEA_BASE_URL must start with http:// or https://");
  }
  return raw;
}

function getGiteaRepo() {
  const forcedRemote = String(process.env.GITEA_REMOTE || process.env.FORGEJO_REMOTE || "").trim();
  const remotes = forcedRemote
    ? [forcedRemote]
    : ["gitea", "forgejo", "origin", "github-new", "codeberg"];

  const preferredBase = normalizeBaseUrl(process.env.GITEA_BASE_URL || process.env.FORGEJO_BASE_URL || "https://git.24-music.de");

  const preferredProtocol = preferredBase ? new URL(preferredBase).protocol : "https:";

  for (const remote of remotes) {
    try {
      const remoteUrl = runCapture("git", ["remote", "get-url", remote]);
      const parsed = parseRemoteUrl(remoteUrl);
      const remoteBase = `https://${parsed.host}`.toLowerCase();
      if (preferredBase && remoteBase !== preferredBase.toLowerCase().replace(/^http:/, "https:")) {
        continue;
      }
      return { remote, ...parsed, baseUrl: `${preferredProtocol}//${parsed.host}` };
    } catch {
      // try next remote
    }
  }

  if (preferredBase) {
    throw new Error(
      `No remote found for ${preferredBase}. Add one with: git remote add gitea ${preferredBase}/<owner>/<repo>.git`
    );
  }

  throw new Error("No suitable remote found. Set GITEA_REMOTE or GITEA_BASE_URL.");
}

function getAuthHeader(host) {
  const explicitToken = String(process.env.GITEA_TOKEN || process.env.FORGEJO_TOKEN || "").trim();
  if (explicitToken) {
    return `token ${explicitToken}`;
  }

  const credentialText = runWithInput("git", ["credential", "fill"], `protocol=https\nhost=${host}\n\n`);
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
    throw new Error(
      `Missing credentials for ${host}. Set GITEA_TOKEN or store credentials for this host in git credential helper.`
    );
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
    process.stdout.write(`package.json is already at version ${version}, skipping update.\n`);
    return;
  }
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function patchLatestYml(releaseDir, version) {
  const ymlPath = path.join(releaseDir, "latest.yml");
  let content = fs.readFileSync(ymlPath, "utf8");
  const setupName = `Real-Debrid-Downloader Setup ${version}.exe`;
  const dashedName = `Real-Debrid-Downloader-Setup-${version}.exe`;
  if (content.includes(dashedName)) {
    content = content.split(dashedName).join(setupName);
    fs.writeFileSync(ymlPath, content, "utf8");
    process.stdout.write(`Patched latest.yml: replaced "${dashedName}" with "${setupName}"\n`);
  }
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
  patchLatestYml(releaseDir, version);
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

async function createOrGetRelease(baseApi, tag, authHeader, notes) {
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

async function uploadReleaseAssets(baseApi, releaseId, authHeader, releaseDir, files) {
  for (const fileName of files) {
    const filePath = path.join(releaseDir, fileName);
    const fileSize = fs.statSync(filePath).size;
    const uploadUrl = `${baseApi}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;

    // Stream large files instead of loading them entirely into memory
    const fileStream = fs.createReadStream(filePath);
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(fileSize)
      },
      body: fileStream,
      duplex: "half"
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (response.ok) {
      process.stdout.write(`Uploaded: ${fileName}\n`);
      continue;
    }
    if (response.status === 409 || response.status === 422) {
      process.stdout.write(`Skipped existing asset: ${fileName}\n`);
      continue;
    }
    throw new Error(`Asset upload failed for ${fileName} (${response.status}): ${JSON.stringify(parsed)}`);
  }
}

async function main() {
  const rootDir = process.cwd();
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write("Usage: npm run release:gitea -- <version> [release notes] [--dry-run]\n");
    process.stdout.write("Env: GITEA_BASE_URL, GITEA_REMOTE, GITEA_TOKEN\n");
    process.stdout.write("Compatibility envs still supported: FORGEJO_BASE_URL, FORGEJO_REMOTE, FORGEJO_TOKEN\n");
    process.stdout.write("Example: npm run release:gitea -- 1.6.31 \"- Bugfixes\"\n");
    return;
  }

  const version = ensureVersionString(args.version);
  const tag = `v${version}`;
  const releaseNotes = args.notes || `- Release ${tag}`;
  const repo = getGiteaRepo();

  ensureNoTrackedChanges();
  ensureTagMissing(tag);

  if (args.dryRun) {
    process.stdout.write(`Dry run: would release ${tag}. No changes made.\n`);
    return;
  }

  updatePackageVersion(rootDir, version);

  process.stdout.write(`Building release artifacts for ${tag}...\n`);
  run(NPM_EXECUTABLE, ["run", "release:win"]);
  const assets = ensureAssetsExist(rootDir, version);

  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `Release ${tag}`]);
  run("git", ["push", repo.remote, "main"]);
  run("git", ["tag", tag]);
  run("git", ["push", repo.remote, tag]);

  const authHeader = getAuthHeader(repo.host);
  const baseApi = `${repo.baseUrl}/api/v1/repos/${repo.owner}/${repo.repo}`;
  const release = await createOrGetRelease(baseApi, tag, authHeader, releaseNotes);
  await uploadReleaseAssets(baseApi, release.id, authHeader, assets.releaseDir, assets.files);

  process.stdout.write(`Release published: ${release.html_url || `${repo.baseUrl}/${repo.owner}/${repo.repo}/releases/tag/${tag}`}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
