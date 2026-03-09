import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAuditLogPath, initAuditLog, logAuditEvent, shutdownAuditLog } from "../src/main/audit-log";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownAuditLog();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("audit-log", () => {
  it("writes audit events to the audit log", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-alog-"));
    tempDirs.push(baseDir);

    initAuditLog(baseDir);
    logAuditEvent("INFO", "Settings changed", { changedKeys: ["token", "autoExtract"] });

    const logPath = getAuditLogPath();
    expect(logPath).not.toBeNull();
    expect(fs.existsSync(logPath!)).toBe(true);
    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("Audit-Log Start");
    expect(content).toContain("Settings changed");
    expect(content).toContain("changedKeys");
  });
});
