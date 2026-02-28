import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { APP_VERSION, DEFAULT_UPDATE_REPO } from "./constants";
import { UpdateCheckResult, UpdateInstallResult } from "../shared/types";
import { compactErrorText } from "./utils";
import { logger } from "./logger";

const RELEASE_FETCH_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 30000;
const DOWNLOAD_BODY_IDLE_TIMEOUT_MS = 45000;
const RETRIES_PER_CANDIDATE = 3;
const RETRY_DELAY_MS = 1500;
const UPDATE_USER_AGENT = `RD-Node-Downloader/${APP_VERSION}`;

let activeUpdateAbortController: AbortController | null = null;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest: string;
};

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
      .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
      .replace(/^(?:www\.)?github\.com\//i, "")
      .replace(/^git@github\.com:/i, "")
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
    if (host === "github.com" || host === "www.github.com") {
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
    releaseUrl: `https://github.com/${safeRepo}/releases/latest`
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
    response = await fetch(`https://api.github.com/repos/${safeRepo}/${endpoint}`, {
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

function buildDownloadCandidates(safeRepo: string, check: UpdateCheckResult): string[] {
  const setupAssetName = String(check.setupAssetName || "").trim();
  const setupAssetUrl = String(check.setupAssetUrl || "").trim();
  const latestTag = String(check.latestTag || "").trim();

  const candidates = [setupAssetUrl];
  if (setupAssetName) {
    const encodedName = encodeURIComponent(setupAssetName);
    candidates.push(`https://github.com/${safeRepo}/releases/latest/download/${encodedName}`);
    if (latestTag) {
      candidates.push(`https://github.com/${safeRepo}/releases/download/${encodeURIComponent(latestTag)}/${encodedName}`);
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

function normalizeSha256Digest(raw: string): string {
  const text = String(raw || "").trim();
  const prefixed = text.match(/^sha256:([a-fA-F0-9]{64})$/i);
  if (prefixed) {
    return prefixed[1].toLowerCase();
  }
  const plain = text.match(/^([a-fA-F0-9]{64})$/);
  return plain ? plain[1].toLowerCase() : "";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

async function verifyDownloadedInstaller(targetPath: string, expectedDigestRaw: string): Promise<void> {
  const expectedDigest = normalizeSha256Digest(expectedDigestRaw);
  if (!expectedDigest) {
    logger.warn("Update-Asset ohne SHA256-Digest aus API; Integritätsprüfung übersprungen");
    return;
  }
  const actualDigest = await sha256File(targetPath);
  if (actualDigest !== expectedDigest) {
    throw new Error("Update-Integritätsprüfung fehlgeschlagen (SHA256 mismatch)");
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

async function downloadFile(url: string, targetPath: string): Promise<void> {
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
        "User-Agent": UPDATE_USER_AGENT
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

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const source = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  const target = fs.createWriteStream(targetPath);
  const idleTimeoutMs = getDownloadBodyIdleTimeoutMs();
  let idleTimer: NodeJS.Timeout | null = null;
  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const onIdleTimeout = (): void => {
    const timeoutError = new Error(`Update Download Body Timeout nach ${Math.ceil(idleTimeoutMs / 1000)}s`);
    source.destroy(timeoutError);
    target.destroy(timeoutError);
  };
  const resetIdleTimer = (): void => {
    if (idleTimeoutMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(onIdleTimeout, idleTimeoutMs);
  };

  const onSourceData = (): void => {
    resetIdleTimer();
  };
  const onSourceDone = (): void => {
    clearIdleTimer();
  };

  if (idleTimeoutMs > 0) {
    source.on("data", onSourceData);
    source.on("end", onSourceDone);
    source.on("close", onSourceDone);
    source.on("error", onSourceDone);
    target.on("close", onSourceDone);
    target.on("error", onSourceDone);
    resetIdleTimer();
  }

  try {
    await pipeline(source, target);
  } catch (error) {
    try {
      source.destroy();
    } catch {
      // ignore
    }
    try {
      target.destroy();
    } catch {
      // ignore
    }
    throw error;
  } finally {
    clearIdleTimer();
    source.off("data", onSourceData);
    source.off("end", onSourceDone);
    source.off("close", onSourceDone);
    source.off("error", onSourceDone);
    target.off("close", onSourceDone);
    target.off("error", onSourceDone);
  }
  logger.info(`Update-Download abgeschlossen: ${targetPath}`);
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

async function downloadWithRetries(url: string, targetPath: string): Promise<void> {
  const shutdownSignal = activeUpdateAbortController?.signal;
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES_PER_CANDIDATE; attempt += 1) {
    if (shutdownSignal?.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    try {
      await downloadFile(url, targetPath);
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

async function downloadFromCandidates(candidates: string[], targetPath: string): Promise<void> {
  const shutdownSignal = activeUpdateAbortController?.signal;
  let lastError: unknown = new Error("Update Download fehlgeschlagen");

  logger.info(`Update-Download: ${candidates.length} Kandidat(en), je ${RETRIES_PER_CANDIDATE} Versuche`);
  for (let index = 0; index < candidates.length; index += 1) {
    if (shutdownSignal?.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    const candidate = candidates[index];
    try {
      await downloadWithRetries(candidate, targetPath);
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

export async function installLatestUpdate(repo: string, prechecked?: UpdateCheckResult): Promise<UpdateInstallResult> {
  if (activeUpdateAbortController && !activeUpdateAbortController.signal.aborted) {
    return { started: false, message: "Update-Download läuft bereits" };
  }
  const updateAbortController = new AbortController();
  activeUpdateAbortController = updateAbortController;

  const safeRepo = normalizeUpdateRepo(repo);
  const check = prechecked && !prechecked.error
    ? prechecked
    : await checkGitHubUpdate(safeRepo);

  if (check.error) {
    return { started: false, message: check.error };
  }
  if (!check.updateAvailable) {
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

  const candidates = buildDownloadCandidates(safeRepo, effectiveCheck);
  if (candidates.length === 0) {
    return { started: false, message: "Setup-Asset nicht gefunden" };
  }

  const fileName = deriveUpdateFileName(effectiveCheck, candidates[0]);
  const targetPath = path.join(os.tmpdir(), "rd-update", `${Date.now()}-${process.pid}-${crypto.randomUUID()}-${fileName}`);

  try {
    if (updateAbortController.signal.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    await downloadFromCandidates(candidates, targetPath);
    if (updateAbortController.signal.aborted) {
      throw new Error("aborted:update_shutdown");
    }
    await verifyDownloadedInstaller(targetPath, String(effectiveCheck.setupAssetDigest || ""));
    const child = spawn(targetPath, [], {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", (spawnError) => {
      logger.error(`Update-Installer Start fehlgeschlagen: ${compactErrorText(spawnError)}`);
    });
    child.unref();
    return { started: true, message: "Update-Installer gestartet" };
  } catch (error) {
    try {
      await fs.promises.rm(targetPath, { force: true });
    } catch {
      // ignore
    }
    const releaseUrl = String(effectiveCheck.releaseUrl || "").trim();
    const hint = releaseUrl ? ` – Manuell: ${releaseUrl}` : "";
    return { started: false, message: `${compactErrorText(error)}${hint}` };
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
