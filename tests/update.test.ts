import fs from "node:fs";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, unrefMock, onceMock } = vi.hoisted(() => {
  const unref = vi.fn();
  const once = vi.fn((_event: string, _handler: (...args: unknown[]) => void) => ({
    unref
  }));
  const spawn = vi.fn(() => ({
    once,
    unref
  }));
  return {
    spawnMock: spawn,
    unrefMock: unref,
    onceMock: once
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

import { buildInstallerLaunchArgs, checkGitHubUpdate, installLatestUpdate, isRemoteNewer, normalizeUpdateRepo, parseVersionParts } from "../src/main/update";
import { APP_VERSION } from "../src/main/constants";
import { UpdateCheckResult, UpdateInstallProgress } from "../src/shared/types";

const originalFetch = globalThis.fetch;

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha512Hex(buffer: Buffer): string {
  return crypto.createHash("sha512").update(buffer).digest("hex");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  spawnMock.mockClear();
  unrefMock.mockClear();
  onceMock.mockClear();
  vi.restoreAllMocks();
});

describe("update", () => {
  it("normalizes update repo input", () => {
    expect(normalizeUpdateRepo("")).toBe("Administrator/real-debrid-downloader");
    expect(normalizeUpdateRepo("owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://codeberg.org/owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://www.codeberg.org/owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://codeberg.org/owner/repo/releases/tag/v1.2.3")).toBe("owner/repo");
    expect(normalizeUpdateRepo("codeberg.org/owner/repo.git")).toBe("owner/repo");
    expect(normalizeUpdateRepo("git@codeberg.org:owner/repo.git")).toBe("owner/repo");
  });

  it("uses normalized repo slug for API requests", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(
        JSON.stringify({
          tag_name: `v${APP_VERSION}`,
          html_url: "https://git.24-music.de/owner/repo/releases/tag/v1.0.0",
          assets: []
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as typeof fetch;

    const result = await checkGitHubUpdate("https://git.24-music.de/owner/repo/releases");
    expect(requestedUrl).toBe("https://git.24-music.de/api/v1/repos/owner/repo/releases/latest");
    expect(result.currentVersion).toBe(APP_VERSION);
    expect(result.latestVersion).toBe(APP_VERSION);
    expect(result.updateAvailable).toBe(false);
  });

  it("picks setup executable asset from release list", async () => {
    globalThis.fetch = (async (): Promise<Response> => new Response(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
        assets: [
          {
            name: "Real-Debrid-Downloader 9.9.9.exe",
            browser_download_url: "https://example.invalid/portable.exe"
          },
          {
            name: "Real-Debrid-Downloader Setup 9.9.9.exe",
            browser_download_url: "https://example.invalid/setup.exe",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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

  it("uses silent NSIS install flags with auto-run after update", () => {
    expect(buildInstallerLaunchArgs()).toEqual(["/S", "--updated", "--force-run"]);
  });

  it("falls back to alternate download URL when setup asset URL returns 404", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    const executableDigest = sha256Hex(executablePayload);
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.includes("stale-setup.exe")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("/releases/download/v9.9.9/")) {
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
      releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "https://example.invalid/stale-setup.exe",
      setupAssetName: "Real-Debrid-Downloader Setup 9.9.9.exe",
      setupAssetDigest: `sha256:${executableDigest}`
    };

    const result = await installLatestUpdate("owner/repo", prechecked);
    expect(result.started).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/releases/download/v9.9.9/"))).toBe(true);
    expect(requestedUrls.filter((url) => url.includes("stale-setup.exe"))).toHaveLength(1);
  });

  it("skips draft tag payload and resolves setup asset from stable latest release", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.endsWith("/releases/tags/v9.9.9")) {
        return new Response(JSON.stringify({
          tag_name: "v9.9.9",
          draft: true,
          prerelease: false,
          assets: [
            {
              name: "Draft Setup 9.9.9.exe",
              browser_download_url: "https://example.invalid/draft-setup.exe"
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.endsWith("/releases/latest")) {
        const stableDigest = sha256Hex(executablePayload);
        return new Response(JSON.stringify({
          tag_name: "v9.9.9",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Stable Setup 9.9.9.exe",
              browser_download_url: "https://example.invalid/stable-setup.exe",
              digest: `sha256:${stableDigest}`
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.includes("stable-setup.exe")) {
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
      releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "",
      setupAssetName: ""
    };

    const result = await installLatestUpdate("owner/repo", prechecked);
    expect(result.started).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/releases/tags/v9.9.9"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/releases/latest"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("stable-setup.exe"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("draft-setup.exe"))).toBe(false);
  });

  it("times out hanging release JSON body reads", async () => {
    vi.useFakeTimers();
    try {
      const cancelSpy = vi.fn(async () => undefined);
      globalThis.fetch = (async (): Promise<Response> => ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => new Promise(() => undefined),
        body: {
          cancel: cancelSpy
        }
      } as unknown as Response)) as typeof fetch;

      const pending = checkGitHubUpdate("owner/repo");
      await vi.advanceTimersByTimeAsync(13000);
      const result = await pending;
      expect(result.updateAvailable).toBe(false);
      expect(String(result.error || "")).toMatch(/timeout/i);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts hanging update body downloads on idle timeout", async () => {
    const previousTimeout = process.env.RD_UPDATE_BODY_IDLE_TIMEOUT_MS;
    process.env.RD_UPDATE_BODY_IDLE_TIMEOUT_MS = "1000";

    try {
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("hang-setup.exe")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            }
          });
          return new Response(body, {
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
        releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
        setupAssetUrl: "https://example.invalid/hang-setup.exe",
        setupAssetName: "",
        setupAssetDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      };

      const result = await installLatestUpdate("owner/repo", prechecked);
      expect(result.started).toBe(false);
      expect(result.message).toMatch(/timeout/i);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.RD_UPDATE_BODY_IDLE_TIMEOUT_MS;
      } else {
        process.env.RD_UPDATE_BODY_IDLE_TIMEOUT_MS = previousTimeout;
      }
    }
  }, 20000);

  it("blocks installer start when SHA256 digest mismatches", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("mismatch-setup.exe")) {
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
      releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "https://example.invalid/mismatch-setup.exe",
      setupAssetName: "setup.exe",
      setupAssetDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    };

    const result = await installLatestUpdate("owner/repo", prechecked);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/integrit|sha256|mismatch/i);
  });

  it("uses latest.yml SHA512 digest when API asset digest is missing", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    const digestSha512Hex = sha512Hex(executablePayload);
    const digestSha512Base64 = Buffer.from(digestSha512Hex, "hex").toString("base64");
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.endsWith("/releases/tags/v9.9.9")) {
        return new Response(JSON.stringify({
          tag_name: "v9.9.9",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Real-Debrid-Downloader Setup 9.9.9.exe",
              browser_download_url: "https://example.invalid/setup-no-digest.exe"
            },
            {
              name: "latest.yml",
              browser_download_url: "https://example.invalid/latest.yml"
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.includes("latest.yml")) {
        return new Response(
          `version: 9.9.9\npath: Real-Debrid-Downloader-Setup-9.9.9.exe\nsha512: ${digestSha512Base64}\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/yaml" }
          }
        );
      }

      if (url.includes("setup-no-digest.exe")) {
        return new Response(executablePayload, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(executablePayload.length)
          }
        });
      }

      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const prechecked: UpdateCheckResult = {
      updateAvailable: true,
      currentVersion: APP_VERSION,
      latestVersion: "9.9.9",
      latestTag: "v9.9.9",
      releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "https://example.invalid/setup-no-digest.exe",
      setupAssetName: "Real-Debrid-Downloader Setup 9.9.9.exe",
      setupAssetDigest: ""
    };

    const result = await installLatestUpdate("owner/repo", prechecked);
    expect(result.started).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/releases/tags/v9.9.9"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("latest.yml"))).toBe(true);
  });

  it("rejects installer when latest.yml SHA512 digest does not match", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    const wrongDigestBase64 = Buffer.alloc(64, 0x13).toString("base64");

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/releases/tags/v9.9.9")) {
        return new Response(JSON.stringify({
          tag_name: "v9.9.9",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Real-Debrid-Downloader Setup 9.9.9.exe",
              browser_download_url: "https://example.invalid/setup-no-digest.exe"
            },
            {
              name: "latest.yml",
              browser_download_url: "https://example.invalid/latest.yml"
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.includes("latest.yml")) {
        return new Response(
          `version: 9.9.9\npath: Real-Debrid-Downloader Setup 9.9.9.exe\nsha512: ${wrongDigestBase64}\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/yaml" }
          }
        );
      }

      if (url.includes("setup-no-digest.exe")) {
        return new Response(executablePayload, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(executablePayload.length)
          }
        });
      }

      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const prechecked: UpdateCheckResult = {
      updateAvailable: true,
      currentVersion: APP_VERSION,
      latestVersion: "9.9.9",
      latestTag: "v9.9.9",
      releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "https://example.invalid/setup-no-digest.exe",
      setupAssetName: "Real-Debrid-Downloader Setup 9.9.9.exe",
      setupAssetDigest: ""
    };

    const result = await installLatestUpdate("owner/repo", prechecked);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/sha512|integrit|mismatch/i);
  });

  it("emits install progress events while downloading and launching update", async () => {
    const executablePayload = fs.readFileSync(process.execPath);
    const digest = sha256Hex(executablePayload);

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("progress-setup.exe")) {
        return new Response(executablePayload, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(executablePayload.length)
          }
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const prechecked: UpdateCheckResult = {
      updateAvailable: true,
      currentVersion: APP_VERSION,
      latestVersion: "9.9.9",
      latestTag: "v9.9.9",
      releaseUrl: "https://codeberg.org/owner/repo/releases/tag/v9.9.9",
      setupAssetUrl: "https://example.invalid/progress-setup.exe",
      setupAssetName: "setup.exe",
      setupAssetDigest: `sha256:${digest}`
    };

    const progressEvents: UpdateInstallProgress[] = [];
    const result = await installLatestUpdate("owner/repo", prechecked, (progress) => {
      progressEvents.push(progress);
    });

    expect(result.started).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(expect.any(String), ["/S", "--updated", "--force-run"], expect.objectContaining({
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }));
    expect(unrefMock).toHaveBeenCalledTimes(1);
    expect(progressEvents.some((entry) => entry.stage === "starting")).toBe(true);
    expect(progressEvents.some((entry) => entry.stage === "downloading")).toBe(true);
    expect(progressEvents.some((entry) => entry.stage === "verifying")).toBe(true);
    expect(progressEvents.some((entry) => entry.stage === "launching")).toBe(true);
    expect(progressEvents.some((entry) => entry.stage === "done")).toBe(true);
  });
});

describe("normalizeUpdateRepo extended", () => {
  it("handles trailing slashes and extra path segments", () => {
    expect(normalizeUpdateRepo("owner/repo/")).toBe("owner/repo");
    expect(normalizeUpdateRepo("/owner/repo/")).toBe("owner/repo");
    expect(normalizeUpdateRepo("https://codeberg.org/owner/repo/tree/main/src")).toBe("owner/repo");
  });

  it("handles ssh-style git URLs", () => {
    expect(normalizeUpdateRepo("git@codeberg.org:user/project.git")).toBe("user/project");
  });

  it("returns default for malformed inputs", () => {
    expect(normalizeUpdateRepo("just-one-part")).toBe("Administrator/real-debrid-downloader");
    expect(normalizeUpdateRepo("   ")).toBe("Administrator/real-debrid-downloader");
  });

  it("rejects traversal-like owner or repo segments", () => {
    expect(normalizeUpdateRepo("../owner/repo")).toBe("Administrator/real-debrid-downloader");
    expect(normalizeUpdateRepo("owner/../repo")).toBe("Administrator/real-debrid-downloader");
    expect(normalizeUpdateRepo("https://codeberg.org/owner/../../repo")).toBe("Administrator/real-debrid-downloader");
  });

  it("handles www prefix", () => {
    expect(normalizeUpdateRepo("https://www.codeberg.org/owner/repo")).toBe("owner/repo");
    expect(normalizeUpdateRepo("www.codeberg.org/owner/repo")).toBe("owner/repo");
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
