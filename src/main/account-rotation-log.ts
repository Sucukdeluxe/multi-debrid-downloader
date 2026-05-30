import fs from "node:fs";
import path from "node:path";
import type { RotationEvent } from "../shared/types";

/** Dedicated log file for multi-account/key rotation events:
 *  Mega-Debrid account selection, Debrid-Link key selection, per-attempt
 *  test result, cooldown set, fallback to next account/key, etc.
 *  Separate from rd_downloader.log so the user can see the rotation flow
 *  without the noise of normal download activity. */

type RotationLevel = "INFO" | "WARN" | "ERROR";

/** In-memory ring buffer of the most recent rotation events so the UI can show
 *  a live "which account was tried and why it failed" panel — the same events
 *  written to account-rotation.log, but surfaced to the renderer via snapshot. */
const ROTATION_EVENT_RING_MAX = 60;
const rotationEventRing: RotationEvent[] = [];
let rotationEventSeq = 0;
let rotationEventListener: ((event: RotationEvent) => void) | null = null;

/** Register a callback fired whenever a new rotation event is recorded (used by
 *  the download-manager to push a fresh snapshot to the UI immediately). */
export function setRotationEventListener(listener: ((event: RotationEvent) => void) | null): void {
  rotationEventListener = listener;
}

/** Returns the recent rotation events, newest first. */
export function getRecentRotationEvents(limit = ROTATION_EVENT_RING_MAX): RotationEvent[] {
  const slice = rotationEventRing.slice(-limit);
  slice.reverse();
  return slice;
}

/** Events that are noise for the UI panel (per-attempt TEST markers). The panel
 *  focuses on outcomes: OK / FAILED / FATAL / skips. */
function isUiRelevantRotationEvent(event: string): boolean {
  return event !== "TEST";
}

function pushRotationEvent(
  level: RotationLevel,
  provider: string,
  accountLabel: string,
  event: string,
  fields?: Record<string, unknown>,
  at = Date.now()
): void {
  if (!isUiRelevantRotationEvent(event)) {
    return;
  }
  rotationEventSeq += 1;
  const entry: RotationEvent = {
    id: `rot_${at}_${rotationEventSeq}`,
    at,
    level,
    provider,
    accountLabel,
    event,
    reason: fields && fields.reason != null ? String(fields.reason) : undefined,
    category: fields && fields.category != null ? String(fields.category) : undefined,
    cooldownSec: fields && fields.cooldownSec != null ? Number(fields.cooldownSec) || 0 : undefined,
    next: fields && fields.next != null ? String(fields.next) : undefined
  };
  rotationEventRing.push(entry);
  if (rotationEventRing.length > ROTATION_EVENT_RING_MAX) {
    rotationEventRing.splice(0, rotationEventRing.length - ROTATION_EVENT_RING_MAX);
  }
  if (rotationEventListener) {
    try {
      rotationEventListener(entry);
    } catch {
      // never let a UI push break the rotation flow
    }
  }
}

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
  // Surface to the UI ring buffer regardless of whether the file log is ready.
  pushRotationEvent(level, provider, accountLabel, event, fields);
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
