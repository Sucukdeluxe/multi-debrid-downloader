import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppSettings, BandwidthScheduleEntry, DebridProvider, DownloadItem, DownloadStatus, HistoryEntry, PackageEntry, PackagePriority, SessionState } from "../shared/types";
import { defaultSettings } from "./constants";
import { logger } from "./logger";

const VALID_PRIMARY_PROVIDERS = new Set(["realdebrid", "megadebrid", "bestdebrid", "alldebrid"]);
const VALID_FALLBACK_PROVIDERS = new Set(["none", "realdebrid", "megadebrid", "bestdebrid", "alldebrid"]);
const VALID_CLEANUP_MODES = new Set(["none", "trash", "delete"]);
const VALID_CONFLICT_MODES = new Set(["overwrite", "skip", "rename", "ask"]);
const VALID_FINISHED_POLICIES = new Set(["never", "immediate", "on_start", "package_done"]);
const VALID_SPEED_MODES = new Set(["global", "per_download"]);
const VALID_THEMES = new Set(["dark", "light"]);
const VALID_EXTRACT_CPU_PRIORITIES = new Set(["high", "middle", "low"]);
const VALID_PACKAGE_PRIORITIES = new Set<string>(["high", "normal", "low"]);
const VALID_DOWNLOAD_STATUSES = new Set<DownloadStatus>([
  "queued", "validating", "downloading", "paused", "reconnect_wait", "extracting", "integrity_check", "completed", "failed", "cancelled"
]);
const VALID_ITEM_PROVIDERS = new Set<DebridProvider>(["realdebrid", "megadebrid", "bestdebrid", "alldebrid"]);

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

function normalizeAbsoluteDir(value: unknown, fallback: string): string {
  const text = asText(value);
  if (!text || !path.isAbsolute(text)) {
    return path.resolve(fallback);
  }
  return path.resolve(text);
}

const DEFAULT_COLUMN_ORDER = ["name", "size", "progress", "hoster", "account", "prio", "status", "speed"];
const ALL_VALID_COLUMNS = new Set([...DEFAULT_COLUMN_ORDER, "added"]);

function normalizeColumnOrder(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_COLUMN_ORDER];
  }
  const valid = ALL_VALID_COLUMNS;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const col of raw) {
    if (typeof col === "string" && valid.has(col) && !seen.has(col)) {
      seen.add(col);
      result.push(col);
    }
  }
  // "name" is mandatory — ensure it's always present
  if (!seen.has("name")) {
    result.unshift("name");
  }
  return result;
}

