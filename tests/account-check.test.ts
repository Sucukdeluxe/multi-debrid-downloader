import { describe, it, expect, vi, afterEach } from "vitest";
import { checkMegaDebridAccount, checkDebridLinkKey, checkAllDebridAccounts } from "../src/main/account-check";
import type { MegaDebridAccountEntry } from "../src/shared/mega-debrid-accounts";
import type { DebridLinkApiKeyEntry } from "../src/shared/debrid-link-keys";
import type { AppSettings } from "../src/shared/types";

function megaAccount(login = "user@example.com"): MegaDebridAccountEntry {
  return { id: "mda_test", login, password: "pw", index: 0, label: "Account 1", maskedLogin: "us**le" };
}

function debridLinkKey(token = "tok_abcdef"): DebridLinkApiKeyEntry {
  return { id: "dlk_test", token, index: 0, label: "Key 1", masked: "tok***def" };
}

function mockFetchOnce(status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  })) as unknown as typeof fetch);
}

const NOW = 1_700_000_000_000; // fixed epoch ms

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkMegaDebridAccount", () => {
  it("reports valid + premium from vip_end (future Unix ts)", async () => {
    const futureSec = Math.floor(NOW / 1000) + 30 * 24 * 60 * 60; // +30 days
    mockFetchOnce(200, { response_code: "ok", response_text: "User logged", token: "t", vip_end: String(futureSec), email: "a@b.de" });
    const st = await checkMegaDebridAccount(megaAccount(), undefined, NOW);
    expect(st.valid).toBe(true);
    expect(st.isPremium).toBe(true);
    expect(st.premiumUntilMs).toBe(futureSec * 1000);
    expect(st.email).toBe("a@b.de");
    expect(st.message).toMatch(/Premium noch/);
  });

  it("reports valid but NOT premium when vip_end is in the past", async () => {
    const pastSec = Math.floor(NOW / 1000) - 1000;
    mockFetchOnce(200, { response_code: "ok", token: "t", vip_end: String(pastSec) });
    const st = await checkMegaDebridAccount(megaAccount(), undefined, NOW);
    expect(st.valid).toBe(true);
    expect(st.isPremium).toBe(false);
  });

  it("reports valid but no premium when vip_end is 0/missing", async () => {
    mockFetchOnce(200, { response_code: "ok", token: "t", vip_end: "0" });
    const st = await checkMegaDebridAccount(megaAccount(), undefined, NOW);
    expect(st.valid).toBe(true);
    expect(st.isPremium).toBe(false);
    expect(st.premiumUntilMs).toBe(0);
    expect(st.message).toMatch(/Kein Premium/);
  });

  it("reports invalid login when response_code != ok", async () => {
    mockFetchOnce(200, { response_code: "error", response_text: "bad login" });
    const st = await checkMegaDebridAccount(megaAccount(), undefined, NOW);
    expect(st.valid).toBe(false);
    expect(st.isPremium).toBe(false);
    expect(st.message).toMatch(/Ungueltiger Login/);
  });

  it("reports invalid on HTTP error", async () => {
    mockFetchOnce(500, "server error");
    const st = await checkMegaDebridAccount(megaAccount(), undefined, NOW);
    expect(st.valid).toBe(false);
  });

  it("never throws on network error — returns a failed status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
    const st = await checkMegaDebridAccount(megaAccount(), undefined, NOW);
    expect(st.valid).toBe(false);
    expect(st.message).toMatch(/Pruefung fehlgeschlagen/);
  });
});

describe("checkDebridLinkKey", () => {
  it("reports valid + premium from premiumLeft seconds", async () => {
    const premiumLeft = 60 * 24 * 60 * 60; // 60 days in seconds
    mockFetchOnce(200, { success: true, value: { username: "u", accountType: 1, premiumLeft } });
    const st = await checkDebridLinkKey(debridLinkKey(), undefined, NOW);
    expect(st.valid).toBe(true);
    expect(st.isPremium).toBe(true);
    expect(st.premiumUntilMs).toBe(NOW + premiumLeft * 1000);
  });

  it("reports valid but free (premiumLeft 0, accountType 0)", async () => {
    mockFetchOnce(200, { success: true, value: { username: "u", accountType: 0, premiumLeft: 0 } });
    const st = await checkDebridLinkKey(debridLinkKey(), undefined, NOW);
    expect(st.valid).toBe(true);
    expect(st.isPremium).toBe(false);
    expect(st.message).toMatch(/Free/);
  });

  it("reports invalid key on HTTP 401", async () => {
    mockFetchOnce(401, { success: false, error: "badToken" });
    const st = await checkDebridLinkKey(debridLinkKey(), undefined, NOW);
    expect(st.valid).toBe(false);
    expect(st.message).toMatch(/Ungueltiger API-Key/);
  });

  it("reports invalid key when success=false", async () => {
    mockFetchOnce(200, { success: false, error: "badToken" });
    const st = await checkDebridLinkKey(debridLinkKey(), undefined, NOW);
    expect(st.valid).toBe(false);
  });
});

describe("checkAllDebridAccounts", () => {
  it("returns empty array when nothing configured", async () => {
    const settings = { megaCredentials: "", megaPassword: "", debridLinkApiKeys: "" } as unknown as AppSettings;
    const result = await checkAllDebridAccounts(settings);
    expect(result).toEqual([]);
  });

  it("checks every configured mega account + debrid-link key", async () => {
    // All requests succeed as valid premium
    const futureSec = Math.floor(Date.now() / 1000) + 1000;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("mega-debrid")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ response_code: "ok", token: "t", vip_end: String(futureSec) }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, value: { accountType: 1, premiumLeft: 1000 } }) };
    }) as unknown as typeof fetch);

    const settings = {
      megaCredentials: "a@b.de:pw1\nc@d.de:pw2",
      megaPassword: "",
      debridLinkApiKeys: "key1\nkey2\nkey3"
    } as unknown as AppSettings;

    const result = await checkAllDebridAccounts(settings);
    expect(result).toHaveLength(5); // 2 mega + 3 debrid-link
    expect(result.filter((r) => r.provider === "megadebrid")).toHaveLength(2);
    expect(result.filter((r) => r.provider === "debridlink")).toHaveLength(3);
    expect(result.every((r) => r.valid)).toBe(true);
  });

  it("caps concurrency (never more than 4 in flight) and preserves result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, value: { accountType: 1, premiumLeft: 1000 } }) };
    }) as unknown as typeof fetch);

    const keys = Array.from({ length: 9 }, (_, i) => `key_${i}`).join("\n");
    const settings = { megaCredentials: "", megaPassword: "", debridLinkApiKeys: keys } as unknown as AppSettings;

    const result = await checkAllDebridAccounts(settings);
    expect(result).toHaveLength(9);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    result.forEach((r, i) => expect(r.label).toBe(`Key ${i + 1}`));
  });
});
