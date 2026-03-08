import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePackageLog, getPackageLogPath, initPackageLogs, logPackageEvent, shutdownPackageLogs } from "../src/main/package-log";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownPackageLogs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("package-log", () => {
  it("creates a persistent package log file", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-plog-"));
    tempDirs.push(baseDir);

    initPackageLogs(baseDir);
    const logPath = ensurePackageLog({
      packageId: "pkg-1",
      name: "Test Paket",
      outputDir: "C:\\downloads\\Test Paket",
      extractDir: "C:\\extract\\Test Paket"
    });

    expect(logPath).not.toBeNull();
    expect(fs.existsSync(logPath!)).toBe(true);

    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("Paket-Log Start");
    expect(content).toContain("Test Paket");
  });

  it("writes detail events into the package log", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-plog-"));
    tempDirs.push(baseDir);

    initPackageLogs(baseDir);
    ensurePackageLog({
      packageId: "pkg-2",
      name: "Detail Paket",
      outputDir: "C:\\downloads\\Detail Paket",
      extractDir: "C:\\extract\\Detail Paket"
    });

    logPackageEvent("pkg-2", "INFO", "Passwort-Versuch", {
      archive: "episode.part1.rar",
      attempt: "1/3",
      password: "\"secret\""
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    const logPath = getPackageLogPath("pkg-2");
    expect(logPath).not.toBeNull();
    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("Passwort-Versuch");
    expect(content).toContain("archive=episode.part1.rar");
    expect(content).toContain("password=\"secret\"");
  });
});
