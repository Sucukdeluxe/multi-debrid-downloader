import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupCancelledPackageArtifacts, removeDownloadLinkArtifacts, removeSampleArtifacts } from "../src/main/cleanup";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanup", () => {
  it("removes archive artifacts but keeps media", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "release.part1.rar"), "x");
    fs.writeFileSync(path.join(dir, "movie.mkv"), "x");

    const removed = cleanupCancelledPackageArtifacts(dir);
    expect(removed).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, "release.part1.rar"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "movie.mkv"))).toBe(true);
  });

  it("removes sample artifacts and link files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "Samples"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Samples", "demo-sample.mkv"), "x");
    fs.writeFileSync(path.join(dir, "download_links.txt"), "https://example.com/a\n");

    const links = removeDownloadLinkArtifacts(dir);
    const samples = removeSampleArtifacts(dir);
    expect(links).toBeGreaterThan(0);
    expect(samples.files + samples.dirs).toBeGreaterThan(0);
  });
});
