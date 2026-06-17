import { describe, expect, it } from "vitest";
import { planDownloadCompletion, reconcileFinalizedSize, validateDownloadedFileCompletion } from "../src/main/download-completion";

describe("download-completion", () => {
  describe("planDownloadCompletion", () => {
    it("uses content-length when present", () => {
      const plan = planDownloadCompletion({
        existingBytes: 0, responseStatus: 200, contentLength: 1000,
        totalFromRange: null, knownTotal: null, correctedTotal: null
      });
      expect(plan.source).toBe("content-length");
      expect(plan.expectedTotal).toBe(1000);
    });
    it("falls back to stream-end when no size info is available", () => {
      const plan = planDownloadCompletion({
        existingBytes: 0, responseStatus: 200, contentLength: 0,
        totalFromRange: null, knownTotal: null, correctedTotal: null
      });
      expect(plan.source).toBe("stream-end");
      expect(plan.expectedTotal).toBeNull();
    });
  });

  describe("validateDownloadedFileCompletion", () => {
    const streamEnd = { expectedTotal: null, source: "stream-end" as const, canFinishEarly: false };
    const contentLength = (n: number) => ({ expectedTotal: n, source: "content-length" as const, canFinishEarly: true });
    const providerMeta = (n: number) => ({ expectedTotal: n, source: "provider-metadata" as const, canFinishEarly: false });

    it("rejects a 0-byte stream-end download (H3)", () => {
      const result = validateDownloadedFileCompletion({ actualBytes: 0, plan: streamEnd });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("download_underflow");
    });

    it("accepts a non-empty stream-end download", () => {
      const result = validateDownloadedFileCompletion({ actualBytes: 5_000_000, plan: streamEnd });
      expect(result.ok).toBe(true);
      expect(result.totalBytes).toBe(5_000_000);
    });

    it("rejects an underflowing content-length download", () => {
      const result = validateDownloadedFileCompletion({ actualBytes: 400, plan: contentLength(1000), toleranceBytes: 0 });
      expect(result.ok).toBe(false);
    });

    it("accepts a complete content-length download", () => {
      const result = validateDownloadedFileCompletion({ actualBytes: 1000, plan: contentLength(1000) });
      expect(result.ok).toBe(true);
    });

    it("rejects a 0-byte download even with known provider size", () => {
      const result = validateDownloadedFileCompletion({ actualBytes: 0, plan: providerMeta(2000) });
      expect(result.ok).toBe(false);
    });

    it("accepts provider-metadata download and flags size mismatch", () => {
      const result = validateDownloadedFileCompletion({ actualBytes: 1900, plan: providerMeta(2000), toleranceBytes: 0 });
      expect(result.ok).toBe(false);
    });
  });

  describe("reconcileFinalizedSize", () => {
    it("keeps the streamed count for a pre-allocated file whose on-disk size is the zero-padding (corruption guard)", () => {
      expect(reconcileFinalizedSize(300_000_000, 1_000_000_000, true)).toBe(300_000_000);
    });

    it("shrinks to the on-disk size when a pre-allocated file is genuinely short (real partial write)", () => {
      expect(reconcileFinalizedSize(500, 300, true)).toBe(300);
    });

    it("reconciles in both directions for a non-pre-allocated file (stat is authoritative)", () => {
      expect(reconcileFinalizedSize(300, 1000, false)).toBe(1000);
      expect(reconcileFinalizedSize(1000, 300, false)).toBe(300);
    });

    it("returns the streamed count unchanged when the stat is invalid", () => {
      expect(reconcileFinalizedSize(1234, Number.NaN, true)).toBe(1234);
      expect(reconcileFinalizedSize(1234, -1, false)).toBe(1234);
    });

    it("is a no-op when on-disk size already equals the streamed count", () => {
      expect(reconcileFinalizedSize(777, 777, true)).toBe(777);
      expect(reconcileFinalizedSize(777, 777, false)).toBe(777);
    });

    it("does not block legitimate overshoot on a pre-allocated file (server sent more than pre-alloc)", () => {
      expect(reconcileFinalizedSize(900, 900, true)).toBe(900);
    });
  });
});
