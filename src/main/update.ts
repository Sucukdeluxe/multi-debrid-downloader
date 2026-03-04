import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { APP_VERSION, DEFAULT_UPDATE_REPO } from "./constants";
import { UpdateCheckResult, UpdateInstallProgress, UpdateInstallResult } from "../shared/types";
import { compactErrorText, humanSize } from "./utils";
import { logger } from "./logger";

const RELEASE_FETCH_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 30000;
const DOWNLOAD_BODY_IDLE_TIMEOUT_MS = 45000;
const RETRIES_PER_CANDIDATE = 3;
const RETRY_DELAY_MS = 1500;
const UPDATE_USER_AGENT = `RD-Node-Downloader/${APP_VERSION}`;
type UpdateSource = {
  name: string;
  webBase: string;
  apiBase: string;
};

const UPDATE_SOURCES: UpdateSource[] = [
  {
    name: "git24",
    webBase: "https://git.24-music.de",
    apiBase: "https://git.24-music.de/api/v1"
  },
  {
    name: "codeberg",
    webBase: "https://codeberg.org",
    apiBase: "https://codeberg.org/api/v1"
  },
  {
    name: "github",
    webBase: "https://github.com",
    apiBase: "https://api.github.com"
  }
];
const PRIMARY_UPDATE_SOURCE = UPDATE_SOURCES[0];
const UPDATE_WEB_BASE = PRIMARY_UPDATE_SOURCE.webBase;
const UPDATE_API_BASE = PRIMARY_UPDATE_SOURCE.apiBase;

let activeUpdateAbortController: AbortController | null = null;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest: string;
};

type UpdateProgressCallback = (progress: UpdateInstallProgress) => void;

function safeEmitProgress(onProgress: UpdateProgressCallback | undefined, progress: UpdateInstallProgress): void {
  if (!onProgress) {
    return;
  }
  try {
    onProgress(progress);
  } catch {
    // ignore renderer callback errors
  }
}

export function normalizeUpdateRepo(repo: string): string {
  const raw = String(repo || "").trim();
  if (!raw) {
    return DEFAULT_UPDATE_REPO;
  }

  const isValidRepoPart = (value: string): boolean => {
    const part = String(value || "").trim();
    if (!part || part === "." || part === "..") {
      return false;
    }
    if (part.includes("..")) {
      return false;
    }
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part);
  };

  const normalizeParts = (input: string): string => {
    const cleaned = input
      .replace(/^https?:\/\/(?:www\.)?(?:codeberg\.org|github\.com|git\.24-music\.de)\//i, "")
      .replace(/^(?:www\.)?(?:codeberg\.org|github\.com|git\.24-music\.de)\//i, "")
      .replace(/^git@(?:codeberg\.org|github\.com|git\.24-music\.de):/i, "")
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "");
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repository = parts[1];
      if (isValidRepoPart(owner) && isValidRepoPart(repository)) {
        return `${owner}/${repository}`;
      }
    }
    return "";
  };

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      host === "codeberg.org"
      || host === "www.codeberg.org"
      || host === "github.com"
      || host === "www.github.com"
      || host === "git.24-music.de"
    ) {
      const normalized = normalizeParts(url.pathname);
      if (normalized) {
        return normalized;
      }
    }
  } catch {
    // plain owner/repo value
  }

  const normalized = normalizeParts(raw);
  return normalized || DEFAULT_UPDATE_REPO;
}

function timeoutController(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`timeout:${ms}`));
  }, ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) {
    return primary;
  }
  return AbortSignal.any([primary, secondary]);
}

async function readJsonWithTimeout(response: Response, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      reject(new Error(`timeout:${timeoutMs}`));
    }, timeoutMs);
  });

  try {
    const payload = await Promise.race([
      response.json().catch(() => null) as Promise<unknown>,
      timeoutPromise
    ]);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as Record<string, unknown>;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function readTextWithTimeout(response: Response, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      reject(new Error(`timeout:${timeoutMs}`));
    }, timeoutMs);
  });

  try {
    const payload = await Promise.race([
      response.text(),
      timeoutPromise
    ]);
    return String(payload || "");
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getDownloadBodyIdleTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_UPDATE_BODY_IDLE_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 1000 && fromEnv <= 30 * 60 * 1000) {
    return Math.floor(fromEnv);
  }
  return DOWNLOAD_BODY_IDLE_TIMEOUT_MS;
}

