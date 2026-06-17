import { describe, expect, it } from "vitest";
import { transientResolveRetryDelayMs, parseMegaDebridCooldownRetry } from "../src/main/download-manager";

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
});
