import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDesktopRenameLogPath,
  initDesktopRenameLog,
  logDesktopRename,
  shutdownDesktopRenameLog,
  verifyRename
} from "../src/main/desktop-rename-log";

const createdTmpDirs: string[] = [];

function tmpDesktop(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-rename-log-"));
  createdTmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  shutdownDesktopRenameLog();
  for (const dir of createdTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
  createdTmpDirs.length = 0;
});

describe("desktop-rename-log", () => {
  it("creates the Downloader-Log folder + session file on init and appends formatted lines", () => {
    const desktop = tmpDesktop();
    initDesktopRenameLog(desktop);

    const logPath = getDesktopRenameLogPath();
    expect(logPath).toBeTruthy();
    expect(path.dirname(logPath as string).endsWith("Downloader-Log")).toBe(true);
    expect(fs.existsSync(logPath as string)).toBe(true);

    logDesktopRename("INFO", "Test-Rename", { source: "a.mkv", requested: "b.mkv" });
    const content = fs.readFileSync(logPath as string, "utf8");
    expect(content).toContain("Rename-Session gestartet");
    expect(content).toContain("Test-Rename");
    expect(content).toContain("source=a.mkv");
    expect(content).toContain("requested=b.mkv");
    expect(content).toMatch(/\[INFO\]/);
  });

  it("self-heals: recreates the whole Downloader-Log FOLDER and file if it is deleted mid-session", () => {
    const desktop = tmpDesktop();
    initDesktopRenameLog(desktop);
    const logPath = getDesktopRenameLogPath() as string;
    logDesktopRename("INFO", "ZeileA");

    fs.rmSync(path.join(desktop, "Downloader-Log"), { recursive: true, force: true });
    expect(fs.existsSync(logPath)).toBe(false);

    logDesktopRename("INFO", "ZeileB");
    expect(fs.existsSync(path.join(desktop, "Downloader-Log"))).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("Rename-Session gestartet");
    expect(content).toContain("ZeileB");
  });

  it("is a silent no-op when initialized without a desktop path (never throws)", () => {
    initDesktopRenameLog("");
    expect(getDesktopRenameLogPath()).toBeNull();
    expect(() => logDesktopRename("INFO", "egal")).not.toThrow();
  });

  it("verifyRename: ok when the target exists under the exact name and the source is gone", () => {
    const dir = tmpDesktop();
    const source = path.join(dir, "scn-xyz.part1.rar");
    const target = path.join(dir, "Movie.2024.German.1080p.part1.rar");
    fs.writeFileSync(target, "data");

    const v = verifyRename(source, target);
    expect(v.ok).toBe(true);
    expect(v.level).toBe("INFO");
    expect(v.targetExists).toBe(true);
    expect(v.onDiskName).toBe("Movie.2024.German.1080p.part1.rar");
    expect(v.nameMatches).toBe(true);
    expect(v.sourceGone).toBe(true);
    expect(v.targetSize).toBe(4);
  });

  it("verifyRename: FAILS when the target is missing although rename reported success", () => {
    const dir = tmpDesktop();
    const v = verifyRename(path.join(dir, "src.rar"), path.join(dir, "never-created.rar"));
    expect(v.ok).toBe(false);
    expect(v.level).toBe("ERROR");
    expect(v.targetExists).toBe(false);
    expect(v.reason).toMatch(/nicht gefunden/i);
  });

  it("verifyRename: FAILS (half-done move) when the source still exists next to the target", () => {
    const dir = tmpDesktop();
    const source = path.join(dir, "src.rar");
    const target = path.join(dir, "dst.rar");
    fs.writeFileSync(source, "x");
    fs.writeFileSync(target, "x");

    const v = verifyRename(source, target);
    expect(v.ok).toBe(false);
    expect(v.level).toBe("ERROR");
    expect(v.sourceGone).toBe(false);
    expect(v.reason).toMatch(/Quelldatei existiert noch/i);
  });

  it("verifyRename: an in-place rename (same path) is ok and does not flag a lingering source", () => {
    const dir = tmpDesktop();
    const p = path.join(dir, "file.mkv");
    fs.writeFileSync(p, "x");

    const v = verifyRename(p, p);
    expect(v.ok).toBe(true);
    expect(v.targetExists).toBe(true);
    expect(v.nameMatches).toBe(true);
  });
});
