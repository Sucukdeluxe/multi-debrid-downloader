import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureItemLog, getItemLogPath, initItemLogs, logItemEvent, shutdownItemLogs } from "../src/main/item-log";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownItemLogs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("item-log", () => {
  it("creates a persistent item log file", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-ilog-"));
    tempDirs.push(baseDir);

    initItemLogs(baseDir);
    const logPath = ensureItemLog({
      itemId: "item-1",
      packageId: "pkg-1",
      packageName: "Test Paket",
      fileName: "episode.part2.rar",
      targetPath: "C:\\downloads\\Test Paket\\episode.part2.rar"
    });

    expect(logPath).not.toBeNull();
    expect(fs.existsSync(logPath!)).toBe(true);

    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("Item-Log Start");
    expect(content).toContain("episode.part2.rar");
  });

  it("writes detail events into the item log", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-ilog-"));
    tempDirs.push(baseDir);

    initItemLogs(baseDir);
    ensureItemLog({
      itemId: "item-2",
      packageId: "pkg-2",
      packageName: "Detail Paket",
      fileName: "episode.part2.rar",
      targetPath: "C:\\downloads\\Detail Paket\\episode.part2.rar"
    });

    logItemEvent("item-2", "ERROR", "Entpack-Fehler", {
      archive: "episode.part2.rar",
      code: "missing_parts",
      detail: "Unexpected end of archive"
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    const logPath = getItemLogPath("item-2");
    expect(logPath).not.toBeNull();
    const content = fs.readFileSync(logPath!, "utf8");
    expect(content).toContain("Entpack-Fehler");
    expect(content).toContain("archive=episode.part2.rar");
    expect(content).toContain("code=missing_parts");
  });
});
