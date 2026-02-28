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
    const overwriteArgs = buildExternalExtractArgs("WinRAR.exe", "archive.rar", "C:\\target", "overwrite");
    expect(overwriteArgs.slice(0, 4)).toEqual(["x", "-o+", "-p-", "-y"]);
    expect(overwriteArgs).toContain("-idc");
    expect(overwriteArgs.some((value) => /^-mt\d+$/i.test(value))).toBe(true);
    expect(overwriteArgs[overwriteArgs.length - 2]).toBe("archive.rar");
    expect(overwriteArgs[overwriteArgs.length - 1]).toBe("C:\\target\\");

    const askArgs = buildExternalExtractArgs("WinRAR.exe", "archive.rar", "C:\\target", "ask", "serienfans.org");
    expect(askArgs.slice(0, 4)).toEqual(["x", "-o-", "-pserienfans.org", "-y"]);
    expect(askArgs).toContain("-idc");
    expect(askArgs.some((value) => /^-mt\d+$/i.test(value))).toBe(true);
    expect(askArgs[askArgs.length - 2]).toBe("archive.rar");
    expect(askArgs[askArgs.length - 1]).toBe("C:\\target\\");

    const compatibilityArgs = buildExternalExtractArgs("WinRAR.exe", "archive.rar", "C:\\target", "overwrite", "", false);
    expect(compatibilityArgs).not.toContain("-idc");
    expect(compatibilityArgs.some((value) => /^-mt\d+$/i.test(value))).toBe(false);

    const unrarRename = buildExternalExtractArgs("unrar", "archive.rar", "C:\\target", "rename");
    expect(unrarRename[0]).toBe("x");
    expect(unrarRename[1]).toBe("-or");
    expect(unrarRename[2]).toBe("-p-");
    expect(unrarRename[3]).toBe("-y");
    expect(unrarRename[unrarRename.length - 2]).toBe("archive.rar");
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

  it("collects split 7z companion parts for cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    fs.mkdirSync(packageDir, { recursive: true });

    const part1 = path.join(packageDir, "release.7z.001");
    const part2 = path.join(packageDir, "release.7z.002");
    const part3 = path.join(packageDir, "release.7z.003");
    const other = path.join(packageDir, "other.7z.001");

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

  it("extracts archives in natural episode order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zip10 = new AdmZip();
    zip10.addFile("e10.txt", Buffer.from("10"));
    zip10.writeZip(path.join(packageDir, "Show.S01E10.zip"));

    const zip2 = new AdmZip();
    zip2.addFile("e02.txt", Buffer.from("02"));
    zip2.writeZip(path.join(packageDir, "Show.S01E02.zip"));

    const zip1 = new AdmZip();
    zip1.addFile("e01.txt", Buffer.from("01"));
    zip1.writeZip(path.join(packageDir, "Show.S01E01.zip"));

    const seenOrder: string[] = [];
    await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false,
      onProgress: (update) => {
        if (update.phase !== "extracting" || !update.archiveName) {
          return;
        }
        if (seenOrder[seenOrder.length - 1] === update.archiveName) {
          return;
        }
        seenOrder.push(update.archiveName);
      }
    });

    expect(seenOrder.slice(0, 3)).toEqual([
      "Show.S01E01.zip",
      "Show.S01E02.zip",
      "Show.S01E10.zip"
    ]);
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

  it("reports extraction progress from 0 to 100", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zip1 = new AdmZip();
    zip1.addFile("a.txt", Buffer.from("a"));
    zip1.writeZip(path.join(packageDir, "a.zip"));

    const zip2 = new AdmZip();
    zip2.addFile("b.txt", Buffer.from("b"));
    zip2.writeZip(path.join(packageDir, "b.zip"));

    const updates: number[] = [];
    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false,
      onProgress: (update) => {
        updates.push(update.percent);
      }
    });

    expect(result.extracted).toBe(2);
    expect(result.failed).toBe(0);
    expect(updates[0]).toBe(0);
    expect(updates.some((value) => value > 0 && value < 100)).toBe(true);
    expect(updates[updates.length - 1]).toBe(100);
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

  it("resumes extraction from persisted progress file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipA = new AdmZip();
    zipA.addFile("a.txt", Buffer.from("a"));
    zipA.writeZip(path.join(packageDir, "a.zip"));

    const zipB = new AdmZip();
    zipB.addFile("b.txt", Buffer.from("b"));
    zipB.writeZip(path.join(packageDir, "b.zip"));

    fs.writeFileSync(path.join(packageDir, ".rd_extract_progress.json"), JSON.stringify({ completedArchives: ["a.zip"] }), "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(2);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(path.join(targetDir, "b.txt"))).toBe(true);
    expect(fs.existsSync(path.join(packageDir, ".rd_extract_progress.json"))).toBe(false);
  });

  it("aborts extraction immediately when abort signal is set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile("file.txt", Buffer.from("x"));
    zip.writeZip(path.join(packageDir, "file.zip"));

    const controller = new AbortController();
    controller.abort();

    await expect(extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false,
      signal: controller.signal
    })).rejects.toThrow("aborted:extract");
  });

  it("handles missing package source directory without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg-missing");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "video.mkv"), "ok", "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.failed).toBe(0);
    expect(result.extracted).toBe(0);
  });

  it("rejects zip entries with path traversal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile("safe.txt", Buffer.from("safe"));
    zip.addFile("../escaped.txt", Buffer.from("malicious"));
    zip.writeZip(path.join(packageDir, "traversal.zip"));

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(fs.existsSync(path.join(targetDir, "safe.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });

  it("builds external extract args for 7z-style extractor", () => {
    const args7z = buildExternalExtractArgs("7z.exe", "archive.7z", "C:\\target", "overwrite");
    expect(args7z[0]).toBe("x");
    expect(args7z).toContain("-y");
    expect(args7z).toContain("-aoa");
    expect(args7z).toContain("-p");
    expect(args7z).toContain("archive.7z");
    expect(args7z).toContain("-oC:\\target");
  });

  it("builds 7z args with skip conflict mode", () => {
    const args = buildExternalExtractArgs("7z", "archive.zip", "/out", "skip");
    expect(args).toContain("-aos");
  });

  it("builds 7z args with rename conflict mode", () => {
    const args = buildExternalExtractArgs("7z", "archive.zip", "/out", "rename");
    expect(args).toContain("-aou");
  });

  it("builds 7z args with password", () => {
    const args = buildExternalExtractArgs("7z", "archive.7z", "/out", "overwrite", "secretpass");
    expect(args).toContain("-psecretpass");
  });

  it("builds WinRAR args with empty password uses -p-", () => {
    const args = buildExternalExtractArgs("WinRAR.exe", "archive.rar", "/out", "overwrite", "");
    expect(args).toContain("-p-");
  });

  it("builds WinRAR args with skip conflict mode uses -o-", () => {
    const args = buildExternalExtractArgs("WinRAR.exe", "archive.rar", "/out", "skip");
    expect(args[1]).toBe("-o-");
  });

  it("collects split zip companion parts for cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    fs.mkdirSync(packageDir, { recursive: true });

    const mainZip = path.join(packageDir, "release.zip");
    const z01 = path.join(packageDir, "release.z01");
    const z02 = path.join(packageDir, "release.z02");
    const otherZip = path.join(packageDir, "other.zip");

    fs.writeFileSync(mainZip, "a", "utf8");
    fs.writeFileSync(z01, "b", "utf8");
    fs.writeFileSync(z02, "c", "utf8");
    fs.writeFileSync(otherZip, "x", "utf8");

    const targets = new Set(collectArchiveCleanupTargets(mainZip));
    expect(targets.has(mainZip)).toBe(true);
    expect(targets.has(z01)).toBe(true);
    expect(targets.has(z02)).toBe(true);
    expect(targets.has(otherZip)).toBe(false);
  });

  it("collects numbered split zip parts (.zip.001, .zip.002) for cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    fs.mkdirSync(packageDir, { recursive: true });

    const part1 = path.join(packageDir, "movie.zip.001");
    const part2 = path.join(packageDir, "movie.zip.002");
    const part3 = path.join(packageDir, "movie.zip.003");
    const mainZip = path.join(packageDir, "movie.zip");
    const other = path.join(packageDir, "other.zip.001");

    fs.writeFileSync(part1, "a", "utf8");
    fs.writeFileSync(part2, "b", "utf8");
    fs.writeFileSync(part3, "c", "utf8");
    fs.writeFileSync(mainZip, "d", "utf8");
    fs.writeFileSync(other, "x", "utf8");

    const targets = new Set(collectArchiveCleanupTargets(part1));
    expect(targets.has(part1)).toBe(true);
    expect(targets.has(part2)).toBe(true);
    expect(targets.has(part3)).toBe(true);
    expect(targets.has(mainZip)).toBe(true);
    expect(targets.has(other)).toBe(false);
  });

  it("collects old-style rar split parts (.r00, .r01) for cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    fs.mkdirSync(packageDir, { recursive: true });

    const mainRar = path.join(packageDir, "show.rar");
    const r00 = path.join(packageDir, "show.r00");
    const r01 = path.join(packageDir, "show.r01");
    const r02 = path.join(packageDir, "show.r02");

    fs.writeFileSync(mainRar, "a", "utf8");
    fs.writeFileSync(r00, "b", "utf8");
    fs.writeFileSync(r01, "c", "utf8");
    fs.writeFileSync(r02, "d", "utf8");

    const targets = new Set(collectArchiveCleanupTargets(mainRar));
    expect(targets.has(mainRar)).toBe(true);
    expect(targets.has(r00)).toBe(true);
    expect(targets.has(r01)).toBe(true);
    expect(targets.has(r02)).toBe(true);
  });
});
