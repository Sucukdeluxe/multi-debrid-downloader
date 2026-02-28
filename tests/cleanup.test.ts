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

  it("cleans up archive files in nested directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);

    // Create nested directory structure with archive files
    const sub1 = path.join(dir, "season1");
    const sub2 = path.join(dir, "season1", "extras");
    fs.mkdirSync(sub2, { recursive: true });

    fs.writeFileSync(path.join(sub1, "episode.part1.rar"), "x");
    fs.writeFileSync(path.join(sub1, "episode.part2.rar"), "x");
    fs.writeFileSync(path.join(sub2, "bonus.zip"), "x");
    fs.writeFileSync(path.join(sub2, "bonus.7z"), "x");
    // Non-archive files should be kept
    fs.writeFileSync(path.join(sub1, "video.mkv"), "real content");
    fs.writeFileSync(path.join(sub2, "subtitle.srt"), "subtitle content");

    const removed = cleanupCancelledPackageArtifacts(dir);
    expect(removed).toBe(4); // 2 rar parts + zip + 7z
    expect(fs.existsSync(path.join(sub1, "episode.part1.rar"))).toBe(false);
    expect(fs.existsSync(path.join(sub1, "episode.part2.rar"))).toBe(false);
    expect(fs.existsSync(path.join(sub2, "bonus.zip"))).toBe(false);
    expect(fs.existsSync(path.join(sub2, "bonus.7z"))).toBe(false);
    // Non-archives kept
    expect(fs.existsSync(path.join(sub1, "video.mkv"))).toBe(true);
    expect(fs.existsSync(path.join(sub2, "subtitle.srt"))).toBe(true);
  });

  it("detects link artifacts by URL content in text files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-clean-"));
    tempDirs.push(dir);

    // File with link-like name containing URLs should be removed
    fs.writeFileSync(path.join(dir, "download_links.txt"), "https://rapidgator.net/file/abc123\nhttps://uploaded.net/file/def456\n");
    // File with link-like name but no URLs should be kept
    fs.writeFileSync(path.join(dir, "my_downloads.txt"), "Just some random text without URLs");
    // Regular text file that doesn't match the link pattern should be kept
    fs.writeFileSync(path.join(dir, "readme.txt"), "https://example.com");
    // .url files should always be removed
    fs.writeFileSync(path.join(dir, "bookmark.url"), "[InternetShortcut]\nURL=https://example.com");
    // .dlc files should always be removed
    fs.writeFileSync(path.join(dir, "container.dlc"), "encrypted-data");

    const removed = removeDownloadLinkArtifacts(dir);
    expect(removed).toBeGreaterThanOrEqual(3); // download_links.txt + bookmark.url + container.dlc
    expect(fs.existsSync(path.join(dir, "download_links.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "bookmark.url"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "container.dlc"))).toBe(false);
    // Non-matching files should be kept
    expect(fs.existsSync(path.join(dir, "readme.txt"))).toBe(true);
  });
});
