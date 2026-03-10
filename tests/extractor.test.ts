import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildExternalExtractArgs,
  cleanErrorText,
  collectArchiveCleanupTargets,
  extractPackageArchives,
  type ExtractArchiveFailureInfo,
  archiveFilenamePasswords,
  detectArchiveSignature,
  classifyExtractionError,
  shouldSerialRetryParallelFailures,
  findArchiveCandidates,
  orderExtractorCandidatesForArchive,
  resolveExtractorBackendModeForArchive,
  resolveExtractorBackendMode,
  shouldFallbackLegacyRarToJvm,
} from "../src/main/extractor";

const tempDirs: string[] = [];
const originalExtractBackend = process.env.RD_EXTRACT_BACKEND;
const originalStatfs = fs.promises.statfs;
const originalZipEntryMemoryLimit = process.env.RD_ZIP_ENTRY_MEMORY_LIMIT_MB;

beforeEach(() => {
  process.env.RD_EXTRACT_BACKEND = "legacy";
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalExtractBackend === undefined) {
    delete process.env.RD_EXTRACT_BACKEND;
  } else {
    process.env.RD_EXTRACT_BACKEND = originalExtractBackend;
  }
  (fs.promises as any).statfs = originalStatfs;
  if (originalZipEntryMemoryLimit === undefined) {
    delete process.env.RD_ZIP_ENTRY_MEMORY_LIMIT_MB;
  } else {
    process.env.RD_ZIP_ENTRY_MEMORY_LIMIT_MB = originalZipEntryMemoryLimit;
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

    const rarCliArgs = buildExternalExtractArgs("Rar.exe", "archive.rar", "C:\\target", "overwrite", "serienjunkies.org");
    expect(rarCliArgs.slice(0, 4)).toEqual(["x", "-o+", "-pserienjunkies.org", "-y"]);
    expect(rarCliArgs[rarCliArgs.length - 2]).toBe("archive.rar");
    expect(rarCliArgs[rarCliArgs.length - 1]).toBe("C:\\target\\");
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

  it("keeps original ZIP size guard error when external fallback is unavailable", async () => {
    process.env.RD_ZIP_ENTRY_MEMORY_LIMIT_MB = "8";

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipPath = path.join(packageDir, "too-large.zip");
    const zip = new AdmZip();
    zip.addFile("large.bin", Buffer.alloc(9 * 1024 * 1024, 7));
    zip.writeZip(zipPath);

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
    expect(String(result.lastError)).toMatch(/ZIP-Eintrag.*groß/i);
  });

  it.skipIf(process.platform !== "win32")("matches resume-state archive names case-insensitively on Windows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const archivePath = path.join(packageDir, "episode.zip");
    fs.writeFileSync(archivePath, "not-a-zip", "utf8");
    fs.writeFileSync(path.join(packageDir, ".rd_extract_progress.json"), JSON.stringify({ completedArchives: ["EPISODE.ZIP"] }), "utf8");

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);
  });

  describe("disk space check", () => {
    it("aborts extraction when disk space is insufficient", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-diskspace-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });

      const zip = new AdmZip();
      zip.addFile("test.txt", Buffer.alloc(1024, 0x41));
      zip.writeZip(path.join(packageDir, "test.zip"));

      (fs.promises as any).statfs = async () => ({ bfree: 1, bsize: 1 });

      await expect(
        extractPackageArchives({
          packageDir,
          targetDir,
          cleanupMode: "none" as any,
          conflictMode: "overwrite" as any,
          removeLinks: false,
          removeSamples: false,
        })
      ).rejects.toThrow(/Nicht genug Speicherplatz/);
    });

    it("proceeds when disk space is sufficient", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-diskspace-ok-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });

      const zip = new AdmZip();
      zip.addFile("test.txt", Buffer.alloc(1024, 0x41));
      zip.writeZip(path.join(packageDir, "test.zip"));

      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none" as any,
        conflictMode: "overwrite" as any,
        removeLinks: false,
        removeSamples: false,
      });
      expect(result.extracted).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  describe("nested extraction", () => {
    it("extracts archives found inside extracted output", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-nested-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });

      const innerZip = new AdmZip();
      innerZip.addFile("deep.txt", Buffer.from("deep content"));

      const outerZip = new AdmZip();
      outerZip.addFile("inner.zip", innerZip.toBuffer());
      outerZip.writeZip(path.join(packageDir, "outer.zip"));

      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none" as any,
        conflictMode: "overwrite" as any,
        removeLinks: false,
        removeSamples: false,
      });

      expect(result.extracted).toBe(2);
      expect(result.failed).toBe(0);
      expect(fs.existsSync(path.join(targetDir, "deep.txt"))).toBe(true);
    });

    it("does not extract blacklisted extensions like .iso", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-nested-bl-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });

      const zip = new AdmZip();
      zip.addFile("disc.iso", Buffer.alloc(64, 0));
      zip.addFile("readme.txt", Buffer.from("hello"));
      zip.writeZip(path.join(packageDir, "package.zip"));

      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none" as any,
        conflictMode: "overwrite" as any,
        removeLinks: false,
        removeSamples: false,
      });

      expect(result.extracted).toBe(1);
      expect(fs.existsSync(path.join(targetDir, "disc.iso"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "readme.txt"))).toBe(true);
    });
  });

  describe("archiveFilenamePasswords", () => {
    it("extracts stem and spaced variant from archive name", () => {
      const result = archiveFilenamePasswords("MyRelease.S01E01.rar");
      expect(result).toContain("MyRelease.S01E01");
      expect(result).toContain("MyRelease S01E01");
    });

    it("strips multipart rar suffix", () => {
      const result = archiveFilenamePasswords("Show.S02E03.part01.rar");
      expect(result).toContain("Show.S02E03");
      expect(result).toContain("Show S02E03");
    });

    it("strips .zip.001 suffix", () => {
      const result = archiveFilenamePasswords("Movie.2024.zip.001");
      expect(result).toContain("Movie.2024");
    });

    it("strips .tar.gz suffix", () => {
      const result = archiveFilenamePasswords("backup.tar.gz");
      expect(result).toContain("backup");
    });

    it("returns empty array for empty input", () => {
      expect(archiveFilenamePasswords("")).toEqual([]);
    });

    it("returns single entry when no dots/underscores", () => {
      const result = archiveFilenamePasswords("simple.zip");
      expect(result).toEqual(["simple"]);
    });

    it("replaces underscores with spaces", () => {
      const result = archiveFilenamePasswords("my_archive_name.7z");
      expect(result).toContain("my_archive_name");
      expect(result).toContain("my archive name");
    });
  });

  describe(".rev cleanup", () => {
    it("collects .rev files for single RAR cleanup", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rev-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      const mainRar = path.join(packageDir, "show.rar");
      const rev = path.join(packageDir, "show.rev");
      const r00 = path.join(packageDir, "show.r00");

      fs.writeFileSync(mainRar, "a", "utf8");
      fs.writeFileSync(rev, "b", "utf8");
      fs.writeFileSync(r00, "c", "utf8");

      const targets = new Set(collectArchiveCleanupTargets(mainRar));
      expect(targets.has(mainRar)).toBe(true);
      expect(targets.has(rev)).toBe(true);
      expect(targets.has(r00)).toBe(true);
    });

    it("collects .rev files for multipart RAR cleanup", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rev-mp-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      const part1 = path.join(packageDir, "show.part01.rar");
      const part2 = path.join(packageDir, "show.part02.rar");
      const rev = path.join(packageDir, "show.rev");

      fs.writeFileSync(part1, "a", "utf8");
      fs.writeFileSync(part2, "b", "utf8");
      fs.writeFileSync(rev, "c", "utf8");

      const targets = new Set(collectArchiveCleanupTargets(part1));
      expect(targets.has(part1)).toBe(true);
      expect(targets.has(part2)).toBe(true);
      expect(targets.has(rev)).toBe(true);
    });
  });

  describe("generic .001 split cleanup", () => {
    it("collects all numbered parts for generic splits", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-split-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      const p001 = path.join(packageDir, "movie.001");
      const p002 = path.join(packageDir, "movie.002");
      const p003 = path.join(packageDir, "movie.003");
      const other = path.join(packageDir, "other.001");

      fs.writeFileSync(p001, "a", "utf8");
      fs.writeFileSync(p002, "b", "utf8");
      fs.writeFileSync(p003, "c", "utf8");
      fs.writeFileSync(other, "x", "utf8");

      const targets = new Set(collectArchiveCleanupTargets(p001));
      expect(targets.has(p001)).toBe(true);
      expect(targets.has(p002)).toBe(true);
      expect(targets.has(p003)).toBe(true);
      expect(targets.has(other)).toBe(false);
    });
  });

  describe("detectArchiveSignature", () => {
    it("detects RAR signature", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-sig-"));
      tempDirs.push(root);
      const filePath = path.join(root, "test.rar");
      // RAR5 signature: 52 61 72 21 1A 07
      fs.writeFileSync(filePath, Buffer.from("526172211a0700", "hex"));
      const sig = await detectArchiveSignature(filePath);
      expect(sig).toBe("rar");
    });

    it("detects ZIP signature", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-sig-"));
      tempDirs.push(root);
      const filePath = path.join(root, "test.zip");
      fs.writeFileSync(filePath, Buffer.from("504b030414000000", "hex"));
      const sig = await detectArchiveSignature(filePath);
      expect(sig).toBe("zip");
    });

    it("detects 7z signature", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-sig-"));
      tempDirs.push(root);
      const filePath = path.join(root, "test.7z");
      fs.writeFileSync(filePath, Buffer.from("377abcaf271c0004", "hex"));
      const sig = await detectArchiveSignature(filePath);
      expect(sig).toBe("7z");
    });

    it("returns null for non-archive files", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-sig-"));
      tempDirs.push(root);
      const filePath = path.join(root, "test.txt");
      fs.writeFileSync(filePath, "Hello World", "utf8");
      const sig = await detectArchiveSignature(filePath);
      expect(sig).toBeNull();
    });

    it("returns null for non-existent file", async () => {
      const sig = await detectArchiveSignature("/nonexistent/file.rar");
      expect(sig).toBeNull();
    });
  });

  describe("findArchiveCandidates extended formats", () => {
    it("finds .tar.gz files", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-tar-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "backup.tar.gz"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "readme.txt"), "info", "utf8");

      const candidates = await findArchiveCandidates(packageDir);
      expect(candidates.map((c) => path.basename(c))).toContain("backup.tar.gz");
    });

    it("finds .tar.bz2 files", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-tar-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "archive.tar.bz2"), "data", "utf8");

      const candidates = await findArchiveCandidates(packageDir);
      expect(candidates.map((c) => path.basename(c))).toContain("archive.tar.bz2");
    });

    it("finds generic .001 split files", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-split-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "movie.001"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "movie.002"), "data", "utf8");

      const candidates = await findArchiveCandidates(packageDir);
      const names = candidates.map((c) => path.basename(c));
      expect(names).toContain("movie.001");
      // .002 should NOT be in candidates (only .001 is the entry point)
      expect(names).not.toContain("movie.002");
    });

    it("does not duplicate .zip.001 as generic split", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dedup-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "movie.zip.001"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "movie.zip.002"), "data", "utf8");

      const candidates = await findArchiveCandidates(packageDir);
      const names = candidates.map((c) => path.basename(c));
      // .zip.001 should appear once from zipSplit detection, not duplicated by genericSplit
      expect(names.filter((n) => n === "movie.zip.001")).toHaveLength(1);
    });

    it("ignores duplicate-suffixed multipart rar volumes as standalone candidates", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rar-dup-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "Sanctuary720-01x07.part1.rar"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "Sanctuary720-01x07.part2.rar"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "Sanctuary720-01x07.part1 (1).rar"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "Sanctuary720-01x07.part2 (1).rar"), "data", "utf8");
      fs.writeFileSync(path.join(packageDir, "Sanctuary720-01x07.part5 (1).rar"), "data", "utf8");

      const candidates = await findArchiveCandidates(packageDir);
      const names = candidates.map((c) => path.basename(c));

      expect(names).toContain("Sanctuary720-01x07.part1.rar");
      expect(names).not.toContain("Sanctuary720-01x07.part1 (1).rar");
      expect(names).not.toContain("Sanctuary720-01x07.part2 (1).rar");
      expect(names).not.toContain("Sanctuary720-01x07.part5 (1).rar");
    });

    it("keeps single rar files with duplicate suffix as valid candidates", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-single-rar-dup-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "Movie (1).rar"), "data", "utf8");

      const candidates = await findArchiveCandidates(packageDir);
      expect(candidates.map((c) => path.basename(c))).toContain("Movie (1).rar");
    });
  });

  describe("classifyExtractionError", () => {
    it("classifies CRC errors", () => {
      expect(classifyExtractionError("CRC failed for file.txt")).toBe("crc_error");
      expect(classifyExtractionError("Checksum error in data")).toBe("crc_error");
    });

    it("classifies wrong password", () => {
      expect(classifyExtractionError("Wrong password")).toBe("wrong_password");
      expect(classifyExtractionError("Falsches Passwort")).toBe("wrong_password");
    });

    it("classifies missing parts", () => {
      expect(classifyExtractionError("Missing volume: part2.rar")).toBe("missing_parts");
      expect(classifyExtractionError("Unexpected end of archive")).toBe("missing_parts");
    });

    it("classifies unsupported format", () => {
      expect(classifyExtractionError("kein RAR-Archiv")).toBe("unsupported_format");
      expect(classifyExtractionError("UNSUPPORTEDMETHOD")).toBe("unsupported_format");
    });

    it("classifies disk full", () => {
      expect(classifyExtractionError("Nicht genug Speicherplatz")).toBe("disk_full");
      expect(classifyExtractionError("No space left on device")).toBe("disk_full");
    });

    it("classifies timeout", () => {
      expect(classifyExtractionError("Entpacken Timeout nach 360s")).toBe("timeout");
    });

    it("classifies abort", () => {
      expect(classifyExtractionError("aborted:extract")).toBe("aborted");
    });

    it("classifies no extractor", () => {
      expect(classifyExtractionError("WinRAR/UnRAR nicht gefunden")).toBe("no_extractor");
    });

    it("prioritizes checksum errors over embedded wrong-password wording", () => {
      expect(classifyExtractionError("Checksum error in the encrypted file. Corrupt file or wrong password.")).toBe("crc_error");
    });

    it("returns unknown for unrecognized errors", () => {
      expect(classifyExtractionError("something weird happened")).toBe("unknown");
    });

    it("keeps important tail markers when long extractor output is trimmed", () => {
      const noisy = `Extracting from archive.rar ${"x".repeat(700)} Unexpected end of archive`;
      const cleaned = cleanErrorText(noisy);
      expect(cleaned).toContain("Unexpected end of archive");
      expect(classifyExtractionError(cleaned)).toBe("missing_parts");
    });
  });

  describe("shouldSerialRetryParallelFailures", () => {
    it("keeps serial recovery enabled after mixed parallel results", () => {
      expect(shouldSerialRetryParallelFailures(1, ["wrong_password"])).toBe(true);
      expect(shouldSerialRetryParallelFailures(2, ["missing_parts"])).toBe(true);
    });

    it("only retries a total parallel wipe-out for contention-like failures", () => {
      expect(shouldSerialRetryParallelFailures(0, ["crc_error", "wrong_password", "unknown"])).toBe(true);
      expect(shouldSerialRetryParallelFailures(0, ["missing_parts"])).toBe(false);
      expect(shouldSerialRetryParallelFailures(0, ["unsupported_format", "crc_error"])).toBe(false);
    });
  });

  describe("password discovery", () => {
    it("reports per-archive failures through onArchiveFailure", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-failure-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(path.join(packageDir, "broken.zip"), "not-a-zip", "utf8");
      const failures: ExtractArchiveFailureInfo[] = [];

      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none",
        conflictMode: "overwrite",
        removeLinks: false,
        removeSamples: false,
        onArchiveFailure: (failure) => {
          failures.push(failure);
        }
      });

      expect(result.extracted).toBe(0);
      expect(result.failed).toBe(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.archiveName).toBe("broken.zip");
      expect(failures[0]?.category).toBe("unsupported_format");
      expect(failures[0]?.suggestRedownload).toBe(false);
    });

    it("extracts first archive serially before parallel pool when multiple passwords", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-pwdisc-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });

      // Create 3 zip archives
      for (const name of ["ep01.zip", "ep02.zip", "ep03.zip"]) {
        const zip = new AdmZip();
        zip.addFile(`${name}.txt`, Buffer.from(name));
        zip.writeZip(path.join(packageDir, name));
      }

      const seenOrder: string[] = [];
      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none",
        conflictMode: "overwrite",
        removeLinks: false,
        removeSamples: false,
        maxParallel: 2,
        passwordList: "pw1|pw2|pw3",
        onProgress: (update) => {
          if (update.phase !== "extracting" || !update.archiveName) return;
          if (seenOrder[seenOrder.length - 1] !== update.archiveName) {
            seenOrder.push(update.archiveName);
          }
        }
      });

      expect(result.extracted).toBe(3);
      expect(result.failed).toBe(0);
      // First archive should be ep01 (natural order, extracted serially for discovery)
      expect(seenOrder[0]).toBe("ep01.zip");
    });

    it("skips discovery when only one password candidate", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-pwdisc-skip-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });

      for (const name of ["a.zip", "b.zip"]) {
        const zip = new AdmZip();
        zip.addFile(`${name}.txt`, Buffer.from(name));
        zip.writeZip(path.join(packageDir, name));
      }

      // No passwordList → only empty string → length=1 → no discovery phase
      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none",
        conflictMode: "overwrite",
        removeLinks: false,
        removeSamples: false,
        maxParallel: 4
      });

      expect(result.extracted).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("skips discovery when only one archive", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-pwdisc-one-"));
      tempDirs.push(root);
      const packageDir = path.join(root, "pkg");
      const targetDir = path.join(root, "out");
      fs.mkdirSync(packageDir, { recursive: true });

      const zip = new AdmZip();
      zip.addFile("single.txt", Buffer.from("single"));
      zip.writeZip(path.join(packageDir, "only.zip"));

      const result = await extractPackageArchives({
        packageDir,
        targetDir,
        cleanupMode: "none",
        conflictMode: "overwrite",
        removeLinks: false,
        removeSamples: false,
        maxParallel: 4,
        passwordList: "pw1|pw2|pw3"
      });

      expect(result.extracted).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  describe("backend selection", () => {
    it("defaults to auto in production when no backend override is set", () => {
      expect(resolveExtractorBackendMode(undefined, false)).toBe("auto");
    });

    it("defaults to legacy in vitest when no backend override is set", () => {
      expect(resolveExtractorBackendMode(undefined, true)).toBe("legacy");
    });

    it("respects explicit backend overrides", () => {
      expect(resolveExtractorBackendMode("legacy", false)).toBe("legacy");
      expect(resolveExtractorBackendMode("jvm", false)).toBe("jvm");
      expect(resolveExtractorBackendMode("auto", false)).toBe("auto");
    });

    it("prefers legacy for rar archives in auto mode on Windows", () => {
      expect(resolveExtractorBackendModeForArchive("C:\\Downloads\\episode.part01.rar", undefined, false, "win32")).toBe("legacy");
      expect(resolveExtractorBackendModeForArchive("C:\\Downloads\\episode.r00", undefined, false, "win32")).toBe("legacy");
    });

    it("falls back from legacy rar to jvm after partial-progress failure in auto mode on Windows", () => {
      expect(
        shouldFallbackLegacyRarToJvm(
          "C:\\Downloads\\episode.part01.rar",
          "auto",
          "legacy",
          "Error: Extracting from C:\\Downloads\\episode.part01.rar",
          38,
          "win32"
        )
      ).toBe(true);
    });

    it("skips legacy rar to jvm fallback for explicit legacy mode and non-rar cases", () => {
      expect(shouldFallbackLegacyRarToJvm("C:\\Downloads\\episode.part01.rar", "legacy", "legacy", "checksum error", 38, "win32")).toBe(false);
      expect(shouldFallbackLegacyRarToJvm("C:\\Downloads\\episode.zip", "auto", "legacy", "unknown failure", 38, "win32")).toBe(false);
      expect(shouldFallbackLegacyRarToJvm("C:\\Downloads\\episode.part01.rar", "auto", "legacy", "timeout", 38, "win32")).toBe(false);
    });

    it("keeps auto for non-rar archives and respects explicit overrides", () => {
      expect(resolveExtractorBackendModeForArchive("C:\\Downloads\\episode.zip", undefined, false, "win32")).toBe("auto");
      expect(resolveExtractorBackendModeForArchive("C:\\Downloads\\episode.part01.rar", "jvm", false, "win32")).toBe("jvm");
      expect(resolveExtractorBackendModeForArchive("C:\\Downloads\\episode.part01.rar", "legacy", false, "win32")).toBe("legacy");
    });
  });

  describe("orderExtractorCandidatesForArchive", () => {
    it("prefers RAR-native CLIs over 7-Zip for rar archives", () => {
      const ordered = orderExtractorCandidatesForArchive(
        ["7z.exe", "Rar.exe", "UnRAR.exe", "WinRAR.exe"],
        "C:\\Downloads\\archive.part01.rar"
      );
      expect(ordered.slice(0, 3)).toEqual(["Rar.exe", "UnRAR.exe", "WinRAR.exe"]);
      expect(ordered[3]).toBe("7z.exe");
    });

    it("keeps 7-Zip first for non-rar archives", () => {
      const ordered = orderExtractorCandidatesForArchive(
        ["UnRAR.exe", "7z.exe", "WinRAR.exe"],
        "C:\\Downloads\\archive.zip"
      );
      expect(ordered[0]).toBe("7z.exe");
    });

    it("prefers the remembered command within the matching archive class", () => {
      const ordered = orderExtractorCandidatesForArchive(
        ["UnRAR.exe", "WinRAR.exe", "7z.exe"],
        "C:\\Downloads\\archive.part01.rar",
        "WinRAR.exe"
      );
      expect(ordered[0]).toBe("WinRAR.exe");
      expect(ordered[1]).toBe("UnRAR.exe");
    });
  });
});
