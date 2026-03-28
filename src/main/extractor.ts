// ════════════════════════════════════════════════════════════════════════════
// Sektion 1 — Imports & Konstanten
// ════════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import AdmZip from "adm-zip";
import { CleanupMode, ConflictMode } from "../shared/types";
import { logger } from "./logger";
import { removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";

import crypto from "node:crypto";

const DEFAULT_ARCHIVE_PASSWORDS = ["", "serienfans.org", "serienjunkies.org"];
const NO_EXTRACTOR_MESSAGE = "Kein nativer Entpacker gefunden (7-Zip/WinRAR). Bitte 7-Zip oder WinRAR installieren.";
const NO_JVM_EXTRACTOR_MESSAGE = "7-Zip-JBinding Runtime nicht gefunden. Bitte resources/extractor-jvm prüfen.";
const JVM_EXTRACTOR_MAIN_CLASS = "com.sucukdeluxe.extractor.JBindExtractorMain";
const JVM_EXTRACTOR_CLASSES_SUBDIR = "classes";
const JVM_EXTRACTOR_LIB_SUBDIR = "lib";
const JVM_EXTRACTOR_REQUIRED_LIBS = [
  "sevenzipjbinding.jar",
  "sevenzipjbinding-all-platforms.jar",
  "zip4j.jar"
];

let resolvedExtractorCommand: string | null = null;
let resolveFailureReason = "";
let resolveFailureAt = 0;
let externalExtractorSupportsPerfFlags = true;
let resolveExtractorCommandInFlight: Promise<string> | null = null;

const EXTRACTOR_RETRY_AFTER_MS = 30_000;
const DEFAULT_ZIP_ENTRY_MEMORY_LIMIT_MB = 256;
const MAX_EXTRACT_OUTPUT_BUFFER = 48 * 1024;
const EXTRACT_PROGRESS_FILE = ".rd_extract_progress.json";
const EXTRACT_BASE_TIMEOUT_MS = 6 * 60 * 1000;
const EXTRACT_PER_GIB_TIMEOUT_MS = 4 * 60 * 1000;
const EXTRACT_MAX_TIMEOUT_MS = 120 * 60 * 1000;
const ARCHIVE_SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const DISK_SPACE_SAFETY_FACTOR = 1.1;
const NESTED_EXTRACT_BLACKLIST_RE = /\.(iso|img|bin|dmg|vhd|vhdx|vmdk|wim)$/i;
const PACKAGE_PASSWORD_CACHE_LIMIT = 256;
const packageLearnedPasswords = new Map<string, string>();
const EXTRACTOR_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_EXTRACT_CPU_BUDGET_PERCENT = 80;
let currentExtractCpuPriority: string | undefined;

// ════════════════════════════════════════════════════════════════════════════
// Sektion 2 — Types & Interfaces
// ════════════════════════════════════════════════════════════════════════════

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
  onlyArchives?: Set<string>;
  skipPostCleanup?: boolean;
  packageId?: string;
  hybridMode?: boolean;
  maxParallel?: number;
  extractCpuPriority?: string;
  onArchiveFailure?: (failure: ExtractArchiveFailureInfo) => void;
  onLog?: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface ExtractProgressUpdate {
  current: number;
  total: number;
  percent: number;
  archiveName: string;
  archivePercent?: number;
  elapsedMs?: number;
  phase: "extracting" | "done" | "preparing";
  passwordAttempt?: number;
  passwordTotal?: number;
  passwordFound?: boolean;
  archiveDone?: boolean;
  archiveSuccess?: boolean;
}

export interface ExtractArchiveFailureInfo {
  archiveName: string;
  errorText: string;
  category: ExtractErrorCategory;
  suggestRedownload: boolean;
  jvmFailureReason?: string;
}

export type ArchiveSignature = "rar" | "7z" | "zip" | "gzip" | "bzip2" | "xz" | null;

const ARCHIVE_SIGNATURES: { prefix: string; type: ArchiveSignature }[] = [
  { prefix: "526172211a07", type: "rar" },
  { prefix: "377abcaf271c", type: "7z" },
  { prefix: "504b0304", type: "zip" },
  { prefix: "1f8b08", type: "gzip" },
  { prefix: "425a68", type: "bzip2" },
  { prefix: "fd377a585a00", type: "xz" },
];

export type ExtractErrorCategory =
  | "crc_error"
  | "wrong_password"
  | "missing_parts"
  | "unsupported_format"
  | "disk_full"
  | "timeout"
  | "aborted"
  | "no_extractor"
  | "unknown";

type ExtractionErrorWithHints = Error & {
  suggestRedownload?: boolean;
  jvmFailureReason?: string;
  legacyBestPercent?: number;
  legacyExtractor?: string;
};

type ExtractBackendMode = "auto" | "jvm" | "legacy";

type JvmExtractorLayout = {
  javaCommand: string;
  classPath: string;
  rootDir: string;
};

type JvmExtractResult = {
  ok: boolean;
  missingCommand: boolean;
  missingRuntime: boolean;
  aborted: boolean;
  timedOut: boolean;
  errorText: string;
  usedPassword: string;
  backend: string;
};

type ExtractSpawnResult = {
  ok: boolean;
  missingCommand: boolean;
  aborted: boolean;
  timedOut: boolean;
  errorText: string;
};

type ExtractResumeState = {
  completedArchives: string[];
};

type ExtractorCommandKind = "rar_native" | "seven_zip" | "other";

interface SubstMapping { drive: string; original: string; }

interface DaemonRequest {
  resolve: (result: JvmExtractResult) => void;
  onArchiveProgress?: (percent: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  parseState: { bestPercent: number; usedPassword: string; backend: string; reportedError: string };
  archiveName: string;
  startedAt: number;
  passwordCount: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 3 — Subst Drive Mapping (Windows long-path workaround)
// ════════════════════════════════════════════════════════════════════════════

const activeSubstDrives = new Set<string>();

function findFreeSubstDrive(): string | null {
  if (process.platform !== "win32") return null;
  for (let code = 90; code >= 71; code--) { // Z to G
    const letter = String.fromCharCode(code);
    if (activeSubstDrives.has(letter)) continue;
    try {
      fs.accessSync(`${letter}:\\`);
      // Drive exists, skip
    } catch {
      return letter;
    }
  }
  return null;
}

function createSubstMapping(targetDir: string): SubstMapping | null {
  if (process.platform !== "win32" || !path.isAbsolute(targetDir)) return null;
  const drive = findFreeSubstDrive();
  if (!drive) return null;
  const result = spawnSync("subst", [`${drive}:`, targetDir], { stdio: "pipe", timeout: 5000 });
  if (result.status !== 0) {
    logger.warn(`subst ${drive}: fehlgeschlagen: ${String(result.stderr || "").trim()}`);
    return null;
  }
  activeSubstDrives.add(drive);
  logger.info(`subst ${drive}: -> ${targetDir}`);
  return { drive, original: targetDir };
}

function removeSubstMapping(mapping: SubstMapping): void {
  spawnSync("subst", [`${mapping.drive}:`, "/d"], { stdio: "pipe", timeout: 5000 });
  activeSubstDrives.delete(mapping.drive);
  logger.info(`subst ${mapping.drive}: entfernt`);
}

export function cleanupStaleSubstDrives(): void {
  if (process.platform !== "win32") return;
  try {
    const result = spawnSync("subst", [], { stdio: "pipe", timeout: 5000 });
    const output = String(result.stdout || "");
    for (const line of output.split("\n")) {
      const match = line.match(/^([A-Z]):\\: => (.+)/i);
      if (!match) continue;
      const drive = match[1].toUpperCase();
      const target = match[2].trim();
      if (/\\rd-extract-|\\Real-Debrid-Downloader/i.test(target)) {
        spawnSync("subst", [`${drive}:`, "/d"], { stdio: "pipe", timeout: 5000 });
        logger.info(`Stale subst ${drive}: entfernt (${target})`);
      }
    }
  } catch {
    // ignore — subst cleanup is best-effort
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 4 — Archiv-Erkennung & Kandidaten
// ════════════════════════════════════════════════════════════════════════════

export async function detectArchiveSignature(filePath: string): Promise<ArchiveSignature> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fd.read(buf, 0, 8, 0);
    if (bytesRead < 3) return null;
    const hex = buf.subarray(0, bytesRead).toString("hex");
    for (const sig of ARCHIVE_SIGNATURES) {
      if (hex.startsWith(sig.prefix)) return sig.type;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

export function pathSetKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function archiveNameKey(fileName: string): string {
  return process.platform === "win32" ? String(fileName || "").toLowerCase() : String(fileName || "");
}

function stripDuplicateSuffixBeforeExtension(fileName: string): string {
  return String(fileName || "").replace(/ \(\d+\)(?=\.[^.]+$)/, "");
}

function hasDuplicateSuffixBeforeExtension(fileName: string): boolean {
  return stripDuplicateSuffixBeforeExtension(fileName) !== String(fileName || "");
}

function archiveDetectionName(fileName: string): string {
  return stripDuplicateSuffixBeforeExtension(path.basename(String(fileName || "")));
}

function archiveCandidateIdentity(filePath: string): string {
  const normalizedPath = path.join(path.dirname(filePath), archiveDetectionName(filePath));
  return pathSetKey(normalizedPath);
}

function prefersArchiveCandidate(nextCandidate: string, currentCandidate: string): boolean {
  const nextName = path.basename(nextCandidate);
  const currentName = path.basename(currentCandidate);
  const nextHasDuplicateSuffix = hasDuplicateSuffixBeforeExtension(nextName);
  const currentHasDuplicateSuffix = hasDuplicateSuffixBeforeExtension(currentName);
  if (nextHasDuplicateSuffix !== currentHasDuplicateSuffix) {
    return !nextHasDuplicateSuffix;
  }
  return ARCHIVE_SORT_COLLATOR.compare(nextName, currentName) < 0;
}

function archiveSortKey(filePath: string): string {
  const fileName = archiveDetectionName(filePath).toLowerCase();
  return fileName
    .replace(/\.part0*1\.rar$/i, "")
    .replace(/\.zip\.\d{3}$/i, "")
    .replace(/\.7z\.\d{3}$/i, "")
    .replace(/\.\d{3}$/i, "")
    .replace(/\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|txz)$/i, "")
    .replace(/\.rar$/i, "")
    .replace(/\.zip$/i, "")
    .replace(/\.7z$/i, "")
    .replace(/[._\-\s]+$/g, "");
}

function archiveTypeRank(filePath: string): number {
  const fileName = archiveDetectionName(filePath).toLowerCase();
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
  if (/\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|txz)$/i.test(fileName)) {
    return 4;
  }
  if (/\.\d{3}$/i.test(fileName)) {
    return 5;
  }
  return 9;
}

export async function findArchiveCandidates(packageDir: string): Promise<string[]> {
  if (!packageDir) {
    return [];
  }
  try {
    await fs.promises.access(packageDir);
  } catch {
    return [];
  }

  let files: string[] = [];
  try {
    files = (await fs.promises.readdir(packageDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(packageDir, entry.name));
  } catch {
    return [];
  }

  const fileNamesLower = new Set(files.map((filePath) => archiveDetectionName(filePath).toLowerCase()));
  const multipartRar = files.filter((filePath) => /\.part0*1\.rar$/i.test(archiveDetectionName(filePath)));
  const singleRar = files.filter((filePath) => {
    const fileName = archiveDetectionName(filePath);
    return /\.rar$/i.test(fileName) && !/\.part\d+\.rar$/i.test(fileName);
  });
  const zipSplit = files.filter((filePath) => /\.zip\.001$/i.test(archiveDetectionName(filePath)));
  const zip = files.filter((filePath) => {
    const fileName = archiveDetectionName(filePath);
    if (!/\.zip$/i.test(fileName)) {
      return false;
    }
    return !fileNamesLower.has(`${fileName}.001`.toLowerCase());
  });
  const sevenSplit = files.filter((filePath) => /\.7z\.001$/i.test(archiveDetectionName(filePath)));
  const seven = files.filter((filePath) => {
    const fileName = archiveDetectionName(filePath);
    if (!/\.7z$/i.test(fileName)) {
      return false;
    }
    return !fileNamesLower.has(`${fileName}.001`.toLowerCase());
  });
  const tarCompressed = files.filter((filePath) => /\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|txz)$/i.test(filePath));
  // Generic .001 splits (HJSplit etc.) — exclude already-recognized .zip.001 and .7z.001
  const genericSplit = files.filter((filePath) => {
    const fileName = archiveDetectionName(filePath).toLowerCase();
    if (!/\.001$/.test(fileName)) return false;
    if (/\.zip\.001$/.test(fileName) || /\.7z\.001$/.test(fileName)) return false;
    return true;
  });

  const unique: string[] = [];
  const seen = new Map<string, number>();
  for (const candidate of [...multipartRar, ...singleRar, ...zipSplit, ...zip, ...sevenSplit, ...seven, ...tarCompressed, ...genericSplit]) {
    const key = archiveCandidateIdentity(candidate);
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (prefersArchiveCandidate(candidate, unique[existingIndex])) {
        unique[existingIndex] = candidate;
      }
      continue;
    }
    seen.set(key, unique.length);
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

// ════════════════════════════════════════════════════════════════════════════
// Sektion 5 — Cleanup & Dateisystem
// ════════════════════════════════════════════════════════════════════════════

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
    // RAR5 recovery volumes: prefix.partN.rev AND legacy prefix.rev
    addMatching(new RegExp(`^${prefix}\\.part\\d+\\.rev$`, "i"));
    addMatching(new RegExp(`^${prefix}\\.rev$`, "i"));
    return Array.from(targets);
  }

  if (/\.rar$/i.test(fileName)) {
    const stem = escapeRegex(fileName.replace(/\.rar$/i, ""));
    addMatching(new RegExp(`^${stem}\\.rar$`, "i"));
    addMatching(new RegExp(`^${stem}\\.r\\d{2,3}$`, "i"));
    addMatching(new RegExp(`^${stem}\\.rev$`, "i"));
    return Array.from(targets);
  }

  if (/\.zip$/i.test(fileName)) {
    const stem = escapeRegex(fileName.replace(/\.zip$/i, ""));
    addMatching(new RegExp(`^${stem}\\.zip$`, "i"));
    addMatching(new RegExp(`^${stem}\\.z\\d{2,3}$`, "i"));
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

  // Tar compound archives (.tar.gz, .tar.bz2, .tar.xz, .tgz, .tbz2, .txz)
  if (/\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|txz)$/i.test(fileName)) {
    return Array.from(targets);
  }

  // Generic .NNN split files (HJSplit etc.)
  const genericSplit = fileName.match(/^(.*)\.(\d{3})$/i);
  if (genericSplit) {
    const stem = escapeRegex(genericSplit[1]);
    addMatching(new RegExp(`^${stem}\\.\\d{3}$`, "i"));
    return Array.from(targets);
  }

  return Array.from(targets);
}

export async function cleanupArchives(
  sourceFiles: string[],
  cleanupMode: CleanupMode,
  options: { shouldAbort?: () => boolean } = {}
): Promise<number> {
  if (cleanupMode === "none") {
    return 0;
  }

  const targets = new Set<string>();
  const dirFilesCache = new Map<string, string[]>();
  for (const sourceFile of sourceFiles) {
    if (options.shouldAbort?.()) {
      return 0;
    }
    const dir = path.dirname(sourceFile);
    let filesInDir = dirFilesCache.get(dir);
    if (!filesInDir) {
      try {
        filesInDir = (await fs.promises.readdir(dir, { withFileTypes: true }))
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

  const moveToTrashLike = async (filePath: string): Promise<boolean> => {
    try {
      const parsed = path.parse(filePath);
      const trashDir = path.join(parsed.dir, ".rd-trash");
      await fs.promises.mkdir(trashDir, { recursive: true });
      let index = 0;
      while (index <= 10000) {
        const suffix = index === 0 ? "" : `-${index}`;
        const candidate = path.join(trashDir, `${parsed.base}.${Date.now()}${suffix}`);
        const candidateExists = await fs.promises.access(candidate).then(() => true, () => false);
        if (!candidateExists) {
          await fs.promises.rename(filePath, candidate);
          return true;
        }
        index += 1;
      }
    } catch {
      // ignore
    }
    return false;
  };

  for (const filePath of targets) {
    if (options.shouldAbort?.()) {
      return removed;
    }
    try {
      const fileExists = await fs.promises.access(filePath).then(() => true, () => false);
      if (!fileExists) {
        continue;
      }
      if (cleanupMode === "trash") {
        if (await moveToTrashLike(filePath)) {
          removed += 1;
        }
        continue;
      }
      await fs.promises.rm(filePath, { force: true });
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

export async function hasAnyFilesRecursive(rootDir: string): Promise<boolean> {
  const rootExists = await fs.promises.access(rootDir).then(() => true, () => false);
  if (!rootExists) {
    return false;
  }
  const deadline = Date.now() + 220;
  let inspectedDirs = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    inspectedDirs += 1;
    if (inspectedDirs > 8000 || Date.now() > deadline) {
      return hasAnyEntries(rootDir);
    }
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
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

async function hasAnyEntries(rootDir: string): Promise<boolean> {
  if (!rootDir) {
    return false;
  }
  const rootExists = await fs.promises.access(rootDir).then(() => true, () => false);
  if (!rootExists) {
    return false;
  }
  try {
    return (await fs.promises.readdir(rootDir)).length > 0;
  } catch {
    return false;
  }
}

export async function removeEmptyDirectoryTree(rootDir: string): Promise<number> {
  const rootExists = await fs.promises.access(rootDir).then(() => true, () => false);
  if (!rootExists) {
    return 0;
  }

  const dirs = [rootDir];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
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
      const entries = await fs.promises.readdir(dirPath);
      if (entries.length === 0) {
        await fs.promises.rmdir(dirPath);
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 6 — Passwort-Management (LRU-Cache & Kandidaten)
// ════════════════════════════════════════════════════════════════════════════

function packagePasswordCacheKey(packageDir: string, packageId?: string): string {
  const normalizedPackageId = String(packageId || "").trim();
  if (normalizedPackageId) {
    return `pkg:${normalizedPackageId}`;
  }
  return `dir:${pathSetKey(path.resolve(packageDir))}`;
}

function packagePasswordCacheLabel(packageDir: string, packageId?: string): string {
  const normalizedPackageId = String(packageId || "").trim();
  if (normalizedPackageId) {
    return `packageId=${normalizedPackageId.slice(0, 8)}`;
  }
  return `packageDir=${path.basename(path.resolve(packageDir))}`;
}

function readCachedPackagePassword(cacheKey: string): string {
  const cached = packageLearnedPasswords.get(cacheKey);
  if (!cached) {
    return "";
  }
  // Refresh insertion order to keep recently used package caches alive.
  packageLearnedPasswords.delete(cacheKey);
  packageLearnedPasswords.set(cacheKey, cached);
  return cached;
}

function writeCachedPackagePassword(cacheKey: string, password: string): void {
  const normalized = String(password || "").trim();
  if (!normalized) {
    return;
  }
  if (packageLearnedPasswords.has(cacheKey)) {
    packageLearnedPasswords.delete(cacheKey);
  }
  packageLearnedPasswords.set(cacheKey, normalized);
  if (packageLearnedPasswords.size > PACKAGE_PASSWORD_CACHE_LIMIT) {
    const oldestKey = packageLearnedPasswords.keys().next().value as string | undefined;
    if (oldestKey) {
      packageLearnedPasswords.delete(oldestKey);
    }
  }
}

function clearCachedPackagePassword(cacheKey: string): void {
  packageLearnedPasswords.delete(cacheKey);
}

export function archiveFilenamePasswords(archiveName: string): string[] {
  const name = String(archiveName || "");
  if (!name) return [];
  const stem = name
    .replace(/\.part\d+\.rar$/i, "")
    .replace(/\.zip\.\d{3}$/i, "")
    .replace(/\.7z\.\d{3}$/i, "")
    .replace(/\.\d{3}$/i, "")
    .replace(/\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|txz)$/i, "")
    .replace(/\.(rar|zip|7z|tar|gz|bz2|xz)$/i, "");
  if (!stem) return [];
  const candidates = [stem];
  const withSpaces = stem.replace(/[._]/g, " ");
  if (withSpaces !== stem) candidates.push(withSpaces);
  return candidates;
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
  if (index === 0) {
    return passwords;
  }
  if (index < 0) {
    return [target, ...passwords.filter((candidate) => candidate !== target)];
  }
  const next = [...passwords];
  const [value] = next.splice(index, 1);
  next.unshift(value);
  return next;
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 7 — Fehler-Klassifizierung
// ════════════════════════════════════════════════════════════════════════════

export function cleanErrorText(text: string): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 500) {
    return normalized;
  }
  const head = normalized.slice(0, 240).trimEnd();
  const tail = normalized.slice(-240).trimStart();
  return `${head} ... ${tail}`;
}

function appendLimited(base: string, chunk: string, maxLen = MAX_EXTRACT_OUTPUT_BUFFER): string {
  const next = `${base}${chunk}`;
  if (next.length <= maxLen) {
    return next;
  }
  return next.slice(next.length - maxLen);
}

function withExtractionErrorHints(
  error: unknown,
  hints: {
    suggestRedownload?: boolean;
    jvmFailureReason?: string;
    legacyBestPercent?: number;
    legacyExtractor?: string;
  }
): Error {
  const base = error instanceof Error ? error : new Error(String(error || "Entpacken fehlgeschlagen"));
  const enhanced = base as ExtractionErrorWithHints;
  if (hints.suggestRedownload) {
    enhanced.suggestRedownload = true;
  }
  if (hints.jvmFailureReason) {
    enhanced.jvmFailureReason = hints.jvmFailureReason;
  }
  if (Number.isFinite(hints.legacyBestPercent)) {
    enhanced.legacyBestPercent = Math.max(Number(enhanced.legacyBestPercent || 0), Number(hints.legacyBestPercent || 0));
  }
  if (hints.legacyExtractor) {
    enhanced.legacyExtractor = hints.legacyExtractor;
  }
  return enhanced;
}

export function classifyExtractionError(errorText: string): ExtractErrorCategory {
  const text = String(errorText || "").toLowerCase();
  if (text.includes("aborted:extract") || text.includes("extract_aborted")) return "aborted";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("crc failed") || text.includes("checksum error") || text.includes("crc error")) return "crc_error";
  if (text.includes("wrong password") || text.includes("falsches passwort") || text.includes("incorrect password")) return "wrong_password";
  if (text.includes("missing volume") || text.includes("next volume") || text.includes("unexpected end of archive") || text.includes("missing parts")) return "missing_parts";
  if (text.includes("nicht gefunden") || text.includes("not found") || text.includes("no extractor")) return "no_extractor";
  if (text.includes("kein rar-archiv") || text.includes("not a rar archive") || text.includes("unsupported") || text.includes("unsupportedmethod")) return "unsupported_format";
  if (text.includes("disk full") || text.includes("speicherplatz") || text.includes("no space left") || text.includes("not enough space")) return "disk_full";
  return "unknown";
}

export function shouldSerialRetryParallelFailures(
  extractedCount: number,
  failedCategories: ExtractErrorCategory[]
): boolean {
  if (failedCategories.length === 0) {
    return false;
  }
  if (extractedCount > 0) {
    return true;
  }
  return failedCategories.every((category) =>
    category === "crc_error"
    || category === "wrong_password"
    || category === "unknown"
  );
}

export function shouldFallbackLegacyRarToJvm(
  archivePath: string,
  configuredMode: ExtractBackendMode,
  backendMode: ExtractBackendMode,
  errorText: string,
  bestPercent = 0,
  platform = process.platform
): boolean {
  if (configuredMode !== "auto" || backendMode !== "legacy") {
    return false;
  }
  if (String(platform || "").toLowerCase() !== "win32") {
    return false;
  }
  if (!isRarArchivePath(archivePath)) {
    return false;
  }

  const category = classifyExtractionError(errorText);
  if (category === "aborted" || category === "timeout" || category === "no_extractor" || category === "missing_parts" || category === "disk_full") {
    return false;
  }

  const text = String(errorText || "").toLowerCase();
  if (text.includes("cannot create")) {
    return false;
  }

  return bestPercent > 0 || category === "unknown";
}

function isExtractAbortError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("aborted:extract") || text.includes("extract_aborted") || text.includes("noextractor:skipped");
}

function isNoExtractorError(errorText: string): boolean {
  return String(errorText || "").toLowerCase().includes("nicht gefunden");
}

function isUnsupportedArchiveFormatError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("kein rar-archiv")
    || text.includes("not a rar archive")
    || text.includes("is not a rar archive");
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

function isJvmRuntimeMissingError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("could not find or load main class")
    || text.includes("classnotfoundexception")
    || text.includes("noclassdeffounderror")
    || text.includes("unsatisfiedlinkerror")
    || text.includes("enoent");
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 8 — Backend-Modus (auto / jvm / legacy)
// ════════════════════════════════════════════════════════════════════════════

export function resolveExtractorBackendMode(
  rawValue?: string | null,
  isVitestEnv = Boolean(process.env.VITEST)
): ExtractBackendMode {
  const defaultMode: ExtractBackendMode = isVitestEnv ? "legacy" : "auto";
  const raw = String(rawValue ?? defaultMode).trim().toLowerCase();
  if (raw === "legacy") {
    return "legacy";
  }
  if (raw === "jvm" || raw === "jbind" || raw === "7zjbinding") {
    return "jvm";
  }
  return "auto";
}

export function resolveExtractorBackendModeForArchive(
  archivePath: string,
  rawValue?: string | null,
  isVitestEnv = Boolean(process.env.VITEST),
  platform = process.platform
): ExtractBackendMode {
  const requestedMode = resolveExtractorBackendMode(rawValue, isVitestEnv);
  if (requestedMode !== "auto") {
    return requestedMode;
  }
  // On Windows, multipart RAR extraction feels significantly snappier with the
  // native CLI path than with the JVM backend, and we already harden that path
  // with subst + flat-mode fallback.
  if (String(platform || "").toLowerCase() === "win32" && isRarArchivePath(archivePath)) {
    return "legacy";
  }
  return requestedMode;
}

function extractorBackendMode(): ExtractBackendMode {
  return resolveExtractorBackendMode(process.env.RD_EXTRACT_BACKEND);
}

function extractorBackendModeForArchive(archivePath: string): ExtractBackendMode {
  return resolveExtractorBackendModeForArchive(archivePath, process.env.RD_EXTRACT_BACKEND);
}

function isRarArchivePath(filePath: string): boolean {
  return /\.(?:rar|r\d{2,3})$/i.test(String(filePath || ""));
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 9 — Native Extractor Resolution (7-Zip / WinRAR)
// ════════════════════════════════════════════════════════════════════════════

function is7zCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes("7z") && !lower.includes("unrar") && !lower.includes("winrar");
}

function isRarNativeCommand(command: string): boolean {
  const base = path.basename(String(command || "")).toLowerCase();
  return base === "unrar.exe"
    || base === "unrar"
    || base === "winrar.exe"
    || base === "rar.exe"
    || base === "rar";
}

function extractorCommandKind(command: string): ExtractorCommandKind {
  if (isRarNativeCommand(command)) {
    return "rar_native";
  }
  if (is7zCommand(command)) {
    return "seven_zip";
  }
  return "other";
}

function isAbsoluteCommand(command: string): boolean {
  return path.isAbsolute(command)
    || command.includes("\\")
    || command.includes("/");
}

function cachedExtractorFitsArchive(command: string, archivePath: string): boolean {
  if (!archivePath) {
    return true;
  }
  const kind = extractorCommandKind(command);
  if (isRarArchivePath(archivePath)) {
    return kind === "rar_native";
  }
  return kind === "seven_zip";
}

export function orderExtractorCandidatesForArchive(
  candidates: string[],
  archivePath: string,
  preferredCommand = ""
): string[] {
  const unique = Array.from(new Set(candidates.filter(Boolean)));
  const preferRarNative = isRarArchivePath(archivePath);
  const rank = (command: string): number => {
    const kind = extractorCommandKind(command);
    if (preferRarNative) {
      if (kind === "rar_native") return 0;
      if (kind === "seven_zip") return 1;
      return 2;
    }
    if (kind === "seven_zip") return 0;
    if (kind === "rar_native") return 1;
    return 2;
  };

  return unique
    .map((command, index) => ({ command, index }))
    .sort((left, right) => {
      const rankDiff = rank(left.command) - rank(right.command);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      const leftPreferred = preferredCommand && left.command === preferredCommand;
      const rightPreferred = preferredCommand && right.command === preferredCommand;
      if (leftPreferred !== rightPreferred) {
        return leftPreferred ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.command);
}

function nativeExtractorCandidates(archivePath = ""): string[] {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const sevenZipInstalled = [
    process.env.RD_7Z_BIN || "",
    path.join(programFiles, "7-Zip", "7z.exe"),
    path.join(programFilesX86, "7-Zip", "7z.exe")
  ];
  if (localAppData) {
    sevenZipInstalled.push(path.join(localAppData, "Programs", "7-Zip", "7z.exe"));
  }

  const winRarInstalled = [
    path.join(programFiles, "WinRAR", "Rar.exe"),
    path.join(programFilesX86, "WinRAR", "Rar.exe"),
    path.join(programFiles, "WinRAR", "UnRAR.exe"),
    path.join(programFilesX86, "WinRAR", "UnRAR.exe")
  ];

  if (localAppData) {
    winRarInstalled.push(path.join(localAppData, "Programs", "WinRAR", "Rar.exe"));
    winRarInstalled.push(path.join(localAppData, "Programs", "WinRAR", "UnRAR.exe"));
  }

  const ordered = resolvedExtractorCommand
    ? [
      resolvedExtractorCommand,
      ...sevenZipInstalled,
      "7z.exe",
      "7z",
      "7za.exe",
      "7za",
      ...winRarInstalled,
      "Rar.exe",
      "rar",
      "UnRAR.exe",
      "unrar"
    ]
    : [
      ...sevenZipInstalled,
      "7z.exe",
      "7z",
      "7za.exe",
      "7za",
      ...winRarInstalled,
      "Rar.exe",
      "rar",
      "UnRAR.exe",
      "unrar"
    ];
  return orderExtractorCandidatesForArchive(ordered, archivePath, resolvedExtractorCommand || "");
}

function extractorProbeArgs(command: string): string[] {
  return isRarNativeCommand(command) ? ["-?"] : ["?"];
}

async function resolveExtractorCommandInternal(archivePath = ""): Promise<string> {
  if (resolvedExtractorCommand) {
    return resolvedExtractorCommand;
  }
  if (resolveFailureReason) {
    const age = Date.now() - resolveFailureAt;
    if (age < EXTRACTOR_RETRY_AFTER_MS) {
      throw new Error(resolveFailureReason);
    }
    resolveFailureReason = "";
    resolveFailureAt = 0;
  }

  const candidates = nativeExtractorCandidates(archivePath);
  for (const command of candidates) {
    if (isAbsoluteCommand(command) && !fs.existsSync(command)) {
      continue;
    }
    const probeArgs = extractorProbeArgs(command);
    const probe = await runExtractCommand(command, probeArgs, undefined, undefined, EXTRACTOR_PROBE_TIMEOUT_MS);
    if (probe.ok || (!probe.missingCommand && !probe.timedOut)) {
      resolvedExtractorCommand = command;
      resolveFailureReason = "";
      resolveFailureAt = 0;
      logger.info(`Entpacker erkannt: ${command}`);
      return command;
    }
  }

  resolveFailureReason = NO_EXTRACTOR_MESSAGE;
  resolveFailureAt = Date.now();
  throw new Error(resolveFailureReason);
}

async function resolveExtractorCommand(archivePath = ""): Promise<string> {
  if (resolvedExtractorCommand && cachedExtractorFitsArchive(resolvedExtractorCommand, archivePath)) {
    return resolvedExtractorCommand;
  }
  if (resolveExtractorCommandInFlight) {
    return resolveExtractorCommandInFlight;
  }

  const pending = resolveExtractorCommandInternal(archivePath);
  resolveExtractorCommandInFlight = pending;
  try {
    return await pending;
  } finally {
    if (resolveExtractorCommandInFlight === pending) {
      resolveExtractorCommandInFlight = null;
    }
  }
}

async function findAlternativeExtractor(currentCommand: string, archivePath = ""): Promise<string | null> {
  const candidates = nativeExtractorCandidates(archivePath);
  const currentKind = extractorCommandKind(currentCommand);
  const preferredKinds: ExtractorCommandKind[] = currentKind === "seven_zip"
    ? ["rar_native"]
    : isRarArchivePath(archivePath)
      ? ["rar_native", "seven_zip"]
      : ["seven_zip", "rar_native"];
  for (const kind of preferredKinds) {
    for (const candidate of candidates) {
      if (candidate === currentCommand) continue;
      if (extractorCommandKind(candidate) !== kind) continue;
      if (isAbsoluteCommand(candidate) && !fs.existsSync(candidate)) continue;
      const probe = await runExtractCommand(candidate, extractorProbeArgs(candidate), undefined, undefined, EXTRACTOR_PROBE_TIMEOUT_MS);
      if (probe.ok || (!probe.missingCommand && !probe.timedOut)) {
        return candidate;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 10 — CPU / Thread / Priority
// ════════════════════════════════════════════════════════════════════════════

/** Compute a safe JVM -Xmx value based on available physical RAM.
 *  Reserves 4 GB for Windows + Electron + other processes, caps at 16 GB. */
function jvmMaxHeapArg(): string {
  const totalGb = os.totalmem() / (1024 ** 3);
  const heapGb = Math.max(1, Math.min(Math.floor(totalGb - 4), 16));
  return `-Xmx${heapGb}g`;
}

function shouldUseExtractorPerformanceFlags(): boolean {
  const raw = String(process.env.RD_EXTRACT_PERF_FLAGS || "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function extractCpuBudgetFromPriority(priority?: string): number {
  switch (priority) {
    case "low": return 25;
    case "middle": return 50;
    default: return 80;
  }
}

function extractOsPriority(priority?: string): number {
  switch (priority) {
    case "high": return os.constants.priority.PRIORITY_NORMAL;
    default: return os.constants.priority.PRIORITY_BELOW_NORMAL;
  }
}

function extractCpuBudgetPercent(priority?: string): number {
  const envValue = Number(process.env.RD_EXTRACT_CPU_BUDGET_PERCENT ?? NaN);
  if (Number.isFinite(envValue) && envValue >= 40 && envValue <= 95) {
    return Math.floor(envValue);
  }
  return extractCpuBudgetFromPriority(priority);
}

function extractorThreadSwitch(hybridMode = false, priority?: string): string {
  if (hybridMode) {
    const envValue = Number(process.env.RD_EXTRACT_THREADS ?? NaN);
    if (Number.isFinite(envValue) && envValue >= 1 && envValue <= 32) {
      return `-mt${Math.floor(envValue)}`;
    }
    const cpuCount = Math.max(1, os.cpus().length || 1);
    const hybridThreads = Math.max(2, Math.min(12, Math.ceil(cpuCount * 0.75)));
    return `-mt${hybridThreads}`;
  }
  const envValue = Number(process.env.RD_EXTRACT_THREADS ?? NaN);
  if (Number.isFinite(envValue) && envValue >= 1 && envValue <= 32) {
    return `-mt${Math.floor(envValue)}`;
  }
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const budgetPercent = extractCpuBudgetPercent(priority);
  const budgetedThreads = Math.floor((cpuCount * budgetPercent) / 100);
  const threadCount = Math.max(1, Math.min(16, Math.max(1, budgetedThreads)));
  return `-mt${threadCount}`;
}

function lowerExtractProcessPriority(childPid: number | undefined, cpuPriority?: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const pid = Number(childPid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    os.setPriority(pid, extractOsPriority(cpuPriority));
  } catch {
    // ignore: priority lowering is best-effort
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 11 — Prozess-Ausführung (spawn, kill, progress parsing)
// ════════════════════════════════════════════════════════════════════════════

function killProcessTree(child: { pid?: number; kill: () => void }): void {
  const pid = Number(child.pid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    return;
  }

  try {
    child.kill();
  } catch {
    // ignore
  }
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

function nextArchivePercent(previous: number, incoming: number): number {
  const prev = Math.max(0, Math.min(100, Math.floor(Number(previous) || 0)));
  const next = Math.max(0, Math.min(100, Math.floor(Number(incoming) || 0)));
  return next >= prev ? next : prev;
}

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
    lowerExtractProcessPriority(child.pid, currentExtractCpuPriority);
    let timeoutId: NodeJS.Timeout | null = null;
    let timedOutByWatchdog = false;
    let abortedBySignal = false;

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
        timedOutByWatchdog = true;
        killProcessTree(child);
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
        abortedBySignal = true;
        killProcessTree(child);
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
      if (abortedBySignal) {
        finish({ ok: false, missingCommand: false, aborted: true, timedOut: false, errorText: "aborted:extract" });
        return;
      }
      if (timedOutByWatchdog) {
        finish({
          ok: false,
          missingCommand: false,
          aborted: false,
          timedOut: true,
          errorText: `Entpacken Timeout nach ${Math.ceil((timeoutMs || 0) / 1000)}s`
        });
        return;
      }
      if (code === 0) {
        finish({ ok: true, missingCommand: false, aborted: false, timedOut: false, errorText: "" });
        return;
      }
      if (code === 1) {
        const lowered = output.toLowerCase();
        const warningOnly = !lowered.includes("crc failed")
          && !lowered.includes("checksum error")
          && !lowered.includes("wrong password")
          && !lowered.includes("cannot open")
          && !lowered.includes("fatal error")
          && !lowered.includes("unexpected end of archive")
          && !lowered.includes("error:");
        if (warningOnly) {
          finish({ ok: true, missingCommand: false, aborted: false, timedOut: false, errorText: "" });
          return;
        }
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

// ════════════════════════════════════════════════════════════════════════════
// Sektion 12 — JVM Backend & Daemon
// ════════════════════════════════════════════════════════════════════════════

let cachedJvmLayout: JvmExtractorLayout | null | undefined;
let cachedJvmLayoutNullSince = 0;
const JVM_LAYOUT_NULL_TTL_MS = 5 * 60 * 1000;

function resolveJavaCommandCandidates(): string[] {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const candidates = [
    process.env.RD_JAVA_BIN || "",
    path.join(programFiles, "JDownloader", "jre", "bin", "java.exe"),
    path.join(programFilesX86, "JDownloader", "jre", "bin", "java.exe"),
    localAppData ? path.join(localAppData, "JDownloader", "jre", "bin", "java.exe") : "",
    "java"
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function resolveJvmExtractorRootCandidates(): string[] {
  const fromEnv = String(process.env.RD_EXTRACTOR_JVM_DIR || "").trim();
  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || "";
  const candidates = [
    fromEnv,
    electronResourcesPath ? path.join(electronResourcesPath, "app.asar.unpacked", "resources", "extractor-jvm") : "",
    path.join(process.cwd(), "resources", "extractor-jvm"),
    path.join(process.cwd(), "build", "resources", "extractor-jvm"),
    path.join(__dirname, "..", "..", "..", "resources", "extractor-jvm"),
    electronResourcesPath ? path.join(electronResourcesPath, "extractor-jvm") : ""
  ].filter(Boolean);
  return Array.from(new Set(candidates));
}

function resolveJvmExtractorLayout(): JvmExtractorLayout | null {
  if (cachedJvmLayout !== undefined) {
    if (cachedJvmLayout === null && Date.now() - cachedJvmLayoutNullSince > JVM_LAYOUT_NULL_TTL_MS) {
      cachedJvmLayout = undefined;
    } else {
      return cachedJvmLayout;
    }
  }
  const javaCandidates = resolveJavaCommandCandidates();
  const javaCommand = javaCandidates.find((candidate) => {
    if (!candidate) {
      return false;
    }
    if (!isAbsoluteCommand(candidate)) {
      return true;
    }
    return fs.existsSync(candidate);
  }) || "";

  if (!javaCommand) {
    cachedJvmLayout = null;
    cachedJvmLayoutNullSince = Date.now();
    return null;
  }

  for (const rootDir of resolveJvmExtractorRootCandidates()) {
    const classesDir = path.join(rootDir, JVM_EXTRACTOR_CLASSES_SUBDIR);
    if (!fs.existsSync(classesDir)) {
      continue;
    }
    const libs = JVM_EXTRACTOR_REQUIRED_LIBS.map((name) => path.join(rootDir, JVM_EXTRACTOR_LIB_SUBDIR, name));
    if (libs.some((filePath) => !fs.existsSync(filePath))) {
      continue;
    }
    const classPath = [classesDir, ...libs].join(path.delimiter);
    const layout = { javaCommand, classPath, rootDir };
    cachedJvmLayout = layout;
    return layout;
  }

  cachedJvmLayout = null;
  cachedJvmLayoutNullSince = Date.now();
  return null;
}

function parseJvmLine(
  line: string,
  onArchiveProgress: ((percent: number) => void) | undefined,
  state: { bestPercent: number; usedPassword: string; backend: string; reportedError: string }
): void {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return;
  }

  if (trimmed.startsWith("RD_PROGRESS ")) {
    const parsed = parseProgressPercent(trimmed);
    if (parsed !== null) {
      const next = nextArchivePercent(state.bestPercent, parsed);
      if (next !== state.bestPercent) {
        state.bestPercent = next;
        onArchiveProgress?.(next);
      }
    }
    return;
  }

  if (trimmed.startsWith("RD_PASSWORD ")) {
    const encoded = trimmed.slice("RD_PASSWORD ".length).trim();
    try {
      state.usedPassword = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      state.usedPassword = "";
    }
    return;
  }

  if (trimmed.startsWith("RD_BACKEND ")) {
    state.backend = trimmed.slice("RD_BACKEND ".length).trim();
    return;
  }

  if (trimmed.startsWith("RD_ERROR ")) {
    state.reportedError = trimmed.slice("RD_ERROR ".length).trim();
  }
}

// ── Persistent JVM Daemon ──
// Keeps a single JVM process alive across multiple extraction requests,
// eliminating the ~5s JVM boot overhead per archive.

let daemonProcess: ChildProcess | null = null;
let daemonReady = false;
let daemonBusy = false;
let daemonCurrentRequest: DaemonRequest | null = null;
let daemonStdoutBuffer = "";
let daemonStderrBuffer = "";
let daemonOutput = "";
let daemonTimeoutId: NodeJS.Timeout | null = null;
let daemonAbortHandler: (() => void) | null = null;
let daemonLayout: JvmExtractorLayout | null = null;

export function shutdownDaemon(): void {
  if (daemonProcess) {
    try { daemonProcess.stdin?.end(); } catch { /* ignore */ }
    try { killProcessTree(daemonProcess); } catch { /* ignore */ }
    daemonProcess = null;
  }
  daemonReady = false;
  daemonBusy = false;
  daemonCurrentRequest = null;
  daemonStdoutBuffer = "";
  daemonStderrBuffer = "";
  daemonOutput = "";
  if (daemonTimeoutId) { clearTimeout(daemonTimeoutId); daemonTimeoutId = null; }
  if (daemonAbortHandler) { daemonAbortHandler = null; }
  daemonLayout = null;
}

function finishDaemonRequest(result: JvmExtractResult): void {
  const req = daemonCurrentRequest;
  if (!req) return;
  daemonCurrentRequest = null;
  daemonBusy = false;
  daemonStdoutBuffer = "";
  daemonStderrBuffer = "";
  daemonOutput = "";
  if (daemonTimeoutId) { clearTimeout(daemonTimeoutId); daemonTimeoutId = null; }
  if (req.signal && daemonAbortHandler) {
    req.signal.removeEventListener("abort", daemonAbortHandler);
    daemonAbortHandler = null;
  }
  req.resolve(result);
}

function flushDaemonParseBuffers(req: DaemonRequest | null): void {
  if (!req) {
    return;
  }
  if (daemonStdoutBuffer.trim()) {
    parseJvmLine(daemonStdoutBuffer, req.onArchiveProgress, req.parseState);
    daemonStdoutBuffer = "";
  }
  if (daemonStderrBuffer.trim()) {
    parseJvmLine(daemonStderrBuffer, req.onArchiveProgress, req.parseState);
    daemonStderrBuffer = "";
  }
}

function handleDaemonLine(line: string): void {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;

  if (trimmed === "RD_DAEMON_READY") {
    daemonReady = true;
    logger.info("JVM Daemon bereit (persistent)");
    return;
  }

  if (trimmed.startsWith("RD_REQUEST_DONE ")) {
    const code = parseInt(trimmed.slice("RD_REQUEST_DONE ".length).trim(), 10);
    const req = daemonCurrentRequest;
    if (!req) return;
    const finalize = (): void => {
      if (daemonCurrentRequest !== req) {
        return;
      }
      flushDaemonParseBuffers(req);
      const elapsedMs = Date.now() - req.startedAt;
      logger.info(
        `JVM Daemon Request Ende: archive=${req.archiveName}, code=${code}, ms=${elapsedMs}, pwCandidates=${req.passwordCount}, ` +
        `bestPercent=${req.parseState.bestPercent}, backend=${req.parseState.backend || "unknown"}, usedPassword=${req.parseState.usedPassword ? "yes" : "no"}`
      );

      if (code === 0) {
        req.onArchiveProgress?.(100);
        finishDaemonRequest({
          ok: true, missingCommand: false, missingRuntime: false,
          aborted: false, timedOut: false, errorText: "",
          usedPassword: req.parseState.usedPassword, backend: req.parseState.backend
        });
        return;
      }

      const message = cleanErrorText(req.parseState.reportedError || daemonOutput) || `Exit Code ${code}`;
      finishDaemonRequest({
        ok: false, missingCommand: false, missingRuntime: isJvmRuntimeMissingError(message),
        aborted: false, timedOut: false, errorText: message,
        usedPassword: req.parseState.usedPassword, backend: req.parseState.backend
      });
    };

    if (code !== 0 && !req.parseState.reportedError) {
      setTimeout(finalize, 40);
      return;
    }

    finalize();
    return;
  }

  if (daemonCurrentRequest) {
    parseJvmLine(trimmed, daemonCurrentRequest.onArchiveProgress, daemonCurrentRequest.parseState);
  }
}

function startDaemon(layout: JvmExtractorLayout): boolean {
  if (daemonProcess && daemonReady) return true;
  if (daemonProcess) return false;
  shutdownDaemon();

  const jvmTmpDir = path.join(os.tmpdir(), `rd-extract-daemon-${crypto.randomUUID()}`);
  fs.mkdirSync(jvmTmpDir, { recursive: true });

  const args = [
    "-Dfile.encoding=UTF-8",
    `-Djava.io.tmpdir=${jvmTmpDir}`,
    "-Xms1g",
    jvmMaxHeapArg(),
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=50",
    "-cp",
    layout.classPath,
    JVM_EXTRACTOR_MAIN_CLASS,
    "--daemon"
  ];

  try {
    const child = spawn(layout.javaCommand, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    lowerExtractProcessPriority(child.pid, currentExtractCpuPriority);
    daemonProcess = child;
    daemonLayout = layout;

    child.stdout!.on("data", (chunk) => {
      const raw = String(chunk || "");
      daemonOutput = appendLimited(daemonOutput, raw);
      daemonStdoutBuffer += raw;
      const lines = daemonStdoutBuffer.split(/\r?\n/);
      daemonStdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        handleDaemonLine(line);
      }
    });

    child.stderr!.on("data", (chunk) => {
      const raw = String(chunk || "");
      daemonOutput = appendLimited(daemonOutput, raw);
      daemonStderrBuffer += raw;
      const lines = daemonStderrBuffer.split(/\r?\n/);
      daemonStderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (daemonCurrentRequest) {
          parseJvmLine(line, daemonCurrentRequest.onArchiveProgress, daemonCurrentRequest.parseState);
        }
      }
    });

    child.on("error", () => {
      if (daemonCurrentRequest) {
        finishDaemonRequest({
          ok: false, missingCommand: true, missingRuntime: true,
          aborted: false, timedOut: false, errorText: "Daemon process error",
          usedPassword: "", backend: ""
        });
      }
      shutdownDaemon();
    });

    child.on("close", () => {
      if (daemonCurrentRequest) {
        const req = daemonCurrentRequest;
        finishDaemonRequest({
          ok: false, missingCommand: false, missingRuntime: false,
          aborted: false, timedOut: false,
          errorText: cleanErrorText(req.parseState.reportedError || daemonOutput) || "Daemon process exited unexpectedly",
          usedPassword: req.parseState.usedPassword, backend: req.parseState.backend
        });
      }
      // Clean up tmp dir
      fs.rm(jvmTmpDir, { recursive: true, force: true }, () => {});
      daemonProcess = null;
      daemonReady = false;
      daemonBusy = false;
      daemonLayout = null;
    });

    logger.info(`JVM Daemon gestartet (PID ${child.pid})`);
    return true;
  } catch (error) {
    logger.warn(`JVM Daemon Start fehlgeschlagen: ${String(error)}`);
    return false;
  }
}

function isDaemonAvailable(layout: JvmExtractorLayout): boolean {
  if (!daemonProcess || !daemonReady) {
    startDaemon(layout);
  }
  return Boolean(daemonProcess && daemonReady && !daemonBusy);
}

/** Wait for the daemon to become ready (boot phase) or free (busy phase), with timeout. */
function waitForDaemonReady(maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (signal?.aborted) { resolve(false); return; }
      if (daemonProcess && daemonReady && !daemonBusy) { resolve(true); return; }
      if (!daemonProcess) { resolve(false); return; }
      if (Date.now() - start >= maxWaitMs) { resolve(false); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

function sendDaemonRequest(
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[],
  onArchiveProgress?: (percent: number) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<JvmExtractResult> {
  return new Promise((resolve) => {
    const mode = effectiveConflictMode(conflictMode);
    const parseState = { bestPercent: 0, usedPassword: "", backend: "", reportedError: "" };
    const archiveName = path.basename(archivePath);

    daemonBusy = true;
    daemonOutput = "";
    daemonCurrentRequest = {
      resolve,
      onArchiveProgress,
      signal,
      timeoutMs,
      parseState,
      archiveName,
      startedAt: Date.now(),
      passwordCount: passwordCandidates.length
    };
    logger.info(`JVM Daemon Request Start: archive=${archiveName}, pwCandidates=${passwordCandidates.length}, timeoutMs=${timeoutMs || 0}, conflict=${mode}`);

    if (timeoutMs && timeoutMs > 0) {
      daemonTimeoutId = setTimeout(() => {
        const req = daemonCurrentRequest;
        if (req) {
          finishDaemonRequest({
            ok: false, missingCommand: false, missingRuntime: false,
            aborted: false, timedOut: true,
            errorText: `Entpacken Timeout nach ${Math.ceil(timeoutMs / 1000)}s`,
            usedPassword: parseState.usedPassword, backend: parseState.backend
          });
        }
        shutdownDaemon();
      }, timeoutMs);
    }

    if (signal) {
      daemonAbortHandler = () => {
        const req = daemonCurrentRequest;
        if (req) {
          finishDaemonRequest({
            ok: false, missingCommand: false, missingRuntime: false,
            aborted: true, timedOut: false, errorText: "aborted:extract",
            usedPassword: parseState.usedPassword, backend: parseState.backend
          });
        }
        shutdownDaemon();
      };
      signal.addEventListener("abort", daemonAbortHandler, { once: true });
    }

    const jsonRequest = JSON.stringify({
      archive: archivePath,
      target: targetDir,
      conflict: mode,
      backend: "auto",
      passwords: passwordCandidates
    });

    try {
      daemonProcess!.stdin!.write(jsonRequest + "\n");
    } catch (error) {
      finishDaemonRequest({
        ok: false, missingCommand: false, missingRuntime: false,
        aborted: false, timedOut: false,
        errorText: `Daemon stdin write failed: ${String(error)}`,
        usedPassword: "", backend: ""
      });
      shutdownDaemon();
    }
  });
}

async function runJvmExtractCommand(
  layout: JvmExtractorLayout,
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[],
  onArchiveProgress?: (percent: number) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<JvmExtractResult> {
  if (signal?.aborted) {
    return Promise.resolve({
      ok: false, missingCommand: false, missingRuntime: false,
      aborted: true, timedOut: false, errorText: "aborted:extract",
      usedPassword: "", backend: ""
    });
  }

  // Try persistent daemon first — saves ~5s JVM boot per archive
  if (isDaemonAvailable(layout)) {
    lowerExtractProcessPriority(daemonProcess?.pid, currentExtractCpuPriority);
    logger.info(`JVM Daemon: Sofort verfügbar, sende Request für ${path.basename(archivePath)} (pwCandidates=${passwordCandidates.length})`);
    return sendDaemonRequest(archivePath, targetDir, conflictMode, passwordCandidates, onArchiveProgress, signal, timeoutMs);
  }

  // Daemon exists but is still booting or busy — wait up to 15s for it
  if (daemonProcess) {
    const reason = !daemonReady ? "booting" : "busy";
    const waitStartedAt = Date.now();
    logger.info(`JVM Daemon: Warte auf ${reason} Daemon für ${path.basename(archivePath)}...`);
    const ready = await waitForDaemonReady(15_000, signal);
    const waitedMs = Date.now() - waitStartedAt;
    if (ready) {
      lowerExtractProcessPriority(daemonProcess?.pid, currentExtractCpuPriority);
      logger.info(`JVM Daemon: Bereit nach ${waitedMs}ms — sende Request für ${path.basename(archivePath)}`);
      return sendDaemonRequest(archivePath, targetDir, conflictMode, passwordCandidates, onArchiveProgress, signal, timeoutMs);
    }
    logger.warn(`JVM Daemon: Timeout nach ${waitedMs}ms beim Warten — Fallback auf neuen Prozess für ${path.basename(archivePath)}`);
  }

  // Fallback: spawn a new JVM process (daemon not available after waiting)
  logger.info(`JVM Spawn: Neuer Prozess für ${path.basename(archivePath)}`);

  const mode = effectiveConflictMode(conflictMode);
  const jvmTmpDir = path.join(os.tmpdir(), `rd-extract-${crypto.randomUUID()}`);
  fs.mkdirSync(jvmTmpDir, { recursive: true });
  const args = [
    "-Dfile.encoding=UTF-8",
    `-Djava.io.tmpdir=${jvmTmpDir}`,
    "-Xms1g",
    jvmMaxHeapArg(),
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=50",
    "-cp",
    layout.classPath,
    JVM_EXTRACTOR_MAIN_CLASS,
    "--archive",
    archivePath,
    "--target",
    targetDir,
    "--conflict",
    mode,
    "--backend",
    "auto"
  ];
  for (const password of passwordCandidates) {
    args.push("--password", password);
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timeoutId: NodeJS.Timeout | null = null;
    let timedOutByWatchdog = false;
    let abortedBySignal = false;
    let onAbort: (() => void) | null = null;
    const parseState = { bestPercent: 0, usedPassword: "", backend: "", reportedError: "" };
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const child = spawn(layout.javaCommand, args, { windowsHide: true });
    lowerExtractProcessPriority(child.pid, currentExtractCpuPriority);

    const flushLines = (rawChunk: string, fromStdErr = false): void => {
      if (!rawChunk) {
        return;
      }
      output = appendLimited(output, rawChunk);
      const nextBuffer = `${fromStdErr ? stderrBuffer : stdoutBuffer}${rawChunk}`;
      const lines = nextBuffer.split(/\r?\n/);
      const keep = lines.pop() || "";
      for (const line of lines) {
        parseJvmLine(line, onArchiveProgress, parseState);
      }
      if (fromStdErr) {
        stderrBuffer = keep;
      } else {
        stdoutBuffer = keep;
      }
    };

    const cleanupTmpDir = (): void => {
      fs.rm(jvmTmpDir, { recursive: true, force: true }, () => {});
    };

    const finish = (result: JvmExtractResult): void => {
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
      cleanupTmpDir();
      resolve(result);
    };

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOutByWatchdog = true;
        killProcessTree(child);
        finish({
          ok: false, missingCommand: false, missingRuntime: false,
          aborted: false, timedOut: true,
          errorText: `Entpacken Timeout nach ${Math.ceil(timeoutMs / 1000)}s`,
          usedPassword: parseState.usedPassword, backend: parseState.backend
        });
      }, timeoutMs);
    }

    onAbort = signal
      ? (): void => {
        abortedBySignal = true;
        killProcessTree(child);
        finish({
          ok: false, missingCommand: false, missingRuntime: false,
          aborted: true, timedOut: false, errorText: "aborted:extract",
          usedPassword: parseState.usedPassword, backend: parseState.backend
        });
      }
      : null;

    if (signal && onAbort) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      flushLines(String(chunk || ""), false);
    });
    child.stderr.on("data", (chunk) => {
      flushLines(String(chunk || ""), true);
    });

    child.on("error", (error) => {
      const text = cleanErrorText(String(error));
      finish({
        ok: false, missingCommand: text.toLowerCase().includes("enoent"),
        missingRuntime: true, aborted: false, timedOut: false,
        errorText: text, usedPassword: parseState.usedPassword, backend: parseState.backend
      });
    });

    child.on("close", (code) => {
      parseJvmLine(stdoutBuffer, onArchiveProgress, parseState);
      parseJvmLine(stderrBuffer, onArchiveProgress, parseState);

      if (abortedBySignal) {
        finish({
          ok: false, missingCommand: false, missingRuntime: false,
          aborted: true, timedOut: false, errorText: "aborted:extract",
          usedPassword: parseState.usedPassword, backend: parseState.backend
        });
        return;
      }
      if (timedOutByWatchdog) {
        finish({
          ok: false, missingCommand: false, missingRuntime: false,
          aborted: false, timedOut: true,
          errorText: `Entpacken Timeout nach ${Math.ceil((timeoutMs || 0) / 1000)}s`,
          usedPassword: parseState.usedPassword, backend: parseState.backend
        });
        return;
      }

      const message = cleanErrorText(parseState.reportedError || output) || `Exit Code ${String(code ?? "?")}`;
      if (code === 0) {
        onArchiveProgress?.(100);
        finish({
          ok: true, missingCommand: false, missingRuntime: false,
          aborted: false, timedOut: false, errorText: "",
          usedPassword: parseState.usedPassword, backend: parseState.backend
        });
        return;
      }

      finish({
        ok: false, missingCommand: false,
        missingRuntime: isJvmRuntimeMissingError(message),
        aborted: false, timedOut: false, errorText: message,
        usedPassword: parseState.usedPassword, backend: parseState.backend
      });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Sektion 13 — Legacy Extraction (buildExternalExtractArgs, runExternalExtract*)
// ════════════════════════════════════════════════════════════════════════════

export function buildExternalExtractArgs(
  command: string,
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  password = "",
  usePerformanceFlags = true,
  hybridMode = false,
  flatMode = false
): string[] {
  const mode = effectiveConflictMode(conflictMode);
  if (isRarNativeCommand(command)) {
    const extractCmd = flatMode ? "e" : "x";
    const overwrite = mode === "overwrite" ? "-o+" : mode === "rename" ? "-or" : "-o-";
    const pass = password ? `-p${password}` : "-p-";
    const perfArgs = usePerformanceFlags && shouldUseExtractorPerformanceFlags()
      ? ["-idc", extractorThreadSwitch(hybridMode, currentExtractCpuPriority)]
      : [];
    return [extractCmd, overwrite, pass, "-y", ...perfArgs, archivePath, `${targetDir}${path.sep}`];
  }

  const overwrite = mode === "overwrite" ? "-aoa" : mode === "rename" ? "-aou" : "-aos";
  const pass = password ? `-p${password}` : "-p";
  return ["x", "-y", overwrite, pass, archivePath, `-o${targetDir}`];
}

// Delay helper for extraction retries
const extractRetryDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runExternalExtractInner(
  command: string,
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[],
  onArchiveProgress: ((percent: number) => void) | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  hybridMode = false,
  onPasswordAttempt?: (attempt: number, total: number) => void,
  forceFlatMode = false,
  flatModeResult?: { needed: boolean },
  onLog?: ExtractOptions["onLog"]
): Promise<string> {
  const passwords = passwordCandidates;
  let lastError = "";
  const extractorName = path.basename(command).replace(/\.exe$/i, "") || command;

  const emptyPasswordCount = passwords.filter((candidate) => candidate === "").length;
  onLog?.("INFO", `Legacy-Extractor Start: archive=${path.basename(archivePath)}, extractor=${extractorName}, passwordCount=${passwords.length}, forceFlatMode=${forceFlatMode}, targetDir=${targetDir}`);
  logger.info(`Legacy-Extractor (${extractorName}): ${path.basename(archivePath)}, passwordCount=${passwords.length}, redacted=true, emptyCandidates=${emptyPasswordCount}${forceFlatMode ? " (flat-mode cached)" : ""}`);

  let announcedStart = false;
  let bestPercent = 0;
  let passwordAttempt = 0;
  let usePerformanceFlags = externalExtractorSupportsPerfFlags && shouldUseExtractorPerformanceFlags();
  const summarizeResultError = (errorText: string): string => cleanErrorText(errorText);
  let createErrorText = "";
  let createErrorPassword = "";

  // Skip normal extraction loop if flat mode is already known to be needed for this package
  if (forceFlatMode) {
    logger.info(`Flat-Modus direkt (gespeichert vom vorherigen Archiv): ${path.basename(archivePath)}`);
    onLog?.("INFO", `Flat-Modus direkt (gespeichert vom vorherigen Archiv): ${path.basename(archivePath)}`);
    for (const password of passwords) {
      if (signal?.aborted) throw new Error("aborted:extract");
      passwordAttempt += 1;
      onLog?.("INFO", `Flach-Extraktion Versuch ${passwordAttempt}/${passwords.length}: archive=${path.basename(archivePath)}, password=<redacted>`);
      logger.info(`Flach-Extraktion Versuch ${passwordAttempt}/${passwords.length} für ${path.basename(archivePath)} (password=<redacted>)`);
      const args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, usePerformanceFlags, hybridMode, true);
      const result = await runExtractCommand(command, args, (chunk) => {
        const parsed = parseProgressPercent(chunk);
        if (parsed === null) return;
        const next = nextArchivePercent(bestPercent, parsed);
        if (next !== bestPercent) { bestPercent = next; onArchiveProgress?.(bestPercent); }
      }, signal, timeoutMs);
      logger.info(`Flach-Extraktion Versuch ${passwordAttempt}/${passwords.length}: ok=${result.ok}, bestPercent=${bestPercent}`);
      onLog?.("INFO", `Flach-Extraktion Ergebnis ${passwordAttempt}/${passwords.length}: archive=${path.basename(archivePath)}, ok=${result.ok}, timedOut=${result.timedOut}, missingCommand=${result.missingCommand}, bestPercent=${bestPercent}`);
      if (result.ok) { if (flatModeResult) flatModeResult.needed = true; onArchiveProgress?.(100); return password; }
      if (result.aborted) throw new Error("aborted:extract");
      if (result.timedOut || result.missingCommand) break;
      lastError = result.errorText;
    }
    throw withExtractionErrorHints(new Error(lastError || "Entpacken fehlgeschlagen (flat-mode)"), { legacyBestPercent: bestPercent, legacyExtractor: extractorName });
  }

  for (const password of passwords) {
    if (signal?.aborted) {
      throw new Error("aborted:extract");
    }
    if (!announcedStart) {
      announcedStart = true;
      onArchiveProgress?.(0);
    }
    passwordAttempt += 1;
    const attemptStartedAt = Date.now();
    onLog?.("INFO", `Legacy-Passwort-Versuch ${passwordAttempt}/${passwords.length}: archive=${path.basename(archivePath)}, password=<redacted>`);
    logger.info(`Legacy-Passwort-Versuch ${passwordAttempt}/${passwords.length} für ${path.basename(archivePath)} (password=<redacted>)`);
    if (passwords.length > 1) {
      onPasswordAttempt?.(passwordAttempt, passwords.length);
    }
    let args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, usePerformanceFlags, hybridMode);
    let result = await runExtractCommand(command, args, (chunk) => {
      const parsed = parseProgressPercent(chunk);
      if (parsed === null) {
        return;
      }
      const next = nextArchivePercent(bestPercent, parsed);
      if (next !== bestPercent) {
        bestPercent = next;
        onArchiveProgress?.(bestPercent);
      }
    }, signal, timeoutMs);

    if (!result.ok && usePerformanceFlags && isUnsupportedExtractorSwitchError(result.errorText)) {
      usePerformanceFlags = false;
      externalExtractorSupportsPerfFlags = false;
      onLog?.("WARN", `Entpacker ohne Performance-Flags fortgesetzt: ${path.basename(archivePath)}`);
      logger.warn(`Entpacker ohne Performance-Flags fortgesetzt: ${path.basename(archivePath)}`);
      args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, false, hybridMode);
      result = await runExtractCommand(command, args, (chunk) => {
        const parsed = parseProgressPercent(chunk);
        if (parsed === null) {
          return;
        }
        const next = nextArchivePercent(bestPercent, parsed);
        if (next !== bestPercent) {
          bestPercent = next;
          onArchiveProgress?.(bestPercent);
        }
      }, signal, timeoutMs);
    }

      logger.info(
        `Legacy-Passwort-Versuch Ergebnis: archive=${path.basename(archivePath)}, attempt=${passwordAttempt}/${passwords.length}, ` +
        `ms=${Date.now() - attemptStartedAt}, ok=${result.ok}, timedOut=${result.timedOut}, missingCommand=${result.missingCommand}, bestPercent=${bestPercent}`
      );
      onLog?.("INFO", `Legacy-Passwort-Versuch Ergebnis: archive=${path.basename(archivePath)}, attempt=${passwordAttempt}/${passwords.length}, ms=${Date.now() - attemptStartedAt}, ok=${result.ok}, timedOut=${result.timedOut}, missingCommand=${result.missingCommand}, bestPercent=${bestPercent}`);
      if (!result.ok) {
        const errorSummary = summarizeResultError(result.errorText);
        if (errorSummary) {
          logger.info(`Legacy-Passwort-Versuch Fehlertext: archive=${path.basename(archivePath)}, attempt=${passwordAttempt}/${passwords.length}, extractor=${extractorName}, error=${errorSummary}`);
          onLog?.("INFO", `Legacy-Passwort-Versuch Fehlertext: archive=${path.basename(archivePath)}, attempt=${passwordAttempt}/${passwords.length}, extractor=${extractorName}, error=${errorSummary}`);
        }
      }

    if (result.ok) {
      onArchiveProgress?.(100);
      return password;
    }

    if (!createErrorText && result.errorText.includes("Cannot create")) {
      createErrorText = result.errorText;
      createErrorPassword = password;
      logger.warn(`Entpack-Pfadfehler gemerkt: archive=${path.basename(archivePath)}, attempt=${passwordAttempt}/${passwords.length}, extractor=${extractorName}, password=<redacted>`);
      onLog?.("WARN", `Entpack-Pfadfehler gemerkt: archive=${path.basename(archivePath)}, attempt=${passwordAttempt}/${passwords.length}, extractor=${extractorName}, password=<redacted>`);
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
      resolveFailureAt = Date.now();
      throw withExtractionErrorHints(new Error(NO_EXTRACTOR_MESSAGE), { legacyBestPercent: bestPercent, legacyExtractor: extractorName });
    }

    lastError = result.errorText;
  }

  // Some archives store internal paths with a leading \, causing invalid \\ paths.
  // Retry in flat mode ("e" instead of "x") which strips all archive paths.
  const pathCreateError = createErrorText || (lastError.includes("Cannot create") ? lastError : "");
  if (pathCreateError) {
    const flatPasswords = createErrorPassword
      ? prioritizePassword(passwords, createErrorPassword)
      : passwords;
    logger.warn(`Entpack-Pfadfehler: Wiederholung mit flachem Modus: ${path.basename(archivePath)}`);
    onLog?.("WARN", `Entpack-Pfadfehler: Wiederholung mit flachem Modus: ${path.basename(archivePath)}`);
    bestPercent = 0;
    passwordAttempt = 0;
    lastError = pathCreateError;
    for (const password of flatPasswords) {
      if (signal?.aborted) throw new Error("aborted:extract");
      passwordAttempt += 1;
      logger.info(`Flach-Extraktion Versuch ${passwordAttempt}/${passwords.length} für ${path.basename(archivePath)} (password=<redacted>)`);
      onLog?.("INFO", `Flach-Extraktion Versuch ${passwordAttempt}/${flatPasswords.length}: archive=${path.basename(archivePath)}, password=<redacted>`);
      const args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, usePerformanceFlags, hybridMode, true);
      const result = await runExtractCommand(command, args, (chunk) => {
        const parsed = parseProgressPercent(chunk);
        if (parsed === null) return;
        const next = nextArchivePercent(bestPercent, parsed);
        if (next !== bestPercent) { bestPercent = next; onArchiveProgress?.(bestPercent); }
      }, signal, timeoutMs);
      logger.info(`Flach-Extraktion Versuch ${passwordAttempt}/${passwords.length}: ok=${result.ok}, bestPercent=${bestPercent}`);
      onLog?.("INFO", `Flach-Extraktion Ergebnis ${passwordAttempt}/${flatPasswords.length}: archive=${path.basename(archivePath)}, ok=${result.ok}, timedOut=${result.timedOut}, missingCommand=${result.missingCommand}, bestPercent=${bestPercent}`);
      if (result.ok) { if (flatModeResult) flatModeResult.needed = true; onArchiveProgress?.(100); return password; }
      if (result.aborted) throw new Error("aborted:extract");
      if (result.timedOut || result.missingCommand) break;
      lastError = result.errorText;
    }
  }

  throw withExtractionErrorHints(new Error(lastError || "Entpacken fehlgeschlagen"), { legacyBestPercent: bestPercent, legacyExtractor: extractorName });
}

async function runExternalExtract(
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[],
  onArchiveProgress?: (percent: number) => void,
  signal?: AbortSignal,
  hybridMode = false,
  onPasswordAttempt?: (attempt: number, total: number) => void,
  forceFlatMode = false,
  flatModeResult?: { needed: boolean },
  onLog?: ExtractOptions["onLog"]
): Promise<string> {
  const timeoutMs = await computeExtractTimeoutMs(archivePath);
  const configuredBackendMode = extractorBackendMode();
  const backendMode = extractorBackendModeForArchive(archivePath);
  const archiveName = path.basename(archivePath);
  const totalStartedAt = Date.now();
  let jvmFailureReason = "";
  let jvmCodecError = false;
  let fallbackFromJvm = false;
  logger.info(`Extract-Backend Start: archive=${archiveName}, mode=${backendMode}, configuredMode=${configuredBackendMode}, pwCandidates=${passwordCandidates.length}, timeoutMs=${timeoutMs}, hybrid=${hybridMode}`);
  onLog?.("INFO", `Extract-Backend Start: archive=${archiveName}, mode=${backendMode}, configuredMode=${configuredBackendMode}, pwCandidates=${passwordCandidates.length}, timeoutMs=${timeoutMs}, hybrid=${hybridMode}`);

  await fs.promises.mkdir(targetDir, { recursive: true });

  let subst: SubstMapping | null = null;

  try {
    if (backendMode !== "legacy") {
      const layout = resolveJvmExtractorLayout();
      if (!layout) {
        jvmFailureReason = NO_JVM_EXTRACTOR_MESSAGE;
        if (backendMode === "jvm") {
          throw new Error(NO_JVM_EXTRACTOR_MESSAGE);
        }
        logger.warn(`JVM-Extractor nicht verfügbar, nutze Legacy-Extractor: ${path.basename(archivePath)}`);
      } else {
        const emptyCount = passwordCandidates.filter((candidate) => candidate === "").length;
        logger.info(`JVM-Extractor aktiv (${layout.rootDir}): ${archiveName}, passwordCount=${passwordCandidates.length}, redacted=true, emptyCandidates=${emptyCount}`);
        const jvmStartedAt = Date.now();
        onLog?.("INFO", `JVM-Extractor vorbereitet: archive=${archiveName}, passwordCandidates=${passwordCandidates.length}, layout=${layout.rootDir}`);
        const jvmResult = await runJvmExtractCommand(
          layout, archivePath, targetDir, conflictMode, passwordCandidates,
          onArchiveProgress, signal, timeoutMs
        );
        const jvmMs = Date.now() - jvmStartedAt;
        onLog?.("INFO", `JVM-Extractor Ergebnis: archive=${archiveName}, ok=${jvmResult.ok}, ms=${jvmMs}, timedOut=${jvmResult.timedOut}, aborted=${jvmResult.aborted}, backend=${jvmResult.backend || "unknown"}, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);
        logger.info(`JVM-Extractor Ergebnis: archive=${archiveName}, ok=${jvmResult.ok}, ms=${jvmMs}, timedOut=${jvmResult.timedOut}, aborted=${jvmResult.aborted}, backend=${jvmResult.backend || "unknown"}, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);

        if (jvmResult.ok) {
          logger.info(`Entpackt via ${jvmResult.backend || "jvm"}: ${archiveName}`);
          logger.info(`Extract-Backend Ende: archive=${archiveName}, backend=${jvmResult.backend || "jvm"}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, fallbackFromJvm=false, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);
          return jvmResult.usedPassword;
        }
        if (jvmResult.aborted) {
          throw new Error("aborted:extract");
        }
        if (jvmResult.timedOut) {
          throw new Error(jvmResult.errorText || `Entpacken Timeout nach ${Math.ceil(timeoutMs / 1000)}s`);
        }

        jvmFailureReason = jvmResult.errorText || "JVM-Extractor fehlgeschlagen";
        fallbackFromJvm = true;
        const jvmFailureLower = jvmFailureReason.toLowerCase();
        const isUnsupportedMethod = jvmFailureReason.includes("UNSUPPORTEDMETHOD");
        const isCodecError = jvmFailureLower.includes("registered codecs")
          || jvmFailureLower.includes("can not open")
          || jvmFailureLower.includes("cannot open archive");
        jvmCodecError = isCodecError;
        const isWrongPassword = jvmFailureReason.includes("WRONG_PASSWORD")
          || jvmFailureLower.includes("wrong password");
        const shouldFallbackToLegacy = isUnsupportedMethod || isCodecError || isWrongPassword;
        onLog?.("WARN", `JVM-Extractor Fallback-Analyse: archive=${archiveName}, unsupportedMethod=${isUnsupportedMethod}, codecError=${isCodecError}, wrongPassword=${isWrongPassword}, backendMode=${backendMode}`);
        if (backendMode === "jvm" && !shouldFallbackToLegacy) {
          throw new Error(jvmFailureReason);
        }
        if (isUnsupportedMethod) {
          logger.warn(`JVM-Extractor: Komprimierungsmethode nicht unterstützt, fallback auf Legacy: ${path.basename(archivePath)}`);
        } else if (isCodecError) {
          logger.warn(`JVM-Extractor: Archiv-Format nicht erkannt, fallback auf Legacy: ${path.basename(archivePath)}`);
        } else if (isWrongPassword) {
          logger.warn(`JVM-Extractor: Kein Passwort hat funktioniert, fallback auf Legacy: ${path.basename(archivePath)}`);
        } else {
          logger.warn(`JVM-Extractor Fehler, fallback auf Legacy: ${jvmFailureReason}`);
        }
      }
    }

    // Use a short drive mapping for legacy native extractors on Windows.
    subst = createSubstMapping(targetDir);
    const effectiveTargetDir = subst ? `${subst.drive}:\\` : targetDir;
    if (subst) {
      onLog?.("INFO", `Legacy-Zielpfad verkuerzt via subst: archive=${archiveName}, originalTargetDir=${targetDir}, effectiveTargetDir=${effectiveTargetDir}`);
    } else {
      onLog?.("INFO", `Legacy-Zielpfad unveraendert: archive=${archiveName}, effectiveTargetDir=${effectiveTargetDir}`);
    }

    const command = await resolveExtractorCommand(archivePath);
    const legacyStartedAt = Date.now();
    let password: string;
    let usedCommand = command;
    try {
      try {
        password = await runExternalExtractInner(
          command, archivePath, effectiveTargetDir, conflictMode, passwordCandidates,
          onArchiveProgress, signal, timeoutMs, hybridMode, onPasswordAttempt,
          forceFlatMode, flatModeResult, onLog
        );
      } catch (primaryError) {
        const isRar = /\.rar$/i.test(archiveName) || /\.r\d{2,3}$/i.test(archiveName);
        const errText = String((primaryError as Error)?.message || primaryError || "");
        const isPasswordOrCorrupt = /wrong.password|checksum error|corrupt/i.test(errText);
        if (isRar && isPasswordOrCorrupt && !signal?.aborted) {
          const alt = await findAlternativeExtractor(command, archivePath);
          if (alt) {
            const altName = path.basename(alt).replace(/\.exe$/i, "");
            onLog?.("INFO", `Legacy-Fallback: primary=${path.basename(command)}, alternative=${altName}, archive=${archiveName}`);
            logger.info(`Legacy-Fallback: ${path.basename(command)} fehlgeschlagen bei RAR, versuche ${altName}: ${archiveName}`);
            usedCommand = alt;
            password = await runExternalExtractInner(
              alt, archivePath, effectiveTargetDir, conflictMode, passwordCandidates,
              onArchiveProgress, signal, timeoutMs, hybridMode, onPasswordAttempt,
              forceFlatMode, flatModeResult, onLog
            );
          } else {
            throw primaryError;
          }
        } else {
          throw primaryError;
        }
      }
    } catch (legacyError) {
      const initialLegacyText = String((legacyError as Error)?.message || legacyError || "");
      const initialLegacyCategory = classifyExtractionError(initialLegacyText);
      const initialLegacyHints = legacyError as ExtractionErrorWithHints;
      const initialLegacyBestPercent = Number.isFinite(initialLegacyHints.legacyBestPercent)
        ? Number(initialLegacyHints.legacyBestPercent || 0)
        : 0;
      const isCrcOrWrongPw = initialLegacyCategory === "crc_error" || initialLegacyCategory === "wrong_password";
      let finalLegacyError: Error;

      // Retry once after a short delay to let Windows flush freshly completed archive parts.
      if (isCrcOrWrongPw && !signal?.aborted) {
        const retryDelayMs = 2500;
        logger.warn(
          `Legacy-Extraktion fehlgeschlagen (${initialLegacyCategory}), Retry nach ${retryDelayMs}ms Delay: ${archiveName}`
        );
        onLog?.("WARN", `Legacy-Extraktion fehlgeschlagen (${initialLegacyCategory}), Retry nach ${retryDelayMs}ms Delay: ${archiveName}`);
        await extractRetryDelay(retryDelayMs);
        if (!signal?.aborted) {
          try {
            const retryCmd = usedCommand;
            const retryPassword = await runExternalExtractInner(
              retryCmd,
              archivePath,
              effectiveTargetDir,
              conflictMode,
              passwordCandidates,
              onArchiveProgress,
              signal,
              timeoutMs,
              hybridMode,
              onPasswordAttempt,
              forceFlatMode,
              flatModeResult,
              onLog
            );
            logger.info(`Legacy-Retry erfolgreich: ${archiveName}`);
            onLog?.("INFO", `Legacy-Retry erfolgreich: ${archiveName}`);
            password = retryPassword;
            usedCommand = retryCmd;
            const retryExtractorName = path.basename(retryCmd).replace(/\.exe$/i, "");
            const retryLegacyMs = Date.now() - legacyStartedAt;
            if (jvmFailureReason) {
              logger.info(`Entpackt via legacy/${retryExtractorName} (nach JVM-Fehler): ${archiveName}`);
            } else {
              logger.info(`Entpackt via legacy/${retryExtractorName} (nach Legacy-Retry): ${archiveName}`);
            }
            logger.info(`Extract-Backend Ende: archive=${archiveName}, backend=legacy/${retryExtractorName}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, legacyMs=${retryLegacyMs}, fallbackFromJvm=${fallbackFromJvm}, usedPassword=${password ? "yes" : "no"}`);
            onLog?.("INFO", `Extract-Backend Ende: archive=${archiveName}, backend=legacy/${retryExtractorName}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, legacyMs=${retryLegacyMs}, fallbackFromJvm=${fallbackFromJvm}, usedPassword=${password ? "yes" : "no"}`);
            return password;
          } catch (retryError) {
            const retryText = String((retryError as Error)?.message || retryError || "");
            const retryCategory = classifyExtractionError(retryText);
            logger.warn(`Legacy-Retry ebenfalls fehlgeschlagen (${retryCategory}): ${archiveName}`);
            onLog?.("WARN", `Legacy-Retry ebenfalls fehlgeschlagen (${retryCategory}): ${archiveName}`);
            const suggestRedownload = jvmCodecError && (retryCategory === "crc_error" || retryCategory === "wrong_password");
            finalLegacyError = withExtractionErrorHints(retryError, {
              suggestRedownload,
              jvmFailureReason: jvmFailureReason || undefined
            });
          }
        } else {
          finalLegacyError = withExtractionErrorHints(legacyError, {
            jvmFailureReason: jvmFailureReason || undefined
          });
        }
      } else {
        const suggestRedownload = jvmCodecError && isCrcOrWrongPw;
        finalLegacyError = withExtractionErrorHints(legacyError, {
          suggestRedownload,
          jvmFailureReason: jvmFailureReason || undefined
        });
      }

      const finalLegacyHints = finalLegacyError as ExtractionErrorWithHints;
      const finalLegacyText = String(finalLegacyError?.message || finalLegacyError || "");
      const finalLegacyBestPercent = Number.isFinite(finalLegacyHints.legacyBestPercent)
        ? Number(finalLegacyHints.legacyBestPercent || 0)
        : initialLegacyBestPercent;

      if (!signal?.aborted && shouldFallbackLegacyRarToJvm(archivePath, configuredBackendMode, backendMode, finalLegacyText, finalLegacyBestPercent)) {
        const layout = resolveJvmExtractorLayout();
        if (layout) {
          logger.warn(`Legacy->JVM-Fallback: archive=${archiveName}, bestPercent=${finalLegacyBestPercent}, reason=${cleanErrorText(finalLegacyText)}`);
          onLog?.("WARN", `Legacy->JVM-Fallback: archive=${archiveName}, bestPercent=${finalLegacyBestPercent}, reason=${cleanErrorText(finalLegacyText)}`);
          const jvmStartedAt = Date.now();
          const jvmResult = await runJvmExtractCommand(
            layout,
            archivePath,
            targetDir,
            conflictMode,
            passwordCandidates,
            onArchiveProgress,
            signal,
            timeoutMs
          );
          const jvmMs = Date.now() - jvmStartedAt;
          logger.info(`JVM-Extractor Ergebnis (nach Legacy-Fallback): archive=${archiveName}, ok=${jvmResult.ok}, ms=${jvmMs}, timedOut=${jvmResult.timedOut}, aborted=${jvmResult.aborted}, backend=${jvmResult.backend || "unknown"}, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);
          onLog?.("INFO", `JVM-Extractor Ergebnis (nach Legacy-Fallback): archive=${archiveName}, ok=${jvmResult.ok}, ms=${jvmMs}, timedOut=${jvmResult.timedOut}, aborted=${jvmResult.aborted}, backend=${jvmResult.backend || "unknown"}, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);
          if (jvmResult.ok) {
            logger.info(`Entpackt via ${jvmResult.backend || "jvm"} (nach Legacy-Fallback): ${archiveName}`);
            logger.info(`Extract-Backend Ende: archive=${archiveName}, backend=${jvmResult.backend || "jvm"}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, fallbackFromJvm=${fallbackFromJvm}, fallbackFromLegacy=true, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);
            onLog?.("INFO", `Extract-Backend Ende: archive=${archiveName}, backend=${jvmResult.backend || "jvm"}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, fallbackFromJvm=${fallbackFromJvm}, fallbackFromLegacy=true, usedPassword=${jvmResult.usedPassword ? "yes" : "no"}`);
            return jvmResult.usedPassword;
          }
          if (jvmResult.aborted) {
            throw new Error("aborted:extract");
          }
          finalLegacyError = withExtractionErrorHints(finalLegacyError, {
            jvmFailureReason: jvmResult.errorText || "JVM-Extractor fehlgeschlagen"
          });
          logger.warn(`Legacy->JVM-Fallback ebenfalls fehlgeschlagen: ${archiveName} (${cleanErrorText(jvmResult.errorText || "JVM-Extractor fehlgeschlagen")})`);
          onLog?.("WARN", `Legacy->JVM-Fallback ebenfalls fehlgeschlagen: archive=${archiveName}, error=${cleanErrorText(jvmResult.errorText || "JVM-Extractor fehlgeschlagen")}`);
        } else {
          logger.warn(`Legacy->JVM-Fallback uebersprungen: JVM-Extractor nicht verfuegbar fuer ${archiveName}`);
          onLog?.("WARN", `Legacy->JVM-Fallback uebersprungen: archive=${archiveName}, reason=no_jvm_extractor`);
        }
      }

      throw finalLegacyError;
    }
    const legacyMs = Date.now() - legacyStartedAt;
    const extractorName = path.basename(usedCommand).replace(/\.exe$/i, "");
    if (jvmFailureReason) {
      logger.info(`Entpackt via legacy/${extractorName} (nach JVM-Fehler): ${archiveName}`);
    } else {
      logger.info(`Entpackt via legacy/${extractorName}: ${archiveName}`);
    }
    logger.info(`Extract-Backend Ende: archive=${archiveName}, backend=legacy/${extractorName}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, legacyMs=${legacyMs}, fallbackFromJvm=${fallbackFromJvm}, usedPassword=${password ? "yes" : "no"}`);
    onLog?.("INFO", `Extract-Backend Ende: archive=${archiveName}, backend=legacy/${extractorName}, mode=${backendMode}, ms=${Date.now() - totalStartedAt}, legacyMs=${legacyMs}, fallbackFromJvm=${fallbackFromJvm}, usedPassword=${password ? "yes" : "no"}`);
    return password;
  } finally {
    if (subst) removeSubstMapping(subst);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Sektion 14 – ZIP Extraction (AdmZip)
// ══════════════════════════════════════════════════════════════════════════════

function isZipSafetyGuardError(error: unknown): boolean {
  const text = String(error || "").toLowerCase();
  return text.includes("path traversal")
    || text.includes("zip-eintrag verdächtig groß")
    || text.includes("zip-eintrag verdaechtig gross");
}

function isZipInternalLimitError(error: unknown): boolean {
  const text = String(error || "").toLowerCase();
  return text.includes("zip-eintrag zu groß")
    || text.includes("zip-eintrag komprimiert zu groß")
    || text.includes("zip-eintrag ohne sichere groessenangabe");
}

function shouldFallbackToExternalZip(error: unknown): boolean {
  if (isZipSafetyGuardError(error)) {
    return false;
  }
  if (isZipInternalLimitError(error)) {
    return true;
  }
  const text = String(error || "").toLowerCase();
  if (text.includes("aborted:extract") || text.includes("extract_aborted")) {
    return false;
  }
  return true;
}

async function extractZipArchive(archivePath: string, targetDir: string, conflictMode: ConflictMode, signal?: AbortSignal): Promise<void> {
  const mode = effectiveConflictMode(conflictMode);
  const memoryLimitBytes = zipEntryMemoryLimitBytes();
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  const resolvedTarget = path.resolve(targetDir);
  const usedOutputs = new Set<string>();
  const renameCounters = new Map<string, number>();

  for (const entry of entries) {
    if (signal?.aborted) {
      throw new Error("aborted:extract");
    }
    const baseOutputPath = path.resolve(targetDir, entry.entryName);
    if (!baseOutputPath.startsWith(resolvedTarget + path.sep) && baseOutputPath !== resolvedTarget) {
      logger.warn(`ZIP-Eintrag übersprungen (Path Traversal): ${entry.entryName}`);
      continue;
    }
    if (entry.isDirectory) {
      await fs.promises.mkdir(baseOutputPath, { recursive: true });
      continue;
    }

    const header = (entry as unknown as {
      header?: {
        size?: number;
        compressedSize?: number;
        crc?: number;
        dataHeader?: {
          size?: number;
          compressedSize?: number;
          crc?: number;
        };
      };
    }).header;
    const uncompressedSize = Number(header?.size ?? header?.dataHeader?.size ?? NaN);
    const compressedSize = Number(header?.compressedSize ?? header?.dataHeader?.compressedSize ?? NaN);

    if (!Number.isFinite(uncompressedSize) || uncompressedSize < 0) {
      throw new Error("ZIP-Eintrag ohne sichere Groessenangabe fur internen Entpacker");
    }
    if (!Number.isFinite(compressedSize) || compressedSize < 0) {
      throw new Error("ZIP-Eintrag ohne sichere Groessenangabe fur internen Entpacker");
    }

    if (uncompressedSize > memoryLimitBytes) {
      const entryMb = Math.ceil(uncompressedSize / (1024 * 1024));
      const limitMb = Math.ceil(memoryLimitBytes / (1024 * 1024));
      throw new Error(`ZIP-Eintrag zu groß für internen Entpacker (${entryMb} MB > ${limitMb} MB)`);
    }
    if (compressedSize > memoryLimitBytes) {
      const entryMb = Math.ceil(compressedSize / (1024 * 1024));
      const limitMb = Math.ceil(memoryLimitBytes / (1024 * 1024));
      throw new Error(`ZIP-Eintrag komprimiert zu groß für internen Entpacker (${entryMb} MB > ${limitMb} MB)`);
    }

    let outputPath = baseOutputPath;
    let outputKey = pathSetKey(outputPath);

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    // TOCTOU note: There is a small race between access and writeFile below.
    // This is acceptable here because zip extraction is single-threaded and we need
    // the exists check to implement skip/rename conflict resolution semantics.
    const outputExists = usedOutputs.has(outputKey) || await fs.promises.access(outputPath).then(() => true, () => false);
    if (outputExists) {
      if (mode === "skip") {
        continue;
      }
      if (mode === "rename") {
        const parsed = path.parse(baseOutputPath);
        const counterKey = pathSetKey(baseOutputPath);
        let n = renameCounters.get(counterKey) || 1;
        let candidate = baseOutputPath;
        let candidateKey = outputKey;
        while (n <= 10000) {
          candidate = path.join(parsed.dir, `${parsed.name} (${n})${parsed.ext}`);
          candidateKey = pathSetKey(candidate);
          if (!usedOutputs.has(candidateKey) && !(await fs.promises.access(candidate).then(() => true, () => false))) {
            break;
          }
          n += 1;
        }
        if (n > 10000) {
          throw new Error(`ZIP-Rename-Limit erreicht für ${entry.entryName}`);
        }
        renameCounters.set(counterKey, n + 1);
        if (signal?.aborted) {
          throw new Error("aborted:extract");
        }
        outputPath = candidate;
        outputKey = candidateKey;
      }
    }

    if (signal?.aborted) {
      throw new Error("aborted:extract");
    }
    const data = entry.getData();
    if (data.length > memoryLimitBytes) {
      const entryMb = Math.ceil(data.length / (1024 * 1024));
      const limitMb = Math.ceil(memoryLimitBytes / (1024 * 1024));
      throw new Error(`ZIP-Eintrag zu groß für internen Entpacker (${entryMb} MB > ${limitMb} MB)`);
    }
    const maxDeclaredSize = Math.max(uncompressedSize, compressedSize);
    if (maxDeclaredSize > 0 && data.length > maxDeclaredSize * 20) {
      throw new Error(`ZIP-Eintrag verdächtig groß nach Entpacken (${entry.entryName})`);
    }
    await fs.promises.writeFile(outputPath, data);
    usedOutputs.add(outputKey);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Sektion 15 – Disk Space, Timeout & Memory Limits
// ══════════════════════════════════════════════════════════════════════════════

async function estimateArchivesTotalBytes(candidates: string[]): Promise<number> {
  let total = 0;
  for (const archivePath of candidates) {
    const parts = collectArchiveCleanupTargets(archivePath);
    for (const part of parts) {
      try {
        total += (await fs.promises.stat(part)).size;
      } catch { /* missing part, ignore */ }
    }
  }
  return total;
}

function humanSizeGB(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

async function checkDiskSpaceForExtraction(targetDir: string, candidates: string[]): Promise<void> {
  if (candidates.length === 0) return;
  const archiveBytes = await estimateArchivesTotalBytes(candidates);
  if (archiveBytes <= 0) return;
  const requiredBytes = Math.ceil(archiveBytes * DISK_SPACE_SAFETY_FACTOR);

  let freeBytes: number;
  try {
    const stats = await fs.promises.statfs(targetDir);
    freeBytes = stats.bfree * stats.bsize;
  } catch {
    return;
  }

  if (freeBytes < requiredBytes) {
    const msg = `Nicht genug Speicherplatz: ${humanSizeGB(requiredBytes)} benötigt, ${humanSizeGB(freeBytes)} frei`;
    logger.error(`Disk-Space-Check: ${msg} (target=${targetDir})`);
    throw new Error(msg);
  }
  logger.info(`Disk-Space-Check OK: ${humanSizeGB(freeBytes)} frei, ${humanSizeGB(requiredBytes)} benötigt (target=${targetDir})`);
}

function zipEntryMemoryLimitBytes(): number {
  const fromEnvMb = Number(process.env.RD_ZIP_ENTRY_MEMORY_LIMIT_MB ?? NaN);
  if (Number.isFinite(fromEnvMb) && fromEnvMb >= 8 && fromEnvMb <= 4096) {
    return Math.floor(fromEnvMb * 1024 * 1024);
  }
  return DEFAULT_ZIP_ENTRY_MEMORY_LIMIT_MB * 1024 * 1024;
}

async function shouldPreferExternalZip(archivePath: string): Promise<boolean> {
  if (extractorBackendMode() !== "legacy") {
    return true;
  }
  try {
    const stat = await fs.promises.stat(archivePath);
    return stat.size >= 64 * 1024 * 1024;
  } catch {
    return true;
  }
}

async function computeExtractTimeoutMs(archivePath: string): Promise<number> {
  try {
    const relatedFiles = collectArchiveCleanupTargets(archivePath);
    let totalBytes = 0;
    for (const filePath of relatedFiles) {
      try {
        totalBytes += (await fs.promises.stat(filePath)).size;
      } catch {
        // ignore missing parts
      }
    }
    if (totalBytes <= 0) {
      totalBytes = (await fs.promises.stat(archivePath)).size;
    }
    const gib = totalBytes / (1024 * 1024 * 1024);
    const dynamicMs = EXTRACT_BASE_TIMEOUT_MS + Math.floor(gib * EXTRACT_PER_GIB_TIMEOUT_MS);
    return Math.max(EXTRACT_BASE_TIMEOUT_MS, Math.min(EXTRACT_MAX_TIMEOUT_MS, dynamicMs));
  } catch {
    return EXTRACT_BASE_TIMEOUT_MS;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Sektion 16 – Resume State
// ══════════════════════════════════════════════════════════════════════════════

function extractProgressFilePath(packageDir: string, packageId?: string): string {
  if (packageId) {
    return path.join(packageDir, `.rd_extract_progress_${packageId}.json`);
  }
  return path.join(packageDir, EXTRACT_PROGRESS_FILE);
}

async function readExtractResumeState(packageDir: string, packageId?: string): Promise<Set<string>> {
  const progressPath = extractProgressFilePath(packageDir, packageId);
  try {
    await fs.promises.access(progressPath);
  } catch {
    return new Set<string>();
  }
  try {
    const payload = JSON.parse(await fs.promises.readFile(progressPath, "utf8")) as Partial<ExtractResumeState>;
    const names = Array.isArray(payload.completedArchives) ? payload.completedArchives : [];
    return new Set(names.map((value) => archiveNameKey(String(value || "").trim())).filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

async function writeExtractResumeState(packageDir: string, completedArchives: Set<string>, packageId?: string): Promise<void> {
  try {
    await fs.promises.mkdir(packageDir, { recursive: true });
    const progressPath = extractProgressFilePath(packageDir, packageId);
    const payload: ExtractResumeState = {
      completedArchives: Array.from(completedArchives)
        .map((name) => archiveNameKey(name))
        .sort((a, b) => a.localeCompare(b))
    };
    const tmpPath = progressPath + "." + Date.now() + "." + Math.random().toString(36).slice(2, 8) + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.promises.rename(tmpPath, progressPath).catch(async () => {
      // rename may fail if another writer renamed tmpPath first (parallel workers)
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    });
  } catch (error) {
    logger.warn(`ExtractResumeState schreiben fehlgeschlagen: ${String(error)}`);
  }
}

export async function clearExtractResumeState(packageDir: string, packageId?: string): Promise<void> {
  try {
    await fs.promises.rm(extractProgressFilePath(packageDir, packageId), { force: true });
  } catch {
    // ignore
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Sektion 17 – Progress & Conflict Helpers
// ══════════════════════════════════════════════════════════════════════════════

function emitExtractLog(
  onLog: ExtractOptions["onLog"] | undefined,
  level: "INFO" | "WARN" | "ERROR",
  message: string
): void {
  if (level === "INFO") {
    logger.info(message);
  } else if (level === "WARN") {
    logger.warn(message);
  } else {
    logger.error(message);
  }
  onLog?.(level, message);
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

// ══════════════════════════════════════════════════════════════════════════════
// Sektion 18 – extractPackageArchives (Orchestrierung)
// ══════════════════════════════════════════════════════════════════════════════

export async function extractPackageArchives(options: ExtractOptions): Promise<{ extracted: number; failed: number; lastError: string }> {
  if (options.signal?.aborted) {
    throw new Error("aborted:extract");
  }
  options.onProgress?.({ current: 0, total: 0, percent: 0, archiveName: "Archive scannen...", phase: "preparing" });
  const allCandidates = await findArchiveCandidates(options.packageDir);
  const candidates = options.onlyArchives
    ? allCandidates.filter((archivePath) => {
      const key = process.platform === "win32" ? path.resolve(archivePath).toLowerCase() : path.resolve(archivePath);
      return options.onlyArchives!.has(key);
    })
    : allCandidates;
  logger.info(`Entpacken gestartet: packageDir=${options.packageDir}, targetDir=${options.targetDir}, archives=${candidates.length}${options.onlyArchives ? ` (hybrid, gesamt=${allCandidates.length})` : ""}, cleanupMode=${options.cleanupMode}, conflictMode=${options.conflictMode}`);
  options.onLog?.("INFO", `Entpacken gestartet: packageDir=${options.packageDir}, targetDir=${options.targetDir}, archives=${candidates.length}${options.onlyArchives ? ` (hybrid, gesamt=${allCandidates.length})` : ""}, cleanupMode=${options.cleanupMode}, conflictMode=${options.conflictMode}`);

  // Disk space pre-check
  if (candidates.length > 0) {
    options.onProgress?.({ current: 0, total: candidates.length, percent: 0, archiveName: "Speicherplatz prüfen...", phase: "preparing" });
    try {
      await fs.promises.mkdir(options.targetDir, { recursive: true });
    } catch { /* ignore */ }
    await checkDiskSpaceForExtraction(options.targetDir, candidates);
  }

  if (candidates.length === 0) {
    if (!options.onlyArchives) {
      const existingResume = await readExtractResumeState(options.packageDir, options.packageId);
      if (existingResume.size > 0 && await hasAnyEntries(options.targetDir)) {
        await clearExtractResumeState(options.packageDir, options.packageId);
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
      await clearExtractResumeState(options.packageDir, options.packageId);
    }
    logger.info(`Entpacken übersprungen (keine Archive gefunden): ${options.packageDir}`);
    return { extracted: 0, failed: 0, lastError: "" };
  }

  const conflictMode = effectiveConflictMode(options.conflictMode);
  if (options.conflictMode === "ask") {
    logger.warn("Extract-ConflictMode 'ask' wird ohne Prompt als 'skip' behandelt");
  }
  const passwordCacheKey = packagePasswordCacheKey(options.packageDir, options.packageId);
  const passwordCacheLabel = packagePasswordCacheLabel(options.packageDir, options.packageId);
  let passwordCandidates = archivePasswords(options.passwordList || "");
  const cachedPackagePassword = readCachedPackagePassword(passwordCacheKey);
  if (cachedPackagePassword) {
    passwordCandidates = prioritizePassword(passwordCandidates, cachedPackagePassword);
    logger.info(`Passwort-Cache Treffer: ${passwordCacheLabel}, bekanntes Passwort wird zuerst getestet`);
    options.onLog?.("INFO", `Passwort-Cache Treffer: ${passwordCacheLabel}, bekanntes Passwort wird zuerst getestet`);
  }
  const resumeCompleted = await readExtractResumeState(options.packageDir, options.packageId);
  const resumeCompletedAtStart = resumeCompleted.size;
  const allCandidateNames = new Set(allCandidates.map((archivePath) => archiveNameKey(path.basename(archivePath))));
  for (const archiveName of Array.from(resumeCompleted.values())) {
    if (!allCandidateNames.has(archiveName)) {
      resumeCompleted.delete(archiveName);
    }
  }
  if (resumeCompleted.size > 0) {
    await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
  } else {
    await clearExtractResumeState(options.packageDir, options.packageId);
  }

  const pendingCandidates = candidates.filter((archivePath) => !resumeCompleted.has(archiveNameKey(path.basename(archivePath))));
  let extracted = candidates.length - pendingCandidates.length;
  let failed = 0;
  let lastError = "";
  let learnedPassword = cachedPackagePassword;
  let packageNeedsFlatMode = false;
  const extractedArchives = new Set<string>();
  const failedArchiveCategories = new Map<string, ExtractErrorCategory>();
  for (const archivePath of candidates) {
    if (resumeCompleted.has(archiveNameKey(path.basename(archivePath)))) {
      extractedArchives.add(archivePath);
    }
  }

  const rememberLearnedPassword = (password: string): void => {
    const normalized = String(password || "").trim();
    if (!normalized) {
      return;
    }
    const changed = normalized !== learnedPassword;
    learnedPassword = normalized;
    passwordCandidates = prioritizePassword(passwordCandidates, normalized);
    writeCachedPackagePassword(passwordCacheKey, normalized);
    if (changed) {
      logger.info(`Passwort-Cache Update: ${passwordCacheLabel}, neues Passwort gelernt`);
      options.onLog?.("INFO", `Passwort-Cache Update: ${passwordCacheLabel}, neues Passwort gelernt`);
    }
  };

  const emitProgress = (
    current: number,
    archiveName: string,
    phase: "extracting" | "done",
    archivePercent?: number,
    elapsedMs?: number,
    pwInfo?: { passwordAttempt?: number; passwordTotal?: number; passwordFound?: boolean },
    archiveInfo?: { archiveDone?: boolean; archiveSuccess?: boolean }
  ): void => {
    if (!options.onProgress) {
      return;
    }
    const total = Math.max(1, candidates.length);
    let percent = Math.max(0, Math.min(100, Math.floor((current / total) * 100)));
    let normalizedArchivePercent = Math.max(0, Math.min(100, Number(archivePercent ?? 0)));
    if (phase !== "done") {
      const boundedCurrent = Math.max(0, Math.min(total, current));
      if (archiveInfo?.archiveDone !== true && normalizedArchivePercent >= 100) {
        normalizedArchivePercent = 99;
      }
      percent = Math.max(0, Math.min(100, Math.floor(((boundedCurrent + (normalizedArchivePercent / 100)) / total) * 100)));
    }
    try {
      options.onProgress({
        current,
        total,
        percent,
        archiveName,
        archivePercent: normalizedArchivePercent,
        elapsedMs,
        phase,
        ...(archiveInfo || {}),
        ...(pwInfo || {})
      });
    } catch (error) {
      logger.warn(`onProgress callback Fehler unterdrückt: ${cleanErrorText(String(error))}`);
    }
  };

  emitProgress(extracted, "", "extracting");

  // Emit "done" progress for archives already completed via resume state
  // so the caller's onProgress handler can mark their items as "Done" immediately
  // rather than leaving them as "Entpacken - Ausstehend" until all extraction finishes.
  for (const archivePath of candidates) {
    if (resumeCompleted.has(archiveNameKey(path.basename(archivePath)))) {
      emitProgress(extracted, path.basename(archivePath), "extracting", 100, 0, undefined, { archiveDone: true, archiveSuccess: true });
    }
  }

  const maxParallel = Math.max(1, options.maxParallel || 1);
  let noExtractorEncountered = false;
  let lastArchiveFinishedAt: number | null = null;

  const extractSingleArchive = async (archivePath: string): Promise<void> => {
    if (options.signal?.aborted) {
      throw new Error("aborted:extract");
    }
    if (noExtractorEncountered) {
      throw new Error("noextractor:skipped");
    }
    const archiveName = path.basename(archivePath);
    const archiveResumeKey = archiveNameKey(archiveName);
    const archiveStartedAt = Date.now();
    const startedCurrent = extracted + failed;
    if (lastArchiveFinishedAt !== null) {
      logger.info(`Extract-Trace Gap: before=${archiveName}, prevDoneToStartMs=${archiveStartedAt - lastArchiveFinishedAt}, progress=${startedCurrent}/${candidates.length}`);
    }
    let archivePercent = 0;
    let reached99At: number | null = null;
    let archiveOutcome: "success" | "failed" | "skipped" = "failed";
    emitProgress(extracted + failed, archiveName, "extracting", archivePercent, 0);
    const pulseTimer = setInterval(() => {
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
    }, 1100);
    const hybrid = Boolean(options.hybridMode);
    // Before the first successful extraction, filename-derived candidates are useful.
    // After a known password is learned, try that first to avoid per-archive delays.
    const filenamePasswords = archiveFilenamePasswords(archiveName);
    const nonEmptyBasePasswords = passwordCandidates.filter((p) => p !== "");
    const orderedNonEmpty = learnedPassword
      ? [learnedPassword, ...nonEmptyBasePasswords.filter((p) => p !== learnedPassword), ...filenamePasswords]
      : [...filenamePasswords, ...nonEmptyBasePasswords];
    const archivePasswordCandidates = learnedPassword
      ? Array.from(new Set([...orderedNonEmpty, ""]))
      : Array.from(new Set(["", ...orderedNonEmpty]));
    const reportArchiveProgress = (value: number): void => {
      archivePercent = nextArchivePercent(archivePercent, value);
      if (reached99At === null && archivePercent >= 99) {
        reached99At = Date.now();
        logger.info(`Extract-Trace 99%: archive=${archiveName}, elapsedMs=${reached99At - archiveStartedAt}`);
      }
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
    };

    // Validate generic .001 splits via file signature before attempting extraction
    const isGenericSplit = /\.\d{3}$/i.test(archiveName) && !/\.(zip|7z)\.\d{3}$/i.test(archiveName);
    if (isGenericSplit) {
      const sig = await detectArchiveSignature(archivePath);
      if (!sig) {
        logger.info(`Generische Split-Datei übersprungen (keine Archiv-Signatur): ${archiveName}`);
        extracted += 1;
        resumeCompleted.add(archiveResumeKey);
        extractedArchives.add(archivePath);
        await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
        clearInterval(pulseTimer);
        archiveOutcome = "skipped";
        const skippedAt = Date.now();
        lastArchiveFinishedAt = skippedAt;
        logger.info(`Extract-Trace Archiv Übersprungen: archive=${archiveName}, ms=${skippedAt - archiveStartedAt}, reason=no-signature`);
        return;
      }
      logger.info(`Generische Split-Datei verifiziert (Signatur: ${sig}): ${archiveName}`);
    }

    logger.info(`Entpacke Archiv: ${path.basename(archivePath)} -> ${options.targetDir}${hybrid ? " (hybrid, reduced threads, low I/O)" : ""}`);
    options.onLog?.("INFO", `Entpacke Archiv: ${path.basename(archivePath)} -> ${options.targetDir}${hybrid ? " (hybrid, reduced threads, low I/O)" : ""}`);
    const emptyArchivePasswordCount = archivePasswordCandidates.filter((candidate) => candidate === "").length;
    options.onLog?.("INFO", `Archiv-Passwortliste: archive=${archiveName}, passwordCount=${archivePasswordCandidates.length}, redacted=true, emptyCandidates=${emptyArchivePasswordCount}`);
    const hasManyPasswords = archivePasswordCandidates.length > 1;
    if (hasManyPasswords) {
      emitProgress(extracted + failed, archiveName, "extracting", 0, 0, { passwordAttempt: 0, passwordTotal: archivePasswordCandidates.length });
    }
    const onPwAttempt = hasManyPasswords
      ? (attempt: number, total: number) => {
        emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt, { passwordAttempt: attempt, passwordTotal: total });
        options.onLog?.("INFO", `Passwort-Versuch ${attempt}/${total}: archive=${archiveName}, password=<redacted>`);
      }
      : undefined;
    try {
      // Set module-level priority before each extract call (race-safe: spawn is synchronous)
      currentExtractCpuPriority = options.extractCpuPriority;
      const ext = path.extname(archivePath).toLowerCase();
      if (ext === ".zip") {
        const preferExternal = await shouldPreferExternalZip(archivePath);
        if (preferExternal) {
          try {
            const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, archivePasswordCandidates, (value) => {
              reportArchiveProgress(value);
            }, options.signal, hybrid, onPwAttempt, false, undefined, options.onLog);
            rememberLearnedPassword(usedPassword);
          } catch (error) {
            if (isNoExtractorError(String(error))) {
              await extractZipArchive(archivePath, options.targetDir, options.conflictMode, options.signal);
            } else {
              throw error;
            }
          }
        } else {
          try {
            await extractZipArchive(archivePath, options.targetDir, options.conflictMode, options.signal);
            archivePercent = 100;
          } catch (error) {
            if (!shouldFallbackToExternalZip(error)) {
              throw error;
            }
            try {
              const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, archivePasswordCandidates, (value) => {
                reportArchiveProgress(value);
              }, options.signal, hybrid, onPwAttempt, false, undefined, options.onLog);
              rememberLearnedPassword(usedPassword);
            } catch (externalError) {
              if (isNoExtractorError(String(externalError)) || isUnsupportedArchiveFormatError(String(externalError))) {
                throw error;
              }
              throw externalError;
            }
          }
        }
      } else {
        const flatResult = { needed: false };
        const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, archivePasswordCandidates, (value) => {
          reportArchiveProgress(value);
        }, options.signal, hybrid, onPwAttempt, packageNeedsFlatMode, flatResult, options.onLog);
        rememberLearnedPassword(usedPassword);
        if (flatResult.needed) packageNeedsFlatMode = true;
      }
      extracted += 1;
      extractedArchives.add(archivePath);
      failedArchiveCategories.delete(archivePath);
      resumeCompleted.add(archiveResumeKey);
      await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
      logger.info(`Entpacken erfolgreich: ${path.basename(archivePath)}`);
      options.onLog?.("INFO", `Entpacken erfolgreich: ${path.basename(archivePath)}`);
      archiveOutcome = "success";
      const successAt = Date.now();
      const tailAfter99Ms = reached99At ? (successAt - reached99At) : -1;
      logger.info(`Extract-Trace Archiv Erfolg: archive=${archiveName}, totalMs=${successAt - archiveStartedAt}, tailAfter99Ms=${tailAfter99Ms >= 0 ? tailAfter99Ms : "n/a"}, pwCandidates=${archivePasswordCandidates.length}`);
      lastArchiveFinishedAt = successAt;
      archivePercent = 100;
      if (hasManyPasswords) {
        emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt, { passwordFound: true }, { archiveDone: true, archiveSuccess: true });
      } else {
        emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt, undefined, { archiveDone: true, archiveSuccess: true });
      }
    } catch (error) {
      const errorText = String(error);
      if (isExtractAbortError(errorText)) {
        throw error;
      }
      failed += 1;
      lastError = errorText;
      const errorCategory = classifyExtractionError(errorText);
      failedArchiveCategories.set(archivePath, errorCategory);
      const hintedError = error as ExtractionErrorWithHints;
      options.onArchiveFailure?.({
        archiveName,
        errorText,
        category: errorCategory,
        suggestRedownload: hintedError?.suggestRedownload === true,
        jvmFailureReason: hintedError?.jvmFailureReason
      });
      logger.error(`Entpack-Fehler ${path.basename(archivePath)} [${errorCategory}]: ${errorText}`);
      options.onLog?.("ERROR", `Entpack-Fehler ${path.basename(archivePath)} [${errorCategory}]: ${errorText}`);
      if (errorCategory === "wrong_password" && learnedPassword) {
        learnedPassword = "";
        clearCachedPackagePassword(passwordCacheKey);
        logger.warn(`Passwort-Cache verworfen: ${passwordCacheLabel} (wrong_password)`);
        options.onLog?.("WARN", `Passwort-Cache verworfen: ${passwordCacheLabel} (wrong_password)`);
      }
      const failedAt = Date.now();
      const tailAfter99Ms = reached99At ? (failedAt - reached99At) : -1;
      logger.warn(`Extract-Trace Archiv Fehler: archive=${archiveName}, totalMs=${failedAt - archiveStartedAt}, tailAfter99Ms=${tailAfter99Ms >= 0 ? tailAfter99Ms : "n/a"}, category=${errorCategory}`);
      lastArchiveFinishedAt = failedAt;
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt, undefined, { archiveDone: true, archiveSuccess: false });
      if (isNoExtractorError(errorText)) {
        noExtractorEncountered = true;
      }
    } finally {
      clearInterval(pulseTimer);
      if (lastArchiveFinishedAt === null || lastArchiveFinishedAt < archiveStartedAt) {
        lastArchiveFinishedAt = Date.now();
      }
      logger.info(`Extract-Trace Archiv Ende: archive=${archiveName}, outcome=${archiveOutcome}, elapsedMs=${lastArchiveFinishedAt - archiveStartedAt}, percent=${archivePercent}`);
    }
  };

  if (maxParallel <= 1) {
    for (const archivePath of pendingCandidates) {
      if (options.signal?.aborted || noExtractorEncountered) break;
      await extractSingleArchive(archivePath);
    }
    // Count remaining archives as failed when no extractor was found
    if (noExtractorEncountered) {
      const remaining = candidates.length - (extracted + failed);
      if (remaining > 0) {
        failed += remaining;
        emitProgress(candidates.length, "", "extracting", 0, 0);
      }
    }
  } else {
    // Password discovery: extract first archive serially to find the correct password,
    // then run remaining archives in parallel with the promoted password order.
    let parallelQueue = pendingCandidates;
    if (passwordCandidates.length > 1 && pendingCandidates.length > 1) {
      logger.info(`Passwort-Discovery: Extrahiere erstes Archiv seriell (${passwordCandidates.length} Passwort-Kandidaten)...`);
      options.onLog?.("INFO", `Passwort-Discovery: Extrahiere erstes Archiv seriell (${passwordCandidates.length} Passwort-Kandidaten)...`);
      const first = pendingCandidates[0];
      try {
        await extractSingleArchive(first);
      } catch (err) {
        const errText = String(err);
        if (/aborted:extract/i.test(errText)) throw err;
        // noextractor:skipped — handled by noExtractorEncountered flag below
      }
      parallelQueue = pendingCandidates.slice(1);
      if (parallelQueue.length > 0) {
        logger.info(`Passwort-Discovery abgeschlossen, starte parallele Extraktion für ${parallelQueue.length} verbleibende Archive`);
      }
    }

    if (parallelQueue.length > 0 && !options.signal?.aborted && !noExtractorEncountered) {
      // Parallel extraction pool: N workers pull from a shared queue
      const queue = [...parallelQueue];
      let nextIdx = 0;
      let abortError: Error | null = null;

      const worker = async (): Promise<void> => {
        while (nextIdx < queue.length && !abortError && !noExtractorEncountered) {
          if (options.signal?.aborted) break;
          const idx = nextIdx;
          nextIdx += 1;
          try {
            await extractSingleArchive(queue[idx]);
          } catch (error) {
            const errText = String(error);
            if (errText.includes("noextractor:skipped")) {
              break; // handled by noExtractorEncountered flag after the pool
            }
            if (isExtractAbortError(errText)) {
              abortError = error instanceof Error ? error : new Error(errText);
              break;
            }
            // Non-abort errors are already handled inside extractSingleArchive
          }
        }
      };

      const workerCount = Math.min(maxParallel, parallelQueue.length);
      logger.info(`Parallele Extraktion: ${workerCount} gleichzeitige Worker für ${parallelQueue.length} Archive`);
      // Snapshot passwordCandidates before parallel extraction to avoid concurrent mutation.
      // Each worker reads the same promoted order from the serial password-discovery pass.
      const frozenPasswords = [...passwordCandidates];
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      // Restore passwordCandidates from frozen snapshot (parallel mutations are discarded).
      passwordCandidates = frozenPasswords;

      if (abortError) throw new Error("aborted:extract");

      if (failed > 0 && extracted === 0) {
        const failedArchives = parallelQueue.filter((ap) => !extractedArchives.has(ap) && !resumeCompleted.has(archiveNameKey(path.basename(ap))));
        const failedCategories = failedArchives.map((archivePath) => failedArchiveCategories.get(archivePath) || "unknown");
        if (failedArchives.length > 0 && shouldSerialRetryParallelFailures(extracted, failedCategories)) {
          const categorySummary = [...new Set(failedCategories)].join(",");
          logger.info(
            `Serielle Wiederholung nach Parallel-Fehlstart: ${failedArchives.length} Archive werden einzeln wiederholt ` +
            `(categories=${categorySummary || "unknown"})`
          );
          let retryRecovered = 0;
          for (const archivePath of failedArchives) {
            if (options.signal?.aborted || noExtractorEncountered) break;
            try {
              failed -= 1;
              await extractSingleArchive(archivePath);
              retryRecovered += 1;
            } catch (retryError) {
              const errText = String(retryError);
              if (isExtractAbortError(errText)) throw retryError;
            }
          }
          if (retryRecovered > 0) {
            logger.info(`Serielle Wiederholung nach Parallel-Fehlstart: ${retryRecovered}/${failedArchives.length} Archive erfolgreich entpackt`);
          }
        }
      }

      // ── Retry failed wrong_password archives serially ──
      // Parallel UnRAR processes writing to the same target directory can cause
      // CRC mismatches that are misreported as "Incorrect password".
      // If any archive succeeded (i.e. the password is known), retry the failed
      // ones one-at-a-time to eliminate false positives from I/O contention.
      if (failed > 0 && extracted > 0) {
        const failedArchives = parallelQueue.filter((ap) => !extractedArchives.has(ap) && !resumeCompleted.has(archiveNameKey(path.basename(ap))));
        if (failedArchives.length > 0) {
          logger.info(`Serielle Wiederholung: ${failedArchives.length} fehlgeschlagene Archive werden einzeln wiederholt (mögliche Parallelitäts-Kollision)`);
          let retryRecovered = 0;
          for (const archivePath of failedArchives) {
            if (options.signal?.aborted || noExtractorEncountered) break;
            try {
              // Reset failed count for this archive before retry
              failed -= 1;
              await extractSingleArchive(archivePath);
              retryRecovered += 1;
            } catch (retryError) {
              const errText = String(retryError);
              if (isExtractAbortError(errText)) throw retryError;
              // extractSingleArchive already incremented failed and logged the error
            }
          }
          if (retryRecovered > 0) {
            logger.info(`Serielle Wiederholung: ${retryRecovered}/${failedArchives.length} Archive erfolgreich entpackt`);
          }
        }
      }
    }

    if (noExtractorEncountered) {
      const remaining = candidates.length - (extracted + failed);
      if (remaining > 0) {
        failed += remaining;
        emitProgress(candidates.length, "", "extracting", 0, 0);
      }
    }
  }

  // ── Nested extraction: extract archives found inside the output (1 level) ──
  if (extracted > 0 && failed === 0 && !options.skipPostCleanup && !options.onlyArchives) {
    try {
      const nestedCandidates = (await findArchiveCandidates(options.targetDir))
        .filter((p) => !NESTED_EXTRACT_BLACKLIST_RE.test(p));
      if (nestedCandidates.length > 0) {
        logger.info(`Nested-Extraction: ${nestedCandidates.length} Archive im Output gefunden`);
        let nestedExtracted = 0;
        let nestedFailed = 0;
        try {
          await checkDiskSpaceForExtraction(options.targetDir, nestedCandidates);
        } catch (spaceError) {
          logger.warn(`Nested-Extraction Disk-Space-Check fehlgeschlagen: ${String(spaceError)}`);
          nestedCandidates.length = 0;
        }
        for (const nestedArchive of nestedCandidates) {
          if (options.signal?.aborted) throw new Error("aborted:extract");
          const nestedName = path.basename(nestedArchive);
          const nestedKey = archiveNameKey(`nested:${nestedName}`);
          if (resumeCompleted.has(nestedKey)) {
            logger.info(`Nested-Extraction übersprungen (bereits entpackt): ${nestedName}`);
            continue;
          }
          const nestedStartedAt = Date.now();
          let nestedPercent = 0;
          emitProgress(extracted + failed, `nested: ${nestedName}`, "extracting", nestedPercent, 0);
          const nestedPulse = setInterval(() => {
            emitProgress(extracted + failed, `nested: ${nestedName}`, "extracting", nestedPercent, Date.now() - nestedStartedAt);
          }, 1100);
          const hybrid = Boolean(options.hybridMode);
          logger.info(`Nested-Entpacke: ${nestedName} -> ${options.targetDir}${hybrid ? " (hybrid)" : ""}`);
          try {
            const ext = path.extname(nestedArchive).toLowerCase();
            if (ext === ".zip" && !(await shouldPreferExternalZip(nestedArchive))) {
              try {
                await extractZipArchive(nestedArchive, options.targetDir, options.conflictMode, options.signal);
                nestedPercent = 100;
              } catch (zipErr) {
                if (!shouldFallbackToExternalZip(zipErr)) throw zipErr;
                const usedPw = await runExternalExtract(nestedArchive, options.targetDir, options.conflictMode, passwordCandidates, (v) => { nestedPercent = Math.max(nestedPercent, v); }, options.signal, hybrid, undefined, false, undefined, options.onLog);
                rememberLearnedPassword(usedPw);
              }
            } else {
              const usedPw = await runExternalExtract(nestedArchive, options.targetDir, options.conflictMode, passwordCandidates, (v) => { nestedPercent = Math.max(nestedPercent, v); }, options.signal, hybrid, undefined, false, undefined, options.onLog);
              rememberLearnedPassword(usedPw);
            }
            extracted += 1;
            nestedExtracted += 1;
            extractedArchives.add(nestedArchive);
            resumeCompleted.add(nestedKey);
            await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
            logger.info(`Nested-Entpacken erfolgreich: ${nestedName}`);
            if (options.cleanupMode !== "none") {
              await cleanupArchives([nestedArchive], options.cleanupMode);
            }
          } catch (nestedErr) {
            const errText = String(nestedErr);
            if (isExtractAbortError(errText)) throw new Error("aborted:extract");
            if (isNoExtractorError(errText)) {
              logger.warn(`Nested-Extraction: Kein Extractor, überspringe restliche`);
              break;
            }
            failed += 1;
            nestedFailed += 1;
            lastError = errText;
            const nestedCategory = classifyExtractionError(errText);
            logger.error(`Nested-Entpack-Fehler ${nestedName} [${nestedCategory}]: ${errText}`);
          } finally {
            clearInterval(nestedPulse);
          }
        }
        logger.info(`Nested-Extraction abgeschlossen: ${nestedExtracted} entpackt, ${nestedFailed} fehlgeschlagen von ${nestedCandidates.length} Kandidaten`);
      }
    } catch (nestedError) {
      const errText = String(nestedError);
      if (isExtractAbortError(errText)) throw new Error("aborted:extract");
      logger.warn(`Nested-Extraction Fehler: ${cleanErrorText(errText)}`);
    }
  }

  if (extracted > 0) {
    const hasOutputAfter = await hasAnyFilesRecursive(options.targetDir);
    const hadResumeProgress = resumeCompletedAtStart > 0;
    if (!hasOutputAfter && conflictMode !== "skip" && !hadResumeProgress) {
      lastError = "Keine entpackten Dateien erkannt";
      failed += extracted;
      extracted = 0;
      logger.error(`Entpacken ohne neue Ausgabe erkannt: ${options.targetDir}. Cleanup wird NICHT ausgeführt.`);
    } else {
      if (!options.skipPostCleanup) {
        const cleanupSources = failed === 0 ? candidates : Array.from(extractedArchives.values());
        const sourceAndTargetEqual = pathSetKey(path.resolve(options.packageDir)) === pathSetKey(path.resolve(options.targetDir));
        const removedArchives = sourceAndTargetEqual
          ? 0
          : await cleanupArchives(cleanupSources, options.cleanupMode);
        if (sourceAndTargetEqual && options.cleanupMode !== "none") {
          logger.warn(`Archive-Cleanup übersprungen (Quelle=Ziel): ${options.packageDir}`);
        }
        if (options.cleanupMode !== "none") {
          logger.info(`Archive-Cleanup abgeschlossen: ${removedArchives} Datei(en) entfernt`);
        }
        if (options.removeLinks) {
          const removedLinks = await removeDownloadLinkArtifacts(options.targetDir);
          logger.info(`Link-Artefakt-Cleanup: ${removedLinks} Datei(en) entfernt`);
        }
        if (options.removeSamples) {
          const removedSamples = await removeSampleArtifacts(options.targetDir);
          logger.info(`Sample-Cleanup: ${removedSamples.files} Datei(en), ${removedSamples.dirs} Ordner entfernt`);
        }
      }

      if (failed === 0 && resumeCompleted.size >= allCandidates.length && !options.skipPostCleanup) {
        await clearExtractResumeState(options.packageDir, options.packageId);
      }

      if (!options.skipPostCleanup && options.cleanupMode === "delete" && !(await hasAnyFilesRecursive(options.packageDir))) {
        const removedDirs = await removeEmptyDirectoryTree(options.packageDir);
        if (removedDirs > 0) {
          logger.info(`Leere Download-Ordner entfernt: ${removedDirs} (root=${options.packageDir})`);
        }
      }
    }
  } else if (!options.skipPostCleanup) {
    try {
      const targetExists = await fs.promises.access(options.targetDir).then(() => true, () => false);
      if (targetExists && (await fs.promises.readdir(options.targetDir)).length === 0) {
        await fs.promises.rm(options.targetDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  if (failed > 0) {
    if (resumeCompleted.size > 0) {
      await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
    } else {
      await clearExtractResumeState(options.packageDir, options.packageId);
    }
  }

  emitProgress(extracted, "", "done");

  logger.info(`Entpacken beendet: extracted=${extracted}, failed=${failed}, targetDir=${options.targetDir}`);

  return { extracted, failed, lastError };
}
