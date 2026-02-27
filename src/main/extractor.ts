import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { CleanupMode, ConflictMode } from "../shared/types";
import { logger } from "./logger";
import { removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";

export interface ExtractOptions {
  packageDir: string;
  targetDir: string;
  cleanupMode: CleanupMode;
  conflictMode: ConflictMode;
  removeLinks: boolean;
  removeSamples: boolean;
}

function findArchiveCandidates(packageDir: string): string[] {
  const files = fs.readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(packageDir, entry.name));

  const preferred = files.filter((file) => /\.part0*1\.rar$/i.test(file));
  const zip = files.filter((file) => /\.zip$/i.test(file));
  const singleRar = files.filter((file) => /\.rar$/i.test(file) && !/\.part\d+\.rar$/i.test(file));
  const seven = files.filter((file) => /\.7z$/i.test(file));

  const ordered = [...preferred, ...zip, ...singleRar, ...seven];
  return Array.from(new Set(ordered));
}

function effectiveConflictMode(conflictMode: ConflictMode): "overwrite" | "skip" | "rename" {
  if (conflictMode === "rename") {
    return "rename";
  }
  if (conflictMode === "overwrite") {
    return "overwrite";
  }
  return "skip";
}

export function buildExternalExtractArgs(command: string, archivePath: string, targetDir: string, conflictMode: ConflictMode): string[] {
  const mode = effectiveConflictMode(conflictMode);
  const lower = command.toLowerCase();
  if (lower.includes("unrar")) {
    const overwrite = mode === "overwrite" ? "-o+" : mode === "rename" ? "-or" : "-o-";
    return ["x", overwrite, archivePath, `${targetDir}${path.sep}`];
  }

  const overwrite = mode === "overwrite" ? "-aoa" : mode === "rename" ? "-aou" : "-aos";
  return ["x", "-y", overwrite, archivePath, `-o${targetDir}`];
}

function runExternalExtract(archivePath: string, targetDir: string, conflictMode: ConflictMode): Promise<void> {
  const candidates = ["7z", "C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe", "unrar"];
  return new Promise((resolve, reject) => {
    const tryExec = (idx: number): void => {
      if (idx >= candidates.length) {
        reject(new Error("Kein 7z/unrar gefunden"));
        return;
      }
      const cmd = candidates[idx];
      const args = buildExternalExtractArgs(cmd, archivePath, targetDir, conflictMode);
      const child = spawn(cmd, args, { windowsHide: true });
      child.on("error", () => tryExec(idx + 1));
      child.on("close", (code) => {
        if (code === 0 || code === 1) {
          resolve();
        } else {
          tryExec(idx + 1);
        }
      });
    };
    tryExec(0);
  });
}

function extractZipArchive(archivePath: string, targetDir: string, conflictMode: ConflictMode): void {
  const mode = effectiveConflictMode(conflictMode);
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const outputPath = path.join(targetDir, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(outputPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (fs.existsSync(outputPath)) {
      if (mode === "skip") {
        continue;
      }
      if (mode === "rename") {
        const parsed = path.parse(outputPath);
        let n = 1;
        let candidate = outputPath;
        while (fs.existsSync(candidate)) {
          candidate = path.join(parsed.dir, `${parsed.name} (${n})${parsed.ext}`);
          n += 1;
        }
        fs.writeFileSync(candidate, entry.getData());
        continue;
      }
    }
    fs.writeFileSync(outputPath, entry.getData());
  }
}

function cleanupArchives(sourceFiles: string[], cleanupMode: CleanupMode): void {
  if (cleanupMode === "none") {
    return;
  }
  for (const filePath of sourceFiles) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
  }
}

export async function extractPackageArchives(options: ExtractOptions): Promise<{ extracted: number; failed: number }> {
  const candidates = findArchiveCandidates(options.packageDir);
  if (candidates.length === 0) {
    return { extracted: 0, failed: 0 };
  }

  fs.mkdirSync(options.targetDir, { recursive: true });

  let extracted = 0;
  let failed = 0;
  const extractedArchives: string[] = [];
  for (const archivePath of candidates) {
    try {
      const ext = path.extname(archivePath).toLowerCase();
      if (ext === ".zip") {
        extractZipArchive(archivePath, options.targetDir, options.conflictMode);
      } else {
        await runExternalExtract(archivePath, options.targetDir, options.conflictMode);
      }
      extracted += 1;
      extractedArchives.push(archivePath);
    } catch (error) {
      failed += 1;
      logger.error(`Entpack-Fehler ${path.basename(archivePath)}: ${String(error)}`);
    }
  }

  if (extracted > 0) {
    cleanupArchives(extractedArchives, options.cleanupMode);
    if (options.removeLinks) {
      removeDownloadLinkArtifacts(options.targetDir);
    }
    if (options.removeSamples) {
      removeSampleArtifacts(options.targetDir);
    }
  }

  return { extracted, failed };
}
