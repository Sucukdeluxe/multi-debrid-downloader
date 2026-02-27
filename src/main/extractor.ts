import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { CleanupMode, ConflictMode } from "../shared/types";
import { logger } from "./logger";
import { removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";

const DEFAULT_ARCHIVE_PASSWORDS = ["", "serienfans.org", "serienjunkies.org"];
const NO_EXTRACTOR_MESSAGE = "WinRAR/UnRAR nicht gefunden. Bitte WinRAR installieren.";

let resolvedExtractorCommand: string | null = null;
let resolveFailureReason = "";
let externalExtractorSupportsPerfFlags = true;

export interface ExtractOptions {
  packageDir: string;
  targetDir: string;
  cleanupMode: CleanupMode;
  conflictMode: ConflictMode;
  removeLinks: boolean;
  removeSamples: boolean;
  passwordList?: string;
  signal?: AbortSignal;
  onProgress?: (update: ExtractProgressUpdate) => void;
}

export interface ExtractProgressUpdate {
  current: number;
  total: number;
  percent: number;
  archiveName: string;
  archivePercent?: number;
  elapsedMs?: number;
  phase: "extracting" | "done";
}

const MAX_EXTRACT_OUTPUT_BUFFER = 48 * 1024;
const EXTRACT_PROGRESS_FILE = ".rd_extract_progress.json";
const EXTRACT_BASE_TIMEOUT_MS = 6 * 60 * 1000;
const EXTRACT_PER_GIB_TIMEOUT_MS = 4 * 60 * 1000;
const EXTRACT_MAX_TIMEOUT_MS = 120 * 60 * 1000;
const ARCHIVE_SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function pathSetKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function archiveSortKey(filePath: string): string {
  const fileName = path.basename(filePath).toLowerCase();
  return fileName
    .replace(/\.part0*1\.rar$/i, "")
    .replace(/\.zip\.\d{3}$/i, "")
    .replace(/\.7z\.\d{3}$/i, "")
    .replace(/\.rar$/i, "")
    .replace(/\.zip$/i, "")
    .replace(/\.7z$/i, "")
    .replace(/[._\-\s]+$/g, "");
}

function archiveTypeRank(filePath: string): number {
  const fileName = path.basename(filePath).toLowerCase();
  if (/\.part0*1\.rar$/i.test(fileName)) {
    return 0;
  }
  if (/\.rar$/i.test(fileName)) {
    return 1;
  }
  if (/\.zip(?:\.\d{3})?$/i.test(fileName)) {
    return 2;
  }
  if (/\.7z(?:\.\d{3})?$/i.test(fileName)) {
    return 3;
  }
  return 9;
}

type ExtractResumeState = {
  completedArchives: string[];
};

function findArchiveCandidates(packageDir: string): string[] {
  if (!packageDir || !fs.existsSync(packageDir)) {
    return [];
  }

  let files: string[] = [];
  try {
    files = fs.readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(packageDir, entry.name));
  } catch {
    return [];
  }

  const fileNamesLower = new Set(files.map((filePath) => path.basename(filePath).toLowerCase()));
  const multipartRar = files.filter((filePath) => /\.part0*1\.rar$/i.test(filePath));
  const singleRar = files.filter((filePath) => /\.rar$/i.test(filePath) && !/\.part\d+\.rar$/i.test(filePath));
  const zipSplit = files.filter((filePath) => /\.zip\.001$/i.test(filePath));
  const zip = files.filter((filePath) => {
    const fileName = path.basename(filePath);
    if (!/\.zip$/i.test(fileName)) {
      return false;
    }
    return !fileNamesLower.has(`${fileName}.001`.toLowerCase());
  });
  const sevenSplit = files.filter((filePath) => /\.7z\.001$/i.test(filePath));
  const seven = files.filter((filePath) => {
    const fileName = path.basename(filePath);
    if (!/\.7z$/i.test(fileName)) {
      return false;
    }
    return !fileNamesLower.has(`${fileName}.001`.toLowerCase());
  });

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...multipartRar, ...singleRar, ...zipSplit, ...zip, ...sevenSplit, ...seven]) {
    const key = pathSetKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }

  unique.sort((left, right) => {
    const keyCmp = ARCHIVE_SORT_COLLATOR.compare(archiveSortKey(left), archiveSortKey(right));
    if (keyCmp !== 0) {
      return keyCmp;
    }
    const rankCmp = archiveTypeRank(left) - archiveTypeRank(right);
    if (rankCmp !== 0) {
      return rankCmp;
    }
    return ARCHIVE_SORT_COLLATOR.compare(path.basename(left), path.basename(right));
  });

  return unique;
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

