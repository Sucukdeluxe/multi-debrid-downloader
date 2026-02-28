import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppSettings, BandwidthScheduleEntry, SessionState } from "../shared/types";
import { defaultSettings } from "./constants";
import { logger } from "./logger";

const VALID_PRIMARY_PROVIDERS = new Set(["realdebrid", "megadebrid", "bestdebrid", "alldebrid"]);
const VALID_FALLBACK_PROVIDERS = new Set(["none", "realdebrid", "megadebrid", "bestdebrid", "alldebrid"]);
const VALID_CLEANUP_MODES = new Set(["none", "trash", "delete"]);
const VALID_CONFLICT_MODES = new Set(["overwrite", "skip", "rename", "ask"]);
const VALID_FINISHED_POLICIES = new Set(["never", "immediate", "on_start", "package_done"]);
const VALID_SPEED_MODES = new Set(["global", "per_download"]);
const VALID_THEMES = new Set(["dark", "light"]);

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function createScheduleId(index: number): string {
  return `sched-${Date.now().toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBandwidthSchedules(raw: unknown): BandwidthScheduleEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: BandwidthScheduleEntry[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const value = entry as Partial<BandwidthScheduleEntry>;
    const rawId = typeof value.id === "string" ? value.id.trim() : "";
    normalized.push({
      id: rawId || createScheduleId(index),
      startHour: clampNumber(value.startHour, 0, 0, 23),
      endHour: clampNumber(value.endHour, 8, 0, 23),
      speedLimitKbps: clampNumber(value.speedLimitKbps, 0, 0, 500000),
      enabled: value.enabled === undefined ? true : Boolean(value.enabled)
    });
  }
  return normalized;
}

export function normalizeSettings(settings: AppSettings): AppSettings {
  const defaults = defaultSettings();
  const normalized: AppSettings = {
    ...defaults,
    ...settings,
    token: asText(settings.token),
    megaLogin: asText(settings.megaLogin),
    megaPassword: asText(settings.megaPassword),
    bestToken: asText(settings.bestToken),
    allDebridToken: asText(settings.allDebridToken),
    archivePasswordList: String(settings.archivePasswordList ?? "").replace(/\r\n/g, "\n"),
    rememberToken: Boolean(settings.rememberToken),
    autoProviderFallback: Boolean(settings.autoProviderFallback),
    outputDir: asText(settings.outputDir) || defaults.outputDir,
    packageName: asText(settings.packageName),
    autoExtract: Boolean(settings.autoExtract),
    autoRename4sf4sj: Boolean(settings.autoRename4sf4sj),
    extractDir: asText(settings.extractDir) || defaults.extractDir,
    createExtractSubfolder: Boolean(settings.createExtractSubfolder),
    hybridExtract: Boolean(settings.hybridExtract),
    removeLinkFilesAfterExtract: Boolean(settings.removeLinkFilesAfterExtract),
    removeSamplesAfterExtract: Boolean(settings.removeSamplesAfterExtract),
    enableIntegrityCheck: Boolean(settings.enableIntegrityCheck),
    autoResumeOnStart: Boolean(settings.autoResumeOnStart),
    autoReconnect: Boolean(settings.autoReconnect),
    maxParallel: clampNumber(settings.maxParallel, defaults.maxParallel, 1, 50),
    speedLimitEnabled: Boolean(settings.speedLimitEnabled),
    speedLimitKbps: clampNumber(settings.speedLimitKbps, defaults.speedLimitKbps, 0, 500000),
    reconnectWaitSeconds: clampNumber(settings.reconnectWaitSeconds, defaults.reconnectWaitSeconds, 10, 600),
    autoUpdateCheck: Boolean(settings.autoUpdateCheck),
    updateRepo: asText(settings.updateRepo) || defaults.updateRepo,
    clipboardWatch: Boolean(settings.clipboardWatch),
    minimizeToTray: Boolean(settings.minimizeToTray),
    theme: VALID_THEMES.has(settings.theme) ? settings.theme : defaults.theme,
    bandwidthSchedules: normalizeBandwidthSchedules(settings.bandwidthSchedules)
  };

  if (!VALID_PRIMARY_PROVIDERS.has(normalized.providerPrimary)) {
    normalized.providerPrimary = defaults.providerPrimary;
  }
  if (!VALID_FALLBACK_PROVIDERS.has(normalized.providerSecondary)) {
    normalized.providerSecondary = "none";
  }
  if (!VALID_FALLBACK_PROVIDERS.has(normalized.providerTertiary)) {
    normalized.providerTertiary = "none";
  }
  if (!VALID_CLEANUP_MODES.has(normalized.cleanupMode)) {
    normalized.cleanupMode = defaults.cleanupMode;
  }
  if (!VALID_CONFLICT_MODES.has(normalized.extractConflictMode)) {
    normalized.extractConflictMode = defaults.extractConflictMode;
  }
  if (!VALID_FINISHED_POLICIES.has(normalized.completedCleanupPolicy)) {
    normalized.completedCleanupPolicy = defaults.completedCleanupPolicy;
  }
  if (!VALID_SPEED_MODES.has(normalized.speedLimitMode)) {
    normalized.speedLimitMode = defaults.speedLimitMode;
  }

  return normalized;
}

function sanitizeCredentialPersistence(settings: AppSettings): AppSettings {
  if (settings.rememberToken) {
    return settings;
  }
  return {
    ...settings,
    token: "",
    megaLogin: "",
    megaPassword: "",
    bestToken: "",
    allDebridToken: "",
    archivePasswordList: ""
  };
}

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
    // Safe: parsed is spread into a fresh object with defaults first, and normalizeSettings
    // validates every field, so prototype pollution via __proto__ / constructor is not a concern.
    const parsed = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as AppSettings;
    const merged = normalizeSettings({
      ...defaultSettings(),
      ...parsed
    });
    return sanitizeCredentialPersistence(merged);
  } catch (error) {
    logger.error(`Konfiguration konnte nicht geladen werden: ${String(error)}`);
    return defaultSettings();
  }
}

function syncRenameWithExdevFallback(tempPath: string, targetPath: string): void {
  try {
    fs.renameSync(tempPath, targetPath);
  } catch (renameError: unknown) {
    if (renameError && typeof renameError === "object" && "code" in renameError && (renameError as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(tempPath, targetPath);
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    } else {
      throw renameError;
    }
  }
}

export function saveSettings(paths: StoragePaths, settings: AppSettings): void {
  ensureBaseDir(paths.baseDir);
  // Create a backup of the existing config before overwriting
  if (fs.existsSync(paths.configFile)) {
    try {
      fs.copyFileSync(paths.configFile, `${paths.configFile}.bak`);
    } catch {
      // Best-effort backup; proceed even if it fails
    }
  }
  const persisted = sanitizeCredentialPersistence(normalizeSettings(settings));
  const payload = JSON.stringify(persisted, null, 2);
  const tempPath = `${paths.configFile}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  syncRenameWithExdevFallback(tempPath, paths.configFile);
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
    const session: SessionState = {
      ...emptySession(),
      ...parsed,
      packages: parsed.packages ?? {},
      items: parsed.items ?? {},
      packageOrder: parsed.packageOrder ?? []
    };

    // Reset transient fields that may be stale from a previous crash
    const ACTIVE_STATUSES = new Set(["downloading", "validating", "extracting", "integrity_check", "paused", "reconnect_wait"]);
    for (const item of Object.values(session.items)) {
      if (ACTIVE_STATUSES.has(item.status)) {
        item.status = "queued";
        item.lastError = "";
      }
      // Always clear stale speed values
      item.speedBps = 0;
    }

    return session;
  } catch (error) {
    logger.error(`Session konnte nicht geladen werden: ${String(error)}`);
    return emptySession();
  }
}

