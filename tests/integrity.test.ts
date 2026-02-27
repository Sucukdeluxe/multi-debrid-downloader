import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHashLine, validateFileAgainstManifest } from "../src/main/integrity";

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
});
