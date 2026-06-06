import fs from "node:fs";
import path from "node:path";
import { logTimestamp } from "./log-timestamp";

type DesktopRenameLevel = "INFO" | "WARN" | "ERROR";

const FOLDER_NAME = "Downloader-Log";

let logDir: string | null = null;
let logFilePath: string | null = null;
let sessionHeader = "";

function fileTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
    + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
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

function ensureWritable(): boolean {
  if (!logDir || !logFilePath) {
    return false;
  }
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (!fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, sessionHeader, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

export function initDesktopRenameLog(desktopDir: string | null | undefined): void {
  try {
    const base = String(desktopDir || "").trim();
    if (!base) {
      logDir = null;
      logFilePath = null;
      return;
    }
    logDir = path.join(base, FOLDER_NAME);
    logFilePath = path.join(logDir, `rename-session_${fileTimestamp()}.txt`);
    sessionHeader = `=== Rename-Session gestartet: ${logTimestamp()} ===\n`
      + "Diese Datei protokolliert JEDEN Umbenenn-/Verschiebevorgang dieser Programm-Sitzung\n"
      + "und verifiziert nach jedem Vorgang, ob die Datei wirklich unter dem Zielnamen auf der\n"
      + "Platte liegt (und die Quelle verschwunden ist). [INFO]=ok, [ERROR]=Verifikation gescheitert.\n\n";
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFilePath, sessionHeader, "utf8");
  } catch {
    logDir = null;
    logFilePath = null;
  }
}

export function logDesktopRename(level: DesktopRenameLevel, message: string, fields?: Record<string, unknown>): void {
  if (!ensureWritable() || !logFilePath) {
    return;
  }
  try {
    fs.appendFileSync(logFilePath, `${logTimestamp()} [${level}] ${message}${formatFields(fields)}\n`, "utf8");
  } catch {
  }
}

export function getDesktopRenameLogPath(): string | null {
  if (!logFilePath) {
    return null;
  }
  try {
    return fs.existsSync(logFilePath) ? logFilePath : null;
  } catch {
    return null;
  }
}

export function shutdownDesktopRenameLog(): void {
  if (ensureWritable() && logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `=== Rename-Session beendet: ${logTimestamp()} ===\n`, "utf8");
    } catch {
    }
  }
  logDir = null;
  logFilePath = null;
}

export interface RenameVerification {
  ok: boolean;
  level: "INFO" | "WARN" | "ERROR";
  targetExists: boolean;
  onDiskName: string | null;
  nameMatches: boolean;
  sourceGone: boolean;
  targetSize: number | null;
  reason: string;
}

function toLongPath(filePath: string): string {
  const absolute = path.resolve(String(filePath || ""));
  if (process.platform !== "win32") {
    return absolute;
  }
  if (!absolute || absolute.startsWith("\\\\?\\")) {
    return absolute;
  }
  if (absolute.length < 248) {
    return absolute;
  }
  if (absolute.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${absolute.slice(2)}`;
  }
  return `\\\\?\\${absolute}`;
}

function resolveOnDiskName(requested: string, entries: string[] | null): string | null {
  if (entries === null) {
    return null;
  }
  const requestedLower = requested.toLowerCase();
  return entries.find((entry) => entry === requested)
    || entries.find((entry) => entry.toLowerCase() === requestedLower)
    || requested;
}

function buildVerification(
  sourcePath: string,
  targetPath: string,
  facts: { targetExists: boolean; targetSize: number | null; dirEntries: string[] | null; sourceExists: boolean }
): RenameVerification {
  const requested = path.basename(targetPath);
  const dirReadFailed = facts.targetExists && facts.dirEntries === null;
  const onDiskName = facts.targetExists ? resolveOnDiskName(requested, facts.dirEntries) : null;

  const samePath = path.resolve(sourcePath).toLowerCase() === path.resolve(targetPath).toLowerCase();
  const sourceGone = samePath ? true : !facts.sourceExists;
  const nameMatches = facts.targetExists && !dirReadFailed && onDiskName === requested;

  const problems: string[] = [];
  let level: "INFO" | "WARN" | "ERROR" = "INFO";
  if (!facts.targetExists) {
    problems.push("Zieldatei nach Rename NICHT gefunden");
    level = "ERROR";
  } else if (!dirReadFailed && !nameMatches) {
    problems.push(`On-Disk-Name weicht ab (ist "${onDiskName}", erwartet "${requested}")`);
    level = "ERROR";
  }
  if (!samePath && facts.targetExists && !sourceGone) {
    problems.push("Quelldatei existiert noch (moeglicher halb-fertiger Verschiebevorgang)");
    level = "ERROR";
  }
  if (level === "INFO" && dirReadFailed) {
    problems.push("Zielverzeichnis nicht lesbar — Schreibweise nicht verifiziert");
    level = "WARN";
  }

  return {
    ok: level === "INFO",
    level,
    targetExists: facts.targetExists,
    onDiskName,
    nameMatches,
    sourceGone,
    targetSize: facts.targetSize,
    reason: problems.join("; ")
  };
}

export function verifyRename(sourcePath: string, targetPath: string): RenameVerification {
  const longTarget = toLongPath(targetPath);
  let targetExists = false;
  let targetSize: number | null = null;
  try {
    const stat = fs.statSync(longTarget);
    targetExists = true;
    targetSize = stat.size;
  } catch {
    targetExists = false;
  }
  let dirEntries: string[] | null = null;
  if (targetExists) {
    try {
      dirEntries = fs.readdirSync(path.dirname(longTarget));
    } catch {
      dirEntries = null;
    }
  }
  let sourceExists = false;
  try {
    fs.statSync(toLongPath(sourcePath));
    sourceExists = true;
  } catch {
    sourceExists = false;
  }
  return buildVerification(sourcePath, targetPath, { targetExists, targetSize, dirEntries, sourceExists });
}

export async function verifyRenameAsync(sourcePath: string, targetPath: string): Promise<RenameVerification> {
  const longTarget = toLongPath(targetPath);
  let targetExists = false;
  let targetSize: number | null = null;
  try {
    const stat = await fs.promises.stat(longTarget);
    targetExists = true;
    targetSize = stat.size;
  } catch {
    targetExists = false;
  }
  let dirEntries: string[] | null = null;
  if (targetExists) {
    try {
      dirEntries = await fs.promises.readdir(path.dirname(longTarget));
    } catch {
      dirEntries = null;
    }
  }
  let sourceExists = false;
  try {
    await fs.promises.stat(toLongPath(sourcePath));
    sourceExists = true;
  } catch {
    sourceExists = false;
  }
  return buildVerification(sourcePath, targetPath, { targetExists, targetSize, dirEntries, sourceExists });
}