export function saveSession(paths: StoragePaths, session: SessionState): void {
  ensureBaseDir(paths.baseDir);
  const payload = JSON.stringify({ ...session, updatedAt: Date.now() });
  const tempPath = `${paths.sessionFile}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  syncRenameWithExdevFallback(tempPath, paths.sessionFile);
}

let asyncSaveRunning = false;
let asyncSaveQueued: { paths: StoragePaths; session: SessionState } | null = null;

export async function saveSessionAsync(paths: StoragePaths, session: SessionState): Promise<void> {
  if (asyncSaveRunning) {
    asyncSaveQueued = { paths, session };
    return;
  }
  asyncSaveRunning = true;
  try {
    await fs.promises.mkdir(paths.baseDir, { recursive: true });
    const payload = JSON.stringify({ ...session, updatedAt: Date.now() });
    const tempPath = `${paths.sessionFile}.tmp`;
    await fsp.writeFile(tempPath, payload, "utf8");
    try {
      await fsp.rename(tempPath, paths.sessionFile);
    } catch (renameError: unknown) {
      if (renameError && typeof renameError === "object" && "code" in renameError && (renameError as NodeJS.ErrnoException).code === "EXDEV") {
        await fsp.copyFile(tempPath, paths.sessionFile);
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      } else {
        throw renameError;
      }
    }
  } catch (error) {
    logger.error(`Async Session-Save fehlgeschlagen: ${String(error)}`);
  } finally {
    asyncSaveRunning = false;
    if (asyncSaveQueued) {
      const queued = asyncSaveQueued;
      asyncSaveQueued = null;
      void saveSessionAsync(queued.paths, queued.session);
    }
  }
}
