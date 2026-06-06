import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHashLine, readHashManifest, validateFileAgainstManifest } from "../src/main/integrity";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("integrity", () => {
  it("parses md5 and sfv lines", () => {
    const md = parseHashLine("d41d8cd98f00b204e9800998ecf8427e  sample.bin");
    expect(md?.algorithm).toBe("md5");
    const sfv = parseHashLine("sample.bin 1A2B3C4D");
    expect(sfv?.algorithm).toBe("crc32");
  });

  it("validates file against md5 manifest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-int-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "movie.bin");
    fs.writeFileSync(filePath, Buffer.from("hello"));
    fs.writeFileSync(path.join(dir, "hash.md5"), "5d41402abc4b2a76b9719d911017c592 movie.bin\n");
    const result = await validateFileAgainstManifest(filePath, dir);
    expect(result.ok).toBe(true);
  });

  it("skips manifest files larger than 5MB", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-int-"));
    tempDirs.push(dir);

    const largeContent = "d41d8cd98f00b204e9800998ecf8427e  sample.bin\n".repeat(200000);
    const manifestPath = path.join(dir, "hashes.md5");
    fs.writeFileSync(manifestPath, largeContent, "utf8");

    const stat = fs.statSync(manifestPath);
    expect(stat.size).toBeGreaterThan(5 * 1024 * 1024);

    const manifest = readHashManifest(dir);
    expect(manifest.size).toBe(0);
  });

  it("does not parse SHA256 (64-char hex) as valid hash", () => {
    const sha256Line = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  emptyfile.bin";
    const result = parseHashLine(sha256Line);
    expect(result).toBeNull();
  });

  it("parses SHA1 hash lines correctly", () => {
    const sha1Line = "da39a3ee5e6b4b0d3255bfef95601890afd80709  emptyfile.bin";
    const result = parseHashLine(sha1Line);
    expect(result).not.toBeNull();
    expect(result?.algorithm).toBe("sha1");
    expect(result?.digest).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(result?.fileName).toBe("emptyfile.bin");
  });

  it("ignores comment lines in hash manifests", () => {
    expect(parseHashLine("; This is a comment")).toBeNull();
    expect(parseHashLine("")).toBeNull();
    expect(parseHashLine("   ")).toBeNull();
  });

  it("keeps first hash entry when duplicate filename appears across manifests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-int-"));
    tempDirs.push(dir);

    fs.writeFileSync(path.join(dir, "disc1.md5"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  movie.mkv\n", "utf8");
    fs.writeFileSync(path.join(dir, "disc2.md5"), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  movie.mkv\n", "utf8");

    const manifest = readHashManifest(dir);
    expect(manifest.get("movie.mkv")?.digest).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