export function parseVersionParts(version: string): number[] {
  const cleaned = version.replace(/^v/i, "").trim();
  return cleaned.split(".").map((part) => Number(part.replace(/[^0-9].*$/, "") || "0"));
}

export function isRemoteNewer(currentVersion: string, latestVersion: string): boolean {
  const current = parseVersionParts(currentVersion);
  const latest = parseVersionParts(latestVersion);
  const maxLen = Math.max(current.length, latest.length);
  for (let i = 0; i < maxLen; i += 1) {
    const a = current[i] ?? 0;
    const b = latest[i] ?? 0;
    if (b > a) {
      return true;
    }
    if (b < a) {
      return false;
    }
  }
  return false;
}

function createFallbackResult(repo: string): UpdateCheckResult {
  const safeRepo = normalizeUpdateRepo(repo);
  return {
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    latestTag: `v${APP_VERSION}`,
    releaseUrl: `${UPDATE_WEB_BASE}/${safeRepo}/releases/latest`
  };
}

function readReleaseAssets(payload: Record<string, unknown>): ReleaseAsset[] {
  const assets = Array.isArray(payload.assets) ? payload.assets as Array<Record<string, unknown>> : [];
  return assets
    .map((asset) => ({
      name: String(asset.name || ""),
      browser_download_url: String(asset.browser_download_url || ""),
      digest: String(asset.digest || "").trim()
    }))
    .filter((asset) => asset.name && asset.browser_download_url);
}

function pickSetupAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const installable = assets.filter((asset) => /\.(exe|msi|msix|msixbundle)$/i.test(asset.name));
  if (installable.length === 0) {
    return null;
  }

  return installable.find((asset) => /setup/i.test(asset.name))
    || installable.find((asset) => !/portable/i.test(asset.name))
    || installable[0];
}

function pickLatestYmlAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  return assets.find((asset) => /^latest\.ya?ml$/i.test(asset.name))
    || assets.find((asset) => /latest/i.test(asset.name) && /\.ya?ml$/i.test(asset.name))
    || null;
}

