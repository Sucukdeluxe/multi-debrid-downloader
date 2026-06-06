import crypto from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  decryptMegaAttributes,
  isMegaFileUrl,
  parseMegaUrl,
  resolveMegaFilename
} from "../src/main/mega-public-api";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeRandomFileKey(): Buffer {
  return crypto.randomBytes(32);
}

function encryptAttributes(jsonAttrs: Record<string, unknown>, aesKey: Buffer): string {
  const plain = "MEGA" + JSON.stringify(jsonAttrs);
  const padded = Buffer.from(plain, "utf8");
  const padLen = (16 - (padded.length % 16)) % 16;
  const buf = Buffer.concat([padded, Buffer.alloc(padLen, 0)]);
  const cipher = crypto.createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return base64Url(enc);
}

describe("mega-public-api", () => {
  describe("isMegaFileUrl", () => {
    it("recognizes new format", () => {
      expect(isMegaFileUrl("https://mega.nz/file/pZl1wBRQ#BFx-HachDy4o9EgKy90IiLMsw3idHFGaDoJhajK5zzo")).toBe(true);
    });
    it("recognizes legacy format", () => {
      expect(isMegaFileUrl("https://mega.nz/#!abc123!def456")).toBe(true);
    });
    it("recognizes mega.co.nz", () => {
      expect(isMegaFileUrl("https://mega.co.nz/file/abc#xyz")).toBe(true);
    });
    it("rejects folder URLs", () => {
      expect(isMegaFileUrl("https://mega.nz/folder/abc#xyz")).toBe(false);
    });
    it("rejects non-mega URLs", () => {
      expect(isMegaFileUrl("https://example.com/file/abc#xyz")).toBe(false);
    });
    it("rejects garbage", () => {
      expect(isMegaFileUrl("")).toBe(false);
      expect(isMegaFileUrl("foo")).toBe(false);
    });
  });

  describe("parseMegaUrl", () => {
    it("parses new-format URL into id + 32-byte key", () => {
      const url = "https://mega.nz/file/pZl1wBRQ#BFx-HachDy4o9EgKy90IiLMsw3idHFGaDoJhajK5zzo";
      const parsed = parseMegaUrl(url);
      expect(parsed).not.toBeNull();
      expect(parsed?.id).toBe("pZl1wBRQ");
      expect(parsed?.rawKey.length).toBe(32);
    });
    it("parses legacy-format URL", () => {
      const id = "abcDEF12";
      const key = makeRandomFileKey();
      const url = `https://mega.nz/#!${id}!${base64Url(key)}`;
      const parsed = parseMegaUrl(url);
      expect(parsed?.id).toBe(id);
      expect(parsed?.rawKey.equals(key)).toBe(true);
    });
    it("rejects URL with folder key (16 bytes)", () => {
      const url = `https://mega.nz/file/abc#${base64Url(crypto.randomBytes(16))}`;
      expect(parseMegaUrl(url)).toBeNull();
    });
    it("rejects malformed URLs", () => {
      expect(parseMegaUrl("not-a-url")).toBeNull();
      expect(parseMegaUrl("https://mega.nz/file/abc")).toBeNull();
    });
  });

  describe("decryptMegaAttributes", () => {
    it("round-trips encrypted Mega attributes", () => {
      const aesKey = crypto.randomBytes(16);
      const original = { n: "Test.S01E01.German.1080p.WEB.x264-DEMO.mkv", c: "ignored" };
      const enc = encryptAttributes(original, aesKey);
      const decoded = Buffer.from(enc + "=".repeat((4 - (enc.length % 4)) % 4), "base64");
      const decrypted = decryptMegaAttributes(decoded, aesKey);
      expect(decrypted).not.toBeNull();
      expect(decrypted?.n).toBe(original.n);
    });
    it("returns null for wrong key", () => {
      const aesKey = crypto.randomBytes(16);
      const wrongKey = crypto.randomBytes(16);
      const enc = encryptAttributes({ n: "x" }, aesKey);
      const decoded = Buffer.from(enc + "=".repeat((4 - (enc.length % 4)) % 4), "base64");
      expect(decryptMegaAttributes(decoded, wrongKey)).toBeNull();
    });
    it("returns null for non-multiple-of-16 input", () => {
      const aesKey = crypto.randomBytes(16);
      expect(decryptMegaAttributes(Buffer.alloc(15), aesKey)).toBeNull();
    });
    it("returns null for wrong key length", () => {
      expect(decryptMegaAttributes(Buffer.alloc(16), Buffer.alloc(8))).toBeNull();
    });
  });

  describe("resolveMegaFilename (mocked fetch)", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("returns filename + size for a valid Mega response", async () => {
      const fileKey = makeRandomFileKey();
      const aesKey = fileKey.subarray(0, 16);
      const url = `https://mega.nz/file/testId12#${base64Url(fileKey)}`;
      const encrypted = encryptAttributes(
        { n: "Direct.Show.S01E01.German.1080p.WEB.x264-DIRECT.mkv" },
        aesKey
      );

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        async json() {
          return [{ s: 1234567890, at: encrypted, msd: 1 }];
        }
      } as unknown as Response);

      const result = await resolveMegaFilename(url);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Direct.Show.S01E01.German.1080p.WEB.x264-DIRECT.mkv");
      expect(result?.size).toBe(1234567890);
    });

    it("returns null when Mega returns numeric error", async () => {
      const fileKey = makeRandomFileKey();
      const url = `https://mega.nz/file/blockedId#${base64Url(fileKey)}`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        async json() {
          return -9;
        }
      } as unknown as Response);

      expect(await resolveMegaFilename(url)).toBeNull();
    });

    it("returns null when response is array with error code", async () => {
      const fileKey = makeRandomFileKey();
      const url = `https://mega.nz/file/blockedId#${base64Url(fileKey)}`;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        async json() {
          return [-16];
        }
      } as unknown as Response);

      expect(await resolveMegaFilename(url)).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      const fileKey = makeRandomFileKey();
      const url = `https://mega.nz/file/networkFail#${base64Url(fileKey)}`;
      global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
      expect(await resolveMegaFilename(url)).toBeNull();
    });

    it("returns null for non-mega URL without making any fetch call", async () => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;
      expect(await resolveMegaFilename("https://example.com/file/abc#xyz")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
