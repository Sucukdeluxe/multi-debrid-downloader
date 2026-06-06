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

  it("removes sample artifacts and link files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "Samples"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Samples", "demo-sample.mkv"), "x");
    fs.writeFileSync(path.join(dir, "download_links.txt"), "https://example.com/a\n");

    const links = await removeDownloadLinkArtifacts(dir);
    const samples = await removeSampleArtifacts(dir);
    expect(links).toBeGreaterThan(0);
    expect(samples.files + samples.dirs).toBeGreaterThan(0);
  });

  it("cleans up archive files in nested directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);

    const sub1 = path.join(dir, "season1");
    const sub2 = path.join(dir, "season1", "extras");
    fs.mkdirSync(sub2, { recursive: true });

    fs.writeFileSync(path.join(sub1, "episode.part1.rar"), "x");
    fs.writeFileSync(path.join(sub1, "episode.part2.rar"), "x");
    fs.writeFileSync(path.join(sub2, "bonus.zip"), "x");
    fs.writeFileSync(path.join(sub2, "bonus.7z"), "x");
    fs.writeFileSync(path.join(sub1, "video.mkv"), "real content");
    fs.writeFileSync(path.join(sub2, "subtitle.srt"), "subtitle content");

    const removed = cleanupCancelledPackageArtifacts(dir);
    expect(removed).toBe(4);
    expect(fs.existsSync(path.join(sub1, "episode.part1.rar"))).toBe(false);
    expect(fs.existsSync(path.join(sub1, "episode.part2.rar"))).toBe(false);
    expect(fs.existsSync(path.join(sub2, "bonus.zip"))).toBe(false);
    expect(fs.existsSync(path.join(sub2, "bonus.7z"))).toBe(false);
    expect(fs.existsSync(path.join(sub1, "video.mkv"))).toBe(true);
    expect(fs.existsSync(path.join(sub2, "subtitle.srt"))).toBe(true);
  });

  it("detects link artifacts by URL content in text files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);

    fs.writeFileSync(path.join(dir, "download_links.txt"), "https://rapidgator.net/file/abc123\nhttps://uploaded.net/file/def456\n");
    fs.writeFileSync(path.join(dir, "my_downloads.txt"), "Just some random text without URLs");
    fs.writeFileSync(path.join(dir, "readme.txt"), "https://example.com");
    fs.writeFileSync(path.join(dir, "bookmark.url"), "[InternetShortcut]\nURL=https://example.com");
    fs.writeFileSync(path.join(dir, "container.dlc"), "encrypted-data");

    const removed = await removeDownloadLinkArtifacts(dir);
    expect(removed).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(dir, "download_links.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "bookmark.url"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "container.dlc"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "readme.txt"))).toBe(true);
  });

  it("does not recurse into sample symlink or junction targets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-ext-"));
    tempDirs.push(dir, external);

    const outsideFile = path.join(external, "outside-sample.mkv");
    fs.writeFileSync(outsideFile, "keep", "utf8");

    const linkedSampleDir = path.join(dir, "sample");
    const linkType: fs.symlink.Type = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(external, linkedSampleDir, linkType);

    const result = await removeSampleArtifacts(dir);
    expect(result.files).toBe(0);
    expect(fs.existsSync(outsideFile)).toBe(true);
  });
});
