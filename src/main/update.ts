import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as childProcess from "node:child_process";
import { APP_VERSION, DEFAULT_UPDATE_REPO } from "./constants";
import { UpdateCheckResult, UpdateInstallProgress, UpdateInstallResult } from "../shared/types";
import { compactErrorText, humanSize } from "./utils";
import { logger } from "./logger";

// ─── Constants ─────────────────────────────────────────────────────────────────

const RELEASE_FETCH_TIMEOUT_MS = 12_000;
const CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_BODY_IDLE_TIMEOUT_MS = 45_000;
const RETRIES_PER_CANDIDATE = 3;
const RETRY_DELAY_MS = 1_500;
const MAX_DOWNLOAD_PASSES = 3;
const USER_AGENT = `RD-Node-Downloader/${APP_VERSION}`;

// ─── Types ─────────────────────────────────────────────────────────────────────

type UpdateSource = {
  name: string;
  webBase: string;
  apiBase: string;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest: string;
};

type UpdateProgressCallback = (progress: UpdateInstallProgress) => void;

type ExpectedDigest = {
  algorithm: "sha256" | "sha512";
  digest: string;
  encoding: "hex" | "base64";
};

// ─── Update Sources ────────────────────────────────────────────────────────────

const UPDATE_SOURCES: UpdateSource[] = [
  { name: "git24", webBase: "https://git.24-music.de", apiBase: "https://git.24-music.de/api/v1" },
  { name: "codeberg", webBase: "https://codeberg.org", apiBase: "https://codeberg.org/api/v1" },
  { name: "github", webBase: "https://github.com", apiBase: "https://api.github.com" },
];

const PRIMARY_SOURCE = UPDATE_SOURCES[0];
const WEB_BASE = PRIMARY_SOURCE.webBase;
const API_BASE = PRIMARY_SOURCE.apiBase;

// ─── Module State ──────────────────────────────────────────────────────────────

let activeAbortController: AbortController | null = null;

// ─── Progress Helper ───────────────────────────────────────────────────────────

function emitProgress(cb: UpdateProgressCallback | undefined, progress: UpdateInstallProgress): void {
  if (!cb) return;
  try {
    cb(progress);
  } catch {
    // ignore renderer callback errors
  }
}

// ─── Version Utilities ─────────────────────────────────────────────────────────

export function parseVersionParts(version: string): number[] {
  const cleaned = version.replace(/^v/i, "").trim();
  return cleaned.split(".").map((part) => Number(part.replace(/[^0-9].*$/, "") || "0"));
}

