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

export async function checkGitHubUpdate(repo: string): Promise<UpdateCheckResult> {
  const safeRepo = normalizeUpdateRepo(repo);
  const fallback: UpdateCheckResult = {
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    latestTag: `v${APP_VERSION}`,
    releaseUrl: `https://github.com/${safeRepo}/releases/latest`
  };

  try {
    const timeout = timeoutController(15000);
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${safeRepo}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "RD-Node-Downloader/1.1.14"
        },
        signal: timeout.signal
      });
    } finally {
      timeout.clear();
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      const reason = String((payload?.message as string) || `HTTP ${response.status}`);
      return { ...fallback, error: reason };
    }

    const latestTag = String(payload.tag_name || `v${APP_VERSION}`).trim();
    const latestVersion = latestTag.replace(/^v/i, "") || APP_VERSION;
    const releaseUrl = String(payload.html_url || fallback.releaseUrl);
    const assets = Array.isArray(payload.assets) ? payload.assets as Array<Record<string, unknown>> : [];
    const exeAssets = assets
      .map((asset) => ({
        name: String(asset.name || ""),
        browser_download_url: String(asset.browser_download_url || "")
      }))
      .filter((asset) => asset.browser_download_url && /\.exe$/i.test(asset.name));
    const setup = exeAssets.find((asset) => /setup/i.test(asset.name))
      || exeAssets.find((asset) => !/portable/i.test(asset.name));

    return {
      updateAvailable: isRemoteNewer(APP_VERSION, latestVersion),
      currentVersion: APP_VERSION,
      latestVersion,
      latestTag,
      releaseUrl,
      setupAssetUrl: setup?.browser_download_url || ""
    };
  } catch (error) {
    return {
      ...fallback,
      error: compactErrorText(error)
    };
  }
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  const timeout = timeoutController(10 * 60 * 1000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "RD-Node-Downloader/1.1.18"
      },
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
}

export async function installLatestUpdate(repo: string): Promise<UpdateInstallResult> {
  const check = await checkGitHubUpdate(repo);
  if (check.error) {
    return { started: false, message: check.error };
  }
  if (!check.updateAvailable) {
    return { started: false, message: "Kein neues Update verfügbar" };
  }
  const downloadUrl = check.setupAssetUrl || check.releaseUrl;
  if (!check.setupAssetUrl) {
    return { started: false, message: "Setup-Asset nicht gefunden" };
  }

  const fileName = path.basename(new URL(downloadUrl).pathname || "update.exe") || "update.exe";
  const targetPath = path.join(os.tmpdir(), "rd-update", `${Date.now()}-${fileName}`);
  try {
    await downloadFile(downloadUrl, targetPath);
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
    return { started: false, message: compactErrorText(error) };
  }
}
