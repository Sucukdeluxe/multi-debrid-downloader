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

describe("extractor jvm backend", () => {
  it("extracts zip archives through SevenZipJBinding backend", async () => {
    if (!hasJavaRuntime() || !hasJvmExtractorRuntime()) {
      return;
    }

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

  it("respects ask/skip conflict mode in jvm backend", async () => {
    if (!hasJavaRuntime() || !hasJvmExtractorRuntime()) {
      return;
    }

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
