import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getDebridLinkApiKeyIds } from "../shared/debrid-link-keys";
import { getMegaDebridAccountIds } from "../shared/mega-debrid-accounts";
import { AppSettings, BandwidthScheduleEntry, DebridFallbackProvider, DebridProvider, DownloadItem, DownloadStatus, HistoryEntry, HistoryRetentionMode, PackageEntry, PackagePriority, SessionState } from "../shared/types";
import { getProviderUsageDayKey } from "../shared/provider-daily-limits";
import { defaultSettings } from "./constants";
import { logger } from "./logger";

const VALID_PRIMARY_PROVIDERS = new Set(["realdebrid", "megadebrid-api", "megadebrid-web", "bestdebrid", "alldebrid", "ddownload", "onefichier", "debridlink", "linksnappy"]);
const VALID_FALLBACK_PROVIDERS = new Set(["none", "realdebrid", "megadebrid-api", "megadebrid-web", "bestdebrid", "alldebrid", "ddownload", "onefichier", "debridlink", "linksnappy"]);
const VALID_CLEANUP_MODES = new Set(["none", "trash", "delete"]);
const VALID_CONFLICT_MODES = new Set(["overwrite", "skip", "rename", "ask"]);
const VALID_FINISHED_POLICIES = new Set(["never", "immediate", "on_start", "package_done"]);
const VALID_SPEED_MODES = new Set(["global", "per_download"]);
const VALID_THEMES = new Set(["dark", "light"]);
const VALID_EXTRACT_CPU_PRIORITIES = new Set(["high", "middle", "low"]);
const VALID_HISTORY_RETENTION_MODES = new Set<HistoryRetentionMode>(["never", "session", "permanent"]);
const VALID_PACKAGE_PRIORITIES = new Set<string>(["high", "normal", "low"]);
const VALID_DOWNLOAD_STATUSES = new Set<DownloadStatus>([
  "queued", "validating", "downloading", "paused", "reconnect_wait", "extracting", "integrity_check", "completed", "failed", "cancelled"
]);
const VALID_ITEM_PROVIDERS = new Set<DebridProvider>(["realdebrid", "megadebrid", "megadebrid-api", "megadebrid-web", "bestdebrid", "alldebrid", "ddownload", "onefichier", "debridlink"]);
const VALID_ONLINE_STATUSES = new Set(["online", "offline", "checking"]);

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

function getPreferredMegaDebridProvider(megaDebridPreferApi: boolean, megaDebridApiEnabled: boolean, megaDebridWebEnabled: boolean): DebridProvider {
  if (megaDebridApiEnabled && !megaDebridWebEnabled) {
    return "megadebrid-api";
  }
  if (megaDebridWebEnabled && !megaDebridApiEnabled) {
    return "megadebrid-web";
  }
  return megaDebridPreferApi ? "megadebrid-api" : "megadebrid-web";
}

function normalizeConfiguredProvider(raw: unknown, megaDebridPreferApi: boolean, megaDebridApiEnabled: boolean, megaDebridWebEnabled: boolean): DebridProvider | null {
  const provider = String(raw ?? "").trim();
  if (!provider) {
    return null;
  }
  if (provider === "megadebrid") {
    return getPreferredMegaDebridProvider(megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled);
  }
  return VALID_PRIMARY_PROVIDERS.has(provider) ? provider as DebridProvider : null;
}

function normalizeFallbackProvider(raw: unknown, megaDebridPreferApi: boolean, megaDebridApiEnabled: boolean, megaDebridWebEnabled: boolean): DebridFallbackProvider {
  const provider = String(raw ?? "").trim();
  if (!provider || provider === "none") {
    return "none";
  }
  const normalized = normalizeConfiguredProvider(provider, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled);
  return normalized || "none";
}