function normalizeAssetNameForDigestMatch(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const fileName = trimmed.split(/[\\/]/g).filter(Boolean).pop() || trimmed;
  return fileName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripYamlScalar(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  const unquoted = trimmed.replace(/^['"]+|['"]+$/g, "");
  return unquoted.trim();
}

function parseSha512FromLatestYml(content: string, setupAssetName: string): string {
  const lines = String(content || "").split(/\r?\n/g);
  const targetNormalized = normalizeAssetNameForDigestMatch(setupAssetName);
  let topLevelPath = "";
  let topLevelSha = "";
  let currentFileUrl = "";
  let firstFileSha = "";

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const fileUrlItem = line.match(/^\s*-\s*url\s*:\s*(.+)\s*$/i);
    if (fileUrlItem?.[1]) {
      currentFileUrl = stripYamlScalar(fileUrlItem[1]);
      continue;
    }
    const fileUrl = line.match(/^\s*url\s*:\s*(.+)\s*$/i);
    if (fileUrl?.[1]) {
      currentFileUrl = stripYamlScalar(fileUrl[1]);
      continue;
    }
    const pathMatch = line.match(/^\s*path\s*:\s*(.+)\s*$/i);
    if (pathMatch?.[1]) {
      topLevelPath = stripYamlScalar(pathMatch[1]);
      continue;
    }
    const shaMatch = line.match(/^\s*sha512\s*:\s*([A-Za-z0-9+/=]{40,})\s*$/);
    if (!shaMatch?.[1]) {
      continue;
    }
    const sha = shaMatch[1].trim();
    if (currentFileUrl) {
      if (!firstFileSha) {
        firstFileSha = sha;
      }
      if (targetNormalized) {
        const fileUrlNormalized = normalizeAssetNameForDigestMatch(currentFileUrl);
        if (fileUrlNormalized && fileUrlNormalized === targetNormalized) {
          return sha;
        }
      }
      currentFileUrl = "";
      continue;
    }
    if (!topLevelSha) {
      topLevelSha = sha;
    }
  }

  if (targetNormalized && topLevelPath && topLevelSha) {
    const topLevelPathNormalized = normalizeAssetNameForDigestMatch(topLevelPath);
    if (topLevelPathNormalized && topLevelPathNormalized === targetNormalized) {
      return topLevelSha;
    }
  }

  return topLevelSha || firstFileSha || "";
}

function parseReleasePayload(payload: Record<string, unknown>, fallback: UpdateCheckResult): UpdateCheckResult {
  const latestTag = String(payload.tag_name || `v${APP_VERSION}`).trim();
  const latestVersion = latestTag.replace(/^v/i, "") || APP_VERSION;
  const releaseUrl = String(payload.html_url || fallback.releaseUrl);
  const setup = pickSetupAsset(readReleaseAssets(payload));

  return {
    updateAvailable: isRemoteNewer(APP_VERSION, latestVersion),
    currentVersion: APP_VERSION,
    latestVersion,
    latestTag,
    releaseUrl,
    setupAssetUrl: setup?.browser_download_url || "",
    setupAssetName: setup?.name || "",
    setupAssetDigest: setup?.digest || ""
  };
}

function isDraftOrPrereleaseRelease(payload: Record<string, unknown>): boolean {
  return Boolean(payload.draft) || Boolean(payload.prerelease);
}

async function fetchReleasePayload(safeRepo: string, endpoint: string): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const timeout = timeoutController(RELEASE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${UPDATE_API_BASE}/repos/${safeRepo}/${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": UPDATE_USER_AGENT
      },
      signal: timeout.signal
    });
    const payload = await readJsonWithTimeout(response, RELEASE_FETCH_TIMEOUT_MS);
    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } finally {
    timeout.clear();
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function deriveTagFromReleaseUrl(releaseUrl: string): string {
  const raw = String(releaseUrl || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\/releases\/tag\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function extractFileNameFromUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    const fileName = path.basename(parsed.pathname || "");
    return fileName ? decodeURIComponent(fileName) : "";
  } catch {
    return "";
  }
}

function deriveSetupNameVariants(setupAssetName: string, setupAssetUrl: string): string[] {
  const directName = String(setupAssetName || "").trim();
  const fromUrlName = extractFileNameFromUrl(setupAssetUrl);
  const source = directName || fromUrlName;
  if (!source) {
    return [];
  }

  const ext = path.extname(source);
  const stem = ext ? source.slice(0, -ext.length) : source;
  const dashed = `${stem.replace(/\s+/g, "-")}${ext}`;
  return uniqueStrings([source, fromUrlName, dashed]);
}

function buildDownloadCandidates(safeRepo: string, check: UpdateCheckResult): string[] {
  const setupAssetName = String(check.setupAssetName || "").trim();
  const setupAssetUrl = String(check.setupAssetUrl || "").trim();
  const latestTag = String(check.latestTag || "").trim() || deriveTagFromReleaseUrl(String(check.releaseUrl || ""));

  const candidates = [setupAssetUrl];
  const nameVariants = deriveSetupNameVariants(setupAssetName, setupAssetUrl);
  if (latestTag && nameVariants.length > 0) {
    for (const name of nameVariants) {
      const encodedName = encodeURIComponent(name);
      candidates.push(`${UPDATE_WEB_BASE}/${safeRepo}/releases/download/${encodeURIComponent(latestTag)}/${encodedName}`);
    }
  }
  if (!latestTag && nameVariants.length > 0) {
    for (const name of nameVariants) {
      const encodedName = encodeURIComponent(name);
      candidates.push(`${UPDATE_WEB_BASE}/${safeRepo}/releases/latest/download/${encodedName}`);
    }
  }

  return uniqueStrings(candidates);
}

function readHttpStatusFromError(error: unknown): number {
  const text = String(error || "");
  const match = text.match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : 0;
}

function isRetryableDownloadError(error: unknown): boolean {
  const status = readHttpStatusFromError(error);
  if (status === 429 || status >= 500) {
    return true;
  }

  const text = String(error || "").toLowerCase();
  return text.includes("timeout")
    || text.includes("fetch failed")
    || text.includes("network")
    || text.includes("econnreset")
    || text.includes("enotfound")
    || text.includes("aborted");
}

function shouldTryNextDownloadCandidate(error: unknown): boolean {
  const status = readHttpStatusFromError(error);
  if (status >= 400 && status <= 599) {
    return true;
  }
  return isRetryableDownloadError(error);
}

function deriveUpdateFileName(check: UpdateCheckResult, url: string): string {
  const sanitizeUpdateAssetFileName = (rawName: string): string => {
    const base = path.basename(String(rawName || "").trim());
    if (!base) {
      return "update.exe";
    }
    const safe = base
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\.+/, "")
      .trim();
    return safe || "update.exe";
  };

  const fromName = String(check.setupAssetName || "").trim();
  if (fromName) {
    return sanitizeUpdateAssetFileName(fromName);
  }
  try {
    const parsed = new URL(url);
    return sanitizeUpdateAssetFileName(parsed.pathname || "update.exe");
  } catch {
    return "update.exe";
  }
}

