import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, REQUEST_RETRIES } from "../src/main/constants";
import { parseDebridLinkApiKeys } from "../src/shared/debrid-link-keys";
import { getProviderUsageDayKey } from "../src/shared/provider-daily-limits";
import { DebridService, extractRapidgatorFilenameFromHtml, fetchAllDebridHostInfo, fetchDebridLinkHostLimits, filenameFromRapidgatorUrlPath, getDebridLinkKeyRuntimeStateForTests, normalizeResolvedFilename, resetDebridLinkRuntimeStateForTests, resetMegaDebridRuntimeStateForTests } from "../src/main/debrid";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDebridLinkRuntimeStateForTests();
  resetMegaDebridRuntimeStateForTests();
  vi.restoreAllMocks();
});

describe("debrid service", () => {
  it("falls back to Mega web when Real-Debrid fails", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      bestToken: "",
      providerOrder: [] as const,
      providerPrimary: "realdebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "bestdebrid" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        return new Response(JSON.stringify({ error: "traffic_limit" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const megaWeb = vi.fn(async () => ({
      fileName: "file.bin",
      directUrl: "https://mega-web.example/file.bin",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    const result = await service.unrestrictLink("https://rapidgator.net/file/example.part1.rar.html");
    expect(result.provider).toBe("megadebrid");
    expect(result.directUrl).toBe("https://mega-web.example/file.bin");
    expect(megaWeb).toHaveBeenCalledTimes(1);
  });

  it("does not fallback when auto fallback is disabled", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "bestdebrid" as const,
      autoProviderFallback: false
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        return new Response("traffic exhausted", { status: 429 });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const megaWeb = vi.fn(async () => ({
      fileName: "unused.bin",
      directUrl: "https://unused",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    await expect(service.unrestrictLink("https://rapidgator.net/file/example.part2.rar.html")).rejects.toThrow();
    expect(megaWeb).toHaveBeenCalledTimes(0);
  });

  it("skips a provider whose daily limit is already reached and uses the next provider", async () => {
    const calledUrls: string[] = [];
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      debridLinkApiKeys: "dl-token",
      providerOrder: ["realdebrid", "debridlink"] as const,
      providerPrimary: "realdebrid" as const,
      providerSecondary: "debridlink" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true,
      providerDailyLimitBytes: { realdebrid: 100 },
      providerDailyUsageBytes: { realdebrid: 100 },
      providerDailyUsageDay: getProviderUsageDayKey()
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calledUrls.push(url);
      if (url.includes("debrid-link.com/api/v2/downloader/add")) {
        return new Response(JSON.stringify({
          success: true,
          value: {
            downloadUrl: "https://debrid-link.example/file.bin",
            name: "file.bin",
            size: 1234
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        throw new Error("Real-Debrid should have been skipped due to daily limit");
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://hoster.example/file.bin");
    expect(result.provider).toBe("debridlink");
    expect(result.directUrl).toBe("https://debrid-link.example/file.bin");
    expect(calledUrls.some((url) => url.includes("api.real-debrid.com/rest/1.0/unrestrict/link"))).toBe(false);
  });

  it("uses the next Debrid-Link key when the first key hit its local daily limit", async () => {
    const keys = parseDebridLinkApiKeys("dl-key-one\ndl-key-two");
    let usedAuthHeader = "";
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      debridLinkApiKeyDailyLimitBytes: {
        [keys[0].id]: 100
      },
      debridLinkApiKeyDailyUsageBytes: {
        [keys[0].id]: 100
      },
      providerDailyUsageDay: getProviderUsageDayKey()
    };

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers;
      if (headers instanceof Headers) {
        usedAuthHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        usedAuthHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        usedAuthHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }
      return new Response(JSON.stringify({
        success: true,
        value: {
          downloadUrl: "https://debrid-link.example/file.bin",
          name: "file.bin",
          size: 1234
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://hoster.example/file.bin");

    expect(usedAuthHeader).toBe("Bearer dl-key-two");
    expect(result.provider).toBe("debridlink");
    expect(result.providerLabel).toContain("Key 2");
  });

  it("uses JSON add payload and refreshes missing Debrid-Link downloadUrl via downloader/list", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    let addBody = "";
    let addContentType = "";
    let addAccept = "";
    const calledUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calledUrls.push(url);
      if (url.includes("debrid-link.com/api/v2/downloader/add")) {
        const headers = init?.headers;
        if (headers instanceof Headers) {
          addContentType = headers.get("Content-Type") || "";
          addAccept = headers.get("Accept") || "";
        } else if (Array.isArray(headers)) {
          addContentType = headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
          addAccept = headers.find(([key]) => key.toLowerCase() === "accept")?.[1] || "";
        } else {
          addContentType = String((headers as Record<string, unknown> | undefined)?.["Content-Type"] || "");
          addAccept = String((headers as Record<string, unknown> | undefined)?.Accept || "");
        }
        addBody = String(init?.body || "");
        return new Response(JSON.stringify({
          success: true,
          value: {
            id: "dl-link-1",
            url: "https://hoster.example/file.bin",
            name: "file.bin",
            expired: true
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("debrid-link.com/api/v2/downloader/list?ids=dl-link-1")) {
        return new Response(JSON.stringify({
          success: true,
          value: [
            {
              id: "dl-link-1",
              url: "https://hoster.example/file.bin",
              name: "file.bin",
              downloadUrl: "https://debrid-link.example/file.bin",
              size: 1234,
              expired: false
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://hoster.example/file.bin");

    expect(addContentType).toBe("application/json");
    expect(addAccept).toBe("application/json");
    expect(addBody).toBe(JSON.stringify({ url: "https://hoster.example/file.bin" }));
    expect(result.provider).toBe("debridlink");
    expect(result.directUrl).toBe("https://debrid-link.example/file.bin");
    expect(calledUrls.some((url) => url.includes("debrid-link.com/api/v2/downloader/list?ids=dl-link-1"))).toBe(true);
  });

  it("rotates to the next Debrid-Link key when the first key is invalid", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const authHeaders: string[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers;
      let authHeader = "";
      if (headers instanceof Headers) {
        authHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        authHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }
      authHeaders.push(authHeader);
      if (authHeader === "Bearer dl-key-one") {
        return new Response(JSON.stringify({
          success: false,
          error: "badToken",
          error_description: "token expired"
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        success: true,
        value: {
          downloadUrl: "https://debrid-link.example/valid.bin",
          name: "valid.bin",
          size: 2048
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://hoster.example/needs-rotation.bin");

    expect(authHeaders).toEqual(["Bearer dl-key-one", "Bearer dl-key-two"]);
    expect(result.provider).toBe("debridlink");
    expect(result.providerLabel).toContain("Key 2");
    expect(result.directUrl).toBe("https://debrid-link.example/valid.bin");
  });

  it("looks up limits and rotates keys when Debrid-Link host quota is reached", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    let limitCalls = 0;
    const authHeaders: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = init?.headers;
      let authHeader = "";
      if (headers instanceof Headers) {
        authHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        authHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }

      if (url.includes("debrid-link.com/api/v2/downloader/limits")) {
        limitCalls += 1;
        return new Response(JSON.stringify({
          success: true,
          value: {
            nextResetSeconds: { value: 900 }
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      authHeaders.push(authHeader);
      if (authHeader === "Bearer dl-key-one") {
        return new Response(JSON.stringify({
          success: false,
          error: "maxDataHost",
          error_description: "host quota reached"
        }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        value: {
          downloadUrl: "https://debrid-link.example/quota-ok.bin",
          name: "quota-ok.bin",
          size: 4096
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/quota-test");

    expect(limitCalls).toBe(1);
    expect(authHeaders).toEqual(["Bearer dl-key-one", "Bearer dl-key-two"]);
    expect(result.provider).toBe("debridlink");
    expect(result.providerLabel).toContain("Key 2");
    expect(result.directUrl).toBe("https://debrid-link.example/quota-ok.bin");
  });

  it("scopes Debrid-Link maxDataHost cooldown to the (key, host) pair so the key stays usable for other hosters", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const unrestrictAuthHeaders: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = init?.headers;
      let authHeader = "";
      if (headers instanceof Headers) {
        authHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        authHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }

      if (url.includes("debrid-link.com/api/v2/downloader/limits")) {
        return new Response(JSON.stringify({
          success: true,
          value: { nextResetSeconds: { value: 900 } }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Only count calls to /downloader/add (the unrestrict endpoint)
      if (url.includes("/downloader/add")) {
        unrestrictAuthHeaders.push(authHeader);
        // Read the body to know which link is being unrestricted
        const bodyText = init?.body ? String(init.body) : "";
        const isRapidgator = /rapidgator/i.test(bodyText);
        // Only key-one + rapidgator returns maxDataHost. All other (key, host)
        // combinations succeed.
        if (authHeader === "Bearer dl-key-one" && isRapidgator) {
          return new Response(JSON.stringify({
            success: false,
            error: "maxDataHost",
            error_description: "host quota reached"
          }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          success: true,
          value: {
            downloadUrl: `https://debrid-link.example/${authHeader.slice(-3)}-${isRapidgator ? "rg" : "ot"}.bin`,
            name: "ok.bin",
            size: 1024
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);

    // 1) First rapidgator: key-one hits maxDataHost → key-two succeeds.
    const r1 = await service.unrestrictLink("https://rapidgator.net/file/first");
    expect(r1.providerLabel).toContain("Key 2");

    // 2) Second rapidgator request: key-one MUST be skipped (host cooldown
    //    on (key1, rapidgator)), only key-two should be tried.
    unrestrictAuthHeaders.length = 0;
    const r2 = await service.unrestrictLink("https://rapidgator.net/file/second");
    expect(unrestrictAuthHeaders).toEqual(["Bearer dl-key-two"]);
    expect(r2.providerLabel).toContain("Key 2");

    // 3) Different host: key-one must NOT be skipped — its host-cooldown is
    //    only for rapidgator, not for uploaded.net.
    unrestrictAuthHeaders.length = 0;
    const r3 = await service.unrestrictLink("https://uploaded.net/file/third");
    expect(unrestrictAuthHeaders).toEqual(["Bearer dl-key-one"]);
    expect(r3.providerLabel).toContain("Key 1");
  });

  it("does not mark Debrid-Link key as errored when the API returns fileNotAvailable (link-level, not key-level)", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = init?.headers;
      let authHeader = "";
      if (headers instanceof Headers) {
        authHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        authHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }

      if (!url.includes("/downloader/add")) {
        return new Response("not-found", { status: 404 });
      }
      if (authHeader === "Bearer dl-key-one") {
        return new Response(JSON.stringify({
          success: false,
          error: "fileNotAvailable",
          error_description: "link is currently not available"
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        success: true,
        value: {
          downloadUrl: "https://debrid-link.example/ok.bin",
          name: "ok.bin",
          size: 1024
        }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const key1Id = parseDebridLinkApiKeys("dl-key-one")[0].id;
    const key2Id = parseDebridLinkApiKeys("dl-key-two")[0].id;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/example");
    expect(result.providerLabel).toContain("Key 2");

    // Key-one responded normally — just that the link was unavailable on the
    // hoster side. Key-one is NOT broken and must not be flagged as "error".
    expect(getDebridLinkKeyRuntimeStateForTests(key1Id)).not.toBe("error");
    // Key-two served the link successfully, so it's "ready".
    expect(getDebridLinkKeyRuntimeStateForTests(key2Id)).toBe("ready");
  });

  it("treats bad Debrid-Link file passwords as fatal and does not rotate keys", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const authHeaders: string[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers;
      let authHeader = "";
      if (headers instanceof Headers) {
        authHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        authHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }
      authHeaders.push(authHeader);
      return new Response(JSON.stringify({
        success: false,
        error: "badFilePassword",
        error_description: "wrong password"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/protected.bin")).rejects.toThrow("wrong password");
    expect(authHeaders).toEqual(["Bearer dl-key-one"]);
  });

  it("returns a cooldown marker when all Debrid-Link keys are temporarily cooling down", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    let addCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("debrid-link.com/api/v2/downloader/add")) {
        return new Response("not-found", { status: 404 });
      }
      addCalls += 1;
      return new Response(JSON.stringify({
        success: false,
        error: "floodDetected",
        error_description: "too many requests"
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/cooldown.bin")).rejects.toThrow("API-Rate-Limit erreicht");
    await expect(service.unrestrictLink("https://hoster.example/cooldown.bin")).rejects.toThrow(/debrid_link_cooldown:\d+:/i);
    expect(addCalls).toBe(2);
  });

  it("returns an invalid-all marker when all Debrid-Link keys are invalid", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const authHeaders: string[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers;
      let authHeader = "";
      if (headers instanceof Headers) {
        authHeader = headers.get("Authorization") || "";
      } else if (Array.isArray(headers)) {
        authHeader = headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
      } else {
        authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
      }
      authHeaders.push(authHeader);
      return new Response(JSON.stringify({
        success: false,
        error: "badToken",
        error_description: "token expired"
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/all-invalid.bin")).rejects.toThrow(/debrid_link_invalid_all:/i);
    expect(authHeaders).toEqual(["Bearer dl-key-one", "Bearer dl-key-two"]);
  });

  it("returns a clear error when all Debrid-Link keys are locally exhausted", async () => {
    const keys = parseDebridLinkApiKeys("dl-key-one\ndl-key-two");
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      debridLinkApiKeyDailyLimitBytes: {
        [keys[0].id]: 100,
        [keys[1].id]: 100
      },
      debridLinkApiKeyDailyUsageBytes: {
        [keys[0].id]: 100,
        [keys[1].id]: 100
      },
      providerDailyUsageDay: getProviderUsageDayKey()
    };

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/no-key-left.bin")).rejects.toThrow(/debrid-link nicht verfuegbar|kein aktiver api-key/i);
  });

  it("stops rotation immediately on Debrid-Link notDebrid (provider-wide) — does NOT burn remaining keys", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const authHeaders: string[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      authHeaders.push(String((init?.headers as Record<string, string> | undefined)?.Authorization || ""));
      return new Response(JSON.stringify({
        success: false,
        error: "notDebrid",
        error_description: "notDebrid"
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/not-debrid.bin")).rejects.toThrow(/debrid_link_cooldown.*notDebrid/);
    // notDebrid is a host-level issue — only Key 1 should be tried, Key 2 must NOT be burned
    expect(authHeaders).toEqual(["Bearer dl-key-one"]);
  });

  it("continues to the next Debrid-Link key for non-provider-wide skip errors without caching a cooldown", async () => {
    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const authHeaders: string[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const authHeader = String((init?.headers as Record<string, string> | undefined)?.Authorization || "");
      authHeaders.push(authHeader);
      if (authHeader === "Bearer dl-key-one") {
        return new Response(JSON.stringify({
          success: false,
          error: "noServerHost",
          error_description: "host temporarily unavailable"
        }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        success: true,
        value: {
          downloadUrl: "https://debrid-link.example/second-key.bin",
          name: "second-key.bin",
          size: 4096
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://hoster.example/skip-key.bin");
    expect(result.directUrl).toBe("https://debrid-link.example/second-key.bin");
    expect(result.sourceAccountLabel).toBe("Key 2");
    expect(authHeaders).toEqual(["Bearer dl-key-one", "Bearer dl-key-two"]);
  });

  it("uses BestDebrid auth header without token query fallback", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "best-token",
      providerPrimary: "bestdebrid" as const,
      providerSecondary: "realdebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calledUrls.push(url);
      if (url.includes("/api/v1/generateLink?link=")) {
        return new Response(JSON.stringify({ download: "https://best.example/file.bin", filename: "file.bin", filesize: 2048 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/example.part3.rar.html");
    expect(result.provider).toBe("bestdebrid");
    expect(result.fileSize).toBe(2048);
    expect(calledUrls.some((url) => url.includes("auth="))).toBe(false);
  });

  it("sends Bearer auth header to BestDebrid", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "best-token",
      providerPrimary: "bestdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    let authHeader = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/generateLink?link=")) {
        const headers = init?.headers;
        if (headers instanceof Headers) {
          authHeader = headers.get("Authorization") || "";
        } else if (Array.isArray(headers)) {
          const tuple = headers.find(([key]) => key.toLowerCase() === "authorization");
          authHeader = tuple?.[1] || "";
        } else {
          authHeader = String((headers as Record<string, unknown> | undefined)?.Authorization || "");
        }
        return new Response(JSON.stringify({ download: "https://best.example/file.bin", filename: "file.bin", filesize: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://hoster.example/file/abc");
    expect(result.provider).toBe("bestdebrid");
    expect(authHeader).toBe("Bearer best-token");
  });

  it("does not retry BestDebrid auth failures (401)", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "best-token",
      providerPrimary: "bestdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/generateLink?link=")) {
        calls += 1;
        return new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/file/no-retry")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("does not retry AllDebrid auth failures (403)", async () => {
    const settings = {
      ...defaultSettings(),
      allDebridToken: "ad-token",
      providerOrder: [] as const,
      providerPrimary: "alldebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4/link/unlock")) {
        calls += 1;
        return new Response(JSON.stringify({ status: "error", error: { message: "forbidden" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://hoster.example/file/no-retry-ad")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("supports AllDebrid unlock", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "ad-token",
      providerOrder: [] as const,
      providerPrimary: "alldebrid" as const,
      providerSecondary: "realdebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4/link/unlock")) {
        return new Response(JSON.stringify({
          status: "success",
          data: {
            link: "https://alldebrid.example/file.bin",
            filename: "file.bin",
            filesize: 4096
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/example.part4.rar.html");
    expect(result.provider).toBe("alldebrid");
    expect(result.directUrl).toBe("https://alldebrid.example/file.bin");
    expect(result.fileSize).toBe(4096);
  });

  it("loads AllDebrid host info via api", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4.1/user/hosts")) {
        return new Response(JSON.stringify({
          status: "success",
          data: {
            hosts: {
              rapidgator: {
                name: "rapidgator",
                status: false,
                quota: 1200,
                quotaMax: 2400,
                quotaType: "traffic",
                limitSimuDl: 2
              }
            }
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const info = await fetchAllDebridHostInfo("ad-token", "rapidgator");
    expect(info.source).toBe("api");
    expect(info.host).toBe("rapidgator");
    expect(info.state).toBe("down");
    expect(info.statusLabel).toBe("Unverfügbar");
    expect(info.quota).toBe(1200);
    expect(info.quotaMax).toBe(2400);
    expect(info.quotaType).toBe("traffic");
    expect(info.limitSimuDl).toBe(2);
  });

  it("loads Debrid-Link rapidgator limits per api key", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("debrid-link.com/api/v2/downloader/limits/all")) {
        return new Response(JSON.stringify({
          success: true,
          value: {
            hosters: [
              {
                name: "rapidgator",
                daySize: { current: 0, value: 150323855360 },
                dayCount: { current: 0, value: 500 }
              }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const info = await fetchDebridLinkHostLimits("key-a", "rapidgator");
    expect(info).toHaveLength(1);
    expect(info[0].keyLabel).toBe("Key 1");
    expect(info[0].host).toBe("rapidgator");
    expect(info[0].trafficCurrentBytes).toBe(0);
    expect(info[0].trafficMaxBytes).toBe(150323855360);
    expect(info[0].linksCurrent).toBe(0);
    expect(info[0].linksMax).toBe(500);
  });

  it("falls back from Debrid-Link limits/all to limits when the host is only present in limits", async () => {
    const calledUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calledUrls.push(url);
      if (url.includes("debrid-link.com/api/v2/downloader/limits/all")) {
        return new Response(JSON.stringify({
          success: true,
          value: {
            hosters: [
              {
                name: "uploaded",
                daySize: { current: 1, value: 2 },
                dayCount: { current: 3, value: 4 }
              }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("debrid-link.com/api/v2/downloader/limits")) {
        return new Response(JSON.stringify({
          success: true,
          value: {
            hosters: [
              {
                name: "rapidgator",
                displayName: "Rapidgator",
                daySize: { current: 2147483648, value: 150323855360 },
                dayCount: { current: 42, value: 500 }
              }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const info = await fetchDebridLinkHostLimits("key-a", "rapidgator");
    expect(info).toHaveLength(1);
    expect(info[0].host).toBe("rapidgator");
    expect(info[0].trafficCurrentBytes).toBe(2147483648);
    expect(info[0].trafficMaxBytes).toBe(150323855360);
    expect(info[0].linksCurrent).toBe(42);
    expect(info[0].linksMax).toBe(500);
    expect(calledUrls.some((url) => url.includes("/limits/all"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/limits"))).toBe(true);
  });

  it("includes Debrid-Link host and key state diagnostics in host limits", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("debrid-link.com/api/v2/downloader/hosts")) {
        return new Response(JSON.stringify({
          success: true,
          value: [
            {
              name: "rapidgator",
              status: 1,
              domains: ["rapidgator.net", "rg.to"]
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("debrid-link.com/api/v2/downloader/limits/all")) {
        return new Response(JSON.stringify({
          success: true,
          value: {
            hosters: [
              {
                name: "rapidgator",
                daySize: { current: 1024, value: 2048 },
                dayCount: { current: 2, value: 5 }
              }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const info = await fetchDebridLinkHostLimits("key-a", "rapidgator");
    expect(info[0].state).toBe("ready");
    expect(info[0].stateLabel).toBe("Bereit");
    expect(info[0].hostState).toBe("up");
    expect(info[0].hostStateLabel).toBe("Online");
  });

  it("returns invalid Debrid-Link key diagnostics instead of failing the whole popup request", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("debrid-link.com/api/v2/downloader/hosts")) {
        return new Response(JSON.stringify({
          success: true,
          value: [
            {
              name: "rapidgator",
              status: 0,
              domains: ["rapidgator.net"]
            }
          ]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("debrid-link.com/api/v2/downloader/limits/all")) {
        return new Response(JSON.stringify({
          success: false,
          error: "badToken",
          error_description: "token expired"
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const info = await fetchDebridLinkHostLimits("key-a", "rapidgator");
    expect(info).toHaveLength(1);
    expect(info[0].state).toBe("invalid");
    expect(info[0].cooldownRemainingMs).toBeGreaterThan(0);
    expect(info[0].hostState).toBe("down");
    expect(info[0].hostStateLabel).toBe("Offline");
  });

  it("uses AllDebrid web path when enabled", async () => {
    const settings = {
      ...defaultSettings(),
      allDebridToken: "ad-token",
      allDebridUseWebLogin: true,
      providerOrder: [] as const,
      providerPrimary: "alldebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    const fetchSpy = vi.fn(async () => new Response("not-found", { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const allDebridWeb = vi.fn(async () => ({
      fileName: "from-web.rar",
      directUrl: "https://df4ea4.debrid.it/dl/example/from-web.rar",
      fileSize: 1234,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { allDebridWebUnrestrict: allDebridWeb });
    const result = await service.unrestrictLink("https://rapidgator.net/file/example.part4.rar.html");
    expect(result.provider).toBe("alldebrid");
    expect(result.directUrl).toContain("debrid.it/dl/");
    expect(result.fileSize).toBe(1234);
    expect(allDebridWeb).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("treats AllDebrid web mode as not configured when callback is unavailable", async () => {
    const settings = {
      ...defaultSettings(),
      allDebridToken: "",
      allDebridUseWebLogin: true,
      providerPrimary: "alldebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://rapidgator.net/file/missing-alldebrid-web")).rejects.toThrow(/nicht konfiguriert/i);
  });

  it("uses Real-Debrid web path when enabled", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      realDebridUseWebLogin: true,
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    const fetchSpy = vi.fn(async () => new Response("not-found", { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const realDebridWeb = vi.fn(async () => ({
      fileName: "from-rd-web.rar",
      directUrl: "https://download.real-debrid.com/d/example/from-rd-web.rar",
      fileSize: 5678,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { realDebridWebUnrestrict: realDebridWeb });
    const result = await service.unrestrictLink("https://rapidgator.net/file/example.part5.rar.html");
    expect(result.provider).toBe("realdebrid");
    expect(result.directUrl).toContain("real-debrid.com/d/");
    expect(result.fileSize).toBe(5678);
    expect(realDebridWeb).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("treats Real-Debrid web mode as not configured when callback is unavailable and no token", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      realDebridUseWebLogin: true,
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://rapidgator.net/file/missing-rd-web")).rejects.toThrow(/nicht konfiguriert/i);
  });

  it("falls back to API token when Real-Debrid web login is disabled", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      realDebridUseWebLogin: false,
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    globalThis.fetch = (async () => new Response(JSON.stringify({
      download: "https://download.real-debrid.com/d/test/file.rar",
      filename: "file.rar",
      filesize: 9999
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;

    const realDebridWeb = vi.fn(async () => null);
    const service = new DebridService(settings, { realDebridWebUnrestrict: realDebridWeb });
    const result = await service.unrestrictLink("https://rapidgator.net/file/test.rar.html");
    expect(result.provider).toBe("realdebrid");
    expect(realDebridWeb).not.toHaveBeenCalled();
  });

  it("treats MegaDebrid as not configured when no credentials are set", async () => {
    const settings = {
      ...defaultSettings(),
      megaLogin: "",
      megaPassword: "",
      providerPrimary: "megadebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://rapidgator.net/file/missing-mega-web")).rejects.toThrow(/nicht konfiguriert/i);
  });

  it("uses Mega web fallback when API fails", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      providerOrder: [] as const,
      providerPrimary: "megadebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    // API returns 404 for connectUser → API fails, falls back to web
    const fetchSpy = vi.fn(async () => new Response("not-found", { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const megaWeb = vi.fn(async () => ({
      fileName: "from-web.rar",
      directUrl: "https://www11.unrestrict.link/download/file/abc/from-web.rar",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    const result = await service.unrestrictLink("https://rapidgator.net/file/abc/from-web.rar.html");
    expect(result.provider).toBe("megadebrid");
    expect(result.directUrl).toContain("unrestrict.link/download/file/");
    expect(megaWeb).toHaveBeenCalledTimes(1);
  });

  it("does not fallback from Mega API to Mega Web unless Mega Web is a separate provider in the order", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      megaDebridApiEnabled: true,
      megaDebridWebEnabled: true,
      providerPrimary: "megadebrid-api" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async () => new Response("not-found", { status: 404 })) as typeof fetch;

    const megaWeb = vi.fn(async () => ({
      fileName: "should-not-run.rar",
      directUrl: "https://unused",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    await expect(service.unrestrictLink("https://rapidgator.net/file/mega-api-only.rar.html")).rejects.toThrow(/mega-debrid api/i);
    expect(megaWeb).toHaveBeenCalledTimes(0);
  });

  it("uses Mega Web only when it is configured as a separate fallback provider", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      megaDebridApiEnabled: true,
      megaDebridWebEnabled: true,
      providerOrder: [] as const,
      providerPrimary: "megadebrid-api" as const,
      providerSecondary: "megadebrid-web" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async () => new Response("not-found", { status: 404 })) as typeof fetch;

    const megaWeb = vi.fn(async () => ({
      fileName: "from-separate-web.rar",
      directUrl: "https://mega-web.example/from-separate-web.rar",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    const result = await service.unrestrictLink("https://rapidgator.net/file/from-separate-web.rar.html");
    expect(result.provider).toBe("megadebrid-web");
    expect(result.directUrl).toBe("https://mega-web.example/from-separate-web.rar");
    expect(megaWeb).toHaveBeenCalledTimes(1);
  });

  it("aborts Mega web unrestrict when caller signal is cancelled", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      providerOrder: [] as const,
      providerPrimary: "megadebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    // API connect fails fast → falls through to web fallback
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as typeof fetch;

    const megaWeb = vi.fn((_link: string, signal?: AbortSignal): Promise<never> => new Promise((_, reject) => {
      const onAbort = (): void => reject(new Error("aborted:mega-web-test"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort("test");
    }, 200);

    try {
      await expect(service.unrestrictLink("https://rapidgator.net/file/abort-mega-web", controller.signal)).rejects.toThrow(/aborted/i);
      expect(megaWeb).toHaveBeenCalledTimes(1);
      expect(megaWeb.mock.calls[0]?.[1]).toBe(controller.signal);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("respects provider selection and does not append hidden providers", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "ad-token",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      providerPrimary: "megadebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    let allDebridCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4/link/unlock")) {
        allDebridCalls += 1;
        return new Response(JSON.stringify({ status: "success", data: { link: "https://alldebrid.example/file.bin" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const megaWeb = vi.fn(async () => null);
    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    await expect(service.unrestrictLink("https://rapidgator.net/file/example.part5.rar.html")).rejects.toThrow();
    expect(allDebridCalls).toBe(0);
  });

  it("does not use secondary provider when fallback is disabled and primary is missing", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: false
    };

    const megaWeb = vi.fn(async () => ({
      fileName: "should-not-run.bin",
      directUrl: "https://unused",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    await expect(service.unrestrictLink("https://rapidgator.net/file/example.part5.rar.html")).rejects.toThrow(/nicht konfiguriert/i);
    expect(megaWeb).toHaveBeenCalledTimes(0);
  });

  it("allows disabling secondary and tertiary providers", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaLogin: "user",
      megaPassword: "pass",
      megaCredentials: "user:pass",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        return new Response(JSON.stringify({ error: "traffic_limit" }), {
          status: 403,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const megaWeb = vi.fn(async () => ({
      fileName: "unused.bin",
      directUrl: "https://unused",
      fileSize: null,
      retriesUsed: 0
    }));

    const service = new DebridService(settings, { megaWebUnrestrict: megaWeb });
    await expect(service.unrestrictLink("https://rapidgator.net/file/example.part6.rar.html")).rejects.toThrow();
    expect(megaWeb).toHaveBeenCalledTimes(0);
  });

  it("resolves rapidgator filename from page when provider returns hash", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        return new Response(JSON.stringify({
          download: "https://cdn.example/file.bin",
          filename: "6f09df2984fe01378537c7cd8d7fa7ce",
          filesize: 2048
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("rapidgator.net/file/6f09df2984fe01378537c7cd8d7fa7ce")) {
        return new Response("<html><head><title>download file Banshee.S04E01.German.DL.720p.part01.rar - Rapidgator</title></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/6f09df2984fe01378537c7cd8d7fa7ce");
    expect(result.provider).toBe("realdebrid");
    expect(result.fileName).toBe("Banshee.S04E01.German.DL.720p.part01.rar");
  });

  it("resolves filenames for rg.to links", async () => {
    const settings = {
      ...defaultSettings(),
      allDebridToken: ""
    };

    const link = "https://rg.to/file/685cec6dcc1837dc725755fc9c726dd9";
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === link) {
        return new Response("<html><head><title>Download file Bulletproof.S01E01.German.DL.DD20.Synced.720p.AmazonHD.h264-GDR.part01.rar</title></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const resolved = await service.resolveFilenames([link]);
    expect(resolved.get(link)).toBe("Bulletproof.S01E01.German.DL.DD20.Synced.720p.AmazonHD.h264-GDR.part01.rar");
  });

  it("does not unrestrict non-rapidgator links during filename scan", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true,
      allDebridToken: ""
    };

    const linkFromPage = "https://rapidgator.net/file/11111111111111111111111111111111";
    const linkFromProvider = "https://hoster.example/file/22222222222222222222222222222222";
    let unrestrictCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === linkFromPage) {
        return new Response("<html><head><title>Download file from-page.part1.rar</title></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }

      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        unrestrictCalls += 1;
        const body = init?.body;
        const bodyText = body instanceof URLSearchParams ? body.toString() : String(body || "");
        const linkValue = new URLSearchParams(bodyText).get("link") || "";
        if (linkValue === linkFromProvider) {
          return new Response(JSON.stringify({
            download: "https://cdn.example/from-provider",
            filename: "from-provider.part2.rar",
            filesize: 1024
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const events: Array<{ link: string; fileName: string }> = [];
    const resolved = await service.resolveFilenames([linkFromPage, linkFromProvider], (link, fileName) => {
      events.push({ link, fileName });
    });

    expect(resolved.get(linkFromPage)).toBe("from-page.part1.rar");
    expect(resolved.has(linkFromProvider)).toBe(false);
    expect(unrestrictCalls).toBe(0);
    expect(events).toEqual(expect.arrayContaining([
      { link: linkFromPage, fileName: "from-page.part1.rar" }
    ]));
  });

  it("does not unrestrict rapidgator links during filename scan after page lookup miss", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      allDebridToken: ""
    };

    const link = "https://rapidgator.net/file/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let unrestrictCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(JSON.stringify({ error: "should-not-be-called" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url === link) {
        return new Response("not found", { status: 404 });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const resolved = await service.resolveFilenames([link]);
    expect(resolved.size).toBe(0);
    expect(unrestrictCalls).toBe(0);
  });

  it("maps AllDebrid filename infos by index when response link is missing", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "ad-token",
      providerPrimary: "realdebrid" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      autoProviderFallback: true
    };

    const linkA = "https://rapidgator.net/file/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const linkB = "https://rapidgator.net/file/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4/link/infos")) {
        return new Response(JSON.stringify({
          status: "success",
          data: {
            infos: [
              { filename: "wrong-a.mkv" },
              { filename: "wrong-b.mkv" }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url === linkA || url === linkB) {
        return new Response("no title", { status: 404 });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const resolved = await service.resolveFilenames([linkA, linkB]);
    expect(resolved.get(linkA)).toBe("wrong-a.mkv");
    expect(resolved.get(linkB)).toBe("wrong-b.mkv");
    expect(resolved.size).toBe(2);
  });

  it("retries AllDebrid filename infos after transient server error", async () => {
    const settings = {
      ...defaultSettings(),
      allDebridToken: "ad-token"
    };

    const link = "https://rapidgator.net/file/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let infoCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4/link/infos")) {
        infoCalls += 1;
        if (infoCalls === 1) {
          return new Response("temporary error", { status: 500 });
        }
        return new Response(JSON.stringify({
          status: "success",
          data: {
            infos: [
              { link, filename: "resolved-from-infos.mkv" }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const resolved = await service.resolveFilenames([link]);
    expect(resolved.get(link)).toBe("resolved-from-infos.mkv");
    expect(infoCalls).toBe(2);
  });

  it("retries AllDebrid filename infos when HTML challenge is returned", async () => {
    const settings = {
      ...defaultSettings(),
      allDebridToken: "ad-token"
    };

    const link = "https://rapidgator.net/file/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let infoCalls = 0;
    let pageCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.alldebrid.com/v4/link/infos")) {
        infoCalls += 1;
        return new Response("<html><title>cf challenge</title></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      if (url === link) {
        pageCalls += 1;
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const resolved = await service.resolveFilenames([link]);
    expect(resolved.size).toBe(0);
    expect(infoCalls).toBe(REQUEST_RETRIES);
    expect(pageCalls).toBe(1);
  });
});

describe("normalizeResolvedFilename", () => {
  it("strips HTML entities", () => {
    expect(normalizeResolvedFilename("Show.S01E01.German.DL.720p.part01.rar")).toBe("Show.S01E01.German.DL.720p.part01.rar");
    expect(normalizeResolvedFilename("File&amp;Name.part1.rar")).toBe("File&Name.part1.rar");
    expect(normalizeResolvedFilename("File&quot;Name&quot;.part1.rar")).toBe('File"Name".part1.rar');
  });

  it("strips HTML tags and collapses whitespace", () => {
    // Tags are replaced by spaces, then multiple spaces collapsed
    const result = normalizeResolvedFilename("<b>Show.S01E01</b>.part01.rar");
    expect(result).toBe("Show.S01E01 .part01.rar");

    // Entity decoding happens before tag removal, so &lt;...&gt; becomes <...> then gets stripped
    const entityTagResult = normalizeResolvedFilename("File&lt;Tag&gt;.part1.rar");
    expect(entityTagResult).toBe("File .part1.rar");
  });

  it("strips 'download file' prefix", () => {
    expect(normalizeResolvedFilename("Download file Show.S01E01.part01.rar")).toBe("Show.S01E01.part01.rar");
    expect(normalizeResolvedFilename("download file Movie.2024.mkv")).toBe("Movie.2024.mkv");
  });

  it("strips Rapidgator suffix", () => {
    expect(normalizeResolvedFilename("Show.S01E01.part01.rar - Rapidgator")).toBe("Show.S01E01.part01.rar");
    expect(normalizeResolvedFilename("Movie.mkv | Rapidgator.net")).toBe("Movie.mkv");
  });

  it("returns empty for opaque or non-filename values", () => {
    expect(normalizeResolvedFilename("")).toBe("");
    expect(normalizeResolvedFilename("just some text")).toBe("");
    expect(normalizeResolvedFilename("e51f6809bb6ca615601f5ac5db433737")).toBe("");
    expect(normalizeResolvedFilename("download.bin")).toBe("");
  });

  it("handles combined transforms", () => {
    // "Download file" prefix stripped, &amp; decoded to &, "- Rapidgator" suffix stripped
    expect(normalizeResolvedFilename("Download file Show.S01E01.part01.rar - Rapidgator"))
      .toBe("Show.S01E01.part01.rar");
  });
});

describe("filenameFromRapidgatorUrlPath", () => {
  it("extracts filename from standard rapidgator URL", () => {
    expect(filenameFromRapidgatorUrlPath("https://rapidgator.net/file/abc123/Show.S01E01.part01.rar.html"))
      .toBe("Show.S01E01.part01.rar");
  });

  it("extracts filename without .html suffix", () => {
    expect(filenameFromRapidgatorUrlPath("https://rapidgator.net/file/abc123/Movie.2024.mkv"))
      .toBe("Movie.2024.mkv");
  });

  it("returns empty for hash-only URL paths", () => {
    expect(filenameFromRapidgatorUrlPath("https://rapidgator.net/file/e51f6809bb6ca615601f5ac5db433737"))
      .toBe("");
  });

  it("returns empty for invalid URLs", () => {
    expect(filenameFromRapidgatorUrlPath("not-a-url")).toBe("");
    expect(filenameFromRapidgatorUrlPath("")).toBe("");
  });

  it("handles URL-encoded path segments", () => {
    expect(filenameFromRapidgatorUrlPath("https://rapidgator.net/file/id/Show%20Name.S01E01.part01.rar.html"))
      .toBe("Show Name.S01E01.part01.rar");
  });
});

describe("extractRapidgatorFilenameFromHtml", () => {
  it("extracts filename from title tag", () => {
    const html = "<html><head><title>Download file Show.S01E01.German.DL.720p.part01.rar - Rapidgator</title></head></html>";
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("Show.S01E01.German.DL.720p.part01.rar");
  });

  it("extracts filename from og:title meta tag", () => {
    const html = '<html><head><meta property="og:title" content="Movie.2024.German.DL.1080p.mkv"></head></html>';
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("Movie.2024.German.DL.1080p.mkv");
  });

  it("extracts filename from reversed og:title attribute order", () => {
    const html = '<html><head><meta content="Movie.2024.German.DL.1080p.mkv" property="og:title"></head></html>';
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("Movie.2024.German.DL.1080p.mkv");
  });

  it("returns empty for HTML without recognizable filenames", () => {
    const html = "<html><head><title>Rapidgator: Fast, Pair and Unlimited</title></head><body>No file here</body></html>";
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("");
  });

  it("returns empty for empty HTML", () => {
    expect(extractRapidgatorFilenameFromHtml("")).toBe("");
  });

  it("ignores broad body text that is not a labeled filename", () => {
    const html = "<html><body>Please download file now from mirror.mkv</body></html>";
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("");
  });

  it("extracts from File name label in page body", () => {
    const html = '<html><body>File name: <b>Show.S02E03.720p.part01.rar</b></body></html>';
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("Show.S02E03.720p.part01.rar");
  });
});
