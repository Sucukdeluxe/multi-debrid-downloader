import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const RETRIES_PER_CANDIDATE = 3;
const RETRY_DELAY_MS = 1500;
const UPDATE_USER_AGENT = `RD-Node-Downloader/${APP_VERSION}`;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export function normalizeUpdateRepo(repo: string): string {
  const raw = String(repo || "").trim();
  if (!raw) {
    return DEFAULT_UPDATE_REPO;
  }

  const normalizeParts = (input: string): string => {
    const cleaned = input
      .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
      .replace(/^(?:www\.)?github\.com\//i, "")
      .replace(/^git@github\.com:/i, "")
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "");
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
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

function parseVersionParts(version: string): number[] {
  const cleaned = version.replace(/^v/i, "").trim();
  return cleaned.split(".").map((part) => Number(part.replace(/[^0-9].*$/, "") || "0"));
}

function isRemoteNewer(currentVersion: string, latestVersion: string): boolean {
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
      browser_download_url: String(asset.browser_download_url || "")
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
    setupAssetName: setup?.name || ""
  };
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
  } finally {
    timeout.clear();
  }

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
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

function isRecoverableDownloadError(error: unknown): boolean {
  const status = readHttpStatusFromError(error);
  if (status === 404 || status === 403 || status === 429 || status >= 500) {
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

function deriveUpdateFileName(check: UpdateCheckResult, url: string): string {
  const fromName = String(check.setupAssetName || "").trim();
  if (fromName) {
    return fromName;
  }
  try {
    const parsed = new URL(url);
    return path.basename(parsed.pathname || "update.exe") || "update.exe";
  } catch {
    return "update.exe";
  }
}

async function resolveSetupAssetFromApi(safeRepo: string, tagHint: string): Promise<{ setupAssetUrl: string; setupAssetName: string } | null> {
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
      const setup = pickSetupAsset(readReleaseAssets(release.payload));
      if (!setup) {
        continue;
      }
      return {
        setupAssetUrl: setup.browser_download_url,
        setupAssetName: setup.name
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
  logger.info(`Update-Download versucht: ${url}`);
  const timeout = timeoutController(CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": UPDATE_USER_AGENT
      },
      redirect: "follow",
      signal: timeout.signal
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
  await pipeline(source, target);
  logger.info(`Update-Download abgeschlossen: ${targetPath}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetries(url: string, targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES_PER_CANDIDATE; attempt += 1) {
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
      if (attempt < RETRIES_PER_CANDIDATE && isRecoverableDownloadError(error)) {
        logger.warn(`Update-Download Retry ${attempt}/${RETRIES_PER_CANDIDATE} für ${url}: ${compactErrorText(error)}`);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function downloadFromCandidates(candidates: string[], targetPath: string): Promise<void> {
  let lastError: unknown = new Error("Update Download fehlgeschlagen");

  logger.info(`Update-Download: ${candidates.length} Kandidat(en), je ${RETRIES_PER_CANDIDATE} Versuche`);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await downloadWithRetries(candidate, targetPath);
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`Update-Download Kandidat ${index + 1}/${candidates.length} endgültig fehlgeschlagen: ${compactErrorText(error)}`);
      if (index < candidates.length - 1 && isRecoverableDownloadError(error)) {
        continue;
      }
      break;
    }
  }

  throw lastError;
}

export async function installLatestUpdate(repo: string, prechecked?: UpdateCheckResult): Promise<UpdateInstallResult> {
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
    setupAssetName: String(check.setupAssetName || "")
  };

  if (!effectiveCheck.setupAssetUrl) {
    const refreshed = await resolveSetupAssetFromApi(safeRepo, effectiveCheck.latestTag);
    if (refreshed) {
      effectiveCheck = {
        ...effectiveCheck,
        setupAssetUrl: refreshed.setupAssetUrl,
        setupAssetName: refreshed.setupAssetName
      };
    }
  }

  const candidates = buildDownloadCandidates(safeRepo, effectiveCheck);
  if (candidates.length === 0) {
    return { started: false, message: "Setup-Asset nicht gefunden" };
  }

  const fileName = deriveUpdateFileName(effectiveCheck, candidates[0]);
  const targetPath = path.join(os.tmpdir(), "rd-update", `${Date.now()}-${fileName}`);

  try {
    await downloadFromCandidates(candidates, targetPath);
    const child = spawn(targetPath, [], {
      detached: true,
      stdio: "ignore"
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
  }
}
