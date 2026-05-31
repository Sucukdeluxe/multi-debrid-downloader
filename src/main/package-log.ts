import fs from "node:fs";
import { logTimestamp } from "./log-timestamp";
import path from "node:path";
import crypto from "node:crypto";

const PACKAGE_LOG_FLUSH_INTERVAL_MS = 200;
const PACKAGE_LOG_RETENTION_DAYS = 30;

type PackageLogLevel = "INFO" | "WARN" | "ERROR";

export interface PackageLogMeta {
  packageId: string;
  name: string;
  outputDir: string;
  extractDir: string;
}

let packageLogsDir: string | null = null;
const knownLogPaths = new Map<string, string>();
const pendingLinesByPackage = new Map<string, string[]>();
const initializedThisProcess = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

function normalizePackageId(packageId: string): string {
  const trimmed = String(packageId || "").trim();
  if (!trimmed) {
    return "";
  }
  const safePrefix = trimmed
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64)
    .replace(/^_+|_+$/g, "");
  const hash = crypto.createHash("sha1").update(trimmed).digest("hex").slice(0, 12);
  return `${safePrefix || "pkg"}_${hash}`;
}

function sanitizeFieldValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.replace(/\r?\n/g, "\\n");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value).replace(/\r?\n/g, "\\n");
  } catch {
    return String(value);
  }
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) {
    return "";
  }
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && sanitizeFieldValue(value) !== "")
    .map(([key, value]) => `${key}=${sanitizeFieldValue(value)}`);
  return parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
}

function getPackageLogFilePathFromNormalized(normalized: string): string | null {
  if (!normalized || !packageLogsDir) {
    return null;
  }
  const existing = knownLogPaths.get(normalized);
  if (existing) {
    return existing;
  }
  const logPath = path.join(packageLogsDir, `package_${normalized}.txt`);
  knownLogPaths.set(normalized, logPath);
  return logPath;
}

function getPackageLogFilePath(packageId: string): string | null {
  return getPackageLogFilePathFromNormalized(normalizePackageId(packageId));
}

function flushPending(): void {
  for (const [packageId, lines] of pendingLinesByPackage.entries()) {
    if (lines.length === 0) {
      continue;
    }
    const logPath = getPackageLogFilePathFromNormalized(packageId);
    if (!logPath) {
      continue;
    }
    const chunk = lines.join("");
    pendingLinesByPackage.set(packageId, []);
    try {
      fs.appendFileSync(logPath, chunk, "utf8");
    } catch {
      // ignore write errors
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, PACKAGE_LOG_FLUSH_INTERVAL_MS);
}

async function cleanupOldPackageLogs(dir: string): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir);
    const cutoff = Date.now() - PACKAGE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("package_") || !file.endsWith(".txt")) {
        continue;
      }
      const filePath = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
        }
      } catch {
        // ignore locked/missing files
      }
    }
  } catch {
    // ignore missing dir
  }
}

function appendLine(packageId: string, line: string): void {
  const normalized = normalizePackageId(packageId);
  if (!normalized) {
    return;
  }
  const lines = pendingLinesByPackage.get(normalized) || [];
  lines.push(line);
  pendingLinesByPackage.set(normalized, lines);
  scheduleFlush();
}

export function initPackageLogs(baseDir: string): void {
  packageLogsDir = path.join(baseDir, "package-logs");
  try {
    fs.mkdirSync(packageLogsDir, { recursive: true });
  } catch {
    packageLogsDir = null;
    return;
  }
  void cleanupOldPackageLogs(packageLogsDir);
}

export function ensurePackageLog(meta: PackageLogMeta): string | null {
  const normalizedPackageId = normalizePackageId(meta.packageId);
  const logPath = getPackageLogFilePath(meta.packageId);
  if (!logPath) {
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, "", "utf8");
    }
    if (!initializedThisProcess.has(normalizedPackageId)) {
      initializedThisProcess.add(normalizedPackageId);
      const startedAt = logTimestamp();
      fs.appendFileSync(
        logPath,
        `=== Paket-Log Start: ${startedAt} | packageId=${sanitizeFieldValue(String(meta.packageId || ""))} | logKey=${normalizedPackageId} | name=${sanitizeFieldValue(meta.name)} ===\n`,
        "utf8"
      );
      fs.appendFileSync(
        logPath,
        `${logTimestamp()} [INFO] Paket-Kontext initialisiert${formatFields({
          name: meta.name,
          outputDir: meta.outputDir,
          extractDir: meta.extractDir
        })}\n`,
        "utf8"
      );
    }
  } catch {
    return null;
  }
  return logPath;
}

export function logPackageEvent(
  packageId: string,
  level: PackageLogLevel,
  message: string,
  fields?: Record<string, unknown>
): void {
  const logPath = getPackageLogFilePath(packageId);
  if (!logPath) {
    return;
  }
  const line = `${logTimestamp()} [${level}] ${message}${formatFields(fields)}\n`;
  appendLine(packageId, line);
}

export function getPackageLogPath(packageId: string): string | null {
  const logPath = getPackageLogFilePath(packageId);
  if (!logPath) {
    return null;
  }
  return fs.existsSync(logPath) ? logPath : null;
}

export function shutdownPackageLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushPending();
  for (const packageId of knownLogPaths.keys()) {
    const logPath = getPackageLogFilePathFromNormalized(packageId);
    if (!logPath) {
      continue;
    }
    try {
      fs.appendFileSync(logPath, `=== Paket-Log Ende: ${logTimestamp()} ===\n`, "utf8");
    } catch {
      // ignore
    }
  }
  pendingLinesByPackage.clear();
  knownLogPaths.clear();
  initializedThisProcess.clear();
  packageLogsDir = null;
}
