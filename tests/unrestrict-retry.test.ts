import { describe, expect, it } from "vitest";
import { transientResolveRetryDelayMs, parseMegaDebridCooldownRetry, parseMegaDebridResetPark, parseMegaDebridSlowLinkRetry } from "../src/main/download-manager";

describe("transientResolveRetryDelayMs (fast, bounded retry for transient resolve failures)", () => {
  it("starts fast (<= 3s) instead of the 5s..120s exponential", () => {
    expect(transientResolveRetryDelayMs(1)).toBeLessThanOrEqual(3000);
  });

  it("ramps gently and caps at 10s", () => {
    expect(transientResolveRetryDelayMs(2)).toBeLessThanOrEqual(7000);
    expect(transientResolveRetryDelayMs(3)).toBeLessThanOrEqual(10000);
    expect(transientResolveRetryDelayMs(10)).toBe(10000);
    expect(transientResolveRetryDelayMs(100)).toBe(10000);
  });

  it("never schedules anywhere near the 5s..120s exponential cap", () => {
    for (let n = 1; n <= 50; n += 1) {
      expect(transientResolveRetryDelayMs(n)).toBeLessThanOrEqual(10000);
      expect(transientResolveRetryDelayMs(n)).toBeGreaterThanOrEqual(1000);
    }
  });

  it("is monotonic non-decreasing", () => {
    let prev = 0;
    for (let n = 1; n <= 12; n += 1) {
      const d = transientResolveRetryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe("parseMegaDebridCooldownRetry (honor the encoded account-cooldown delay)", () => {
  it("parses the encoded delay from a bare mega_debrid_cooldown error", () => {
    const r = parseMegaDebridCooldownRetry("mega_debrid_cooldown:20330:Mega-Debrid (Account 2/2, Da******el): Token error");
    expect(r).not.toBeNull();
    expect(r!.delayMs).toBe(20330);
    expect(r!.detail).toContain("Mega-Debrid");
  });

  it("parses it when embedded in the aggregated provider-chain error", () => {
    const aggregated = "Unrestrict fehlgeschlagen: Mega-Debrid API: mega_debrid_cooldown:20330:Mega-Debrid (Account 2/2): Token error";
    expect(parseMegaDebridCooldownRetry(aggregated)!.delayMs).toBe(20330);
  });

  it("takes the SOONEST (min) cooldown when several accounts are cooled", () => {
    const both = "Mega-Debrid API: mega_debrid_cooldown:116285:web | Mega-Debrid API: mega_debrid_cooldown:20330:api";
    expect(parseMegaDebridCooldownRetry(both)!.delayMs).toBe(20330);
  });

  it("clamps to [1s, 15min]", () => {
    expect(parseMegaDebridCooldownRetry("mega_debrid_cooldown:1:x")!.delayMs).toBe(1000);
    expect(parseMegaDebridCooldownRetry("mega_debrid_cooldown:99999999:x")!.delayMs).toBe(15 * 60 * 1000);
  });

  it("returns null when there is no mega cooldown marker", () => {
    expect(parseMegaDebridCooldownRetry("Datei beim Hoster gerade nicht abrufbar")).toBeNull();
    expect(parseMegaDebridCooldownRetry("debrid_link_cooldown:5000:x")).toBeNull();
  });

  it("does NOT swallow the until-Tagesreset park token", () => {
    expect(parseMegaDebridCooldownRetry("mega_debrid_reset_park:43200000:Alle Accounts bis zum Tagesreset gesperrt")).toBeNull();
  });
});

describe("parseMegaDebridSlowLinkRetry (park only the slow link, never the account)", () => {
  it("parses the encoded delay from a slow-link error", () => {
    const r = parseMegaDebridSlowLinkRetry("mega_debrid_slow_link:120000:Mega-Debrid (Account 1/1, Su******e3): aborted");
    expect(r).not.toBeNull();
    expect(r!.delayMs).toBe(120000);
    expect(r!.detail).toContain("Mega-Debrid");
  });

  it("parses it when embedded in the aggregated provider-chain error", () => {
    const aggregated = "Provider-Kette: Mega-Debrid Web fehlgeschlagen (Error: mega_debrid_slow_link:90000:Mega-Debrid (Account 1/1): aborted)";
    expect(parseMegaDebridSlowLinkRetry(aggregated)!.delayMs).toBe(90000);
  });

  it("clamps to [1s, 15min]", () => {
    expect(parseMegaDebridSlowLinkRetry("mega_debrid_slow_link:1:x")!.delayMs).toBe(1000);
    expect(parseMegaDebridSlowLinkRetry("mega_debrid_slow_link:99999999:x")!.delayMs).toBe(15 * 60 * 1000);
  });

  it("does not collide with the account-cooldown or reset-park tokens", () => {
    expect(parseMegaDebridSlowLinkRetry("mega_debrid_cooldown:20330:x")).toBeNull();
    expect(parseMegaDebridSlowLinkRetry("mega_debrid_reset_park:43200000:x")).toBeNull();
    expect(parseMegaDebridCooldownRetry("mega_debrid_slow_link:120000:x")).toBeNull();
  });
});

describe("parseMegaDebridResetPark (park the item until the Tagesreset, not a ~2min generic retry)", () => {
  it("parses the encoded until-reset delay from the park token", () => {
    const r = parseMegaDebridResetPark("mega_debrid_reset_park:43200000:Mega-Debrid: Alle Accounts am Tageslimit (bis zum Tagesreset gesperrt)");
    expect(r).not.toBeNull();
    expect(r!.delayMs).toBe(43200000);
    expect(r!.detail).toContain("bis zum Tagesreset gesperrt");
  });

  it("parses it when embedded in the aggregated provider-chain error", () => {
    const aggregated = "Unrestrict fehlgeschlagen: Mega-Debrid API: mega_debrid_reset_park:7200000:Alle Accounts bis zum Tagesreset gesperrt";
    expect(parseMegaDebridResetPark(aggregated)!.delayMs).toBe(7200000);
  });

  it("is NOT clamped to the 15min cooldown ceiling (can park multiple hours)", () => {
    expect(parseMegaDebridResetPark("mega_debrid_reset_park:21600000:x")!.delayMs).toBe(21600000);
  });

  it("clamps to a sane [1s, 26h] window and rejects junk", () => {
    expect(parseMegaDebridResetPark("mega_debrid_reset_park:1:x")!.delayMs).toBe(1000);
    expect(parseMegaDebridResetPark("mega_debrid_reset_park:999999999999:x")!.delayMs).toBe(26 * 60 * 60 * 1000);
    expect(parseMegaDebridResetPark("mega_debrid_cooldown:20330:x")).toBeNull();
    expect(parseMegaDebridResetPark("kein Token hier")).toBeNull();
  });
});
