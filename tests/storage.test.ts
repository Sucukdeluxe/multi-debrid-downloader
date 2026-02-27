import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettings } from "../src/shared/types";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, loadSettings, normalizeSettings, saveSettings } from "../src/main/storage";

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
      cleanupMode: "broken" as unknown as AppSettings["cleanupMode"],
      extractConflictMode: "broken" as unknown as AppSettings["extractConflictMode"],
      completedCleanupPolicy: "broken" as unknown as AppSettings["completedCleanupPolicy"],
      speedLimitMode: "broken" as unknown as AppSettings["speedLimitMode"],
      maxParallel: 0,
      reconnectWaitSeconds: 9999,
      speedLimitKbps: -1,
      outputDir: "   ",
      extractDir: "   ",
      updateRepo: "   "
    });

    expect(normalized.providerPrimary).toBe("realdebrid");
    expect(normalized.cleanupMode).toBe("none");
    expect(normalized.extractConflictMode).toBe("overwrite");
    expect(normalized.completedCleanupPolicy).toBe("never");
    expect(normalized.speedLimitMode).toBe("global");
    expect(normalized.maxParallel).toBe(1);
    expect(normalized.reconnectWaitSeconds).toBe(600);
    expect(normalized.speedLimitKbps).toBe(0);
    expect(normalized.outputDir).toBe(defaultSettings().outputDir);
    expect(normalized.extractDir).toBe(defaultSettings().extractDir);
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
    expect(loaded.reconnectWaitSeconds).toBe(10);
    expect(loaded.speedLimitMode).toBe("global");
    expect(loaded.updateRepo).toBe(defaultSettings().updateRepo);
  });
});