export function isRemoteNewer(currentVersion: string, latestVersion: string): boolean {
  const current = parseVersionParts(currentVersion);
  const latest = parseVersionParts(latestVersion);
  const len = Math.max(current.length, latest.length);
  for (let i = 0; i < len; i += 1) {
    const a = current[i] ?? 0;
    const b = latest[i] ?? 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

// ─── Repository Normalization ──────────────────────────────────────────────────

function isValidRepoPart(value: string): boolean {
  const part = String(value || "").trim();
  if (!part || part === "." || part === ".." || part.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part);
}

function extractOwnerRepo(input: string): string {
  const cleaned = input
    .replace(/^https?:\/\/(?:www\.)?(?:codeberg\.org|github\.com|git\.24-music\.de)\//i, "")
    .replace(/^(?:www\.)?(?:codeberg\.org|github\.com|git\.24-music\.de)\//i, "")
    .replace(/^git@(?:codeberg\.org|github\.com|git\.24-music\.de):/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2 && isValidRepoPart(parts[0]) && isValidRepoPart(parts[1])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return "";
}

export function normalizeUpdateRepo(repo: string): string {
  const raw = String(repo || "").trim();
  if (!raw) return DEFAULT_UPDATE_REPO;

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
      const result = extractOwnerRepo(url.pathname);
      if (result) return result;
    }
  } catch {
    // not a URL, try as plain text
  }

  const result = extractOwnerRepo(raw);
  return result || DEFAULT_UPDATE_REPO;
}

// ─── Network Utilities ─────────────────────────────────────────────────────────

function timeoutController(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout:${ms}`)), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}

async function readJsonBody(response: Response, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      reject(new Error(`timeout:${timeoutMs}`));
    }, timeoutMs);
  });

  try {
    const data = await Promise.race([
      response.json().catch(() => null) as Promise<unknown>,
      timeoutPromise,
    ]);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readTextBody(response: Response, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      reject(new Error(`timeout:${timeoutMs}`));
    }, timeoutMs);
  });

  try {
    return String(await Promise.race([response.text(), timeoutPromise]) || "");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getBodyIdleTimeout(): number {
  const env = Number(process.env.RD_UPDATE_BODY_IDLE_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(env) && env >= 1000 && env <= 30 * 60 * 1000) return Math.floor(env);
  return DOWNLOAD_BODY_IDLE_TIMEOUT_MS;
}

// ─── Digest Parsing & Verification ─────────────────────────────────────────────
//
// SHA-256 = 32 bytes → hex: 64 chars, base64: 43-44 chars (+ up to 1 padding =)
// SHA-512 = 64 bytes → hex: 128 chars, base64: 86-88 chars (+ up to 2 padding =)

function normalizeBase64(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/-/g, "+")   // URL-safe → standard
    .replace(/_/g, "/")   // URL-safe → standard
    .replace(/=+$/g, ""); // strip padding for consistent comparison
}

export function parseExpectedDigest(raw: string): ExpectedDigest | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  // ── Prefixed: sha256:<value> ──

  const pre256hex = text.match(/^sha256:([a-fA-F0-9]{64})$/i);
  if (pre256hex) {
    return { algorithm: "sha256", digest: pre256hex[1].toLowerCase(), encoding: "hex" };
  }

  const pre256b64 = text.match(/^sha256:([A-Za-z0-9+/_-]{43,44}={0,1})$/i);
  if (pre256b64) {
    return { algorithm: "sha256", digest: normalizeBase64(pre256b64[1]), encoding: "base64" };
  }

  // ── Prefixed: sha512:<value> ──

  const pre512hex = text.match(/^sha512:([a-fA-F0-9]{128})$/i);
  if (pre512hex) {
    return { algorithm: "sha512", digest: pre512hex[1].toLowerCase(), encoding: "hex" };
  }

  const pre512b64 = text.match(/^sha512:([A-Za-z0-9+/_-]{86,88}={0,2})$/i);
  if (pre512b64) {
    return { algorithm: "sha512", digest: normalizeBase64(pre512b64[1]), encoding: "base64" };
  }

  // ── Plain hex ──

  if (/^[a-fA-F0-9]{64}$/.test(text)) {
    return { algorithm: "sha256", digest: text.toLowerCase(), encoding: "hex" };
  }
  if (/^[a-fA-F0-9]{128}$/.test(text)) {
    return { algorithm: "sha512", digest: text.toLowerCase(), encoding: "hex" };
  }

  // ── Plain base64 (SHA-512 first since it's longer → won't accidentally match SHA-256) ──

  const plain512b64 = text.match(/^([A-Za-z0-9+/_-]{86,88}={0,2})$/);
  if (plain512b64) {
    return { algorithm: "sha512", digest: normalizeBase64(plain512b64[1]), encoding: "base64" };
  }

  const plain256b64 = text.match(/^([A-Za-z0-9+/_-]{43,44}={0,1})$/);
  if (plain256b64) {
    return { algorithm: "sha256", digest: normalizeBase64(plain256b64[1]), encoding: "base64" };
  }

  logger.warn(`Unrecognized digest format (${text.length} chars): ${text.slice(0, 40)}...`);
  return null;
}

async function hashFile(filePath: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): Promise<string> {
  const hash = crypto.createHash(algorithm);
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const result = hash.digest(encoding);
      resolve(encoding === "hex" ? result.toLowerCase() : result);
    });
  });
}

// ─── latest.yml Parsing ────────────────────────────────────────────────────────

function normalizeNameForMatch(value: string): string {
  const name = String(value || "").trim().split(/[\\/]/g).filter(Boolean).pop() || "";
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripYamlQuotes(raw: string): string {
  return String(raw || "").trim().replace(/^['"]+|['"]+$/g, "").trim();
}

function extractSha512Value(raw: string): string {
  const stripped = stripYamlQuotes(raw);
  // Base64 SHA-512: 86-88 chars + optional padding
  const b64 = stripped.match(/^([A-Za-z0-9+/_-]{86,88}={0,2})$/);
  if (b64) return b64[1];
  // Hex SHA-512: exactly 128 hex chars
  const hex = stripped.match(/^([a-fA-F0-9]{128})$/);
  if (hex) return hex[1];
  return "";
}

function parseSha512FromLatestYml(content: string, setupAssetName: string): string {
  const lines = String(content || "").split(/\r?\n/);
  const target = normalizeNameForMatch(setupAssetName);

  let topLevelPath = "";
  let topLevelSha = "";
  let currentFileUrl = "";
  let firstFileSha = "";

  for (const rawLine of lines) {
    const line = String(rawLine);

    // File entry URL (inside files: array)
    const fileUrlItem = line.match(/^\s*-\s*url\s*:\s*(.+)\s*$/i);
    if (fileUrlItem?.[1]) {
      currentFileUrl = stripYamlQuotes(fileUrlItem[1]);
      continue;
    }

    // Top-level or non-array URL
    const urlMatch = line.match(/^\s*url\s*:\s*(.+)\s*$/i);
    if (urlMatch?.[1]) {
      currentFileUrl = stripYamlQuotes(urlMatch[1]);
      continue;
    }

    // Top-level path
    const pathMatch = line.match(/^\s*path\s*:\s*(.+)\s*$/i);
    if (pathMatch?.[1]) {
      topLevelPath = stripYamlQuotes(pathMatch[1]);
      continue;
    }

    // SHA-512 value (handles quoted and unquoted)
    const shaMatch = line.match(/^\s*sha512\s*:\s*(.+)\s*$/i);
    if (!shaMatch?.[1]) continue;

    const sha = extractSha512Value(shaMatch[1]);
    if (!sha) continue;

    if (currentFileUrl) {
      if (!firstFileSha) firstFileSha = sha;
      if (target && normalizeNameForMatch(currentFileUrl) === target) {
        return sha;
      }
      currentFileUrl = "";
      continue;
    }

    if (!topLevelSha) topLevelSha = sha;
  }

  // Try matching via top-level path
  if (target && topLevelPath && topLevelSha) {
    if (normalizeNameForMatch(topLevelPath) === target) {
      return topLevelSha;
    }
  }

  return topLevelSha || firstFileSha || "";
}

// ─── Installer Verification ───────────────────────────────────────────────────

async function verifyBinaryShape(filePath: string): Promise<void> {
  const stats = await fs.promises.stat(filePath);
  if (!Number.isFinite(stats.size) || stats.size < 128 * 1024) {
    throw new Error("Update-Installer ungültig (Datei zu klein)");
  }

  const handle = await fs.promises.open(filePath, "r");
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

async function verifyDownloadedInstaller(filePath: string, digestRaw: string): Promise<void> {
  await verifyBinaryShape(filePath);

  const expected = parseExpectedDigest(digestRaw);
  if (!expected) {
    if (String(process.env.RD_ALLOW_UNSIGNED_UPDATE || "").trim() === "1") {
      logger.warn("Update-Asset ohne gültigen SHA-Digest (RD_ALLOW_UNSIGNED_UPDATE=1) - nur EXE-Basisprüfung durchgeführt");
      return;
    }
    throw new Error("Update-Asset ohne gültigen SHA-Digest");
  }

  const actualRaw = await hashFile(filePath, expected.algorithm, expected.encoding);
  const actual = expected.encoding === "base64" ? normalizeBase64(actualRaw) : actualRaw;
  const expectedNorm = expected.encoding === "base64" ? normalizeBase64(expected.digest) : expected.digest;

  if (actual !== expectedNorm) {
    const algo = expected.algorithm.toUpperCase();
    logger.error(
      `${algo} mismatch!\n  Erwartet: ${expectedNorm.slice(0, 40)}...\n  Tatsächlich: ${actual.slice(0, 40)}...`
    );
    throw new Error(`Update-Integritätsprüfung fehlgeschlagen (${algo} mismatch)`);
  }

  logger.info(`${expected.algorithm.toUpperCase()} Integrität bestätigt`);
}

// ─── Release API ───────────────────────────────────────────────────────────────

async function fetchRelease(repo: string, endpoint: string): Promise<{
  ok: boolean;
  status: number;
  payload: Record<string, unknown> | null;
}> {
  const tc = timeoutController(RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/repos/${repo}/${endpoint}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
      signal: tc.signal,
    });
    const payload = await readJsonBody(response, RELEASE_FETCH_TIMEOUT_MS);
    return { ok: response.ok, status: response.status, payload };
  } finally {
    tc.clear();
  }
}

function readAssets(payload: Record<string, unknown>): ReleaseAsset[] {
  const raw = Array.isArray(payload.assets) ? (payload.assets as Array<Record<string, unknown>>) : [];
  return raw
    .map((a) => ({
      name: String(a.name || ""),
      browser_download_url: String(a.browser_download_url || ""),
      digest: String(a.digest || "").trim(),
    }))
    .filter((a) => a.name && a.browser_download_url);
}

function pickSetupAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const executables = assets.filter((a) => /\.(exe|msi|msix|msixbundle)$/i.test(a.name));
  if (executables.length === 0) return null;
  return (
    executables.find((a) => /setup/i.test(a.name))
    || executables.find((a) => !/portable/i.test(a.name))
    || executables[0]
  );
}

function pickLatestYml(assets: ReleaseAsset[]): ReleaseAsset | null {
  return (
    assets.find((a) => /^latest\.ya?ml$/i.test(a.name))
    || assets.find((a) => /latest/i.test(a.name) && /\.ya?ml$/i.test(a.name))
    || null
  );
}

function isDraftOrPrerelease(payload: Record<string, unknown>): boolean {
  return Boolean(payload.draft) || Boolean(payload.prerelease);
}

function parseReleasePayload(payload: Record<string, unknown>, fallbackUrl: string): UpdateCheckResult {
  const latestTag = String(payload.tag_name || `v${APP_VERSION}`).trim();
  const latestVersion = latestTag.replace(/^v/i, "") || APP_VERSION;
  const releaseUrl = String(payload.html_url || fallbackUrl);
  const setup = pickSetupAsset(readAssets(payload));
  const body = typeof payload.body === "string" ? payload.body.trim() : "";

  return {
    updateAvailable: isRemoteNewer(APP_VERSION, latestVersion),
    currentVersion: APP_VERSION,
    latestVersion,
    latestTag,
    releaseUrl,
    setupAssetUrl: setup?.browser_download_url || "",
    setupAssetName: setup?.name || "",
    setupAssetDigest: setup?.digest || "",
    releaseNotes: body || undefined,
  };
}

// ─── Download Candidates ───────────────────────────────────────────────────────

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function extractFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const fileName = path.basename(parsed.pathname || "");
    return fileName ? decodeURIComponent(fileName) : "";
  } catch {
    return "";
  }
}

function deriveTagFromUrl(releaseUrl: string): string {
  try {
    const match = new URL(releaseUrl).pathname.match(/\/releases\/tag\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function deriveNameVariants(name: string, url: string): string[] {
  const directName = String(name || "").trim();
  const fromUrl = extractFileNameFromUrl(url);
  const source = directName || fromUrl;
  if (!source) return [];
  const ext = path.extname(source);
  const stem = ext ? source.slice(0, -ext.length) : source;
  const dashed = `${stem.replace(/\s+/g, "-")}${ext}`;
  return uniqueStrings([source, fromUrl, dashed]);
}

function buildCandidates(repo: string, check: UpdateCheckResult): string[] {
  const assetUrl = String(check.setupAssetUrl || "").trim();
  const tag = String(check.latestTag || "").trim() || deriveTagFromUrl(String(check.releaseUrl || ""));
  const names = deriveNameVariants(String(check.setupAssetName || ""), assetUrl);

  const urls: string[] = [assetUrl];
  if (tag && names.length > 0) {
    for (const name of names) {
      urls.push(`${WEB_BASE}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`);
    }
  }
  if (!tag && names.length > 0) {
    for (const name of names) {
      urls.push(`${WEB_BASE}/${repo}/releases/latest/download/${encodeURIComponent(name)}`);
    }
  }
  return uniqueStrings(urls);
}

function deriveFileName(check: UpdateCheckResult, url: string): string {
  const sanitize = (raw: string): string => {
    const base = path.basename(String(raw || "").trim());
    if (!base) return "update.exe";
    const safe = base.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
    return safe || "update.exe";
  };

  const fromName = String(check.setupAssetName || "").trim();
  if (fromName) return sanitize(fromName);
  try {
    return sanitize(new URL(url).pathname || "update.exe");
  } catch {
    return "update.exe";
  }
}

// ─── Error Classification ──────────────────────────────────────────────────────

function httpStatusFromError(error: unknown): number {
  const match = String(error || "").match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : 0;
}

function isRetryable(error: unknown): boolean {
  const status = httpStatusFromError(error);
  if (status === 429 || status >= 500) return true;
  const text = String(error || "").toLowerCase();
  return text.includes("timeout")
    || text.includes("fetch failed")
    || text.includes("network")
    || text.includes("econnreset")
    || text.includes("enotfound")
    || text.includes("aborted");
}

function shouldTryNextCandidate(error: unknown): boolean {
  const status = httpStatusFromError(error);
  if (status >= 400 && status <= 599) return true;
  return isRetryable(error);
}

function isIntegrityError(error: unknown): boolean {
  const text = String(error || "").toLowerCase();
  return text.includes("integrit") || text.includes("mismatch");
}

// ─── Sleep ─────────────────────────────────────────────────────────────────────

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) throw new Error("aborted:update_shutdown");

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

// ─── Download Engine ───────────────────────────────────────────────────────────

async function downloadFile(
  url: string,
  targetPath: string,
  onProgress?: UpdateProgressCallback,
): Promise<void> {
  const shutdown = activeAbortController?.signal;
  if (shutdown?.aborted) throw new Error("aborted:update_shutdown");

  logger.info(`Update-Download versucht: ${url}`);

  // Connect with timeout
  const tc = timeoutController(CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
      redirect: "follow",
      signal: combineSignals(tc.signal, shutdown),
    });
  } finally {
    tc.clear();
  }

  if (!response.ok || !response.body) {
    throw new Error(`Update Download fehlgeschlagen (HTTP ${response.status})`);
  }

  // Parse content-length
  const clRaw = Number(response.headers.get("content-length") || NaN);
  const totalBytes = Number.isFinite(clRaw) && clRaw > 0 ? Math.max(0, Math.floor(clRaw)) : null;

  // Progress tracking
  let downloadedBytes = 0;
  let lastProgressAt = 0;

  const reportProgress = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 160) return;
    lastProgressAt = now;
    const percent = totalBytes && totalBytes > 0
      ? Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)))
      : null;
    const message = totalBytes && percent !== null
      ? `Update wird heruntergeladen: ${percent}% (${humanSize(downloadedBytes)} / ${humanSize(totalBytes)})`
      : `Update wird heruntergeladen (${humanSize(downloadedBytes)})`;
    emitProgress(onProgress, { stage: "downloading", percent, downloadedBytes, totalBytes, message });
  };

  reportProgress(true);

  // Prepare filesystem
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp`;
  const writeStream = fs.createWriteStream(tempPath);
  const reader = response.body.getReader();

  // Idle timeout tracking
  const idleMs = getBodyIdleTimeout();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleTimedOut = false;

  const clearIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const resetIdle = (): void => {
    clearIdle();
    if (idleMs > 0) {
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        reader.cancel().catch(() => undefined);
      }, idleMs);
    }
  };

  // Stream body to disk
  try {
    resetIdle();
    for (;;) {
      if (shutdown?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new Error("aborted:update_shutdown");
      }
      const { done, value } = await reader.read();
      if (done) break;

      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!writeStream.write(buf)) {
        await new Promise<void>((resolve) => writeStream.once("drain", resolve));
      }
      downloadedBytes += buf.byteLength;
      resetIdle();
      reportProgress(false);
    }
  } catch (error) {
    writeStream.destroy();
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    if (idleTimedOut) {
      throw new Error(`Update Download Body Timeout nach ${Math.ceil(idleMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearIdle();
  }

  // Flush and close write stream
  await new Promise<void>((resolve, reject) => {
    writeStream.end(() => resolve());
    writeStream.on("error", reject);
  });

  // Handle idle timeout on clean reader exit
  if (idleTimedOut) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw new Error(`Update Download Body Timeout nach ${Math.ceil(idleMs / 1000)}s`);
  }

  // Verify completeness
  if (totalBytes && downloadedBytes !== totalBytes) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw new Error(`Update Download unvollständig (${downloadedBytes} / ${totalBytes} Bytes)`);
  }

  // Atomic rename temp → final
  await fs.promises.rename(tempPath, targetPath);
  reportProgress(true);
  logger.info(`Update-Download abgeschlossen: ${targetPath} (${downloadedBytes} Bytes)`);
}

async function downloadWithRetries(
  url: string,
  targetPath: string,
  onProgress?: UpdateProgressCallback,
): Promise<void> {
  const shutdown = activeAbortController?.signal;
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRIES_PER_CANDIDATE; attempt += 1) {
    if (shutdown?.aborted) throw new Error("aborted:update_shutdown");
    try {
      await downloadFile(url, targetPath, onProgress);
      return;
    } catch (error) {
      lastError = error;
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
      if (attempt < RETRIES_PER_CANDIDATE && isRetryable(error)) {
        logger.warn(`Update-Download Retry ${attempt}/${RETRIES_PER_CANDIDATE} für ${url}: ${compactErrorText(error)}`);
        await sleep(RETRY_DELAY_MS * attempt, shutdown);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function downloadFromCandidates(
  candidates: string[],
  targetPath: string,
  onProgress?: UpdateProgressCallback,
): Promise<void> {
  const shutdown = activeAbortController?.signal;
  let lastError: unknown = new Error("Update Download fehlgeschlagen");

  logger.info(`Update-Download: ${candidates.length} Kandidat(en), je ${RETRIES_PER_CANDIDATE} Versuche`);
  for (let i = 0; i < candidates.length; i += 1) {
    if (shutdown?.aborted) throw new Error("aborted:update_shutdown");
    emitProgress(onProgress, {
      stage: "downloading",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: `Update-Download: Quelle ${i + 1}/${candidates.length}`,
    });
    try {
      await downloadWithRetries(candidates[i], targetPath, onProgress);
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`Update-Download Kandidat ${i + 1}/${candidates.length} endgültig fehlgeschlagen: ${compactErrorText(error)}`);
      if (i < candidates.length - 1 && shouldTryNextCandidate(error)) continue;
      break;
    }
  }
  throw lastError;
}

// ─── Asset Resolution Helpers ──────────────────────────────────────────────────

async function resolveAssetFromApi(repo: string, tag: string): Promise<{
  setupAssetUrl: string;
  setupAssetName: string;
  setupAssetDigest: string;
} | null> {
  const endpoints = uniqueStrings([
    tag ? `releases/tags/${encodeURIComponent(tag)}` : "",
    "releases/latest",
  ]);

  for (const ep of endpoints) {
    try {
      const { ok, payload } = await fetchRelease(repo, ep);
      if (!ok || !payload || isDraftOrPrerelease(payload)) continue;
      const setup = pickSetupAsset(readAssets(payload));
      if (!setup) continue;
      return {
        setupAssetUrl: setup.browser_download_url,
        setupAssetName: setup.name,
        setupAssetDigest: setup.digest,
      };
    } catch {
      // try next endpoint
    }
  }
  return null;
}

async function resolveDigestFromYml(repo: string, tag: string, setupName: string): Promise<string> {
  const endpoints = uniqueStrings([
    tag ? `releases/tags/${encodeURIComponent(tag)}` : "",
    "releases/latest",
  ]);

  for (const ep of endpoints) {
    try {
      const { ok, payload } = await fetchRelease(repo, ep);
      if (!ok || !payload || isDraftOrPrerelease(payload)) continue;

      const yml = pickLatestYml(readAssets(payload));
      if (!yml) continue;

      const tc = timeoutController(RELEASE_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(yml.browser_download_url, {
          headers: { "User-Agent": USER_AGENT },
          signal: tc.signal,
        });
      } finally {
        tc.clear();
      }
      if (!response.ok) continue;

      const yamlText = await readTextBody(response, RELEASE_FETCH_TIMEOUT_MS);
      const sha = parseSha512FromLatestYml(yamlText, setupName);
      if (sha) return `sha512:${sha}`;
    } catch {
      // try next endpoint
    }
  }
  return "";
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function buildInstallerLaunchArgs(): string[] {
  return ["/S", "--updated", "--force-run"];
}

export async function checkGitHubUpdate(repo: string): Promise<UpdateCheckResult> {
  const safeRepo = normalizeUpdateRepo(repo);
  const fallbackUrl = `${WEB_BASE}/${safeRepo}/releases/latest`;
  const fallback: UpdateCheckResult = {
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    latestTag: `v${APP_VERSION}`,
    releaseUrl: fallbackUrl,
  };

  try {
    const { ok, status, payload } = await fetchRelease(safeRepo, "releases/latest");
    if (!ok || !payload) {
      const reason = String((payload?.message as string) || `HTTP ${status}`);
      return { ...fallback, error: reason };
    }
    return parseReleasePayload(payload, fallbackUrl);
  } catch (error) {
    return { ...fallback, error: compactErrorText(error) };
  }
}

export async function installLatestUpdate(
  repo: string,
  prechecked?: UpdateCheckResult,
  onProgress?: UpdateProgressCallback,
): Promise<UpdateInstallResult> {
  // Prevent concurrent updates
  if (activeAbortController && !activeAbortController.signal.aborted) {
    emitProgress(onProgress, {
      stage: "error", percent: null, downloadedBytes: 0, totalBytes: null,
      message: "Update-Download läuft bereits",
    });
    return { started: false, message: "Update-Download läuft bereits" };
  }

  const abortCtrl = new AbortController();
  activeAbortController = abortCtrl;
  const safeRepo = normalizeUpdateRepo(repo);

  // Resolve update check
  const check = prechecked && !prechecked.error
    ? prechecked
    : await checkGitHubUpdate(safeRepo);

  if (check.error) {
    activeAbortController = null;
    emitProgress(onProgress, {
      stage: "error", percent: null, downloadedBytes: 0, totalBytes: null,
      message: check.error,
    });
    return { started: false, message: check.error };
  }

  if (!check.updateAvailable) {
    activeAbortController = null;
    emitProgress(onProgress, {
      stage: "error", percent: null, downloadedBytes: 0, totalBytes: null,
      message: "Kein neues Update verfügbar",
    });
    return { started: false, message: "Kein neues Update verfügbar" };
  }

  // Mutable effective state for enrichment
  let effective: UpdateCheckResult = {
    ...check,
    setupAssetUrl: String(check.setupAssetUrl || ""),
    setupAssetName: String(check.setupAssetName || ""),
    setupAssetDigest: String(check.setupAssetDigest || ""),
  };

  // Enrich: resolve asset from API if needed
  if (!effective.setupAssetUrl || !effective.setupAssetDigest) {
    const refreshed = await resolveAssetFromApi(safeRepo, effective.latestTag);
    if (refreshed) {
      effective = {
        ...effective,
        setupAssetUrl: refreshed.setupAssetUrl,
        setupAssetName: refreshed.setupAssetName,
        setupAssetDigest: refreshed.setupAssetDigest,
      };
    }
  }

  // Enrich: resolve digest from latest.yml if still missing
  if (!effective.setupAssetDigest && effective.setupAssetUrl) {
    const digest = await resolveDigestFromYml(safeRepo, effective.latestTag, effective.setupAssetName || "");
    if (digest) {
      effective = { ...effective, setupAssetDigest: digest };
      logger.info("Update-Integritätsdigest aus latest.yml übernommen");
    }
  }

  // Build download candidates
  let candidates = buildCandidates(safeRepo, effective);
  if (candidates.length === 0) {
    activeAbortController = null;
    emitProgress(onProgress, {
      stage: "error", percent: null, downloadedBytes: 0, totalBytes: null,
      message: "Setup-Asset nicht gefunden",
    });
    return { started: false, message: "Setup-Asset nicht gefunden" };
  }

  const fileName = deriveFileName(effective, candidates[0]);
  const targetPath = path.join(os.tmpdir(), "rd-update", `${Date.now()}-${process.pid}-${crypto.randomUUID()}-${fileName}`);

  try {
    emitProgress(onProgress, {
      stage: "starting", percent: 0, downloadedBytes: 0, totalBytes: null,
      message: "Update wird vorbereitet",
    });

    if (abortCtrl.signal.aborted) throw new Error("aborted:update_shutdown");

    // ── Download + verify with retry passes ──
    let verified = false;
    let lastVerifyError: unknown = null;
    let integrityError: unknown = null;

    for (let pass = 0; pass < MAX_DOWNLOAD_PASSES && !verified; pass += 1) {
      logger.info(`Update-Download Kandidaten (Pass ${pass + 1}/${MAX_DOWNLOAD_PASSES}): ${candidates.join(" | ")}`);
      lastVerifyError = null;

      for (let i = 0; i < candidates.length; i += 1) {
        if (abortCtrl.signal.aborted) throw new Error("aborted:update_shutdown");

        try {
          await downloadWithRetries(candidates[i], targetPath, onProgress);

          if (abortCtrl.signal.aborted) throw new Error("aborted:update_shutdown");

          emitProgress(onProgress, {
            stage: "verifying", percent: 100, downloadedBytes: 0, totalBytes: null,
            message: `Prüfe Installer-Integrität (${i + 1}/${candidates.length})`,
          });

          await verifyDownloadedInstaller(targetPath, String(effective.setupAssetDigest || ""));
          verified = true;
          break;
        } catch (error) {
          lastVerifyError = error;
          if (!integrityError && isIntegrityError(error)) {
            integrityError = error;
          }
          await fs.promises.rm(targetPath, { force: true }).catch(() => {});
          if (i < candidates.length - 1) {
            logger.warn(`Update-Kandidat ${i + 1}/${candidates.length} verworfen: ${compactErrorText(error)}`);
          }
        }
      }

      if (verified) break;

      // Refresh candidates on 404 or integrity mismatch
      const status = httpStatusFromError(lastVerifyError);
      const shouldRefresh = pass < MAX_DOWNLOAD_PASSES - 1 && (status === 404 || integrityError !== null);
      if (!shouldRefresh) break;

      logger.warn(`Pass ${pass + 1} fehlgeschlagen (${integrityError ? "Integritätsfehler" : "HTTP 404"}), aktualisiere Kandidaten...`);

      const refreshed = await resolveAssetFromApi(safeRepo, effective.latestTag);
      if (refreshed) {
        effective = {
          ...effective,
          setupAssetUrl: refreshed.setupAssetUrl || effective.setupAssetUrl,
          setupAssetName: refreshed.setupAssetName || effective.setupAssetName,
          setupAssetDigest: refreshed.setupAssetDigest || effective.setupAssetDigest,
        };
      }

      const ymlDigest = await resolveDigestFromYml(safeRepo, effective.latestTag, effective.setupAssetName || "");
      if (ymlDigest) {
        effective = { ...effective, setupAssetDigest: ymlDigest };
        logger.info("Update-Integritätsdigest aus latest.yml aktualisiert");
      }

      const refreshedCandidates = buildCandidates(safeRepo, effective);
      if (refreshedCandidates.length > 0) {
        const changed = refreshedCandidates.length !== candidates.length
          || refreshedCandidates.some((v, idx) => v !== candidates[idx]);
        if (changed) {
          candidates = refreshedCandidates;
          logger.info("Kandidatenliste aktualisiert");
        }
      }

      if (integrityError) {
        integrityError = null;
        logger.warn("SHA-Mismatch erkannt, erneuter Download-Versuch");
      }
    }

    if (!verified) {
      throw integrityError || lastVerifyError || new Error("Update-Download fehlgeschlagen");
    }

    // ── Launch installer ──
    emitProgress(onProgress, {
      stage: "launching", percent: 100, downloadedBytes: 0, totalBytes: null,
      message: "Starte stille Update-Installation",
    });

    const child = childProcess.spawn(targetPath, buildInstallerLaunchArgs(), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (spawnError) => {
      logger.error(`Update-Installer Start fehlgeschlagen: ${compactErrorText(spawnError)}`);
    });
    child.unref();

    emitProgress(onProgress, {
      stage: "done", percent: 100, downloadedBytes: 0, totalBytes: null,
      message: "Update wird im Hintergrund installiert und danach neu gestartet",
    });

    return { started: true, message: "Stille Update-Installation gestartet" };
  } catch (error) {
    try {
      await fs.promises.rm(targetPath, { force: true });
    } catch {
      // ignore
    }
    const releaseUrl = String(effective.releaseUrl || "").trim();
    const hint = releaseUrl ? ` – Manuell: ${releaseUrl}` : "";
    const message = `${compactErrorText(error)}${hint}`;
    emitProgress(onProgress, {
      stage: "error", percent: null, downloadedBytes: 0, totalBytes: null,
      message,
    });
    return { started: false, message };
  } finally {
    if (activeAbortController === abortCtrl) {
      activeAbortController = null;
    }
  }
}

export function abortActiveUpdateDownload(): void {
  if (!activeAbortController || activeAbortController.signal.aborted) return;
  activeAbortController.abort("shutdown");
}
