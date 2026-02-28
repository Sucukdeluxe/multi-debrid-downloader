import { afterEach, describe, expect, it } from "vitest";
import { RealDebridClient } from "../src/main/realdebrid";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("realdebrid client", () => {
  it("returns a clear error when HTML is returned instead of JSON", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("<html><title>Cloudflare</title></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }) as typeof fetch;

    const client = new RealDebridClient("rd-token");
    await expect(client.unrestrictLink("https://hoster.example/file/html")).rejects.toThrow(/html/i);
  });

  it("does not leak raw response body on JSON parse errors", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("<html>token=secret-should-not-leak</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const client = new RealDebridClient("rd-token");
    try {
      await client.unrestrictLink("https://hoster.example/file/invalid-json");
      throw new Error("expected unrestrict to fail");
    } catch (error) {
      const text = String(error || "");
      expect(text.toLowerCase()).toContain("json");
      expect(text.toLowerCase()).not.toContain("secret-should-not-leak");
      expect(text.toLowerCase()).not.toContain("<html>");
    }
  });
});
