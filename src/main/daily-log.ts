import fs from "node:fs";
import path from "node:path";
import { addLogListener, removeLogListener } from "./logger";

const DAILY_LOG_RETENTION_DAYS = 30;
const CLEANUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

let dailyLogDir = "";
let currentDayKey = "";
let currentLogFd: number | null = null;
let currentRenameFd: number | null = null;
let logListener: ((line: string) => void) | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
let lastCleanupAt = 0;

function getDayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMonthDir(dayKey: string): string {
  return dayKey.slice(0, 7); // "YYYY-MM"
}

function ensureDayFile(dayKey: string): number | null {
  if (currentDayKey === dayKey && currentLogFd !== null) {
    return currentLogFd;
  }

  // Close previous day's fd
  if (currentLogFd !== null) {
    try { fs.closeSync(currentLogFd); } catch { /* ignore */ }
    currentLogFd = null;
  }
  if (currentRenameFd !== null) {
    try { fs.closeSync(currentRenameFd); } catch { /* ignore */ }
    currentRenameFd = null;
  }

  currentDayKey = dayKey;
  const monthDir = path.join(dailyLogDir, getMonthDir(dayKey));

  try {
    fs.mkdirSync(monthDir, { recursive: true });
    const filePath = path.join(monthDir, `${dayKey}.log`);
    currentLogFd = fs.openSync(filePath, "a");
    return currentLogFd;
  } catch {
    return null;
  }
}

function ensureRenameFd(dayKey: string): number | null {
  if (currentDayKey === dayKey && currentRenameFd !== null) {
    return currentRenameFd;
  }

  // ensureDayFile handles day transitions
  if (currentDayKey !== dayKey) {
    ensureDayFile(dayKey);
  }

  if (currentRenameFd !== null) {
    return currentRenameFd;
  }

  const monthDir = path.join(dailyLogDir, getMonthDir(dayKey));
  try {
    fs.mkdirSync(monthDir, { recursive: true });
    const filePath = path.join(monthDir, `${dayKey}-rename.log`);
    currentRenameFd = fs.openSync(filePath, "a");
    return currentRenameFd;
  } catch {
    return null;
  }
}

function writeToDailyLog(line: string): void {
  if (!dailyLogDir) return;

  const dayKey = getDayKey();
  const fd = ensureDayFile(dayKey);
  if (fd === null) return;

  try {
    fs.writeSync(fd, line);
  } catch {
    // Close and retry on next write
    try { fs.closeSync(fd); } catch { /* ignore */ }
    currentLogFd = null;
  }
}

export function writeToDailyRenameLog(line: string): void {
  if (!dailyLogDir) return;

  const dayKey = getDayKey();
  const fd = ensureRenameFd(dayKey);
  if (fd === null) return;

  try {
    fs.writeSync(fd, line);
  } catch {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    currentRenameFd = null;
  }
}

function cleanupOldDailyLogs(): void {
  if (!dailyLogDir) return;

  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_CHECK_INTERVAL_MS) return;
  lastCleanupAt = now;

  const cutoffMs = now - DAILY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  try {
    const monthDirs = fs.readdirSync(dailyLogDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name));

    for (const monthDir of monthDirs) {
      const monthPath = path.join(dailyLogDir, monthDir.name);
      const files = fs.readdirSync(monthPath, { withFileTypes: true })
        .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}/.test(e.name));

      for (const file of files) {
        const filePath = path.join(monthPath, file.name);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoffMs) {
            fs.rmSync(filePath, { force: true });
          }
        } catch { /* ignore */ }
      }

      // Remove empty month dirs
      try {
        const remaining = fs.readdirSync(monthPath);
        if (remaining.length === 0) {
          fs.rmdirSync(monthPath);
        }
      } catch { /* ignore */ }
    }
  } catch {
    // ignore cleanup errors
  }
}

export function initDailyLog(baseDir: string): void {
  dailyLogDir = path.join(baseDir, "daily-logs");

  try {
    fs.mkdirSync(dailyLogDir, { recursive: true });
  } catch { /* ignore */ }

  // Attach listener to main logger
  logListener = (line: string) => writeToDailyLog(line);
  addLogListener(logListener);

  // Initial cleanup
  cleanupOldDailyLogs();

  // Periodic cleanup
  cleanupTimer = setInterval(cleanupOldDailyLogs, CLEANUP_CHECK_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function shutdownDailyLog(): void {
  if (logListener) {
    removeLogListener(logListener);
    logListener = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (currentLogFd !== null) {
    try { fs.closeSync(currentLogFd); } catch { /* ignore */ }
    currentLogFd = null;
  }
  if (currentRenameFd !== null) {
    try { fs.closeSync(currentRenameFd); } catch { /* ignore */ }
    currentRenameFd = null;
  }
  currentDayKey = "";
}

export function getDailyLogDir(): string {
  return dailyLogDir;
}