function normalizeDisabledProviders(raw: unknown): DebridProvider[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<DebridProvider>();
  const result: DebridProvider[] = [];
  for (const entry of raw) {
    const provider = String(entry ?? "").trim();
    const candidates: DebridProvider[] = provider === "megadebrid"
      ? ["megadebrid-api", "megadebrid-web"]
      : (VALID_PRIMARY_PROVIDERS.has(provider) ? [provider as DebridProvider] : []);
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

function normalizeProviderByteMap(
  raw: unknown,
  megaDebridPreferApi: boolean,
  megaDebridApiEnabled: boolean,
  megaDebridWebEnabled: boolean,
  mergeMode: "max" | "sum"
): Partial<Record<DebridProvider, number>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Partial<Record<DebridProvider, number>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const provider = normalizeConfiguredProvider(key, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled);
    if (!provider) {
      continue;
    }
    const bytes = clampNumber(value, 0, 0, Number.MAX_SAFE_INTEGER);
    if (bytes <= 0) {
      continue;
    }
    if (mergeMode === "sum") {
      result[provider] = (result[provider] || 0) + bytes;
    } else {
      result[provider] = Math.max(result[provider] || 0, bytes);
    }
  }
  return result;
}

function normalizeNamedByteMap(raw: unknown, allowedKeys: readonly string[]): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const allowed = new Set(allowedKeys);
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || !allowed.has(normalizedKey)) {
      continue;
    }
    const bytes = clampNumber(value, 0, 0, Number.MAX_SAFE_INTEGER);
    if (bytes <= 0) {
      continue;
    }
    result[normalizedKey] = bytes;
  }
  return result;
}

function normalizeStringList(raw: unknown, allowedKeys: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const allowed = new Set(allowedKeys);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const normalized = String(entry || "").trim();
    if (!normalized || !allowed.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeHosterRouting(raw: unknown, megaDebridPreferApi: boolean, megaDebridApiEnabled: boolean, megaDebridWebEnabled: boolean): Record<string, DebridProvider> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, DebridProvider> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const hoster = String(key).trim().toLowerCase();
    const provider = normalizeConfiguredProvider(value, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled);
    if (hoster && provider) {
      result[hoster] = provider;
    }
  }
  return result;
}

function normalizeProviderOrder(
  raw: unknown,
  megaDebridPreferApi: boolean,
  megaDebridApiEnabled: boolean,
  megaDebridWebEnabled: boolean,
  legacyPrimary: unknown,
  legacySecondary: unknown,
  legacyTertiary: unknown
): DebridProvider[] {
  let list: unknown[] = [];

  if (Array.isArray(raw) && raw.length > 0) {
    list = raw;
  } else {
    // Migrate from old primary/secondary/tertiary
    const candidates = [legacyPrimary, legacySecondary, legacyTertiary].filter(
      (v) => v && String(v).trim() && String(v).trim() !== "none"
    );
    if (candidates.length > 0) {
      list = candidates;
    }
  }

  const seen = new Set<DebridProvider>();
  const result: DebridProvider[] = [];
  for (const entry of list) {
    const provider = normalizeConfiguredProvider(entry, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled);
    if (provider && !seen.has(provider)) {
      seen.add(provider);
      result.push(provider);
    }
  }
  return result;
}

const DEPRECATED_UPDATE_REPOS = new Set([
  "sucukdeluxe/real-debrid-downloader"
]);

function migrateUpdateRepo(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed || DEPRECATED_UPDATE_REPOS.has(trimmed.toLowerCase())) {
    return fallback;
  }
  return trimmed;
}