type ExpectedDigest = {
  algorithm: "sha256" | "sha512";
  digest: string;
  encoding: "hex" | "base64";
};

function normalizeBase64Digest(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

function parseExpectedDigest(raw: string): ExpectedDigest | null {
  const text = String(raw || "").trim();
  const prefixed256 = text.match(/^sha256:([a-fA-F0-9]{64})$/i);
  if (prefixed256) {
    return { algorithm: "sha256", digest: prefixed256[1].toLowerCase(), encoding: "hex" };
  }
  const prefixed512 = text.match(/^sha512:([a-fA-F0-9]{128})$/i);
  if (prefixed512) {
    return { algorithm: "sha512", digest: prefixed512[1].toLowerCase(), encoding: "hex" };
  }
  const prefixed512Base64 = text.match(/^sha512:([A-Za-z0-9+/_-]{80,}={0,2})$/i);
  if (prefixed512Base64) {
    return { algorithm: "sha512", digest: normalizeBase64Digest(prefixed512Base64[1]), encoding: "base64" };
  }
  const prefixed256Base64 = text.match(/^sha256:([A-Za-z0-9+/_-]{40,}={0,2})$/i);
  if (prefixed256Base64) {
    return { algorithm: "sha256", digest: normalizeBase64Digest(prefixed256Base64[1]), encoding: "base64" };
  }
  const plain256 = text.match(/^([a-fA-F0-9]{64})$/);
  if (plain256) {
    return { algorithm: "sha256", digest: plain256[1].toLowerCase(), encoding: "hex" };
  }
  const plain512 = text.match(/^([a-fA-F0-9]{128})$/);
  if (plain512) {
    return { algorithm: "sha512", digest: plain512[1].toLowerCase(), encoding: "hex" };
  }
  const plain512Base64 = text.match(/^([A-Za-z0-9+/_-]{80,}={0,2})$/i);
  if (plain512Base64) {
    return { algorithm: "sha512", digest: normalizeBase64Digest(plain512Base64[1]), encoding: "base64" };
  }
  const plain256Base64 = text.match(/^([A-Za-z0-9+/_-]{40,}={0,2})$/i);
  if (plain256Base64) {
    return { algorithm: "sha256", digest: normalizeBase64Digest(plain256Base64[1]), encoding: "base64" };
  }
  return null;
}

async function hashFile(filePath: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): Promise<string> {
  const hash = crypto.createHash(algorithm);
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      if (encoding === "base64") {
        resolve(hash.digest("base64"));
        return;
      }
      resolve(hash.digest("hex").toLowerCase());
    });
  });
}

async function verifyInstallerBinaryShape(targetPath: string): Promise<void> {
  const stats = await fs.promises.stat(targetPath);
  if (!Number.isFinite(stats.size) || stats.size < 128 * 1024) {
    throw new Error("Update-Installer ungültig (Datei zu klein)");
  }

  const handle = await fs.promises.open(targetPath, "r");
  try {
    const header = Buffer.alloc(2);
    const result = await handle.read(header, 0, 2, 0);
    if (result.bytesRead < 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
      throw new Error("Update-Installer ungültig (keine EXE-Datei)");
    }
  } finally {
    await handle.close();
  }
}

