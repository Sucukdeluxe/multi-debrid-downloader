import fs from "node:fs";
import path from "node:path";
import { addLogListener, removeLogListener } from "./logger";

const DAILY_LOG_RETENTION_DAYS = 30;
const CLEANUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 500;
const BUFFER_LIMIT_CHARS = 500_000;

let dailyLogDir = "";
let currentDayKey = "";
let logListener: ((line: string) => void) | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
let lastCleanupAt = 0;

// Async buffered writes — never blocks the event loop
let pendingLogLines: string[] = [];
let pendingLogChars = 0;
let pendingRenameLines: string[] = [];
let pendingRenameChars = 0;
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight = false;

function getDayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMonthDir(dayKey: string): string {
  return dayKey.slice(0, 7);
}

function getDailyLogPath(dayKey: string): string {
  return path.join(dailyLogDir, getMonthDir(dayKey), `${dayKey}.log`);
}

function getDailyRenameLogPath(dayKey: string): string {
  return path.join(dailyLogDir, getMonthDir(dayKey), `${dayKey}-rename.log`);
}

function scheduleFlush(): void {
  if (flushTimer || flushInFlight) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAsync();
  }, FLUSH_INTERVAL_MS);
}

async function flushAsync(): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;

  try {
    const dayKey = currentDayKey || getDayKey();

    if (pendingLogLines.length > 0) {
      const chunk = pendingLogLines.join("");
      pendingLogLines = [];
      pendingLogChars = 0;
      const filePath = getDailyLogPath(dayKey);
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, chunk, "utf8");
      } catch { /* ignore */ }
    }

    if (pendingRenameLines.length > 0) {
      const chunk = pendingRenameLines.join("");
      pendingRenameLines = [];
      pendingRenameChars = 0;
      const filePath = getDailyRenameLogPath(dayKey);
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, chunk, "utf8");
      } catch { /* ignore */ }
    }
  } finally {
    flushInFlight = false;
    if (pendingLogLines.length > 0 || pendingRenameLines.length > 0) {
      scheduleFlush();
    }
  }
}

function flushSyncOnExit(): void {
  const dayKey = currentDayKey || getDayKey();

  if (pendingLogLines.length > 0) {
    const chunk = pendingLogLines.join("");
    pendingLogLines = [];
    pendingLogChars = 0;
    try {
      const filePath = getDailyLogPath(dayKey);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, chunk, "utf8");
    } catch { /* ignore */ }
  }

  if (pendingRenameLines.length > 0) {
    const chunk = pendingRenameLines.join("");
    pendingRenameLines = [];
    pendingRenameChars = 0;
    try {
      const filePath = getDailyRenameLogPath(dayKey);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, chunk, "utf8");
    } catch { /* ignore */ }
  }
}

function writeToDailyLog(line: string): void {
  if (!dailyLogDir) return;

  const dayKey = getDayKey();
  if (dayKey !== currentDayKey) {
    // Day changed — flush previous day's buffer first
    if (currentDayKey && (pendingLogLines.length > 0 || pendingRenameLines.length > 0)) {
      void flushAsync();
    }
    currentDayKey = dayKey;
  }

  pendingLogLines.push(line);
  pendingLogChars += line.length;

  // Shed oldest lines if buffer too large
  while (pendingLogChars > BUFFER_LIMIT_CHARS && pendingLogLines.length > 1) {
    const removed = pendingLogLines.shift();
    if (removed) pendingLogChars -= removed.length;
  }

  scheduleFlush();
}

export function writeToDailyRenameLog(line: string): void {
  if (!dailyLogDir) return;

  const dayKey = getDayKey();
  if (dayKey !== currentDayKey) {
    currentDayKey = dayKey;
  }

  pendingRenameLines.push(line);
  pendingRenameChars += line.length;

  while (pendingRenameChars > BUFFER_LIMIT_CHARS && pendingRenameLines.length > 1) {
    const removed = pendingRenameLines.shift();
    if (removed) pendingRenameChars -= removed.length;
  }

  scheduleFlush();
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

  currentDayKey = getDayKey();

  logListener = (line: string) => writeToDailyLog(line);
  addLogListener(logListener);

  cleanupOldDailyLogs();

  cleanupTimer = setInterval(cleanupOldDailyLogs, CLEANUP_CHECK_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();

  process.once("exit", flushSyncOnExit);
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
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushSyncOnExit();
  currentDayKey = "";
}

export function getDailyLogDir(): string {
  return dailyLogDir;
}
