import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalExtractArgs, collectArchiveCleanupTargets, extractPackageArchives } from "../src/main/extractor";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractor", () => {
  it("maps external extractor args by conflict mode", () => {
    expect(buildExternalExtractArgs("WinRAR.exe", "archive.rar", "C:\\target", "overwrite")).toEqual([
      "x",
      "-o+",
      "-p-",
      "-y",
      "archive.rar",
      "C:\\target\\"
    ]);
    expect(buildExternalExtractArgs("WinRAR.exe", "archive.rar", "C:\\target", "ask", "serienfans.org")).toEqual([
      "x",
      "-o-",
      "-pserienfans.org",
      "-y",
      "archive.rar",
      "C:\\target\\"
    ]);

    const unrarRename = buildExternalExtractArgs("unrar", "archive.rar", "C:\\target", "rename");
    expect(unrarRename[0]).toBe("x");
    expect(unrarRename[1]).toBe("-or");
    expect(unrarRename[2]).toBe("-p-");
    expect(unrarRename[3]).toBe("-y");
    expect(unrarRename[4]).toBe("archive.rar");
  });

  it("deletes only successfully extracted archives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const validZipPath = path.join(packageDir, "ok.zip");
    const invalidZipPath = path.join(packageDir, "bad.zip");

    const zip = new AdmZip();
    zip.addFile("release.txt", Buffer.from("ok"));
    zip.writeZip(validZipPath);
    fs.writeFileSync(invalidZipPath, "not-a-zip", "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "delete",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(1);
    expect(fs.existsSync(validZipPath)).toBe(false);
    expect(fs.existsSync(invalidZipPath)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "release.txt"))).toBe(true);
  });

  it("collects companion rar parts for cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    fs.mkdirSync(packageDir, { recursive: true });

    const part1 = path.join(packageDir, "show.s01e01.part01.rar");
    const part2 = path.join(packageDir, "show.s01e01.part02.rar");
    const part3 = path.join(packageDir, "show.s01e01.part03.rar");
    const other = path.join(packageDir, "other.s01e01.part01.rar");

    fs.writeFileSync(part1, "a", "utf8");
    fs.writeFileSync(part2, "b", "utf8");
    fs.writeFileSync(part3, "c", "utf8");
    fs.writeFileSync(other, "x", "utf8");

    const targets = new Set(collectArchiveCleanupTargets(part1));
    expect(targets.has(part1)).toBe(true);
    expect(targets.has(part2)).toBe(true);
    expect(targets.has(part3)).toBe(true);
    expect(targets.has(other)).toBe(false);
  });

  it("deletes split zip companion parts when cleanup is enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipPath = path.join(packageDir, "season.zip");
    const z01Path = path.join(packageDir, "season.z01");
    const z02Path = path.join(packageDir, "season.z02");
    const otherPath = path.join(packageDir, "other.z01");

    const zip = new AdmZip();
    zip.addFile("episode.txt", Buffer.from("ok"));
    zip.writeZip(zipPath);
    fs.writeFileSync(z01Path, "part1", "utf8");
    fs.writeFileSync(z02Path, "part2", "utf8");
    fs.writeFileSync(otherPath, "keep", "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "delete",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(zipPath)).toBe(false);
    expect(fs.existsSync(z01Path)).toBe(false);
    expect(fs.existsSync(z02Path)).toBe(false);
    expect(fs.existsSync(otherPath)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "episode.txt"))).toBe(true);
  });

  it("removes empty package directory after archive cleanup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipPath = path.join(packageDir, "release.zip");
    const zip = new AdmZip();
    zip.addFile("video.mkv", Buffer.from("ok"));
    zip.writeZip(zipPath);

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "delete",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(packageDir)).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "video.mkv"))).toBe(true);
  });

  it("keeps package directory when non-archive files remain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipPath = path.join(packageDir, "release.zip");
    const keepPath = path.join(packageDir, "notes.nfo");
    const zip = new AdmZip();
    zip.addFile("video.mkv", Buffer.from("ok"));
    zip.writeZip(zipPath);
    fs.writeFileSync(keepPath, "keep", "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "delete",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(packageDir)).toBe(true);
    expect(fs.existsSync(keepPath)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "video.mkv"))).toBe(true);
  });

  it("treats ask conflict mode as skip in zip extraction", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const zipPath = path.join(packageDir, "conflict.zip");
    const zip = new AdmZip();
    zip.addFile("same.txt", Buffer.from("new"));
    zip.writeZip(zipPath);

    const existingPath = path.join(targetDir, "same.txt");
    fs.writeFileSync(existingPath, "old", "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "ask",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);
    expect(fs.readFileSync(existingPath, "utf8")).toBe("old");
  });

  it("does not keep empty target dir when extraction fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    fs.writeFileSync(path.join(packageDir, "broken.zip"), "not-a-zip", "utf8");
    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(0);
    expect(result.failed).toBe(1);
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
