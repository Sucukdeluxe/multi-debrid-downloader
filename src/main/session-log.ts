import fs from "node:fs";
import path from "node:path";
import { setLogListener } from "./logger";

const SESSION_LOG_FLUSH_INTERVAL_MS = 200;

let sessionLogPath: string | null = null;
let sessionLogsDir: string | null = null;
let pendingLines: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function formatTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
}

function flushPending(): void {
  if (pendingLines.length === 0 || !sessionLogPath) {
    return;
  }
  const chunk = pendingLines.join("");
  pendingLines = [];
  try {
    fs.appendFileSync(sessionLogPath, chunk, "utf8");
  } catch {
    // ignore write errors
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, SESSION_LOG_FLUSH_INTERVAL_MS);
}

function appendToSessionLog(line: string): void {
  if (!sessionLogPath) {
    return;
  }
  pendingLines.push(line);
  scheduleFlush();
}

async function cleanupOldSessionLogs(dir: string, maxAgeDays: number): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("session_") || !file.endsWith(".txt")) {
        continue;
      }
      const filePath = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
        }
      } catch {
        // ignore - file may be locked
      }
    }
  } catch {
    // ignore - dir may not exist
  }
}

export function initSessionLog(baseDir: string): void {
  sessionLogsDir = path.join(baseDir, "session-logs");
  fs.mkdirSync(sessionLogsDir, { recursive: true });

  const timestamp = formatTimestamp();
  sessionLogPath = path.join(sessionLogsDir, `session_${timestamp}.txt`);

  const isoTimestamp = new Date().toISOString();
  try {
    fs.writeFileSync(sessionLogPath, `=== Session gestartet: ${isoTimestamp} ===\n`, "utf8");
  } catch {
    sessionLogPath = null;
    return;
  }

  setLogListener((line) => appendToSessionLog(line));

  void cleanupOldSessionLogs(sessionLogsDir, 7);
}

export function getSessionLogPath(): string | null {
  return sessionLogPath;
}

export function shutdownSessionLog(): void {
  if (!sessionLogPath) {
    return;
  }

  // Flush any pending lines
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushPending();

  // Write closing line
  const isoTimestamp = new Date().toISOString();
  try {
    fs.appendFileSync(sessionLogPath, `=== Session beendet: ${isoTimestamp} ===\n`, "utf8");
  } catch {
    // ignore
  }

  setLogListener(null);
  sessionLogPath = null;
}
