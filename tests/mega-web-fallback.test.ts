import { afterEach, describe, expect, it, vi } from "vitest";
import { MegaWebFallback } from "../src/main/mega-web-fallback";

const originalFetch = globalThis.fetch;

describe("mega-web-fallback", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("MegaWebFallback class", () => {
    it("returns null when credentials are empty", async () => {
      const fallback = new MegaWebFallback(() => ({ login: "", password: "" }));
      const result = await fallback.unrestrict("https://mega.debrid/test");
      expect(result).toBeNull();
    });

    it("logs in, fetches HTML, parses code, and polls AJAX for direct url", async () => {
      let fetchCallCount = 0;
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCallCount += 1;
        
        if (urlStr.includes("form=login")) {
          const headers = new Headers();
          headers.append("set-cookie", "session=goodcookie; path=/");
          return new Response("", { headers, status: 200 });
        }
        
        if (urlStr.includes("page=debrideur")) {
          return new Response('<form id="debridForm"></form>', { status: 200 });
        }
        
        if (urlStr.includes("form=debrid")) {
          // The POST to generate the code
          return new Response(`
            <div class="acp-box">
              <h3>Link: https://mega.debrid/link1</h3>
              <a href="javascript:processDebrid(1,'secretcode123',0)">Download</a>
            </div>
          `, { status: 200 });
        }
        
        if (urlStr.includes("ajax=debrid")) {
          // Polling endpoint
          return new Response(JSON.stringify({ link: "https://mega.direct/123" }), { status: 200 });
        }
        
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const fallback = new MegaWebFallback(() => ({ login: "user", password: "pwd" }));
      
      const result = await fallback.unrestrict("https://mega.debrid/link1");
      expect(result).not.toBeNull();
      expect(result?.directUrl).toBe("https://mega.direct/123");
      expect(result?.fileName).toBe("link1");
      // Calls: 1. Login POST, 2. Verify GET, 3. Generate POST, 4. Polling POST
      expect(fetchCallCount).toBe(4);
    });

    it("fails fast on 'Kein Server für diesen Hoster' (account hoster quota) instead of re-login + re-poll", async () => {
      let ajaxCalls = 0;
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("form=login")) {
          const headers = new Headers();
          headers.append("set-cookie", "session=goodcookie; path=/");
          return new Response("", { headers, status: 200 });
        }
        if (urlStr.includes("page=debrideur")) {
          return new Response('<form id="debridForm"></form>', { status: 200 });
        }
        if (urlStr.includes("form=debrid")) {
          return new Response(`<div class="acp-box"><h3>Link: https://mega.debrid/l1</h3><a href="javascript:processDebrid(1,'code1',0)">d</a></div>`, { status: 200 });
        }
        if (urlStr.includes("ajax=debrid")) {
          ajaxCalls += 1;
          return new Response(JSON.stringify({ link: "", text: "Erreur : Kein Server für diesen Hoster verfügbar. Bitte versuchen Sie es später noch einmal." }), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const fallback = new MegaWebFallback(() => ({ login: "user", password: "pwd" }));
      // Muss schnell mit der ECHTEN Meldung scheitern — NICHT null zurückgeben (was
      // re-Login + erneutes Pollen auslösen würde und das Rotations-Budget frisst).
      await expect(fallback.unrestrict("https://mega.debrid/l1")).rejects.toThrow(/kein server für diesen hoster/i);
      expect(ajaxCalls).toBe(1);
    });

    it("logs in with the per-account credentials passed to unrestrict, not the default", async () => {
      const loginsUsed: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, opts?: { body?: unknown }) => {
        const urlStr = String(url);
        if (urlStr.includes("form=login")) {
          const params = new URLSearchParams(String(opts?.body ?? ""));
          loginsUsed.push(params.get("login") || "");
          const headers = new Headers();
          headers.append("set-cookie", "session=goodcookie; path=/");
          return new Response("", { headers, status: 200 });
        }
        if (urlStr.includes("page=debrideur")) {
          return new Response('<form id="debridForm"></form>', { status: 200 });
        }
        if (urlStr.includes("form=debrid")) {
          return new Response(`<div class="acp-box"><h3>Link: https://mega.debrid/l1</h3><a href="javascript:processDebrid(1,'code1',0)">d</a></div>`, { status: 200 });
        }
        if (urlStr.includes("ajax=debrid")) {
          return new Response(JSON.stringify({ link: "https://mega.direct/ok" }), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      // getCredentials liefert den DEFAULT/Legacy-Account ...
      const fallback = new MegaWebFallback(() => ({ login: "defaultacc", password: "defpw" }));
      // ... aber die Rotation übergibt explizit Account 2 — DESSEN Login MUSS verwendet werden.
      const result = await fallback.unrestrict("https://mega.debrid/l1", undefined, { login: "account2", password: "pw2" });
      expect(result?.directUrl).toBe("https://mega.direct/ok");
      expect(loginsUsed).toContain("account2");
      expect(loginsUsed).not.toContain("defaultacc");
    });

    it("throws if login fails to set cookie", async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("form=login")) {
          const headers = new Headers(); // No cookie
          return new Response("", { headers, status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const fallback = new MegaWebFallback(() => ({ login: "bad", password: "bad" }));
      
      await expect(fallback.unrestrict("http://mega.debrid/file"))
        .rejects.toThrow("Mega-Web Login liefert kein Session-Cookie");
    });

    it("throws if login verify check fails (no form found)", async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("form=login")) {
          const headers = new Headers();
          headers.append("set-cookie", "session=goodcookie; path=/");
          return new Response("", { headers, status: 200 });
        }
        if (urlStr.includes("page=debrideur")) {
          // Missing form!
          return new Response('<html><body>Nothing here</body></html>', { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const fallback = new MegaWebFallback(() => ({ login: "a", password: "b" }));
      
      await expect(fallback.unrestrict("http://mega.debrid/file"))
        .rejects.toThrow("Mega-Web Login ungültig oder Session blockiert");
    });
    
    it("returns null if generation fails to find a code", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        callCount++;
        if (urlStr.includes("form=login")) {
          const headers = new Headers();
          headers.append("set-cookie", "session=goodcookie; path=/");
          return new Response("", { headers, status: 200 });
        }
        if (urlStr.includes("page=debrideur")) {
          return new Response('<form id="debridForm"></form>', { status: 200 });
        }
        if (urlStr.includes("form=debrid")) {
          // The generate POST returns HTML without any codes
          return new Response(`<div>No links here</div>`, { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      const fallback = new MegaWebFallback(() => ({ login: "a", password: "b" }));
      const result = await fallback.unrestrict("http://mega.debrid/file");
      
      // Generation fails -> resets cookie -> tries again -> fails again -> returns null
      expect(result).toBeNull();
    });

    it("aborts pending Mega-Web polling when signal is cancelled", async () => {
      globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const urlStr = String(url);

        if (urlStr.includes("form=login")) {
          const headers = new Headers();
          headers.append("set-cookie", "session=goodcookie; path=/");
          return Promise.resolve(new Response("", { headers, status: 200 }));
        }

        if (urlStr.includes("page=debrideur")) {
          return Promise.resolve(new Response('<form id="debridForm"></form>', { status: 200 }));
        }

        if (urlStr.includes("form=debrid")) {
          return Promise.resolve(new Response(`
            <div class="acp-box">
              <h3>Link: https://mega.debrid/link2</h3>
              <a href="javascript:processDebrid(1,'secretcode456',0)">Download</a>
            </div>
          `, { status: 200 }));
        }

        if (urlStr.includes("ajax=debrid")) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const onAbort = (): void => reject(new Error("aborted:ajax"));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        return Promise.resolve(new Response("Not found", { status: 404 }));
      }) as unknown as typeof fetch;

      const fallback = new MegaWebFallback(() => ({ login: "user", password: "pwd" }));
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort("test");
      }, 200);

      try {
        await expect(fallback.unrestrict("https://mega.debrid/link2", controller.signal)).rejects.toThrow(/aborted/i);
      } finally {
        clearTimeout(timer);
      }
    });
  });
});
