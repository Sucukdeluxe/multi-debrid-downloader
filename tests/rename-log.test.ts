import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRenameLogPath, initRenameLog, logRenameEvent, shutdownRenameLog } from "../src/main/rename-log";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownRenameLog();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("rename-log", () => {
  it("writes rename events to the rename log", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rlog-"));
    tempDirs.push(baseDir);

    initRenameLog(baseDir);
    logRenameEvent("INFO", "Auto-Rename durchgeführt", {
      packageName: "Test Paket",
      sourcePath: "C:\\extract\\old.mkv",
      targetPath: "C:\\extract\\new.mkv"
    });

    const logPath = getRenameLogPath();
    expect(logPath).not.toBeNull();
    expect(fs.existsSync(logPath!)).toBe(true);
    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("Rename-Log Start");
    expect(content).toContain("Auto-Rename durchgeführt");
    expect(content).toContain("sourcePath=C:\\extract\\old.mkv");
  });

  it("rotates oversized rename logs on startup", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rlog-rotate-"));
    tempDirs.push(baseDir);

    const oversizedPath = path.join(baseDir, "rename.log");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(oversizedPath, "x".repeat(10 * 1024 * 1024 + 256), "utf8");

    initRenameLog(baseDir);

    expect(fs.existsSync(oversizedPath)).toBe(true);
    expect(fs.existsSync(`${oversizedPath}.old`)).toBe(true);
    const content = fs.readFileSync(oversizedPath, "utf8");
    expect(content).toContain("Rename-Log Start");
  });
});
