import { describe, expect, it } from "vitest";
import { transientResolveRetryDelayMs } from "../src/main/download-manager";

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
