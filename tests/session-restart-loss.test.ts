import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadItem, PackageEntry, SessionState } from "../src/shared/types";
import {
  cancelPendingAsyncSaves,
  createStoragePaths,
  emptySession,
  loadSession,
  loadSettings,
  saveSession,
  saveSessionAsync,
  saveSettings,
  saveSettingsAsync
} from "../src/main/storage";
import { defaultSettings } from "../src/main/constants";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePackage(id: string, itemId: string): PackageEntry {
  return {
    id,
    name: `Package ${id}`,
    outputDir: "C:/tmp/out",
    extractDir: "C:/tmp/extract",
    status: "queued",
    itemIds: [itemId],
    cancelled: false,
    enabled: true,
    downloadStartedAt: 0,
    downloadCompletedAt: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

function makeItem(id: string, packageId: string): DownloadItem {
  return {
    id,
    packageId,
    url: `https://example.com/${id}`,
    provider: null,
    status: "queued",
    retries: 0,
    speedBps: 0,
    downloadedBytes: 0,
    totalBytes: null,
    progressPercent: 0,
    fileName: `${id}.rar`,
    targetPath: "",
    resumable: true,
    attempts: 0,
    lastError: "",
    fullStatus: "Wartet",
    createdAt: 1,
    updatedAt: 1
  };
}

function sessionWith(ids: string[]): SessionState {
  const s = emptySession();
  for (const id of ids) {
    const itemId = `${id}-item`;
    s.packageOrder.push(id);
    s.packages[id] = makePackage(id, itemId);
    s.items[itemId] = makeItem(itemId, id);
  }
  return s;
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("session restart loss", () => {
  it("does not let a queued stale async save clobber a newer synchronous save", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-loss-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    cancelPendingAsyncSaves();
    await settle(50);

    saveSession(paths, sessionWith(["A", "B"]));

    const inflight = saveSessionAsync(paths, sessionWith(["A", "B"]));
    const queued = saveSessionAsync(paths, sessionWith(["A", "B"]));
    saveSession(paths, sessionWith(["A", "B", "C"]));

    await inflight;
    await queued;
    await settle();

    const loaded = loadSession(paths);
    expect(Object.keys(loaded.packages).sort()).toEqual(["A", "B", "C"]);
  });

  it("recovers packages from the backup when the primary session file is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-loss-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    fs.writeFileSync(`${paths.sessionFile}.bak`, JSON.stringify(sessionWith(["A", "B"])), "utf8");
    expect(fs.existsSync(paths.sessionFile)).toBe(false);

    const loaded = loadSession(paths);
    expect(Object.keys(loaded.packages).sort()).toEqual(["A", "B"]);
  });

  it("still treats a truly fresh install (no primary, no backup, no temp) as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-loss-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    const loaded = loadSession(paths);
    expect(Object.keys(loaded.packages)).toEqual([]);
    expect(Object.keys(loaded.items)).toEqual([]);
  });

  it("recovers from the backup when the primary exists but is empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-loss-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    fs.writeFileSync(paths.sessionFile, JSON.stringify(emptySession()), "utf8");
    fs.writeFileSync(`${paths.sessionFile}.bak`, JSON.stringify(sessionWith(["A", "B"])), "utf8");

    const loaded = loadSession(paths);
    expect(Object.keys(loaded.packages).sort()).toEqual(["A", "B"]);
  });

  it("does not let an in-flight/queued async settings save clobber a newer synchronous saveSettings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-settings-race-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    cancelPendingAsyncSaves();
    await settle(50);

    const withName = (name: string) => ({ ...defaultSettings(), packageName: name });

    saveSettings(paths, withName("OLD"));
    const inflight = saveSettingsAsync(paths, withName("OLD"));
    const queued = saveSettingsAsync(paths, withName("OLD"));
    saveSettings(paths, withName("NEW"));

    await inflight;
    await queued;
    await settle();

    expect(loadSettings(paths).packageName).toBe("NEW");
  });
});