export function normalizeSettings(settings: AppSettings): AppSettings {
  const defaults = defaultSettings();
  const normalized: AppSettings = {
    token: asText(settings.token),
    megaLogin: asText(settings.megaLogin),
    megaPassword: asText(settings.megaPassword),
    bestToken: asText(settings.bestToken),
    allDebridToken: asText(settings.allDebridToken),
    archivePasswordList: String(settings.archivePasswordList ?? "").replace(/\r\n/g, "\n"),
    rememberToken: Boolean(settings.rememberToken),
    providerPrimary: settings.providerPrimary,
    providerSecondary: settings.providerSecondary,
    providerTertiary: settings.providerTertiary,
    autoProviderFallback: Boolean(settings.autoProviderFallback),
    outputDir: normalizeAbsoluteDir(settings.outputDir, defaults.outputDir),
    packageName: asText(settings.packageName),
    autoExtract: Boolean(settings.autoExtract),
    autoRename4sf4sj: Boolean(settings.autoRename4sf4sj),
    extractDir: normalizeAbsoluteDir(settings.extractDir, defaults.extractDir),
    collectMkvToLibrary: Boolean(settings.collectMkvToLibrary),
    mkvLibraryDir: normalizeAbsoluteDir(settings.mkvLibraryDir, defaults.mkvLibraryDir),
    createExtractSubfolder: Boolean(settings.createExtractSubfolder),
    hybridExtract: Boolean(settings.hybridExtract),
    cleanupMode: settings.cleanupMode,
    extractConflictMode: settings.extractConflictMode,
    removeLinkFilesAfterExtract: Boolean(settings.removeLinkFilesAfterExtract),
    removeSamplesAfterExtract: Boolean(settings.removeSamplesAfterExtract),
    enableIntegrityCheck: Boolean(settings.enableIntegrityCheck),
    autoResumeOnStart: Boolean(settings.autoResumeOnStart),
    autoReconnect: Boolean(settings.autoReconnect),
    maxParallel: clampNumber(settings.maxParallel, defaults.maxParallel, 1, 50),
    maxParallelExtract: clampNumber(settings.maxParallelExtract, defaults.maxParallelExtract, 1, 8),
    retryLimit: clampNumber(settings.retryLimit, defaults.retryLimit, 0, 99),
    reconnectWaitSeconds: clampNumber(settings.reconnectWaitSeconds, defaults.reconnectWaitSeconds, 10, 600),
    completedCleanupPolicy: settings.completedCleanupPolicy,
    speedLimitEnabled: Boolean(settings.speedLimitEnabled),
    speedLimitKbps: clampNumber(settings.speedLimitKbps, defaults.speedLimitKbps, 0, 500000),
    speedLimitMode: settings.speedLimitMode,
    autoUpdateCheck: Boolean(settings.autoUpdateCheck),
    updateRepo: asText(settings.updateRepo) || defaults.updateRepo,
    clipboardWatch: Boolean(settings.clipboardWatch),
    minimizeToTray: Boolean(settings.minimizeToTray),
    collapseNewPackages: settings.collapseNewPackages !== undefined ? Boolean(settings.collapseNewPackages) : defaults.collapseNewPackages,
    autoSkipExtracted: settings.autoSkipExtracted !== undefined ? Boolean(settings.autoSkipExtracted) : defaults.autoSkipExtracted,
    confirmDeleteSelection: settings.confirmDeleteSelection !== undefined ? Boolean(settings.confirmDeleteSelection) : defaults.confirmDeleteSelection,
    totalDownloadedAllTime: typeof settings.totalDownloadedAllTime === "number" && settings.totalDownloadedAllTime >= 0 ? settings.totalDownloadedAllTime : defaults.totalDownloadedAllTime,
    theme: VALID_THEMES.has(settings.theme) ? settings.theme : defaults.theme,
    bandwidthSchedules: normalizeBandwidthSchedules(settings.bandwidthSchedules),
    columnOrder: normalizeColumnOrder(settings.columnOrder),
    extractCpuPriority: settings.extractCpuPriority
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
  if (normalized.providerSecondary === normalized.providerPrimary) {
    normalized.providerSecondary = "none";
  }
  if (normalized.providerTertiary === normalized.providerPrimary || normalized.providerTertiary === normalized.providerSecondary) {
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
  if (!VALID_EXTRACT_CPU_PRIORITIES.has(normalized.extractCpuPriority)) {
    normalized.extractCpuPriority = defaults.extractCpuPriority;
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
  historyFile: string;
}

export function createStoragePaths(baseDir: string): StoragePaths {
  return {
    baseDir,
    configFile: path.join(baseDir, "rd_downloader_config.json"),
    sessionFile: path.join(baseDir, "rd_session_state.json"),
    historyFile: path.join(baseDir, "rd_history.json")
  };
}

function ensureBaseDir(baseDir: string): void {
  fs.mkdirSync(baseDir, { recursive: true });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readSettingsFile(filePath: string): AppSettings | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as AppSettings;
    const merged = normalizeSettings({
      ...defaultSettings(),
      ...parsed
    });
    return sanitizeCredentialPersistence(merged);
  } catch {
    return null;
  }
}

function normalizeLoadedSession(raw: unknown): SessionState {
  const fallback = emptySession();
  const parsed = asRecord(raw);
  if (!parsed) {
    return fallback;
  }

  const now = Date.now();
  const itemsById: Record<string, DownloadItem> = {};
  const rawItems = asRecord(parsed.items) ?? {};
  for (const [entryId, rawItem] of Object.entries(rawItems)) {
    const item = asRecord(rawItem);
    if (!item) {
      continue;
    }
    const id = asText(item.id) || entryId;
    const packageId = asText(item.packageId);
    const url = asText(item.url);
    if (!id || !packageId || !url) {
      continue;
    }

    const statusRaw = asText(item.status) as DownloadStatus;
    const status: DownloadStatus = VALID_DOWNLOAD_STATUSES.has(statusRaw) ? statusRaw : "queued";
    const providerRaw = asText(item.provider) as DebridProvider;

    const onlineStatusRaw = asText(item.onlineStatus);
    const validOnlineStatuses = new Set(["online", "offline", "checking"]);

    itemsById[id] = {
      id,
      packageId,
      url,
      provider: VALID_ITEM_PROVIDERS.has(providerRaw) ? providerRaw : null,
      status,
      retries: clampNumber(item.retries, 0, 0, 1_000_000),
      speedBps: clampNumber(item.speedBps, 0, 0, 10_000_000_000),
      downloadedBytes: clampNumber(item.downloadedBytes, 0, 0, 10_000_000_000_000),
      totalBytes: item.totalBytes == null ? null : clampNumber(item.totalBytes, 0, 0, 10_000_000_000_000),
      progressPercent: clampNumber(item.progressPercent, 0, 0, 100),
      fileName: asText(item.fileName) || "download.bin",
      targetPath: asText(item.targetPath),
      resumable: item.resumable === undefined ? true : Boolean(item.resumable),
      attempts: clampNumber(item.attempts, 0, 0, 10_000),
      lastError: asText(item.lastError),
      fullStatus: asText(item.fullStatus),
      onlineStatus: validOnlineStatuses.has(onlineStatusRaw) ? onlineStatusRaw as "online" | "offline" | "checking" : undefined,
      createdAt: clampNumber(item.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: clampNumber(item.updatedAt, now, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  const packagesById: Record<string, PackageEntry> = {};
  const rawPackages = asRecord(parsed.packages) ?? {};
  for (const [entryId, rawPkg] of Object.entries(rawPackages)) {
    const pkg = asRecord(rawPkg);
    if (!pkg) {
      continue;
    }
    const id = asText(pkg.id) || entryId;
    if (!id) {
      continue;
    }
    const statusRaw = asText(pkg.status) as DownloadStatus;
    const status: DownloadStatus = VALID_DOWNLOAD_STATUSES.has(statusRaw) ? statusRaw : "queued";
    const rawItemIds = Array.isArray(pkg.itemIds) ? pkg.itemIds : [];
    packagesById[id] = {
      id,
      name: asText(pkg.name) || "Paket",
      outputDir: asText(pkg.outputDir),
      extractDir: asText(pkg.extractDir),
      status,
      itemIds: rawItemIds
        .map((value) => asText(value))
        .filter((value) => value.length > 0),
      cancelled: Boolean(pkg.cancelled),
      enabled: pkg.enabled === undefined ? true : Boolean(pkg.enabled),
      priority: VALID_PACKAGE_PRIORITIES.has(asText(pkg.priority)) ? asText(pkg.priority) as PackagePriority : "normal",
      createdAt: clampNumber(pkg.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: clampNumber(pkg.updatedAt, now, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  for (const [itemId, item] of Object.entries(itemsById)) {
    if (!packagesById[item.packageId]) {
      delete itemsById[itemId];
    }
  }

  for (const pkg of Object.values(packagesById)) {
    pkg.itemIds = pkg.itemIds.filter((itemId) => {
      const item = itemsById[itemId];
      return Boolean(item) && item.packageId === pkg.id;
    });
  }

  const rawOrder = Array.isArray(parsed.packageOrder) ? parsed.packageOrder : [];
  const seenOrder = new Set<string>();
  const packageOrder = rawOrder
    .map((entry) => asText(entry))
    .filter((id) => {
      if (!(id in packagesById) || seenOrder.has(id)) {
        return false;
      }
      seenOrder.add(id);
      return true;
    });
  for (const packageId of Object.keys(packagesById)) {
    if (!packageOrder.includes(packageId)) {
      packageOrder.push(packageId);
    }
  }

  return {
    ...fallback,
    version: clampNumber(parsed.version, fallback.version, 1, 10),
    packageOrder,
    packages: packagesById,
    items: itemsById,
    runStartedAt: clampNumber(parsed.runStartedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    totalDownloadedBytes: clampNumber(parsed.totalDownloadedBytes, 0, 0, Number.MAX_SAFE_INTEGER),
    summaryText: asText(parsed.summaryText),
    reconnectUntil: clampNumber(parsed.reconnectUntil, 0, 0, Number.MAX_SAFE_INTEGER),
    reconnectReason: asText(parsed.reconnectReason),
    paused: Boolean(parsed.paused),
    running: Boolean(parsed.running),
    updatedAt: clampNumber(parsed.updatedAt, now, 0, Number.MAX_SAFE_INTEGER)
  };
}

export function loadSettings(paths: StoragePaths): AppSettings {
  ensureBaseDir(paths.baseDir);
  if (!fs.existsSync(paths.configFile)) {
    return defaultSettings();
  }
  const loaded = readSettingsFile(paths.configFile);
  if (loaded) {
    return loaded;
  }

  const backupFile = `${paths.configFile}.bak`;
  const backupLoaded = fs.existsSync(backupFile) ? readSettingsFile(backupFile) : null;
  if (backupLoaded) {
    logger.warn("Konfiguration defekt, Backup-Datei wird verwendet");
    try {
      const payload = JSON.stringify(backupLoaded, null, 2);
      const tempPath = `${paths.configFile}.tmp`;
      fs.writeFileSync(tempPath, payload, "utf8");
      syncRenameWithExdevFallback(tempPath, paths.configFile);
    } catch {
      // ignore restore write failure
    }
    return backupLoaded;
  }

  logger.error("Konfiguration konnte nicht geladen werden (auch Backup fehlgeschlagen)");
  return defaultSettings();
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

function sessionTempPath(sessionFile: string, kind: "sync" | "async"): string {
  return `${sessionFile}.${kind}.tmp`;
}

function sessionBackupPath(sessionFile: string): string {
  return `${sessionFile}.bak`;
}

function normalizeLoadedSessionTransientFields(session: SessionState): SessionState {
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
}

function readSessionFile(filePath: string): SessionState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return normalizeLoadedSessionTransientFields(normalizeLoadedSession(parsed));
  } catch {
    return null;
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

let asyncSettingsSaveRunning = false;
let asyncSettingsSaveQueued: { paths: StoragePaths; payload: string } | null = null;

async function writeSettingsPayload(paths: StoragePaths, payload: string): Promise<void> {
  await fs.promises.mkdir(paths.baseDir, { recursive: true });
  await fsp.copyFile(paths.configFile, `${paths.configFile}.bak`).catch(() => {});
  const tempPath = `${paths.configFile}.settings.tmp`;
  await fsp.writeFile(tempPath, payload, "utf8");
  try {
    await fsp.rename(tempPath, paths.configFile);
  } catch (renameError: unknown) {
    if (renameError && typeof renameError === "object" && "code" in renameError && (renameError as NodeJS.ErrnoException).code === "EXDEV") {
      await fsp.copyFile(tempPath, paths.configFile);
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    } else {
      throw renameError;
    }
  }
}

export async function saveSettingsAsync(paths: StoragePaths, settings: AppSettings): Promise<void> {
  const persisted = sanitizeCredentialPersistence(normalizeSettings(settings));
  const payload = JSON.stringify(persisted, null, 2);
  if (asyncSettingsSaveRunning) {
    asyncSettingsSaveQueued = { paths, payload };
    return;
  }
  asyncSettingsSaveRunning = true;
  try {
    await writeSettingsPayload(paths, payload);
  } catch (error) {
    logger.error(`Async Settings-Save fehlgeschlagen: ${String(error)}`);
  } finally {
    asyncSettingsSaveRunning = false;
    if (asyncSettingsSaveQueued) {
      const queued = asyncSettingsSaveQueued;
      asyncSettingsSaveQueued = null;
      void writeSettingsPayload(queued.paths, queued.payload).catch((err) => logger.error(`Async Settings-Save (queued) fehlgeschlagen: ${String(err)}`));
    }
  }
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

  const primary = readSessionFile(paths.sessionFile);
  if (primary) {
    return primary;
  }

  const backupFile = sessionBackupPath(paths.sessionFile);
  const backup = fs.existsSync(backupFile) ? readSessionFile(backupFile) : null;
  if (backup) {
    logger.warn("Session defekt, Backup-Datei wird verwendet");
    try {
      const payload = JSON.stringify({ ...backup, updatedAt: Date.now() });
      const tempPath = sessionTempPath(paths.sessionFile, "sync");
      fs.writeFileSync(tempPath, payload, "utf8");
      syncRenameWithExdevFallback(tempPath, paths.sessionFile);
    } catch {
      // ignore restore write failure
    }
    return backup;
  }

  logger.error("Session konnte nicht geladen werden (auch Backup fehlgeschlagen)");
  return emptySession();
}

export function saveSession(paths: StoragePaths, session: SessionState): void {
  ensureBaseDir(paths.baseDir);
  if (fs.existsSync(paths.sessionFile)) {
    try {
      fs.copyFileSync(paths.sessionFile, sessionBackupPath(paths.sessionFile));
    } catch {
      // Best-effort backup; proceed even if it fails
    }
  }
  const payload = JSON.stringify({ ...session, updatedAt: Date.now() });
  const tempPath = sessionTempPath(paths.sessionFile, "sync");
  fs.writeFileSync(tempPath, payload, "utf8");
  syncRenameWithExdevFallback(tempPath, paths.sessionFile);
}

let asyncSaveRunning = false;
let asyncSaveQueued: { paths: StoragePaths; payload: string } | null = null;

async function writeSessionPayload(paths: StoragePaths, payload: string): Promise<void> {
  await fs.promises.mkdir(paths.baseDir, { recursive: true });
  await fsp.copyFile(paths.sessionFile, sessionBackupPath(paths.sessionFile)).catch(() => {});
  const tempPath = sessionTempPath(paths.sessionFile, "async");
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
}

async function saveSessionPayloadAsync(paths: StoragePaths, payload: string): Promise<void> {
  if (asyncSaveRunning) {
    asyncSaveQueued = { paths, payload };
    return;
  }
  asyncSaveRunning = true;
  try {
    await writeSessionPayload(paths, payload);
  } catch (error) {
    logger.error(`Async Session-Save fehlgeschlagen: ${String(error)}`);
  } finally {
    asyncSaveRunning = false;
    if (asyncSaveQueued) {
      const queued = asyncSaveQueued;
      asyncSaveQueued = null;
      void saveSessionPayloadAsync(queued.paths, queued.payload);
    }
  }
}

export async function saveSessionAsync(paths: StoragePaths, session: SessionState): Promise<void> {
  const payload = JSON.stringify({ ...session, updatedAt: Date.now() });
  await saveSessionPayloadAsync(paths, payload);
}

const MAX_HISTORY_ENTRIES = 500;

function normalizeHistoryEntry(raw: unknown, index: number): HistoryEntry | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  
  const id = asText(entry.id) || `hist-${Date.now().toString(36)}-${index}`;
  const name = asText(entry.name) || "Unbenannt";
  const providerRaw = asText(entry.provider);
  
  return {
    id,
    name,
    totalBytes: clampNumber(entry.totalBytes, 0, 0, Number.MAX_SAFE_INTEGER),
    downloadedBytes: clampNumber(entry.downloadedBytes, 0, 0, Number.MAX_SAFE_INTEGER),
    fileCount: clampNumber(entry.fileCount, 0, 0, 100000),
    provider: VALID_ITEM_PROVIDERS.has(providerRaw as DebridProvider) ? providerRaw as DebridProvider : null,
    completedAt: clampNumber(entry.completedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    durationSeconds: clampNumber(entry.durationSeconds, 0, 0, Number.MAX_SAFE_INTEGER),
    status: entry.status === "deleted" ? "deleted" : "completed",
    outputDir: asText(entry.outputDir)
  };
}

export function loadHistory(paths: StoragePaths): HistoryEntry[] {
  ensureBaseDir(paths.baseDir);
  if (!fs.existsSync(paths.historyFile)) {
    return [];
  }
  
  try {
    const raw = JSON.parse(fs.readFileSync(paths.historyFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < raw.length && entries.length < MAX_HISTORY_ENTRIES; i++) {
      const normalized = normalizeHistoryEntry(raw[i], i);
      if (normalized) entries.push(normalized);
    }
    return entries;
  } catch {
    return [];
  }
}

export function saveHistory(paths: StoragePaths, entries: HistoryEntry[]): void {
  ensureBaseDir(paths.baseDir);
  const trimmed = entries.slice(0, MAX_HISTORY_ENTRIES);
  const payload = JSON.stringify(trimmed, null, 2);
  const tempPath = `${paths.historyFile}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  syncRenameWithExdevFallback(tempPath, paths.historyFile);
}

export function addHistoryEntry(paths: StoragePaths, entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistory(paths);
  const updated = [entry, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  saveHistory(paths, updated);
  return updated;
}

export function removeHistoryEntry(paths: StoragePaths, entryId: string): HistoryEntry[] {
  const existing = loadHistory(paths);
  const updated = existing.filter(e => e.id !== entryId);
  saveHistory(paths, updated);
  return updated;
}

export function clearHistory(paths: StoragePaths): void {
  ensureBaseDir(paths.baseDir);
  if (fs.existsSync(paths.historyFile)) {
    try {
      fs.unlinkSync(paths.historyFile);
    } catch {
      // ignore
    }
  }
}
