import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalExtractArgs, extractPackageArchives } from "../src/main/extractor";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractor", () => {
  it("maps external extractor args by conflict mode", () => {
    expect(buildExternalExtractArgs("7z", "archive.rar", "C:\\target", "overwrite")).toEqual([
      "x",
      "-y",
      "-aoa",
      "-p",
      "archive.rar",
      "-oC:\\target"
    ]);
    expect(buildExternalExtractArgs("7z", "archive.rar", "C:\\target", "ask")).toEqual([
      "x",
      "-y",
      "-aos",
      "-p",
      "archive.rar",
      "-oC:\\target"
    ]);
    expect(buildExternalExtractArgs("7z", "archive.rar", "C:\\target", "ask", "serienfans.org")).toEqual([
      "x",
      "-y",
      "-aos",
      "-pserienfans.org",
      "archive.rar",
      "-oC:\\target"
    ]);

    const unrarRename = buildExternalExtractArgs("unrar", "archive.rar", "C:\\target", "rename");
    expect(unrarRename[0]).toBe("x");
    expect(unrarRename[1]).toBe("-or");
    expect(unrarRename[2]).toBe("-p-");
    expect(unrarRename[3]).toBe("archive.rar");
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
