import fs from "node:fs";
import path from "node:path";
import { AppSettings, SessionState } from "../shared/types";
import { defaultSettings } from "./constants";
import { logger } from "./logger";

const VALID_PROVIDERS = new Set(["realdebrid", "megadebrid", "bestdebrid", "alldebrid"]);

export interface StoragePaths {
  baseDir: string;
  configFile: string;
  sessionFile: string;
}

export function createStoragePaths(baseDir: string): StoragePaths {
  return {
    baseDir,
    configFile: path.join(baseDir, "rd_downloader_config.json"),
    sessionFile: path.join(baseDir, "rd_session_state.json")
  };
}

function ensureBaseDir(baseDir: string): void {
  fs.mkdirSync(baseDir, { recursive: true });
}

export function loadSettings(paths: StoragePaths): AppSettings {
  ensureBaseDir(paths.baseDir);
  if (!fs.existsSync(paths.configFile)) {
    return defaultSettings();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as Partial<AppSettings>;
    const merged: AppSettings = {
      ...defaultSettings(),
      ...parsed
    };
    if (!VALID_PROVIDERS.has(merged.providerPrimary)) {
      merged.providerPrimary = "realdebrid";
    }
    if (!VALID_PROVIDERS.has(merged.providerSecondary)) {
      merged.providerSecondary = "megadebrid";
    }
    if (!VALID_PROVIDERS.has(merged.providerTertiary)) {
      merged.providerTertiary = "bestdebrid";
    }
    merged.autoProviderFallback = Boolean(merged.autoProviderFallback);
    merged.maxParallel = Math.max(1, Math.min(50, Number(merged.maxParallel) || 4));
    merged.speedLimitKbps = Math.max(0, Math.min(500000, Number(merged.speedLimitKbps) || 0));
    merged.reconnectWaitSeconds = Math.max(10, Math.min(600, Number(merged.reconnectWaitSeconds) || 45));
    return merged;
  } catch (error) {
    logger.error(`Konfiguration konnte nicht geladen werden: ${String(error)}`);
    return defaultSettings();
  }
}

export function saveSettings(paths: StoragePaths, settings: AppSettings): void {
  ensureBaseDir(paths.baseDir);
  const payload = JSON.stringify(settings, null, 2);
  const tempPath = `${paths.configFile}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  fs.renameSync(tempPath, paths.configFile);
}

export function emptySession(): SessionState {
  return {
    version: 2,
    packageOrder: [],
    packages: {},
    items: {},
    runStartedAt: 0,
    totalDownloadedBytes: 0,
    summaryText: "",
    reconnectUntil: 0,
    reconnectReason: "",
    paused: false,
    running: false,
    updatedAt: Date.now()
  };
}

export function loadSession(paths: StoragePaths): SessionState {
  ensureBaseDir(paths.baseDir);
  if (!fs.existsSync(paths.sessionFile)) {
    return emptySession();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.sessionFile, "utf8")) as Partial<SessionState>;
    return {
      ...emptySession(),
      ...parsed,
      packages: parsed.packages ?? {},
      items: parsed.items ?? {},
      packageOrder: parsed.packageOrder ?? []
    };
  } catch (error) {
    logger.error(`Session konnte nicht geladen werden: ${String(error)}`);
    return emptySession();
  }
}

export function saveSession(paths: StoragePaths, session: SessionState): void {
  ensureBaseDir(paths.baseDir);
  const payload = JSON.stringify({ ...session, updatedAt: Date.now() }, null, 2);
  const tempPath = `${paths.sessionFile}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  fs.renameSync(tempPath, paths.sessionFile);
}