async function verifyDownloadedInstaller(targetPath: string, expectedDigestRaw: string): Promise<void> {
  await verifyInstallerBinaryShape(targetPath);

  const expected = parseExpectedDigest(expectedDigestRaw);
  if (!expected) {
    logger.warn("Update-Asset ohne SHA-Digest; nur EXE-Basisprüfung durchgeführt");
    return;
  }
  const actualDigestRaw = await hashFile(targetPath, expected.algorithm, expected.encoding);
  const actualDigest = expected.encoding === "base64"
    ? normalizeBase64Digest(actualDigestRaw).replace(/=+$/g, "")
    : actualDigestRaw;
  const expectedDigest = expected.encoding === "base64"
    ? normalizeBase64Digest(expected.digest).replace(/=+$/g, "")
    : expected.digest;
  if (actualDigest !== expectedDigest) {
    throw new Error(`Update-Integritätsprüfung fehlgeschlagen (${expected.algorithm.toUpperCase()} mismatch)`);
  }
}

async function resolveSetupAssetFromApi(safeRepo: string, tagHint: string): Promise<{ setupAssetUrl: string; setupAssetName: string; setupAssetDigest: string } | null> {
  const endpointCandidates = uniqueStrings([
    tagHint ? `releases/tags/${encodeURIComponent(tagHint)}` : "",
    "releases/latest"
  ]);

  for (const endpoint of endpointCandidates) {
    try {
      const release = await fetchReleasePayload(safeRepo, endpoint);
      if (!release.ok || !release.payload) {
        continue;
      }
      if (isDraftOrPrereleaseRelease(release.payload)) {
        continue;
      }
      const setup = pickSetupAsset(readReleaseAssets(release.payload));
      if (!setup) {
        continue;
      }
      return {
        setupAssetUrl: setup.browser_download_url,
        setupAssetName: setup.name,
        setupAssetDigest: setup.digest
      };
    } catch {
      // ignore and continue with next endpoint candidate
    }
  }

  return null;
}

async function resolveSetupDigestFromLatestYml(safeRepo: string, tagHint: string, setupAssetName: string): Promise<string> {
  const endpointCandidates = uniqueStrings([
    tagHint ? `releases/tags/${encodeURIComponent(tagHint)}` : "",
    "releases/latest"
  ]);

  for (const endpoint of endpointCandidates) {
    try {
      const release = await fetchReleasePayload(safeRepo, endpoint);
      if (!release.ok || !release.payload) {
        continue;
      }
      if (isDraftOrPrereleaseRelease(release.payload)) {
        continue;
      }

      const assets = readReleaseAssets(release.payload);
      const ymlAsset = pickLatestYmlAsset(assets);
      if (!ymlAsset) {
        continue;
      }

      const timeout = timeoutController(RELEASE_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(ymlAsset.browser_download_url, {
          headers: {
            "User-Agent": UPDATE_USER_AGENT
          },
          signal: timeout.signal
        });
      } finally {
        timeout.clear();
      }
      if (!response.ok) {
        continue;
      }

      const yamlText = await readTextWithTimeout(response, RELEASE_FETCH_TIMEOUT_MS);
      const sha512 = parseSha512FromLatestYml(yamlText, setupAssetName);
      if (sha512) {
        return `sha512:${sha512}`;
      }
    } catch {
      // ignore and continue with next endpoint candidate
    }
  }

  return "";
}

export async function checkGitHubUpdate(repo: string): Promise<UpdateCheckResult> {
  const safeRepo = normalizeUpdateRepo(repo);
  const fallback = createFallbackResult(safeRepo);

  try {
    const release = await fetchReleasePayload(safeRepo, "releases/latest");
    if (!release.ok || !release.payload) {
      const reason = String((release.payload?.message as string) || `HTTP ${release.status}`);
      return { ...fallback, error: reason };
    }

    return parseReleasePayload(release.payload, fallback);
  } catch (error) {
    return {
      ...fallback,
      error: compactErrorText(error)
    };
  }
}

