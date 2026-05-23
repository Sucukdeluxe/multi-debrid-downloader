import { describe, expect, it } from "vitest";
import { planDownloadCompletion, validateDownloadedFileCompletion } from "../src/main/download-completion";

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

    // H3 regression: a stream-end download (no Content-Length, no provider size)
    // that yielded 0 bytes is a FAILED download, not a valid completion.
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
      // provider-metadata: shorter than expected -> underflow rejected
      expect(result.ok).toBe(false);
    });
  });
});
