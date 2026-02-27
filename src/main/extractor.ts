import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { path7za } from "7zip-bin";
import { CleanupMode, ConflictMode } from "../shared/types";
import { logger } from "./logger";
import { removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";

const DEFAULT_ARCHIVE_PASSWORDS = ["", "serienfans.org", "serienjunkies.org"];
const FALLBACK_COMMANDS = ["7z", "C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe", "unrar"];

let preferredExtractorCommand: string | null = null;
let extractorUnavailable = false;
let extractorUnavailableReason = "";

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

function cleanErrorText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeBundledExtractorPath(filePath: string): string {
  return filePath.includes("app.asar")
    ? filePath.replace("app.asar", "app.asar.unpacked")
    : filePath;
}

function archivePasswords(): string[] {
  const custom = String(process.env.RD_ARCHIVE_PASSWORDS || "")
    .split(/[;,\n]/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_ARCHIVE_PASSWORDS, ...custom]));
}

function extractorCandidates(): string[] {
  const bundled = normalizeBundledExtractorPath(path7za);
  const ordered = preferredExtractorCommand
    ? [preferredExtractorCommand, bundled, ...FALLBACK_COMMANDS]
    : [bundled, ...FALLBACK_COMMANDS];
  return Array.from(new Set(ordered.filter(Boolean)));
}

function isAbsoluteCommand(command: string): boolean {
  return path.isAbsolute(command)
    || command.includes("\\")
    || command.includes("/");
}

type ExtractSpawnResult = {
  ok: boolean;
  missingCommand: boolean;
  errorText: string;
};

function runExtractCommand(command: string, args: string[]): Promise<ExtractSpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(command, args, { windowsHide: true });

    child.stdout.on("data", (chunk) => {
      output += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk || "");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const text = cleanErrorText(String(error));
      resolve({
        ok: false,
        missingCommand: text.toLowerCase().includes("enoent"),
        errorText: text
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0 || code === 1) {
        resolve({ ok: true, missingCommand: false, errorText: "" });
        return;
      }
      const cleaned = cleanErrorText(output);
      resolve({
        ok: false,
        missingCommand: false,
        errorText: cleaned || `Exit Code ${String(code ?? "?")}`
      });
    });
  });
}

export function buildExternalExtractArgs(
  command: string,
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  password = ""
): string[] {
  const mode = effectiveConflictMode(conflictMode);
  const lower = command.toLowerCase();
  if (lower.includes("unrar")) {
    const overwrite = mode === "overwrite" ? "-o+" : mode === "rename" ? "-or" : "-o-";
    const pass = password ? `-p${password}` : "-p-";
    return ["x", overwrite, pass, archivePath, `${targetDir}${path.sep}`];
  }

  const overwrite = mode === "overwrite" ? "-aoa" : mode === "rename" ? "-aou" : "-aos";
  const pass = password ? `-p${password}` : "-p";
  return ["x", "-y", overwrite, pass, archivePath, `-o${targetDir}`];
}

async function runExternalExtract(archivePath: string, targetDir: string, conflictMode: ConflictMode): Promise<void> {
  if (extractorUnavailable) {
    throw new Error(extractorUnavailableReason || "Kein Entpacker gefunden (7-Zip/unrar fehlt)");
  }

  const candidates = extractorCandidates();
  const passwords = archivePasswords();
  let lastError = "";
  let sawExecutableCommand = false;
  let missingCommands = 0;

  fs.mkdirSync(targetDir, { recursive: true });

  for (const command of candidates) {
    if (isAbsoluteCommand(command) && !fs.existsSync(command)) {
      missingCommands += 1;
      continue;
    }

    for (const password of passwords) {
      const args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password);
      const result = await runExtractCommand(command, args);
      if (result.ok) {
        preferredExtractorCommand = command;
        extractorUnavailable = false;
        extractorUnavailableReason = "";
        return;
      }

      if (result.missingCommand) {
        missingCommands += 1;
        lastError = result.errorText;
        break;
      }

      sawExecutableCommand = true;
      lastError = result.errorText;
    }
  }

  if (!sawExecutableCommand && missingCommands >= candidates.length) {
    extractorUnavailable = true;
    extractorUnavailableReason = "Kein Entpacker gefunden (7-Zip/unrar fehlt oder konnte nicht gestartet werden)";
    throw new Error(extractorUnavailableReason);
  }

  throw new Error(lastError || "Entpacken fehlgeschlagen");
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

export async function extractPackageArchives(options: ExtractOptions): Promise<{ extracted: number; failed: number; lastError: string }> {
  const candidates = findArchiveCandidates(options.packageDir);
  if (candidates.length === 0) {
    return { extracted: 0, failed: 0, lastError: "" };
  }

  let extracted = 0;
  let failed = 0;
  let lastError = "";
  const extractedArchives: string[] = [];
  for (const archivePath of candidates) {
    try {
      const ext = path.extname(archivePath).toLowerCase();
      if (ext === ".zip") {
        try {
          extractZipArchive(archivePath, options.targetDir, options.conflictMode);
        } catch {
          await runExternalExtract(archivePath, options.targetDir, options.conflictMode);
        }
      } else {
        await runExternalExtract(archivePath, options.targetDir, options.conflictMode);
      }
      extracted += 1;
      extractedArchives.push(archivePath);
    } catch (error) {
      failed += 1;
      const errorText = String(error);
      lastError = errorText;
      logger.error(`Entpack-Fehler ${path.basename(archivePath)}: ${errorText}`);
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
  } else {
    try {
      if (fs.existsSync(options.targetDir) && fs.readdirSync(options.targetDir).length === 0) {
        fs.rmSync(options.targetDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  return { extracted, failed, lastError };
}