async function downloadFile(url: string, targetPath: string, onProgress?: UpdateProgressCallback): Promise<{ expectedBytes: number | null }> {
  const shutdownSignal = activeUpdateAbortController?.signal;
  if (shutdownSignal?.aborted) {
    throw new Error("aborted:update_shutdown");
  }
  logger.info(`Update-Download versucht: ${url}`);
  const timeout = timeoutController(CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": UPDATE_USER_AGENT,
        "Accept-Encoding": "identity"
      },
      redirect: "follow",
      signal: combineSignals(timeout.signal, shutdownSignal)
    });
  } finally {
    timeout.clear();
  }
  if (!response.ok || !response.body) {
    throw new Error(`Update Download fehlgeschlagen (HTTP ${response.status})`);
  }

  const totalBytesRaw = Number(response.headers.get("content-length") || NaN);
  const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0
    ? Math.max(0, Math.floor(totalBytesRaw))
    : null;
  let downloadedBytes = 0;
  let lastProgressAt = 0;
  const emitDownloadProgress = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 160) {
      return;
    }
    lastProgressAt = now;
    const percent = totalBytes && totalBytes > 0
      ? Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)))
      : null;
    const message = totalBytes && percent !== null
      ? `Update wird heruntergeladen: ${percent}% (${humanSize(downloadedBytes)} / ${humanSize(totalBytes)})`
      : `Update wird heruntergeladen (${humanSize(downloadedBytes)})`;
    safeEmitProgress(onProgress, {
      stage: "downloading",
      percent,
      downloadedBytes,
      totalBytes,
      message
    });
  };
  emitDownloadProgress(true);

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  const idleTimeoutMs = getDownloadBodyIdleTimeoutMs();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleTimedOut = false;
  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdleTimer = (): void => {
    if (idleTimeoutMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      reader.cancel().catch(() => undefined);
    }, idleTimeoutMs);
  };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];

  try {
    resetIdleTimer();
    for (;;) {
      if (shutdownSignal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new Error("aborted:update_shutdown");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(buf);
      downloadedBytes += buf.byteLength;
      resetIdleTimer();
      emitDownloadProgress(false);
    }
  } finally {
    clearIdleTimer();
  }

  if (idleTimedOut) {
    throw new Error(`Update Download Body Timeout nach ${Math.ceil(idleTimeoutMs / 1000)}s`);
  }

  const fileBuffer = Buffer.concat(chunks);
  if (totalBytes && fileBuffer.byteLength !== totalBytes) {
    throw new Error(`Update Download unvollständig (${fileBuffer.byteLength} / ${totalBytes} Bytes)`);
  }

  await fs.promises.writeFile(targetPath, fileBuffer);
  emitDownloadProgress(true);
  logger.info(`Update-Download abgeschlossen: ${targetPath} (${fileBuffer.byteLength} Bytes)`);

  return { expectedBytes: totalBytes };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    throw new Error("aborted:update_shutdown");
  }
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted:update_shutdown"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function downloadWithRetries(url: string, targetPath: string, onProgress?: UpdateProgressCallback): Promise<void> {
  const shutdownSignal = activeUpdateAbortController?.signal;
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES_PER_CANDIDATE; attempt += 1) {
    if (shutdownSignal?.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    try {
      await downloadFile(url, targetPath, onProgress);
      return;
    } catch (error) {
      lastError = error;
      try {
        await fs.promises.rm(targetPath, { force: true });
      } catch {
        // ignore
      }
      if (attempt < RETRIES_PER_CANDIDATE && isRetryableDownloadError(error)) {
        logger.warn(`Update-Download Retry ${attempt}/${RETRIES_PER_CANDIDATE} für ${url}: ${compactErrorText(error)}`);
        await sleep(RETRY_DELAY_MS * attempt, shutdownSignal);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function downloadFromCandidates(candidates: string[], targetPath: string, onProgress?: UpdateProgressCallback): Promise<void> {
  const shutdownSignal = activeUpdateAbortController?.signal;
  let lastError: unknown = new Error("Update Download fehlgeschlagen");

  logger.info(`Update-Download: ${candidates.length} Kandidat(en), je ${RETRIES_PER_CANDIDATE} Versuche`);
  for (let index = 0; index < candidates.length; index += 1) {
    if (shutdownSignal?.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    const candidate = candidates[index];
    safeEmitProgress(onProgress, {
      stage: "downloading",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: `Update-Download: Quelle ${index + 1}/${candidates.length}`
    });
    try {
      await downloadWithRetries(candidate, targetPath, onProgress);
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`Update-Download Kandidat ${index + 1}/${candidates.length} endgültig fehlgeschlagen: ${compactErrorText(error)}`);
      if (index < candidates.length - 1 && shouldTryNextDownloadCandidate(error)) {
        continue;
      }
      break;
    }
  }

  throw lastError;
}

export async function installLatestUpdate(
  repo: string,
  prechecked?: UpdateCheckResult,
  onProgress?: UpdateProgressCallback
): Promise<UpdateInstallResult> {
  if (activeUpdateAbortController && !activeUpdateAbortController.signal.aborted) {
    safeEmitProgress(onProgress, {
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Update-Download läuft bereits"
    });
    return { started: false, message: "Update-Download läuft bereits" };
  }
  const updateAbortController = new AbortController();
  activeUpdateAbortController = updateAbortController;

  const safeRepo = normalizeUpdateRepo(repo);
  const check = prechecked && !prechecked.error
    ? prechecked
    : await checkGitHubUpdate(safeRepo);

  if (check.error) {
    activeUpdateAbortController = null;
    safeEmitProgress(onProgress, {
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: check.error
    });
    return { started: false, message: check.error };
  }
  if (!check.updateAvailable) {
    activeUpdateAbortController = null;
    safeEmitProgress(onProgress, {
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Kein neues Update verfügbar"
    });
    return { started: false, message: "Kein neues Update verfügbar" };
  }

  let effectiveCheck: UpdateCheckResult = {
    ...check,
    setupAssetUrl: String(check.setupAssetUrl || ""),
    setupAssetName: String(check.setupAssetName || ""),
    setupAssetDigest: String(check.setupAssetDigest || "")
  };

  if (!effectiveCheck.setupAssetUrl || !effectiveCheck.setupAssetDigest) {
    const refreshed = await resolveSetupAssetFromApi(safeRepo, effectiveCheck.latestTag);
    if (refreshed) {
      effectiveCheck = {
        ...effectiveCheck,
        setupAssetUrl: refreshed.setupAssetUrl,
        setupAssetName: refreshed.setupAssetName,
        setupAssetDigest: refreshed.setupAssetDigest
      };
    }
  }

  if (!effectiveCheck.setupAssetDigest && effectiveCheck.setupAssetUrl) {
    const digestFromYml = await resolveSetupDigestFromLatestYml(safeRepo, effectiveCheck.latestTag, effectiveCheck.setupAssetName || "");
    if (digestFromYml) {
      effectiveCheck = {
        ...effectiveCheck,
        setupAssetDigest: digestFromYml
      };
      logger.info("Update-Integritätsdigest aus latest.yml übernommen");
    }
  }

  let candidates = buildDownloadCandidates(safeRepo, effectiveCheck);
  if (candidates.length === 0) {
    activeUpdateAbortController = null;
    safeEmitProgress(onProgress, {
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Setup-Asset nicht gefunden"
    });
    return { started: false, message: "Setup-Asset nicht gefunden" };
  }

  const fileName = deriveUpdateFileName(effectiveCheck, candidates[0]);
  const targetPath = path.join(os.tmpdir(), "rd-update", `${Date.now()}-${process.pid}-${crypto.randomUUID()}-${fileName}`);

  try {
    safeEmitProgress(onProgress, {
      stage: "starting",
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Update wird vorbereitet"
    });
    if (updateAbortController.signal.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    let verified = false;
    let lastVerifyError: unknown = null;
    let integrityError: unknown = null;
    for (let pass = 0; pass < 3 && !verified; pass += 1) {
      logger.info(`Update-Download Kandidaten (${pass + 1}/3): ${candidates.join(" | ")}`);
      lastVerifyError = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
          await downloadWithRetries(candidate, targetPath, onProgress);
          if (updateAbortController.signal.aborted) {
            throw new Error("aborted:update_shutdown");
          }
          safeEmitProgress(onProgress, {
            stage: "verifying",
            percent: 100,
            downloadedBytes: 0,
            totalBytes: null,
            message: `Prüfe Installer-Integrität (${index + 1}/${candidates.length})`
          });
          await verifyDownloadedInstaller(targetPath, String(effectiveCheck.setupAssetDigest || ""));
          verified = true;
          break;
        } catch (error) {
          lastVerifyError = error;
          const errorText = compactErrorText(error).toLowerCase();
          if (!integrityError && (errorText.includes("integrit") || errorText.includes("mismatch"))) {
            integrityError = error;
          }
          try {
            await fs.promises.rm(targetPath, { force: true });
          } catch {
            // ignore
          }
          if (index < candidates.length - 1) {
            logger.warn(`Update-Kandidat ${index + 1}/${candidates.length} verworfen: ${compactErrorText(error)}`);
          }
        }
      }

      if (verified) {
        break;
      }

      const status = readHttpStatusFromError(lastVerifyError);
      const wasIntegrityError = integrityError !== null;
      let shouldRetryAfterRefresh = false;

      if (pass < 2 && (status === 404 || wasIntegrityError)) {
        const refreshed = await resolveSetupAssetFromApi(safeRepo, effectiveCheck.latestTag);
        if (refreshed) {
          effectiveCheck = {
            ...effectiveCheck,
            setupAssetUrl: refreshed.setupAssetUrl || effectiveCheck.setupAssetUrl,
            setupAssetName: refreshed.setupAssetName || effectiveCheck.setupAssetName,
            setupAssetDigest: refreshed.setupAssetDigest || effectiveCheck.setupAssetDigest
          };
        }

        const digestFromYml = await resolveSetupDigestFromLatestYml(safeRepo, effectiveCheck.latestTag, effectiveCheck.setupAssetName || "");
        if (digestFromYml) {
          effectiveCheck = {
            ...effectiveCheck,
            setupAssetDigest: digestFromYml
          };
          logger.info("Update-Integritätsdigest aus latest.yml übernommen");
        }

        const refreshedCandidates = buildDownloadCandidates(safeRepo, effectiveCheck);
        const changed = refreshedCandidates.length > 0
          && (refreshedCandidates.length !== candidates.length
            || refreshedCandidates.some((value, idx) => value !== candidates[idx]));
        if (changed) {
          logger.warn(`Update-Fehler erkannt (${wasIntegrityError ? "integrity" : "404"}), Kandidatenliste aus API neu geladen`);
          candidates = refreshedCandidates;
        }
        shouldRetryAfterRefresh = true;
        if (wasIntegrityError) {
          integrityError = null;
          logger.warn("SHA512-Mismatch erkannt, erneuter Download-Versuch");
        }
      }
      if (!shouldRetryAfterRefresh) {
        break;
      }
    }
    if (!verified) {
      throw integrityError || lastVerifyError || new Error("Update-Download fehlgeschlagen");
    }
    safeEmitProgress(onProgress, {
      stage: "launching",
      percent: 100,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Starte Update-Installer"
    });
    const child = spawn(targetPath, [], {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", (spawnError) => {
      logger.error(`Update-Installer Start fehlgeschlagen: ${compactErrorText(spawnError)}`);
    });
    child.unref();
    safeEmitProgress(onProgress, {
      stage: "done",
      percent: 100,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Update-Installer gestartet"
    });
    return { started: true, message: "Update-Installer gestartet" };
  } catch (error) {
    try {
      await fs.promises.rm(targetPath, { force: true });
    } catch {
      // ignore
    }
    const releaseUrl = String(effectiveCheck.releaseUrl || "").trim();
    const hint = releaseUrl ? ` – Manuell: ${releaseUrl}` : "";
    const message = `${compactErrorText(error)}${hint}`;
    safeEmitProgress(onProgress, {
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message
    });
    return { started: false, message };
  } finally {
    if (activeUpdateAbortController === updateAbortController) {
      activeUpdateAbortController = null;
    }
  }
}

export function abortActiveUpdateDownload(): void {
  if (!activeUpdateAbortController || activeUpdateAbortController.signal.aborted) {
    return;
  }
  activeUpdateAbortController.abort("shutdown");
}
