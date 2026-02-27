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
});