function appendLimited(base: string, chunk: string, maxLen = MAX_EXTRACT_OUTPUT_BUFFER): string {
  const next = `${base}${chunk}`;
  if (next.length <= maxLen) {
    return next;
  }
  return next.slice(next.length - maxLen);
}

function parseProgressPercent(chunk: string): number | null {
  const text = String(chunk || "");
  const matches = text.match(/(?:^|\D)(\d{1,3})%/g);
  if (!matches) {
    return null;
  }
  let latest: number | null = null;
  for (const raw of matches) {
    const digits = raw.match(/(\d{1,3})%/);
    if (!digits) {
      continue;
    }
    const value = Number(digits[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      latest = value;
    }
  }
  return latest;
}

function shouldPreferExternalZip(archivePath: string): boolean {
  try {
    const stat = fs.statSync(archivePath);
    return stat.size >= 64 * 1024 * 1024;
  } catch {
    return true;
  }
}

function computeExtractTimeoutMs(archivePath: string): number {
  try {
    const relatedFiles = collectArchiveCleanupTargets(archivePath);
    let totalBytes = 0;
    for (const filePath of relatedFiles) {
      try {
        totalBytes += fs.statSync(filePath).size;
      } catch {
        // ignore missing parts
      }
    }
    if (totalBytes <= 0) {
      totalBytes = fs.statSync(archivePath).size;
    }
    const gib = totalBytes / (1024 * 1024 * 1024);
    const dynamicMs = EXTRACT_BASE_TIMEOUT_MS + Math.floor(gib * EXTRACT_PER_GIB_TIMEOUT_MS);
    return Math.max(EXTRACT_BASE_TIMEOUT_MS, Math.min(EXTRACT_MAX_TIMEOUT_MS, dynamicMs));
  } catch {
    return EXTRACT_BASE_TIMEOUT_MS;
  }
}

function extractProgressFilePath(packageDir: string): string {
  return path.join(packageDir, EXTRACT_PROGRESS_FILE);
}

function readExtractResumeState(packageDir: string): Set<string> {
  const progressPath = extractProgressFilePath(packageDir);
  if (!fs.existsSync(progressPath)) {
    return new Set<string>();
  }
  try {
    const payload = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Partial<ExtractResumeState>;
    const names = Array.isArray(payload.completedArchives) ? payload.completedArchives : [];
    return new Set(names.map((value) => String(value || "").trim()).filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

function writeExtractResumeState(packageDir: string, completedArchives: Set<string>): void {
  const progressPath = extractProgressFilePath(packageDir);
  const payload: ExtractResumeState = {
    completedArchives: Array.from(completedArchives).sort((a, b) => a.localeCompare(b))
  };
  fs.writeFileSync(progressPath, JSON.stringify(payload, null, 2), "utf8");
}

function clearExtractResumeState(packageDir: string): void {
  try {
    fs.rmSync(extractProgressFilePath(packageDir), { force: true });
  } catch {
    // ignore
  }
}

function isExtractAbortError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("aborted:extract") || text.includes("extract_aborted");
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

function prioritizePassword(passwords: string[], successful: string): string[] {
  const target = String(successful || "");
  if (!target || passwords.length <= 1) {
    return passwords;
  }
  const index = passwords.findIndex((candidate) => candidate === target);
  if (index <= 0) {
    return passwords;
  }
  const next = [...passwords];
  const [value] = next.splice(index, 1);
  next.unshift(value);
  return next;
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

function isUnsupportedExtractorSwitchError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("unknown switch")
    || text.includes("unknown option")
    || text.includes("invalid switch")
    || text.includes("unsupported option")
    || text.includes("unbekannter schalter")
    || text.includes("falscher parameter");
}

function shouldUseExtractorPerformanceFlags(): boolean {
  const raw = String(process.env.RD_EXTRACT_PERF_FLAGS || "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function extractorThreadSwitch(): string {
  const envValue = Number(process.env.RD_EXTRACT_THREADS ?? NaN);
  if (Number.isFinite(envValue) && envValue >= 1 && envValue <= 32) {
    return `-mt${Math.floor(envValue)}`;
  }
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const threadCount = Math.max(1, Math.min(16, cpuCount));
  return `-mt${threadCount}`;
}

type ExtractSpawnResult = {
  ok: boolean;
  missingCommand: boolean;
  aborted: boolean;
  timedOut: boolean;
  errorText: string;
};

function runExtractCommand(
  command: string,
  args: string[],
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<ExtractSpawnResult> {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, missingCommand: false, aborted: true, timedOut: false, errorText: "aborted:extract" });
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(command, args, { windowsHide: true });
    let timeoutId: NodeJS.Timeout | null = null;

    const finish = (result: ExtractSpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish({
          ok: false,
          missingCommand: false,
          aborted: false,
          timedOut: true,
          errorText: `Entpacken Timeout nach ${Math.ceil(timeoutMs / 1000)}s`
        });
      }, timeoutMs);
    }

    const onAbort = signal
      ? (): void => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish({ ok: false, missingCommand: false, aborted: true, timedOut: false, errorText: "aborted:extract" });
      }
      : null;
    if (signal && onAbort) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      output = appendLimited(output, text);
      onChunk?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      output = appendLimited(output, text);
      onChunk?.(text);
    });

    child.on("error", (error) => {
      const text = cleanErrorText(String(error));
      finish({
        ok: false,
        missingCommand: text.toLowerCase().includes("enoent"),
        aborted: false,
        timedOut: false,
        errorText: text
      });
    });

    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        finish({ ok: true, missingCommand: false, aborted: false, timedOut: false, errorText: "" });
        return;
      }
      const cleaned = cleanErrorText(output);
      finish({
        ok: false,
        missingCommand: false,
        aborted: false,
        timedOut: false,
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
  password = "",
  usePerformanceFlags = true
): string[] {
  const mode = effectiveConflictMode(conflictMode);
  const lower = command.toLowerCase();
  if (lower.includes("unrar") || lower.includes("winrar")) {
    const overwrite = mode === "overwrite" ? "-o+" : mode === "rename" ? "-or" : "-o-";
    const pass = password ? `-p${password}` : "-p-";
    const perfArgs = usePerformanceFlags && shouldUseExtractorPerformanceFlags()
      ? ["-idc", extractorThreadSwitch()]
      : [];
    return ["x", overwrite, pass, "-y", ...perfArgs, archivePath, `${targetDir}${path.sep}`];
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
  passwordCandidates: string[],
  onArchiveProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const command = await resolveExtractorCommand();
  const passwords = passwordCandidates;
  let lastError = "";
  const timeoutMs = computeExtractTimeoutMs(archivePath);

  fs.mkdirSync(targetDir, { recursive: true });

  let announcedStart = false;
  let bestPercent = 0;
  let usePerformanceFlags = externalExtractorSupportsPerfFlags && shouldUseExtractorPerformanceFlags();

  for (const password of passwords) {
    if (signal?.aborted) {
      throw new Error("aborted:extract");
    }
    if (!announcedStart) {
      announcedStart = true;
      onArchiveProgress?.(0);
    }
    let args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, usePerformanceFlags);
    let result = await runExtractCommand(command, args, (chunk) => {
      const parsed = parseProgressPercent(chunk);
      if (parsed === null || parsed <= bestPercent) {
        return;
      }
      bestPercent = parsed;
      onArchiveProgress?.(bestPercent);
    }, signal, timeoutMs);

    if (!result.ok && usePerformanceFlags && isUnsupportedExtractorSwitchError(result.errorText)) {
      usePerformanceFlags = false;
      externalExtractorSupportsPerfFlags = false;
      logger.warn(`Entpacker ohne Performance-Flags fortgesetzt: ${path.basename(archivePath)}`);
      args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, false);
      result = await runExtractCommand(command, args, (chunk) => {
        const parsed = parseProgressPercent(chunk);
        if (parsed === null || parsed <= bestPercent) {
          return;
        }
        bestPercent = parsed;
        onArchiveProgress?.(bestPercent);
      }, signal, timeoutMs);
    }

    if (result.ok) {
      onArchiveProgress?.(100);
      return password;
    }

    if (result.aborted) {
      throw new Error("aborted:extract");
    }

    if (result.timedOut) {
      lastError = result.errorText;
      break;
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

export function collectArchiveCleanupTargets(sourceArchivePath: string, directoryFiles?: string[]): string[] {
  const targets = new Set<string>([sourceArchivePath]);
  const dir = path.dirname(sourceArchivePath);
  const fileName = path.basename(sourceArchivePath);

  let filesInDir: string[] = directoryFiles ?? [];
  if (!directoryFiles) {
    try {
      filesInDir = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return Array.from(targets);
    }
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

  const splitZip = fileName.match(/^(.*)\.zip\.\d{3}$/i);
  if (splitZip) {
    const stem = escapeRegex(splitZip[1]);
    addMatching(new RegExp(`^${stem}\\.zip$`, "i"));
    addMatching(new RegExp(`^${stem}\\.zip\\.\\d{3}$`, "i"));
    return Array.from(targets);
  }

  if (/\.7z$/i.test(fileName)) {
    const stem = escapeRegex(fileName.replace(/\.7z$/i, ""));
    addMatching(new RegExp(`^${stem}\\.7z$`, "i"));
    addMatching(new RegExp(`^${stem}\\.7z\\.\\d{3}$`, "i"));
    return Array.from(targets);
  }

  const splitSeven = fileName.match(/^(.*)\.7z\.\d{3}$/i);
  if (splitSeven) {
    const stem = escapeRegex(splitSeven[1]);
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
  const dirFilesCache = new Map<string, string[]>();
  for (const sourceFile of sourceFiles) {
    const dir = path.dirname(sourceFile);
    let filesInDir = dirFilesCache.get(dir);
    if (!filesInDir) {
      try {
        filesInDir = fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        filesInDir = [];
      }
      dirFilesCache.set(dir, filesInDir);
    }

    for (const target of collectArchiveCleanupTargets(sourceFile, filesInDir)) {
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
  const deadline = Date.now() + 70;
  let inspectedDirs = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    inspectedDirs += 1;
    if (inspectedDirs > 8000 || Date.now() > deadline) {
      return true;
    }
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

function hasAnyEntries(rootDir: string): boolean {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return false;
  }
  try {
    return fs.readdirSync(rootDir).length > 0;
  } catch {
    return false;
  }
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
  if (options.signal?.aborted) {
    throw new Error("aborted:extract");
  }

  const candidates = findArchiveCandidates(options.packageDir);
  logger.info(`Entpacken gestartet: packageDir=${options.packageDir}, targetDir=${options.targetDir}, archives=${candidates.length}, cleanupMode=${options.cleanupMode}, conflictMode=${options.conflictMode}`);
  if (candidates.length === 0) {
    const existingResume = readExtractResumeState(options.packageDir);
    if (existingResume.size > 0 && hasAnyEntries(options.targetDir)) {
      clearExtractResumeState(options.packageDir);
      logger.info(`Entpacken übersprungen (Archive bereinigt, Ziel hat Dateien): ${options.packageDir}`);
      options.onProgress?.({
        current: existingResume.size,
        total: existingResume.size,
        percent: 100,
        archiveName: "",
        phase: "done"
      });
      return { extracted: existingResume.size, failed: 0, lastError: "" };
    }
    clearExtractResumeState(options.packageDir);
    logger.info(`Entpacken übersprungen (keine Archive gefunden): ${options.packageDir}`);
    return { extracted: 0, failed: 0, lastError: "" };
  }

  const conflictMode = effectiveConflictMode(options.conflictMode);
  let passwordCandidates = archivePasswords(options.passwordList || "");
  const resumeCompleted = readExtractResumeState(options.packageDir);
  const resumeCompletedAtStart = resumeCompleted.size;
  const candidateNames = new Set(candidates.map((archivePath) => path.basename(archivePath)));
  for (const archiveName of Array.from(resumeCompleted.values())) {
    if (!candidateNames.has(archiveName)) {
      resumeCompleted.delete(archiveName);
    }
  }
  if (resumeCompleted.size > 0) {
    writeExtractResumeState(options.packageDir, resumeCompleted);
  } else {
    clearExtractResumeState(options.packageDir);
  }

  const pendingCandidates = candidates.filter((archivePath) => !resumeCompleted.has(path.basename(archivePath)));
  let extracted = resumeCompleted.size;
  let failed = 0;
  let lastError = "";
  const extractedArchives = new Set<string>();
  for (const archivePath of candidates) {
    if (resumeCompleted.has(path.basename(archivePath))) {
      extractedArchives.add(archivePath);
    }
  }

  const emitProgress = (
    current: number,
    archiveName: string,
    phase: "extracting" | "done",
    archivePercent?: number,
    elapsedMs?: number
  ): void => {
    if (!options.onProgress) {
      return;
    }
    const total = Math.max(1, candidates.length);
    let percent = Math.max(0, Math.min(100, Math.floor((current / total) * 100)));
    if (phase !== "done") {
      const boundedCurrent = Math.max(0, Math.min(total, current));
      const boundedArchivePercent = Math.max(0, Math.min(100, Number(archivePercent ?? 0)));
      percent = Math.max(0, Math.min(100, Math.floor(((boundedCurrent + (boundedArchivePercent / 100)) / total) * 100)));
    }
    options.onProgress({
      current,
      total,
      percent,
      archiveName,
      archivePercent,
      elapsedMs,
      phase
    });
  };

  emitProgress(extracted, "", "extracting");

  for (const archivePath of pendingCandidates) {
    if (options.signal?.aborted) {
      throw new Error("aborted:extract");
    }
    const archiveName = path.basename(archivePath);
    const archiveStartedAt = Date.now();
    let archivePercent = 0;
    emitProgress(extracted + failed, archiveName, "extracting", archivePercent, 0);
    const pulseTimer = setInterval(() => {
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
    }, 1100);
    logger.info(`Entpacke Archiv: ${path.basename(archivePath)} -> ${options.targetDir}`);
    try {
      const ext = path.extname(archivePath).toLowerCase();
      if (ext === ".zip") {
        const preferExternal = shouldPreferExternalZip(archivePath);
        if (preferExternal) {
          try {
            const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, passwordCandidates, (value) => {
              archivePercent = Math.max(archivePercent, value);
              emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
            }, options.signal);
            passwordCandidates = prioritizePassword(passwordCandidates, usedPassword);
          } catch (error) {
            if (isNoExtractorError(String(error))) {
              extractZipArchive(archivePath, options.targetDir, options.conflictMode);
            } else {
              throw error;
            }
          }
        } else {
          try {
            extractZipArchive(archivePath, options.targetDir, options.conflictMode);
            archivePercent = 100;
          } catch {
            const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, passwordCandidates, (value) => {
              archivePercent = Math.max(archivePercent, value);
              emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
            }, options.signal);
            passwordCandidates = prioritizePassword(passwordCandidates, usedPassword);
          }
        }
      } else {
        const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, passwordCandidates, (value) => {
          archivePercent = Math.max(archivePercent, value);
          emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
        }, options.signal);
        passwordCandidates = prioritizePassword(passwordCandidates, usedPassword);
      }
      extracted += 1;
      extractedArchives.add(archivePath);
      resumeCompleted.add(archiveName);
      writeExtractResumeState(options.packageDir, resumeCompleted);
      logger.info(`Entpacken erfolgreich: ${path.basename(archivePath)}`);
      archivePercent = 100;
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
    } catch (error) {
      failed += 1;
      const errorText = String(error);
      if (isExtractAbortError(errorText)) {
        throw new Error("aborted:extract");
      }
      lastError = errorText;
      logger.error(`Entpack-Fehler ${path.basename(archivePath)}: ${errorText}`);
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
      if (isNoExtractorError(errorText)) {
        const remaining = candidates.length - (extracted + failed);
        if (remaining > 0) {
          failed += remaining;
          emitProgress(candidates.length, archiveName, "extracting", 0, Date.now() - archiveStartedAt);
        }
        break;
      }
    } finally {
      clearInterval(pulseTimer);
    }
  }

  if (extracted > 0) {
    const hasOutputAfter = hasAnyEntries(options.targetDir);
    const hadResumeProgress = resumeCompletedAtStart > 0;
    if (!hasOutputAfter && conflictMode !== "skip" && !hadResumeProgress) {
      lastError = "Keine entpackten Dateien erkannt";
      failed += extracted;
      extracted = 0;
      logger.error(`Entpacken ohne neue Ausgabe erkannt: ${options.targetDir}. Cleanup wird NICHT ausgeführt.`);
    } else {
      const cleanupSources = failed === 0 ? candidates : Array.from(extractedArchives.values());
      const removedArchives = cleanupArchives(cleanupSources, options.cleanupMode);
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

      if (failed === 0 && resumeCompleted.size >= candidates.length) {
        clearExtractResumeState(options.packageDir);
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

  if (failed > 0) {
    if (resumeCompleted.size > 0) {
      writeExtractResumeState(options.packageDir, resumeCompleted);
    } else {
      clearExtractResumeState(options.packageDir);
    }
  }

  emitProgress(candidates.length, "", "done");

  logger.info(`Entpacken beendet: extracted=${extracted}, failed=${failed}, targetDir=${options.targetDir}`);

  return { extracted, failed, lastError };
}
