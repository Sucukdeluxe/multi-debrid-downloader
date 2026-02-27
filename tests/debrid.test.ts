import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/main/constants";
import { DebridService } from "../src/main/debrid";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("debrid service", () => {
  it("falls back to Mega web when Real-Debrid fails", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaLogin: "user",
      megaPassword: "pass",
      bestToken: "",
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

  it("supports BestDebrid auth query fallback", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "best-token",
      providerPrimary: "bestdebrid" as const,
      providerSecondary: "realdebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/generateLink?link=")) {
        return new Response(JSON.stringify({ message: "Bad token, expired, or invalid" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("/api/v1/generateLink?auth=")) {
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
  });

  it("supports AllDebrid unlock", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "ad-token",
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

  it("uses Mega web path exclusively", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "",
      megaLogin: "user",
      megaPassword: "pass",
      providerPrimary: "megadebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

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
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("respects provider selection and does not append hidden providers", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      bestToken: "",
      allDebridToken: "ad-token",
      megaLogin: "user",
      megaPassword: "pass",
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

  it("allows disabling secondary and tertiary providers", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaLogin: "user",
      megaPassword: "pass",
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
});
