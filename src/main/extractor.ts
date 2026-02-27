import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { CleanupMode, ConflictMode } from "../shared/types";
import { logger } from "./logger";
import { removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";

const DEFAULT_ARCHIVE_PASSWORDS = ["", "serienfans.org", "serienjunkies.org"];
const NO_EXTRACTOR_MESSAGE = "WinRAR/UnRAR nicht gefunden. Bitte WinRAR installieren.";

let resolvedExtractorCommand: string | null = null;
let resolveFailureReason = "";

export interface ExtractOptions {
  packageDir: string;
  targetDir: string;
  cleanupMode: CleanupMode;
  conflictMode: ConflictMode;
  removeLinks: boolean;
  removeSamples: boolean;
  passwordList?: string;
  onProgress?: (update: ExtractProgressUpdate) => void;
}

export interface ExtractProgressUpdate {
  current: number;
  total: number;
  percent: number;
  archiveName: string;
  phase: "extracting" | "done";
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

function archivePasswords(listInput: string): string[] {
  const custom = String(listInput || "")
    .split(/\r?\n/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const fromEnv = String(process.env.RD_ARCHIVE_PASSWORDS || "")
    .split(/[;,\n]/g)
    .map((part) => part.trim())
    .filter(Boolean);

  return Array.from(new Set(["", ...custom, ...fromEnv, ...DEFAULT_ARCHIVE_PASSWORDS]));
}

function winRarCandidates(): string[] {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const installed = [
    path.join(programFiles, "WinRAR", "UnRAR.exe"),
    path.join(programFiles, "WinRAR", "WinRAR.exe"),
    path.join(programFilesX86, "WinRAR", "UnRAR.exe"),
    path.join(programFilesX86, "WinRAR", "WinRAR.exe")
  ];

  if (localAppData) {
    installed.push(path.join(localAppData, "Programs", "WinRAR", "UnRAR.exe"));
    installed.push(path.join(localAppData, "Programs", "WinRAR", "WinRAR.exe"));
  }

  const ordered = resolvedExtractorCommand
    ? [resolvedExtractorCommand, ...installed, "UnRAR.exe", "WinRAR.exe", "unrar", "winrar"]
    : [...installed, "UnRAR.exe", "WinRAR.exe", "unrar", "winrar"];
  return Array.from(new Set(ordered.filter(Boolean)));
}

function isAbsoluteCommand(command: string): boolean {
  return path.isAbsolute(command)
    || command.includes("\\")
    || command.includes("/");
}

function isNoExtractorError(errorText: string): boolean {
  return String(errorText || "").toLowerCase().includes("nicht gefunden");
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
  if (lower.includes("unrar") || lower.includes("winrar")) {
    const overwrite = mode === "overwrite" ? "-o+" : mode === "rename" ? "-or" : "-o-";
    const pass = password ? `-p${password}` : "-p-";
    return ["x", overwrite, pass, "-y", archivePath, `${targetDir}${path.sep}`];
  }

  const overwrite = mode === "overwrite" ? "-aoa" : mode === "rename" ? "-aou" : "-aos";
  const pass = password ? `-p${password}` : "-p";
  return ["x", "-y", overwrite, pass, archivePath, `-o${targetDir}`];
}

async function resolveExtractorCommand(): Promise<string> {
  if (resolvedExtractorCommand) {
    return resolvedExtractorCommand;
  }
  if (resolveFailureReason) {
    throw new Error(resolveFailureReason);
  }

  const candidates = winRarCandidates();
  for (const command of candidates) {
    if (isAbsoluteCommand(command) && !fs.existsSync(command)) {
      continue;
    }
    const probeArgs = command.toLowerCase().includes("winrar") ? ["-?"] : ["?"];
    const probe = await runExtractCommand(command, probeArgs);
    if (!probe.missingCommand) {
      resolvedExtractorCommand = command;
      resolveFailureReason = "";
      logger.info(`Entpacker erkannt: ${command}`);
      return command;
    }
  }

  resolveFailureReason = NO_EXTRACTOR_MESSAGE;
  throw new Error(resolveFailureReason);
}

async function runExternalExtract(
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[]
): Promise<void> {
  const command = await resolveExtractorCommand();
  const passwords = passwordCandidates;
  let lastError = "";

  fs.mkdirSync(targetDir, { recursive: true });

  for (const password of passwords) {
    const args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password);
    const result = await runExtractCommand(command, args);
    if (result.ok) {
      return;
    }

    if (result.missingCommand) {
      resolvedExtractorCommand = null;
      resolveFailureReason = NO_EXTRACTOR_MESSAGE;
      throw new Error(NO_EXTRACTOR_MESSAGE);
    }

    lastError = result.errorText;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function captureDirFingerprint(rootDir: string): Map<string, string> {
  const fingerprint = new Map<string, string>();
  if (!fs.existsSync(rootDir)) {
    return fingerprint;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const stat = fs.statSync(full);
        const relative = path.relative(rootDir, full).toLowerCase();
        fingerprint.set(relative, `${stat.size}:${stat.mtimeMs}`);
      } catch {
        // ignore
      }
    }
  }

  return fingerprint;
}

function hasDirChanges(before: Map<string, string>, after: Map<string, string>): boolean {
  if (after.size > before.size) {
    return true;
  }
  for (const [relative, meta] of after.entries()) {
    if (before.get(relative) !== meta) {
      return true;
    }
  }
  return false;
}

export function collectArchiveCleanupTargets(sourceArchivePath: string): string[] {
  const targets = new Set<string>([sourceArchivePath]);
  const dir = path.dirname(sourceArchivePath);
  const fileName = path.basename(sourceArchivePath);

  let filesInDir: string[] = [];
  try {
    filesInDir = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return Array.from(targets);
  }

  const addMatching = (pattern: RegExp): void => {
    for (const candidate of filesInDir) {
      if (pattern.test(candidate)) {
        targets.add(path.join(dir, candidate));
      }
    }
  };

  const multipartRar = fileName.match(/^(.*)\.part\d+\.rar$/i);
  if (multipartRar) {
    const prefix = escapeRegex(multipartRar[1]);
    addMatching(new RegExp(`^${prefix}\\.part\\d+\\.rar$`, "i"));
    return Array.from(targets);
  }

  if (/\.rar$/i.test(fileName)) {
    const stem = escapeRegex(fileName.replace(/\.rar$/i, ""));
    addMatching(new RegExp(`^${stem}\\.rar$`, "i"));
    addMatching(new RegExp(`^${stem}\\.r\\d{2}$`, "i"));
    return Array.from(targets);
  }

  if (/\.zip$/i.test(fileName)) {
    const stem = escapeRegex(fileName.replace(/\.zip$/i, ""));
    addMatching(new RegExp(`^${stem}\\.zip$`, "i"));
    addMatching(new RegExp(`^${stem}\\.z\\d{2}$`, "i"));
    return Array.from(targets);
  }

  if (/\.7z$/i.test(fileName)) {
    const stem = escapeRegex(fileName.replace(/\.7z$/i, ""));
    addMatching(new RegExp(`^${stem}\\.7z$`, "i"));
    addMatching(new RegExp(`^${stem}\\.7z\\.\\d{3}$`, "i"));
    return Array.from(targets);
  }

  return Array.from(targets);
}

function cleanupArchives(sourceFiles: string[], cleanupMode: CleanupMode): number {
  if (cleanupMode === "none") {
    return 0;
  }

  const targets = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const target of collectArchiveCleanupTargets(sourceFile)) {
      targets.add(target);
    }
  }

  let removed = 0;
  for (const filePath of targets) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

function hasAnyFilesRecursive(rootDir: string): boolean {
  if (!fs.existsSync(rootDir)) {
    return false;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        return true;
      }
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
  return false;
}

function removeEmptyDirectoryTree(rootDir: string): number {
  if (!fs.existsSync(rootDir)) {
    return 0;
  }

  const dirs = [rootDir];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const full = path.join(current, entry.name);
        dirs.push(full);
        stack.push(full);
      }
    }
  }

  dirs.sort((a, b) => b.length - a.length);
  let removed = 0;
  for (const dirPath of dirs) {
    try {
      const entries = fs.readdirSync(dirPath);
      if (entries.length === 0) {
        fs.rmdirSync(dirPath);
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

export async function extractPackageArchives(options: ExtractOptions): Promise<{ extracted: number; failed: number; lastError: string }> {
  const candidates = findArchiveCandidates(options.packageDir);
  logger.info(`Entpacken gestartet: packageDir=${options.packageDir}, targetDir=${options.targetDir}, archives=${candidates.length}, cleanupMode=${options.cleanupMode}, conflictMode=${options.conflictMode}`);
  if (candidates.length === 0) {
    logger.info(`Entpacken übersprungen (keine Archive gefunden): ${options.packageDir}`);
    return { extracted: 0, failed: 0, lastError: "" };
  }

  const conflictMode = effectiveConflictMode(options.conflictMode);
  const passwordCandidates = archivePasswords(options.passwordList || "");
  const beforeFingerprint = captureDirFingerprint(options.targetDir);
  let extracted = 0;
  let failed = 0;
  let lastError = "";
  const extractedArchives: string[] = [];

  const emitProgress = (current: number, archiveName: string, phase: "extracting" | "done"): void => {
    if (!options.onProgress) {
      return;
    }
    const total = Math.max(1, candidates.length);
    const percent = Math.max(0, Math.min(100, Math.floor((current / total) * 100)));
    options.onProgress({ current, total, percent, archiveName, phase });
  };

  emitProgress(0, "", "extracting");

  for (const archivePath of candidates) {
    const archiveName = path.basename(archivePath);
    emitProgress(extracted + failed, archiveName, "extracting");
    logger.info(`Entpacke Archiv: ${path.basename(archivePath)} -> ${options.targetDir}`);
    try {
      const ext = path.extname(archivePath).toLowerCase();
      if (ext === ".zip") {
        try {
          extractZipArchive(archivePath, options.targetDir, options.conflictMode);
        } catch {
          await runExternalExtract(archivePath, options.targetDir, options.conflictMode, passwordCandidates);
        }
      } else {
        await runExternalExtract(archivePath, options.targetDir, options.conflictMode, passwordCandidates);
      }
      extracted += 1;
      extractedArchives.push(archivePath);
      logger.info(`Entpacken erfolgreich: ${path.basename(archivePath)}`);
      emitProgress(extracted + failed, archiveName, "extracting");
    } catch (error) {
      failed += 1;
      const errorText = String(error);
      lastError = errorText;
      logger.error(`Entpack-Fehler ${path.basename(archivePath)}: ${errorText}`);
      emitProgress(extracted + failed, archiveName, "extracting");
      if (isNoExtractorError(errorText)) {
        const remaining = candidates.length - (extracted + failed);
        if (remaining > 0) {
          failed += remaining;
          emitProgress(candidates.length, archiveName, "extracting");
        }
        break;
      }
    }
  }

  if (extracted > 0) {
    const afterFingerprint = captureDirFingerprint(options.targetDir);
    const changedOutput = hasDirChanges(beforeFingerprint, afterFingerprint);
    if (!changedOutput && conflictMode !== "skip") {
      lastError = "Keine entpackten Dateien erkannt";
      failed += extracted;
      extracted = 0;
      logger.error(`Entpacken ohne neue Ausgabe erkannt: ${options.targetDir}. Cleanup wird NICHT ausgeführt.`);
    } else {
      const removedArchives = cleanupArchives(extractedArchives, options.cleanupMode);
      if (options.cleanupMode !== "none") {
        logger.info(`Archive-Cleanup abgeschlossen: ${removedArchives} Datei(en) entfernt`);
      }
      if (options.removeLinks) {
        const removedLinks = removeDownloadLinkArtifacts(options.targetDir);
        logger.info(`Link-Artefakt-Cleanup: ${removedLinks} Datei(en) entfernt`);
      }
      if (options.removeSamples) {
        const removedSamples = removeSampleArtifacts(options.targetDir);
        logger.info(`Sample-Cleanup: ${removedSamples.files} Datei(en), ${removedSamples.dirs} Ordner entfernt`);
      }

      if (options.cleanupMode === "delete" && !hasAnyFilesRecursive(options.packageDir)) {
        const removedDirs = removeEmptyDirectoryTree(options.packageDir);
        if (removedDirs > 0) {
          logger.info(`Leere Download-Ordner entfernt: ${removedDirs} (root=${options.packageDir})`);
        }
      }
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

  emitProgress(candidates.length, "", "done");

  logger.info(`Entpacken beendet: extracted=${extracted}, failed=${failed}, targetDir=${options.targetDir}`);

  return { extracted, failed, lastError };
}
