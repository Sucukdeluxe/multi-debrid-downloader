import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/main/constants";
import { DebridService, extractRapidgatorFilenameFromHtml, filenameFromRapidgatorUrlPath, normalizeResolvedFilename } from "../src/main/debrid";

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

  it("falls back to provider unrestrict for unresolved filename scan", async () => {
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

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === linkFromPage) {
        return new Response("<html><head><title>Download file from-page.part1.rar</title></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }

      if (url.includes("api.real-debrid.com/rest/1.0/unrestrict/link")) {
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
    expect(resolved.get(linkFromProvider)).toBe("from-provider.part2.rar");
    expect(events).toEqual(expect.arrayContaining([
      { link: linkFromPage, fileName: "from-page.part1.rar" },
      { link: linkFromProvider, fileName: "from-provider.part2.rar" }
    ]));
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

  it("extracts from File name label in page body", () => {
    const html = '<html><body>File name: <b>Show.S02E03.720p.part01.rar</b></body></html>';
    expect(extractRapidgatorFilenameFromHtml(html)).toBe("Show.S02E03.720p.part01.rar");
  });
});
