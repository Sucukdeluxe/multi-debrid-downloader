import { describe, expect, it } from "vitest";
import { parsePackagesFromLinksText, isHttpLink, sanitizeFilename, formatEta, filenameFromUrl, looksLikeOpaqueFilename } from "../src/main/utils";

describe("utils", () => {
  it("validates http links", () => {
    expect(isHttpLink("https://example.com/file")).toBe(true);
    expect(isHttpLink("http://example.com/file")).toBe(true);
    expect(isHttpLink("ftp://example.com")).toBe(false);
    expect(isHttpLink("foo bar")).toBe(false);
  });

  it("sanitizes filenames", () => {
    expect(sanitizeFilename("foo/bar:baz*")).toBe("foo bar baz");
    expect(sanitizeFilename("   ")).toBe("Paket");
    expect(sanitizeFilename("test\0file.txt")).toBe("testfile.txt");
    expect(sanitizeFilename("\0\0\0")).toBe("Paket");
    expect(sanitizeFilename("..")).toBe("Paket");
    expect(sanitizeFilename(".")).toBe("Paket");
    expect(sanitizeFilename("release... ")).toBe("release");
    expect(sanitizeFilename(" con ")).toBe("con_");
  });

  it("parses package markers", () => {
    const parsed = parsePackagesFromLinksText(
      "# package: A\nhttps://a.com/1\nhttps://a.com/2\n# package: B\nhttps://b.com/1\n",
      "Default"
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("A");
    expect(parsed[0].links).toHaveLength(2);
    expect(parsed[1].name).toBe("B");
  });

  it("formats eta", () => {
    expect(formatEta(-1)).toBe("--");
    expect(formatEta(65)).toBe("01:05");
    expect(formatEta(3661)).toBe("01:01:01");
  });

  it("normalizes filenames from links", () => {
    expect(filenameFromUrl("https://rapidgator.net/file/id/show.part1.rar.html")).toBe("show.part1.rar");
    expect(filenameFromUrl("https://debrid.example/dl/abc?filename=Movie.S01E01.mkv")).toBe("Movie.S01E01.mkv");
    expect(filenameFromUrl("https://debrid.example/dl/%E0%A4%A")).toBe("%E0%A4%A");
    expect(filenameFromUrl("https://debrid.example/dl/e51f6809bb6ca615601f5ac5db433737")).toBe("e51f6809bb6ca615601f5ac5db433737");
    expect(looksLikeOpaqueFilename("download.bin")).toBe(true);
    expect(looksLikeOpaqueFilename("e51f6809bb6ca615601f5ac5db433737")).toBe(true);
    expect(looksLikeOpaqueFilename("movie.part1.rar")).toBe(false);
  });

  it("preserves unicode filenames", () => {
    expect(sanitizeFilename("日本語ファイル.txt")).toBe("日本語ファイル.txt");
    expect(sanitizeFilename("Ünïcödé Tëst.mkv")).toBe("Ünïcödé Tëst.mkv");
    expect(sanitizeFilename("파일이름.rar")).toBe("파일이름.rar");
    expect(sanitizeFilename("файл.zip")).toBe("файл.zip");
  });

  it("handles very long filenames", () => {
    const longName = "a".repeat(300);
    const result = sanitizeFilename(longName);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // The function should return a non-empty string and not crash
    expect(result).toBe(longName);
  });

  it("formats eta with very large values without crashing", () => {
    const result = formatEta(999999);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // 999999 seconds = 277h 46m 39s
    expect(result).toBe("277:46:39");
  });

  it("formats eta with edge cases", () => {
    expect(formatEta(0)).toBe("00:00");
    expect(formatEta(NaN)).toBe("--");
    expect(formatEta(Infinity)).toBe("--");
    expect(formatEta(Number.MAX_SAFE_INTEGER)).toMatch(/^\d+:\d{2}:\d{2}$/);
  });

  it("extracts filenames from URLs with encoded characters", () => {
    expect(filenameFromUrl("https://example.com/file%20with%20spaces.rar")).toBe("file with spaces.rar");
    // %C3%A9 decodes to e-acute (UTF-8), which is preserved
    expect(filenameFromUrl("https://example.com/t%C3%A9st%20file.zip")).toBe("t\u00e9st file.zip");
    expect(filenameFromUrl("https://example.com/dl?filename=Movie%20Name%20S01E01.mkv")).toBe("Movie Name S01E01.mkv");
    // Malformed percent-encoding should not crash
    const result = filenameFromUrl("https://example.com/%ZZ%invalid");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles looksLikeOpaqueFilename edge cases", () => {
    // Empty string -> sanitizeFilename returns "Paket" which is not opaque
    expect(looksLikeOpaqueFilename("")).toBe(false);
    expect(looksLikeOpaqueFilename("a")).toBe(false);
    expect(looksLikeOpaqueFilename("ab")).toBe(false);
    expect(looksLikeOpaqueFilename("abc")).toBe(false);
    expect(looksLikeOpaqueFilename("download.bin")).toBe(true);
    // 24-char hex string is opaque (matches /^[a-f0-9]{24,}$/)
    expect(looksLikeOpaqueFilename("abcdef123456789012345678")).toBe(true);
    expect(looksLikeOpaqueFilename("abcdef1234567890abcdef12")).toBe(true);
    // Short hex strings (< 24 chars) are NOT considered opaque
    expect(looksLikeOpaqueFilename("abcdef12345")).toBe(false);
    // Real filename with extension
    expect(looksLikeOpaqueFilename("Show.S01E01.720p.mkv")).toBe(false);
  });
});