export function normalizeSettings(settings: AppSettings): AppSettings {
  const defaults = defaultSettings();
  const currentUsageDay = getProviderUsageDayKey();
  const megaLogin = asText(settings.megaLogin);
  const megaPassword = asText(settings.megaPassword);
  // Migrate legacy single-account to multi-account format
  let megaCredentials = String(settings.megaCredentials ?? "").replace(/\r\n|\r/g, "\n").trim();
  if (!megaCredentials && megaLogin && megaPassword) {
    megaCredentials = `${megaLogin}:${megaPassword}`;
  }
  const megaDebridAccountIds = getMegaDebridAccountIds(megaCredentials);
  const megaDebridPreferApi = settings.megaDebridPreferApi !== undefined ? Boolean(settings.megaDebridPreferApi) : true;
  const hasMegaCreds = Boolean(megaLogin && megaPassword);
  const megaDebridApiEnabled = settings.megaDebridApiEnabled !== undefined
    ? Boolean(settings.megaDebridApiEnabled)
    : (hasMegaCreds ? megaDebridPreferApi : defaults.megaDebridApiEnabled);
  const megaDebridWebEnabled = settings.megaDebridWebEnabled !== undefined
    ? Boolean(settings.megaDebridWebEnabled)
    : (hasMegaCreds ? !megaDebridPreferApi : defaults.megaDebridWebEnabled);
  const providerDailyUsageDayRaw = asText(settings.providerDailyUsageDay);
  const providerDailyUsageDay = /^\d{4}-\d{2}-\d{2}$/.test(providerDailyUsageDayRaw)
    ? providerDailyUsageDayRaw
    : currentUsageDay;
  const debridLinkApiKeyIds = getDebridLinkApiKeyIds(String(settings.debridLinkApiKeys ?? ""));
  const providerDailyUsageBytes = normalizeProviderByteMap(
    settings.providerDailyUsageBytes,
    megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled,
    "sum"
  );
  const providerTotalUsageBytes = normalizeProviderByteMap(
    settings.providerTotalUsageBytes,
    megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled,
    "sum"
  );
  const debridLinkApiKeyDailyLimitBytes = normalizeNamedByteMap(
    settings.debridLinkApiKeyDailyLimitBytes,
    debridLinkApiKeyIds
  );
  const debridLinkApiKeyDailyUsageBytes = normalizeNamedByteMap(
    settings.debridLinkApiKeyDailyUsageBytes,
    debridLinkApiKeyIds
  );
  const debridLinkApiKeyTotalUsageBytes = normalizeNamedByteMap(
    settings.debridLinkApiKeyTotalUsageBytes,
    debridLinkApiKeyIds
  );
  const debridLinkDisabledKeyIds = normalizeStringList(settings.debridLinkDisabledKeyIds, debridLinkApiKeyIds);
  const normalized: AppSettings = {
    token: asText(settings.token),
    realDebridUseWebLogin: Boolean(settings.realDebridUseWebLogin),
    megaLogin,
    megaPassword,
    megaCredentials,
    megaDebridApiEnabled,
    megaDebridWebEnabled,
    megaDebridPreferApi,
    bestToken: asText(settings.bestToken),
    bestDebridUseWebLogin: Boolean(settings.bestDebridUseWebLogin),
    allDebridToken: asText(settings.allDebridToken),
    allDebridUseWebLogin: Boolean(settings.allDebridUseWebLogin),
    ddownloadLogin: asText(settings.ddownloadLogin),
    ddownloadPassword: asText(settings.ddownloadPassword),
    oneFichierApiKey: asText(settings.oneFichierApiKey),
    debridLinkApiKeys: String(settings.debridLinkApiKeys ?? "").replace(/\r\n|\r/g, "\n").trim(),
    debridLinkDisabledKeyIds,
    linkSnappyLogin: asText(settings.linkSnappyLogin),
    linkSnappyPassword: asText(settings.linkSnappyPassword),
    archivePasswordList: String(settings.archivePasswordList ?? "").replace(/\r\n|\r/g, "\n"),
    rememberToken: Boolean(settings.rememberToken),
    providerOrder: normalizeProviderOrder(
      settings.providerOrder,
      megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled,
      settings.providerPrimary, settings.providerSecondary, settings.providerTertiary
    ),
    providerPrimary: normalizeConfiguredProvider(settings.providerPrimary, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled) || defaults.providerPrimary,
    providerSecondary: normalizeFallbackProvider(settings.providerSecondary, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled),
    providerTertiary: normalizeFallbackProvider(settings.providerTertiary, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled),
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
    updateRepo: migrateUpdateRepo(asText(settings.updateRepo), defaults.updateRepo),
    clipboardWatch: Boolean(settings.clipboardWatch),
    minimizeToTray: Boolean(settings.minimizeToTray),
    collapseNewPackages: settings.collapseNewPackages !== undefined ? Boolean(settings.collapseNewPackages) : defaults.collapseNewPackages,
    historyRetentionMode: VALID_HISTORY_RETENTION_MODES.has(settings.historyRetentionMode)
      ? settings.historyRetentionMode
      : defaults.historyRetentionMode,
    accountListShowDetailedDebridLinkKeys: settings.accountListShowDetailedDebridLinkKeys !== undefined
      ? Boolean(settings.accountListShowDetailedDebridLinkKeys)
      : defaults.accountListShowDetailedDebridLinkKeys,
    autoSortPackagesByProgress: settings.autoSortPackagesByProgress !== undefined ? Boolean(settings.autoSortPackagesByProgress) : defaults.autoSortPackagesByProgress,
    autoSkipExtracted: settings.autoSkipExtracted !== undefined ? Boolean(settings.autoSkipExtracted) : defaults.autoSkipExtracted,
    hideExtractedItems: settings.hideExtractedItems !== undefined ? Boolean(settings.hideExtractedItems) : defaults.hideExtractedItems,
    confirmDeleteSelection: settings.confirmDeleteSelection !== undefined ? Boolean(settings.confirmDeleteSelection) : defaults.confirmDeleteSelection,
    totalDownloadedAllTime: typeof settings.totalDownloadedAllTime === "number" && settings.totalDownloadedAllTime >= 0 ? settings.totalDownloadedAllTime : defaults.totalDownloadedAllTime,
    totalCompletedFilesAllTime: typeof settings.totalCompletedFilesAllTime === "number" && settings.totalCompletedFilesAllTime >= 0 ? settings.totalCompletedFilesAllTime : defaults.totalCompletedFilesAllTime,
    totalRuntimeAllTimeMs: typeof settings.totalRuntimeAllTimeMs === "number" && settings.totalRuntimeAllTimeMs >= 0 ? settings.totalRuntimeAllTimeMs : defaults.totalRuntimeAllTimeMs,
    theme: VALID_THEMES.has(settings.theme) ? settings.theme : defaults.theme,
    bandwidthSchedules: normalizeBandwidthSchedules(settings.bandwidthSchedules),
    columnOrder: normalizeColumnOrder(settings.columnOrder),
    extractCpuPriority: settings.extractCpuPriority,
    autoExtractWhenStopped: settings.autoExtractWhenStopped !== undefined ? Boolean(settings.autoExtractWhenStopped) : defaults.autoExtractWhenStopped,
    disabledProviders: normalizeDisabledProviders(settings.disabledProviders),
    hosterRouting: normalizeHosterRouting(settings.hosterRouting, megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled),
    providerDailyLimitBytes: normalizeProviderByteMap(
      settings.providerDailyLimitBytes,
      megaDebridPreferApi, megaDebridApiEnabled, megaDebridWebEnabled,
      "max"
    ),
    providerDailyUsageBytes: providerDailyUsageDay === currentUsageDay ? providerDailyUsageBytes : {},
    providerTotalUsageBytes,
    debridLinkApiKeyDailyLimitBytes,
    debridLinkApiKeyDailyUsageBytes: providerDailyUsageDay === currentUsageDay ? debridLinkApiKeyDailyUsageBytes : {},
    debridLinkApiKeyTotalUsageBytes,
    megaDebridDisabledAccountIds: normalizeStringList(settings.megaDebridDisabledAccountIds, megaDebridAccountIds),
    megaDebridAccountDailyLimitBytes: normalizeNamedByteMap(settings.megaDebridAccountDailyLimitBytes, megaDebridAccountIds),
    megaDebridAccountDailyUsageBytes: providerDailyUsageDay === currentUsageDay
      ? normalizeNamedByteMap(settings.megaDebridAccountDailyUsageBytes, megaDebridAccountIds)
      : {},
    megaDebridAccountTotalUsageBytes: normalizeNamedByteMap(settings.megaDebridAccountTotalUsageBytes, megaDebridAccountIds),
    providerDailyUsageDay: providerDailyUsageDay === currentUsageDay ? providerDailyUsageDay : currentUsageDay,
    scheduledStartEpochMs: clampNumber(settings.scheduledStartEpochMs, defaults.scheduledStartEpochMs, 0, Number.MAX_SAFE_INTEGER)
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
    realDebridUseWebLogin: settings.realDebridUseWebLogin,
    megaLogin: "",
    megaPassword: "",
    megaCredentials: "",
    bestToken: "",
    bestDebridUseWebLogin: settings.bestDebridUseWebLogin,
    allDebridToken: "",
    ddownloadLogin: "",
    ddownloadPassword: "",
    oneFichierApiKey: "",
    debridLinkApiKeys: "",
    linkSnappyLogin: "",
    linkSnappyPassword: ""
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

/** JSON replacer that sanitizes NaN/Infinity to null to prevent file corruption. */
function safeJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  return value;
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

export function normalizeLoadedSession(raw: unknown): SessionState {
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

    itemsById[id] = {
      id,
      packageId,
      url,
      provider: VALID_ITEM_PROVIDERS.has(providerRaw) ? providerRaw : null,
      providerLabel: asText(item.providerLabel) || undefined,
      providerAccountId: asText(item.providerAccountId) || undefined,
      providerAccountLabel: asText(item.providerAccountLabel) || undefined,
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
      onlineStatus: VALID_ONLINE_STATUSES.has(onlineStatusRaw) ? onlineStatusRaw as "online" | "offline" | "checking" : undefined,
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
      downloadStartedAt: clampNumber(pkg.downloadStartedAt, 0, 0, Number.MAX_SAFE_INTEGER),
      downloadCompletedAt: clampNumber(pkg.downloadCompletedAt, 0, 0, Number.MAX_SAFE_INTEGER),
      createdAt: clampNumber(pkg.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: clampNumber(pkg.updatedAt, now, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  let orphanedItemCount = 0;
  for (const [itemId, item] of Object.entries(itemsById)) {
    if (!packagesById[item.packageId]) {
      orphanedItemCount += 1;
      delete itemsById[itemId];
    }
  }
  if (orphanedItemCount > 0) {
    logger.warn(`normalizeLoadedSession: ${orphanedItemCount} verwaiste Items entfernt (fehlende Pakete)`);
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
    if (!seenOrder.has(packageId)) {
      seenOrder.add(packageId);
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
      const payload = JSON.stringify(backupLoaded, safeJsonReplacer, 2);
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

export function normalizeLoadedSessionTransientFields(session: SessionState): SessionState {
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

  // Reset package-level active statuses to queued (mirrors item reset above)
  const ACTIVE_PKG_STATUSES = new Set(["downloading", "validating", "extracting", "integrity_check", "paused", "reconnect_wait"]);
  for (const pkg of Object.values(session.packages)) {
    if (ACTIVE_PKG_STATUSES.has(pkg.status)) {
      pkg.status = "queued";
    }
    pkg.postProcessLabel = undefined;
  }

  // Clear stale session-level running/paused flags
  session.running = false;
  session.paused = false;

  return session;
}

function readSessionFile(filePath: string): SessionState | null {
  try {
    // Inline readFileSync into JSON.parse so the raw string is not bound to a
    // variable and can be GC'd immediately — avoids holding the full JSON text
    // and the parsed object graph in memory simultaneously.
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const session = normalizeLoadedSessionTransientFields(normalizeLoadedSession(parsed));
    const pkgCount = Object.keys(session.packages).length;
    const itemCount = Object.keys(session.items).length;
    logger.info(`Session geladen: ${filePath} (${pkgCount} Pakete, ${itemCount} Items)`);
    return session;
  } catch (error) {
    logger.error(`Session-Datei nicht lesbar: ${filePath}: ${String(error)}`);
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
  const payload = JSON.stringify(persisted, safeJsonReplacer, 2);
  const tempPath = `${paths.configFile}.tmp`;
  try {
    fs.writeFileSync(tempPath, payload, "utf8");
    syncRenameWithExdevFallback(tempPath, paths.configFile);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

let asyncSettingsSaveRunning = false;
let asyncSettingsSaveQueued: { paths: StoragePaths; settings: AppSettings } | null = null;

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
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw renameError;
    }
  }
}

export async function saveSettingsAsync(paths: StoragePaths, settings: AppSettings): Promise<void> {
  const persisted = sanitizeCredentialPersistence(normalizeSettings(settings));
  const payload = JSON.stringify(persisted, safeJsonReplacer, 2);
  if (asyncSettingsSaveRunning) {
    asyncSettingsSaveQueued = { paths, settings };
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
      void saveSettingsAsync(queued.paths, queued.settings);
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
    logger.info("Keine Session-Datei vorhanden, starte mit leerer Session");
    return emptySession();
  }

  const primary = readSessionFile(paths.sessionFile);
  const backupFile = sessionBackupPath(paths.sessionFile);

  // If primary loaded but is empty, check if backup has packages (safety net)
  if (primary) {
    const primaryPkgCount = Object.keys(primary.packages).length;
    if (primaryPkgCount === 0 && fs.existsSync(backupFile)) {
      const backup = readSessionFile(backupFile);
      if (backup) {
        const backupPkgCount = Object.keys(backup.packages).length;
        if (backupPkgCount > 0) {
          logger.warn(`Session-Datei ist leer (0 Pakete), aber Backup hat ${backupPkgCount} Pakete — verwende Backup`);
          try {
            const payload = JSON.stringify({ ...backup, updatedAt: Date.now() }, safeJsonReplacer);
            const tempPath = sessionTempPath(paths.sessionFile, "sync");
            fs.writeFileSync(tempPath, payload, "utf8");
            syncRenameWithExdevFallback(tempPath, paths.sessionFile);
          } catch {
            // ignore restore write failure
          }
          return backup;
        }
      }
    }
    return primary;
  }

  const backup = fs.existsSync(backupFile) ? readSessionFile(backupFile) : null;
  if (backup) {
    logger.warn("Session defekt, Backup-Datei wird verwendet");
    try {
      const payload = JSON.stringify({ ...backup, updatedAt: Date.now() }, safeJsonReplacer);
      const tempPath = sessionTempPath(paths.sessionFile, "sync");
      fs.writeFileSync(tempPath, payload, "utf8");
      syncRenameWithExdevFallback(tempPath, paths.sessionFile);
    } catch {
      // ignore restore write failure
    }
    return backup;
  }

  // Last resort: try to recover from temp files left by interrupted writes
  for (const kind of ["sync", "async"] as const) {
    const tmpPath = sessionTempPath(paths.sessionFile, kind);
    if (fs.existsSync(tmpPath)) {
      const tmpSession = readSessionFile(tmpPath);
      if (tmpSession && Object.keys(tmpSession.packages).length > 0) {
        logger.warn(`Session aus temporaerer Datei wiederhergestellt: ${tmpPath} (${Object.keys(tmpSession.packages).length} Pakete)`);
        try {
          const payload = JSON.stringify({ ...tmpSession, updatedAt: Date.now() }, safeJsonReplacer);
          fs.writeFileSync(paths.sessionFile, payload, "utf8");
        } catch {
          // ignore restore write failure
        }
        return tmpSession;
      }
    }
  }

  logger.error("Session konnte nicht geladen werden (Primary, Backup und Temp-Dateien fehlgeschlagen)");
  return emptySession();
}

export function saveSession(paths: StoragePaths, session: SessionState): void {
  syncSaveGeneration += 1;
  ensureBaseDir(paths.baseDir);
  if (fs.existsSync(paths.sessionFile)) {
    try {
      fs.copyFileSync(paths.sessionFile, sessionBackupPath(paths.sessionFile));
    } catch {
      // Best-effort backup; proceed even if it fails
    }
  }
  const payload = JSON.stringify({ ...session, updatedAt: Date.now() }, safeJsonReplacer);
  const tempPath = sessionTempPath(paths.sessionFile, "sync");
  try {
    fs.writeFileSync(tempPath, payload, "utf8");
    syncRenameWithExdevFallback(tempPath, paths.sessionFile);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

let asyncSaveRunning = false;
let asyncSaveQueued: { paths: StoragePaths; payload: string } | null = null;
let syncSaveGeneration = 0;

async function writeSessionPayload(paths: StoragePaths, payload: string, generation: number): Promise<void> {
  await fs.promises.mkdir(paths.baseDir, { recursive: true });
  await fsp.copyFile(paths.sessionFile, sessionBackupPath(paths.sessionFile)).catch(() => {});
  const tempPath = sessionTempPath(paths.sessionFile, "async");
  await fsp.writeFile(tempPath, payload, "utf8");
  // If a synchronous save occurred after this async save started, discard the stale write
  if (generation < syncSaveGeneration) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    return;
  }
  try {
    await fsp.rename(tempPath, paths.sessionFile);
  } catch (renameError: unknown) {
    if (renameError && typeof renameError === "object" && "code" in renameError && (renameError as NodeJS.ErrnoException).code === "EXDEV") {
      if (generation < syncSaveGeneration) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        return;
      }
      await fsp.copyFile(tempPath, paths.sessionFile);
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    } else {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
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
  const gen = syncSaveGeneration;
  try {
    await writeSessionPayload(paths, payload, gen);
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

export function cancelPendingAsyncSaves(): void {
  asyncSaveQueued = null;
  asyncSettingsSaveQueued = null;
  syncSaveGeneration += 1;
}

export async function saveSessionAsync(paths: StoragePaths, session: SessionState): Promise<void> {
  const payload = JSON.stringify({ ...session, updatedAt: Date.now() }, safeJsonReplacer);
  await saveSessionPayloadAsync(paths, payload);
}

const MAX_HISTORY_ENTRIES = 500;

export function normalizeHistoryEntry(raw: unknown, index: number): HistoryEntry | null {
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
    outputDir: asText(entry.outputDir),
    urls: Array.isArray(entry.urls) ? (entry.urls as unknown[]).map(String).filter(Boolean) : undefined
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
  const payload = JSON.stringify(trimmed, safeJsonReplacer, 2);
  const tempPath = `${paths.historyFile}.tmp`;
  try {
    fs.writeFileSync(tempPath, payload, "utf8");
    syncRenameWithExdevFallback(tempPath, paths.historyFile);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

export function addHistoryEntry(paths: StoragePaths, entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistory(paths);
  const updated = [entry, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  saveHistory(paths, updated);
  return updated;
}

export function loadHistoryForRetention(paths: StoragePaths, retentionMode: HistoryRetentionMode): HistoryEntry[] {
  return retentionMode === "never" ? [] : loadHistory(paths);
}

export function addHistoryEntryForRetention(paths: StoragePaths, retentionMode: HistoryRetentionMode, entry: HistoryEntry): HistoryEntry[] {
  if (retentionMode === "never") {
    return [];
  }
  return addHistoryEntry(paths, entry);
}

export function resetHistoryForRetention(paths: StoragePaths, retentionMode: HistoryRetentionMode): void {
  if (retentionMode === "permanent") {
    return;
  }
  clearHistory(paths);
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
