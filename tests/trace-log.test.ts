import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureLogger, logger } from "../src/main/logger";
import { getSessionLogPath, initSessionLog, shutdownSessionLog } from "../src/main/session-log";
import { getTraceConfig, getTraceConfigPath, getTraceLogPath, initTraceLog, logTraceEvent, setTraceEnabled, shutdownTraceLog } from "../src/main/trace-log";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownSessionLog();
  shutdownTraceLog();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("trace-log", () => {
  it("captures main log lines and explicit trace events when enabled", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-tlog-"));
    tempDirs.push(baseDir);

    configureLogger(baseDir);
    initTraceLog(baseDir);
    initSessionLog(baseDir);
    setTraceEnabled(true, "test");

    logger.info("TRACE-MAIN-CAPTURE");
    logTraceEvent("INFO", "audit", "TRACE-AUDIT-CAPTURE", { source: "test" });

    await new Promise((resolve) => setTimeout(resolve, 350));

    const traceLogPath = getTraceLogPath();
    const sessionLogPath = getSessionLogPath();
    const traceConfigPath = getTraceConfigPath();
    expect(traceLogPath).not.toBeNull();
    expect(sessionLogPath).not.toBeNull();
    expect(traceConfigPath).not.toBeNull();

    const traceContent = fs.readFileSync(traceLogPath!, "utf8");
    expect(traceContent).toContain("Trace-Log Start");
    expect(traceContent).toContain("TRACE-MAIN-CAPTURE");
    expect(traceContent).toContain("TRACE-AUDIT-CAPTURE");

    const sessionContent = fs.readFileSync(sessionLogPath!, "utf8");
    expect(sessionContent).toContain("TRACE-MAIN-CAPTURE");

    const traceConfig = getTraceConfig();
    expect(traceConfig.enabled).toBe(true);
    expect(traceConfig.autoDisableAt).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(traceConfigPath!, "utf8")).enabled).toBe(true);
  });

  it("auto-disables support trace after the requested duration", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-tlog-expire-"));
    tempDirs.push(baseDir);

    configureLogger(baseDir);
    initTraceLog(baseDir);
    setTraceEnabled(true, "expire-test", 50);

    await new Promise((resolve) => setTimeout(resolve, 350));

    const traceConfig = getTraceConfig();
    expect(traceConfig.enabled).toBe(false);
    expect(traceConfig.autoDisableAt).toBeNull();

    const traceLogPath = getTraceLogPath();
    expect(traceLogPath).not.toBeNull();
    const traceContent = fs.readFileSync(traceLogPath!, "utf8");
    expect(traceContent).toContain("Support-Trace automatisch deaktiviert");
  });

  it("rotates oversized trace logs on startup", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-tlog-rotate-"));
    tempDirs.push(baseDir);

    const oversizedPath = path.join(baseDir, "trace.log");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(oversizedPath, "x".repeat(10 * 1024 * 1024 + 256), "utf8");

    initTraceLog(baseDir);

    expect(fs.existsSync(oversizedPath)).toBe(true);
    expect(fs.existsSync(`${oversizedPath}.old`)).toBe(true);
    const currentContent = fs.readFileSync(oversizedPath, "utf8");
    expect(currentContent).toContain("Trace-Log Start");
  });
});
