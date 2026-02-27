import fs from "node:fs";
import path from "node:path";

let logFilePath = path.resolve(process.cwd(), "rd_downloader.log");
let fallbackLogFilePath: string | null = null;

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

function write(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  const primary = appendLine(logFilePath, line);

  if (fallbackLogFilePath) {
    const fallback = appendLine(fallbackLogFilePath, line);
    if (!primary.ok && !fallback.ok) {
      try {
        process.stderr.write(`LOGGER write failed (primary+fallback): ${primary.errorText} | ${fallback.errorText}\n`);
      } catch {
        // ignore stderr failures
      }
    }
    return;
  }

  if (!primary.ok) {
    try {
      process.stderr.write(`LOGGER write failed: ${primary.errorText}\n`);
    } catch {
      // ignore stderr failures
    }
  }
}

export const logger = {
  info: (msg: string): void => write("INFO", msg),
  warn: (msg: string): void => write("WARN", msg),
  error: (msg: string): void => write("ERROR", msg)
};

export function getLogFilePath(): string {
  return logFilePath;
}
