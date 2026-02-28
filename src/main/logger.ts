import fs from "node:fs";
import path from "node:path";

let logFilePath = path.resolve(process.cwd(), "rd_downloader.log");
let fallbackLogFilePath: string | null = null;
const LOG_FLUSH_INTERVAL_MS = 120;
const LOG_BUFFER_LIMIT_CHARS = 1_000_000;
const LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
let lastRotateCheckAt = 0;

let pendingLines: string[] = [];
let pendingChars = 0;
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight = false;
let exitHookAttached = false;

export function configureLogger(baseDir: string): void {
  logFilePath = path.join(baseDir, "rd_downloader.log");
  const cwdLogPath = path.resolve(process.cwd(), "rd_downloader.log");
  fallbackLogFilePath = cwdLogPath === logFilePath ? null : cwdLogPath;
}

function appendLine(filePath: string, line: string): { ok: boolean; errorText: string } {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, "utf8");
    return { ok: true, errorText: "" };
  } catch (error) {
    return { ok: false, errorText: String(error) };
  }
}

async function appendChunk(filePath: string, chunk: string): Promise<{ ok: boolean; errorText: string }> {
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, chunk, "utf8");
    return { ok: true, errorText: "" };
  } catch (error) {
    return { ok: false, errorText: String(error) };
  }
}

function writeStderr(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // ignore stderr failures
  }
}

function flushSyncPending(): void {
  if (pendingLines.length === 0) {
    return;
  }

  const chunk = pendingLines.join("");
  pendingLines = [];
  pendingChars = 0;

  const primary = appendLine(logFilePath, chunk);
  if (fallbackLogFilePath) {
    const fallback = appendLine(fallbackLogFilePath, chunk);
    if (!primary.ok && !fallback.ok) {
      writeStderr(`LOGGER write failed (primary+fallback): ${primary.errorText} | ${fallback.errorText}\n`);
    }
    return;
  }

  if (!primary.ok) {
    writeStderr(`LOGGER write failed: ${primary.errorText}\n`);
  }
}

function scheduleFlush(immediate = false): void {
  if (flushInFlight) {
    return;
  }
  if (immediate) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flushAsync();
    return;
  }
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAsync();
  }, LOG_FLUSH_INTERVAL_MS);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const now = Date.now();
    if (now - lastRotateCheckAt < 60_000) {
      return;
    }
    lastRotateCheckAt = now;
    const stat = fs.statSync(filePath);
    if (stat.size < LOG_MAX_FILE_BYTES) {
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
    // ignore - file may not exist yet
  }
}

async function flushAsync(): Promise<void> {
  if (flushInFlight || pendingLines.length === 0) {
    return;
  }

  flushInFlight = true;
  const chunk = pendingLines.join("");
  pendingLines = [];
  pendingChars = 0;

  try {
    rotateIfNeeded(logFilePath);
    const primary = await appendChunk(logFilePath, chunk);
    if (fallbackLogFilePath) {
      const fallback = await appendChunk(fallbackLogFilePath, chunk);
      if (!primary.ok && !fallback.ok) {
        writeStderr(`LOGGER write failed (primary+fallback): ${primary.errorText} | ${fallback.errorText}\n`);
      }
    } else if (!primary.ok) {
      writeStderr(`LOGGER write failed: ${primary.errorText}\n`);
    }
  } finally {
    flushInFlight = false;
    if (pendingLines.length > 0) {
      scheduleFlush(true);
    }
  }
}

function ensureExitHook(): void {
  if (exitHookAttached) {
    return;
  }
  exitHookAttached = true;
  process.once("beforeExit", flushSyncPending);
  process.once("exit", flushSyncPending);
}

function write(level: "INFO" | "WARN" | "ERROR", message: string): void {
  ensureExitHook();
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  pendingLines.push(line);
  pendingChars += line.length;

  while (pendingChars > LOG_BUFFER_LIMIT_CHARS && pendingLines.length > 1) {
    const removed = pendingLines.shift();
    if (!removed) {
      break;
    }
    pendingChars = Math.max(0, pendingChars - removed.length);
  }

  if (level === "ERROR") {
    scheduleFlush(true);
    return;
  }
  scheduleFlush();
}

export const logger = {
  info: (msg: string): void => write("INFO", msg),
  warn: (msg: string): void => write("WARN", msg),
  error: (msg: string): void => write("ERROR", msg)
};

export function getLogFilePath(): string {
  return logFilePath;
}
