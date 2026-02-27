import { APP_VERSION, DEFAULT_UPDATE_REPO } from "./constants";
import { UpdateCheckResult } from "../shared/types";
import { compactErrorText } from "./utils";

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

    return {
      updateAvailable: isRemoteNewer(APP_VERSION, latestVersion),
      currentVersion: APP_VERSION,
      latestVersion,
      latestTag,
      releaseUrl
    };
  } catch (error) {
    return {
      ...fallback,
      error: compactErrorText(error)
    };
  }
}
