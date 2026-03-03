import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import AdmZip from "adm-zip";
import { CleanupMode, ConflictMode } from "../shared/types";
import { logger } from "./logger";
import { removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";

import crypto from "node:crypto";

const DEFAULT_ARCHIVE_PASSWORDS = ["", "serienfans.org", "serienjunkies.org"];
const NO_EXTRACTOR_MESSAGE = "WinRAR/UnRAR nicht gefunden. Bitte WinRAR installieren.";
const NO_JVM_EXTRACTOR_MESSAGE = "7-Zip-JBinding Runtime nicht gefunden. Bitte resources/extractor-jvm prüfen.";
const JVM_EXTRACTOR_MAIN_CLASS = "com.sucukdeluxe.extractor.JBindExtractorMain";
const JVM_EXTRACTOR_CLASSES_SUBDIR = "classes";
const JVM_EXTRACTOR_LIB_SUBDIR = "lib";
const JVM_EXTRACTOR_REQUIRED_LIBS = [
  "sevenzipjbinding.jar",
  "sevenzipjbinding-all-platforms.jar",
  "zip4j.jar"
];

// ── subst drive mapping for long paths on Windows ──
const SUBST_THRESHOLD = 100;
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

interface SubstMapping { drive: string; original: string; }

function createSubstMapping(targetDir: string): SubstMapping | null {
  if (process.platform !== "win32" || targetDir.length < SUBST_THRESHOLD) return null;
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

let resolvedExtractorCommand: string | null = null;
let resolveFailureReason = "";
let resolveFailureAt = 0;
let externalExtractorSupportsPerfFlags = true;
let resolveExtractorCommandInFlight: Promise<string> | null = null;

const EXTRACTOR_RETRY_AFTER_MS = 30_000;
const DEFAULT_ZIP_ENTRY_MEMORY_LIMIT_MB = 256;
const EXTRACTOR_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_EXTRACT_CPU_BUDGET_PERCENT = 80;

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
const DISK_SPACE_SAFETY_FACTOR = 1.1;
const NESTED_EXTRACT_BLACKLIST_RE = /\.(iso|img|bin|dmg|vhd|vhdx|vmdk|wim)$/i;

export type ArchiveSignature = "rar" | "7z" | "zip" | "gzip" | "bzip2" | "xz" | null;

const ARCHIVE_SIGNATURES: { prefix: string; type: ArchiveSignature }[] = [
  { prefix: "526172211a07", type: "rar" },
  { prefix: "377abcaf271c", type: "7z" },
  { prefix: "504b0304", type: "zip" },
  { prefix: "1f8b08", type: "gzip" },
  { prefix: "425a68", type: "bzip2" },
  { prefix: "fd377a585a00", type: "xz" },
];

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

export function pathSetKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function archiveNameKey(fileName: string): string {
  return process.platform === "win32" ? String(fileName || "").toLowerCase() : String(fileName || "");
}

function archiveSortKey(filePath: string): string {
  const fileName = path.basename(filePath).toLowerCase();
  return fileName
    .replace(/\.part0*1\.rar$/i, "")
    .replace(/\.zip\.\d{3}$/i, "")
    .replace(/\.7z\.\d{3}$/i, "")
    .replace(/\.\d{3}$/i, "")
    .replace(/\.tar\.(gz|bz2|xz)$/i, "")
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
  if (/\.tar\.(gz|bz2|xz)$/i.test(fileName)) {
    return 4;
  }
  if (/\.\d{3}$/i.test(fileName)) {
    return 5;
  }
  return 9;
}

type ExtractResumeState = {
  completedArchives: string[];
};

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
  const tarCompressed = files.filter((filePath) => /\.tar\.(gz|bz2|xz)$/i.test(filePath));
  // Generic .001 splits (HJSplit etc.) — exclude already-recognized .zip.001 and .7z.001
  const genericSplit = files.filter((filePath) => {
    const fileName = path.basename(filePath).toLowerCase();
    if (!/\.001$/.test(fileName)) return false;
    if (/\.zip\.001$/.test(fileName) || /\.7z\.001$/.test(fileName)) return false;
    return true;
  });

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...multipartRar, ...singleRar, ...zipSplit, ...zip, ...sevenSplit, ...seven, ...tarCompressed, ...genericSplit]) {
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
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
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
    const tmpPath = progressPath + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.promises.rename(tmpPath, progressPath);
  } catch (error) {
    logger.warn(`ExtractResumeState schreiben fehlgeschlagen: ${String(error)}`);
  }
}

