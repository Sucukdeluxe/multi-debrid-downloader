import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettings } from "../src/shared/types";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession, loadSession, loadSettings, normalizeSettings, saveSession, saveSessionAsync, saveSettings } from "../src/main/storage";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings storage", () => {
  it("does not persist provider credentials when rememberToken is disabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    saveSettings(paths, {
      ...defaultSettings(),
      rememberToken: false,
      token: "rd-token",
      megaLogin: "mega-user",
      megaPassword: "mega-pass",
      bestToken: "best-token",
      allDebridToken: "all-token"
    });

    const raw = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as Record<string, unknown>;
    expect(raw.token).toBe("");
    expect(raw.megaLogin).toBe("");
    expect(raw.megaPassword).toBe("");
    expect(raw.bestToken).toBe("");
    expect(raw.allDebridToken).toBe("");

    const loaded = loadSettings(paths);
    expect(loaded.rememberToken).toBe(false);
    expect(loaded.token).toBe("");
    expect(loaded.megaLogin).toBe("");
    expect(loaded.megaPassword).toBe("");
    expect(loaded.bestToken).toBe("");
    expect(loaded.allDebridToken).toBe("");
  });

  it("persists provider credentials when rememberToken is enabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    saveSettings(paths, {
      ...defaultSettings(),
      rememberToken: true,
      token: "rd-token",
      megaLogin: "mega-user",
      megaPassword: "mega-pass",
      bestToken: "best-token",
      allDebridToken: "all-token"
    });

    const loaded = loadSettings(paths);
    expect(loaded.token).toBe("rd-token");
    expect(loaded.megaLogin).toBe("mega-user");
    expect(loaded.megaPassword).toBe("mega-pass");
    expect(loaded.bestToken).toBe("best-token");
    expect(loaded.allDebridToken).toBe("all-token");
  });

  it("normalizes invalid enum and numeric values", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      providerPrimary: "invalid-provider" as unknown as AppSettings["providerPrimary"],
      providerSecondary: "invalid-provider" as unknown as AppSettings["providerSecondary"],
      providerTertiary: "invalid-provider" as unknown as AppSettings["providerTertiary"],
      cleanupMode: "broken" as unknown as AppSettings["cleanupMode"],
      extractConflictMode: "broken" as unknown as AppSettings["extractConflictMode"],
      completedCleanupPolicy: "broken" as unknown as AppSettings["completedCleanupPolicy"],
      speedLimitMode: "broken" as unknown as AppSettings["speedLimitMode"],
      maxParallel: 0,
      retryLimit: 999,
      reconnectWaitSeconds: 9999,
      speedLimitKbps: -1,
      outputDir: "   ",
      extractDir: "   ",
      mkvLibraryDir: "   ",
      updateRepo: "   "
    });

    expect(normalized.providerPrimary).toBe("realdebrid");
    expect(normalized.providerSecondary).toBe("none");
    expect(normalized.providerTertiary).toBe("none");
    expect(normalized.cleanupMode).toBe("none");
    expect(normalized.extractConflictMode).toBe("overwrite");
    expect(normalized.completedCleanupPolicy).toBe("never");
    expect(normalized.speedLimitMode).toBe("global");
    expect(normalized.maxParallel).toBe(1);
    expect(normalized.retryLimit).toBe(99);
    expect(normalized.reconnectWaitSeconds).toBe(600);
    expect(normalized.speedLimitKbps).toBe(0);
    expect(normalized.outputDir).toBe(defaultSettings().outputDir);
    expect(normalized.extractDir).toBe(defaultSettings().extractDir);
    expect(normalized.mkvLibraryDir).toBe(defaultSettings().mkvLibraryDir);
    expect(normalized.updateRepo).toBe(defaultSettings().updateRepo);
  });

  it("normalizes malformed persisted config on load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    fs.writeFileSync(
      paths.configFile,
      JSON.stringify({
        providerPrimary: "not-valid",
        completedCleanupPolicy: "not-valid",
        maxParallel: "999",
        retryLimit: "-3",
        reconnectWaitSeconds: "1",
        speedLimitMode: "not-valid",
        updateRepo: ""
      }),
      "utf8"
    );

    const loaded = loadSettings(paths);
    expect(loaded.providerPrimary).toBe("realdebrid");
    expect(loaded.completedCleanupPolicy).toBe("never");
    expect(loaded.maxParallel).toBe(50);
    expect(loaded.retryLimit).toBe(0);
    expect(loaded.reconnectWaitSeconds).toBe(10);
    expect(loaded.speedLimitMode).toBe("global");
    expect(loaded.updateRepo).toBe(defaultSettings().updateRepo);
  });

  it("keeps explicit none as fallback provider choice", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      providerSecondary: "none",
      providerTertiary: "none"
    });

    expect(normalized.providerSecondary).toBe("none");
    expect(normalized.providerTertiary).toBe("none");
  });

  it("normalizes archive password list line endings", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      archivePasswordList: "one\r\ntwo\r\nthree"
    });

    expect(normalized.archivePasswordList).toBe("one\ntwo\nthree");
  });

  it("assigns and preserves bandwidth schedule ids", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      bandwidthSchedules: [{ id: "", startHour: 1, endHour: 6, speedLimitKbps: 1024, enabled: true }]
    });

    const generatedId = normalized.bandwidthSchedules[0]?.id;
    expect(typeof generatedId).toBe("string");
    expect(generatedId?.length).toBeGreaterThan(0);

    const normalizedAgain = normalizeSettings({
      ...defaultSettings(),
      bandwidthSchedules: normalized.bandwidthSchedules
    });
    expect(normalizedAgain.bandwidthSchedules[0]?.id).toBe(generatedId);
  });

  it("resets stale active statuses to queued on session load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    const session = emptySession();
    session.packages["pkg1"] = {
      id: "pkg1",
      name: "Test Package",
      outputDir: "/tmp/out",
      extractDir: "/tmp/extract",
      status: "downloading",
      itemIds: ["item1", "item2", "item3", "item4"],
      cancelled: false,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    session.items["item1"] = {
      id: "item1",
      packageId: "pkg1",
      url: "https://example.com/file1.rar",
      provider: null,
      status: "downloading",
      retries: 0,
      speedBps: 1024,
      downloadedBytes: 5000,
      totalBytes: 10000,
      progressPercent: 50,
      fileName: "file1.rar",
      targetPath: "/tmp/out/file1.rar",
      resumable: true,
      attempts: 1,
      lastError: "some error",
      fullStatus: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    session.items["item2"] = {
      id: "item2",
      packageId: "pkg1",
      url: "https://example.com/file2.rar",
      provider: null,
      status: "paused",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: "file2.rar",
      targetPath: "/tmp/out/file2.rar",
      resumable: false,
      attempts: 0,
      lastError: "",
      fullStatus: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    session.items["item3"] = {
      id: "item3",
      packageId: "pkg1",
      url: "https://example.com/file3.rar",
      provider: null,
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 10000,
      totalBytes: 10000,
      progressPercent: 100,
      fileName: "file3.rar",
      targetPath: "/tmp/out/file3.rar",
      resumable: false,
      attempts: 1,
      lastError: "",
      fullStatus: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    session.items["item4"] = {
      id: "item4",
      packageId: "pkg1",
      url: "https://example.com/file4.rar",
      provider: null,
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: "file4.rar",
      targetPath: "/tmp/out/file4.rar",
      resumable: false,
      attempts: 0,
      lastError: "",
      fullStatus: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    saveSession(paths, session);
    const loaded = loadSession(paths);

    // Active statuses (downloading, paused) should be reset to "queued"
    expect(loaded.items["item1"].status).toBe("queued");
    expect(loaded.items["item2"].status).toBe("queued");
    // Speed should be cleared
    expect(loaded.items["item1"].speedBps).toBe(0);
    // lastError should be cleared for reset items
    expect(loaded.items["item1"].lastError).toBe("");
    // Completed and queued statuses should be preserved
    expect(loaded.items["item3"].status).toBe("completed");
    expect(loaded.items["item4"].status).toBe("queued");
    // Downloaded bytes should be preserved
    expect(loaded.items["item1"].downloadedBytes).toBe(5000);
    // Package data should be preserved
    expect(loaded.packages["pkg1"].name).toBe("Test Package");
  });

  it("returns empty session when session file contains invalid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    fs.writeFileSync(paths.sessionFile, "{{{corrupted json!!!", "utf8");

    const loaded = loadSession(paths);
    const empty = emptySession();
    expect(loaded.packages).toEqual(empty.packages);
    expect(loaded.items).toEqual(empty.items);
    expect(loaded.packageOrder).toEqual(empty.packageOrder);
  });

  it("returns defaults when config file contains invalid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    // Write invalid JSON to the config file
    fs.writeFileSync(paths.configFile, "{{{{not valid json!!!}", "utf8");

    const loaded = loadSettings(paths);
    const defaults = defaultSettings();
    expect(loaded.providerPrimary).toBe(defaults.providerPrimary);
    expect(loaded.maxParallel).toBe(defaults.maxParallel);
    expect(loaded.retryLimit).toBe(defaults.retryLimit);
    expect(loaded.outputDir).toBe(defaults.outputDir);
    expect(loaded.cleanupMode).toBe(defaults.cleanupMode);
  });

  it("loads backup config when primary config is corrupted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    const backupSettings = {
      ...defaultSettings(),
      outputDir: path.join(dir, "backup-output"),
      packageName: "from-backup"
    };
    fs.writeFileSync(`${paths.configFile}.bak`, JSON.stringify(backupSettings, null, 2), "utf8");
    fs.writeFileSync(paths.configFile, "{broken-json", "utf8");

    const loaded = loadSettings(paths);
    expect(loaded.outputDir).toBe(backupSettings.outputDir);
    expect(loaded.packageName).toBe("from-backup");
  });

  it("sanitizes malformed persisted session structures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    fs.writeFileSync(paths.sessionFile, JSON.stringify({
      version: "invalid",
      packageOrder: [123, "pkg-valid"],
      packages: {
        "1": "bad-entry",
        "pkg-valid": {
          id: "pkg-valid",
          name: "Valid Package",
          outputDir: "C:/tmp/out",
          extractDir: "C:/tmp/extract",
          status: "downloading",
          itemIds: ["item-valid", 123],
          cancelled: false,
          enabled: true
        }
      },
      items: {
        "item-valid": {
          id: "item-valid",
          packageId: "pkg-valid",
          url: "https://example.com/file",
          status: "queued",
          fileName: "file.bin",
          targetPath: "C:/tmp/out/file.bin"
        },
        "item-bad": "broken"
      }
    }), "utf8");

    const loaded = loadSession(paths);
    expect(Object.keys(loaded.packages)).toEqual(["pkg-valid"]);
    expect(Object.keys(loaded.items)).toEqual(["item-valid"]);
    expect(loaded.packageOrder).toEqual(["pkg-valid"]);
  });

  it("captures async session save payload before later mutations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    const session = emptySession();
    session.summaryText = "before-mutation";

    const pending = saveSessionAsync(paths, session);
    session.summaryText = "after-mutation";
    await pending;

    const persisted = JSON.parse(fs.readFileSync(paths.sessionFile, "utf8")) as { summaryText: string };
    expect(persisted.summaryText).toBe("before-mutation");
  });

  it("applies defaults for missing fields when loading old config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-store-"));
    tempDirs.push(dir);
    const paths = createStoragePaths(dir);

    // Write a minimal config that simulates an old version missing newer fields
    fs.writeFileSync(
      paths.configFile,
      JSON.stringify({
        token: "my-token",
        rememberToken: true,
        outputDir: "/custom/output"
      }),
      "utf8"
    );

    const loaded = loadSettings(paths);
    const defaults = defaultSettings();

    // Old fields should be preserved
    expect(loaded.token).toBe("my-token");
    expect(loaded.outputDir).toBe(path.resolve("/custom/output"));

    // Missing new fields should get default values
    expect(loaded.autoProviderFallback).toBe(defaults.autoProviderFallback);
    expect(loaded.hybridExtract).toBe(defaults.hybridExtract);
    expect(loaded.completedCleanupPolicy).toBe(defaults.completedCleanupPolicy);
    expect(loaded.speedLimitMode).toBe(defaults.speedLimitMode);
    expect(loaded.clipboardWatch).toBe(defaults.clipboardWatch);
    expect(loaded.minimizeToTray).toBe(defaults.minimizeToTray);
    expect(loaded.retryLimit).toBe(defaults.retryLimit);
    expect(loaded.collectMkvToLibrary).toBe(defaults.collectMkvToLibrary);
    expect(loaded.mkvLibraryDir).toBe(defaults.mkvLibraryDir);
    expect(loaded.theme).toBe(defaults.theme);
    expect(loaded.bandwidthSchedules).toEqual(defaults.bandwidthSchedules);
    expect(loaded.updateRepo).toBe(defaults.updateRepo);
  });
});
