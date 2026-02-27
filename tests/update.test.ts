import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGitHubUpdate, normalizeUpdateRepo } from "../src/main/update";
import { APP_VERSION } from "../src/main/constants";

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
  });
});
