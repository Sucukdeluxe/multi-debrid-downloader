import fs from "node:fs";
import path from "node:path";

/** Dedicated log file for multi-account/key rotation events:
 *  Mega-Debrid account selection, Debrid-Link key selection, per-attempt
 *  test result, cooldown set, fallback to next account/key, etc.
 *  Separate from rd_downloader.log so the user can see the rotation flow
 *  without the noise of normal download activity. */

type RotationLevel = "INFO" | "WARN" | "ERROR";

const ROTATION_LOG_MAX_FILE_BYTES = Number(process.env.RD_ACCOUNT_ROTATION_LOG_MAX_BYTES || 5 * 1024 * 1024);
const ROTATION_LOG_RETENTION_DAYS = Number(process.env.RD_ACCOUNT_ROTATION_LOG_RETENTION_DAYS || 14);

let rotationLogPath: string | null = null;

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
    if (stat.size < ROTATION_LOG_MAX_FILE_BYTES) {
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
    const cutoff = Date.now() - ROTATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(backup, { force: true });
    }
  } catch {
    // ignore
  }
}

export function initAccountRotationLog(baseDir: string): void {
  rotationLogPath = path.join(baseDir, "account-rotation.log");
  try {
    fs.mkdirSync(path.dirname(rotationLogPath), { recursive: true });
    cleanupOldBackup(rotationLogPath);
    if (!fs.existsSync(rotationLogPath)) {
      fs.writeFileSync(rotationLogPath, "", "utf8");
    }
    rotateIfNeeded(rotationLogPath);
    if (!fs.existsSync(rotationLogPath)) {
      fs.writeFileSync(rotationLogPath, "", "utf8");
    }
    fs.appendFileSync(
      rotationLogPath,
      `=== Account-Rotation Log Start: ${new Date().toISOString()} ===\n`,
      "utf8"
    );
  } catch {
    rotationLogPath = null;
  }
}

/** Record an account/key rotation event. The format is intentionally compact
 *  and grep-friendly: timestamp + level + provider + accountLabel + event + fields.
 *  Example output:
 *    2026-04-19T20:48:50.000Z [INFO] Mega-Debrid Web | Account 2 (fa**david@...) | TEST | link=https://...
 *    2026-04-19T20:48:52.000Z [WARN] Mega-Debrid Web | Account 2 (fa**david@...) | FAILED reason="Antwort leer" cooldownSec=30 | link=https://...
 *    2026-04-19T20:48:53.000Z [INFO] Mega-Debrid Web | Account 3 (am**@example.com) | TEST | link=https://...
 *    2026-04-19T20:48:55.000Z [INFO] Mega-Debrid Web | Account 3 (am**@example.com) | OK directLink=https://... | link=https://... */
export function logAccountRotation(
  level: RotationLevel,
  provider: string,
  accountLabel: string,
  event: string,
  fields?: Record<string, unknown>
): void {
  if (!rotationLogPath) {
    return;
  }
  try {
    rotateIfNeeded(rotationLogPath);
    if (!fs.existsSync(rotationLogPath)) {
      fs.writeFileSync(rotationLogPath, "", "utf8");
    }
    const head = `${new Date().toISOString()} [${level}] ${provider} | ${accountLabel} | ${event}`;
    fs.appendFileSync(rotationLogPath, `${head}${formatFields(fields)}\n`, "utf8");
  } catch {
    // ignore write errors
  }
}

export function getAccountRotationLogPath(): string | null {
  if (!rotationLogPath) {
    return null;
  }
  return fs.existsSync(rotationLogPath) ? rotationLogPath : null;
}

export function shutdownAccountRotationLog(): void {
  if (!rotationLogPath) {
    return;
  }
  try {
    fs.appendFileSync(
      rotationLogPath,
      `=== Account-Rotation Log Ende: ${new Date().toISOString()} ===\n`,
      "utf8"
    );
  } catch {
    // ignore
  }
  rotationLogPath = null;
}
