import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { APP_VERSION, DEFAULT_UPDATE_REPO } from "./constants";
import { UpdateCheckResult, UpdateInstallResult } from "../shared/types";
import { compactErrorText } from "./utils";

type ReleaseAsset = { name: string; browser_download_url: string };

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
  const safeRepo = (repo || DEFAULT_UPDATE_REPO).trim() || DEFAULT_UPDATE_REPO;
  const fallback: UpdateCheckResult = {
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    latestTag: `v${APP_VERSION}`,
    releaseUrl: `https://github.com/${safeRepo}/releases/latest`
  };

  try {
    const response = await fetch(`https://api.github.com/repos/${safeRepo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "RD-Node-Downloader/1.1.14"
      }
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      const reason = String((payload?.message as string) || `HTTP ${response.status}`);
      return { ...fallback, error: reason };
    }

    const latestTag = String(payload.tag_name || `v${APP_VERSION}`).trim();
    const latestVersion = latestTag.replace(/^v/i, "") || APP_VERSION;
    const releaseUrl = String(payload.html_url || fallback.releaseUrl);
    const assets = Array.isArray(payload.assets) ? payload.assets as Array<Record<string, unknown>> : [];
    const setup = assets
      .map((asset) => ({
        name: String(asset.name || ""),
        browser_download_url: String(asset.browser_download_url || "")
      }))
      .find((asset) => /\.setup\..*\.exe$/i.test(asset.name));

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
  const response = await fetch(url, {
    headers: {
      "User-Agent": "RD-Node-Downloader/1.1.18"
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Update Download fehlgeschlagen (HTTP ${response.status})`);
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const stream = fs.createWriteStream(targetPath);
  await new Promise<void>((resolve, reject) => {
    const reader = response.body!.getReader();
    const pump = (): void => {
      void reader.read().then(({ done, value }) => {
        if (done) {
          stream.end(() => resolve());
          return;
        }
        if (value) {
          stream.write(Buffer.from(value));
        }
        pump();
      }).catch((error) => {
        stream.destroy();
        reject(error);
      });
    };
    pump();
  });
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
  const targetPath = path.join(os.tmpdir(), "rd-update", fileName);
  try {
    await downloadFile(downloadUrl, targetPath);
    const child = spawn(targetPath, [], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return { started: true, message: "Update-Installer gestartet" };
  } catch (error) {
    return { started: false, message: compactErrorText(error) };
  }
}
