import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { extractPackageArchives } from "../src/main/extractor";

const tempDirs: string[] = [];
const originalBackend = process.env.RD_EXTRACT_BACKEND;

function hasJavaRuntime(): boolean {
  const result = spawnSync("java", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

function hasJvmExtractorRuntime(): boolean {
  const root = path.join(process.cwd(), "resources", "extractor-jvm");
  const classesMain = path.join(root, "classes", "com", "sucukdeluxe", "extractor", "JBindExtractorMain.class");
  const requiredLibs = [
    path.join(root, "lib", "sevenzipjbinding.jar"),
    path.join(root, "lib", "sevenzipjbinding-all-platforms.jar"),
    path.join(root, "lib", "zip4j.jar")
  ];
  return fs.existsSync(classesMain) && requiredLibs.every((libPath) => fs.existsSync(libPath));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalBackend === undefined) {
    delete process.env.RD_EXTRACT_BACKEND;
  } else {
    process.env.RD_EXTRACT_BACKEND = originalBackend;
  }
});

describe.skipIf(!hasJavaRuntime() || !hasJvmExtractorRuntime())("extractor jvm backend", () => {
  it("extracts zip archives through SevenZipJBinding backend", async () => {
    process.env.RD_EXTRACT_BACKEND = "jvm";

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-jvm-extract-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipPath = path.join(packageDir, "release.zip");
    const zip = new AdmZip();
    zip.addFile("episode.txt", Buffer.from("ok"));
    zip.writeZip(zipPath);

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
    expect(fs.existsSync(path.join(targetDir, "episode.txt"))).toBe(true);
  });

  it("emits progress callbacks with archiveName and percent", async () => {
    process.env.RD_EXTRACT_BACKEND = "jvm";

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-jvm-progress-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zipPath = path.join(packageDir, "progress-test.zip");
    const zip = new AdmZip();
    zip.addFile("file1.txt", Buffer.from("Hello World ".repeat(100)));
    zip.addFile("file2.txt", Buffer.from("Another file ".repeat(100)));
    zip.writeZip(zipPath);

    const progressUpdates: Array<{
      archiveName: string;
      percent: number;
      phase: string;
      archivePercent?: number;
    }> = [];

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false,
      onProgress: (update) => {
        progressUpdates.push({
          archiveName: update.archiveName,
          percent: update.percent,
          phase: update.phase,
          archivePercent: update.archivePercent,
        });
      },
    });

    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);

    const phases = new Set(progressUpdates.map((u) => u.phase));
    expect(phases.has("preparing")).toBe(true);
    expect(phases.has("extracting")).toBe(true);

    const extracting = progressUpdates.filter((u) => u.phase === "extracting" && u.archiveName === "progress-test.zip");
    expect(extracting.length).toBeGreaterThan(0);

    const lastExtracting = extracting[extracting.length - 1];
    expect(lastExtracting.archivePercent).toBe(100);

    expect(fs.existsSync(path.join(targetDir, "file1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "file2.txt"))).toBe(true);
  });

  it("extracts multiple archives sequentially with progress for each", async () => {
    process.env.RD_EXTRACT_BACKEND = "jvm";

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-jvm-multi-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });

    const zip1 = new AdmZip();
    zip1.addFile("episode01.txt", Buffer.from("ep1 content"));
    zip1.writeZip(path.join(packageDir, "archive1.zip"));

    const zip2 = new AdmZip();
    zip2.addFile("episode02.txt", Buffer.from("ep2 content"));
    zip2.writeZip(path.join(packageDir, "archive2.zip"));

    const archiveNames = new Set<string>();

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none",
      conflictMode: "overwrite",
      removeLinks: false,
      removeSamples: false,
      onProgress: (update) => {
        if (update.phase === "extracting" && update.archiveName) {
          archiveNames.add(update.archiveName);
        }
      },
    });

    expect(result.extracted).toBe(2);
    expect(result.failed).toBe(0);
    expect(archiveNames.has("archive1.zip")).toBe(true);
    expect(archiveNames.has("archive2.zip")).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "episode01.txt"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "episode02.txt"))).toBe(true);
  });

  it("respects ask/skip conflict mode in jvm backend", async () => {
    process.env.RD_EXTRACT_BACKEND = "jvm";

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-jvm-extract-"));
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
});
