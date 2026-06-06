import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initSessionLog, getSessionLogPath, shutdownSessionLog } from "../src/main/session-log";
import { setLogListener } from "../src/main/logger";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownSessionLog();
  setLogListener(null);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("session-log", () => {
  it("initSessionLog creates directory and file", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    initSessionLog(baseDir);
    const logPath = getSessionLogPath();
    expect(logPath).not.toBeNull();
    expect(fs.existsSync(logPath!)).toBe(true);
    expect(fs.existsSync(path.join(baseDir, "session-logs"))).toBe(true);
    expect(path.basename(logPath!)).toMatch(/^session_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/);

    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("=== Session gestartet:");

    shutdownSessionLog();
  });

  it("logger listener writes to session log", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    initSessionLog(baseDir);
    const logPath = getSessionLogPath()!;

    const { logger } = await import("../src/main/logger");
    logger.info("Test-Nachricht für Session-Log");

    await new Promise((resolve) => setTimeout(resolve, 500));

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("Test-Nachricht für Session-Log");

    shutdownSessionLog();
  });

  it("shutdownSessionLog writes closing line", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    initSessionLog(baseDir);
    const logPath = getSessionLogPath()!;

    shutdownSessionLog();

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("=== Session beendet:");
  });

  it("shutdownSessionLog removes listener", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    initSessionLog(baseDir);
    const logPath = getSessionLogPath()!;

    shutdownSessionLog();

    const { logger } = await import("../src/main/logger");
    logger.info("Nach-Shutdown-Nachricht");

    await new Promise((resolve) => setTimeout(resolve, 500));

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).not.toContain("Nach-Shutdown-Nachricht");
  });

  it("cleanupOldSessionLogs deletes old files", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    const logsDir = path.join(baseDir, "session-logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const oldFile = path.join(logsDir, "session_2020-01-01_00-00-00.txt");
    fs.writeFileSync(oldFile, "old session");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);

    const newFile = path.join(logsDir, "session_2099-01-01_00-00-00.txt");
    fs.writeFileSync(newFile, "new session");

    initSessionLog(baseDir);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);

    shutdownSessionLog();
  });

  it("cleanupOldSessionLogs keeps recent files", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    const logsDir = path.join(baseDir, "session-logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const recentFile = path.join(logsDir, "session_2025-12-01_00-00-00.txt");
    fs.writeFileSync(recentFile, "recent session");
    const recentTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(recentFile, recentTime, recentTime);

    initSessionLog(baseDir);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fs.existsSync(recentFile)).toBe(true);

    shutdownSessionLog();
  });

  it("multiple sessions create different files", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-slog-"));
    tempDirs.push(baseDir);

    initSessionLog(baseDir);
    const path1 = getSessionLogPath();
    shutdownSessionLog();

    await new Promise((resolve) => setTimeout(resolve, 1100));

    initSessionLog(baseDir);
    const path2 = getSessionLogPath();
    shutdownSessionLog();

    expect(path1).not.toBeNull();
    expect(path2).not.toBeNull();
    expect(path1).not.toBe(path2);
    expect(fs.existsSync(path1!)).toBe(true);
    expect(fs.existsSync(path2!)).toBe(true);
  });
});
