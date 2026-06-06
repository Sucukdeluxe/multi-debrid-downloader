import fs from "node:fs";
import { logTimestamp } from "./log-timestamp";
import path from "node:path";
import crypto from "node:crypto";

const ITEM_LOG_FLUSH_INTERVAL_MS = 200;
const ITEM_LOG_RETENTION_DAYS = 30;

type ItemLogLevel = "INFO" | "WARN" | "ERROR";

export interface ItemLogMeta {
  itemId: string;
  packageId: string;
  packageName: string;
  fileName: string;
  targetPath: string;
}

let itemLogsDir: string | null = null;
const knownLogPaths = new Map<string, string>();
const pendingLinesByItem = new Map<string, string[]>();
const initializedThisProcess = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

function normalizeItemId(itemId: string): string {
  const trimmed = String(itemId || "").trim();
  if (!trimmed) {
    return "";
  }
  const safePrefix = trimmed
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64)
    .replace(/^_+|_+$/g, "");
  const hash = crypto.createHash("sha1").update(trimmed).digest("hex").slice(0, 12);
  return `${safePrefix || "item"}_${hash}`;
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

function getItemLogFilePathFromNormalized(normalized: string): string | null {
  if (!normalized || !itemLogsDir) {
    return null;
  }
  const existing = knownLogPaths.get(normalized);
  if (existing) {
    return existing;
  }
  const logPath = path.join(itemLogsDir, `item_${normalized}.txt`);
  knownLogPaths.set(normalized, logPath);
  return logPath;
}

function getItemLogFilePath(itemId: string): string | null {
  return getItemLogFilePathFromNormalized(normalizeItemId(itemId));
}

function flushPending(): void {
  for (const [itemId, lines] of pendingLinesByItem.entries()) {
    if (lines.length === 0) {
      continue;
    }
    const logPath = getItemLogFilePathFromNormalized(itemId);
    if (!logPath) {
      continue;
    }
    const chunk = lines.join("");
    pendingLinesByItem.set(itemId, []);
    try {
      fs.appendFileSync(logPath, chunk, "utf8");
    } catch {
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
  }, ITEM_LOG_FLUSH_INTERVAL_MS);
}

async function cleanupOldItemLogs(dir: string): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir);
    const cutoff = Date.now() - ITEM_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("item_") || !file.endsWith(".txt")) {
        continue;
      }
      const filePath = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
        }
      } catch {
      }
    }
  } catch {
  }
}

function appendLine(itemId: string, line: string): void {
  const normalized = normalizeItemId(itemId);
  if (!normalized) {
    return;
  }
  const lines = pendingLinesByItem.get(normalized) || [];
  lines.push(line);
  pendingLinesByItem.set(normalized, lines);
  scheduleFlush();
}

export function initItemLogs(baseDir: string): void {
  itemLogsDir = path.join(baseDir, "item-logs");
  try {
    fs.mkdirSync(itemLogsDir, { recursive: true });
  } catch {
    itemLogsDir = null;
    return;
  }
  void cleanupOldItemLogs(itemLogsDir);
}

export function ensureItemLog(meta: ItemLogMeta): string | null {
  const normalizedItemId = normalizeItemId(meta.itemId);
  const logPath = getItemLogFilePath(meta.itemId);
  if (!logPath) {
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, "", "utf8");
    }
    if (!initializedThisProcess.has(normalizedItemId)) {
      initializedThisProcess.add(normalizedItemId);
      const startedAt = logTimestamp();
      fs.appendFileSync(
        logPath,
        `=== Item-Log Start: ${startedAt} | itemId=${sanitizeFieldValue(String(meta.itemId || ""))} | logKey=${normalizedItemId} | fileName=${sanitizeFieldValue(meta.fileName)} ===\n`,
        "utf8"
      );
      fs.appendFileSync(
        logPath,
        `${logTimestamp()} [INFO] Item-Kontext initialisiert${formatFields({
          packageId: meta.packageId,
          packageName: meta.packageName,
          fileName: meta.fileName,
          targetPath: meta.targetPath
        })}\n`,
        "utf8"
      );
    }
  } catch {
    return null;
  }
  return logPath;
}

export function logItemEvent(
  itemId: string,
  level: ItemLogLevel,
  message: string,
  fields?: Record<string, unknown>
): void {
  const logPath = getItemLogFilePath(itemId);
  if (!logPath) {
    return;
  }
  const line = `${logTimestamp()} [${level}] ${message}${formatFields(fields)}\n`;
  appendLine(itemId, line);
}

export function getItemLogPath(itemId: string): string | null {
  const logPath = getItemLogFilePath(itemId);
  if (!logPath) {
    return null;
  }
  return fs.existsSync(logPath) ? logPath : null;
}

export function shutdownItemLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushPending();
  for (const itemId of knownLogPaths.keys()) {
    const logPath = getItemLogFilePathFromNormalized(itemId);
    if (!logPath) {
      continue;
    }
    try {
      fs.appendFileSync(logPath, `=== Item-Log Ende: ${logTimestamp()} ===\n`, "utf8");
    } catch {
    }
  }
  pendingLinesByItem.clear();
  knownLogPaths.clear();
  initializedThisProcess.clear();
  itemLogsDir = null;
}