async function clearExtractResumeState(packageDir: string, packageId?: string): Promise<void> {
  try {
    await fs.promises.rm(extractProgressFilePath(packageDir, packageId), { force: true });
  } catch {
    // ignore
  }
}

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

export function classifyExtractionError(errorText: string): ExtractErrorCategory {
  const text = String(errorText || "").toLowerCase();
  if (text.includes("aborted:extract") || text.includes("extract_aborted")) return "aborted";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("wrong password") || text.includes("falsches passwort") || text.includes("incorrect password")) return "wrong_password";
  if (text.includes("crc failed") || text.includes("checksum error") || text.includes("crc error")) return "crc_error";
  if (text.includes("missing volume") || text.includes("next volume") || text.includes("unexpected end of archive") || text.includes("missing parts")) return "missing_parts";
  if (text.includes("nicht gefunden") || text.includes("not found") || text.includes("no extractor")) return "no_extractor";
  if (text.includes("kein rar-archiv") || text.includes("not a rar archive") || text.includes("unsupported") || text.includes("unsupportedmethod")) return "unsupported_format";
  if (text.includes("disk full") || text.includes("speicherplatz") || text.includes("no space left") || text.includes("not enough space")) return "disk_full";
  return "unknown";
}

function isExtractAbortError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("aborted:extract") || text.includes("extract_aborted");
}

export function archiveFilenamePasswords(archiveName: string): string[] {
  const name = String(archiveName || "");
  if (!name) return [];
  const stem = name
    .replace(/\.part\d+\.rar$/i, "")
    .replace(/\.zip\.\d{3}$/i, "")
    .replace(/\.7z\.\d{3}$/i, "")
    .replace(/\.\d{3}$/i, "")
    .replace(/\.tar\.(gz|bz2|xz)$/i, "")
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
    path.join(programFilesX86, "WinRAR", "UnRAR.exe"),
    path.join(programFilesX86, "WinRAR", "UnRAR.exe")
  ];

  if (localAppData) {
    installed.push(path.join(localAppData, "Programs", "WinRAR", "UnRAR.exe"));
  }

  const ordered = resolvedExtractorCommand
    ? [resolvedExtractorCommand, ...installed, "UnRAR.exe", "unrar"]
    : [...installed, "UnRAR.exe", "unrar"];
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

function shouldUseExtractorPerformanceFlags(): boolean {
  const raw = String(process.env.RD_EXTRACT_PERF_FLAGS || "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function extractCpuBudgetPercent(): number {
  const envValue = Number(process.env.RD_EXTRACT_CPU_BUDGET_PERCENT ?? NaN);
  if (Number.isFinite(envValue) && envValue >= 40 && envValue <= 95) {
    return Math.floor(envValue);
  }
  return DEFAULT_EXTRACT_CPU_BUDGET_PERCENT;
}

function extractorThreadSwitch(hybridMode = false): string {
  if (hybridMode) {
    // 2 threads during hybrid extraction (download + extract simultaneously).
    // JDownloader 2 uses in-process 7-Zip-JBinding which naturally limits throughput
    // to ~16 MB/s write. 2 UnRAR threads produce similar controlled disk load.
    return "-mt2";
  }
  const envValue = Number(process.env.RD_EXTRACT_THREADS ?? NaN);
  if (Number.isFinite(envValue) && envValue >= 1 && envValue <= 32) {
    return `-mt${Math.floor(envValue)}`;
  }
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const budgetPercent = extractCpuBudgetPercent();
  const budgetedThreads = Math.floor((cpuCount * budgetPercent) / 100);
  const threadCount = Math.max(1, Math.min(16, Math.max(1, budgetedThreads)));
  return `-mt${threadCount}`;
}

function lowerExtractProcessPriority(childPid: number | undefined): void {
  if (process.platform !== "win32") {
    return;
  }
  const pid = Number(childPid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    // IDLE_PRIORITY_CLASS: lowers CPU scheduling priority so extraction
    // doesn't starve other processes. I/O priority stays Normal (like JDownloader 2).
    os.setPriority(pid, os.constants.priority.PRIORITY_LOW);
  } catch {
    // ignore: priority lowering is best-effort
  }
}

type ExtractSpawnResult = {
  ok: boolean;
  missingCommand: boolean;
  aborted: boolean;
  timedOut: boolean;
  errorText: string;
};

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
    lowerExtractProcessPriority(child.pid);
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

function extractorBackendMode(): ExtractBackendMode {
  const defaultMode = process.env.VITEST ? "legacy" : "jvm";
  const raw = String(process.env.RD_EXTRACT_BACKEND || defaultMode).trim().toLowerCase();
  if (raw === "legacy") {
    return "legacy";
  }
  if (raw === "jvm" || raw === "jbind" || raw === "7zjbinding") {
    return "jvm";
  }
  return "auto";
}

function isJvmRuntimeMissingError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("could not find or load main class")
    || text.includes("classnotfoundexception")
    || text.includes("noclassdeffounderror")
    || text.includes("unsatisfiedlinkerror")
    || text.includes("enoent");
}

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

