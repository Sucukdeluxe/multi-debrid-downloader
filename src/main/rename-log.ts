import fs from "node:fs";
import path from "node:path";

type RenameLogLevel = "INFO" | "WARN" | "ERROR";

const RENAME_LOG_MAX_FILE_BYTES = Number(process.env.RD_RENAME_LOG_MAX_BYTES || 10 * 1024 * 1024);
const RENAME_LOG_RETENTION_DAYS = Number(process.env.RD_RENAME_LOG_RETENTION_DAYS || 30);

let renameLogPath: string | null = null;

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

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < RENAME_LOG_MAX_FILE_BYTES) {
      return;
    }
    const backup = `${filePath}.old`;
    try {
      fs.rmSync(backup, { force: true });
    } catch {
      // ignore
    }
    fs.renameSync(filePath, backup);
  } catch {
    // ignore
  }
}

function cleanupOldBackup(filePath: string): void {
  const backup = `${filePath}.old`;
  try {
    const stat = fs.statSync(backup);
    const cutoff = Date.now() - RENAME_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(backup, { force: true });
    }
  } catch {
    // ignore
  }
}

export function initRenameLog(baseDir: string): void {
  renameLogPath = path.join(baseDir, "rename.log");
  try {
    fs.mkdirSync(path.dirname(renameLogPath), { recursive: true });
    cleanupOldBackup(renameLogPath);
    if (!fs.existsSync(renameLogPath)) {
      fs.writeFileSync(renameLogPath, "", "utf8");
    }
    rotateIfNeeded(renameLogPath);
    if (!fs.existsSync(renameLogPath)) {
      fs.writeFileSync(renameLogPath, "", "utf8");
    }
    fs.appendFileSync(renameLogPath, `=== Rename-Log Start: ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    renameLogPath = null;
  }
}

export function logRenameEvent(level: RenameLogLevel, message: string, fields?: Record<string, unknown>): void {
  if (!renameLogPath) {
    return;
  }
  try {
    rotateIfNeeded(renameLogPath);
    if (!fs.existsSync(renameLogPath)) {
      fs.writeFileSync(renameLogPath, "", "utf8");
    }
    fs.appendFileSync(
      renameLogPath,
      `${new Date().toISOString()} [${level}] ${message}${formatFields(fields)}\n`,
      "utf8"
    );
  } catch {
    // ignore write errors
  }
}

export function getRenameLogPath(): string | null {
  if (!renameLogPath) {
    return null;
  }
  return fs.existsSync(renameLogPath) ? renameLogPath : null;
}

export function shutdownRenameLog(): void {
  if (!renameLogPath) {
    return;
  }
  try {
    fs.appendFileSync(renameLogPath, `=== Rename-Log Ende: ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    // ignore
  }
  renameLogPath = null;
}
