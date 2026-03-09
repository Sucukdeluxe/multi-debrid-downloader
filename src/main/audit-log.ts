import fs from "node:fs";
import path from "node:path";

type AuditLevel = "INFO" | "WARN" | "ERROR";

const AUDIT_LOG_MAX_FILE_BYTES = Number(process.env.RD_AUDIT_LOG_MAX_BYTES || 10 * 1024 * 1024);
const AUDIT_LOG_RETENTION_DAYS = Number(process.env.RD_AUDIT_LOG_RETENTION_DAYS || 30);

let auditLogPath: string | null = null;

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
    if (stat.size < AUDIT_LOG_MAX_FILE_BYTES) {
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
    const cutoff = Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(backup, { force: true });
    }
  } catch {
    // ignore
  }
}

export function initAuditLog(baseDir: string): void {
  auditLogPath = path.join(baseDir, "audit.log");
  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    cleanupOldBackup(auditLogPath);
    if (!fs.existsSync(auditLogPath)) {
      fs.writeFileSync(auditLogPath, "", "utf8");
    }
    rotateIfNeeded(auditLogPath);
    if (!fs.existsSync(auditLogPath)) {
      fs.writeFileSync(auditLogPath, "", "utf8");
    }
    fs.appendFileSync(auditLogPath, `=== Audit-Log Start: ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    auditLogPath = null;
  }
}

export function logAuditEvent(level: AuditLevel, message: string, fields?: Record<string, unknown>): void {
  if (!auditLogPath) {
    return;
  }
  try {
    rotateIfNeeded(auditLogPath);
    if (!fs.existsSync(auditLogPath)) {
      fs.writeFileSync(auditLogPath, "", "utf8");
    }
    fs.appendFileSync(
      auditLogPath,
      `${new Date().toISOString()} [${level}] ${message}${formatFields(fields)}\n`,
      "utf8"
    );
  } catch {
    // ignore write errors
  }
}

export function getAuditLogPath(): string | null {
  if (!auditLogPath) {
    return null;
  }
  return fs.existsSync(auditLogPath) ? auditLogPath : null;
}

export function shutdownAuditLog(): void {
  if (!auditLogPath) {
    return;
  }
  try {
    fs.appendFileSync(auditLogPath, `=== Audit-Log Ende: ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    // ignore
  }
  auditLogPath = null;
}
