import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGitHubUpdate, installLatestUpdate, isRemoteNewer, normalizeUpdateRepo, parseVersionParts } from "../src/main/update";
import { APP_VERSION } from "../src/main/constants";
import { UpdateCheckResult } from "../src/shared/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("update", () => {
  it("normalizes update repo input", () => {
    expect(normalizeUpdateRepo("")).toBe("Sucukdeluxe/real-debrid-downloader");
    expect(normalizeUpdateRepo("owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://www.github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://github.com/owner/repo/releases/tag/v1.2.3")).toBe("owner/repo");
    expect(normalizeUpdateRepo("github.com/owner/repo.git")).toBe("owner/repo");
    expect(normalizeUpdateRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  it("uses normalized repo slug for GitHub API requests", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(
        JSON.stringify({
          tag_name: `v${APP_VERSION}`,
          html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
          assets: []
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as typeof fetch;

    const result = await checkGitHubUpdate("https://github.com/owner/repo/releases");
    expect(requestedUrl).toBe("https://api.github.com/repos/owner/repo/releases/latest");
    expect(result.currentVersion).toBe(APP_VERSION);
    expect(result.latestVersion).toBe(APP_VERSION);
    expect(result.updateAvailable).toBe(false);
  });

  it("picks setup executable asset from release list", async () => {
    globalThis.fetch = (async (): Promise<Response> => new Response(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/owner/repo/releases/tag/v9.9.9",
        assets: [
          {
            name: "Real-Debrid-Downloader 9.9.9.exe",
            browser_download_url: "https://example.invalid/portable.exe"
          },
          {
            name: "Real-Debrid-Downloader Setup 9.9.9.exe",
            browser_download_url: "https://example.invalid/setup.exe"
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )) as typeof fetch;

    const result = await checkGitHubUpdate("owner/repo");
    expect(result.updateAvailable).toBe(true);
    expect(result.setupAssetUrl).toBe("https://example.invalid/setup.exe");
    expect(result.setupAssetName).toBe("Real-Debrid-Downloader Setup 9.9.9.exe");
  });

  it("falls back to alternate download URL when setup asset URL returns 404", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.includes("stale-setup.exe")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("/releases/latest/download/")) {
        return new Response(executablePayload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" }
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const prechecked: UpdateCheckResult = {
      updateAvailable: true,
      currentVersion: APP_VERSION,
      latestVersion: "9.9.9",
      latestTag: "v9.9.9",
      releaseUrl: "https://github.com/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "https://example.invalid/stale-setup.exe",
      setupAssetName: "Real-Debrid-Downloader Setup 9.9.9.exe"
    };

    const result = await installLatestUpdate("owner/repo", prechecked);
    expect(result.started).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/releases/latest/download/"))).toBe(true);
  });
});

describe("normalizeUpdateRepo extended", () => {
  it("handles trailing slashes and extra path segments", () => {
    expect(normalizeUpdateRepo("owner/repo/")).toBe("owner/repo");
    expect(normalizeUpdateRepo("/owner/repo/")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://github.com/owner/repo/tree/main/src")).toBe("owner/repo");
  });

  it("handles ssh-style git URLs", () => {
    expect(normalizeUpdateRepo("git@github.com:user/project.git")).toBe("user/project");
  });

  it("returns default for malformed inputs", () => {
    expect(normalizeUpdateRepo("just-one-part")).toBe("Sucukdeluxe/real-debrid-downloader");
    expect(normalizeUpdateRepo("   ")).toBe("Sucukdeluxe/real-debrid-downloader");
  });

  it("handles www prefix", () => {
    expect(normalizeUpdateRepo("https://www.github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("www.github.com/owner/repo")).toBe("owner/repo");
  });
});

describe("isRemoteNewer", () => {
  it("detects newer major version", () => {
    expect(isRemoteNewer("1.0.0", "2.0.0")).toBe(true);
  });

  it("detects newer minor version", () => {
    expect(isRemoteNewer("1.2.0", "1.3.0")).toBe(true);
  });

  it("detects newer patch version", () => {
    expect(isRemoteNewer("1.2.3", "1.2.4")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(isRemoteNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false for older version", () => {
    expect(isRemoteNewer("2.0.0", "1.0.0")).toBe(false);
    expect(isRemoteNewer("1.3.0", "1.2.0")).toBe(false);
    expect(isRemoteNewer("1.2.4", "1.2.3")).toBe(false);
  });

  it("handles versions with different segment counts", () => {
    expect(isRemoteNewer("1.2", "1.2.1")).toBe(true);
    expect(isRemoteNewer("1.2.1", "1.2")).toBe(false);
    expect(isRemoteNewer("1", "1.0.1")).toBe(true);
  });

  it("handles v-prefix in version strings", () => {
    expect(isRemoteNewer("v1.0.0", "v2.0.0")).toBe(true);
    expect(isRemoteNewer("v1.0.0", "v1.0.0")).toBe(false);
  });
});

describe("parseVersionParts", () => {
  it("parses standard version strings", () => {
    expect(parseVersionParts("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersionParts("10.20.30")).toEqual([10, 20, 30]);
  });

  it("strips v prefix", () => {
    expect(parseVersionParts("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersionParts("V1.2.3")).toEqual([1, 2, 3]);
  });

  it("handles single segment", () => {
    expect(parseVersionParts("5")).toEqual([5]);
  });

  it("handles version with pre-release suffix", () => {
    // Non-numeric suffixes are stripped per part
    expect(parseVersionParts("1.2.3-beta")).toEqual([1, 2, 3]);
    expect(parseVersionParts("1.2.3rc1")).toEqual([1, 2, 3]);
  });

  it("handles empty and whitespace", () => {
    expect(parseVersionParts("")).toEqual([0]);
    expect(parseVersionParts("  ")).toEqual([0]);
  });

  it("handles versions with extra dots", () => {
    expect(parseVersionParts("1.2.3.4")).toEqual([1, 2, 3, 4]);
  });
});