let cachedJvmLayout: JvmExtractorLayout | null | undefined;

function resolveJvmExtractorLayout(): JvmExtractorLayout | null {
  if (cachedJvmLayout !== undefined) {
    return cachedJvmLayout;
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
    if (parsed !== null && parsed > state.bestPercent) {
      state.bestPercent = parsed;
      onArchiveProgress?.(parsed);
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

function runJvmExtractCommand(
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
      ok: false,
      missingCommand: false,
      missingRuntime: false,
      aborted: true,
      timedOut: false,
      errorText: "aborted:extract",
      usedPassword: "",
      backend: ""
    });
  }

  const mode = effectiveConflictMode(conflictMode);
  // Each JVM process needs its own temp dir so parallel SevenZipJBinding
  // instances don't fight over the same native DLL file lock.
  const jvmTmpDir = path.join(os.tmpdir(), `rd-extract-${crypto.randomUUID()}`);
  fs.mkdirSync(jvmTmpDir, { recursive: true });
  const args = [
    "-Dfile.encoding=UTF-8",
    `-Djava.io.tmpdir=${jvmTmpDir}`,
    "-Xms32m",
    "-Xmx512m",
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
    lowerExtractProcessPriority(child.pid);

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
          ok: false,
          missingCommand: false,
          missingRuntime: false,
          aborted: false,
          timedOut: true,
          errorText: `Entpacken Timeout nach ${Math.ceil(timeoutMs / 1000)}s`,
          usedPassword: parseState.usedPassword,
          backend: parseState.backend
        });
      }, timeoutMs);
    }

    onAbort = signal
      ? (): void => {
        abortedBySignal = true;
        killProcessTree(child);
        finish({
          ok: false,
          missingCommand: false,
          missingRuntime: false,
          aborted: true,
          timedOut: false,
          errorText: "aborted:extract",
          usedPassword: parseState.usedPassword,
          backend: parseState.backend
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
        ok: false,
        missingCommand: text.toLowerCase().includes("enoent"),
        missingRuntime: true,
        aborted: false,
        timedOut: false,
        errorText: text,
        usedPassword: parseState.usedPassword,
        backend: parseState.backend
      });
    });

    child.on("close", (code) => {
      parseJvmLine(stdoutBuffer, onArchiveProgress, parseState);
      parseJvmLine(stderrBuffer, onArchiveProgress, parseState);

      if (abortedBySignal) {
        finish({
          ok: false,
          missingCommand: false,
          missingRuntime: false,
          aborted: true,
          timedOut: false,
          errorText: "aborted:extract",
          usedPassword: parseState.usedPassword,
          backend: parseState.backend
        });
        return;
      }
      if (timedOutByWatchdog) {
        finish({
          ok: false,
          missingCommand: false,
          missingRuntime: false,
          aborted: false,
          timedOut: true,
          errorText: `Entpacken Timeout nach ${Math.ceil((timeoutMs || 0) / 1000)}s`,
          usedPassword: parseState.usedPassword,
          backend: parseState.backend
        });
        return;
      }

      const message = cleanErrorText(parseState.reportedError || output) || `Exit Code ${String(code ?? "?")}`;
      if (code === 0) {
        onArchiveProgress?.(100);
        finish({
          ok: true,
          missingCommand: false,
          missingRuntime: false,
          aborted: false,
          timedOut: false,
          errorText: "",
          usedPassword: parseState.usedPassword,
          backend: parseState.backend
        });
        return;
      }

      finish({
        ok: false,
        missingCommand: false,
        missingRuntime: isJvmRuntimeMissingError(message),
        aborted: false,
        timedOut: false,
        errorText: message,
        usedPassword: parseState.usedPassword,
        backend: parseState.backend
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
  usePerformanceFlags = true,
  hybridMode = false
): string[] {
  const mode = effectiveConflictMode(conflictMode);
  const lower = command.toLowerCase();
  if (lower.includes("unrar") || lower.includes("winrar")) {
    const overwrite = mode === "overwrite" ? "-o+" : mode === "rename" ? "-or" : "-o-";
    // NOTE: The password is passed as a CLI argument (-p<password>), which means it may be
    // visible via process listing tools (e.g. `ps aux` on Unix). This is unavoidable because
    // WinRAR/UnRAR CLI does not support password input via stdin or environment variables.
    // On Windows (the target platform) this is less of a concern than on shared Unix systems.
    const pass = password ? `-p${password}` : "-p-";
    const perfArgs = usePerformanceFlags && shouldUseExtractorPerformanceFlags()
      ? ["-idc", extractorThreadSwitch(hybridMode)]
      : [];
    return ["x", overwrite, pass, "-y", ...perfArgs, archivePath, `${targetDir}${path.sep}`];
  }

  const overwrite = mode === "overwrite" ? "-aoa" : mode === "rename" ? "-aou" : "-aos";
  // NOTE: Same password-in-args limitation as above applies to 7z as well.
  const pass = password ? `-p${password}` : "-p";
  return ["x", "-y", overwrite, pass, archivePath, `-o${targetDir}`];
}

async function resolveExtractorCommandInternal(): Promise<string> {
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

  const candidates = winRarCandidates();
  for (const command of candidates) {
    if (isAbsoluteCommand(command) && !fs.existsSync(command)) {
      continue;
    }
    const probeArgs = command.toLowerCase().includes("winrar") ? ["-?"] : ["?"];
    const probe = await runExtractCommand(command, probeArgs, undefined, undefined, EXTRACTOR_PROBE_TIMEOUT_MS);
    if (probe.ok) {
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

async function resolveExtractorCommand(): Promise<string> {
  if (resolvedExtractorCommand) {
    return resolvedExtractorCommand;
  }
  if (resolveExtractorCommandInFlight) {
    return resolveExtractorCommandInFlight;
  }

  const pending = resolveExtractorCommandInternal();
  resolveExtractorCommandInFlight = pending;
  try {
    return await pending;
  } finally {
    if (resolveExtractorCommandInFlight === pending) {
      resolveExtractorCommandInFlight = null;
    }
  }
}

async function runExternalExtract(
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[],
  onArchiveProgress?: (percent: number) => void,
  signal?: AbortSignal,
  hybridMode = false
): Promise<string> {
  const timeoutMs = await computeExtractTimeoutMs(archivePath);
  const backendMode = extractorBackendMode();
  let jvmFailureReason = "";

  await fs.promises.mkdir(targetDir, { recursive: true });

  // On Windows, long targetDir + archive internal paths can exceed MAX_PATH (260 chars).
  // Use "subst" to map the targetDir to a short drive letter for the legacy extraction process.
  // JVM does NOT use subst — Java handles long paths natively and subst causes
  // false-positive path traversal errors in secureResolve (getCanonicalFile inconsistency).
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
        const maskedPasswords = passwordCandidates.map((p) => p === "" ? '""' : `"${p.slice(0, 2)}${"*".repeat(Math.max(0, p.length - 2))}"`);
        logger.info(`JVM-Extractor aktiv (${layout.rootDir}): ${path.basename(archivePath)}, ${passwordCandidates.length} Passwörter: [${maskedPasswords.join(", ")}]`);
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

        if (jvmResult.ok) {
          logger.info(`Entpackt via ${jvmResult.backend || "jvm"}: ${path.basename(archivePath)}`);
          return jvmResult.usedPassword;
        }
        if (jvmResult.aborted) {
          throw new Error("aborted:extract");
        }
        if (jvmResult.timedOut) {
          throw new Error(jvmResult.errorText || `Entpacken Timeout nach ${Math.ceil(timeoutMs / 1000)}s`);
        }

        jvmFailureReason = jvmResult.errorText || "JVM-Extractor fehlgeschlagen";
        const jvmFailureLower = jvmFailureReason.toLowerCase();
        const isUnsupportedMethod = jvmFailureReason.includes("UNSUPPORTEDMETHOD");
        const isCodecError = jvmFailureLower.includes("registered codecs")
          || jvmFailureLower.includes("can not open")
          || jvmFailureLower.includes("cannot open archive");
        const isWrongPassword = jvmFailureReason.includes("WRONG_PASSWORD")
          || jvmFailureLower.includes("wrong password");
        const shouldFallbackToLegacy = isUnsupportedMethod || isCodecError || isWrongPassword;
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

    // subst only needed for legacy UnRAR/7z (MAX_PATH limit)
    subst = createSubstMapping(targetDir);
    const effectiveTargetDir = subst ? `${subst.drive}:` : targetDir;

    const command = await resolveExtractorCommand();
    const password = await runExternalExtractInner(
      command,
      archivePath,
      effectiveTargetDir,
      conflictMode,
      passwordCandidates,
      onArchiveProgress,
      signal,
      timeoutMs,
      hybridMode
    );
    const extractorName = path.basename(command).replace(/\.exe$/i, "");
    if (jvmFailureReason) {
      logger.info(`Entpackt via legacy/${extractorName} (nach JVM-Fehler): ${path.basename(archivePath)}`);
    } else {
      logger.info(`Entpackt via legacy/${extractorName}: ${path.basename(archivePath)}`);
    }
    return password;
  } finally {
    if (subst) removeSubstMapping(subst);
  }
}

async function runExternalExtractInner(
  command: string,
  archivePath: string,
  targetDir: string,
  conflictMode: ConflictMode,
  passwordCandidates: string[],
  onArchiveProgress: ((percent: number) => void) | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  hybridMode = false
): Promise<string> {
  const passwords = passwordCandidates;
  let lastError = "";

  const maskedPasswords = passwords.map((p) => p === "" ? '""' : `"${p.slice(0, 2)}${"*".repeat(Math.max(0, p.length - 2))}"`);
  logger.info(`Legacy-Extractor: ${path.basename(archivePath)}, ${passwords.length} Passwörter: [${maskedPasswords.join(", ")}]`);

  let announcedStart = false;
  let bestPercent = 0;
  let passwordAttempt = 0;
  let usePerformanceFlags = externalExtractorSupportsPerfFlags && shouldUseExtractorPerformanceFlags();

  for (const password of passwords) {
    if (signal?.aborted) {
      throw new Error("aborted:extract");
    }
    if (!announcedStart) {
      announcedStart = true;
      onArchiveProgress?.(0);
    }
    passwordAttempt += 1;
    const maskedPw = password === "" ? '""' : `"${password.slice(0, 2)}${"*".repeat(Math.max(0, password.length - 2))}"`;
    logger.info(`Legacy-Passwort-Versuch ${passwordAttempt}/${passwords.length} für ${path.basename(archivePath)}: ${maskedPw}`);
    let args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, usePerformanceFlags, hybridMode);
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
      args = buildExternalExtractArgs(command, archivePath, targetDir, conflictMode, password, false, hybridMode);
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
      resolveFailureAt = Date.now();
      throw new Error(NO_EXTRACTOR_MESSAGE);
    }

    lastError = result.errorText;
  }

  throw new Error(lastError || "Entpacken fehlgeschlagen");
}

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
    if (data.length > Math.max(uncompressedSize, compressedSize) * 20) {
      throw new Error(`ZIP-Eintrag verdächtig groß nach Entpacken (${entry.entryName})`);
    }
    await fs.promises.writeFile(outputPath, data);
    usedOutputs.add(outputKey);
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

  // Generic .NNN split files (HJSplit etc.)
  const genericSplit = fileName.match(/^(.*)\.(\d{3})$/i);
  if (genericSplit) {
    const stem = escapeRegex(genericSplit[1]);
    addMatching(new RegExp(`^${stem}\\.\\d{3}$`, "i"));
    return Array.from(targets);
  }

  return Array.from(targets);
}

async function cleanupArchives(sourceFiles: string[], cleanupMode: CleanupMode): Promise<number> {
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

async function hasAnyFilesRecursive(rootDir: string): Promise<boolean> {
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

async function removeEmptyDirectoryTree(rootDir: string): Promise<number> {
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

export async function extractPackageArchives(options: ExtractOptions): Promise<{ extracted: number; failed: number; lastError: string }> {
  if (options.signal?.aborted) {
    throw new Error("aborted:extract");
  }

  const allCandidates = await findArchiveCandidates(options.packageDir);
  const candidates = options.onlyArchives
    ? allCandidates.filter((archivePath) => {
      const key = process.platform === "win32" ? path.resolve(archivePath).toLowerCase() : path.resolve(archivePath);
      return options.onlyArchives!.has(key);
    })
    : allCandidates;
  logger.info(`Entpacken gestartet: packageDir=${options.packageDir}, targetDir=${options.targetDir}, archives=${candidates.length}${options.onlyArchives ? ` (hybrid, gesamt=${allCandidates.length})` : ""}, cleanupMode=${options.cleanupMode}, conflictMode=${options.conflictMode}`);

  // Disk space pre-check
  if (candidates.length > 0) {
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
  let passwordCandidates = archivePasswords(options.passwordList || "");
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
  const extractedArchives = new Set<string>();
  for (const archivePath of candidates) {
    if (resumeCompleted.has(archiveNameKey(path.basename(archivePath)))) {
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
    try {
      options.onProgress({
        current,
        total,
        percent,
        archiveName,
        archivePercent,
        elapsedMs,
        phase
      });
    } catch (error) {
      logger.warn(`onProgress callback Fehler unterdrückt: ${cleanErrorText(String(error))}`);
    }
  };

  emitProgress(extracted, "", "extracting");

  const maxParallel = Math.max(1, options.maxParallel || 1);
  let noExtractorEncountered = false;

  const extractSingleArchive = async (archivePath: string): Promise<void> => {
    if (options.signal?.aborted || noExtractorEncountered) {
      throw new Error("aborted:extract");
    }
    const archiveName = path.basename(archivePath);
    const archiveResumeKey = archiveNameKey(archiveName);
    const archiveStartedAt = Date.now();
    let archivePercent = 0;
    emitProgress(extracted + failed, archiveName, "extracting", archivePercent, 0);
    const pulseTimer = setInterval(() => {
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
    }, 1100);
    const hybrid = Boolean(options.hybridMode);
    // Insert archive-filename-derived passwords after "" but before custom passwords
    const filenamePasswords = archiveFilenamePasswords(archiveName);
    const archivePasswordCandidates = filenamePasswords.length > 0
      ? Array.from(new Set(["", ...filenamePasswords, ...passwordCandidates.filter((p) => p !== "")]))
      : passwordCandidates;

    // Validate generic .001 splits via file signature before attempting extraction
    const isGenericSplit = /\.\d{3}$/i.test(archiveName) && !/\.(zip|7z)\.\d{3}$/i.test(archiveName);
    if (isGenericSplit) {
      const sig = await detectArchiveSignature(archivePath);
      if (!sig) {
        logger.info(`Generische Split-Datei übersprungen (keine Archiv-Signatur): ${archiveName}`);
        clearInterval(pulseTimer);
        return;
      }
      logger.info(`Generische Split-Datei verifiziert (Signatur: ${sig}): ${archiveName}`);
    }

    logger.info(`Entpacke Archiv: ${path.basename(archivePath)} -> ${options.targetDir}${hybrid ? " (hybrid, reduced threads, low I/O)" : ""}`);
    try {
      const ext = path.extname(archivePath).toLowerCase();
      if (ext === ".zip") {
        const preferExternal = await shouldPreferExternalZip(archivePath);
        if (preferExternal) {
          try {
            const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, archivePasswordCandidates, (value) => {
              archivePercent = Math.max(archivePercent, value);
              emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
            }, options.signal, hybrid);
            passwordCandidates = prioritizePassword(passwordCandidates, usedPassword);
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
                archivePercent = Math.max(archivePercent, value);
                emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
              }, options.signal, hybrid);
              passwordCandidates = prioritizePassword(passwordCandidates, usedPassword);
            } catch (externalError) {
              if (isNoExtractorError(String(externalError)) || isUnsupportedArchiveFormatError(String(externalError))) {
                throw error;
              }
              throw externalError;
            }
          }
        }
      } else {
        const usedPassword = await runExternalExtract(archivePath, options.targetDir, options.conflictMode, archivePasswordCandidates, (value) => {
          archivePercent = Math.max(archivePercent, value);
          emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
        }, options.signal, hybrid);
        passwordCandidates = prioritizePassword(passwordCandidates, usedPassword);
      }
      extracted += 1;
      extractedArchives.add(archivePath);
      resumeCompleted.add(archiveResumeKey);
      await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
      logger.info(`Entpacken erfolgreich: ${path.basename(archivePath)}`);
      archivePercent = 100;
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
    } catch (error) {
      failed += 1;
      const errorText = String(error);
      if (isExtractAbortError(errorText)) {
        throw error;
      }
      lastError = errorText;
      const errorCategory = classifyExtractionError(errorText);
      logger.error(`Entpack-Fehler ${path.basename(archivePath)} [${errorCategory}]: ${errorText}`);
      emitProgress(extracted + failed, archiveName, "extracting", archivePercent, Date.now() - archiveStartedAt);
      if (isNoExtractorError(errorText)) {
        noExtractorEncountered = true;
      }
    } finally {
      clearInterval(pulseTimer);
    }
  };

  if (maxParallel <= 1) {
    for (const archivePath of pendingCandidates) {
      if (options.signal?.aborted || noExtractorEncountered) break;
      await extractSingleArchive(archivePath);
    }
  } else {
    // Parallel extraction pool: N workers pull from a shared queue
    const queue = [...pendingCandidates];
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
          if (isExtractAbortError(String(error))) {
            abortError = error instanceof Error ? error : new Error(String(error));
            break;
          }
          // Non-abort errors are already handled inside extractSingleArchive
        }
      }
    };

    const workerCount = Math.min(maxParallel, pendingCandidates.length);
    logger.info(`Parallele Extraktion: ${workerCount} gleichzeitige Worker für ${pendingCandidates.length} Archive`);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (abortError) throw new Error("aborted:extract");
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
          const nestedKey = archiveNameKey(nestedName);
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
                const usedPw = await runExternalExtract(nestedArchive, options.targetDir, options.conflictMode, passwordCandidates, (v) => { nestedPercent = Math.max(nestedPercent, v); }, options.signal, hybrid);
                passwordCandidates = prioritizePassword(passwordCandidates, usedPw);
              }
            } else {
              const usedPw = await runExternalExtract(nestedArchive, options.targetDir, options.conflictMode, passwordCandidates, (v) => { nestedPercent = Math.max(nestedPercent, v); }, options.signal, hybrid);
              passwordCandidates = prioritizePassword(passwordCandidates, usedPw);
            }
            extracted += 1;
            nestedExtracted += 1;
            extractedArchives.add(nestedArchive);
            resumeCompleted.add(nestedKey);
            await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
            logger.info(`Nested-Entpacken erfolgreich: ${nestedName}`);
            if (options.cleanupMode === "delete") {
              for (const part of collectArchiveCleanupTargets(nestedArchive)) {
                try { await fs.promises.unlink(part); } catch { /* ignore */ }
              }
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
    const hasOutputAfter = await hasAnyEntries(options.targetDir);
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
