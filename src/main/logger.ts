import fs from "node:fs";
import path from "node:path";

let logFilePath = path.resolve(process.cwd(), "rd_downloader.log");

export function configureLogger(baseDir: string): void {
  logFilePath = path.join(baseDir, "rd_downloader.log");
}

function write(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, line, "utf8");
  } catch {
    // ignore logging failures
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
