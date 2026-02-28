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
  });
});
