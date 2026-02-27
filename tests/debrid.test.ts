import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/constants";
import { DebridService } from "../src/main/debrid";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("debrid service", () => {
  it("falls back to Mega-Debrid when Real-Debrid fails", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaToken: "mega-token",
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
      if (url.includes("mega-debrid.eu/api.php?action=getLink")) {
        return new Response(JSON.stringify({ response_code: "ok", debridLink: "https://mega.example/file.bin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/example.part1.rar.html");
    expect(result.provider).toBe("megadebrid");
    expect(result.directUrl).toBe("https://mega.example/file.bin");
  });

  it("does not fallback when auto fallback is disabled", async () => {
    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      megaToken: "mega-token",
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
      return new Response(JSON.stringify({ response_code: "ok", debridLink: "https://mega.example/file.bin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://rapidgator.net/file/example.part2.rar.html")).rejects.toThrow();
  });

  it("supports BestDebrid auth query fallback", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      megaToken: "",
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
      megaToken: "",
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

  it("retries Mega-Debrid with alternate request variants", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      megaToken: "mega-token",
      bestToken: "",
      allDebridToken: "",
      providerPrimary: "megadebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("mega-debrid.eu/api.php?action=getLink") && !url.includes("&link=")) {
        return new Response(JSON.stringify({ response_code: "UNRESTRICTING_ERROR_1", response_text: "UNRESTRICTING_ERROR_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("mega-debrid.eu/api.php?action=getLink") && url.includes("&link=")) {
        return new Response(JSON.stringify({ response_code: "ok", debridLink: "https://mega.example/file2.bin", filename: "file2.bin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    const result = await service.unrestrictLink("https://rapidgator.net/file/abc/name.part1.rar.html");
    expect(result.provider).toBe("megadebrid");
    expect(result.fileName).toBe("file2.bin");
    expect(calls).toBeGreaterThan(1);
  });

  it("respects provider selection and does not append hidden fallback providers", async () => {
    const settings = {
      ...defaultSettings(),
      token: "",
      megaToken: "mega-token",
      bestToken: "",
      allDebridToken: "ad-token",
      providerPrimary: "megadebrid" as const,
      providerSecondary: "megadebrid" as const,
      providerTertiary: "megadebrid" as const,
      autoProviderFallback: true
    };

    let allDebridCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("mega-debrid.eu/api.php?action=getLink")) {
        return new Response(JSON.stringify({ response_code: "error", response_text: "host unavailable" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("api.alldebrid.com/v4/link/unlock")) {
        allDebridCalls += 1;
        return new Response(JSON.stringify({ status: "success", data: { link: "https://alldebrid.example/file.bin" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const service = new DebridService(settings);
    await expect(service.unrestrictLink("https://rapidgator.net/file/example.part5.rar.html")).rejects.toThrow();
    expect(allDebridCalls).toBe(0);
  });
});
