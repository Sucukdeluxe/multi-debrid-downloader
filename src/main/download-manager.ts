import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import {
  AllDebridHostInfo,
  AppSettings,
  DebridProvider,
  DownloadItem,
  DownloadStats,
  DownloadSummary,
  DownloadStatus,
  DuplicatePolicy,
  HistoryEntry,
  PackageEntry,
  PackagePriority,
  ParsedPackageInput,
  SessionState,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot, DebridAccountStatus } from "../shared/types";
import { parseDebridLinkApiKeys } from "../shared/debrid-link-keys";
import {
  addDebridLinkApiKeyDailyUsageBytes,
  addDebridLinkApiKeyTotalUsageBytes,
  addMegaDebridAccountDailyUsageBytes,
  addMegaDebridAccountTotalUsageBytes,
  addProviderDailyUsageBytes,
  addProviderTotalUsageBytes,
  getProviderUsageDayKey,
  isProviderDailyLimitReached
} from "../shared/provider-daily-limits";
import { REQUEST_RETRIES, SAMPLE_VIDEO_EXTENSIONS, SPEED_WINDOW_SECONDS, WRITE_BUFFER_SIZE, WRITE_FLUSH_TIMEOUT_MS, ALLOCATION_UNIT_SIZE, STREAM_HIGH_WATER_MARK, DISK_BUSY_THRESHOLD_MS, DISK_BUSY_STATUS_THRESHOLD_MS } from "./constants";
import { parseCollectorInput } from "./link-parser";

// Reference counter for NODE_TLS_REJECT_UNAUTHORIZED to avoid race conditions
// when multiple parallel downloads need TLS verification disabled (e.g. DDownload).
let tlsSkipRefCount = 0;
function acquireTlsSkip(): void {
  tlsSkipRefCount += 1;
  if (tlsSkipRefCount === 1) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}
function releaseTlsSkip(): void {
  tlsSkipRefCount -= 1;
  if (tlsSkipRefCount <= 0) {
    tlsSkipRefCount = 0;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
}
import { cleanupCancelledPackageArtifactsAsync, removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";
import { planDownloadCompletion, validateDownloadedFileCompletion } from "./download-completion";
import { AllDebridWebUnrestrictor, BestDebridWebUnrestrictor, DebridService, MegaWebUnrestrictor, RealDebridWebUnrestrictor, checkRapidgatorOnline, fetchAllDebridHostInfo, getAvailableDebridLinkApiKeys, pruneExpiredDebridLinkRuntimeState, pruneExpiredMegaDebridRuntimeState } from "./debrid";
import { cleanupArchives, clearExtractResumeState, collectArchiveCleanupTargets, detectArchiveSignature, extractPackageArchives, findArchiveCandidates, hasAnyFilesRecursive, removeEmptyDirectoryTree, resetExtractorCachesForPasswordChange, type ExtractArchiveFailureInfo } from "./extractor";
import { validateFileAgainstManifest } from "./integrity";
import { logger } from "./logger";
import { getRecentRotationEvents, runWithRotationItemSink, setRotationEventListener } from "./account-rotation-log";
import type { RotationEvent } from "../shared/types";
import { ensureItemLog, getItemLogPath as getPersistedItemLogPath, logItemEvent as writeItemLogEvent } from "./item-log";
import { ensurePackageLog, getPackageLogPath as getPersistedPackageLogPath, logPackageEvent as writePackageLogEvent } from "./package-log";
import { logRenameEvent as writeRenameLogEvent } from "./rename-log";
import { logDesktopRename, verifyRename, verifyRenameAsync, type RenameVerification } from "./desktop-rename-log";
import { StoragePaths, saveSession, saveSessionAsync, saveSettings, saveSettingsAsync } from "./storage";
import { compactErrorText, ensureDirPath, filenameFromUrl, formatEta, humanSize, looksLikeOpaqueFilename, nowMs, sanitizeFilename, sleep } from "./utils";

type ActiveTask = {
  itemId: string;
  packageId: string;
  abortController: AbortController;
  abortReason: "stop" | "cancel" | "reconnect" | "package_toggle" | "stall" | "shutdown" | "reset" | "none";
  resumable: boolean;
  nonResumableCounted: boolean;
  freshRetryUsed?: boolean;
  resumeHardResetUsed?: boolean;
  stallRetries?: number;
  genericErrorRetries?: number;
  unrestrictRetries?: number;
  blockedOnDiskWrite?: boolean;
  blockedOnDiskSince?: number;
};

type PackageItemDiskState = {
  diskPath: string | null;
  exists: boolean;
  size: number;
  minBytes: number;
  fullOnDisk: boolean;
  persistedBytesReady: boolean;
  reason: "ok" | "missing_path" | "missing_file" | "too_small" | "persisted_shortfall";
};

type HybridFailedArchiveState = {
  marker: string;
  lastError: string;
  updatedAt: number;
};

const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 10000;

const DEFAULT_DOWNLOAD_CONNECT_TIMEOUT_MS = 25000;

const DEFAULT_GLOBAL_STALL_WATCHDOG_TIMEOUT_MS = 60000;

const DEFAULT_POST_EXTRACT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const EXTRACT_PROGRESS_EMIT_INTERVAL_MS = 260;

const DEFAULT_UNRESTRICT_TIMEOUT_MS = 60000;

const DEFAULT_LOW_THROUGHPUT_TIMEOUT_MS = 120000;

const DEFAULT_LOW_THROUGHPUT_MIN_BYTES = 64 * 1024;

const MINI_DOWNLOAD_RETRY_THRESHOLD_BYTES = 5 * 1024;

const ALLDEBRID_HOST_INFO_TTL_MS = 60000;

const ALLDEBRID_START_STAGGER_MS = 3000;

const ARCHIVE_SETTLE_MIN_DELAY_MS = 1500;

const ARCHIVE_SETTLE_POLL_MS = 250;

const ARCHIVE_SETTLE_MAX_WAIT_MS = 5000;

const MAX_SAME_DIRECT_URL_ATTEMPTS = 3;

const RESUME_REWIND_BYTES = 256 * 1024;

const REALDEBRID_TOTAL_MISMATCH_TOLERANCE_BYTES = 64 * 1024;

const PREALLOC_RESUME_MISMATCH_THRESHOLD_BYTES = 1024 * 1024;

const LARGE_BINARY_FILE_RE = /\.(?:part\d+\.rar|rar|r\d{2,3}|zip(?:\.\d+)?|7z(?:\.\d+)?|tar|gz|bz2|xz|iso|mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|webm|mp3|flac|aac|wav)$/i;

/** Files that are legitimately tiny (< 5 KB) and should NOT be rejected as suspicious. */
const KNOWN_SMALL_FILE_RE = /\.(?:sfv|nfo|nzb|md5|sha1|sha256|crc|txt|url|lnk|srr)$/i;

/** Folder name patterns indicating bonus/extras content that should NOT be moved
 *  to the flat MKV library or auto-renamed. Matches after normalizing separators
 *  (so "Making.Of", "making-of", "making of", "makingof" all match "makingof"). */
const BONUS_DIR_NORMALIZED_PATTERNS = [
  "extras", "extra", "bonus", "featurettes", "featurette",
  "specials", "specialfeatures",
  "behindthescenes", "deletedscenes", "deletedscene",
  "makingof", "outtakes", "trailers", "interviews", "documentaries",
  "alternateending", "gagreel"
];

/** Filename token patterns for bonus content (e.g. "making-of-e02.mkv"). */
const BONUS_FILENAME_RE = /(?:^|[._\-\s])(?:making[._\-\s]?of|behind[._\-\s]?the[._\-\s]?scenes|deleted[._\-\s]?scene|alternate[._\-\s]?ending|gag[._\-\s]?reel|featurette|outtakes?|bloopers?|interview|extended[._\-\s]?scene|exclusive[._\-\s]?scene|inside[._\-\s]?e\d+|making[._\-\s]?of[._\-\s]?e\d+)(?:[._\-\s]|$)/i;

/** Normalize a folder/file segment for bonus-pattern matching: lowercase and
 *  strip common separators so "Making.Of" → "makingof". */
function normalizeBonusSegment(segment: string): string {
  return String(segment || "").toLowerCase().replace(/[._\-\s]+/g, "");
}

/** Detect if a file path lies inside a bonus/extras subdirectory of the package.
 *  Walks up the path from filePath until packageDir and checks each segment. */
function isInsideBonusDir(filePath: string, packageDir: string): boolean {
  if (!filePath || !packageDir) return false;
  let current = path.dirname(filePath);
  const root = path.resolve(packageDir);
  let safety = 0;
  while (current && safety++ < 32) {
    const resolvedCurrent = path.resolve(current);
    if (resolvedCurrent === root) return false;
    if (!isPathInsideDir(current, packageDir)) return false;
    const normalized = normalizeBonusSegment(path.basename(current));
    for (const pattern of BONUS_DIR_NORMALIZED_PATTERNS) {
      if (normalized.includes(pattern)) return true;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return false;
}

function expectedMinBytes(totalBytes: number | null | undefined, strict: boolean): number {
  if (!totalBytes || totalBytes <= 0) {
    return 10240;
  }
  return strict ? totalBytes : Math.max(10240, totalBytes - ALLOCATION_UNIT_SIZE);
}

function itemExpectedMinBytes(item: DownloadItem): number {
  const strict = isLargeBinaryLikePath(item.targetPath || item.fileName || "");
  return expectedMinBytes(item.totalBytes, strict);
}

function resolvePreallocResumeMismatchThreshold(pathHint: string): number {
  return isLargeBinaryLikePath(pathHint)
    ? 0
    : PREALLOC_RESUME_MISMATCH_THRESHOLD_BYTES;
}

function resolvePackageItemDiskPath(pkg: PackageEntry, item: DownloadItem): string | null {
  if (item.targetPath) {
    return item.targetPath;
  }
  if (item.fileName && pkg.outputDir) {
    return path.join(pkg.outputDir, item.fileName);
  }
  return null;
}

function inspectPackageItemDiskState(pkg: PackageEntry, item: DownloadItem): PackageItemDiskState {
  const minBytes = itemExpectedMinBytes(item);
  const diskPath = resolvePackageItemDiskPath(pkg, item);
  if (!diskPath) {
    return {
      diskPath: null,
      exists: false,
      size: 0,
      minBytes,
      fullOnDisk: false,
      persistedBytesReady: false,
      reason: "missing_path"
    };
  }

  try {
    const stat = fs.statSync(diskPath);
    const fullOnDisk = stat.size >= minBytes;
    const persistedBytesReady = item.downloadedBytes >= minBytes;
    return {
      diskPath,
      exists: true,
      size: stat.size,
      minBytes,
      fullOnDisk,
      persistedBytesReady,
      reason: !fullOnDisk
        ? "too_small"
        : !persistedBytesReady
          ? "persisted_shortfall"
          : "ok"
    };
  } catch {
    return {
      diskPath,
      exists: false,
      size: 0,
      minBytes,
      fullOnDisk: false,
      persistedBytesReady: false,
      reason: "missing_file"
    };
  }
}

function stripArchiveSuffixForMatching(fileName: string): string {
  const trimmed = path.basename(String(fileName || "").trim());
  if (!trimmed) {
    return "";
  }
  let next = trimmed.replace(/\.(?:part\d+\.rar|zip\.\d+|7z\.\d+|rar|r\d{2,3}|zip|7z|\d{3})$/i, "");
  next = next.replace(/\.part\d+$/i, "").replace(/\.vol\d+[+\d]*$/i, "");
  return next.toLowerCase();
}

function isPreferredArchiveEntryPointName(fileName: string): boolean {
  const normalized = path.basename(String(fileName || "").trim()).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\.part0*1\.rar$/.test(normalized)
    || (/\.rar$/.test(normalized) && !/\.part\d+\.rar$/.test(normalized) && !/\.r\d{2,3}$/.test(normalized))
    || /\.zip\.001$/.test(normalized)
    || /\.7z\.001$/.test(normalized)
    || (/\.001$/.test(normalized) && !/\.(zip|7z)\.001$/.test(normalized));
}

function getDownloadStallTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_STALL_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 2000 && fromEnv <= 600000) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS;
}

function getDownloadConnectTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_CONNECT_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 250 && fromEnv <= 180000) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_DOWNLOAD_CONNECT_TIMEOUT_MS;
}

function getGlobalStallWatchdogTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_GLOBAL_STALL_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv)) {
    if (fromEnv <= 0) {
      return 0;
    }
    if (fromEnv >= 2000 && fromEnv <= 600000) {
      return Math.floor(fromEnv);
    }
  }
  return DEFAULT_GLOBAL_STALL_WATCHDOG_TIMEOUT_MS;
}

function getPostExtractTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_POST_EXTRACT_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 2000 && fromEnv <= 24 * 60 * 60 * 1000) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_POST_EXTRACT_TIMEOUT_MS;
}

function getUnrestrictTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_UNRESTRICT_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 5000 && fromEnv <= 15 * 60 * 1000) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_UNRESTRICT_TIMEOUT_MS;
}

function getLowThroughputTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_LOW_THROUGHPUT_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 30000 && fromEnv <= 20 * 60 * 1000) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_LOW_THROUGHPUT_TIMEOUT_MS;
}

function getLowThroughputMinBytes(): number {
  const fromEnv = Number(process.env.RD_LOW_THROUGHPUT_MIN_BYTES ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 1024 && fromEnv <= 32 * 1024 * 1024) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_LOW_THROUGHPUT_MIN_BYTES;
}

function normalizeRetryLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return REQUEST_RETRIES;
  }
  return Math.max(0, Math.min(99, Math.floor(num)));
}

function retryLimitLabel(retryLimit: number): string {
  return retryLimit <= 0 ? "inf" : String(retryLimit);
}

function retryLimitToMaxRetries(retryLimit: number): number {
  return retryLimit <= 0 ? Number.MAX_SAFE_INTEGER : retryLimit;
}

type HistoryEntryCallback = (entry: HistoryEntry) => void;

type DownloadManagerOptions = {
  megaWebUnrestrict?: MegaWebUnrestrictor;
  allDebridWebUnrestrict?: AllDebridWebUnrestrictor;
  realDebridWebUnrestrict?: RealDebridWebUnrestrictor;
  bestDebridWebUnrestrict?: BestDebridWebUnrestrictor;
  invalidateMegaSession?: () => void;
  onHistoryEntry?: HistoryEntryCallback;
};

function generateHistoryId(): string {
  return `hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stable empty object reference reused for snapshots when no package speeds
 *  are active. Avoids allocating a fresh `{}` per snapshot which breaks
 *  React.memo()/useMemo dependency comparisons in the renderer. */
const EMPTY_PACKAGE_SPEED_BPS: Readonly<Record<string, number>> = Object.freeze({});

function cloneSession(session: SessionState): SessionState {
  // Shallow clone only — items/packages are emitted to the renderer via IPC,
  // which runs structuredClone() on the payload in the same event-loop tick
  // (so the renderer always gets an isolated deep copy). All in-process
  // consumers of getSnapshot() (app-controller, debug-server, link export)
  // read the snapshot synchronously without mutating it. Doing a per-item
  // shallow clone here was a redundant ~5000 object allocations per emit
  // for a 5000-item queue. Cloning only the outer Records keeps consumers
  // safe from later additions/removals while avoiding per-item allocation.
  return {
    ...session,
    packageOrder: [...session.packageOrder],
    packages: { ...session.packages },
    items: { ...session.items }
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    bandwidthSchedules: (settings.bandwidthSchedules || []).map((entry) => ({ ...entry })),
    providerDailyLimitBytes: { ...(settings.providerDailyLimitBytes || {}) },
    providerDailyUsageBytes: { ...(settings.providerDailyUsageBytes || {}) },
    providerTotalUsageBytes: { ...(settings.providerTotalUsageBytes || {}) },
    debridLinkApiKeyDailyLimitBytes: { ...(settings.debridLinkApiKeyDailyLimitBytes || {}) },
    debridLinkApiKeyDailyUsageBytes: { ...(settings.debridLinkApiKeyDailyUsageBytes || {}) },
    debridLinkApiKeyTotalUsageBytes: { ...(settings.debridLinkApiKeyTotalUsageBytes || {}) }
  };
}

type ParsedContentRange = {
  start: number;
  end: number;
  total: number | null;
};

function parseContentRange(contentRange: string | null): ParsedContentRange | null {
  if (!contentRange) {
    return null;
  }
  const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }
  if (total !== null && (!Number.isFinite(total) || total <= 0 || end >= total)) {
    return null;
  }
  return { start, end, total };
}

function parseContentRangeTotal(contentRange: string | null): number | null {
  return parseContentRange(contentRange)?.total ?? null;
}

function parseContentDispositionFilename(contentDisposition: string | null): string {
  if (!contentDisposition) {
    return "";
  }

  const encodedMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch?.[1]) {
    let value = encodedMatch[1].trim();
    value = value.replace(/^[A-Za-z0-9._-]+(?:'[^']*)?'/, "");
    value = value.replace(/^['"]+|['"]+$/g, "");
    try {
      const decoded = decodeURIComponent(value).trim();
      if (decoded) {
        return decoded;
      }
    } catch {
      if (value) {
        return value;
      }
    }
  }

  const plainMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (!plainMatch?.[1]) {
    return "";
  }
  return plainMatch[1].trim().replace(/^['"]+|['"]+$/g, "");
}

function isArchiveLikePath(filePath: string): boolean {
  const lower = path.basename(filePath).toLowerCase();
  return /\.(?:part\d+\.rar|rar|r\d{2,3}|zip(?:\.\d+)?|z\d{1,3}|7z(?:\.\d+)?)$/i.test(lower);
}

function extractHosterKey(link: string): string {
  try {
    const host = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return "";
  }
}

function isLargeBinaryLikePath(filePath: string): boolean {
  const lower = path.basename(String(filePath || "")).toLowerCase();
  return isArchiveLikePath(lower) || LARGE_BINARY_FILE_RE.test(lower);
}

function shouldRejectSuspiciousSmallDownload(
  filePath: string,
  fileName: string,
  fileSizeOnDisk: number,
  expectedTotal: number | null
): boolean {
  const size = Math.max(0, Math.floor(Number(fileSizeOnDisk) || 0));
  const expected = Number.isFinite(expectedTotal || NaN) ? Math.max(0, Math.floor(expectedTotal || 0)) : 0;
  const binaryLike = isLargeBinaryLikePath(filePath || fileName);
  const name = path.basename(String(filePath || fileName || ""));

  // Known small files (e.g. .sfv, .nfo) are legitimately tiny — never reject them
  // as long as they received the expected number of bytes (or we have no expectation).
  if (KNOWN_SMALL_FILE_RE.test(name) && (expected <= 0 || size >= expected)) {
    return false;
  }

  if (size <= 0) {
    return expected > 0 || binaryLike;
  }
  if (size < 512) {
    if (expected > 0 && size >= expected && binaryLike) {
      return false;
    }
    return true;
  }
  if (size >= MINI_DOWNLOAD_RETRY_THRESHOLD_BYTES) {
    return false;
  }
  if (expected >= MINI_DOWNLOAD_RETRY_THRESHOLD_BYTES) {
    return true;
  }
  return binaryLike;
}

function isFetchFailure(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("fetch failed") || text.includes("socket hang up") || text.includes("econnreset") || text.includes("network error");
}

function shouldRewindResumeTail(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  if (!text) {
    return false;
  }
  return text.includes("terminated")
    || text.includes("stall_timeout")
    || text.includes("slow_throughput")
    || text.includes("write_drain_timeout")
    || text.includes("premature close")
    || text.includes("unexpected eof")
    || text.includes("download_underflow")
    || isFetchFailure(text);
}

function isHttp416Text(errorText: string): boolean {
  return /(^|\D)416(\D|$)/.test(String(errorText || ""));
}

function shouldPreflightFinalizeItemFromDisk(item: DownloadItem): boolean {
  const text = `${item.fullStatus || ""} ${item.lastError || ""}`.toLowerCase();
  return text.includes("resume-link erneuern")
    || text.includes("resume link erneuern")
    || text.includes("direktlink erneuern")
    || text.includes("direktlink erschöpft")
    || text.includes("direct_link_retry_exhausted")
    || text.includes("download_underflow")
    || text.includes("resume_download_underflow")
    || text.includes("range_ignored_on_resume")
    || text.includes("server ignorierte range");
}

function isResumeHardResetReason(errorText: string): boolean {
  const text = String(errorText || "");
  return text.startsWith("resume_download_underflow:");
}

function isRealDebridProvider(provider: string | null | undefined): boolean {
  return String(provider || "").trim().toLowerCase() === "realdebrid";
}

export function getAuthoritativeRealDebridTotal(
  provider: string | null | undefined,
  knownTotal: number,
  existingBytes: number,
  responseStatus: number,
  contentLength: number,
  totalFromRange: number | null,
  resumeHardResetUsed: boolean
): { totalBytes: number; source: "content-range" | "content-length"; mismatchBytes: number } | null {
  if (!isRealDebridProvider(provider) || !knownTotal || knownTotal <= 0) {
    return null;
  }

  const evaluateCandidate = (
    candidateTotal: number,
    source: "content-range" | "content-length"
  ): { totalBytes: number; source: "content-range" | "content-length"; mismatchBytes: number } | null => {
    if (!Number.isFinite(candidateTotal) || candidateTotal <= 0 || candidateTotal >= knownTotal) {
      return null;
    }

    const mismatchBytes = knownTotal - candidateTotal;
    if (mismatchBytes > REALDEBRID_TOTAL_MISMATCH_TOLERANCE_BYTES) {
      return null;
    }

    if (candidateTotal + ALLOCATION_UNIT_SIZE < existingBytes) {
      return null;
    }

    if (responseStatus === 206) {
      if (existingBytes <= 0) {
        return null;
      }
      const maxReachableBytes = existingBytes + Math.max(0, contentLength);
      if (candidateTotal > maxReachableBytes + ALLOCATION_UNIT_SIZE) {
        return null;
      }
    } else if (responseStatus === 200) {
      if (!resumeHardResetUsed || source !== "content-length") {
        return null;
      }
    } else {
      return null;
    }

    return {
      totalBytes: candidateTotal,
      source,
      mismatchBytes
    };
  };

  return evaluateCandidate(totalFromRange || 0, "content-range")
    || evaluateCandidate(contentLength, "content-length");
}

function isPermanentLinkError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("permanent ungültig")
    || /file.?not.?found/.test(text)
    || /file.?unavailable/.test(text)
    || /link.?is.?dead/.test(text)
    || text.includes("file has been removed")
    || text.includes("file has been deleted")
    || text.includes("file is no longer available")
    || text.includes("file was removed")
    || text.includes("file was deleted");
}

function isUnrestrictFailure(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("unrestrict") || text.includes("debrid-link") || text.includes("debrid_link_")
    || text.includes("mega-web") || text.includes("mega-debrid")
    || text.includes("bestdebrid") || text.includes("alldebrid") || text.includes("kein debrid")
    || text.includes("session-cookie") || text.includes("session cookie") || text.includes("session blockiert")
    || text.includes("session expired") || text.includes("invalid session")
    || text.includes("login ungültig") || text.includes("login liefert")
    || text.includes("login required") || text.includes("login failed");
}

function parseDebridLinkCooldownRetry(errorText: string): { delayMs: number; detail: string } | null {
  const match = String(errorText || "").match(/debrid_link_cooldown:(\d+):(.*)$/i);
  if (!match) {
    return null;
  }
  const delayMs = Math.max(1000, Math.min(15 * 60 * 1000, Number(match[1]) || 0));
  const detail = String(match[2] || "").trim();
  if (!delayMs) {
    return null;
  }
  return { delayMs, detail };
}

function parseDebridLinkTerminalFailure(errorText: string): { kind: "invalid_all" | "no_active_key"; detail: string } | null {
  const raw = String(errorText || "");
  const match = raw.match(/debrid_link_(invalid_all|no_active_key):(.*)$/i);
  if (!match) {
    if (/debrid-link.+(deaktiviert|ausgeschopft|kein aktiver api-key)/i.test(raw)) {
      return {
        kind: "no_active_key",
        detail: raw.trim()
      };
    }
    return null;
  }
  const kind = String(match[1] || "").toLowerCase() === "invalid_all" ? "invalid_all" : "no_active_key";
  const detail = String(match[2] || "").trim();
  return {
    kind,
    detail: detail || "Debrid-Link ist aktuell nicht verfuegbar"
  };
}

function isProviderBusyUnrestrictError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("too many active")
    || text.includes("too many concurrent")
    || text.includes("too many downloads")
    || text.includes("active download")
    || text.includes("concurrent limit")
    || text.includes("slot limit")
    || text.includes("limit reached")
    || text.includes("zu viele aktive")
    || text.includes("zu viele gleichzeitige")
    || text.includes("zu viele downloads");
}

function isHosterUnavailableError(errorText: string): boolean {
  return String(errorText || "").toLowerCase().includes("hosternotavailable");
}

function isTemporaryUnrestrictError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("server error")
    || text.includes("internal server error")
    || text.includes("notdebrid")
    || text.includes("unable to generate link")
    || text.includes("kann aktuell nicht generiert werden")
    || text.includes("temporarily unavailable")
    || text.includes("temporary unavailable")
    || text.includes("temporarily disabled")
    || text.includes("try again later")
    || text.includes("service unavailable")
    || text.includes("host is down")
    || text.includes("maintenance")
    || text.includes("bad gateway")
    || text.includes("gateway timeout")
    || text.includes("cloudflare")
    || text.includes("worker error");
}

function isFinishedStatus(status: DownloadStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isExtractedLabel(statusText: string): boolean {
  return /^entpackt\b/i.test(String(statusText || "").trim());
}

function isExtractErrorLabel(statusText: string): boolean {
  const text = String(statusText || "").trim();
  return /^entpacken\b/i.test(text) && /\berror\b/i.test(text)
    || /^entpack-fehler\b/i.test(text)
    || /^entpacken\b.*\btimeout\b/i.test(text);
}

function isTransientExtractStatus(statusText: string): boolean {
  const text = String(statusText || "").trim();
  return /^entpacken\b/i.test(text)
    || /^passwort\b/i.test(text)
    || /^finalisieren\b/i.test(text);
}

function shouldAutoRetryExtraction(statusText: string): boolean {
  return !isExtractedLabel(statusText) && !isExtractErrorLabel(statusText);
}

function shouldPreserveExtractionResumeLabel(statusText: string): boolean {
  const text = String(statusText || "").trim();
  return isTransientExtractStatus(text) || /^entpacken abgebrochen\b/i.test(text);
}

function formatExtractDone(elapsedMs: number): string {
  if (elapsedMs < 1000) return "Entpackt - Done (<1s)";
  const secs = elapsedMs / 1000;
  return secs < 100
    ? `Entpackt - Done (${secs.toFixed(1)}s)`
    : `Entpackt - Done (${Math.round(secs)}s)`;
}

function providerLabel(provider: DownloadItem["provider"]): string {
  if (provider === "realdebrid") {
    return "Real-Debrid";
  }
  if (provider === "megadebrid") {
    return "Mega-Debrid";
  }
  if (provider === "megadebrid-api") {
    return "Mega-Debrid API";
  }
  if (provider === "megadebrid-web") {
    return "Mega-Debrid Web";
  }
  if (provider === "bestdebrid") {
    return "BestDebrid";
  }
  if (provider === "alldebrid") {
    return "AllDebrid";
  }
  if (provider === "ddownload") {
    return "DDownload";
  }
  if (provider === "onefichier") {
    return "1Fichier";
  }
  if (provider === "debridlink") {
    return "Debrid-Link";
  }
  if (provider === "linksnappy") {
    return "LinkSnappy";
  }
  return "Debrid";
}

function resolveMegaDebridProvider(settings: AppSettings, provider: DebridProvider | null): DebridProvider | null {
  if (provider !== "megadebrid") {
    return provider;
  }
  const apiEnabled = settings.megaDebridApiEnabled
    || (settings.megaLogin.trim() && settings.megaPassword.trim() && !settings.megaDebridApiEnabled && !settings.megaDebridWebEnabled && settings.megaDebridPreferApi);
  const webEnabled = settings.megaDebridWebEnabled
    || (settings.megaLogin.trim() && settings.megaPassword.trim() && !settings.megaDebridApiEnabled && !settings.megaDebridWebEnabled && !settings.megaDebridPreferApi);
  if (apiEnabled && !webEnabled) {
    return "megadebrid-api";
  }
  if (webEnabled && !apiEnabled) {
    return "megadebrid-web";
  }
  return settings.megaDebridPreferApi ? "megadebrid-api" : "megadebrid-web";
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const file = pathKey(filePath);
  const dir = pathKey(dirPath);
  if (file === dir) {
    return true;
  }
  const withSep = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return file.startsWith(withSep);
}

const EMPTY_DIR_IGNORED_FILE_NAMES = new Set([
  "thumbs.db",
  "desktop.ini",
  ".ds_store"
]);
const EMPTY_DIR_IGNORED_FILE_RE = /^\.rd_extract_progress(?:_[^.\\/]+)?\.json$/i;

function isIgnorableEmptyDirFileName(fileName: string): boolean {
  const normalized = String(fileName || "").trim().toLowerCase();
  return EMPTY_DIR_IGNORED_FILE_NAMES.has(normalized) || EMPTY_DIR_IGNORED_FILE_RE.test(normalized);
}

/** Kopfzeile fuer eine Rename-Verifikation im Desktop-Log (passend zum Level). */
function verifyHeadline(v: RenameVerification): string {
  if (v.ok) {
    return "Rename verifiziert";
  }
  if (v.level === "WARN") {
    return "Rename vollzogen, aber Schreibweise nicht verifiziert";
  }
  return "Rename meldet OK, aber Verifikation FEHLGESCHLAGEN";
}

function toWindowsLongPathIfNeeded(filePath: string): string {
  const absolute = path.resolve(String(filePath || ""));
  if (process.platform !== "win32") {
    return absolute;
  }
  if (!absolute || absolute.startsWith("\\\\?\\")) {
    return absolute;
  }
  if (absolute.length < 248) {
    return absolute;
  }
  if (absolute.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${absolute.slice(2)}`;
  }
  return `\\\\?\\${absolute}`;
}

const SCENE_RELEASE_FOLDER_RE = /-(?:4sf|4sj)$/i;
const SCENE_GROUP_SUFFIX_RE = /-(?=[A-Za-z0-9]{2,}$)(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]+$/;
const SCENE_EPISODE_RE = /(?:^|[._\-\s])s(\d{1,2})e(\d{1,3})(?:e(\d{1,3}))?(?!\d)/i;
const SCENE_EPISODE_JOINED_RE = /s(\d{1,2})e(\d{1,3})(?:e(\d{1,3}))?(?!\d)/i;
// Scene typo: "S05S01" instead of "S05E01" — second S should be E
const SCENE_EPISODE_TYPO_SS_RE = /(?:^|[._\-\s])s(\d{1,2})s(\d{1,3})(?!\d)/i;
const SCENE_SEASON_ONLY_RE = /(^|[._\-\s])s\d{1,2}(?=[._\-\s]|$)/i;

/** True iff the name has at least 3 alphabetic characters BEFORE the first
 *  SxxExx / Sxx token. Used to distinguish folders/files with a real series
 *  name ("Desperate.Housewives.S01...") from generic season labels
 *  ("S01 Complete", "Season 1"). */
export function hasMeaningfulSeriesPrefix(name: string): boolean {
  const text = String(name || "");
  const seasonMatch = text.match(/(?:^|[._\-\s])s\d{1,2}/i);
  if (!seasonMatch || seasonMatch.index === undefined) {
    return false;
  }
  const prefix = text.slice(0, seasonMatch.index);
  const alphaChars = (prefix.match(/[A-Za-z]/g) || []).length;
  return alphaChars >= 3;
}

/** Heuristic: returns true if the file name LOOKS LIKE an obfuscated /
 *  scrambled hoster name (e.g. "awa-diethundermans02e16hd.mkv") rather than
 *  a clean scene release ("the.royals.2015.s01e09.german.dl.720p.bluray.x264-j4f.mkv").
 *
 *  Used as a guard before we override a source-derived episode token with
 *  a folder-derived one. A clean scene file's embedded SxxExx is
 *  authoritative — overriding it would mislabel the episode. Only files
 *  that lack the usual scene markers (quality, language, codec, source/
 *  format) are treated as obfuscated and let the folder win.
 *
 *  Threshold: < 2 scene markers AND no proper dot-separated scene
 *  structure → considered obfuscated. */
export function looksLikeObfuscatedSceneFileName(name: string): boolean {
  const text = String(name || "").toLowerCase();
  if (!text) {
    return true;
  }
  let markers = 0;
  if (/(?:^|[._\-\s])(?:480|540|576|720|1080|1440|2160|4320)p(?:[._\-\s]|$)/.test(text)) markers += 1;
  if (/(?:^|[._\-\s])(?:german|english|french|italian|spanish|dutch|nordic|multi|ger|eng|ita|fre|spa)(?:[._\-\s]|$)/.test(text)) markers += 1;
  if (/(?:^|[._\-\s])(?:bluray|brrip|bdrip|webrip|web-?dl|web|hdtv|dvdrip|amazonhd|amzn|nflx|nf|hulu|dsnp)(?:[._\-\s]|$)/.test(text)) markers += 1;
  if (/(?:^|[._\-\s])(?:x264|x265|h264|h265|hevc|xvid|divx|avc)(?:[._\-\s]|$)/.test(text)) markers += 1;
  if (/(?:^|[._\-\s])(?:ac3|aac|dd5\.?1|dd51|dts|eac3|atmos|truehd|flac)(?:[._\-\s]|$)/.test(text)) markers += 1;
  // 2+ scene markers → definitely a clean scene file, not obfuscated
  if (markers >= 2) {
    return false;
  }
  // No markers AND looks like glued/short hoster code → obfuscated
  // Check for typical hoster pattern: short prefix + glued lowercase + episode digits
  // e.g. "awa-diethundermans02e16hd", "scn-dthund7-S02E06"
  const dotCount = (text.match(/\./g) || []).length;
  // A clean scene file usually has 6+ dot-separated tokens (excluding extension)
  // An obfuscated file usually has 0-2 dots (mostly using - or no separators).
  if (dotCount >= 5) {
    // Many dots usually means scene-style structure even with few markers
    return false;
  }
  return true;
}
const SCENE_SEASON_CAPTURE_RE = /(?:^|[._\-\s])s(\d{1,2})(?=[._\-\s]|$)/i;
const SCENE_EPISODE_ONLY_RE = /(?:^|[._\-\s])e(?:p(?:isode)?)?\s*0*(\d{1,3})(?:[._\-\s]|$)/i;
const SCENE_PART_TOKEN_RE = /(?:^|[._\-\s])(?:teil|part)\s*0*(\d{1,3})(?=[._\-\s]|$)/i;
const SCENE_COMPACT_EPISODE_CODE_RE = /(?:^|[._\-\s])(\d{3,4})([a-z])?(?=$|[._\-\s])/i;
const SCENE_RP_TOKEN_RE = /(?:^|[._\-\s])rp(?:[._\-\s]|$)/i;
const SCENE_REPACK_TOKEN_RE = /(?:^|[._\-\s])repack(?:[._\-\s]|$)/i;
const SCENE_QUALITY_TOKEN_RE = /([._\-\s])((?:4320|2160|1440|1080|720|576|540|480|360)p)(?=[._\-\s]|$)/i;
const SCENE_GROUP_SUFFIX_FALLBACK_RE = /-([A-Za-z0-9]{2,})$/;
const SCENE_FLEXIBLE_GROUP_SUFFIX_RE = /-([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)$/;
const SCENE_MIXED_GROUP_SUFFIX_RE = /-[^-]*[\/\\|\u2044\u2215][^-]*$/;
const SCENE_NON_GROUP_SUFFIXES = new Set([
  "x264",
  "x265",
  "h264",
  "h265",
  "avc",
  "hevc",
  "web",
  "webrip",
  "webdl",
  "bluray",
  "bdrip",
  "hdtv",
  "dvdrip",
  "remux"
]);

function isValidSceneGroupSuffix(suffix: string): boolean {
  const normalizedSuffix = String(suffix || "").trim();
  if (!normalizedSuffix) {
    return false;
  }

  const lower = normalizedSuffix.toLowerCase();
  if (SCENE_NON_GROUP_SUFFIXES.has(lower)) {
    return false;
  }
  if (/^s\d{1,2}e\d{1,3}(?:e\d{1,3})?$/i.test(normalizedSuffix) || /^s\d{1,2}$/i.test(normalizedSuffix) || /^e\d{1,3}$/i.test(normalizedSuffix)) {
    return false;
  }
  if (/^\d+p$/.test(lower) || /^\d+$/.test(lower)) {
    return false;
  }
  if (/^\d/.test(normalizedSuffix)) {
    return false;
  }
  if (/4s(?:f|j)/i.test(normalizedSuffix) && !/^(?:4sf|4sj)$/i.test(normalizedSuffix)) {
    return false;
  }
  return /[a-z]/i.test(normalizedSuffix);
}

function extractFlexibleSceneGroupSuffix(fileName: string): string | null {
  const text = String(fileName || "").trim();
  if (!text) {
    return null;
  }

  const match = text.match(SCENE_FLEXIBLE_GROUP_SUFFIX_RE);
  const suffix = String(match?.[1] || "").trim();
  if (!suffix || !/[a-z]/i.test(suffix)) {
    return null;
  }

  const suffixParts = suffix.split("_").filter(Boolean);
  if (suffixParts.length === 0) {
    return null;
  }
  if (!suffixParts.every((part) => isValidSceneGroupSuffix(part))) {
    return null;
  }
  return suffix;
}

function hasMixedSceneGroupSuffix(fileName: string): boolean {
  const text = String(fileName || "").trim();
  if (!text) {
    return false;
  }
  return SCENE_MIXED_GROUP_SUFFIX_RE.test(text);
}

function applySourceSceneGroupSuffix(targetBaseName: string, sourceFileName: string): string {
  const target = String(targetBaseName || "").trim();
  const suffix = extractFlexibleSceneGroupSuffix(sourceFileName);
  if (!target || !suffix) {
    return target;
  }

  if (/-[^-]+$/.test(target)) {
    return target.replace(/-[^-]+$/, `-${suffix}`);
  }
  return `${target}-${suffix}`;
}

function hasSceneGroupSuffix(fileName: string): boolean {
  const text = String(fileName || "").trim();
  if (!text) {
    return false;
  }

  if (SCENE_GROUP_SUFFIX_RE.test(text)) {
    const directMatch = text.match(SCENE_GROUP_SUFFIX_FALLBACK_RE);
    return isValidSceneGroupSuffix(String(directMatch?.[1] || ""));
  }

  const fallbackMatch = text.match(SCENE_GROUP_SUFFIX_FALLBACK_RE);
  const suffix = String(fallbackMatch?.[1] || "").trim();
  return isValidSceneGroupSuffix(suffix);
}

/** Older scene releases used "1x01" instead of "S01E01". The episode group
 *  is capped at 2 digits so the regex does NOT falsely match codec tokens
 *  like "x264" / "x265" / "x266" or aspect ratios like "1920x1080". */
const SCENE_EPISODE_X_RE = /(?:^|[._\-\s])(\d{1,2})x(\d{1,2})(?:x(\d{1,2}))?(?![\dx])/i;

export function extractEpisodeToken(fileName: string): string | null {
  const text = String(fileName || "");
  const match = text.match(SCENE_EPISODE_RE)
    || text.match(SCENE_EPISODE_JOINED_RE)
    || text.match(SCENE_EPISODE_TYPO_SS_RE)
    || text.match(SCENE_EPISODE_X_RE);
  if (!match) {
    return null;
  }

  const season = Number(match[1]);
  const episode = Number(match[2]);
  if (!Number.isFinite(season) || !Number.isFinite(episode) || season < 0 || episode < 0) {
    return null;
  }

  let token = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  if (match[3]) {
    const episode2 = Number(match[3]);
    if (Number.isFinite(episode2) && episode2 > 0) {
      token += `E${String(episode2).padStart(2, "0")}`;
    }
  }
  return token;
}

function extractSeasonToken(fileName: string): string | null {
  const text = String(fileName || "");
  const episodeMatch = text.match(SCENE_EPISODE_RE);
  if (episodeMatch?.[1]) {
    const season = Number(episodeMatch[1]);
    if (Number.isFinite(season) && season >= 0) {
      return `S${String(season).padStart(2, "0")}`;
    }
  }
  const seasonMatch = text.match(SCENE_SEASON_CAPTURE_RE);
  if (!seasonMatch?.[1]) {
    return null;
  }
  const season = Number(seasonMatch[1]);
  if (!Number.isFinite(season) || season < 0) {
    return null;
  }
  return `S${String(season).padStart(2, "0")}`;
}

function extractPartEpisodeNumber(fileName: string): number | null {
  const match = String(fileName || "").match(SCENE_PART_TOKEN_RE);
  if (!match?.[1]) {
    return null;
  }
  const episode = Number(match[1]);
  if (!Number.isFinite(episode) || episode <= 0) {
    return null;
  }
  return episode;
}

function extractEpisodeOnlyNumber(fileName: string): number | null {
  const match = String(fileName || "").match(SCENE_EPISODE_ONLY_RE);
  if (!match?.[1]) {
    return null;
  }
  const episode = Number(match[1]);
  if (!Number.isFinite(episode) || episode <= 0 || episode > 999) {
    return null;
  }
  return episode;
}

function extractCompactEpisodeToken(fileName: string, seasonHint: number | null): string | null {
  const trimmed = String(fileName || "").trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(SCENE_COMPACT_EPISODE_CODE_RE);
  if (!match?.[1]) {
    return null;
  }

  const code = match[1];
  const episodeSuffix = String(match[2] || "").toLowerCase();
  if (code === "4320" || code === "2160" || code === "1440" || code === "1080"
    || code === "0720" || code === "720" || code === "0576" || code === "576"
    || code === "0540" || code === "540" || code === "0480" || code === "480"
    || code === "0360" || code === "360") {
    return null;
  }

  const letterOffset = episodeSuffix
    ? episodeSuffix.charCodeAt(0) - "a".charCodeAt(0)
    : 0;
  const toToken = (season: number, episode: number): string | null => {
    const effectiveEpisode = episode + Math.max(0, letterOffset);
    if (episodeSuffix && (letterOffset < 0 || letterOffset > 25)) {
      return null;
    }
    if (!Number.isFinite(season) || !Number.isFinite(effectiveEpisode) || season < 0 || season > 99 || effectiveEpisode <= 0 || effectiveEpisode > 999) {
      return null;
    }
    return `S${String(season).padStart(2, "0")}E${String(effectiveEpisode).padStart(2, "0")}`;
  };

  if (seasonHint !== null && Number.isFinite(seasonHint) && seasonHint >= 0 && seasonHint <= 99) {
    const seasonRaw = String(Math.trunc(seasonHint));
    const seasonPadded = String(Math.trunc(seasonHint)).padStart(2, "0");
    const seasonPrefixes = [seasonPadded, seasonRaw].filter((value, index, array) => value.length > 0 && array.indexOf(value) === index)
      .sort((a, b) => b.length - a.length);
    for (const prefix of seasonPrefixes) {
      if (!code.startsWith(prefix) || code.length <= prefix.length) {
        continue;
      }
      const episode = Number(code.slice(prefix.length));
      const token = toToken(Number(seasonRaw), episode);
      if (token) {
        return token;
      }
    }
  }

  if (code.length === 3) {
    return toToken(Number(code[0]), Number(code.slice(1)));
  }
  if (code.length === 4) {
    return toToken(Number(code.slice(0, 2)), Number(code.slice(2)));
  }
  return null;
}

function resolveEpisodeTokenForAutoRename(sourceFileName: string, folderNames: string[]): { token: string; fromPart: boolean } | null {
  const directFromSource = extractEpisodeToken(sourceFileName);
  if (directFromSource) {
    return { token: directFromSource, fromPart: false };
  }

  for (const folderName of folderNames) {
    const directFromFolder = extractEpisodeToken(folderName);
    if (directFromFolder) {
      return { token: directFromFolder, fromPart: false };
    }
  }

  const seasonTokenHint = extractSeasonToken(sourceFileName)
    ?? folderNames.map((folderName) => extractSeasonToken(folderName)).find(Boolean)
    ?? null;
  const episodeOnly = extractEpisodeOnlyNumber(sourceFileName)
    ?? folderNames.map((folderName) => extractEpisodeOnlyNumber(folderName)).find((value) => Number.isFinite(value) && (value as number) > 0)
    ?? null;
  if (seasonTokenHint && episodeOnly) {
    return {
      token: `${seasonTokenHint}E${String(episodeOnly).padStart(2, "0")}`,
      fromPart: false
    };
  }
  const seasonHint = seasonTokenHint ? Number(seasonTokenHint.slice(1)) : null;
  const compactEpisode = extractCompactEpisodeToken(sourceFileName, seasonHint);
  if (compactEpisode) {
    return { token: compactEpisode, fromPart: false };
  }

  const partEpisode = extractPartEpisodeNumber(sourceFileName)
    ?? folderNames.map((folderName) => extractPartEpisodeNumber(folderName)).find((value) => Number.isFinite(value) && (value as number) > 0)
    ?? null;
  if (!partEpisode) {
    return null;
  }

  const seasonToken = seasonTokenHint || "S01";

  return {
    token: `${seasonToken}E${String(partEpisode).padStart(2, "0")}`,
    fromPart: true
  };
}

export function applyEpisodeTokenToFolderName(folderName: string, episodeToken: string): string {
  const trimmed = String(folderName || "").trim();
  if (!trimmed) {
    return episodeToken;
  }

  // Match single episodes (S01E03), multi-episodes (S01E01E02), and
  // episode ranges (S01E01-E08, S01E01-08) so the range is fully replaced
  // with the source's specific episode token.
  const episodeRe = /(^|[._\-\s])s\d{1,2}e\d{1,3}(?:e\d{1,3})?(?:[-]e?\d{1,3})?(?=[._\-\s]|$)/i;
  if (episodeRe.test(trimmed)) {
    return trimmed.replace(episodeRe, `$1${episodeToken}`);
  }

  const withSeason = trimmed.replace(SCENE_SEASON_ONLY_RE, `$1${episodeToken}`);
  if (withSeason !== trimmed) {
    return withSeason;
  }

  const withSuffixInsert = trimmed.replace(/-(4sf|4sj)$/i, `.${episodeToken}-$1`);
  if (withSuffixInsert !== trimmed) {
    return withSuffixInsert;
  }

  return `${trimmed}.${episodeToken}`;
}

export function sourceHasRpToken(fileName: string): boolean {
  return SCENE_RP_TOKEN_RE.test(String(fileName || ""));
}

function removeRpTokens(baseName: string): string {
  const normalized = String(baseName || "")
    .replace(/(^|[._\-\s])rp(?=([._\-\s]|$))/ig, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/\s{2,}/g, " ")
    .replace(/^[._\-\s]+|[._\-\s]+$/g, "");
  return normalized || String(baseName || "");
}

export function ensureRepackToken(baseName: string): string {
  if (SCENE_REPACK_TOKEN_RE.test(baseName)) {
    return baseName;
  }

  const withQualityToken = baseName.replace(SCENE_QUALITY_TOKEN_RE, "$1REPACK.$2");
  if (withQualityToken !== baseName) {
    return withQualityToken;
  }

  const withSuffixToken = baseName.replace(/-(4sf|4sj)$/i, ".REPACK-$1");
  if (withSuffixToken !== baseName) {
    return withSuffixToken;
  }

  return `${baseName}.REPACK`;
}

export function buildAutoRenameBaseName(folderName: string, sourceFileName: string): string | null {
  const normalizedFolderName = String(folderName || "").trim();
  const normalizedSourceFileName = String(sourceFileName || "").trim();
  if (!normalizedFolderName || !normalizedSourceFileName) {
    return null;
  }

  const isLegacy4sf4sjFolder = SCENE_RELEASE_FOLDER_RE.test(normalizedFolderName);
  const isSceneGroupFolder = hasSceneGroupSuffix(normalizedFolderName);
  if (!isLegacy4sf4sjFolder && !isSceneGroupFolder) {
    return null;
  }

  const episodeToken = extractEpisodeToken(normalizedSourceFileName);
  if (!episodeToken) {
    return null;
  }

  let next = isLegacy4sf4sjFolder
    ? applyEpisodeTokenToFolderName(normalizedFolderName, episodeToken)
    : normalizedFolderName;

  // If the folder contains an episode RANGE (e.g. S01E01-E08), replace the
  // range with the source's specific episode token.  Without this, all
  // episodes in a range-named folder share the same target name, producing
  // (2)(3)(4) suffixes during MKV collection.
  if (!isLegacy4sf4sjFolder && isSceneGroupFolder) {
    const episodeRangeRe = /(^|[._\-\s])s\d{1,2}e\d{1,3}[-]e?\d{1,3}(?=[._\-\s]|$)/i;
    if (episodeRangeRe.test(normalizedFolderName)) {
      next = applyEpisodeTokenToFolderName(normalizedFolderName, episodeToken);
    }
  }

  const hasRepackHint = sourceHasRpToken(normalizedSourceFileName)
    || SCENE_REPACK_TOKEN_RE.test(normalizedSourceFileName)
    || sourceHasRpToken(normalizedFolderName)
    || SCENE_REPACK_TOKEN_RE.test(normalizedFolderName);
  if (hasRepackHint) {
    next = removeRpTokens(next);
    next = ensureRepackToken(next);
  }

  return sanitizeFilename(next);
}

export function buildAutoRenameBaseNameFromFolders(folderNames: string[], sourceFileName: string): string | null {
  return buildAutoRenameBaseNameFromFoldersWithOptions(folderNames, sourceFileName, { forceEpisodeForSeasonFolder: false });
}

export function buildAutoRenameBaseNameFromFoldersWithOptions(
  folderNames: string[],
  sourceFileName: string,
  options: { forceEpisodeForSeasonFolder?: boolean }
): string | null {
  const ordered = folderNames
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 0);
  if (ordered.length === 0) {
    return null;
  }

  const normalizedSourceFileName = String(sourceFileName || "").trim();
  const resolvedEpisode = resolveEpisodeTokenForAutoRename(normalizedSourceFileName, ordered);
  const forceEpisodeForSeasonFolder = Boolean(options.forceEpisodeForSeasonFolder);
  const globalRepackHint = sourceHasRpToken(normalizedSourceFileName)
    || SCENE_REPACK_TOKEN_RE.test(normalizedSourceFileName)
    || ordered.some((folderName) => sourceHasRpToken(folderName) || SCENE_REPACK_TOKEN_RE.test(folderName));

  for (const folderName of ordered) {
    const folderHasEpisode = Boolean(extractEpisodeToken(folderName));
    const folderHasSeason = Boolean(extractSeasonToken(folderName));
    const folderHasPart = extractPartEpisodeNumber(folderName) !== null;
    if (folderHasPart && !folderHasEpisode && !folderHasSeason) {
      continue;
    }

    let target = buildAutoRenameBaseName(folderName, normalizedSourceFileName);
    if (!target && resolvedEpisode && hasSceneGroupSuffix(folderName) && (folderHasSeason || folderHasEpisode)) {
      target = applyEpisodeTokenToFolderName(folderName, resolvedEpisode.token);
    }
    if (!target) {
      continue;
    }

    if (resolvedEpisode
      && forceEpisodeForSeasonFolder
      && hasSceneGroupSuffix(target)
      && !extractEpisodeToken(target)
      && SCENE_SEASON_ONLY_RE.test(target)) {
      target = applyEpisodeTokenToFolderName(target, resolvedEpisode.token);
    }

    if (resolvedEpisode?.fromPart
      && hasSceneGroupSuffix(target)
      && !extractEpisodeToken(target)
      && SCENE_SEASON_ONLY_RE.test(target)) {
      target = applyEpisodeTokenToFolderName(target, resolvedEpisode.token);
    }

    if (resolvedEpisode
      && folderHasSeason
      && !folderHasEpisode
      && (hasMixedSceneGroupSuffix(folderName) || !hasSceneGroupSuffix(folderName))) {
      target = applySourceSceneGroupSuffix(target, normalizedSourceFileName);
    }

    if (globalRepackHint) {
      target = ensureRepackToken(removeRpTokens(target));
    }
    return sanitizeFilename(target);
  }

  // Last-resort fallback: if no scene-group-suffix folder was found but a folder
  // has a season token and the source has an episode token, inject the episode anyway.
  // This handles user-renamed packages like "Mystery Road S02" where the folder has
  // no scene group suffix but still contains enough info for a useful rename.
  if (resolvedEpisode && forceEpisodeForSeasonFolder) {
    for (const folderName of ordered) {
      if (!SCENE_SEASON_ONLY_RE.test(folderName) || extractEpisodeToken(folderName)) {
        continue;
      }
      let target = applyEpisodeTokenToFolderName(folderName, resolvedEpisode.token);
      if (hasMixedSceneGroupSuffix(folderName) || !hasSceneGroupSuffix(folderName)) {
        target = applySourceSceneGroupSuffix(target, normalizedSourceFileName);
      }
      if (globalRepackHint) {
        target = ensureRepackToken(removeRpTokens(target));
      }
      return sanitizeFilename(target);
    }
  }

  return null;
}

// Hoisted regex patterns — avoid recompiling on every resolveArchiveItemsFromList() call.
const ARCHIVE_MULTIPART_RAR_RE = /^(.*)\.part0*1\.rar$/;
const ARCHIVE_RAR_RE = /^(.*)\.rar$/;
const ARCHIVE_ZIP_SPLIT_RE = /^(.*)\.zip\.001$/;
const ARCHIVE_7Z_SPLIT_RE = /^(.*)\.7z\.001$/;
const ARCHIVE_GENERIC_001_RE = /^(.*)\.001$/;
const ARCHIVE_KNOWN_001_RE = /\.(zip|7z)\.001$/;
const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

export function resolveArchiveItemsFromList(archiveName: string, items: DownloadItem[]): DownloadItem[] {
  const normalizeArchiveMatchName = (value: string): string =>
    stripDuplicateSuffixBeforeExtension(path.basename(String(value || "")));
  const entryLower = normalizeArchiveMatchName(archiveName).toLowerCase();

  // Helper: get item basename (try targetPath first, then fileName)
  const itemBaseName = (item: DownloadItem): string =>
    normalizeArchiveMatchName(item.targetPath || item.fileName || "");

  // Try pattern-based matching first (for multipart archives).
  // Note: the constructed RegExps below depend on the input filename so they
  // cannot be hoisted — but the *test* regexes above are now reused.
  let pattern: RegExp | null = null;
  const multipartMatch = entryLower.match(ARCHIVE_MULTIPART_RAR_RE);
  if (multipartMatch) {
    const prefix = multipartMatch[1].replace(REGEX_ESCAPE_RE, "\\$&");
    pattern = new RegExp(`^${prefix}\\.part\\d+\\.rar$`, "i");
  }
  if (!pattern) {
    const rarMatch = entryLower.match(ARCHIVE_RAR_RE);
    if (rarMatch) {
      const stem = rarMatch[1].replace(REGEX_ESCAPE_RE, "\\$&");
      pattern = new RegExp(`^${stem}\\.r(ar|\\d{2,3})$`, "i");
    }
  }
  if (!pattern) {
    const zipSplitMatch = entryLower.match(ARCHIVE_ZIP_SPLIT_RE);
    if (zipSplitMatch) {
      const stem = zipSplitMatch[1].replace(REGEX_ESCAPE_RE, "\\$&");
      pattern = new RegExp(`^${stem}\\.zip(\\.\\d+)?$`, "i");
    }
  }
  if (!pattern) {
    const sevenSplitMatch = entryLower.match(ARCHIVE_7Z_SPLIT_RE);
    if (sevenSplitMatch) {
      const stem = sevenSplitMatch[1].replace(REGEX_ESCAPE_RE, "\\$&");
      pattern = new RegExp(`^${stem}\\.7z(\\.\\d+)?$`, "i");
    }
  }
  if (!pattern && ARCHIVE_GENERIC_001_RE.test(entryLower) && !ARCHIVE_KNOWN_001_RE.test(entryLower)) {
    const genericSplitMatch = entryLower.match(ARCHIVE_GENERIC_001_RE);
    if (genericSplitMatch) {
      const stem = genericSplitMatch[1].replace(REGEX_ESCAPE_RE, "\\$&");
      pattern = new RegExp(`^${stem}\\.\\d{3}$`, "i");
    }
  }

  // Attempt 1: Pattern match (handles multipart archives)
  if (pattern) {
    const matched = items.filter((item) => pattern!.test(itemBaseName(item)));
    if (matched.length > 0) return matched;
  }

  // Attempt 2: Exact filename match (case-insensitive)
  const exactMatch = items.filter((item) => itemBaseName(item).toLowerCase() === entryLower);
  if (exactMatch.length > 0) return exactMatch;

  // Attempt 3: Stem-based fuzzy match — strip archive extensions and compare stems.
  // Handles cases where debrid services modify filenames slightly.
  const archiveStem = entryLower
    .replace(/\.part\d+\.rar$/i, "")
    .replace(/\.r\d{2,3}$/i, "")
    .replace(/\.rar$/i, "")
    .replace(/\.(zip|7z)\.\d{3}$/i, "")
    .replace(/\.\d{3}$/i, "")
    .replace(/\.(zip|7z)$/i, "");
  if (archiveStem.length > 3) {
    const stemMatch = items.filter((item) => {
      const name = itemBaseName(item).toLowerCase();
      return name.startsWith(archiveStem) && /\.(rar|r\d{2,3}|zip|7z|\d{3})$/i.test(name);
    });
    if (stemMatch.length > 0) return stemMatch;
  }

  // Attempt 4: If only one item in the list and one archive — return it as a best-effort match.
  // This handles single-file packages where the filename may have been modified.
  if (items.length === 1) {
    const singleName = itemBaseName(items[0]).toLowerCase();
    if (/\.(rar|zip|7z|\d{3})$/i.test(singleName)) {
      return items;
    }
  }

  return [];
}

function stripDuplicateSuffixBeforeExtension(fileName: string): string {
  return String(fileName || "").replace(/ \(\d+\)(?=\.[^.]+$)/, "");
}

function hasDuplicateSuffixBeforeExtension(fileName: string): boolean {
  const normalized = stripDuplicateSuffixBeforeExtension(fileName);
  return normalized !== String(fileName || "");
}

function startupDuplicateStateRank(item: DownloadItem, diskExists: boolean): number {
  let rank = diskExists ? 40 : 0;
  switch (item.status) {
    case "completed":
      rank += 40;
      break;
    case "downloading":
    case "validating":
    case "integrity_check":
      rank += 25;
      break;
    case "queued":
    case "reconnect_wait":
    case "paused":
      rank += 10;
      break;
    case "failed":
      rank += 5;
      break;
    default:
      break;
  }
  const fullStatus = String(item.fullStatus || "").trim();
  if (isExtractedLabel(fullStatus)) {
    rank += 65;
  } else if (/^fertig\b/i.test(fullStatus)) {
    rank += 30;
  } else if (isTransientExtractStatus(fullStatus)) {
    rank += 20;
  } else if (isExtractErrorLabel(fullStatus)) {
    rank += 5;
  }
  rank += Math.max(0, Math.min(9, Math.floor(Number(item.progressPercent || 0) / 12)));
  if (Number(item.downloadedBytes || 0) > 0) {
    rank += 1;
  }
  return rank;
}

export function extractArchiveNameFromExtractorLogMessage(message: string): string | null {
  const text = String(message || "").trim();
  if (!text) {
    return null;
  }

  const patterns = [
    /archive=([^,\s|]+)/i,
    /Entpacke Archiv:\s*([^\s]+)\s*->/i,
    /Entpack-Fehler\s+([^\s]+)\s+\[/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function summarizeExtractFailureReason(reason: string): string {
  const text = compactErrorText(reason).replace(/^Error:\s*/i, "").trim();
  if (!text) {
    return "Entpacken fehlgeschlagen";
  }
  if (/checksum error|crc/i.test(text)) {
    return "Checksum/CRC-Fehler im Archiv";
  }
  if (/wrong password|falsches passwort|password/i.test(text) && /checksum error in the encrypted file/i.test(text)) {
    return "Checksum- oder Passwortfehler im verschluesselten Archiv";
  }
  if (/missing_file|next volume is required|cannot find volume|volume.*missing|part.*missing/i.test(text)) {
    return "Teilarchiv fehlt oder ist nicht lesbar";
  }
  if (/unexpected end of archive|no end header found|invalid or unsupported zip format|not a rar archive|ungueltig|unsupported_format/i.test(text)) {
    return "Archiv unvollstaendig oder ungueltig";
  }
  return text;
}

function formatExtractFailureLabel(reason: string, archiveName = ""): string {
  const summary = summarizeExtractFailureReason(reason);
  const archive = String(archiveName || "").trim();
  return archive
    ? `Entpack-Fehler [${archive}]: ${summary}`
    : `Entpack-Fehler: ${summary}`;
}

function retryDelayWithJitter(attempt: number, baseMs: number): number {
  const exponential = baseMs * Math.pow(1.5, Math.min(attempt - 1, 14));
  const capped = Math.min(exponential, 120000);
  const jitter = capped * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}

export class DownloadManager extends EventEmitter {
  private settings: AppSettings;

  private session: SessionState;

  private storagePaths: StoragePaths;

  public skipShutdownPersist = false;

  /** Block ALL persistence (persistSoon + shutdown). Set after importBackup to prevent
   *  the old in-memory session from overwriting the restored backup on disk. */
  public blockAllPersistence = false;

  private debridService: DebridService;

  private invalidateMegaSessionFn?: () => void;

  private activeTasks = new Map<string, ActiveTask>();

  private scheduleRunning = false;
  private schedulerGeneration = 0;

  private persistTimer: NodeJS.Timeout | null = null;

  private speedEvents: Array<{ at: number; bytes: number; pid: string }> = [];

  private summary: DownloadSummary | null = null;

  private nonResumableActive = 0;

  private stateEmitTimer: NodeJS.Timeout | null = null;
  private lastStateEmitAt = 0;

  private speedBytesLastWindow = 0;

  private sessionDownloadedBytes = 0;
  private sessionCompletedFiles = 0;

  private statsCache: DownloadStats | null = null;

  private statsCacheAt = 0;

  /** Cache for cloneSettings() results in getSnapshot() — invalidated after 400ms
   *  or by explicit invalidateSettingsSnapshotCache() calls. */
  private settingsSnapshotCache: AppSettings | null = null;
  private settingsSnapshotCacheAt = 0;
  private invalidateSettingsSnapshotCache(): void {
    this.settingsSnapshotCache = null;
    this.settingsSnapshotCacheAt = 0;
  }

  /** State-diffing tracking: hashes of items/packages as last sent to the
   *  renderer. Allows getSnapshotForEmit() to return only changed entries
   *  plus a list of removed IDs, drastically cutting IPC payload size for
   *  large queues (5000+ items) where most items are idle between emits. */
  private lastEmittedItemHashes = new Map<string, string>();
  private lastEmittedPackageHashes = new Map<string, string>();
  private firstEmitDone = false;
  private lastFullEmitAt = 0;
  /** Force a full resync every 30 seconds to recover from any potential drift. */
  private static readonly FULL_RESYNC_INTERVAL_MS = 30000;

  private lastPersistAt = 0;
  private lastSettingsPersistAt = 0;
  private appSessionStartedAt = 0;
  private runtimePersistedTotalMs = 0;
  private runtimePersistedAt = 0;

  private cleanupQueue: Promise<void> = Promise.resolve();

  private packagePostProcessQueue: Promise<void> = Promise.resolve();

  private packagePostProcessActive = 0;

  private packagePostProcessWaiters: Array<{ packageId: string; resolve: () => void }> = [];

  private packagePostProcessTasks = new Map<string, Promise<void>>();

  private packagePostProcessAbortControllers = new Map<string, AbortController>();

  private packageDeferredPostProcessAbortControllers = new Map<string, AbortController>();

  // Hybrid post-extract (Rename + MKV-Collect) läuft als detached Promise sobald
  // ein Archiv-Set fertig ist. Separat von der Deferred-Pipe getrackt, damit
  // runDeferredPostExtraction's replace-Logik die laufende Hybrid-Arbeit nicht
  // killt — und damit globaler Abort (Stop/Shutdown) + Run-Abschluss sie sehen.
  // Set pro Package, da mehrere Archive-Sets dicht hintereinander fertig werden
  // können. (H1/H2/M1)
  private packageHybridPostProcessControllers = new Map<string, Set<AbortController>>();

  private packagePostProcessVersions = new Map<string, number>();

  private hybridExtractRequeue = new Set<string>();

  // Tracks archive paths already attempted per package until the package/archive state changes
  // or the user explicitly retries extraction.
  private hybridExtractedPaths = new Map<string, Set<string>>();

  // Tracks failed hybrid archives together with a lightweight state marker so unchanged
  // archives are not retried on every subsequent post-processing wake-up.
  private hybridFailedArchives = new Map<string, Map<string, HybridFailedArchiveState>>();

  /** Archives already auto-recovered via forced re-download (loop protection). */
  private autoRecoveredForRedownload = new Set<string>();

  private reservedTargetPaths = new Map<string, string>();

  private claimedTargetPathByItem = new Map<string, string>();

  private itemContributedBytes = new Map<string, number>();

  /** Per-package serialization for ALL post-process file operations that
   *  touch files inside the package's extractDir — currently autoRename and
   *  collectMkvFilesToLibrary. Previously only autoRename was serialized
   *  (autoRenameInFlight), but the hybrid-extract pipe (fire-and-forget) and
   *  the deferred-post-process pipe (top-level awaited) could interleave so
   *  that pipe A's mkvMove ran while pipe B's rename was still scanning the
   *  same dir → ENOENT and files moved to the library under their old
   *  obfuscated names. By chaining both rename AND mkvMove onto the same
   *  per-package promise we guarantee that at most one file-mutating
   *  operation runs per package at any time, regardless of which pipe
   *  triggered it. */
  private packageFileOpChain = new Map<string, Promise<unknown>>();

  /** Minimum age (ms) a video file must reach before auto-rename will touch
   *  it. Guards against renaming files mid-write during hybrid extract.
   *  Disabled (0) under Vitest so tests that create files immediately before
   *  triggering a rename don't have to sleep. Tests can also override via
   *  setFileStabilizeMinAgeMsForTests. */
  private fileStabilizeMinAgeMs = process.env.VITEST ? 0 : 2000;

  public setFileStabilizeMinAgeMsForTests(ms: number): void {
    this.fileStabilizeMinAgeMs = Math.max(0, Math.floor(ms));
  }

  private runItemIds = new Set<string>();

  private runPackageIds = new Set<string>();

  private runOutcomes = new Map<string, "completed" | "failed" | "cancelled">();

  private runCompletedPackages = new Set<string>();

  private historyRecordedPackages = new Set<string>();

  private itemCount = 0;

  private lastSchedulerHeartbeatAt = 0;

  private lastReconnectMarkAt = 0;

  private consecutiveReconnects = 0;

  private lastGlobalProgressBytes = 0;

  private lastGlobalProgressAt = 0;

  private retryAfterByItem = new Map<string, number>();

  private retryStateByItem = new Map<string, {
    freshRetryUsed: boolean;
    resumeHardResetUsed: boolean;
    stallRetries: number;
    genericErrorRetries: number;
    unrestrictRetries: number;
  }>();

  private providerFailures = new Map<string, { count: number; lastFailAt: number; cooldownUntil: number }>();

  private allDebridHostInfoCache = new Map<string, { info: AllDebridHostInfo; cachedAt: number }>();

  private providerStartReservations = new Map<string, number>();
  private pacedStartReservationByItem = new Map<string, number>();

  private lastStaleResetAt = 0;

  private onHistoryEntryCallback?: HistoryEntryCallback;

  public constructor(settings: AppSettings, session: SessionState, storagePaths: StoragePaths, options: DownloadManagerOptions = {}) {
    super();
    this.settings = settings;
    const startedAt = nowMs();
    this.appSessionStartedAt = startedAt;
    this.runtimePersistedTotalMs = Math.max(0, Number(settings.totalRuntimeAllTimeMs || 0));
    this.runtimePersistedAt = startedAt;
    // loadSession already returns a fresh, standalone object graph — no need to
    // deep-clone again.  This avoids duplicating the entire session in memory at
    // startup which can spike peak heap on low-RAM servers.
    this.session = session;
    this.itemCount = Object.keys(this.session.items).length;
    this.storagePaths = storagePaths;
    this.debridService = new DebridService(settings, {
      megaWebUnrestrict: options.megaWebUnrestrict,
      allDebridWebUnrestrict: options.allDebridWebUnrestrict,
      realDebridWebUnrestrict: options.realDebridWebUnrestrict,
      bestDebridWebUnrestrict: options.bestDebridWebUnrestrict
    });
    this.invalidateMegaSessionFn = options.invalidateMegaSession;
    this.onHistoryEntryCallback = options.onHistoryEntry;
    logger.info(`DownloadManager Init: ${Object.keys(this.session.packages).length} Pakete, ${this.itemCount} Items, cleanupPolicy=${this.settings.completedCleanupPolicy}`);
    for (const pkg of Object.values(this.session.packages)) {
      this.ensurePackageLogForPackage(pkg);
      this.logPackageForPackage(pkg, "INFO", "Paket aus Session wiederhergestellt", {
        itemCount: pkg.itemIds.length,
        status: pkg.status,
        enabled: pkg.enabled,
        cancelled: pkg.cancelled
      });
    }
    this.applyOnStartCleanupPolicy();
    this.normalizeSessionStatuses();
    this.restoreTargetPathReservations();
    this.resolveExistingQueuedOpaqueFilenames();
    this.revalidateCompletedItems();
    void this.recoverRetryableItems("startup").catch((err) => logger.warn(`recoverRetryableItems Fehler (startup): ${compactErrorText(err)}`));
    this.recoverPostProcessingOnStartup();
    this.checkExistingRapidgatorLinks();
    void this.cleanupExistingExtractedArchives().catch((err) => logger.warn(`cleanupExistingExtractedArchives Fehler (constructor): ${compactErrorText(err)}`));
    // Push a fresh snapshot to the UI whenever a rotation event is recorded so
    // the live rotation panel updates immediately. The listener is module-global,
    // so guard against firing on a torn-down manager after shutdown.
    setRotationEventListener(() => {
      if (this.rotationListenerActive === false) {
        return;
      }
      try {
        // Forced emit: rotation happens during the idle link-resolve phase (no
        // downloads running), where the normal emit cadence can be starved. The
        // forced path has a 120ms floor — the right cadence for a live log panel.
        this.emitState(true);
      } catch {
        // never let a UI push break the rotation flow
      }
    });
  }

  private rotationListenerActive = true;

  public getPackageLogPath(packageId: string): string | null {
    const pkg = this.session.packages[packageId];
    if (pkg) {
      return this.ensurePackageLogForPackage(pkg);
    }
    return getPersistedPackageLogPath(packageId);
  }

  public getItemLogPath(itemId: string): string | null {
    const item = this.session.items[itemId];
    if (item) {
      return this.ensureItemLogForItem(item);
    }
    return getPersistedItemLogPath(itemId);
  }

  private ensurePackageLogForPackage(pkg: PackageEntry): string | null {
    return ensurePackageLog({
      packageId: pkg.id,
      name: pkg.name,
      outputDir: pkg.outputDir,
      extractDir: pkg.extractDir
    });
  }

  private ensureItemLogForItem(item: DownloadItem): string | null {
    const pkg = this.session.packages[item.packageId];
    return ensureItemLog({
      itemId: item.id,
      packageId: item.packageId,
      packageName: pkg?.name || "",
      fileName: item.fileName,
      targetPath: item.targetPath
    });
  }

  private logPackage(packageId: string, level: "INFO" | "WARN" | "ERROR", message: string, fields?: Record<string, unknown>): void {
    writePackageLogEvent(packageId, level, message, fields);
  }

  private logPackageForPackage(pkg: PackageEntry, level: "INFO" | "WARN" | "ERROR", message: string, fields?: Record<string, unknown>): void {
    this.ensurePackageLogForPackage(pkg);
    this.logPackage(pkg.id, level, message, {
      packageName: pkg.name,
      ...fields
    });
  }

  private logExtractionForItems(
    pkg: PackageEntry,
    items: DownloadItem[],
    prefix: string,
    level: "INFO" | "WARN" | "ERROR",
    message: string
  ): void {
    const fullMessage = `${prefix}: ${message}`;
    this.logPackageForPackage(pkg, level, fullMessage);

    const archiveName = extractArchiveNameFromExtractorLogMessage(message);
    if (!archiveName) {
      return;
    }
    for (const item of resolveArchiveItemsFromList(archiveName, items)) {
      this.logPackageForItem(item, level, fullMessage, { archiveName });
    }
  }

  private logPackageForItem(
    item: DownloadItem,
    level: "INFO" | "WARN" | "ERROR",
    message: string,
    fields?: Record<string, unknown>
  ): void {
    const pkg = this.session.packages[item.packageId];
    if (pkg) {
      this.ensurePackageLogForPackage(pkg);
    }
    this.ensureItemLogForItem(item);
    this.logPackage(item.packageId, level, message, {
      packageName: pkg?.name || "",
      itemId: item.id,
      fileName: item.fileName,
      status: item.status,
      targetPath: item.targetPath,
      ...fields
    });
    writeItemLogEvent(item.id, level, message, {
      packageId: item.packageId,
      packageName: pkg?.name || "",
      itemId: item.id,
      fileName: item.fileName,
      status: item.status,
      targetPath: item.targetPath,
      ...fields
    });
  }

  private logItemOnly(
    item: DownloadItem,
    level: "INFO" | "WARN" | "ERROR",
    message: string,
    fields?: Record<string, unknown>
  ): void {
    const pkg = this.session.packages[item.packageId];
    this.ensureItemLogForItem(item);
    writeItemLogEvent(item.id, level, message, {
      packageId: item.packageId,
      packageName: pkg?.name || "",
      itemId: item.id,
      fileName: item.fileName,
      status: item.status,
      targetPath: item.targetPath,
      ...fields
    });
  }

  private collectRenameMatchTokensForItem(pkg: PackageEntry, item: DownloadItem): string[] {
    const tokens = new Set<string>();
    const maybeAdd = (value: string | null | undefined): void => {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized || normalized.length < 4) {
        return;
      }
      tokens.add(normalized);
    };

    maybeAdd(stripArchiveSuffixForMatching(item.fileName || ""));
    maybeAdd(stripArchiveSuffixForMatching(item.targetPath ? path.basename(item.targetPath) : ""));
    const diskPath = resolvePackageItemDiskPath(pkg, item);
    if (diskPath) {
      maybeAdd(stripArchiveSuffixForMatching(path.basename(diskPath)));
    }
    const episodeToken = extractEpisodeToken(item.fileName || path.basename(item.targetPath || ""));
    if (episodeToken) {
      maybeAdd(episodeToken);
    }
    return [...tokens].sort((a, b) => b.length - a.length);
  }

  private inferItemForMediaLog(
    pkg: PackageEntry,
    ...candidates: Array<string | null | undefined>
  ): { item: DownloadItem | null; matchedBy: string | null } {
    const items = pkg.itemIds
      .map((itemId) => this.session.items[itemId])
      .filter(Boolean) as DownloadItem[];
    if (items.length === 0) {
      return { item: null, matchedBy: null };
    }
    if (items.length === 1) {
      return { item: items[0] || null, matchedBy: items[0] ? "single_item_package" : null };
    }

    const haystack = candidates
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .join(" || ");
    if (!haystack) {
      return { item: null, matchedBy: null };
    }

    let bestItem: DownloadItem | null = null;
    let bestScore = 0;
    let bestMatchedBy: string | null = null;
    let bestPreferredEntry = false;
    let ambiguous = false;

    for (const item of items) {
      const fileName = item.fileName || path.basename(item.targetPath || "");
      const preferredEntry = isPreferredArchiveEntryPointName(fileName);
      let score = preferredEntry ? 5 : 0;
      let matchedBy: string | null = preferredEntry ? "entry_point" : null;

      const episodeToken = extractEpisodeToken(fileName);
      if (episodeToken && haystack.includes(episodeToken.toLowerCase())) {
        score = 110 + (preferredEntry ? 5 : 0);
        matchedBy = "episode_token";
      } else {
        for (const token of this.collectRenameMatchTokensForItem(pkg, item)) {
          if (haystack.includes(token)) {
            score = Math.max(score, Math.min(100, 40 + token.length) + (preferredEntry ? 5 : 0));
            matchedBy = token === episodeToken?.toLowerCase() ? "episode_token" : `token:${token}`;
            break;
          }
        }
      }

      if (score > bestScore || (score === bestScore && score > 0 && preferredEntry && !bestPreferredEntry)) {
        bestItem = item;
        bestScore = score;
        bestMatchedBy = matchedBy;
        bestPreferredEntry = preferredEntry;
        ambiguous = false;
        continue;
      }
      if (score > 0 && score === bestScore && preferredEntry === bestPreferredEntry) {
        ambiguous = true;
      }
    }

    if (ambiguous || !bestItem || bestScore <= 0) {
      return { item: null, matchedBy: null };
    }
    return { item: bestItem, matchedBy: bestMatchedBy };
  }

  private logRenameProcess(
    pkg: PackageEntry,
    level: "INFO" | "WARN" | "ERROR",
    stage: "auto-rename" | "mkv-move",
    message: string,
    fields?: Record<string, unknown>,
    item?: DownloadItem | null,
    matchedBy?: string | null
  ): void {
    writeRenameLogEvent(level, message, {
      stage,
      packageId: pkg.id,
      packageName: pkg.name,
      ...(item ? { itemId: item.id, fileName: item.fileName } : {}),
      ...(matchedBy ? { matchedBy } : {}),
      ...fields
    });
    // Spiegeln ins Desktop-Rename-Log (luekenlose Sitzungs-Uebersicht beim User).
    logDesktopRename(level, `[${stage}] ${message}`, {
      paket: pkg.name,
      ...(item ? { datei: item.fileName } : {}),
      ...(matchedBy ? { matchedBy } : {}),
      ...fields
    });
    if (item) {
      this.logItemOnly(item, level, message, {
        stage,
        ...(matchedBy ? { matchedBy } : {}),
        ...fields
      });
    }
  }

  public applyDebridAccountStatuses(statuses: DebridAccountStatus[]): void {
    const map: Record<string, DebridAccountStatus> = { ...(this.settings.debridAccountStatuses || {}) };
    for (const status of statuses) {
      map[status.accountId] = status;
    }
    this.settings.debridAccountStatuses = map;
    this.invalidateSettingsSnapshotCache();
    void saveSettingsAsync(this.storagePaths, this.settings).catch((err) => logger.warn(`saveSettingsAsync Fehler (account-status): ${compactErrorText(err as Error)}`));
    this.emitState();
  }

  public setSettings(next: AppSettings): void {
    const previous = this.settings;
    next.totalDownloadedAllTime = Math.max(next.totalDownloadedAllTime || 0, this.settings.totalDownloadedAllTime || 0);
    next.totalCompletedFilesAllTime = Math.max(next.totalCompletedFilesAllTime || 0, this.settings.totalCompletedFilesAllTime || 0);
    const now = nowMs();
    next.totalRuntimeAllTimeMs = Math.max(next.totalRuntimeAllTimeMs || 0, this.getLiveTotalRuntimeMs(now));
    this.settings = next;
    this.invalidateSettingsSnapshotCache();
    this.runtimePersistedTotalMs = this.settings.totalRuntimeAllTimeMs || 0;
    this.runtimePersistedAt = now;
    this.ensureProviderDailyUsageFresh(nowMs());
    this.debridService.setSettings(next);
    this.allDebridHostInfoCache.clear();

    // When the provider order or hoster routing changes, clear the cached provider on
    // all non-active, non-terminal items so the new settings are respected on the next
    // download attempt.
    const prevOrder = JSON.stringify(previous.providerOrder ?? []);
    const nextOrder = JSON.stringify(next.providerOrder ?? []);
    const prevRouting = JSON.stringify(previous.hosterRouting ?? {});
    const nextRouting = JSON.stringify(next.hosterRouting ?? {});
    if (prevOrder !== nextOrder || prevRouting !== nextRouting) {
      const activeItemIds = new Set([...this.activeTasks.values()].map((t) => t.itemId));
      for (const item of Object.values(this.session.items)) {
        // Clear for all non-active items except truly finished ones (completed/failed).
        // "cancelled" items with fullStatus="Gestoppt" are stopped downloads that will
        // restart on the next start() call, so they must also get their provider cleared.
        if (!activeItemIds.has(item.id) && item.status !== "completed" && item.status !== "failed") {
          item.provider = null;
        }
      }
    }

    const previousArchivePasswords = String(previous.archivePasswordList || "").replace(/\r\n|\r/g, "\n");
    const nextArchivePasswords = String(next.archivePasswordList || "").replace(/\r\n|\r/g, "\n");
    if (previousArchivePasswords !== nextArchivePasswords) {
      this.hybridExtractedPaths.clear();
      this.hybridFailedArchives.clear();
      // Bug-Fix: ein neu hinzugefügtes Passwort griff bei "Jetzt entpacken" erst
      // nach App-Neustart. Der gesamte Settings-/Extract-Pfad propagiert die Liste
      // korrekt pro Request — aber der langlebige JVM-Daemon + der In-Memory
      // Learned-Password-Cache überleben einen Settings-Save (nur ein App-Neustart
      // setzt sie zurück). Wir replizieren den Neustart-Effekt am Extractor-
      // Subsystem: Learned-Cache leeren + idle Daemon herunterfahren, damit die
      // nächste Extraktion frisch mit der neuen Passwortliste startet.
      const pwCount = nextArchivePasswords.split("\n").filter(Boolean).length;
      const reset = resetExtractorCachesForPasswordChange();
      logger.info(`Archiv-Passwortliste geaendert (${pwCount} Eintraege): Extractor-Caches zurueckgesetzt (learned=${reset.learnedCleared}, daemonRestart=${reset.daemonRestarted})`);
    }

    // When account credentials change, clear the provider-failure circuit-breaker
    // for affected providers. Otherwise a freshly added account would inherit
    // the cooldown that the previous (now removed) account had triggered, and
    // the user would be confused why "their new account doesn't work right away".
    const credChanges: Array<{ prev: string; next: string; providers: string[] }> = [
      { prev: previous.token || "", next: next.token || "", providers: ["realdebrid"] },
      { prev: previous.allDebridToken || "", next: next.allDebridToken || "", providers: ["alldebrid"] },
      { prev: previous.bestDebridApiKey || "", next: next.bestDebridApiKey || "", providers: ["bestdebrid"] },
      { prev: previous.debridLinkApiKeys || "", next: next.debridLinkApiKeys || "", providers: ["debridlink"] },
      { prev: previous.linkSnappyLogin + "|" + previous.linkSnappyPassword, next: next.linkSnappyLogin + "|" + next.linkSnappyPassword, providers: ["linksnappy"] },
      { prev: previous.ddownloadLogin + "|" + previous.ddownloadPassword, next: next.ddownloadLogin + "|" + next.ddownloadPassword, providers: ["ddownload"] },
      { prev: previous.megaCredentials + "|" + previous.megaPassword, next: next.megaCredentials + "|" + next.megaPassword, providers: ["megadebrid", "megadebrid-api", "megadebrid-web"] }
    ];
    let clearedProviderFailures = 0;
    for (const change of credChanges) {
      if (change.prev === change.next) continue;
      for (const provider of change.providers) {
        // Provider failure keys are sometimes "provider" alone, sometimes "provider:hoster".
        // Clear all entries that start with the provider name.
        for (const key of [...this.providerFailures.keys()]) {
          if (key === provider || key.startsWith(`${provider}:`)) {
            this.providerFailures.delete(key);
            clearedProviderFailures += 1;
          }
        }
      }
    }
    if (clearedProviderFailures > 0) {
      logger.info(`Settings-Update: ${clearedProviderFailures} Provider-Failure(s) gecleart wegen geaenderter Credentials`);
    }

    this.resolveExistingQueuedOpaqueFilenames();
    void this.cleanupExistingExtractedArchives().catch((err) => logger.warn(`cleanupExistingExtractedArchives Fehler (setSettings): ${compactErrorText(err)}`));
    if (next.completedCleanupPolicy !== "never") {
      this.applyRetroactiveCleanupPolicy();
    }
    this.emitState();
  }

  public getSettings(): AppSettings {
    return this.settings;
  }

  public getSession(): SessionState {
    return cloneSession(this.session);
  }

  public getSummary(): DownloadSummary | null {
    return this.summary;
  }

  public isSessionRunning(): boolean {
    return this.session.running;
  }

  /** Abort all running post-processing tasks (extractions). */
  public abortAllPostProcessing(): void {
    this.abortPostProcessing("external");
    for (const waiter of this.packagePostProcessWaiters) { waiter.resolve(); }
    this.packagePostProcessWaiters = [];
    this.packagePostProcessActive = 0;
  }

  /** Trigger pending extractions without starting the session (for autoExtractWhenStopped). */
  public triggerIdleExtractions(): void {
    if (this.session.running || !this.settings.autoExtract || !this.settings.autoExtractWhenStopped) {
      return;
    }
    this.recoverPostProcessingOnStartup();
    this.triggerPendingExtractions();
    this.persistSoon();
    this.emitState();
  }

  /** Compact hash of the visible/mutable item fields. Two items with identical
   *  hashes are considered "no visible change" and can be excluded from delta
   *  emits. Field selection covers everything ItemRow/PackageCard render. */
  private buildItemHash(item: DownloadItem): string {
    return `${item.updatedAt}|${item.status}|${item.progressPercent}|${item.speedBps}|${item.downloadedBytes}|${item.totalBytes}|${item.retries}|${item.fullStatus || ""}|${item.fileName}|${item.providerLabel || ""}|${item.provider || ""}|${item.onlineStatus || ""}|${item.lastError || ""}`;
  }

  /** Compact hash of the visible/mutable package fields. */
  private buildPackageHash(pkg: PackageEntry): string {
    return `${pkg.updatedAt}|${pkg.status}|${pkg.name}|${pkg.enabled ? 1 : 0}|${pkg.cancelled ? 1 : 0}|${pkg.priority || ""}|${pkg.itemIds.length}|${pkg.postProcessLabel || ""}`;
  }

  /** Returns a snapshot suitable for IPC emit. On the first emit (or every
   *  30s for safety, or when explicitly forced), returns a "full" payload
   *  containing all items/packages. Otherwise returns a "delta" with only
   *  items/packages that changed since the last emit, plus removed IDs. */
  public getSnapshotForEmit(forceFull = false): UiSnapshot {
    const base = this.getSnapshot();
    const now = nowMs();
    const needsFullResync = !this.firstEmitDone || forceFull
      || (now - this.lastFullEmitAt) > DownloadManager.FULL_RESYNC_INTERVAL_MS;

    if (needsFullResync) {
      // Refresh tracking state to current snapshot
      this.lastEmittedItemHashes.clear();
      this.lastEmittedPackageHashes.clear();
      for (const id in base.session.items) {
        this.lastEmittedItemHashes.set(id, this.buildItemHash(base.session.items[id]));
      }
      for (const id in base.session.packages) {
        this.lastEmittedPackageHashes.set(id, this.buildPackageHash(base.session.packages[id]));
      }
      this.firstEmitDone = true;
      this.lastFullEmitAt = now;
      return { ...base, payloadKind: "full" };
    }

    // Build deltas: include only items/packages whose hash changed since last emit
    const changedItems: Record<string, DownloadItem> = {};
    const removedItemIds: string[] = [];
    const seenItemIds = new Set<string>();
    let itemChangeCount = 0;
    for (const id in base.session.items) {
      seenItemIds.add(id);
      const item = base.session.items[id];
      const newHash = this.buildItemHash(item);
      const oldHash = this.lastEmittedItemHashes.get(id);
      if (oldHash !== newHash) {
        changedItems[id] = item;
        this.lastEmittedItemHashes.set(id, newHash);
        itemChangeCount += 1;
      }
    }
    // Detect removed items
    for (const id of this.lastEmittedItemHashes.keys()) {
      if (!seenItemIds.has(id)) {
        removedItemIds.push(id);
      }
    }
    for (const id of removedItemIds) {
      this.lastEmittedItemHashes.delete(id);
    }

    const changedPackages: Record<string, PackageEntry> = {};
    const removedPackageIds: string[] = [];
    const seenPackageIds = new Set<string>();
    for (const id in base.session.packages) {
      seenPackageIds.add(id);
      const pkg = base.session.packages[id];
      const newHash = this.buildPackageHash(pkg);
      const oldHash = this.lastEmittedPackageHashes.get(id);
      if (oldHash !== newHash) {
        changedPackages[id] = pkg;
        this.lastEmittedPackageHashes.set(id, newHash);
      }
    }
    for (const id of this.lastEmittedPackageHashes.keys()) {
      if (!seenPackageIds.has(id)) {
        removedPackageIds.push(id);
      }
    }
    for (const id of removedPackageIds) {
      this.lastEmittedPackageHashes.delete(id);
    }

    return {
      ...base,
      session: {
        ...base.session,
        items: changedItems,
        packages: changedPackages,
      },
      payloadKind: "delta",
      removedItemIds,
      removedPackageIds,
    };
  }

  public getSnapshot(): UiSnapshot {
    const now = nowMs();
    this.ensureProviderDailyUsageFresh(now, true);
    this.pruneSpeedEvents(now);
    const paused = this.session.running && this.session.paused;
    const speedBps = !this.session.running || paused ? 0 : this.speedBytesLastWindow / SPEED_WINDOW_SECONDS;

    let totalItems = 0;
    let doneItems = 0;
    if (this.session.running && this.runItemIds.size > 0) {
      totalItems = this.runItemIds.size;
      for (const itemId of this.runItemIds) {
        if (this.runOutcomes.has(itemId)) {
          doneItems += 1;
          continue;
        }
        const item = this.session.items[itemId];
        if (item && isFinishedStatus(item.status)) {
          doneItems += 1;
        }
      }
    } else {
      const sessionItems = Object.values(this.session.items);
      totalItems = sessionItems.length;
      for (const item of sessionItems) {
        if (isFinishedStatus(item.status)) {
          doneItems += 1;
        }
      }
    }
    const elapsed = this.session.runStartedAt > 0 ? (now - this.session.runStartedAt) / 1000 : 0;
    const rate = doneItems > 0 && elapsed > 0 ? doneItems / elapsed : 0;
    const remaining = totalItems - doneItems;
    const eta = remaining > 0 && rate > 0 ? remaining / rate : -1;

    const reconnectMs = Math.max(0, this.session.reconnectUntil - now);

    const snapshotSession = cloneSession(this.session);
    // Cache the cloneSettings result for ~400ms. Settings are mutated in-place
    // (so a reference check wouldn't detect changes) but most snapshot ticks
    // happen close together (e.g. 700ms emit interval) where settings haven't
    // changed at all. Cloning 85+ fields + 6 nested usage Maps + bandwidth
    // schedules every ~700ms is wasteful when we can serve from cache for
    // most of those ticks. The 400ms TTL ensures user-driven settings changes
    // become visible within one render cycle of normal snapshot timing.
    // Manual invalidation via invalidateSettingsSnapshotCache() is called by
    // any code path that needs immediate visibility (replaceSettings, etc.).
    let snapshotSettings: AppSettings;
    if (this.settingsSnapshotCache && now - this.settingsSnapshotCacheAt < 400) {
      snapshotSettings = this.settingsSnapshotCache;
    } else {
      snapshotSettings = cloneSettings(this.settings);
      this.settingsSnapshotCache = snapshotSettings;
      this.settingsSnapshotCacheAt = now;
    }
    const snapshotSummary = this.summary
      ? { ...this.summary }
      : null;

    return {
      rotationEvents: getRecentRotationEvents(40),
      settings: snapshotSettings,
      session: snapshotSession,
      summary: snapshotSummary,
      stats: this.getStats(now),
      speedText: `Geschwindigkeit: ${humanSize(Math.max(0, Math.floor(speedBps)))}/s`,
      etaText: paused || !this.session.running ? "ETA: --" : `ETA: ${formatEta(eta)}`,
      canStart: !this.session.running,
      canStop: this.session.running,
      canPause: this.session.running,
      clipboardActive: this.settings.clipboardWatch,
      reconnectSeconds: Math.ceil(reconnectMs / 1000),
      packageSpeedBps: !this.session.running || paused
        ? EMPTY_PACKAGE_SPEED_BPS
        : (() => {
          // Direct loop avoids the [...Map].map().Object.fromEntries() allocation
          // chain (3 allocations per entry → 1).
          const out: Record<string, number> = {};
          for (const [pid, bytes] of this.speedBytesPerPackage) {
            out[pid] = Math.floor(bytes / SPEED_WINDOW_SECONDS);
          }
          return out;
        })()
    };
  }

  public getStats(now = nowMs()): DownloadStats {
    const itemCount = this.itemCount;
    if (this.statsCache && this.session.running && itemCount >= 500 && now - this.statsCacheAt < 1500) {
      return this.statsCache;
    }

    this.resetSessionTotalsIfQueueEmpty();

    const stats = {
      totalDownloaded: this.sessionDownloadedBytes,
      totalDownloadedAllTime: this.settings.totalDownloadedAllTime,
      totalFiles: this.sessionCompletedFiles,
      totalFilesSession: this.sessionCompletedFiles,
      totalFilesAllTime: this.settings.totalCompletedFilesAllTime,
      totalPackages: this.session.packageOrder.length,
      sessionStartedAt: this.session.runStartedAt,
      appSessionStartedAt: this.appSessionStartedAt,
      sessionRuntimeMs: this.getAppSessionRuntimeMs(now),
      totalRuntimeMs: this.getLiveTotalRuntimeMs(now),
      runtimeMeasuredAt: now
    };
    this.statsCache = stats;
    this.statsCacheAt = now;
    return stats;
  }

  public getLiveTotalRuntimeMs(now = nowMs()): number {
    return Math.max(0, this.runtimePersistedTotalMs + Math.max(0, now - this.runtimePersistedAt));
  }

  private getAppSessionRuntimeMs(now = nowMs()): number {
    return this.appSessionStartedAt > 0 ? Math.max(0, now - this.appSessionStartedAt) : 0;
  }

  private foldRuntimeIntoSettings(now = nowMs()): boolean {
    const totalRuntimeMs = this.getLiveTotalRuntimeMs(now);
    if (!Number.isFinite(totalRuntimeMs) || totalRuntimeMs <= (this.settings.totalRuntimeAllTimeMs || 0)) {
      return false;
    }
    this.settings.totalRuntimeAllTimeMs = totalRuntimeMs;
    this.runtimePersistedTotalMs = totalRuntimeMs;
    this.runtimePersistedAt = now;
    this.invalidateStatsCache();
    return true;
  }

  public persistRuntimeStats(sync = false): void {
    if (this.blockAllPersistence) {
      return;
    }
    const now = nowMs();
    if (!this.foldRuntimeIntoSettings(now)) {
      if (sync && !fs.existsSync(this.storagePaths.configFile)) {
        saveSettings(this.storagePaths, this.settings);
      }
      return;
    }
    this.lastSettingsPersistAt = now;
    if (sync) {
      saveSettings(this.storagePaths, this.settings);
      return;
    }
    void saveSettingsAsync(this.storagePaths, this.settings).catch((err) => logger.warn(`saveSettingsAsync Fehler: ${compactErrorText(err as Error)}`));
  }

  private invalidateStatsCache(): void {
    this.statsCache = null;
    this.statsCacheAt = 0;
  }

  private resetSessionTotalsIfQueueEmpty(force = false): void {
    // Cheap O(1) check via cached counters covers the common case.
    // The Object.keys() cross-check below was redundant — itemCount and
    // packageOrder are kept in sync with session.items / session.packages
    // by every mutation site, so the second check just allocated two
    // arrays per call without ever changing the outcome.
    if (this.itemCount > 0 || this.session.packageOrder.length > 0) {
      return;
    }
    if (!force && (this.sessionDownloadedBytes > 0 || this.sessionCompletedFiles > 0 || this.itemContributedBytes.size > 0)) {
      return;
    }
    let changed = false;
    if (this.session.totalDownloadedBytes !== 0) {
      this.session.totalDownloadedBytes = 0;
      changed = true;
    }
    if (this.sessionDownloadedBytes !== 0) {
      this.sessionDownloadedBytes = 0;
      changed = true;
    }
    if (this.sessionCompletedFiles !== 0) {
      this.sessionCompletedFiles = 0;
      changed = true;
    }
    if (this.session.runStartedAt !== 0) {
      this.session.runStartedAt = 0;
      changed = true;
    }
    if (this.session.summaryText) {
      this.session.summaryText = "";
      changed = true;
    }
    if (this.lastGlobalProgressBytes !== 0) {
      this.lastGlobalProgressBytes = 0;
      changed = true;
    }
    if (this.speedEvents.length > 0 || this.speedBytesLastWindow !== 0 || this.speedBytesPerPackage.size > 0) {
      this.speedEvents = [];
      this.speedBytesLastWindow = 0;
      this.speedBytesPerPackage.clear();
      this.speedEventsHead = 0;
      changed = true;
    }
    if (changed) {
      this.invalidateStatsCache();
    }
  }

  private getPackagePostProcessVersion(packageId: string): number {
    return this.packagePostProcessVersions.get(packageId) || 0;
  }

  private bumpPackagePostProcessVersion(packageId: string): number {
    const next = this.getPackagePostProcessVersion(packageId) + 1;
    this.packagePostProcessVersions.set(packageId, next);
    return next;
  }

  private abortPackagePostProcessing(packageId: string, reason: string, invalidateDeferred = true): void {
    if (invalidateDeferred) {
      this.bumpPackagePostProcessVersion(packageId);
    }

    const postProcessController = this.packagePostProcessAbortControllers.get(packageId);
    if (postProcessController && !postProcessController.signal.aborted) {
      postProcessController.abort(reason);
    }
    this.packagePostProcessAbortControllers.delete(packageId);
    this.packagePostProcessTasks.delete(packageId);

    const deferredController = this.packageDeferredPostProcessAbortControllers.get(packageId);
    if (deferredController && !deferredController.signal.aborted) {
      deferredController.abort(reason);
    }
    this.packageDeferredPostProcessAbortControllers.delete(packageId);

    // Auch laufende Hybrid-Post-Extract-Promises (Rename/MKV-Collect) abbrechen. (H2)
    const hybridSet = this.packageHybridPostProcessControllers.get(packageId);
    if (hybridSet) {
      for (const controller of hybridSet) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      }
      this.packageHybridPostProcessControllers.delete(packageId);
    }

    this.hybridExtractRequeue.delete(packageId);
    this.clearHybridArchiveState(packageId);
  }

  private isDeferredPostProcessStillCurrent(
    packageId: string,
    pkg: PackageEntry,
    version: number,
    signal?: AbortSignal
  ): boolean {
    if (signal?.aborted) {
      return false;
    }
    if (this.session.packages[packageId] !== pkg) {
      return false;
    }
    return this.getPackagePostProcessVersion(packageId) === version;
  }

  private throwIfDeferredPostProcessAborted(
    packageId: string,
    pkg: PackageEntry,
    version: number,
    signal?: AbortSignal
  ): void {
    if (this.isDeferredPostProcessStillCurrent(packageId, pkg, version, signal)) {
      return;
    }
    throw new Error(String(signal?.reason || "aborted:deferred"));
  }

  private packageOutputDirInUse(outputDir: string): boolean {
    const key = pathKey(outputDir);
    return Object.values(this.session.packages).some((pkg) => pathKey(pkg.outputDir) === key);
  }

  public resetSessionStats(): void {
    const now = nowMs();
    this.session.totalDownloadedBytes = 0;
    this.sessionDownloadedBytes = 0;
    this.sessionCompletedFiles = 0;
    this.session.runStartedAt = this.session.running ? now : 0;
    this.appSessionStartedAt = now;
    this.session.summaryText = "";
    this.lastGlobalProgressBytes = 0;
    this.lastGlobalProgressAt = now;
    this.speedEvents = [];
    this.speedEventsHead = 0;
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.summary = null;
    this.invalidateStatsCache();
    this.persistSoon();
    this.emitState(true);
  }

  public resetDownloadStats(): void {
    this.settings.totalDownloadedAllTime = 0;
    this.settings.totalCompletedFilesAllTime = 0;
    this.settings.providerTotalUsageBytes = {};
    this.settings.debridLinkApiKeyTotalUsageBytes = {};
    this.lastSettingsPersistAt = nowMs();
    saveSettings(this.storagePaths, this.settings);
    this.invalidateStatsCache();
    this.emitState(true);
  }

  public renamePackage(packageId: string, newName: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }
    const previousName = pkg.name;
    pkg.name = sanitizeFilename(newName) || pkg.name;
    pkg.updatedAt = nowMs();
    this.logPackageForPackage(pkg, "INFO", "Paket umbenannt", {
      oldName: previousName,
      newName: pkg.name
    });
    this.persistSoon();
    this.emitState(true);
  }

  public reorderPackages(packageIds: string[]): void {
    const seen = new Set<string>();
    const valid = packageIds.filter((id) => {
      if (!this.session.packages[id] || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
    const remaining = this.session.packageOrder.filter((id) => !seen.has(id));
    this.session.packageOrder = [...valid, ...remaining];
    this.persistSoon();
    this.emitState(true);
  }

  public removeItem(itemId: string): void {
    const item = this.session.items[itemId];
    if (!item) {
      return;
    }
    this.logPackageForItem(item, "WARN", "Item entfernt", {
      url: item.url
    });
    this.recordRunOutcome(itemId, "cancelled");
    const active = this.activeTasks.get(itemId);
    const hasActiveTask = Boolean(active);
    if (active) {
      active.abortReason = "cancel";
      active.abortController.abort("cancel");
    }
    const pkg = this.session.packages[item.packageId];
    let removedByPackageCleanup = false;
    if (pkg) {
      pkg.itemIds = pkg.itemIds.filter((id) => id !== itemId);
      if (pkg.itemIds.length === 0) {
        this.removePackageFromSession(item.packageId, [itemId]);
        removedByPackageCleanup = true;
      } else {
        pkg.updatedAt = nowMs();
      }
    }
    // removePackageFromSession already deletes the item and decrements itemCount
    if (!removedByPackageCleanup) {
      delete this.session.items[itemId];
      this.itemCount = Math.max(0, this.itemCount - 1);
    }
    this.retryAfterByItem.delete(itemId);
    this.retryStateByItem.delete(itemId);
    this.dropItemContribution(itemId);
    if (!hasActiveTask) {
      this.releaseTargetPath(itemId);
    }
    this.persistSoon();
    this.emitState(true);
  }

  public togglePackage(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }

    const nextEnabled = !pkg.enabled;
    pkg.enabled = nextEnabled;

    if (!nextEnabled) {
      if (pkg.status === "downloading" || pkg.status === "extracting") {
        pkg.status = "paused";
      }
      this.abortPackagePostProcessing(packageId, "package_toggle");
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        if (this.session.running && !isFinishedStatus(item.status) && !this.runOutcomes.has(itemId)) {
          this.runItemIds.delete(itemId);
        }
        const active = this.activeTasks.get(itemId);
        if (active) {
          active.abortReason = "package_toggle";
          active.abortController.abort("package_toggle");
          continue;
        }
        if (item.status === "queued" || item.status === "reconnect_wait") {
          item.status = "queued";
          item.speedBps = 0;
          item.fullStatus = "Paket gestoppt";
          item.updatedAt = nowMs();
        }
      }
      this.runPackageIds.delete(packageId);
      this.runCompletedPackages.delete(packageId);
    } else {
      if (pkg.status === "paused") {
        pkg.status = "queued";
      }
      let hasReactivatedRunItems = false;
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        if (this.session.running && !isFinishedStatus(item.status)) {
          this.runOutcomes.delete(itemId);
          this.runItemIds.add(itemId);
          hasReactivatedRunItems = true;
        }
        if (item.status === "queued" && item.fullStatus === "Paket gestoppt") {
          item.fullStatus = "Wartet";
          item.updatedAt = nowMs();
        }
      }
      if (this.session.running) {
        if (hasReactivatedRunItems) {
          this.runPackageIds.add(packageId);
        }
        void this.ensureScheduler().catch((err) => logger.warn(`ensureScheduler Fehler (togglePackage): ${compactErrorText(err)}`));
      }
    }

    pkg.updatedAt = nowMs();
    this.persistSoon();
    this.emitState(true);
  }

  public exportQueue(): string {
    const exportData = {
      version: 1,
      packages: this.session.packageOrder.map((id) => {
        const pkg = this.session.packages[id];
        if (!pkg) {
          return null;
        }
        const entries = pkg.itemIds
          .map((itemId) => this.session.items[itemId])
          .filter((item): item is DownloadItem => Boolean(item && item.url));
        return {
          name: pkg.name,
          links: entries.map((item) => item.url),
          fileNames: entries.map((item) => item.fileName || "")
        };
      }).filter(Boolean)
    };
    return JSON.stringify(exportData, null, 2);
  }

  public importQueue(json: string): { addedPackages: number; addedLinks: number } {
    const trimmed = String(json || "").trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let data: { packages?: Array<{ name: string; links: string[]; fileNames?: string[] }> };
      try {
        data = JSON.parse(json) as { packages?: Array<{ name: string; links: string[]; fileNames?: string[] }> };
      } catch {
        throw new Error("Ungultige Queue-Datei (JSON)");
      }
      if (!Array.isArray(data.packages)) {
        return { addedPackages: 0, addedLinks: 0 };
      }
      const inputs: ParsedPackageInput[] = data.packages
        .map((pkg) => {
          const name = typeof pkg?.name === "string" ? pkg.name : "";
          const linksRaw = Array.isArray(pkg?.links) ? pkg.links : [];
          const fileNamesRaw = Array.isArray(pkg?.fileNames) ? pkg.fileNames : [];
          const entries = linksRaw
            .map((link, index) => ({
              link: typeof link === "string" ? link.trim() : "",
              fileName: typeof fileNamesRaw[index] === "string" ? fileNamesRaw[index].trim() : ""
            }))
            .filter((entry) => entry.link.length > 0);
          const links = entries.map((entry) => entry.link);
          const fileNames = entries.map((entry) => entry.fileName);
          return {
            name,
            links,
            ...(fileNames.some((fileName) => fileName.length > 0) ? { fileNames } : {})
          };
        })
        .filter((pkg) => pkg.name.trim().length > 0 && pkg.links.length > 0);
      return this.addPackages(inputs);
    }

    const inputs = parseCollectorInput(json, "");
    if (inputs.length === 0) {
      return { addedPackages: 0, addedLinks: 0 };
    }
    return this.addPackages(inputs);
  }

  public clearAll(): void {
    this.clearPersistTimer();
    this.stop();
    this.abortPostProcessing("clear_all");
    if (this.stateEmitTimer) {
      clearTimeout(this.stateEmitTimer);
      this.stateEmitTimer = null;
    }
    this.session.packageOrder = [];
    this.session.packages = {};
    this.session.items = {};
    this.itemCount = 0;
    this.session.summaryText = "";
    this.runItemIds.clear();
    this.runPackageIds.clear();
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.historyRecordedPackages.clear();
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.retryStateByItem.clear();
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();
    this.itemContributedBytes.clear();
    this.speedEvents = [];
    this.speedEventsHead = 0;
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.packagePostProcessTasks.clear();
    this.packagePostProcessAbortControllers.clear();
    this.packageDeferredPostProcessAbortControllers.clear();
    this.packageHybridPostProcessControllers.clear();
    this.hybridExtractRequeue.clear();
    this.hybridExtractedPaths.clear();
    this.hybridFailedArchives.clear();
    this.providerFailures.clear();
    this.packagePostProcessQueue = Promise.resolve();
    this.packagePostProcessActive = 0;
    for (const waiter of this.packagePostProcessWaiters) { waiter.resolve(); }
    this.packagePostProcessWaiters = [];
    this.summary = null;
    this.nonResumableActive = 0;
    this.resetSessionTotalsIfQueueEmpty(true);
    this.persistNow();
    this.emitState(true);
  }

  public addPackages(packages: ParsedPackageInput[]): { addedPackages: number; addedLinks: number } {
    let addedPackages = 0;
    let addedLinks = 0;
    const unresolvedByLink = new Map<string, string[]>();
    const newItemIds: string[] = [];
    for (const pkg of packages) {
      const links = pkg.links.filter((link) => !!link.trim());
      if (links.length === 0) {
        continue;
      }
      const packageId = uuidv4();
      const safeName = sanitizeFilename(pkg.name);
      const outputDir = ensureDirPath(this.settings.outputDir, safeName);
      const extractBase = this.settings.extractDir || path.join(this.settings.outputDir, "_entpackt");
      const extractDir = this.settings.createExtractSubfolder ? ensureDirPath(extractBase, safeName) : extractBase;
      const packageEntry: PackageEntry = {
        id: packageId,
        name: safeName,
        outputDir,
        extractDir,
        status: "queued",
        itemIds: [],
        cancelled: false,
        enabled: true,
        priority: "normal",
        downloadStartedAt: 0,
        downloadCompletedAt: 0,
        createdAt: nowMs(),
        updatedAt: nowMs()
      };
      this.ensurePackageLogForPackage(packageEntry);
      this.logPackageForPackage(packageEntry, "INFO", "Paket angelegt", {
        outputDir,
        extractDir,
        linkCount: links.length
      });

      // Collect per-link summary for ONE batched package-log entry after the
      // loop, instead of ~10 sync FS calls per link. A DLC with many packages
      // was freezing the UI for 1-2 minutes because logPackageForItem called
      // ensurePackageLog + ensureItemLog + appendFileSync×multiple per link.
      const registeredLinkSummary: string[] = [];
      for (let linkIdx = 0; linkIdx < links.length; linkIdx += 1) {
        const link = links[linkIdx];
        const itemId = uuidv4();
        const hintName = pkg.fileNames?.[linkIdx];
        const fileName = (hintName && !looksLikeOpaqueFilename(hintName)) ? sanitizeFilename(hintName) : filenameFromUrl(link);
        const item: DownloadItem = {
          id: itemId,
          packageId,
          url: link,
          provider: null,
          status: "queued",
          retries: 0,
          speedBps: 0,
          downloadedBytes: 0,
          totalBytes: null,
          progressPercent: 0,
          fileName,
          targetPath: "",
          resumable: true,
          attempts: 0,
          lastError: "",
          fullStatus: "Wartet",
          createdAt: nowMs(),
          updatedAt: nowMs()
        };
        this.assignItemTargetPath(item, path.join(outputDir, fileName));
        registeredLinkSummary.push(`#${linkIdx + 1} ${fileName} <- ${link}`);
        packageEntry.itemIds.push(itemId);
        this.session.items[itemId] = item;
        this.itemCount += 1;
        if (this.session.running) {
          this.runItemIds.add(itemId);
          this.runPackageIds.add(packageId);
        }
        if (looksLikeOpaqueFilename(fileName)) {
          const existing = unresolvedByLink.get(link) ?? [];
          existing.push(itemId);
          unresolvedByLink.set(link, existing);
        }
        newItemIds.push(itemId);
        addedLinks += 1;
      }

      // One batched log entry per package instead of one per link.
      // Item-logs are left uninitialized here — they'll be lazily created
      // the first time the item actually gets a real lifecycle event
      // (download start, error, etc.). For very large packages (>50 links)
      // we only log the first 20 + a "... +N more" suffix so the single log
      // line doesn't grow into hundreds of KB.
      if (registeredLinkSummary.length > 0) {
        const PREVIEW = 20;
        const linksField = registeredLinkSummary.length <= 50
          ? registeredLinkSummary.join(" | ")
          : `${registeredLinkSummary.slice(0, PREVIEW).join(" | ")} | ... +${registeredLinkSummary.length - PREVIEW} more`;
        this.logPackageForPackage(packageEntry, "INFO", `Links registriert (${registeredLinkSummary.length})`, {
          links: linksField
        });
      }

      this.session.packages[packageId] = packageEntry;
      this.session.packageOrder.push(packageId);
      addedPackages += 1;
    }

    if (addedPackages > 0 || addedLinks > 0) {
      const pkgNames = packages.filter((p) => p.links.length > 0).map((p) => p.name).join(", ");
      logger.info(`Pakete hinzugefügt: ${addedPackages} Paket(e), ${addedLinks} Link(s) [${pkgNames}]`);
    }
    this.persistSoon();
    this.emitState();
    if (unresolvedByLink.size > 0) {
      void this.resolveQueuedFilenames(unresolvedByLink).catch((err) => logger.warn(`resolveQueuedFilenames Fehler (addPackages): ${compactErrorText(err)}`));
    }
    if (newItemIds.length > 0) {
      void this.checkRapidgatorLinks(newItemIds).catch((err) => logger.warn(`checkRapidgatorLinks Fehler: ${compactErrorText(err)}`));
    }
    return { addedPackages, addedLinks };
  }

  public async getStartConflicts(): Promise<StartConflictEntry[]> {
    const hasFilesByExtractDir = new Map<string, boolean>();
    const conflicts: StartConflictEntry[] = [];
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }

      const hasPendingItems = pkg.itemIds.some((itemId) => {
        const item = this.session.items[itemId];
        if (!item) {
          return false;
        }
        return item.status === "queued" || item.status === "reconnect_wait";
      });
      if (!hasPendingItems) {
        continue;
      }

      if (!this.isPackageSpecificExtractDir(pkg)) {
        continue;
      }

      const extractDirKey = pathKey(pkg.extractDir);
      const hasExtractedFiles = hasFilesByExtractDir.has(extractDirKey)
        ? Boolean(hasFilesByExtractDir.get(extractDirKey))
        : await this.directoryHasAnyFiles(pkg.extractDir);
      if (!hasFilesByExtractDir.has(extractDirKey)) {
        hasFilesByExtractDir.set(extractDirKey, hasExtractedFiles);
      }

      if (hasExtractedFiles) {
        conflicts.push({
          packageId: pkg.id,
          packageName: pkg.name,
          extractDir: pkg.extractDir
        });
      }
    }
    return conflicts;
  }

  public async resolveStartConflict(packageId: string, policy: DuplicatePolicy): Promise<StartConflictResolutionResult> {
    const pkg = this.session.packages[packageId];
    if (!pkg || pkg.cancelled) {
      return { skipped: false, overwritten: false };
    }

    if (policy === "skip") {
      let hadPendingItems = false;
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        if (item.status === "queued" || item.status === "reconnect_wait") {
          hadPendingItems = true;
        }

        const active = this.activeTasks.get(itemId);
        if (active) {
          active.abortReason = "package_toggle";
          active.abortController.abort("package_toggle");
        }

        if (item.status === "queued" || item.status === "reconnect_wait") {
          item.status = "queued";
          item.speedBps = 0;
          item.lastError = "";
          item.fullStatus = "Wartet";
          item.updatedAt = nowMs();
        }

        this.runItemIds.delete(itemId);
        this.runOutcomes.delete(itemId);

        this.retryAfterByItem.delete(itemId);
        this.retryStateByItem.delete(itemId);
      }

      this.abortPackagePostProcessing(packageId, "skip");

      this.runPackageIds.delete(packageId);
      this.runCompletedPackages.delete(packageId);

      const items = pkg.itemIds
        .map((itemId) => this.session.items[itemId])
        .filter(Boolean) as DownloadItem[];
      const hasPendingNow = items.some((item) => item.status === "queued" || item.status === "reconnect_wait");
      if (hadPendingItems || hasPendingNow) {
        pkg.status = pkg.enabled ? "queued" : "paused";
      }
      pkg.updatedAt = nowMs();

      this.persistSoon();
      this.emitState(true);

      // Fix async race: processItem catch with "package_toggle" overwrites fullStatus
      // after we already set it to "Wartet". Re-fix on next microtask.
      const pkgItemIds = [...pkg.itemIds];
      queueMicrotask(() => {
        for (const iid of pkgItemIds) {
          const it = this.session.items[iid];
          if (it && it.status === "queued" && it.fullStatus === "Paket gestoppt") {
            it.fullStatus = "Wartet";
            it.updatedAt = nowMs();
          }
        }
        this.emitState(true);
      });

      return { skipped: true, overwritten: false };
    }

    if (policy === "overwrite") {
      this.abortPackagePostProcessing(packageId, "overwrite");
      const canDeleteExtractDir = this.isPackageSpecificExtractDir(pkg) && !this.isExtractDirSharedWithOtherPackages(pkg.id, pkg.extractDir);
      if (canDeleteExtractDir) {
        try {
          await fs.promises.rm(pkg.extractDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      try {
        await fs.promises.rm(pkg.outputDir, { recursive: true, force: true });
      } catch {
        // ignore
      }

      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        const active = this.activeTasks.get(itemId);
        if (active) {
          active.abortReason = "reset";
          active.abortController.abort("reset");
        }
        this.releaseTargetPath(itemId);
        item.status = "queued";
        item.retries = 0;
        item.speedBps = 0;
        item.downloadedBytes = 0;
        item.totalBytes = null;
        item.progressPercent = 0;
        item.resumable = true;
        item.attempts = 0;
        item.lastError = "";
        item.fullStatus = "Wartet";
        item.provider = null;
        item.updatedAt = nowMs();
        this.assignItemTargetPath(item, path.join(pkg.outputDir, sanitizeFilename(item.fileName || filenameFromUrl(item.url))));
        this.runOutcomes.delete(itemId);
        this.dropItemContribution(itemId);
        this.retryAfterByItem.delete(itemId);
        this.retryStateByItem.delete(itemId);
        if (this.session.running) {
          this.runItemIds.add(itemId);
        }
      }
      this.runCompletedPackages.delete(packageId);
      if (this.session.running) {
        this.runPackageIds.add(packageId);
      }
      pkg.status = "queued";
      pkg.updatedAt = nowMs();
      this.persistSoon();
      this.emitState(true);
      void this.ensureScheduler().catch((err) => logger.warn(`ensureScheduler Fehler (resolveStartConflict): ${compactErrorText(err)}`));
      return { skipped: false, overwritten: true };
    }

    return { skipped: false, overwritten: false };
  }

  private isPackageSpecificExtractDir(pkg: PackageEntry): boolean {
    const expectedName = sanitizeFilename(pkg.name).toLowerCase();
    if (!expectedName) {
      return false;
    }
    return path.basename(pkg.extractDir).toLowerCase() === expectedName;
  }

  private isExtractDirSharedWithOtherPackages(packageId: string, extractDir: string): boolean {
    const key = pathKey(extractDir);
    for (const otherId of this.session.packageOrder) {
      if (otherId === packageId) {
        continue;
      }
      const other = this.session.packages[otherId];
      if (!other || other.cancelled) {
        continue;
      }
      if (pathKey(other.extractDir) === key) {
        return true;
      }
    }
    return false;
  }

  private async resolveQueuedFilenames(unresolvedByLink: Map<string, string[]>): Promise<void> {
    try {
      let changed = false;
      const applyResolvedName = (link: string, fileName: string): void => {
        const itemIds = unresolvedByLink.get(link);
        if (!itemIds || itemIds.length === 0) {
          return;
        }
        if (!fileName || fileName.toLowerCase() === "download.bin") {
          return;
        }
        const normalized = sanitizeFilename(fileName);
        if (!normalized || normalized.toLowerCase() === "download.bin") {
          return;
        }

        let changedForLink = false;
        for (const itemId of itemIds) {
          const item = this.session.items[itemId];
          if (!item) {
            continue;
          }
          if (!looksLikeOpaqueFilename(item.fileName)) {
            continue;
          }
          if (item.status !== "queued" && item.status !== "reconnect_wait") {
            continue;
          }
          item.fileName = normalized;
          this.assignItemTargetPath(item, path.join(this.session.packages[item.packageId]?.outputDir || this.settings.outputDir, normalized));
          item.updatedAt = nowMs();
          changed = true;
          changedForLink = true;
        }

        if (changedForLink) {
          this.persistSoon();
          this.emitState();
        }
      };

      await this.debridService.resolveFilenames(Array.from(unresolvedByLink.keys()), applyResolvedName);

      if (changed) {
        this.persistSoon();
        this.emitState();
      }
    } catch (error) {
      logger.warn(`Dateinamen-Resolve fehlgeschlagen: ${compactErrorText(error)}`);
    }
  }

  private async checkRapidgatorLinks(itemIds: string[]): Promise<void> {
    const itemsToCheck: Array<{ itemId: string; url: string }> = [];

    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item || item.status !== "queued") continue;
      item.onlineStatus = "checking";
      itemsToCheck.push({ itemId, url: item.url });
    }
    if (itemsToCheck.length > 0) {
      this.emitState();
    }

    // Check links one by one (sequentially) so the user sees dots change progressively
    const checkedUrls = new Map<string, Awaited<ReturnType<typeof checkRapidgatorOnline>>>();

    for (const { itemId, url } of itemsToCheck) {
      const item = this.session.items[itemId];
      if (!item) continue;

      // Reuse result if same URL was already checked
      if (checkedUrls.has(url)) {
        const cached = checkedUrls.get(url);
        if (cached !== undefined) {
          this.applyRapidgatorCheckResult(item, cached);
        }
        this.emitState();
        continue;
      }

      try {
        const result = await checkRapidgatorOnline(url);
        checkedUrls.set(url, result);
        this.applyRapidgatorCheckResult(item, result);
      } catch (err) {
        logger.warn(`checkRapidgatorOnline Fehler für ${url}: ${compactErrorText(err)}`);
        item.onlineStatus = undefined;
      }
      this.emitState();
    }

    this.persistSoon();
  }

  private resolveExistingQueuedOpaqueFilenames(): void {
    const unresolvedByLink = new Map<string, string[]>();
    for (const item of Object.values(this.session.items)) {
      if (!looksLikeOpaqueFilename(item.fileName)) {
        continue;
      }
      if (item.status !== "queued" && item.status !== "reconnect_wait") {
        continue;
      }
      const pkg = this.session.packages[item.packageId];
      if (!pkg || pkg.cancelled) {
        continue;
      }
      const existing = unresolvedByLink.get(item.url) ?? [];
      existing.push(item.id);
      unresolvedByLink.set(item.url, existing);
    }

    if (unresolvedByLink.size > 0) {
      void this.resolveQueuedFilenames(unresolvedByLink).catch((err) => logger.warn(`resolveQueuedFilenames Fehler (resolveExisting): ${compactErrorText(err)}`));
    }
  }

  private applyRapidgatorCheckResult(item: DownloadItem, result: Awaited<ReturnType<typeof checkRapidgatorOnline>>): void {
    if (!result) {
      if (item.onlineStatus === "checking") {
        item.onlineStatus = undefined;
      }
      return;
    }
    if (item.status !== "queued") return;

    if (!result.online) {
      item.status = "failed";
      item.fullStatus = "Offline";
      item.lastError = "Datei nicht gefunden auf Rapidgator";
      item.onlineStatus = "offline";
      item.updatedAt = nowMs();
      if (this.runItemIds.has(item.id)) {
        this.recordRunOutcome(item.id, "failed");
      }
      // Refresh package status since item was set to failed
      const pkg = this.session.packages[item.packageId];
      if (pkg) this.refreshPackageStatus(pkg);
    } else {
      if (result.fileName && looksLikeOpaqueFilename(item.fileName)) {
        item.fileName = sanitizeFilename(result.fileName);
        this.assignItemTargetPath(item, path.join(this.session.packages[item.packageId]?.outputDir || this.settings.outputDir, item.fileName));
      }
      item.onlineStatus = "online";
      item.updatedAt = nowMs();
    }
  }

  private checkExistingRapidgatorLinks(): void {
    const uncheckedIds: string[] = [];
    for (const item of Object.values(this.session.items)) {
      if (item.status !== "queued") continue;
      if (item.onlineStatus) continue; // already checked
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        if (host !== "rapidgator.net" && !host.endsWith(".rapidgator.net") && host !== "rg.to" && !host.endsWith(".rg.to")) continue;
      } catch { continue; }
      uncheckedIds.push(item.id);
    }
    if (uncheckedIds.length > 0) {
      void this.checkRapidgatorLinks(uncheckedIds).catch((err) => logger.warn(`checkRapidgatorLinks Fehler (startup): ${compactErrorText(err)}`));
    }
  }

  private async cleanupExistingExtractedArchives(): Promise<void> {
    if (this.settings.cleanupMode === "none") {
      return;
    }

    const extractDirUsage = new Map<string, number>();
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.extractDir) {
        continue;
      }
      const key = pathKey(pkg.extractDir);
      extractDirUsage.set(key, (extractDirUsage.get(key) || 0) + 1);
    }

    const cleanupTargetsByPackage = new Map<string, Set<string>>();
    const dirFilesCache = new Map<string, string[]>();
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || pkg.status !== "completed") {
        continue;
      }
      if (this.packagePostProcessTasks.has(packageId)) {
        continue;
      }

      const items = pkg.itemIds
        .map((itemId) => this.session.items[itemId])
        .filter(Boolean) as DownloadItem[];
      if (items.length === 0 || !items.every((item) => item.status === "completed")) {
        continue;
      }

      const hasExtractErrors = items.some((item) => isExtractErrorLabel(item.fullStatus || ""));
      if (hasExtractErrors) {
        logger.info(`Nachträgliches Cleanup übersprungen: pkg=${pkg.name}, reason=extract_error_present`);
        continue;
      }

      const hasExtractMarker = items.some((item) => isExtractedLabel(item.fullStatus));
      const extractDirIsUnique = (extractDirUsage.get(pathKey(pkg.extractDir)) || 0) === 1;
      const hasExtractedOutput = extractDirIsUnique && await this.directoryHasAnyFiles(pkg.extractDir);
      if (!hasExtractMarker && !hasExtractedOutput) {
        continue;
      }

      const packageTargets = cleanupTargetsByPackage.get(packageId) ?? new Set<string>();
      for (const item of items) {
        const rawTargetPath = String(item.targetPath || "").trim();
        const fallbackTargetPath = item.fileName ? path.join(pkg.outputDir, sanitizeFilename(item.fileName)) : "";
        const targetPath = rawTargetPath || fallbackTargetPath;
        if (!targetPath || !isArchiveLikePath(targetPath)) {
          continue;
        }
        const dir = path.dirname(targetPath);
        let filesInDir = dirFilesCache.get(dir);
        if (!filesInDir) {
          try {
            filesInDir = (await fs.promises.readdir(dir, { withFileTypes: true }))
              .filter((entry) => entry.isFile())
              .map((entry) => entry.name);
          } catch {
            filesInDir = [];
          }
          dirFilesCache.set(dir, filesInDir);
        }

        for (const cleanupTarget of collectArchiveCleanupTargets(targetPath, filesInDir)) {
          packageTargets.add(cleanupTarget);
        }
      }
      if (packageTargets.size > 0) {
        cleanupTargetsByPackage.set(packageId, packageTargets);
      }
    }

    if (cleanupTargetsByPackage.size === 0) {
      return;
    }

    this.cleanupQueue = this.cleanupQueue
      .then(async () => {
        for (const [packageId, targets] of cleanupTargetsByPackage.entries()) {
          const pkg = this.session.packages[packageId];
          if (!pkg) {
            continue;
          }

          logger.info(`Nachträgliches Cleanup geprüft: pkg=${pkg.name}, targets=${targets.size}, marker=${pkg.itemIds.some((id) => isExtractedLabel(this.session.items[id]?.fullStatus || ""))}`);

          let removed = 0;
          for (const targetPath of targets) {
            if (!await this.existsAsync(targetPath)) {
              continue;
            }
            try {
              await fs.promises.rm(targetPath, { force: true });
              removed += 1;
            } catch {
              // ignore
            }
          }

          if (removed > 0) {
            logger.info(`Nachträgliches Archive-Cleanup für ${pkg.name}: ${removed} Datei(en) gelöscht`);
            if (!await this.directoryHasAnyFiles(pkg.outputDir)) {
              const removedDirs = await this.removeEmptyDirectoryTree(pkg.outputDir);
              if (removedDirs > 0) {
                logger.info(`Nachträgliches Cleanup entfernte leere Download-Ordner für ${pkg.name}: ${removedDirs}`);
              }
            }
          } else {
            logger.info(`Nachträgliches Archive-Cleanup für ${pkg.name}: keine Dateien entfernt`);
          }
        }
      })
      .catch((error) => {
        logger.warn(`Nachträgliches Archive-Cleanup fehlgeschlagen: ${compactErrorText(error)}`);
      });
  }

  private async directoryHasAnyFiles(rootDir: string): Promise<boolean> {
    if (!rootDir) {
      return false;
    }
    try {
      await fs.promises.access(rootDir);
    } catch {
      return false;
    }
    const deadline = nowMs() + 55;
    let inspectedDirs = 0;
    const stack = [rootDir];
    while (stack.length > 0) {
      inspectedDirs += 1;
      if (inspectedDirs > 6000 || nowMs() > deadline) {
        return true;
      }
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isFile() && !isIgnorableEmptyDirFileName(entry.name)) {
          return true;
        }
        if (entry.isDirectory()) {
          stack.push(path.join(current, entry.name));
        }
      }
    }
    return false;
  }

  private async removeEmptyDirectoryTree(rootDir: string): Promise<number> {
    if (!rootDir) {
      return 0;
    }
    try {
      await fs.promises.access(rootDir);
    } catch {
      return 0;
    }

    const dirs = [rootDir];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const full = path.join(current, entry.name);
          dirs.push(full);
          stack.push(full);
        }
      }
    }

    dirs.sort((a, b) => b.length - a.length);
    let removed = 0;
    for (const dirPath of dirs) {
      try {
        let entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !isIgnorableEmptyDirFileName(entry.name)) {
            continue;
          }
          try {
            await fs.promises.rm(path.join(dirPath, entry.name), { force: true });
          } catch {
            // ignore and keep directory untouched
          }
        }

        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        if (entries.length === 0) {
          await fs.promises.rmdir(dirPath);
          removed += 1;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  }

  private async collectFilesByExtensions(rootDir: string, extensions: Set<string>): Promise<string[]> {
    if (!rootDir || extensions.size === 0) {
      return [];
    }
    try {
      await fs.promises.access(rootDir);
    } catch {
      return [];
    }

    const normalizedExtensions = new Set<string>();
    for (const extension of extensions) {
      const normalized = String(extension || "").trim().toLowerCase();
      if (normalized) {
        normalizedExtensions.add(normalized);
      }
    }
    if (normalizedExtensions.size === 0) {
      return [];
    }

    const files: string[] = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        // NEVER follow symlinks / junctions / reparse points. Following them
        // can leak the scan into unrelated directories — including the shared
        // mkv library — and cause cross-package renames (the v1.7.107 bug).
        // Dirent.isDirectory() returns true for symlinks pointing to dirs,
        // so we MUST also exclude symbolic links explicitly.
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (!normalizedExtensions.has(extension)) {
          continue;
        }
        files.push(fullPath);
      }
    }

    return files;
  }

  private async collectVideoFiles(rootDir: string): Promise<string[]> {
    return await this.collectFilesByExtensions(rootDir, SAMPLE_VIDEO_EXTENSIONS);
  }

  private async existsAsync(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(toWindowsLongPathIfNeeded(filePath));
      return true;
    } catch {
      return false;
    }
  }

  /** Verify+Log fuer SYNCHRONE Rename-Sites (startup-Dedup, Suffix-Fix, Deobfuskation),
   *  die nicht ueber renamePathWithExdevFallback laufen. Nach erfolgreichem renameSync
   *  aufrufen — verifiziert das On-Disk-Ergebnis und protokolliert es ins Desktop-Log. */
  private logVerifiedRenameSync(label: string, sourcePath: string, targetPath: string, extraFields?: Record<string, unknown>): void {
    const v = verifyRename(sourcePath, targetPath);
    logDesktopRename(v.level, `${label}: ${verifyHeadline(v)}`, {
      ...(extraFields || {}),
      source: path.basename(sourcePath),
      requested: path.basename(targetPath),
      onDisk: v.onDiskName,
      targetDir: path.dirname(targetPath),
      sourceGone: v.sourceGone,
      sizeBytes: v.targetSize,
      ...(v.ok ? {} : { grund: v.reason })
    });
  }

  /** Verifizierter Wrapper um jeden Media-Rename/-Move: protokolliert den Vorgang
   *  ins Desktop-Rename-Log UND verifiziert danach, dass die Datei wirklich unter
   *  dem Zielnamen auf der Platte liegt (Quelle weg, korrekte Schreibweise). Nur weil
   *  fs.rename "ok" meldet, ist der Rename noch nicht bewiesen. Verifikations-Fehler
   *  werden NUR geloggt (kein throw) — reine Beobachtbarkeit, keine Verhaltensaenderung. */
  private async renamePathWithExdevFallback(sourcePath: string, targetPath: string, ctx?: { label?: string; fields?: Record<string, unknown> }): Promise<void> {
    const label = ctx?.label || "rename";
    try {
      await this.renamePathWithExdevFallbackRaw(sourcePath, targetPath);
    } catch (error) {
      logDesktopRename("ERROR", `${label}: Rename fehlgeschlagen`, {
        ...(ctx?.fields || {}),
        source: path.basename(sourcePath),
        sourceDir: path.dirname(sourcePath),
        target: path.basename(targetPath),
        error: compactErrorText(error)
      });
      throw error;
    }
    const v = await verifyRenameAsync(sourcePath, targetPath);
    logDesktopRename(v.level, `${label}: ${verifyHeadline(v)}`, {
      ...(ctx?.fields || {}),
      source: path.basename(sourcePath),
      requested: path.basename(targetPath),
      onDisk: v.onDiskName,
      targetDir: path.dirname(targetPath),
      sourceGone: v.sourceGone,
      sizeBytes: v.targetSize,
      ...(v.ok ? {} : { grund: v.reason })
    });
  }

  private async renamePathWithExdevFallbackRaw(sourcePath: string, targetPath: string): Promise<void> {
    const sourceFsPath = toWindowsLongPathIfNeeded(sourcePath);
    const targetFsPath = toWindowsLongPathIfNeeded(targetPath);
    // Transient lock codes — antivirus scan, Windows Search Indexer, OneDrive
    // sync, an open video player. These typically clear within a second or
    // two, so a tiny retry loop converts a hard failure into a quiet wait.
    const TRANSIENT_RENAME_ERROR_CODES = new Set(["EBUSY", "EACCES", "EPERM", "EEXIST"]);
    const RENAME_RETRY_DELAYS_MS = [200, 500, 1000];
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await fs.promises.rename(sourceFsPath, targetFsPath);
        if (attempt > 0) {
          logger.info(`Rename erfolgreich nach ${attempt} Retry(s): ${path.basename(sourcePath)}`);
        }
        return;
      } catch (error) {
        lastError = error;
        const code = error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code || "")
          : "";
        if (code === "EXDEV") {
          // Cross-volume — fall through to copy+rm fallback below.
          break;
        }
        if (TRANSIENT_RENAME_ERROR_CODES.has(code) && attempt < RENAME_RETRY_DELAYS_MS.length) {
          const delay = RENAME_RETRY_DELAYS_MS[attempt];
          logger.info(`Rename ${code} (vermutlich Antivirus/Indexer/Player), Retry in ${delay}ms: ${path.basename(sourcePath)}`);
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }

    // EXDEV (cross-volume) fallback: copy + remove source.
    const lastCode = lastError && typeof lastError === "object" && "code" in lastError
      ? String((lastError as NodeJS.ErrnoException).code || "")
      : "";
    if (lastCode !== "EXDEV") {
      throw lastError;
    }
    await fs.promises.copyFile(sourceFsPath, targetFsPath);
    await fs.promises.rm(sourceFsPath, { force: true });
  }

  /** When a video file is renamed, rename matching subtitle / metadata
   *  companions in the same folder so they keep their pairing. Without this,
   *  a media player can no longer auto-load subs after the rename because
   *  the player matches by base filename. */
  private async renameCompanionFiles(
    sourceVideoPath: string,
    targetVideoPath: string,
    pkg?: PackageEntry
  ): Promise<void> {
    const COMPANION_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".smi", ".nfo"]);
    const sourceDir = path.dirname(sourceVideoPath);
    const targetDir = path.dirname(targetVideoPath);
    const sourceVideoBase = path.basename(sourceVideoPath, path.extname(sourceVideoPath));
    const targetVideoBase = path.basename(targetVideoPath, path.extname(targetVideoPath));
    if (!sourceVideoBase || !targetVideoBase || sourceVideoBase === targetVideoBase) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      const entryName = entry.name;
      const entryExt = path.extname(entryName).toLowerCase();
      if (!COMPANION_EXTENSIONS.has(entryExt)) {
        continue;
      }
      // Match by basename prefix (handles language tags like "movie.de.srt"):
      //   "awa-show02e16hd.srt"     -> base "awa-show02e16hd"
      //   "awa-show02e16hd.de.srt"  -> base "awa-show02e16hd.de"
      // We accept any companion whose basename starts with the source video's
      // basename + "." OR equals the source basename (no language tag).
      const entryBase = path.basename(entryName, path.extname(entryName));
      const isExactMatch = entryBase === sourceVideoBase;
      const isPrefixMatch = entryBase.startsWith(`${sourceVideoBase}.`);
      if (!isExactMatch && !isPrefixMatch) {
        continue;
      }
      // Preserve any suffix after the video basename (e.g. language tag ".de").
      const suffixAfterBase = isExactMatch ? "" : entryBase.slice(sourceVideoBase.length);
      const newCompanionName = `${targetVideoBase}${suffixAfterBase}${entryExt}`;
      const sourceCompanionPath = path.join(sourceDir, entryName);
      const targetCompanionPath = path.join(targetDir, newCompanionName);
      if (sourceCompanionPath === targetCompanionPath) {
        continue;
      }
      try {
        await this.renamePathWithExdevFallback(sourceCompanionPath, targetCompanionPath, { label: "companion" });
        logger.info(`Auto-Rename Companion: ${entryName} -> ${newCompanionName}`);
        if (pkg) {
          this.logPackageForPackage(pkg, "INFO", "Auto-Rename Companion umbenannt", {
            source: sourceCompanionPath,
            target: targetCompanionPath
          });
        }
      } catch (err) {
        logger.warn(`Auto-Rename Companion fehlgeschlagen: ${entryName} -> ${newCompanionName}: ${compactErrorText(err as Error)}`);
      }
    }
  }

  /** Move matching SUBTITLE companions alongside a video collected into the
   *  library. Note: .nfo / metadata files are intentionally NOT moved — the
   *  library should contain video + subs only. .nfo stays in the extract
   *  dir and is removed by normal cleanup. */
  private async moveCompanionFiles(
    sourceVideoPath: string,
    targetVideoPath: string,
    pkg?: PackageEntry
  ): Promise<void> {
    const COMPANION_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".smi"]);
    const sourceDir = path.dirname(sourceVideoPath);
    const targetDir = path.dirname(targetVideoPath);
    const sourceVideoBase = path.basename(sourceVideoPath, path.extname(sourceVideoPath));
    const targetVideoBase = path.basename(targetVideoPath, path.extname(targetVideoPath));
    if (!sourceVideoBase || !targetVideoBase) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      const entryName = entry.name;
      const entryExt = path.extname(entryName).toLowerCase();
      if (!COMPANION_EXTENSIONS.has(entryExt)) {
        continue;
      }
      const entryBase = path.basename(entryName, path.extname(entryName));
      const isExactMatch = entryBase === sourceVideoBase;
      const isPrefixMatch = entryBase.startsWith(`${sourceVideoBase}.`);
      if (!isExactMatch && !isPrefixMatch) {
        continue;
      }
      const suffixAfterBase = isExactMatch ? "" : entryBase.slice(sourceVideoBase.length);
      const newCompanionName = `${targetVideoBase}${suffixAfterBase}${entryExt}`;
      const sourceCompanionPath = path.join(sourceDir, entryName);
      const targetCompanionPath = path.join(targetDir, newCompanionName);
      if (sourceCompanionPath === targetCompanionPath) {
        continue;
      }
      try {
        await this.moveFileWithExdevFallback(sourceCompanionPath, targetCompanionPath);
        logger.info(`MKV-Move Companion: ${entryName} -> ${newCompanionName}`);
        if (pkg) {
          this.logPackageForPackage(pkg, "INFO", "Companion mit-verschoben", {
            source: sourceCompanionPath,
            target: targetCompanionPath
          });
        }
      } catch (err) {
        logger.warn(`MKV-Move Companion fehlgeschlagen: ${entryName}: ${compactErrorText(err as Error)}`);
      }
    }
  }

  private isPathLengthRenameError(error: unknown): boolean {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : "";
    if (code === "ENAMETOOLONG") {
      return true;
    }
    const text = String(error || "").toLowerCase();
    return text.includes("path too long")
      || text.includes("name too long")
      || text.includes("filename or extension is too long");
  }

  private buildSafeAutoRenameTargetPath(sourcePath: string, targetBaseName: string, sourceExt: string): string | null {
    const dirPath = path.dirname(sourcePath);
    const safeBaseName = sanitizeFilename(String(targetBaseName || "").trim());
    if (!safeBaseName) {
      return null;
    }
    const safeExt = String(sourceExt || "").trim();

    const candidatePath = path.join(dirPath, `${safeBaseName}${safeExt}`);
    if (process.platform !== "win32") {
      return candidatePath;
    }

    const fileName = path.basename(candidatePath);
    if (fileName.length > 255) {
      return null;
    }

    // Note: total-path length is intentionally NOT checked here. We used to
    // cap it at 247 chars (v1.7.151) on the assumption that paths beyond
    // Windows MAX_PATH (260) would fail or be unusable downstream. That
    // turned out to be ACTIVELY HARMFUL: renamePathWithExdevFallback wraps
    // every rename via toWindowsLongPathIfNeeded (\\?\ prefix), and the
    // file ends up in the library dir after mkv-move where the parent path
    // is short. Imposing a 247-char cap on the EXTRACT-dir intermediate
    // path threw away perfectly-good scene-release names like
    // "Dr.House.S04E02.Der.Stoff.aus.dem.die.Heldin.ist.GERMAN.5.1.DL.AC3.720p.BDRiP.x264-TvR.mkv"
    // and replaced them with ugly "Dr.House.S04E02.mkv" via fallback.
    // We rely on the long-path prefix for the rename and on the 255-char
    // NTFS file-name limit above for the actual constraint.

    return candidatePath;
  }

  private buildShortPackageFallbackBaseName(folderCandidates: string[], sourceBaseName: string, targetBaseName: string): string | null {
    const normalizedCandidates = folderCandidates
      .map((value) => String(value || "").trim())
      .filter((value) => value.length > 0);
    const fallbackTemplate = [...normalizedCandidates].reverse().find((folderName) => {
      return hasSceneGroupSuffix(folderName) && Boolean(extractSeasonToken(folderName));
    }) || "";
    if (!fallbackTemplate) {
      return null;
    }

    const seasonMatch = fallbackTemplate.match(/^(.*?)(?:[._\-\s])s(\d{1,2})(?=[._\-\s]|$)/i);
    if (!seasonMatch?.[1] || !seasonMatch?.[2]) {
      return null;
    }

    const seasonNumber = Number(seasonMatch[2]);
    if (!Number.isFinite(seasonNumber) || seasonNumber < 0) {
      return null;
    }

    const shortRootName = String(seasonMatch[1]).replace(/[._\-\s]+$/g, "").trim();
    if (!shortRootName) {
      return null;
    }

    let fallback = `${shortRootName}.S${String(seasonNumber).padStart(2, "0")}`;
    const resolvedEpisode = resolveEpisodeTokenForAutoRename(sourceBaseName, normalizedCandidates);
    if (resolvedEpisode && new RegExp(`^S${String(seasonNumber).padStart(2, "0")}E\\d{2,3}$`, "i").test(resolvedEpisode.token)) {
      fallback = `${shortRootName}.${resolvedEpisode.token}`;
    }
    const hasRepackHint = sourceHasRpToken(sourceBaseName)
      || SCENE_REPACK_TOKEN_RE.test(sourceBaseName)
      || sourceHasRpToken(targetBaseName)
      || SCENE_REPACK_TOKEN_RE.test(targetBaseName)
      || folderCandidates.some((folderName) => sourceHasRpToken(folderName) || SCENE_REPACK_TOKEN_RE.test(folderName));
    if (hasRepackHint) {
      fallback = ensureRepackToken(removeRpTokens(fallback));
    }

    const normalized = sanitizeFilename(fallback);
    if (!normalized || normalized.toLowerCase() === String(targetBaseName || "").trim().toLowerCase()) {
      return null;
    }
    return normalized;
  }

  private buildVeryShortPackageFallbackBaseName(folderCandidates: string[], sourceBaseName: string, targetBaseName: string): string | null {
    const base = this.buildShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName);
    if (!base) {
      return null;
    }
    const match = base.match(/^(.+?)[._\-\s](S\d{2})(?:\b|[._\-\s])/i) || base.match(/^(.+?)\.(S\d{2})$/i);
    if (!match?.[1] || !match?.[2]) {
      return null;
    }
    const firstToken = match[1].split(/[._\-\s]+/).filter(Boolean)[0] || "";
    if (!firstToken) {
      return null;
    }
    const next = sanitizeFilename(`${firstToken}.${match[2].toUpperCase()}`);
    if (!next || next.toLowerCase() === String(targetBaseName || "").trim().toLowerCase()) {
      return null;
    }
    if (SCENE_REPACK_TOKEN_RE.test(base)) {
      return ensureRepackToken(next);
    }
    return next;
  }

  /** Serialize a file-mutating post-process operation per package. Both
   *  autoRename and collectMkvFilesToLibrary touch files in extractDir;
   *  running them concurrently (across the hybrid-extract and deferred-
   *  post-process pipes) corrupts state. This helper chains every call
   *  onto the previous one so at most one such op runs per package. */
  private chainPackageFileOp<T>(pkgId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.packageFileOpChain.get(pkgId);
    const result = (previous ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.packageFileOpChain.set(pkgId, result);
    return result.finally(() => {
      // Only clear the slot if no newer chained call replaced us — keeps
      // the chain intact when several callers queue up at once.
      if (this.packageFileOpChain.get(pkgId) === result) {
        this.packageFileOpChain.delete(pkgId);
      }
    });
  }

  private async autoRenameExtractedVideoFiles(
    extractDir: string,
    pkg?: PackageEntry,
    shouldAbort?: () => boolean,
    treatFilesAsStable = false
  ): Promise<number> {
    if (!pkg) {
      return this.autoRenameExtractedVideoFilesImpl(extractDir, undefined, shouldAbort, treatFilesAsStable);
    }
    return this.chainPackageFileOp(pkg.id, () =>
      this.autoRenameExtractedVideoFilesImpl(extractDir, pkg, shouldAbort, treatFilesAsStable)
    );
  }

  private async autoRenameExtractedVideoFilesImpl(
    extractDir: string,
    pkg?: PackageEntry,
    shouldAbort?: () => boolean,
    // Im finalen Deferred-Pass ist die Extraktion abgeschlossen (awaited) — es gibt
    // keinen concurrent Extractor-Write mehr. Der Frische-Gate (unten) ist dort ein
    // False Positive: er wuerde eine eben extrahierte (noch "frische") Datei vom
    // Rename ausschliessen, woraufhin der nachgelagerte Collect (deferFreshFiles=false)
    // sie mit Original-Scene-Namen in die Library moved. treatFilesAsStable=true
    // umgeht den Gate, sodass der Final-Pass garantiert ALLE Dateien umbenennt.
    treatFilesAsStable = false
  ): Promise<number> {
    if (!this.settings.autoRename4sf4sj) {
      return 0;
    }

    // SAFETY: refuse to scan if extractDir is identical to or contains
    // the shared MKV library. Otherwise the scan would treat already-
    // collected library files as "extracted videos" and rename them based
    // on whatever folder candidates happen to surface — corrupting files
    // from OTHER packages. This is the v1.7.107 bug vector and must never
    // come back. extractDir INSIDE mkvLibraryDir is also rejected: it
    // would put extracted files directly into the library tree where
    // subsequent scans would rename them out of their package context.
    const mkvLibraryDir = String(this.settings.mkvLibraryDir || "").trim();
    if (mkvLibraryDir) {
      const sameOrLibraryInside = isPathInsideDir(mkvLibraryDir, extractDir);
      const extractInsideLibrary = isPathInsideDir(extractDir, mkvLibraryDir);
      if (sameOrLibraryInside || extractInsideLibrary) {
        logger.warn(`Auto-Rename ABGEBROCHEN: extractDir=${extractDir} ueberlappt mit mkvLibraryDir=${mkvLibraryDir} — Cross-Package Korruption verhindert`);
        if (pkg) {
          this.logPackageForPackage(pkg, "ERROR", "Auto-Rename abgebrochen: extractDir ueberlappt mit MKV-Bibliothek", {
            extractDir,
            mkvLibraryDir
          });
        }
        return 0;
      }
    }

    const videoFiles = await this.collectVideoFiles(extractDir);
    logger.info(`Auto-Rename: ${videoFiles.length} Video-Dateien gefunden in ${extractDir}`);
    if (pkg) {
      this.logPackageForPackage(pkg, "INFO", "Auto-Rename Scan gestartet", {
        extractDir,
        videoFiles: videoFiles.length
      });
      this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename Scan gestartet", {
        extractDir,
        videoFiles: videoFiles.length
      });
    }
    let renamed = 0;

    // Collect additional folder candidates from package metadata (outputDir only).
    // Item filenames are intentionally excluded: they contain episode tokens from
    // OTHER files in the package, which pollute resolveEpisodeTokenForAutoRename
    // and cause all files to receive the same wrong episode number.
    const packageExtraCandidates: string[] = [];
    if (pkg) {
      const outputBase = path.basename(pkg.outputDir || "");
      if (outputBase) {
        packageExtraCandidates.push(outputBase);
      }
    }

    const sampleTokenRe = /(^|[._\-\s])sample([._\-\s]|$)/i;
    const sampleDirNames = new Set(["sample", "samples"]);
    // Short suffix pattern: scene groups often use "-s.mkv" for samples (e.g. itn-continuum.s01e10.720p-s.mkv)
    const sampleSuffixRe = /[._\-]s$/i;
    // Files that were still being written to by the extractor in the last
    // few seconds must not be renamed — hybrid-extract produces MKVs
    // progressively and a concurrent rename scan can catch a file mid-write.
    // We skip such "fresh" files and let the next scan pick them up once
    // they've stabilized (hybrid-extract fires a new rename scan after every
    // archive completes, so nothing gets missed).
    const FILE_STABILIZE_MIN_AGE_MS = this.fileStabilizeMinAgeMs;
    for (const sourcePath of videoFiles) {
      if (shouldAbort?.()) {
        return renamed;
      }
      const sourceName = path.basename(sourcePath);
      const sourceExt = path.extname(sourceName);
      const sourceBaseName = path.basename(sourceName, sourceExt);
      const parentDirName = path.basename(path.dirname(sourcePath)).toLowerCase();

      // Skip files that are still being written. stat() may fail if the file
      // disappeared (another pipe's mkvMove) — treat as "skip this scan".
      let sourceStat: fs.Stats | null = null;
      try {
        sourceStat = await fs.promises.stat(sourcePath);
      } catch {
        continue;
      }
      // now PER FILE erfassen (nicht einmal am Scan-Start): bei Hybrid-Extraktion
      // werden weitere Dateien WÄHREND dieses Scans geschrieben. Ein am Scan-Start
      // erfasstes now waere fuer solche Dateien aelter als ihre mtime → negatives
      // ageMs → der Clock-Skew-Zweig unten wuerde sie faelschlich als "stabil"
      // werten und einen Rename mitten im Extractor-Write ausloesen (EBUSY →
      // deferred → der Collect moved die Datei mit Original-Namen, statt umbenannt).
      const now = Date.now();
      const ageMs = now - sourceStat.mtimeMs;
      // Negative age = mtime in the future (clock skew, NTP correction,
      // VM resume after suspension). Treat as "definitely stable" so the
      // file doesn't get stuck waiting for the wall clock to catch up.
      if (!treatFilesAsStable && ageMs >= 0 && ageMs < FILE_STABILIZE_MIN_AGE_MS) {
        logger.info(`Auto-Rename: ${sourceName} uebersprungen — Datei noch frisch (${Math.floor(ageMs)}ms), wird beim naechsten Scan behandelt`);
        continue;
      }

      // Skip sample files — renaming them strips the "-sample" suffix,
      // making them indistinguishable from the main MKV and causing (2)
      // duplicates during MKV collection.
      // BUT: a series with "Sample" in the title (e.g. "Sample.Squad.S01E01")
      // would match sampleTokenRe as a false positive. Real samples are
      // small (typically <150 MB); the actual episode is always larger.
      // Use the file size as a sanity check — only treat as sample if the
      // file is small. Folder-based detection (sampleDirNames) doesn't need
      // the size guard because sample subfolders are unambiguous.
      const SAMPLE_MAX_BYTES = 150 * 1024 * 1024;
      const looksLikeSampleByName = sampleTokenRe.test(sourceBaseName) || sampleSuffixRe.test(sourceBaseName);
      const insideSampleDir = sampleDirNames.has(parentDirName);
      if (insideSampleDir) {
        continue;
      }
      if (looksLikeSampleByName) {
        if (sourceStat.size <= SAMPLE_MAX_BYTES) {
          continue;
        }
        // Large file with "sample" in the name — series-title false positive.
        logger.info(`Auto-Rename: ${sourceName} matcht Sample-Pattern, aber Groesse ${Math.round(sourceStat.size / (1024 * 1024))} MB > Schwelle — wird als echter Inhalt behandelt`);
      }
      // Skip bonus/extras content (Featurettes, Making-Of, Behind-The-Scenes, etc.)
      // These have generic descriptive names and would get renamed to misleading
      // episode names if matched against the package's SxxExx pattern.
      if (isInsideBonusDir(sourcePath, extractDir) || BONUS_FILENAME_RE.test(sourceBaseName)) {
        continue;
      }
      const folderCandidates: string[] = [];
      let currentDir = path.dirname(sourcePath);
      while (currentDir && isPathInsideDir(currentDir, extractDir)) {
        folderCandidates.push(path.basename(currentDir));
        const parent = path.dirname(currentDir);
        if (!parent || parent === currentDir) {
          break;
        }
        currentDir = parent;
      }
      // Append package-level candidates that aren't already present
      const seen = new Set(folderCandidates.map(c => c.toLowerCase()));
      for (const extra of packageExtraCandidates) {
        if (!seen.has(extra.toLowerCase())) {
          seen.add(extra.toLowerCase());
          folderCandidates.push(extra);
        }
      }
      let targetBaseName = buildAutoRenameBaseNameFromFoldersWithOptions(folderCandidates, sourceBaseName, {
        forceEpisodeForSeasonFolder: true
      });
      // Defense against degenerate folder layouts: when the immediate parent
      // folder lacks a real series name (e.g. "S01 Complete", "Season 1",
      // "Staffel 02"), buildAutoRenameBaseName can collapse a perfect source
      // filename like "Desperate.Housewives.S01E01.German.Synced.DL.720p.WEB-
      // DL.AC3.h264" into garbage like "S01E01 Complete". If the source is
      // already well-formed (has SxxExx + a meaningful series-name prefix)
      // and the computed target is much shorter / lacks that prefix, keep
      // the source as-is — renaming would actively destroy information.
      if (targetBaseName && sourceBaseName.length > 0) {
        const sourceHasEpisode = Boolean(extractEpisodeToken(sourceBaseName));
        const targetHasEpisode = Boolean(extractEpisodeToken(targetBaseName));
        const sourceHasSeriesPrefix = hasMeaningfulSeriesPrefix(sourceBaseName);
        const targetHasSeriesPrefix = hasMeaningfulSeriesPrefix(targetBaseName);
        const targetIsMuchShorter = targetBaseName.length * 2 < sourceBaseName.length;
        if (sourceHasEpisode
          && targetHasEpisode
          && sourceHasSeriesPrefix
          && !targetHasSeriesPrefix
          && targetIsMuchShorter) {
          logger.info(`Auto-Rename uebersprungen: Source "${sourceBaseName}" ist bereits aussagekraeftiger als computed Target "${targetBaseName}"`);
          if (pkg) {
            const resolved = resolveRenameItem();
            this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename uebersprungen: Source schon besser als computed Target", {
              sourcePath,
              sourceName,
              sourceBaseName,
              targetBaseName,
              folders: folderCandidates.join(", ")
            }, resolved.item, resolved.matchedBy);
          }
          continue;
        }
      }
      const resolveRenameItem = (...extra: Array<string | null | undefined>): { item: DownloadItem | null; matchedBy: string | null } => {
        if (!pkg) {
          return { item: null, matchedBy: null };
        }
        return this.inferItemForMediaLog(pkg, sourcePath, sourceName, folderCandidates.join(" "), targetBaseName || "", ...extra);
      };
      // SAFETY NET: Never strip a valid SxxExx token from the source filename.
      // If the source already has an episode token but the computed target lost it
      // (e.g. malformed package name "S01GERMAN" with no separator), preserve the
      // episode by either inserting it into the target or skipping the rename entirely.
      // Without this guard, all episodes from a malformed pack collapse to one name
      // and collide with (2)(3)(4) suffixes in the MKV library.
      const sourceEpisodeToken = extractEpisodeToken(sourceBaseName);
      if (targetBaseName && sourceEpisodeToken) {
        const targetEpisodeToken = extractEpisodeToken(targetBaseName);
        if (!targetEpisodeToken) {
          // Try to insert the source's episode token: replace "Sxx<garbage>" with "SxxExx.<garbage>"
          const insertedEpisode = targetBaseName.replace(
            /(^|[._\-\s])(s\d{1,2})(?=[A-Za-z0-9])/i,
            `$1${sourceEpisodeToken}.`
          );
          if (insertedEpisode !== targetBaseName && extractEpisodeToken(insertedEpisode)) {
            logger.info(`Auto-Rename Safety: Episode-Token in Target eingefuegt: ${targetBaseName} -> ${insertedEpisode}`);
            targetBaseName = insertedEpisode;
          } else {
            const repaired = applyEpisodeTokenToFolderName(targetBaseName, sourceEpisodeToken);
            if (repaired && extractEpisodeToken(repaired)) {
              logger.info(`Auto-Rename Safety: Episode-Token via applyToken: ${targetBaseName} -> ${repaired}`);
              targetBaseName = repaired;
            } else {
              logger.warn(`Auto-Rename Safety: Skipping rename - target wuerde Episode-Token verlieren (source=${sourceBaseName}, target=${targetBaseName})`);
              if (pkg) {
                const resolved = resolveRenameItem();
                this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename uebersprungen: Episode-Token wuerde verloren gehen", {
                  sourcePath,
                  sourceName,
                  sourceEpisodeToken,
                  targetBaseName
                }, resolved.item, resolved.matchedBy);
              }
              continue;
            }
          }
        } else if (targetEpisodeToken !== sourceEpisodeToken) {
          // Target has a DIFFERENT episode token than source. Normally that's a
          // sign the rename would mislabel the episode — BUT scene releases
          // often place obfuscated MKVs (e.g. "awa-diethundermans02e16hd.mkv"
          // = scrambled E16) inside an explicitly named episode folder
          // (e.g. "Die.Thundermans.S02E01.Der.Thunder.Van.GERMAN.x264-aWake").
          // The folder is created by the release group with the REAL episode
          // info; the file name is anti-piracy obfuscation. So when the
          // immediate parent folder carries the same explicit SxxExx token as
          // our computed targetBaseName, trust the folder and override the
          // misleading source token.
          const parentFolderName = path.basename(path.dirname(sourcePath));
          const parentEpisodeToken = extractEpisodeToken(parentFolderName);
          // GUARD: only let the folder override the source token when the
          // source filename actually LOOKS obfuscated (no scene markers like
          // 720p / german / x264 / bluray, no dot-separated structure).
          // A clean scene release filename — e.g. "the.royals.2015.s01e09.
          // german.dl.720p.bluray.x264-j4f.mkv" — must NEVER be overridden,
          // because a one-off folder/file mismatch with a clean source means
          // the FOLDER is wrong, not the file. Renaming a real S01E09 to
          // S01E08 because the folder happens to say E08 would corrupt data.
          const sourceLooksObfuscated = looksLikeObfuscatedSceneFileName(sourceName);
          const folderIsAuthoritative = Boolean(
            parentEpisodeToken
            && parentEpisodeToken === targetEpisodeToken
            && parentFolderName.toLowerCase() !== path.basename(extractDir).toLowerCase()
            && sourceLooksObfuscated
          );
          if (folderIsAuthoritative) {
            logger.info(`Auto-Rename: source-Token ${sourceEpisodeToken} ignoriert, Folder-Token ${targetEpisodeToken} ist authoritativ (vermutlich obfuskierter Dateiname in ${parentFolderName})`);
            if (pkg) {
              const resolved = resolveRenameItem();
              this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename: Folder-Token uebersteuert obfuskierten Datei-Token", {
                sourcePath,
                sourceName,
                sourceEpisodeToken,
                targetEpisodeToken,
                parentFolder: parentFolderName,
                targetBaseName
              }, resolved.item, resolved.matchedBy);
            }
            // Fall through to the normal rename path with targetBaseName.
          } else {
            logger.warn(`Auto-Rename Safety: Skipping rename - Episode-Token Mismatch (source=${sourceEpisodeToken}, target=${targetEpisodeToken})`);
            if (pkg) {
              const resolved = resolveRenameItem();
              this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename uebersprungen: Episode-Token Mismatch", {
                sourcePath,
                sourceName,
                sourceEpisodeToken,
                targetEpisodeToken,
                targetBaseName
              }, resolved.item, resolved.matchedBy);
            }
            continue;
          }
        }
      }
      if (!targetBaseName) {
        if (pkg) {
          this.logPackageForPackage(pkg, "WARN", "Auto-Rename übersprungen: kein Zielname", {
            sourceName,
            sourceBaseName,
            folders: folderCandidates.join(", ")
          });
          const resolved = resolveRenameItem();
          this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename übersprungen: kein Zielname", {
            sourcePath,
            sourceName,
            sourceBaseName,
            folders: folderCandidates.join(", ")
          }, resolved.item, resolved.matchedBy);
        }
        logger.info(`Auto-Rename: kein Zielname für ${sourceName} (folders=${folderCandidates.join(", ")})`);
        continue;
      }

      let targetPath = this.buildSafeAutoRenameTargetPath(sourcePath, targetBaseName, sourceExt);
      if (!targetPath) {
        const fallbackBaseName = this.buildShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName);
        if (fallbackBaseName) {
          targetPath = this.buildSafeAutoRenameTargetPath(sourcePath, fallbackBaseName, sourceExt);
          if (targetPath) {
            logger.warn(`Auto-Rename Fallback wegen Pfadlänge: ${sourceName} -> ${path.basename(targetPath)}`);
            if (pkg) {
              const resolved = resolveRenameItem(targetPath, fallbackBaseName);
              this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename Fallback wegen Pfadlänge gewählt", {
                sourcePath,
                sourceName,
                targetPath,
                targetBaseName,
                fallbackBaseName
              }, resolved.item, resolved.matchedBy);
            }
          }
        }
        if (!targetPath) {
          const veryShortFallback = this.buildVeryShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName);
          if (veryShortFallback) {
            targetPath = this.buildSafeAutoRenameTargetPath(sourcePath, veryShortFallback, sourceExt);
            if (targetPath) {
              logger.warn(`Auto-Rename Kurz-Fallback wegen Pfadlänge: ${sourceName} -> ${path.basename(targetPath)}`);
              if (pkg) {
                const resolved = resolveRenameItem(targetPath, veryShortFallback);
                this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename Kurz-Fallback wegen Pfadlänge gewählt", {
                  sourcePath,
                  sourceName,
                  targetPath,
                  targetBaseName,
                  fallbackBaseName: veryShortFallback
                }, resolved.item, resolved.matchedBy);
              }
            }
          }
        }
      }
      if (!targetPath) {
        if (pkg) {
          this.logPackageForPackage(pkg, "WARN", "Auto-Rename übersprungen: Zielpfad ungültig", {
            sourceName,
            sourceBaseName,
            targetBaseName
          });
          const resolved = resolveRenameItem();
          this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename übersprungen: Zielpfad ungültig", {
            sourcePath,
            sourceName,
            sourceBaseName,
            targetBaseName
          }, resolved.item, resolved.matchedBy);
        }
        logger.warn(`Auto-Rename übersprungen (Zielpfad zu lang/ungültig): ${sourcePath}`);
        continue;
      }
      if (targetPath === sourcePath) {
        // Exact match (including casing) — truly nothing to do.
        if (pkg) {
          const resolved = resolveRenameItem(targetPath);
          this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename übersprungen: Name bereits passend", {
            sourcePath,
            sourceName,
            targetPath,
            targetBaseName
          }, resolved.item, resolved.matchedBy);
        }
        continue;
      }
      if (pathKey(targetPath) === pathKey(sourcePath) && targetPath !== sourcePath) {
        // Same file on case-insensitive FS but different casing — rename in-place.
        // Route through renamePathWithExdevFallback so we get the long-path /
        // UNC handling AND the transient-error retry for free.
        try {
          await this.renamePathWithExdevFallback(sourcePath, targetPath, { label: "auto-rename (Schreibweise)" });
          renamedCount += 1;
          if (pkg) {
            const resolved = resolveRenameItem(targetPath);
            this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename (Casing korrigiert)", {
              sourcePath,
              sourceName,
              targetPath,
              targetBaseName
            }, resolved.item, resolved.matchedBy);
          }
          logger.info(`Auto-Rename Casing: ${sourcePath} -> ${targetPath}`);
        } catch (err) {
          logger.warn(`Auto-Rename Casing fehlgeschlagen: ${sourcePath} -> ${targetPath}: ${compactErrorText(err as Error)}`);
        }
        continue;
      }
      if (await this.existsAsync(targetPath)) {
        // A previous successful rename (this scan or an earlier one) already
        // produced the target. Try numbered variants: "<base>.2.mkv",
        // "<base>.3.mkv", ... — caps at 99 to bound the loop. This handles
        // legit multi-MKV-per-folder cases (alternate audio, A/B parts in the
        // same folder) without dropping the second file silently.
        const targetDir = path.dirname(targetPath);
        const targetExt = path.extname(targetPath);
        const targetBase = path.basename(targetPath, targetExt);
        let resolvedTarget: string | null = null;
        for (let suffixN = 2; suffixN <= 99; suffixN += 1) {
          const candidate = path.join(targetDir, `${targetBase}.${suffixN}${targetExt}`);
          // Defensive: never pick the source file as our resolved target.
          // If sourceName is already e.g. "<base>.2.mkv", existsAsync would
          // see it as "existing" and the loop would otherwise pick "<base>.3"
          // — but if pathKey matches (case-insensitive), bail to next idx
          // so we don't accidentally rename source-onto-itself with a
          // surprising suffix.
          if (pathKey(candidate) === pathKey(sourcePath)) {
            continue;
          }
          if (!(await this.existsAsync(candidate))) {
            resolvedTarget = candidate;
            break;
          }
        }
        if (!resolvedTarget) {
          if (pkg) {
            this.logPackageForPackage(pkg, "WARN", "Auto-Rename übersprungen: Ziel existiert (>99 Varianten belegt)", {
              sourceName,
              targetPath
            });
            const resolved = resolveRenameItem(targetPath);
            this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename übersprungen: Ziel existiert", {
              sourcePath,
              sourceName,
              targetPath,
              targetBaseName
            }, resolved.item, resolved.matchedBy);
          }
          logger.warn(`Auto-Rename übersprungen (Ziel existiert, >99 Varianten belegt): ${targetPath}`);
          continue;
        }
        if (pkg) {
          this.logPackageForPackage(pkg, "INFO", "Auto-Rename mit Suffix (Ziel existierte)", {
            sourceName,
            originalTarget: targetPath,
            resolvedTarget
          });
        }
        logger.info(`Auto-Rename mit Suffix: Ziel ${path.basename(targetPath)} existierte → benutze ${path.basename(resolvedTarget)}`);
        targetPath = resolvedTarget;
      }

      try {
        await this.renamePathWithExdevFallback(sourcePath, targetPath, { label: "auto-rename" });
        if (pkg) {
          this.logPackageForPackage(pkg, "INFO", "Auto-Rename durchgeführt", {
            sourcePath,
            targetPath,
            sourceName
          });
          const resolved = resolveRenameItem(targetPath);
          this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename durchgeführt", {
            sourcePath,
            targetPath,
            sourceName,
            targetBaseName,
            folders: folderCandidates.join(", ")
          }, resolved.item, resolved.matchedBy);
        }
        logger.info(`Auto-Rename: ${sourceName} -> ${path.basename(targetPath)}`);
        renamed += 1;
        // Rename matching companion files (subtitles, .nfo, .idx/.sub) so they
        // stay paired with the renamed video for media-player auto-loading.
        await this.renameCompanionFiles(sourcePath, targetPath, pkg);
      } catch (error) {
        if (this.isPathLengthRenameError(error)) {
          const fallbackCandidates = [
            this.buildShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName),
            this.buildVeryShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName)
          ].filter((value): value is string => Boolean(value));
          let fallbackRenamed = false;
          for (const fallbackBaseName of fallbackCandidates) {
            const fallbackPath = this.buildSafeAutoRenameTargetPath(sourcePath, fallbackBaseName, sourceExt);
            if (!fallbackPath || pathKey(fallbackPath) === pathKey(sourcePath)) {
              continue;
            }
            if (await this.existsAsync(fallbackPath)) {
              continue;
            }
            try {
              await this.renamePathWithExdevFallback(sourcePath, fallbackPath, { label: "auto-rename (Pfadlaenge-Fallback)" });
              logger.warn(`Auto-Rename Fallback wegen Pfadlänge: ${sourceName} -> ${path.basename(fallbackPath)}`);
              renamed += 1;
              if (pkg) {
                const resolved = resolveRenameItem(fallbackPath, fallbackBaseName);
                this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename Fallback durchgeführt", {
                  sourcePath,
                  sourceName,
                  targetPath: fallbackPath,
                  targetBaseName,
                  fallbackBaseName
                }, resolved.item, resolved.matchedBy);
              }
              fallbackRenamed = true;
              break;
            } catch {
              // try next fallback candidate
            }
          }
          if (fallbackRenamed) {
            continue;
          }
        }
        logger.warn(`Auto-Rename fehlgeschlagen (${sourceName}): ${compactErrorText(error)}`);
        if (pkg) {
          this.logPackageForPackage(pkg, "WARN", "Auto-Rename fehlgeschlagen", {
            sourceName,
            error: compactErrorText(error)
          });
          const resolved = resolveRenameItem(targetPath);
          this.logRenameProcess(pkg, "WARN", "auto-rename", "Auto-Rename fehlgeschlagen", {
            sourcePath,
            sourceName,
            targetPath,
            targetBaseName,
            folders: folderCandidates.join(", "),
            error: compactErrorText(error)
          }, resolved.item, resolved.matchedBy);
        }
      }
    }

    if (renamed > 0) {
      logger.info(`Auto-Rename (Scene): ${renamed} Datei(en) umbenannt`);
      if (pkg) {
        this.logPackageForPackage(pkg, "INFO", "Auto-Rename abgeschlossen", {
          renamed
        });
        this.logRenameProcess(pkg, "INFO", "auto-rename", "Auto-Rename abgeschlossen", {
          extractDir,
          renamed
        });
      }
    }
    return renamed;
  }

  private async moveFileWithExdevFallback(sourcePath: string, targetPath: string): Promise<void> {
    await this.renamePathWithExdevFallback(sourcePath, targetPath, { label: "mkv-move" });
  }

  private async cleanupNonMkvResidualFiles(rootDir: string, targetDir: string): Promise<number> {
    if (!rootDir || !await this.existsAsync(rootDir)) {
      return 0;
    }

    let removed = 0;
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (isPathInsideDir(fullPath, targetDir)) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (SAMPLE_VIDEO_EXTENSIONS.has(extension)) {
          continue;
        }
        try {
          await fs.promises.rm(toWindowsLongPathIfNeeded(fullPath), { force: true });
          removed += 1;
        } catch {
          // ignore and keep file
        }
      }
    }

    return removed;
  }

  private async cleanupRemainingArchiveArtifacts(packageDir: string, shouldAbort?: () => boolean): Promise<number> {
    if (this.settings.cleanupMode === "none") {
      return 0;
    }
    if (shouldAbort?.()) {
      return 0;
    }
    const candidates = await findArchiveCandidates(packageDir);
    if (candidates.length === 0) {
      return 0;
    }

    let removed = 0;
    const dirFilesCache = new Map<string, string[]>();
    const targets = new Set<string>();
    for (const sourceFile of candidates) {
      if (shouldAbort?.()) {
        return removed;
      }
      const dir = path.dirname(sourceFile);
      let filesInDir = dirFilesCache.get(dir);
      if (!filesInDir) {
        try {
          filesInDir = (await fs.promises.readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name);
        } catch {
          filesInDir = [];
        }
        dirFilesCache.set(dir, filesInDir);
      }
      for (const target of collectArchiveCleanupTargets(sourceFile, filesInDir)) {
        targets.add(target);
      }
    }

    for (const targetPath of targets) {
      if (shouldAbort?.()) {
        return removed;
      }
      try {
        if (!await this.existsAsync(targetPath)) {
          continue;
        }
        if (this.settings.cleanupMode === "trash") {
          const parsed = path.parse(targetPath);
          const trashDir = path.join(parsed.dir, ".rd-trash");
          await fs.promises.mkdir(trashDir, { recursive: true });
          let moved = false;
          for (let index = 0; index <= 1000; index += 1) {
            const suffix = index === 0 ? "" : `-${index}`;
            const candidate = path.join(trashDir, `${parsed.base}.${Date.now()}${suffix}`);
            if (await this.existsAsync(candidate)) {
              continue;
            }
            await this.renamePathWithExdevFallback(targetPath, candidate, { label: "mkv-move (Konflikt-Aufloesung)" });
            moved = true;
            break;
          }
          if (moved) {
            removed += 1;
          }
          continue;
        }
        await fs.promises.rm(toWindowsLongPathIfNeeded(targetPath), { force: true });
        removed += 1;
      } catch {
        // ignore
      }
    }

    return removed;
  }

  private hasDeferredPostProcessPending(packageId: string): boolean {
    const controller = this.packageDeferredPostProcessAbortControllers.get(packageId);
    if (controller && !controller.signal.aborted) {
      return true;
    }
    const hybridSet = this.packageHybridPostProcessControllers.get(packageId);
    if (hybridSet) {
      for (const c of hybridSet) {
        if (!c.signal.aborted) {
          return true;
        }
      }
    }
    return false;
  }

  /** M1: True wenn IRGENDWO noch Deferred- oder Hybrid-Post-Processing läuft.
   *  Verhindert dass der Scheduler/finishRun den Run als beendet meldet und
   *  State zurücksetzt, während im Hintergrund noch Dateien verschoben werden. */
  private hasAnyDeferredPostProcessPending(): boolean {
    for (const controller of this.packageDeferredPostProcessAbortControllers.values()) {
      if (!controller.signal.aborted) {
        return true;
      }
    }
    for (const hybridSet of this.packageHybridPostProcessControllers.values()) {
      for (const c of hybridSet) {
        if (!c.signal.aborted) {
          return true;
        }
      }
    }
    return false;
  }

  private async buildUniqueFlattenTargetPath(targetDir: string, sourcePath: string, reserved: Set<string>): Promise<string> {
    const parsed = path.parse(path.basename(sourcePath));
    const extension = parsed.ext || ".mkv";
    const baseName = sanitizeFilename(parsed.name || "video");

    let index = 1;
    const MAX_ATTEMPTS = 10000;
    while (index <= MAX_ATTEMPTS) {
      const candidateName = index <= 1
        ? `${baseName}${extension}`
        : `${baseName} (${index})${extension}`;
      const candidatePath = path.join(targetDir, candidateName);
      const candidateKey = pathKey(candidatePath);
      if (reserved.has(candidateKey)) {
        index += 1;
        continue;
      }
      if (!await this.existsAsync(candidatePath)) {
        reserved.add(candidateKey);
        return candidatePath;
      }
      index += 1;
    }
    // Fallback: use timestamp-based name to guarantee termination
    const fallbackName = `${baseName} (${Date.now()})${extension}`;
    const fallbackPath = path.join(targetDir, fallbackName);
    reserved.add(pathKey(fallbackPath));
    return fallbackPath;
  }

  private async collectMkvFilesToLibrary(
    packageId: string,
    pkg: PackageEntry,
    shouldAbort?: () => boolean,
    deferFreshFiles = false
  ): Promise<void> {
    if (!this.settings.collectMkvToLibrary) {
      return;
    }

    // SOURCE DIRECTORIES:
    // - Wenn autoExtract aktiv: extractDir ist primäre Quelle (entpackte Videos).
    // - IMMER zusätzlich outputDir: Provider wie Mega-Debrid liefern direkte
    //   .mkv (kein Archiv), die sonst im outputDir liegen bleiben und nie in
    //   der Library landen würden.
    const sourceDirCandidates: string[] = [];
    if (this.settings.autoExtract && pkg.extractDir) {
      sourceDirCandidates.push(pkg.extractDir);
    }
    if (pkg.outputDir) {
      sourceDirCandidates.push(pkg.outputDir);
    }
    // Dedupe nach resolved Pfad (extractDir kann == outputDir sein).
    const sourceDirSeen = new Set<string>();
    const sourceDirsAll: string[] = [];
    for (const dir of sourceDirCandidates) {
      const resolved = path.resolve(dir).toLowerCase();
      if (sourceDirSeen.has(resolved)) continue;
      sourceDirSeen.add(resolved);
      sourceDirsAll.push(dir);
    }

    const targetDirRaw = String(this.settings.mkvLibraryDir || "").trim();
    if (sourceDirsAll.length === 0 || !targetDirRaw) {
      logger.warn(`MKV-Sammelordner übersprungen: pkg=${pkg.name}, ungültiger Pfad`);
      return;
    }
    const targetDir = path.resolve(targetDirRaw);

    // SAFETY: never move files WITHIN the library tree, and never treat the
    // library itself as a source. sourceDir == targetDir would scan the
    // library, match files collected from OTHER packages via the same rename
    // heuristics, and move them around — a cross-package corruption vector.
    // Pro Source-Dir prüfen — einer kann safe sein, der andere nicht.
    const sourceDirs: string[] = [];
    for (const dir of sourceDirsAll) {
      if (isPathInsideDir(dir, targetDir) || isPathInsideDir(targetDir, dir)) {
        logger.warn(`MKV-Sammelordner: Source uebersprungen (ueberlappt mit mkvLibraryDir): pkg=${pkg.name}, dir=${dir}, target=${targetDir}`);
        this.logPackageForPackage(pkg, "WARN", "MKV-Sammelordner: Source uebersprungen (ueberlappt mit MKV-Bibliothek)", {
          sourceDir: dir,
          targetDir
        });
        continue;
      }
      if (!await this.existsAsync(dir)) {
        continue;
      }
      sourceDirs.push(dir);
    }
    if (sourceDirs.length === 0) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, keine nutzbare Quelle (alle Source-Dirs fehlen oder ueberlappen mit Library)`);
      return;
    }

    // CLEANUP-DIR: NUR dieser Ordner darf nach dem Move destruktiv aufgeraeumt
    // werden (Restdateien loeschen + leere Ordner entfernen).
    // - autoExtract=true  -> extractDir (entpackter Inhalt, fertig verarbeitet)
    // - autoExtract=false -> outputDir (kein Extract, das ist der finale Inhalt)
    //
    // WICHTIG: Bei autoExtract=true wird der outputDir NICHT hier aufgeraeumt!
    // Dort liegen die RAR-Archive, die von der separaten Archive-Cleanup-Pipeline
    // (mit Extraktions-Guards) verwaltet werden. Ein blindes Loeschen aller
    // Nicht-Video-Dateien im outputDir wuerde noch nicht entpackte Archive-Sets
    // anderer Staffeln/Items zerstoeren (Regression v1.7.154, gefixt v1.7.156).
    const cleanupDirCandidate = this.settings.autoExtract ? pkg.extractDir : pkg.outputDir;
    const cleanupDir = (cleanupDirCandidate && sourceDirs.some(
      (d) => path.resolve(d).toLowerCase() === path.resolve(cleanupDirCandidate).toLowerCase()
    )) ? cleanupDirCandidate : null;

    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
    } catch (error) {
      logger.warn(`MKV-Sammelordner konnte nicht erstellt werden: pkg=${pkg.name}, dir=${targetDir}, reason=${compactErrorText(error)}`);
      return;
    }

    // Sammle aus ALLEN safe source dirs. Dedupe nach basename (lowercase) —
    // extractDir wird zuerst gescannt und gewinnt bei Kollision (entpackte
    // Datei hat Vorrang vor evtl. noch liegengebliebenem Quell-File).
    const seenBasenames = new Set<string>();
    const collected: { filePath: string; sourceRoot: string }[] = [];
    for (const dir of sourceDirs) {
      const filesInDir = await this.collectFilesByExtensions(dir, SAMPLE_VIDEO_EXTENSIONS);
      for (const filePath of filesInDir) {
        const baseLower = path.basename(filePath).toLowerCase();
        if (seenBasenames.has(baseLower)) continue;
        seenBasenames.add(baseLower);
        collected.push({ filePath, sourceRoot: dir });
      }
    }
    if (collected.length === 0) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, keine MKV gefunden`);
      return;
    }

    // Filter: Sample- und Bonus-Dateien ausschließen
    // - Sample-Ordner / "sample" im Dateinamen
    // - Bonus-Subordner (Extras, Bonus, Featurettes, etc.)
    // - Bonus-Dateinamen (Making-Of, Deleted-Scene, etc.)
    const sampleDirNames = new Set(["sample", "samples"]);
    const sampleTokenRe = /(^|[._\-\s])sample([._\-\s]|$)/i;
    const mkvFiles: string[] = [];
    let sampleSkipped = 0;
    let bonusSkipped = 0;
    for (const { filePath, sourceRoot } of collected) {
      if (shouldAbort?.()) {
        return;
      }
      const parentDir = path.basename(path.dirname(filePath)).toLowerCase();
      const stem = path.parse(path.basename(filePath)).name;
      if (sampleDirNames.has(parentDir) || sampleTokenRe.test(stem)) {
        sampleSkipped += 1;
        continue;
      }
      if (isInsideBonusDir(filePath, sourceRoot) || BONUS_FILENAME_RE.test(stem)) {
        bonusSkipped += 1;
        logger.info(`MKV-Sammelordner: Bonus-Datei uebersprungen: ${path.basename(filePath)} (Pfad: ${path.relative(sourceRoot, filePath)})`);
        continue;
      }
      mkvFiles.push(filePath);
    }
    if (sampleSkipped > 0) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, ${sampleSkipped} Sample-MKV(s) übersprungen`);
    }
    if (bonusSkipped > 0) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, ${bonusSkipped} Bonus-MKV(s) übersprungen (Extras/Featurettes/etc.)`);
    }
    if (mkvFiles.length === 0) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, keine MKV nach Sample/Bonus-Filter`);
      return;
    }

    this.logRenameProcess(pkg, "INFO", "mkv-move", "MKV-Sammelordner Scan gestartet", {
      sourceDirs: sourceDirs.join(" | "),
      targetDir,
      mkvFiles: mkvFiles.length
    });

    const reservedTargets = new Set<string>();
    let moved = 0;
    let skipped = 0;
    let failed = 0;
    let sourceArtifactsChanged = false;
    let sourceCleanupRelevant = false;

    for (const sourcePath of mkvFiles) {
      if (shouldAbort?.()) {
        return;
      }
      if (isPathInsideDir(sourcePath, targetDir)) {
        skipped += 1;
        continue;
      }

      // Skip 0-byte files from failed/partial extractions
      let sourceSize = 0;
      let sourceMtimeMs = 0;
      try {
        const stat = await fs.promises.stat(sourcePath);
        sourceSize = stat.size;
        sourceMtimeMs = stat.mtimeMs;
      } catch {
        skipped += 1;
        continue;
      }
      // Frische-Skip (nur Hybrid-Pfad: deferFreshFiles=true): eine gerade extrahierte
      // Datei wird vom Auto-Rename absichtlich deferred (noch nicht stabil / EBUSY).
      // Wuerde der Collect sie JETZT moven, landet sie mit Original-Namen in der
      // Library statt umbenannt (genau der gemeldete "1-2 pro Staffel nicht
      // umbenannt"-Bug). Wir defern sie ebenfalls → eine spaetere Hybrid-Runde oder
      // der finale Deferred-Pass (deferFreshFiles=false) benennt sie um + sammelt sie.
      if (deferFreshFiles && this.fileStabilizeMinAgeMs > 0) {
        const ageMs = Date.now() - sourceMtimeMs;
        if (ageMs >= 0 && ageMs < this.fileStabilizeMinAgeMs) {
          logger.info(`MKV-Sammelordner: ${path.basename(sourcePath)} uebersprungen — Datei noch frisch (${Math.floor(ageMs)}ms), wird nach Stabilisierung gesammelt`);
          skipped += 1;
          continue;
        }
      }
      if (sourceSize === 0) {
        logger.warn(`MKV-Sammelordner: überspringe 0-Byte-Datei ${path.basename(sourcePath)}`);
        const resolved = this.inferItemForMediaLog(pkg, sourcePath, path.basename(sourcePath), targetDir);
        this.logRenameProcess(pkg, "WARN", "mkv-move", "MKV übersprungen: 0-Byte-Datei", {
          sourcePath,
          targetDir,
          sourceSize
        }, resolved.item, resolved.matchedBy);
        skipped += 1;
        continue;
      }

      // Check if identical file already exists in target (same name + same size) → skip instead of creating (2) copy
      const idealTargetPath = path.join(targetDir, path.basename(sourcePath));
      try {
        const existingStat = await fs.promises.stat(idealTargetPath);
        if (existingStat.size === sourceSize) {
          logger.info(`MKV-Sammelordner: Duplikat übersprungen (gleiche Größe ${humanSize(sourceSize)}): ${path.basename(sourcePath)}`);
          const resolved = this.inferItemForMediaLog(pkg, sourcePath, path.basename(sourcePath), idealTargetPath);
          this.logRenameProcess(pkg, "INFO", "mkv-move", "MKV-Duplikat übersprungen", {
            sourcePath,
            targetPath: idealTargetPath,
            sourceSize
          }, resolved.item, resolved.matchedBy);
          // Remove the duplicate source file to avoid future re-processing
          try {
            await fs.promises.unlink(sourcePath);
            sourceArtifactsChanged = true;
          } catch {
            /* ignore */
          }
          sourceCleanupRelevant = true;
          skipped += 1;
          continue;
        }
      } catch {
        // File doesn't exist in target yet — proceed normally
      }

      const targetPath = await this.buildUniqueFlattenTargetPath(targetDir, sourcePath, reservedTargets);
      if (pathKey(sourcePath) === pathKey(targetPath)) {
        skipped += 1;
        continue;
      }

      try {
        await this.moveFileWithExdevFallback(sourcePath, targetPath);
        moved += 1;
        sourceArtifactsChanged = true;
        sourceCleanupRelevant = true;
        this.logPackageForPackage(pkg, "INFO", "MKV verschoben", {
          sourcePath,
          targetPath,
          sourceSize
        });
        const resolved = this.inferItemForMediaLog(pkg, sourcePath, path.basename(sourcePath), targetPath);
        this.logRenameProcess(pkg, "INFO", "mkv-move", "MKV verschoben", {
          sourcePath,
          targetPath,
          sourceSize
        }, resolved.item, resolved.matchedBy);
        // Move matching companion files (subtitles, .nfo) alongside the video
        // so the media player can still find them next to the file.
        await this.moveCompanionFiles(sourcePath, targetPath, pkg);
      } catch (error) {
        failed += 1;
        logger.warn(`MKV verschieben fehlgeschlagen: ${sourcePath} -> ${targetPath} (${compactErrorText(error)})`);
        this.logPackageForPackage(pkg, "WARN", "MKV verschieben fehlgeschlagen", {
          sourcePath,
          targetPath,
          error: compactErrorText(error)
        });
        const resolved = this.inferItemForMediaLog(pkg, sourcePath, path.basename(sourcePath), targetPath);
        this.logRenameProcess(pkg, "WARN", "mkv-move", "MKV verschieben fehlgeschlagen", {
          sourcePath,
          targetPath,
          sourceSize,
          error: compactErrorText(error)
        }, resolved.item, resolved.matchedBy);
      }
    }

    if ((sourceArtifactsChanged || sourceCleanupRelevant) && cleanupDir && await this.existsAsync(cleanupDir)) {
      // NUR cleanupDir aufraeumen — niemals den outputDir bei autoExtract=true,
      // sonst werden noch nicht entpackte Archive-Sets geloescht (s.o.).
      const removedResidual = await this.cleanupNonMkvResidualFiles(cleanupDir, targetDir);
      if (removedResidual > 0) {
        logger.info(`MKV-Sammelordner entfernte Restdateien: pkg=${pkg.name}, dir=${cleanupDir}, entfernt=${removedResidual}`);
      }
      const removedDirs = await this.removeEmptyDirectoryTree(cleanupDir);
      if (removedDirs > 0) {
        logger.info(`MKV-Sammelordner entfernte leere Ordner: pkg=${pkg.name}, dir=${cleanupDir}, entfernt=${removedDirs}`);
      }
    }

    logger.info(`MKV-Sammelordner: pkg=${pkg.name}, packageId=${packageId}, moved=${moved}, skipped=${skipped}, failed=${failed}, target=${targetDir}`);
    this.logRenameProcess(pkg, "INFO", "mkv-move", "MKV-Sammelordner abgeschlossen", {
      sourceDirs: sourceDirs.join(" | "),
      targetDir,
      moved,
      skipped,
      failed
    });
  }

  public cancelPackage(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }
    this.logPackageForPackage(pkg, "WARN", "Paketabbruch angefordert", {
      itemCount: pkg.itemIds.length
    });
    pkg.cancelled = true;
    pkg.updatedAt = nowMs();
    const packageName = pkg.name;
    const outputDir = pkg.outputDir;
    const itemIds = [...pkg.itemIds];

    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      // Only overwrite outcome for non-completed items to preserve correct summary stats
      if (item.status !== "completed") {
        this.recordRunOutcome(itemId, "cancelled");
      }
      const active = this.activeTasks.get(itemId);
      if (active) {
        active.abortReason = "cancel";
        active.abortController.abort("cancel");
      }
    }

    this.abortPackagePostProcessing(packageId, "cancel");

    this.removePackageFromSession(packageId, itemIds);
    this.persistSoon();
    this.emitState(true);

    this.cleanupQueue = this.cleanupQueue
      .then(async () => {
        const removed = await cleanupCancelledPackageArtifactsAsync(outputDir, {
          shouldAbort: () => this.packageOutputDirInUse(outputDir)
        });
        logger.info(`Paket ${packageName} abgebrochen, ${removed} Artefakte gelöscht`);
      })
      .catch((error) => {
        logger.warn(`Cleanup für Paket ${packageName} fehlgeschlagen: ${compactErrorText(error)}`);
      });
  }

  public resetPackage(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) return;

    const itemIds = [...pkg.itemIds];

    // 1. Abort active downloads for items in THIS package only
    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item) continue;

      const active = this.activeTasks.get(itemId);
      if (active) {
        active.abortReason = "reset";
        active.abortController.abort("reset");
      }

      // Delete partial download file
      const targetPath = String(item.targetPath || "").trim();
      if (targetPath) {
        try { fs.rmSync(targetPath, { force: true }); } catch { /* ignore */ }
        this.releaseTargetPath(itemId);
      }

      // Reset item state
      this.dropItemContribution(itemId);
      this.runOutcomes.delete(itemId);
      this.runItemIds.delete(itemId);
      this.retryAfterByItem.delete(itemId);
      this.retryStateByItem.delete(itemId);

      item.status = "queued";
      item.downloadedBytes = 0;
      item.totalBytes = null;
      item.progressPercent = 0;
      item.speedBps = 0;
      item.attempts = 0;
      item.retries = 0;
      item.lastError = "";
      item.resumable = true;
      item.targetPath = "";
      item.provider = null;
      item.fullStatus = "Wartet";
      item.onlineStatus = undefined;
      item.updatedAt = nowMs();
    }

    // 2. Abort post-processing (extraction) if active for THIS package
    this.abortPackagePostProcessing(packageId, "reset");
    this.runCompletedPackages.delete(packageId);

    // 3. Clean up extraction progress manifest (.rd_extract_progress.json)
    if (pkg.outputDir) {
      clearExtractResumeState(pkg.outputDir, packageId).catch(() => {});
      clearExtractResumeState(pkg.outputDir).catch(() => {});
    }

    // 4. Reset package state
    pkg.status = "queued";
    pkg.cancelled = false;
    pkg.enabled = true;
    pkg.updatedAt = nowMs();
    this.historyRecordedPackages.delete(packageId);

    // 5. Re-add to runItemIds/runPackageIds if session is running so outcomes are tracked
    if (this.session.running) {
      for (const itemId of itemIds) {
        this.runItemIds.add(itemId);
      }
      this.runPackageIds.add(packageId);
    }

    logger.info(`Paket "${pkg.name}" zurückgesetzt (${itemIds.length} Items)`);
    this.persistSoon();
    this.emitState(true);
    if (this.session.running) {
      void this.ensureScheduler().catch((err) => logger.warn(`ensureScheduler Fehler (resetPackage): ${compactErrorText(err)}`));
    }
  }

  public resetItems(itemIds: string[]): void {
    const affectedPackageIds = new Set<string>();
    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item) continue;

      affectedPackageIds.add(item.packageId);

      const active = this.activeTasks.get(itemId);
      if (active) {
        active.abortReason = "reset";
        active.abortController.abort("reset");
      }

      const targetPath = String(item.targetPath || "").trim();
      if (targetPath) {
        try { fs.rmSync(targetPath, { force: true }); } catch { /* ignore */ }
        this.releaseTargetPath(itemId);
      }

      this.dropItemContribution(itemId);
      this.runOutcomes.delete(itemId);
      this.retryAfterByItem.delete(itemId);
      this.retryStateByItem.delete(itemId);

      item.status = "queued";
      item.downloadedBytes = 0;
      item.totalBytes = null;
      item.progressPercent = 0;
      item.speedBps = 0;
      item.attempts = 0;
      item.retries = 0;
      item.lastError = "";
      item.resumable = true;
      item.targetPath = "";
      item.provider = null;
      item.fullStatus = "Wartet";
      item.onlineStatus = undefined;
      item.updatedAt = nowMs();

      // Re-add to runItemIds if session is running so outcome is tracked in summary
      if (this.session.running) {
        this.runItemIds.add(itemId);
      } else {
        this.runItemIds.delete(itemId);
      }
    }

    // Reset parent package status if it was completed/failed (now has queued items again)
    for (const pkgId of affectedPackageIds) {
      // Abort active post-processing for this package
      this.abortPackagePostProcessing(pkgId, "reset");
      this.runCompletedPackages.delete(pkgId);
      this.historyRecordedPackages.delete(pkgId);

      const pkg = this.session.packages[pkgId];
      if (pkg && (pkg.status === "completed" || pkg.status === "failed" || pkg.status === "cancelled")) {
        pkg.status = "queued";
        pkg.cancelled = false;
        pkg.updatedAt = nowMs();
      }
      // Re-add package to runPackageIds so scheduler picks up the reset items
      if (this.session.running) {
        this.runPackageIds.add(pkgId);
      }
    }

    logger.info(`${itemIds.length} Item(s) zurückgesetzt`);
    this.persistSoon();
    this.emitState(true);
    if (this.session.running) {
      void this.ensureScheduler().catch((err) => logger.warn(`ensureScheduler Fehler (resetItems): ${compactErrorText(err)}`));
    }
  }

  public setPackagePriority(packageId: string, priority: PackagePriority): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) return;
    if (priority !== "high" && priority !== "normal" && priority !== "low") return;
    pkg.priority = priority;
    pkg.updatedAt = nowMs();

    // Move high-priority packages to the top of packageOrder
    if (priority === "high") {
      const order = this.session.packageOrder;
      const idx = order.indexOf(packageId);
      if (idx > 0) {
        order.splice(idx, 1);
        // Insert after last existing high-priority package
        let insertAt = 0;
        for (let i = 0; i < order.length; i++) {
          const p = this.session.packages[order[i]];
          if (p && p.priority === "high") {
            insertAt = i + 1;
          }
        }
        order.splice(insertAt, 0, packageId);
      }
    }

    this.persistSoon();
    this.emitState();
  }

  public skipItems(itemIds: string[]): void {
    const affectedPackageIds = new Set<string>();
    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item) continue;
      if (item.status !== "queued" && item.status !== "reconnect_wait") continue;
      item.status = "cancelled";
      item.fullStatus = "Übersprungen";
      item.speedBps = 0;
      item.updatedAt = nowMs();
      this.retryAfterByItem.delete(itemId);
      this.retryStateByItem.delete(itemId);
      this.releaseTargetPath(itemId);
      this.recordRunOutcome(itemId, "cancelled");
      affectedPackageIds.add(item.packageId);
    }
    for (const pkgId of affectedPackageIds) {
      const pkg = this.session.packages[pkgId];
      if (pkg) this.refreshPackageStatus(pkg);
    }
    // Trigger extraction if all items are now in a terminal state and some completed (no failures)
    if (this.settings.autoExtract) {
      for (const pkgId of affectedPackageIds) {
        const pkg = this.session.packages[pkgId];
        if (!pkg || pkg.cancelled || this.packagePostProcessTasks.has(pkgId)) continue;
        const pkgItems = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
        const hasPending = pkgItems.some((i) => i.status !== "completed" && i.status !== "failed" && i.status !== "cancelled");
        const hasFailed = pkgItems.some((i) => i.status === "failed");
        const hasUnextracted = pkgItems.some((i) => i.status === "completed" && shouldAutoRetryExtraction(i.fullStatus || ""));
        if (!hasPending && !hasFailed && hasUnextracted) {
          for (const it of pkgItems) {
            if (it.status === "completed" && shouldAutoRetryExtraction(it.fullStatus || "")) {
              it.fullStatus = "Entpacken - Ausstehend";
              it.updatedAt = nowMs();
            }
          }
          void this.runPackagePostProcessing(pkgId).catch((err) => logger.warn(`Post-processing nach Skip: ${compactErrorText(err)}`));
        }
      }
    }
    this.persistSoon();
    this.emitState();
  }

  public async startPackages(packageIds: string[]): Promise<void> {
    const targetSet = new Set(packageIds);

    // Enable specified packages if disabled (only non-cancelled)
    for (const pkgId of targetSet) {
      const pkg = this.session.packages[pkgId];
      if (pkg && !pkg.cancelled && !pkg.enabled) {
        pkg.enabled = true;
      }
    }

    // Recover stopped items in specified packages
    for (const item of Object.values(this.session.items)) {
      if (!targetSet.has(item.packageId)) continue;
      if (item.status === "cancelled" && item.fullStatus === "Gestoppt") {
        const pkg = this.session.packages[item.packageId];
        if (pkg && !pkg.cancelled && pkg.enabled) {
          item.status = "queued";
          item.fullStatus = "Wartet";
          item.lastError = "";
          item.speedBps = 0;
          item.updatedAt = nowMs();
        }
      }
    }

    // If already running, the scheduler will pick up newly enabled items
    if (this.session.running) {
      // Add new items to runItemIds so the scheduler processes them
      for (const item of Object.values(this.session.items)) {
        if (!targetSet.has(item.packageId)) continue;
        if (item.status === "queued" || item.status === "reconnect_wait") {
          this.runItemIds.add(item.id);
          this.runPackageIds.add(item.packageId);
        }
      }
      this.persistSoon();
      this.emitState(true);
      return;
    }

    // Not running: start with only items from specified packages
    this.triggerPendingExtractions();
    const runItems = Object.values(this.session.items)
      .filter((item) => {
        if (!targetSet.has(item.packageId)) return false;
        if (item.status !== "queued" && item.status !== "reconnect_wait") return false;
        const pkg = this.session.packages[item.packageId];
        return Boolean(pkg && !pkg.cancelled && pkg.enabled);
      });
    if (runItems.length === 0) {
      this.persistSoon();
      this.emitState(true);
      return;
    }
    this.runItemIds = new Set(runItems.map((item) => item.id));
    this.runPackageIds = new Set(runItems.map((item) => item.packageId));
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.retryStateByItem.clear();
    this.itemContributedBytes.clear();
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();
    this.session.running = true;
    this.session.paused = false;
    this.session.runStartedAt = nowMs();
    this.session.totalDownloadedBytes = 0;
    this.sessionCompletedFiles = 0;
    this.session.summaryText = "";
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.speedEventsHead = 0;
    this.lastGlobalProgressBytes = 0;
    this.lastGlobalProgressAt = nowMs();
    this.lastReconnectMarkAt = 0;
    this.consecutiveReconnects = 0;
    this.globalSpeedLimitQueue = Promise.resolve();
    this.globalSpeedLimitNextAt = 0;
    this.summary = null;
    this.nonResumableActive = 0;
    this.persistSoon();
    this.emitState(true);
    logger.info(`Start (nur Pakete: ${packageIds.length}): ${runItems.length} Items`);
    void this.ensureScheduler().catch((error) => {
      logger.error(`Scheduler abgestürzt: ${compactErrorText(error)}`);
      this.session.running = false;
      this.session.paused = false;
      this.persistSoon();
      this.emitState(true);
    });
  }

  public async startItems(itemIds: string[]): Promise<void> {
    const targetSet = new Set(itemIds);

    // Collect affected package IDs
    const affectedPackageIds = new Set<string>();
    for (const itemId of targetSet) {
      const item = this.session.items[itemId];
      if (item) affectedPackageIds.add(item.packageId);
    }

    // Enable affected packages if disabled (only non-cancelled)
    for (const pkgId of affectedPackageIds) {
      const pkg = this.session.packages[pkgId];
      if (pkg && !pkg.cancelled && !pkg.enabled) {
        pkg.enabled = true;
      }
    }

    // Recover stopped items
    for (const itemId of targetSet) {
      const item = this.session.items[itemId];
      if (!item) continue;
      if (item.status === "cancelled" && item.fullStatus === "Gestoppt") {
        const pkg = this.session.packages[item.packageId];
        if (pkg && !pkg.cancelled && pkg.enabled) {
          item.status = "queued";
          item.fullStatus = "Wartet";
          item.lastError = "";
          item.speedBps = 0;
          item.updatedAt = nowMs();
        }
      }
    }

    // If already running, add items to scheduler
    if (this.session.running) {
      for (const itemId of targetSet) {
        const item = this.session.items[itemId];
        if (!item) continue;
        const pkg = this.session.packages[item.packageId];
        if (!pkg || pkg.cancelled || !pkg.enabled) continue;
        if (item.status === "queued" || item.status === "reconnect_wait") {
          this.runItemIds.add(item.id);
          this.runPackageIds.add(item.packageId);
        }
      }
      this.persistSoon();
      this.emitState(true);
      return;
    }

    // Not running: start with only specified items
    this.triggerPendingExtractions();
    const runItems = [...targetSet]
      .map((id) => this.session.items[id])
      .filter((item) => {
        if (!item) return false;
        if (item.status !== "queued" && item.status !== "reconnect_wait") return false;
        const pkg = this.session.packages[item.packageId];
        return Boolean(pkg && !pkg.cancelled && pkg.enabled);
      });
    if (runItems.length === 0) {
      this.persistSoon();
      this.emitState(true);
      return;
    }
    this.runItemIds = new Set(runItems.map((item) => item.id));
    this.runPackageIds = new Set(runItems.map((item) => item.packageId));
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.retryStateByItem.clear();
    this.itemContributedBytes.clear();
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();
    this.session.running = true;
    this.session.paused = false;
    this.session.runStartedAt = nowMs();
    this.session.totalDownloadedBytes = 0;
    this.sessionCompletedFiles = 0;
    this.session.summaryText = "";
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.speedEventsHead = 0;
    this.lastGlobalProgressBytes = 0;
    this.lastGlobalProgressAt = nowMs();
    this.lastReconnectMarkAt = 0;
    this.consecutiveReconnects = 0;
    this.globalSpeedLimitQueue = Promise.resolve();
    this.globalSpeedLimitNextAt = 0;
    this.summary = null;
    this.nonResumableActive = 0;
    this.persistSoon();
    this.emitState(true);
    logger.info(`Start (nur Items: ${itemIds.length}): ${runItems.length} Items`);
    void this.ensureScheduler().catch((error) => {
      logger.error(`Scheduler abgestürzt: ${compactErrorText(error)}`);
      this.session.running = false;
      this.session.paused = false;
      this.persistSoon();
      this.emitState(true);
    });
  }

  public async start(): Promise<void> {
    if (this.session.running) {
      return;
    }
    // Bump scheduler generation so any old scheduler from a previous run exits
    // instead of continuing with stale state.
    this.schedulerGeneration += 1;

    // Set running early to prevent concurrent start() calls from passing the guard
    // while we await recoverRetryableItems below.
    this.session.running = true;

    const recoveredItems = await this.recoverRetryableItems("start");

    // Yield once more to let any pending abort handlers from the previous stop()
    // complete — they check this.session.running and skip status overwrite if true.
    await sleep(0);

    let recoveredStoppedItems = 0;
    for (const item of Object.values(this.session.items)) {
      if (item.status !== "cancelled" || item.fullStatus !== "Gestoppt") {
        continue;
      }
      const pkg = this.session.packages[item.packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      item.status = "queued";
      item.fullStatus = "Wartet";
      item.lastError = "";
      item.speedBps = 0;
      item.updatedAt = nowMs();
      recoveredStoppedItems += 1;
    }

    if (recoveredItems > 0 || recoveredStoppedItems > 0) {
      this.persistSoon();
      this.emitState(true);
    }

    this.triggerPendingExtractions();

    const runItems = Object.values(this.session.items)
      .filter((item) => {
        if (item.status !== "queued" && item.status !== "reconnect_wait") {
          return false;
        }
        const pkg = this.session.packages[item.packageId];
        return Boolean(pkg && !pkg.cancelled && pkg.enabled);
      });
    if (runItems.length === 0) {
      if (this.packagePostProcessTasks.size > 0) {
        this.runItemIds.clear();
        this.runPackageIds.clear();
        this.runOutcomes.clear();
        this.runCompletedPackages.clear();
        this.session.running = true;
        this.session.paused = false;
        this.session.runStartedAt = this.session.runStartedAt || nowMs();
        this.persistSoon();
        this.emitState(true);
        void this.ensureScheduler().catch((error) => {
          logger.error(`Scheduler abgestürzt: ${compactErrorText(error)}`);
          this.session.running = false;
          this.session.paused = false;
          this.persistSoon();
          this.emitState(true);
        });
        return;
      }
      this.runItemIds.clear();
      this.runPackageIds.clear();
      this.runOutcomes.clear();
      this.runCompletedPackages.clear();
      this.retryAfterByItem.clear();
      this.providerStartReservations.clear();
      this.pacedStartReservationByItem.clear();
      this.retryStateByItem.clear();
      this.reservedTargetPaths.clear();
      this.claimedTargetPathByItem.clear();
      this.session.running = false;
      this.session.paused = false;
      this.session.runStartedAt = 0;
      this.session.totalDownloadedBytes = 0;
      this.sessionCompletedFiles = 0;
      this.session.summaryText = "";
      this.session.reconnectUntil = 0;
      this.session.reconnectReason = "";
      this.speedEvents = [];
      this.speedBytesLastWindow = 0;
      this.speedBytesPerPackage.clear();
      this.speedEventsHead = 0;
      this.lastGlobalProgressBytes = 0;
      this.lastGlobalProgressAt = nowMs();
      this.summary = null;
      this.nonResumableActive = 0;
      this.persistSoon();
      this.emitState(true);
      return;
    }
    this.runItemIds = new Set(runItems.map((item) => item.id));
    this.runPackageIds = new Set(runItems.map((item) => item.packageId));
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.retryStateByItem.clear();
    this.itemContributedBytes.clear();
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();

    this.session.running = true;
    this.session.paused = false;
    // Keep cumulative session bytes across stop/resume so the session total stays accurate.
    // Only runStartedAt resets (for ETA/speed calculations relative to current run).
    this.session.runStartedAt = nowMs();
    this.session.totalDownloadedBytes = 0;
    this.sessionCompletedFiles = 0;
    this.session.summaryText = "";
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.lastReconnectMarkAt = 0;
    this.consecutiveReconnects = 0;
    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.speedEventsHead = 0;
    this.lastGlobalProgressBytes = 0;
    this.lastGlobalProgressAt = nowMs();
    this.globalSpeedLimitQueue = Promise.resolve();
    this.globalSpeedLimitNextAt = 0;
    this.summary = null;
    this.nonResumableActive = 0;
    this.persistSoon();
    this.emitState(true);
    void this.ensureScheduler().catch((error) => {
      logger.error(`Scheduler abgestürzt: ${compactErrorText(error)}`);
      this.session.running = false;
      this.session.paused = false;
      this.persistSoon();
      this.emitState(true);
    });
  }

  public stop(): void {
    const keepExtraction = this.settings.autoExtractWhenStopped;
    this.schedulerGeneration += 1;
    this.session.running = false;
    this.session.paused = false;
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.retryStateByItem.clear();
    this.lastGlobalProgressBytes = this.session.totalDownloadedBytes;
    this.lastGlobalProgressAt = nowMs();
    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.speedEventsHead = 0;
    if (!keepExtraction) {
      this.abortPostProcessing("stop");
      for (const waiter of this.packagePostProcessWaiters) { waiter.resolve(); }
      this.packagePostProcessWaiters = [];
      this.packagePostProcessActive = 0;
    }
    for (const active of this.activeTasks.values()) {
      active.abortReason = "stop";
      active.abortController.abort("stop");
    }
    // Reset all non-finished items to clean "Wartet" / "Paket gestoppt" state
    for (const item of Object.values(this.session.items)) {
      if (!isFinishedStatus(item.status)) {
        item.status = "queued";
        item.speedBps = 0;
        const pkg = this.session.packages[item.packageId];
        item.fullStatus = pkg && !pkg.enabled ? "Paket gestoppt" : "Wartet";
        item.updatedAt = nowMs();
      }
    }
    for (const pkg of Object.values(this.session.packages)) {
      if (keepExtraction && (pkg.status === "extracting" || pkg.status === "integrity_check")) {
        // Keep extraction-related statuses when autoExtractWhenStopped
        continue;
      }
      if (pkg.status === "downloading" || pkg.status === "validating"
        || pkg.status === "extracting" || pkg.status === "integrity_check"
        || pkg.status === "paused" || pkg.status === "reconnect_wait") {
        pkg.status = "queued";
        pkg.updatedAt = nowMs();
      }
    }
    this.persistSoon();
    this.emitState(true);
  }

  public prepareForShutdown(): void {
    logger.info(`Shutdown-Vorbereitung gestartet: active=${this.activeTasks.size}, running=${this.session.running}, paused=${this.session.paused}`);
    this.rotationListenerActive = false;
    this.clearPersistTimer();
    if (this.stateEmitTimer) {
      clearTimeout(this.stateEmitTimer);
      this.stateEmitTimer = null;
    }
    this.session.running = false;
    this.session.paused = false;
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.lastGlobalProgressBytes = this.session.totalDownloadedBytes;
    this.lastGlobalProgressAt = nowMs();
    this.abortPostProcessing("shutdown");

    let requeuedItems = 0;
    for (const active of this.activeTasks.values()) {
      const item = this.session.items[active.itemId];
      if (item && !isFinishedStatus(item.status)) {
        item.status = "queued";
        item.speedBps = 0;
        const pkg = this.session.packages[item.packageId];
        item.fullStatus = pkg && !pkg.enabled ? "Paket gestoppt" : "Wartet";
        item.updatedAt = nowMs();
        requeuedItems += 1;
      }
      active.abortReason = "shutdown";
      active.abortController.abort("shutdown");
    }

    for (const pkg of Object.values(this.session.packages)) {
      if (pkg.status === "downloading"
        || pkg.status === "validating"
        || pkg.status === "extracting"
        || pkg.status === "integrity_check"
        || pkg.status === "paused"
        || pkg.status === "reconnect_wait") {
        pkg.status = pkg.enabled ? "queued" : "paused";
        pkg.updatedAt = nowMs();
      }
    }

    for (const item of Object.values(this.session.items)) {
      if (item.status !== "completed") continue;
      const fullSt = item.fullStatus || "";
      // Only relabel items with active extraction status (e.g. "Entpacken 45%", "Passwort prüfen")
      // Skip items that were merely waiting ("Entpacken - Ausstehend", "Entpacken - Warten auf Parts")
      // as they were never actively extracting and "abgebrochen" would be misleading.
      if (/^Entpacken\b/i.test(fullSt) && !/Ausstehend/i.test(fullSt) && !/Warten/i.test(fullSt) && !isExtractedLabel(fullSt)) {
        item.fullStatus = "Entpacken abgebrochen (wird fortgesetzt)";
        item.updatedAt = nowMs();
        const pkg = this.session.packages[item.packageId];
        if (pkg) {
          pkg.status = pkg.enabled ? "queued" : "paused";
          pkg.updatedAt = nowMs();
        }
      }
    }

    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.speedEventsHead = 0;
    this.runItemIds.clear();
    this.runPackageIds.clear();
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.nonResumableActive = 0;
    this.session.summaryText = "";
    // Persist synchronously on shutdown to guarantee data is written before process exits.
    // Only skip if a backup was just imported (skipShutdownPersist) — the restored session
    // on disk must not be overwritten.  blockAllPersistence is intentionally NOT checked
    // here: it guards async/periodic saves during runtime, but shutdown must always persist
    // to prevent queue loss across restarts/updates.
    if (!this.skipShutdownPersist) {
      const pkgCount = Object.keys(this.session.packages).length;
      const itemCount = Object.keys(this.session.items).length;
      logger.info(`Shutdown-Save: ${pkgCount} Pakete, ${itemCount} Items`);
      this.foldRuntimeIntoSettings(nowMs());
      saveSession(this.storagePaths, this.session);
      saveSettings(this.storagePaths, this.settings);
    } else {
      logger.info(`Shutdown-Save übersprungen: skipShutdownPersist=${this.skipShutdownPersist}, blockAllPersistence=${this.blockAllPersistence}`);
    }
    this.emitState(true);
    logger.info(`Shutdown-Vorbereitung beendet: requeued=${requeuedItems}`);
  }

  public togglePause(): boolean {
    if (!this.session.running) {
      return false;
    }
    const wasPaused = this.session.paused;
    this.session.paused = !this.session.paused;

    if (!wasPaused && this.session.paused) {
      // Do NOT abort extraction on pause — extraction works on already-downloaded
      // files and should continue while downloads are paused.
      this.speedEvents = [];
      this.speedBytesLastWindow = 0;
      this.speedBytesPerPackage.clear();
      this.speedEventsHead = 0;
    }

    // When unpausing: clear all retry delays so stuck queued items restart immediately,
    // and abort long-stuck validating/downloading tasks so they get retried fresh.
    if (wasPaused && !this.session.paused) {
      this.retryAfterByItem.clear();
      this.providerStartReservations.clear();
      this.pacedStartReservationByItem.clear();
      // Reset provider circuit breaker so items don't sit in cooldown after unpause
      this.providerFailures.clear();

      const now = nowMs();
      for (const active of this.activeTasks.values()) {
        if (active.abortController.signal.aborted) {
          continue;
        }
        const item = this.session.items[active.itemId];
        if (!item) {
          continue;
        }
        const stuckSeconds = item.updatedAt > 0 ? (now - item.updatedAt) / 1000 : 0;
        const isStuckValidating = item.status === "validating" && stuckSeconds > 30;
        const isStuckDownloading = item.status === "downloading" && item.speedBps === 0 && stuckSeconds > 30;
        if (isStuckValidating || isStuckDownloading) {
          active.abortReason = "stall";
          active.abortController.abort("stall");
        }
      }

      // Retry failed extractions after unpause
      this.triggerPendingExtractions();
    }

    this.persistSoon();
    this.emitState(true);
    return this.session.paused;
  }

  private normalizeSessionStatuses(): void {
    this.session.running = false;
    this.session.paused = false;
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";

    for (const item of Object.values(this.session.items)) {
      if (item.provider === "megadebrid") {
        item.provider = resolveMegaDebridProvider(this.settings, item.provider);
      }
      if (item.provider !== "realdebrid"
        && item.provider !== "megadebrid"
        && item.provider !== "megadebrid-api"
        && item.provider !== "megadebrid-web"
        && item.provider !== "bestdebrid"
        && item.provider !== "alldebrid"
        && item.provider !== "ddownload") {
        item.provider = null;
      }
      if (item.status === "cancelled" && item.fullStatus === "Gestoppt") {
        item.status = "queued";
        item.fullStatus = "Wartet";
        item.lastError = "";
        item.speedBps = 0;
        item.provider = null;  // Re-evaluate provider order on restart
        item.updatedAt = nowMs();
        continue;
      }
      if (item.status === "extracting" || item.status === "integrity_check") {
        // These items have already been fully downloaded — mark as completed
        // so recoverPostProcessingOnStartup() can re-trigger extraction.
        item.status = "completed";
        item.fullStatus = `Fertig (${humanSize(item.downloadedBytes)})`;
        item.speedBps = 0;
        item.updatedAt = nowMs();
      } else if (item.status === "downloading"
        || item.status === "validating"
        || item.status === "paused"
        || item.status === "reconnect_wait") {
        const preserveRecoveryStatus = shouldPreflightFinalizeItemFromDisk(item);
        item.status = "queued";
        if (preserveRecoveryStatus) {
          item.fullStatus = (item.fullStatus || "").trim() || "Wartet";
        } else {
          const itemPkg = this.session.packages[item.packageId];
          item.fullStatus = (itemPkg && itemPkg.enabled === false) ? "Paket gestoppt" : "Wartet";
        }
        item.speedBps = 0;
        item.updatedAt = nowMs();
      }
      // Clear stale transient status texts from previous session
      if (item.status === "queued") {
        const statusText = (item.fullStatus || "").trim();
        if (statusText !== "Wartet"
          && statusText !== "Paket gestoppt"
          && statusText !== "Online"
          && !shouldPreflightFinalizeItemFromDisk(item)) {
          item.fullStatus = "Wartet";
        }
      }
      // Reset stale "checking" status from interrupted checks
      if (item.onlineStatus === "checking") {
        item.onlineStatus = undefined;
      }
      if (item.status === "completed") {
        const statusText = (item.fullStatus || "").trim();
        // Preserve extraction-related statuses (Ausstehend, Warten auf Parts, etc.)
        if (/^Entpacken\b/i.test(statusText) || isExtractErrorLabel(statusText) || isExtractedLabel(statusText) || /^Fertig\b/i.test(statusText)) {
          // keep as-is
        } else {
          item.fullStatus = this.settings.autoExtract
            ? "Entpacken - Ausstehend"
            : `Fertig (${humanSize(item.downloadedBytes)})`;
        }
      }
    }
    for (const pkg of Object.values(this.session.packages)) {
      if (pkg.enabled === undefined) {
        pkg.enabled = true;
      }
      if (!pkg.priority) {
        pkg.priority = "normal";
      }
      if (pkg.status === "downloading"
        || pkg.status === "validating"
        || pkg.status === "extracting"
        || pkg.status === "integrity_check"
        || pkg.status === "paused"
        || pkg.status === "reconnect_wait") {
        pkg.status = "queued";
      }

      const items = pkg.itemIds
        .map((itemId) => this.session.items[itemId])
        .filter(Boolean) as DownloadItem[];
      if (items.length === 0) {
        continue;
      }

      const hasPending = items.some((item) => (
        item.status === "queued"
        || item.status === "reconnect_wait"
      ));
      if (hasPending) {
        pkg.status = pkg.enabled ? "queued" : "paused";
        continue;
      }

      const success = items.filter((item) => item.status === "completed").length;
      const failed = items.filter((item) => item.status === "failed").length;
      const cancelled = items.filter((item) => item.status === "cancelled").length;

      if (failed > 0) {
        pkg.status = "failed";
      } else if (cancelled > 0) {
        pkg.status = success > 0 ? "completed" : "cancelled";
      } else if (success > 0) {
        pkg.status = "completed";
      }
    }
    this.resetSessionTotalsIfQueueEmpty(true);
    this.persistSoon();
  }

  private applyOnStartCleanupPolicy(): void {
    if (this.settings.completedCleanupPolicy !== "on_start") {
      return;
    }
    logger.info(`applyOnStartCleanupPolicy: ${Object.keys(this.session.packages).length} Pakete, ${Object.keys(this.session.items).length} Items vor Bereinigung`);
    for (const pkgId of [...this.session.packageOrder]) {
      const pkg = this.session.packages[pkgId];
      if (!pkg) {
        continue;
      }
      const completedItemIds: string[] = [];
      pkg.itemIds = pkg.itemIds.filter((itemId) => {
        const item = this.session.items[itemId];
        if (!item) {
          return false;
        }
        if (item.status === "completed") {
          // With autoExtract: keep items that haven't been extracted yet
          if (this.settings.autoExtract && !isExtractedLabel(item.fullStatus || "")) {
            return true;
          }
          completedItemIds.push(itemId);
          return false;
        }
        return true;
      });
      if (pkg.itemIds.length === 0) {
        logger.info(`applyOnStartCleanupPolicy: entferne Paket ${pkg.name} (${completedItemIds.length} completed Items)`);
        this.removePackageFromSession(pkgId, completedItemIds);
      } else {
        if (completedItemIds.length > 0) {
          logger.info(`applyOnStartCleanupPolicy: entferne ${completedItemIds.length} completed Items aus Paket ${pkg.name} (${pkg.itemIds.length} Items verbleiben)`);
        }
        for (const itemId of completedItemIds) {
          delete this.session.items[itemId];
          this.itemCount = Math.max(0, this.itemCount - 1);
        }
      }
    }
    logger.info(`applyOnStartCleanupPolicy: ${Object.keys(this.session.packages).length} Pakete, ${Object.keys(this.session.items).length} Items nach Bereinigung`);
  }

  private applyRetroactiveCleanupPolicy(): void {
    const policy = this.settings.completedCleanupPolicy;
    if (policy === "never") return;

    let removed = 0;
    for (const pkgId of [...this.session.packageOrder]) {
      const pkg = this.session.packages[pkgId];
      if (!pkg) continue;

      if (policy === "immediate") {
        const completedItemIds = pkg.itemIds.filter((itemId) => {
          const item = this.session.items[itemId];
          if (!item || item.status !== "completed") return false;
          if (this.settings.autoExtract) return isExtractedLabel(item.fullStatus || "");
          return true;
        });
        for (const itemId of completedItemIds) {
          pkg.itemIds = pkg.itemIds.filter((id) => id !== itemId);
          this.releaseTargetPath(itemId);
          this.dropItemContribution(itemId);
          this.retryAfterByItem.delete(itemId);
          this.retryStateByItem.delete(itemId);
          removed += 1;
        }
        if (pkg.itemIds.length === 0) {
          this.removePackageFromSession(pkgId, completedItemIds);
        } else {
          for (const itemId of completedItemIds) {
            delete this.session.items[itemId];
            this.itemCount = Math.max(0, this.itemCount - 1);
          }
        }
      } else if (policy === "package_done" || policy === "on_start") {
        const allCompleted = pkg.itemIds.every((id) => {
          const item = this.session.items[id];
          return !item || item.status === "completed" || item.status === "failed" || item.status === "cancelled";
        });
        if (!allCompleted) continue;
        if (this.settings.autoExtract) {
          const allExtracted = pkg.itemIds.every((id) => {
            const item = this.session.items[id];
            if (!item) return true;
            if (item.status === "failed" || item.status === "cancelled") return true;
            return isExtractedLabel(item.fullStatus || "");
          });
          if (!allExtracted) continue;
        }
        removed += pkg.itemIds.length;
        this.removePackageFromSession(pkgId, [...pkg.itemIds], "completed");
      }
    }
    if (removed > 0) {
      logger.info(`Retroaktive Bereinigung: ${removed} fertige Items entfernt (policy=${policy})`);
      this.persistSoon();
    }
  }

  public clearPersistTimer(): void {
    if (!this.persistTimer) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  private persistSoon(): void {
    if (this.persistTimer || this.blockAllPersistence) {
      return;
    }

    const itemCount = this.itemCount;
    const minGapMs = this.session.running
      ? itemCount >= 1500
        ? 3000
        : itemCount >= 700
          ? 2200
          : itemCount >= 250
            ? 1500
            : 700
      : 300;
    const sinceLastPersist = nowMs() - this.lastPersistAt;
    const delay = Math.max(120, minGapMs - sinceLastPersist);

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, delay);
  }

  private persistNow(): void {
    const now = nowMs();
    this.lastPersistAt = now;
    void saveSessionAsync(this.storagePaths, this.session).catch((err) => logger.warn(`saveSessionAsync Fehler: ${compactErrorText(err)}`));
    if (now - this.lastSettingsPersistAt >= 30000) {
      this.foldRuntimeIntoSettings(now);
      this.lastSettingsPersistAt = now;
      void saveSettingsAsync(this.storagePaths, this.settings).catch((err) => logger.warn(`saveSettingsAsync Fehler: ${compactErrorText(err as Error)}`));
    }
  }

  /** Synchronous persist — guarantees state is on disk before returning.
   *  Used before update installs to prevent queue loss. */
  public persistNowSync(): void {
    this.clearPersistTimer();
    const pkgCount = Object.keys(this.session.packages).length;
    const itemCount = Object.keys(this.session.items).length;
    logger.info(`Pre-Update Sync-Save: ${pkgCount} Pakete, ${itemCount} Items`);
    this.foldRuntimeIntoSettings(nowMs());
    saveSession(this.storagePaths, this.session);
    saveSettings(this.storagePaths, this.settings);
  }

  private emitState(force = false): void {
    const now = nowMs();
    const MIN_FORCE_GAP_MS = 120;
    if (force) {
      const sinceLastEmit = now - this.lastStateEmitAt;
      if (sinceLastEmit >= MIN_FORCE_GAP_MS) {
        if (this.stateEmitTimer) {
          clearTimeout(this.stateEmitTimer);
          this.stateEmitTimer = null;
        }
        this.lastStateEmitAt = now;
        this.emit("state", this.getSnapshotForEmit());
        return;
      }
      // Too soon — replace any pending timer with a shorter forced-emit timer
      if (this.stateEmitTimer) {
        clearTimeout(this.stateEmitTimer);
        this.stateEmitTimer = null;
      }
      this.stateEmitTimer = setTimeout(() => {
        this.stateEmitTimer = null;
        this.lastStateEmitAt = nowMs();
        this.emit("state", this.getSnapshotForEmit());
      }, MIN_FORCE_GAP_MS - sinceLastEmit);
      return;
    }
    if (this.stateEmitTimer) {
      return;
    }
    const itemCount = this.itemCount;
    const emitDelay = this.session.running
      ? itemCount >= 1500
        ? 700
        : itemCount >= 700
          ? 500
          : itemCount >= 250
            ? 300
            : 150
      : 200;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.lastStateEmitAt = nowMs();
      this.emit("state", this.getSnapshotForEmit());
    }, emitDelay);
  }

  private speedEventsHead = 0;
  private speedBytesPerPackage = new Map<string, number>();

  private pruneSpeedEvents(now: number): void {
    const cutoff = now - SPEED_WINDOW_SECONDS * 1000;
    while (this.speedEventsHead < this.speedEvents.length && this.speedEvents[this.speedEventsHead].at < cutoff) {
      const ev = this.speedEvents[this.speedEventsHead];
      this.speedBytesLastWindow = Math.max(0, this.speedBytesLastWindow - ev.bytes);
      const pkgBytes = (this.speedBytesPerPackage.get(ev.pid) ?? 0) - ev.bytes;
      if (pkgBytes <= 0) this.speedBytesPerPackage.delete(ev.pid);
      else this.speedBytesPerPackage.set(ev.pid, pkgBytes);
      this.speedEventsHead += 1;
    }
    if (this.speedEventsHead > 200) {
      this.speedEvents = this.speedEvents.slice(this.speedEventsHead);
      this.speedEventsHead = 0;
    }
  }

  private lastSpeedPruneAt = 0;

  private recordSpeed(bytes: number, packageId: string = ""): void {
    const now = nowMs();
    if (bytes > 0 && this.consecutiveReconnects > 0) {
      this.consecutiveReconnects = 0;
    }
    const bucket = now - (now % 120);
    const last = this.speedEvents[this.speedEvents.length - 1];
    if (last && last.at === bucket && last.pid === packageId) {
      last.bytes += bytes;
    } else {
      this.speedEvents.push({ at: bucket, bytes, pid: packageId });
    }
    this.speedBytesLastWindow += bytes;
    this.speedBytesPerPackage.set(packageId, (this.speedBytesPerPackage.get(packageId) ?? 0) + bytes);
    if (now - this.lastSpeedPruneAt >= 1500) {
      this.pruneSpeedEvents(now);
      this.lastSpeedPruneAt = now;
    }
  }

  private recordRunOutcome(itemId: string, status: "completed" | "failed" | "cancelled"): void {
    if (!this.runItemIds.has(itemId)) {
      return;
    }
    const previous = this.runOutcomes.get(itemId);
    this.runOutcomes.set(itemId, status);
    if (status === "completed" && previous !== "completed") {
      this.sessionCompletedFiles += 1;
      this.settings.totalCompletedFilesAllTime = Math.max(0, Number(this.settings.totalCompletedFilesAllTime || 0)) + 1;
      this.invalidateStatsCache();
    }
  }

  private dropItemContribution(itemId: string): void {
    this.itemContributedBytes.delete(itemId);
    // Session totals are cumulative for the current app run and must not shrink
    // just because an item/package is removed from the queue after completion.
    this.invalidateStatsCache();
  }

  private claimTargetPath(itemId: string, preferredPath: string, allowExistingFile = false): string {
    const preferredKey = pathKey(preferredPath);
    const existingClaim = this.claimedTargetPathByItem.get(itemId);
    if (existingClaim) {
      const existingKey = pathKey(existingClaim);
      const owner = this.reservedTargetPaths.get(existingKey);
      if (owner === itemId) {
        if (existingKey === preferredKey) {
          return existingClaim;
        }
        this.reservedTargetPaths.delete(existingKey);
      }
      this.claimedTargetPathByItem.delete(itemId);
    }

    const parsed = path.parse(preferredPath);
    const maxIndex = 10000;
    for (let index = 0; index <= maxIndex; index += 1) {
      const candidate = index === 0
        ? preferredPath
        : path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
      const key = index === 0
        ? preferredKey
        : pathKey(candidate);
      const owner = this.reservedTargetPaths.get(key);
      const existsOnDisk = fs.existsSync(candidate);
      const allowExistingCandidate = allowExistingFile && index === 0;
      if ((!owner || owner === itemId) && (owner === itemId || !existsOnDisk || allowExistingCandidate)) {
        this.reservedTargetPaths.set(key, itemId);
        this.claimedTargetPathByItem.set(itemId, candidate);
        return candidate;
      }
    }
    logger.error(`claimTargetPath: Limit erreicht für ${preferredPath}`);
    const fallbackPath = path.join(parsed.dir, `${parsed.name} (${Date.now()})${parsed.ext}`);
    this.reservedTargetPaths.set(pathKey(fallbackPath), itemId);
    this.claimedTargetPathByItem.set(itemId, fallbackPath);
    return fallbackPath;
  }

  private releaseTargetPath(itemId: string): void {
    const claimedPath = this.claimedTargetPathByItem.get(itemId);
    if (!claimedPath) {
      return;
    }
    const key = pathKey(claimedPath);
    const owner = this.reservedTargetPaths.get(key);
    if (owner === itemId) {
      this.reservedTargetPaths.delete(key);
    }
    this.claimedTargetPathByItem.delete(itemId);
  }

  /** Restore reservedTargetPaths from persisted session on startup so claimTargetPath
   *  knows which files belong to which items. Without this, after restart all paths are
   *  unclaimed and a new download with the same filename would create a "(1)" copy
   *  instead of reusing its own partial file — or worse, overwrite another item's file. */
  private restoreTargetPathReservations(): void {
    let restored = 0;
    let droppedUnsafe = 0;
    for (const item of Object.values(this.session.items)) {
      const pkg = this.session.packages[item.packageId];
      if (!pkg) {
        continue;
      }
      const tp = String(item.targetPath || "").trim();
      if (!tp) continue;
      if (!isPathInsideDir(tp, pkg.outputDir)) {
        droppedUnsafe += 1;
        item.targetPath = "";
        continue;
      }
      const key = pathKey(tp);
      if (!this.reservedTargetPaths.has(key)) {
        this.reservedTargetPaths.set(key, item.id);
        this.claimedTargetPathByItem.set(item.id, tp);
        restored += 1;
      }
    }
    if (restored > 0) {
      logger.info(`restoreTargetPathReservations: ${restored} Pfade aus Session wiederhergestellt`);
    }
    if (droppedUnsafe > 0) {
      logger.warn(`restoreTargetPathReservations: ${droppedUnsafe} unsichere targetPath-Eintraege verworfen`);
    }
    this.reconcileDuplicateSuffixSessionItems();
    // Fix legacy (N) suffix files: rename back to original if original path is free
    this.fixDuplicateSuffixFiles();
  }

  private reconcileDuplicateSuffixSessionItems(): void {
    let merged = 0;
    const touchedPackageIds = new Set<string>();

    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg) {
        continue;
      }

      for (const itemId of [...pkg.itemIds]) {
        const duplicateItem = this.session.items[itemId];
        if (!duplicateItem) {
          continue;
        }
        const duplicateTargetPath = String(duplicateItem.targetPath || "").trim();
        if (!duplicateTargetPath) {
          continue;
        }
        const duplicateBaseName = path.basename(duplicateTargetPath);
        if (!hasDuplicateSuffixBeforeExtension(duplicateBaseName)) {
          continue;
        }

        const canonicalBaseName = stripDuplicateSuffixBeforeExtension(duplicateBaseName);
        const canonicalPath = path.join(path.dirname(duplicateTargetPath), canonicalBaseName);
        const canonicalKey = pathKey(canonicalPath);
        let primaryItem = Object.values(this.session.items).find((candidate) =>
          candidate.packageId === packageId
          && candidate.id !== duplicateItem.id
          && (
            pathKey(String(candidate.targetPath || "")) === canonicalKey
            || (
              !candidate.targetPath
              && stripDuplicateSuffixBeforeExtension(candidate.fileName || "") === canonicalBaseName
            )
          )
        );
        if (!primaryItem) {
          continue;
        }

        const duplicateExists = fs.existsSync(duplicateTargetPath);
        let canonicalExists = fs.existsSync(canonicalPath);
        const primaryWins = startupDuplicateStateRank(primaryItem, canonicalExists) >= startupDuplicateStateRank(duplicateItem, duplicateExists);

        if (duplicateExists && !canonicalExists) {
          try {
            fs.renameSync(duplicateTargetPath, canonicalPath);
            canonicalExists = true;
            this.logVerifiedRenameSync("startup-dedup", duplicateTargetPath, canonicalPath);
            logger.info(`startupDuplicateMerge: ${path.basename(duplicateTargetPath)} → ${canonicalBaseName}`);
          } catch (err) {
            logDesktopRename("ERROR", "startup-dedup: Rename fehlgeschlagen", {
              source: path.basename(duplicateTargetPath),
              target: canonicalBaseName,
              error: compactErrorText(err)
            });
            logger.warn(`startupDuplicateMerge: Umbenennung fehlgeschlagen ${duplicateTargetPath}: ${compactErrorText(err)}`);
          }
        } else if (duplicateExists && canonicalExists && primaryWins) {
          try {
            fs.rmSync(duplicateTargetPath, { force: true });
          } catch {
            // ignore, stale duplicate can remain on disk if Windows still holds a handle
          }
        } else if (duplicateExists && canonicalExists && !primaryWins && primaryItem.status !== "completed") {
          try {
            fs.rmSync(canonicalPath, { force: true });
            fs.renameSync(duplicateTargetPath, canonicalPath);
            canonicalExists = true;
            this.logVerifiedRenameSync("startup-dedup (Austausch)", duplicateTargetPath, canonicalPath);
            logger.info(`startupDuplicateMerge: ersetze verwaisten Originalpfad ${canonicalBaseName} durch ${path.basename(duplicateTargetPath)}`);
          } catch (err) {
            logDesktopRename("ERROR", "startup-dedup (Austausch): Rename fehlgeschlagen", {
              source: path.basename(duplicateTargetPath),
              target: canonicalBaseName,
              error: compactErrorText(err)
            });
            logger.warn(`startupDuplicateMerge: Austausch fehlgeschlagen ${canonicalPath}: ${compactErrorText(err)}`);
          }
        }

        const duplicateShouldWin = !primaryWins || (duplicateItem.status === "completed" && primaryItem.status !== "completed");
        if (duplicateShouldWin) {
          primaryItem.status = duplicateItem.status;
          primaryItem.fullStatus = duplicateItem.fullStatus;
          primaryItem.lastError = duplicateItem.lastError;
          primaryItem.downloadedBytes = Math.max(Number(primaryItem.downloadedBytes || 0), Number(duplicateItem.downloadedBytes || 0));
          primaryItem.totalBytes = Math.max(Number(primaryItem.totalBytes || 0), Number(duplicateItem.totalBytes || 0)) || primaryItem.totalBytes;
          primaryItem.progressPercent = Math.max(Number(primaryItem.progressPercent || 0), Number(duplicateItem.progressPercent || 0));
        }

        if (canonicalExists) {
          try {
            const stat = fs.statSync(canonicalPath);
            primaryItem.downloadedBytes = Math.max(Number(primaryItem.downloadedBytes || 0), stat.size);
            if (!primaryItem.totalBytes || primaryItem.totalBytes < stat.size) {
              primaryItem.totalBytes = stat.size;
            }
            if (primaryItem.status === "completed") {
              primaryItem.progressPercent = 100;
            }
          } catch {
            // ignore stat failures; persisted metadata remains as-is
          }
        }

        primaryItem.fileName = canonicalBaseName;
        primaryItem.targetPath = canonicalPath;
        primaryItem.updatedAt = Math.max(Number(primaryItem.updatedAt || 0), Number(duplicateItem.updatedAt || 0), nowMs());
        this.claimedTargetPathByItem.set(primaryItem.id, canonicalPath);
        this.reservedTargetPaths.set(canonicalKey, primaryItem.id);

        this.retryAfterByItem.delete(duplicateItem.id);
        this.retryStateByItem.delete(duplicateItem.id);
        this.releaseTargetPath(duplicateItem.id);
        this.dropItemContribution(duplicateItem.id);
        delete this.session.items[duplicateItem.id];
        pkg.itemIds = pkg.itemIds.filter((candidateId) => candidateId !== duplicateItem.id);
        this.itemCount = Math.max(0, this.itemCount - 1);
        merged += 1;
        touchedPackageIds.add(packageId);
      }
    }

    if (merged > 0) {
      for (const packageId of touchedPackageIds) {
        const pkg = this.session.packages[packageId];
        if (pkg) {
          this.refreshPackageStatus(pkg);
        }
      }
      logger.info(`reconcileDuplicateSuffixSessionItems: ${merged} Duplikat-Items zusammengeführt`);
      this.persistSoon();
    }
  }

  /** Re-validate "completed" items on startup: if the file on disk is significantly
   *  smaller than expected, the item was incorrectly marked completed (e.g. by the
   *  old 50% recovery threshold). Reset to "queued" so it gets re-downloaded. */
  private revalidateCompletedItems(): void {
    let fixed = 0;
    const touchedPackageIds = new Set<string>();
    for (const item of Object.values(this.session.items)) {
      if (item.status !== "completed") continue;
      if (isExtractedLabel(item.fullStatus || "")) continue;
      const targetPath = String(item.targetPath || "").trim();
      const archiveLike = isArchiveLikePath(targetPath || item.fileName || "");
      if (archiveLike) {
        let statSize: number | null = null;
        if (targetPath) {
          try {
            statSize = fs.statSync(targetPath).size;
          } catch {
            statSize = null;
          }
        }
        const zeroByteArchive = statSize != null
          ? statSize <= 0
          : (item.downloadedBytes <= 0 && item.progressPercent >= 100) || /\b0\s*B\b/i.test(item.fullStatus || "");
        if (zeroByteArchive) {
          logger.warn(`revalidateCompleted: ${item.fileName} ist 0B/leer, setze auf queued`);
          this.queueItemForRetry(item, {
            hardReset: true,
            reason: "Wartet (Auto-Retry: 0B-Datei)"
          });
          fixed += 1;
          touchedPackageIds.add(item.packageId);
          continue;
        }
      }
      if (!targetPath || !item.totalBytes || item.totalBytes <= 0) continue;
      try {
        const stat = fs.statSync(targetPath);
        const expectedMinSize = expectedMinBytes(item.totalBytes, isLargeBinaryLikePath(item.fileName || targetPath));
        const persistedShortfall = item.downloadedBytes < expectedMinSize && stat.size >= expectedMinSize;
        if (stat.size < expectedMinSize) {
          logger.warn(`revalidateCompleted: ${item.fileName} ist nur ${humanSize(stat.size)} statt ${humanSize(item.totalBytes)}, setze auf queued`);
          item.status = "queued";
          item.fullStatus = "Wartet";
          item.downloadedBytes = stat.size;
          item.progressPercent = Math.floor((stat.size / item.totalBytes) * 100);
          item.speedBps = 0;
          fixed += 1;
          touchedPackageIds.add(item.packageId);
        } else if (persistedShortfall) {
          logger.warn(`revalidateCompleted: ${item.fileName} wirkt pre-alloc/unvollständig (stat=${humanSize(stat.size)}, bytes=${humanSize(item.downloadedBytes)}, total=${humanSize(item.totalBytes)}), setze auf queued`);
          item.status = "queued";
          item.fullStatus = "Wartet (Auto-Recovery: pre-alloc)";
          item.progressPercent = Math.max(0, Math.min(99, Math.floor((Math.max(0, item.downloadedBytes) / item.totalBytes) * 100)));
          item.speedBps = 0;
          fixed += 1;
          touchedPackageIds.add(item.packageId);
        }
      } catch {
        // file doesn't exist — reset to queued so it gets re-downloaded
        if (archiveLike && this.shouldPreserveMissingCompletedArchiveForStartupRecovery(item)) {
          logger.info(`revalidateCompleted: ${item.fileName} Quelle fehlt, belasse fuer Startup-Recovery`);
          continue;
        }
        logger.warn(`revalidateCompleted: ${item.fileName} Datei nicht gefunden, setze auf queued`);
        item.status = "queued";
        item.fullStatus = "Wartet";
        item.downloadedBytes = 0;
        item.progressPercent = 0;
        item.speedBps = 0;
        fixed += 1;
        touchedPackageIds.add(item.packageId);
      }
    }
    if (fixed > 0) {
      for (const packageId of touchedPackageIds) {
        const pkg = this.session.packages[packageId];
        if (pkg) {
          this.refreshPackageStatus(pkg);
        }
      }
      logger.info(`revalidateCompletedItems: ${fixed} Items korrigiert`);
      this.persistSoon();
    }
  }

  private shouldPreserveMissingCompletedArchiveForStartupRecovery(item: DownloadItem): boolean {
    if (!this.settings.autoExtract) {
      return false;
    }
    const pkg = this.session.packages[item.packageId];
    if (!pkg || pkg.cancelled || pkg.enabled === false) {
      return false;
    }
    const statusText = String(item.fullStatus || "").trim();
    if (isExtractedLabel(statusText) || isExtractErrorLabel(statusText)) {
      return false;
    }
    return /^Fertig\b/i.test(statusText)
      || shouldPreserveExtractionResumeLabel(statusText)
      || shouldAutoRetryExtraction(statusText);
  }

  private tryFinalizeItemFromDisk(
    pkg: PackageEntry,
    item: DownloadItem,
    source: string,
    errorText = ""
  ): boolean {
    const diskState = inspectPackageItemDiskState(pkg, item);
    const normalizedError = compactErrorText(errorText).replace(/^Error:\s*/i, "");
    const knownShortfall = item.totalBytes != null && item.totalBytes > 0
      ? Math.max(0, item.totalBytes - diskState.size)
      : 0;
    const underflowIndicated = normalizedError.includes("download_underflow")
      || normalizedError.includes("resume_download_underflow");
    const archiveLikeTarget = String(item.fileName || diskState.diskPath || "").toLowerCase();
    const archiveLike = /(?:\.part\d+\.rar|\.rar|\.r\d{2,3}|\.zip(?:\.\d+)?|\.7z(?:\.\d+)?|\.(?:tar(?:\.(?:gz|bz2|xz))?|tgz|tbz2|txz)|\.\d{3})$/i.test(archiveLikeTarget);
    const expectedMinSize = expectedMinBytes(item.totalBytes, isLargeBinaryLikePath(item.fileName || diskState.diskPath || ""));
    const looksComplete = diskState.exists
      && diskState.fullOnDisk
      && (
        diskState.reason === "ok"
        || item.progressPercent >= 100
        || item.downloadedBytes >= diskState.minBytes
        || (item.totalBytes != null && item.totalBytes > 0 && diskState.size >= expectedMinSize)
      );
    if (!looksComplete || (knownShortfall > 0 && (underflowIndicated || archiveLike))) {
      return false;
    }

    logger.info(
      `${source}: ${item.fileName || item.id} ist bereits vollstaendig auf Disk ` +
      `(${humanSize(diskState.size)}, erwartet mind. ${humanSize(diskState.minBytes)})`
    );
    this.logPackageForItem(item, "INFO", `${source}: Datei bereits vollstaendig`, {
      fileSize: diskState.size,
      expectedMin: diskState.minBytes,
      diskReason: diskState.reason,
      error: errorText || undefined
    });

    item.status = "completed";
    item.fullStatus = this.settings.autoExtract
      ? "Entpacken - Ausstehend"
      : `Fertig (${humanSize(diskState.size)})`;
    item.downloadedBytes = diskState.size;
    if (!item.totalBytes || item.totalBytes < diskState.size) {
      item.totalBytes = diskState.size;
    }
    item.progressPercent = 100;
    item.speedBps = 0;
    const finalizedAt = nowMs();
    item.updatedAt = finalizedAt;
    this.notePackageDownloadCompleted(pkg, finalizedAt);
    pkg.updatedAt = finalizedAt;
    this.recordRunOutcome(item.id, "completed");

    if (this.session.running) {
      void this.runPackagePostProcessing(pkg.id).catch((err) => {
        logger.warn(`runPackagePostProcessing Fehler (${source}): ${compactErrorText(err)}`);
      }).finally(() => {
        this.applyCompletedCleanupPolicy(pkg.id, item.id);
        this.persistSoon();
        this.emitState();
      });
    }

    this.persistSoon();
    this.emitState();
    this.retryStateByItem.delete(item.id);
    return true;
  }

  private areAllPackageItemRefsFinished(pkg: PackageEntry): boolean {
    return pkg.itemIds.every((itemId) => {
      const item = this.session.items[itemId];
      return item != null && isFinishedStatus(item.status);
    });
  }

  private shouldCollapseQuickPostProcessRequeue(packageId: string): boolean {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return true;
    }
    return !this.areAllPackageItemRefsFinished(pkg);
  }

  private async findFullExtractArchiveSet(pkg: PackageEntry, completedItems: DownloadItem[]): Promise<Set<string>> {
    const relevant = new Set<string>();
    if (!pkg.outputDir || completedItems.length === 0) {
      return relevant;
    }

    const candidates = await findArchiveCandidates(pkg.outputDir);
    for (const candidate of candidates) {
      const archiveItems = resolveArchiveItemsFromList(path.basename(candidate), completedItems);
      if (archiveItems.length === 0) {
        continue;
      }
      const hasPendingExtract = archiveItems.some((item) => !isExtractedLabel(item.fullStatus || ""));
      if (!hasPendingExtract) {
        continue;
      }
      relevant.add(pathKey(candidate));
    }

    return relevant;
  }

  private clearHybridArchiveState(packageId: string, archiveKey?: string): void {
    if (!archiveKey) {
      this.hybridExtractedPaths.delete(packageId);
      this.hybridFailedArchives.delete(packageId);
      // Also clear re-download loop protection for this package
      for (const key of this.autoRecoveredForRedownload) {
        if (key.startsWith(`${packageId}::`)) this.autoRecoveredForRedownload.delete(key);
      }
      return;
    }

    const normalizedKey = pathKey(archiveKey);
    const attempted = this.hybridExtractedPaths.get(packageId);
    if (attempted) {
      attempted.delete(normalizedKey);
      if (attempted.size === 0) {
        this.hybridExtractedPaths.delete(packageId);
      }
    }

    const failed = this.hybridFailedArchives.get(packageId);
    if (failed) {
      failed.delete(normalizedKey);
      if (failed.size === 0) {
        this.hybridFailedArchives.delete(packageId);
      }
    }
  }

  private buildHybridArchiveRetryMarker(pkg: PackageEntry, items: DownloadItem[], archiveKey: string): string {
    const archiveName = path.basename(archiveKey);
    const archiveItems = resolveArchiveItemsFromList(archiveName, items)
      .slice()
      .sort((left, right) => {
        const leftName = (left.fileName || left.targetPath || left.id || "").toLowerCase();
        const rightName = (right.fileName || right.targetPath || right.id || "").toLowerCase();
        return leftName.localeCompare(rightName);
      });

    const itemStates = archiveItems.map((item) => {
      const diskState = inspectPackageItemDiskState(pkg, item);
      return [
        (item.fileName || item.id || "").toLowerCase(),
        item.status,
        item.downloadedBytes || 0,
        item.totalBytes || 0,
        diskState.reason,
        diskState.size
      ].join("|");
    });

    return JSON.stringify({
      archiveName: archiveName.toLowerCase(),
      passwordList: String(this.settings.archivePasswordList || "").replace(/\r\n|\r/g, "\n").trim(),
      itemStates
    });
  }

  private autoRecoverArchiveCrcFailure(
    pkg: PackageEntry,
    items: DownloadItem[],
    failure: ExtractArchiveFailureInfo,
    scope: "hybrid" | "full"
  ): number {
    // Allow auto-recovery for both crc_error and wrong_password when suggestRedownload is set.
    // Encrypted RAR5 archives with corrupt content produce "Checksum error in the encrypted
    // file" which is indistinguishable from a wrong-password error.  When the JVM extractor
    // also failed (suggestRedownload=true), re-downloading is warranted for both categories.
    if (!failure.suggestRedownload || (failure.category !== "crc_error" && failure.category !== "wrong_password")) {
      return 0;
    }

    const archiveItems = resolveArchiveItemsFromList(failure.archiveName, items)
      .filter((item) => item.status === "completed");
    if (archiveItems.length === 0) {
      logger.warn(`Auto-Recovery (${scope}): Keine completed Items für ${failure.archiveName} gefunden, überspringe`);
      return 0;
    }

    const inspectedArchiveItems = archiveItems
      .map((item) => ({ item, state: inspectPackageItemDiskState(pkg, item) }));
    const corruptArchiveItems = inspectedArchiveItems
      .filter(({ state }) => state.reason !== "ok");

    if (corruptArchiveItems.length === 0) {
      // All files have the expected size on disk.  This can mean either:
      //   (a) content is corrupt despite correct size (network corruption), or
      //   (b) archive is valid but password is wrong (e.g. header-encrypted RAR).
      // Check the RAR magic bytes of the first part to distinguish:
      //   valid signature → password issue → don't waste traffic re-downloading.
      //   invalid signature → genuine corruption → force re-download.
      const firstPart = inspectedArchiveItems.find(({ state }) => state.diskPath);
      let hasValidSignature = false;
      if (firstPart?.state.diskPath) {
        try {
          const fd = fs.openSync(firstPart.state.diskPath, "r");
          try {
            const header = Buffer.alloc(8);
            fs.readSync(fd, header, 0, 8, 0);
            // RAR4: 52 61 72 21 1a 07 00, RAR5: 52 61 72 21 1a 07 01 00
            // 7z:   37 7a bc af 27 1c, ZIP: 50 4b 03 04
            hasValidSignature =
              (header[0] === 0x52 && header[1] === 0x61 && header[2] === 0x72 && header[3] === 0x21 && header[4] === 0x1a && header[5] === 0x07) ||
              (header[0] === 0x37 && header[1] === 0x7a && header[2] === 0xbc && header[3] === 0xaf) ||
              (header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04);
          } finally {
            fs.closeSync(fd);
          }
        } catch { /* can't read → treat as corrupt */ }
      }

      if (hasValidSignature) {
        logger.warn(
          `Auto-Recovery (${scope}): ${failure.archiveName} uebersprungen - ` +
          `Dateien haben korrekte Groesse und gueltige Archiv-Signatur, ` +
          `wahrscheinlicher Passwort-/Extractor-Fall statt defektem Download`
        );
        return 0;
      }

      logger.warn(
        `Auto-Recovery (${scope}): ${failure.archiveName} - Dateien korrekte Groesse aber ungueltige Archiv-Signatur, ` +
        `erzwinge Re-Download aller ${archiveItems.length} Parts`
      );
      corruptArchiveItems.push(...inspectedArchiveItems);
    }

    const queuedAt = nowMs();
    const reason = "Wartet (Auto-Recovery: Archiv beschädigt/unvollständig)";
    let changed = 0;
    for (const { item } of corruptArchiveItems) {
      const claimedTargetPath = String(item.targetPath || "").trim();
      if (claimedTargetPath) {
        try {
          fs.rmSync(claimedTargetPath, { force: true });
        } catch {
          // ignore; claim is still released so a fresh path can be chosen if needed
        }
      }
      this.releaseTargetPath(item.id);
      this.dropItemContribution(item.id);
      item.targetPath = "";
      item.status = "queued";
      item.attempts = 0;
      item.downloadedBytes = 0;
      item.progressPercent = 0;
      item.speedBps = 0;
      item.lastError = failure.errorText;
      item.fullStatus = reason;
      item.updatedAt = queuedAt;
      changed += 1;
    }

    if (changed > 0) {
      this.clearHybridArchiveState(pkg.id);
      pkg.status = (pkg.enabled && this.session.running && !this.session.paused) ? "downloading" : "queued";
      pkg.updatedAt = queuedAt;
      const evidence = corruptArchiveItems
        .slice(0, 3)
        .map(({ item, state }) => `${item.fileName}:${state.reason}`)
        .join(", ");
      const suffix = corruptArchiveItems.length > 3 ? ` (+${corruptArchiveItems.length - 3} weitere)` : "";
      logger.warn(
        `Auto-Recovery (${scope}): ${failure.archiveName} auf queued gesetzt (${changed} Items), ` +
        `evidence=${evidence}${suffix}, cause=${compactErrorText(failure.jvmFailureReason || failure.errorText)}`
      );
      this.persistSoon();
      this.emitState();
    }
    return changed;
  }

  private applyPackageExtractFailureStatuses(
    completedItems: DownloadItem[],
    resolveArchiveItems: (archiveName: string) => DownloadItem[],
    failedArchiveErrors: Map<string, string>,
    fallbackReason: string,
    previousStatuses: Map<string, string>,
    appliedAt = nowMs()
  ): void {
    const affectedItemIds = new Set<string>();

    for (const [archiveName, errorText] of failedArchiveErrors.entries()) {
      const reason = compactErrorText(errorText || fallbackReason || "Entpacken fehlgeschlagen");
      for (const entry of resolveArchiveItems(archiveName)) {
        if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) {
          continue;
        }
        entry.fullStatus = formatExtractFailureLabel(reason, archiveName);
        entry.updatedAt = appliedAt;
        affectedItemIds.add(entry.id);
      }
    }

    let appliedSpecificFailure = affectedItemIds.size > 0;
    for (const entry of completedItems) {
      if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) {
        continue;
      }
      if (affectedItemIds.has(entry.id)) {
        continue;
      }

      const currentStatus = String(entry.fullStatus || "").trim();
      if (currentStatus === "Entpacken - Error") {
        entry.fullStatus = formatExtractFailureLabel(fallbackReason);
        entry.updatedAt = appliedAt;
        appliedSpecificFailure = true;
        continue;
      }

      if (isTransientExtractStatus(currentStatus)) {
        const previousStatus = String(previousStatuses.get(entry.id) || "").trim();
        entry.fullStatus = isTransientExtractStatus(previousStatus)
          ? `Fertig (${humanSize(entry.downloadedBytes)})`
          : previousStatus || `Fertig (${humanSize(entry.downloadedBytes)})`;
        entry.updatedAt = appliedAt;
      }
    }

    if (appliedSpecificFailure) {
      return;
    }

    for (const entry of completedItems) {
      if (entry.status === "completed" && !isExtractedLabel(entry.fullStatus)) {
        entry.fullStatus = formatExtractFailureLabel(fallbackReason);
        entry.updatedAt = appliedAt;
      }
    }
  }

  /**
   * Detect and fix obfuscated archive filenames after download.
   * Some hosters mutate filenames (e.g. `.part06.rar` → `.part06.mov`) and
   * inject typos into the stem to prevent automated extraction.
   * This method reads magic bytes of non-archive files and renames them back
   * to their correct archive extension, using correctly-named siblings as a
   * reference for the base filename.
   */
  private async deobfuscateArchiveFiles(
    pkg: PackageEntry,
    completedItems: DownloadItem[],
    signal?: AbortSignal
  ): Promise<number> {
    const KNOWN_ARCHIVE_EXTS = new Set([
      ".rar", ".zip", ".7z", ".gz", ".bz2", ".xz", ".tgz", ".tbz2", ".txz",
      ".tar", ".001", ".002", ".003", ".004", ".005", ".006", ".007", ".008", ".009",
    ]);
    // Also treat .r00-.r99 as known archive extensions
    const isArchiveExt = (ext: string): boolean => {
      const lower = ext.toLowerCase();
      if (KNOWN_ARCHIVE_EXTS.has(lower)) return true;
      if (/^\.r\d{2}$/.test(lower)) return true;
      if (/^\.part\d+\.rar$/.test(lower)) return true;
      return false;
    };

    // Map items by their target path (lowercased for case-insensitive lookup)
    const itemByPath = new Map<string, DownloadItem>();
    for (const item of completedItems) {
      if (item.targetPath) {
        itemByPath.set(item.targetPath.toLowerCase(), item);
      }
    }

    // Collect reference RAR files (correctly named) and suspect files
    const referenceRars: string[] = [];
    const suspectFiles: Array<{ item: DownloadItem; filePath: string }> = [];

    for (const item of completedItems) {
      if (!item.targetPath || !item.fileName) continue;
      if (signal?.aborted) return 0;
      const ext = path.extname(item.fileName).toLowerCase();
      // Check for double extension like .part01.rar
      const doubleExt = item.fileName.match(/(\.\w+\.\w+)$/)?.[1]?.toLowerCase() || "";
      if (isArchiveExt(ext) || isArchiveExt(doubleExt)) {
        if (ext === ".rar") {
          referenceRars.push(item.targetPath);
        }
        continue;
      }
      // Non-archive extension — suspect
      suspectFiles.push({ item, filePath: item.targetPath });
    }

    if (suspectFiles.length === 0) return 0;

    // Extract base pattern from reference RAR files
    // e.g. "tvs-star_crossed-dd51-ded-dl-7p-nfhd-x264-104" from "tvs-star_crossed-...part01.rar"
    let referenceBase = "";
    const partBaseRe = /^(.+?)\.part\d{1,3}\.rar$/i;
    for (const rarPath of referenceRars) {
      const match = path.basename(rarPath).match(partBaseRe);
      if (match) {
        referenceBase = match[1];
        break;
      }
    }

    let fixedCount = 0;
    const SIG_TO_EXT: Record<string, string> = { rar: ".rar", "7z": ".7z", zip: ".zip" };

    for (const { item, filePath } of suspectFiles) {
      if (signal?.aborted) break;
      try {
        const exists = await fs.promises.stat(filePath).then(() => true, () => false);
        if (!exists) continue;

        const sig = await detectArchiveSignature(filePath);
        if (!sig || !SIG_TO_EXT[sig]) continue;

        const correctExt = SIG_TO_EXT[sig];
        const oldName = path.basename(filePath);
        let newName: string;

        // Try to extract part number from the obfuscated filename
        const partMatch = oldName.match(/[._-](?:[a-z]*?)part(\d{1,3})\b/i)
          || oldName.match(/[._-]r?part(\d{1,3})\b/i);
        const partNum = partMatch?.[1];

        if (referenceBase && partNum) {
          // Reconstruct correct filename from reference base + part number
          const paddedPart = partNum.padStart(2, "0");
          newName = `${referenceBase}.part${paddedPart}${correctExt}`;
        } else {
          // No reference available — just fix the extension
          const stem = oldName.replace(/\.[^.]+$/, "");
          newName = `${stem}${correctExt}`;
        }

        if (newName === oldName) continue;

        const newPath = path.join(path.dirname(filePath), newName);
        // Don't overwrite existing files
        const targetExists = await fs.promises.stat(newPath).then(() => true, () => false);
        if (targetExists) {
          logger.warn(`Deobfuskation: Ziel existiert bereits, ueberspringe: ${newPath}`);
          continue;
        }

        await fs.promises.rename(filePath, newPath);
        this.logVerifiedRenameSync("deobfuskation", filePath, newPath, { paket: pkg.name, signatur: sig });
        item.fileName = newName;
        item.targetPath = newPath;
        // Update the path lookup
        this.releaseTargetPath(item.id);
        this.claimTargetPath(item.id, newPath);
        fixedCount += 1;
        logger.info(`Deobfuskation: ${oldName} -> ${newName} (${sig} erkannt)`);
        this.logPackageForPackage(pkg, "INFO", "Archiv-Deobfuskation", {
          oldName,
          newName,
          signature: sig
        });
      } catch (err) {
        logDesktopRename("ERROR", "deobfuskation: Rename fehlgeschlagen", {
          source: path.basename(filePath),
          paket: pkg.name,
          error: compactErrorText(err as Error)
        });
        logger.warn(`Deobfuskation fehlgeschlagen: ${filePath}: ${compactErrorText(err as Error)}`);
      }
    }

    if (fixedCount > 0) {
      logger.info(`Deobfuskation abgeschlossen: pkg=${pkg.name}, ${fixedCount} Datei(en) korrigiert`);
      this.persistSoon();
      this.emitState();
    }
    return fixedCount;
  }

  private async waitForCompletedArchiveFilesToSettle(
    pkg: PackageEntry,
    items: DownloadItem[],
    signal: AbortSignal | undefined,
    scope: "hybrid" | "full"
  ): Promise<void> {
    const archiveItems = items.filter((item) =>
      item.status === "completed" && isArchiveLikePath(item.targetPath || item.fileName || "")
    );
    if (archiveItems.length === 0) {
      return;
    }

    const startedAt = nowMs();
    const newestCompletionAt = archiveItems.reduce((maxTs, item) => Math.max(maxTs, Number(item.updatedAt || 0)), 0);
    const minDelayMs = newestCompletionAt > 0
      ? Math.max(0, ARCHIVE_SETTLE_MIN_DELAY_MS - Math.max(0, startedAt - newestCompletionAt))
      : 0;

    if (minDelayMs > 0) {
      logger.info(
        `Extract-Settle (${scope}): warte ${minDelayMs}ms nach letztem Downloadabschluss ` +
        `vor Entpacken: pkg=${pkg.name}, archiveItems=${archiveItems.length}`
      );
      this.logPackageForPackage(pkg, "INFO", "Archiv-Stabilisierung wartet", {
        scope,
        waitMs: minDelayMs,
        archiveItems: archiveItems.length,
        reason: "recent_completion"
      });
      pkg.postProcessLabel = "Archive stabilisieren...";
      this.emitState();
      let remainingMs = minDelayMs;
      while (remainingMs > 0) {
        if (signal?.aborted) {
          return;
        }
        const sleepMs = Math.min(ARCHIVE_SETTLE_POLL_MS, remainingMs);
        await sleep(sleepMs);
        remainingMs -= sleepMs;
      }
    }

    const deadlineAt = nowMs() + ARCHIVE_SETTLE_MAX_WAIT_MS;
    const requiredStableRounds = minDelayMs > 0 ? 2 : 1;
    let stableRounds = 0;
    let lastSnapshot = "";
    let pollCount = 0;
    let lastPending = "";

    while (stableRounds < requiredStableRounds && nowMs() < deadlineAt) {
      if (signal?.aborted) {
        return;
      }

      const snapshotParts: string[] = [];
      const pending: string[] = [];
      for (const item of archiveItems) {
        const state = inspectPackageItemDiskState(pkg, item);
        const label = item.fileName || item.id;
        snapshotParts.push(`${item.id}:${state.reason}:${state.size}`);
        if (state.reason !== "ok" || !state.diskPath) {
          pending.push(`${label}:${state.reason}`);
          continue;
        }
        try {
          const fd = await fs.promises.open(state.diskPath, "r");
          await fd.close();
        } catch {
          pending.push(`${label}:open_failed`);
        }
      }

      pollCount += 1;
      lastPending = pending.join(", ");
      const snapshot = snapshotParts.join("|");
      if (pending.length === 0) {
        stableRounds = snapshot === lastSnapshot ? stableRounds + 1 : 1;
      } else {
        stableRounds = 0;
      }
      lastSnapshot = snapshot;

      if (stableRounds >= requiredStableRounds) {
        break;
      }

      await sleep(ARCHIVE_SETTLE_POLL_MS);
    }

    const settleMs = nowMs() - startedAt;
    if (stableRounds >= requiredStableRounds) {
      if (pollCount > 1 || minDelayMs > 0) {
        logger.info(
          `Extract-Settle (${scope}) abgeschlossen: pkg=${pkg.name}, archiveItems=${archiveItems.length}, ` +
          `waitMs=${settleMs}, polls=${pollCount}`
        );
        this.logPackageForPackage(pkg, "INFO", "Archiv-Stabilisierung abgeschlossen", {
          scope,
          archiveItems: archiveItems.length,
          waitMs: settleMs,
          polls: pollCount
        });
      }
      return;
    }

    logger.warn(
      `Extract-Settle (${scope}) Timeout: pkg=${pkg.name}, archiveItems=${archiveItems.length}, ` +
      `waitMs=${settleMs}, pending=${lastPending || "none"}`
    );
    this.logPackageForPackage(pkg, "WARN", "Archiv-Stabilisierung Timeout", {
      scope,
      archiveItems: archiveItems.length,
      waitMs: settleMs,
      pending: lastPending || "none"
    });
  }

  /** Detect items whose targetPath has a " (N)" suffix from a previous bug and rename
   *  them back to the original filename if the original path is not claimed by another item. */
  private fixDuplicateSuffixFiles(): void {
    const SUFFIX_RE = /^(.+) \(\d+\)(\.[^.]+)$/;
    let fixed = 0;
    for (const item of Object.values(this.session.items)) {
      const tp = String(item.targetPath || "").trim();
      if (!tp) continue;
      const parsed = path.parse(tp);
      const fullName = parsed.name + parsed.ext; // e.g. "file.part3 (1).rar"
      const match = SUFFIX_RE.exec(fullName);
      if (!match) continue;
      const originalName = match[1] + match[2]; // "file.part3.rar"
      const originalPath = path.join(parsed.dir, originalName);
      const originalKey = pathKey(originalPath);
      const originalOwner = this.reservedTargetPaths.get(originalKey);
      // Only rename if original path is not claimed by another item and doesn't exist on disk
      if (originalOwner && originalOwner !== item.id) continue;
      if (!originalOwner && fs.existsSync(originalPath)) continue;
      if (!fs.existsSync(tp)) {
        // File with (N) doesn't exist either — just fix the path reference
        this.reservedTargetPaths.delete(pathKey(tp));
        this.reservedTargetPaths.set(originalKey, item.id);
        this.claimedTargetPathByItem.set(item.id, originalPath);
        item.targetPath = originalPath;
        item.fileName = originalName;
        fixed += 1;
        continue;
      }
      try {
        fs.renameSync(tp, originalPath);
        this.logVerifiedRenameSync("suffix-fix", tp, originalPath);
        this.reservedTargetPaths.delete(pathKey(tp));
        this.reservedTargetPaths.set(originalKey, item.id);
        this.claimedTargetPathByItem.set(item.id, originalPath);
        item.targetPath = originalPath;
        item.fileName = originalName;
        fixed += 1;
        logger.info(`fixDuplicateSuffix: ${path.basename(tp)} → ${originalName}`);
      } catch (err) {
        logDesktopRename("ERROR", "suffix-fix: Rename fehlgeschlagen", {
          source: path.basename(tp),
          target: originalName,
          error: compactErrorText(err)
        });
        logger.warn(`fixDuplicateSuffix: Umbenennung fehlgeschlagen ${tp}: ${compactErrorText(err)}`);
      }
    }
    if (fixed > 0) {
      logger.info(`fixDuplicateSuffixFiles: ${fixed} Dateien korrigiert`);
      this.persistSoon();
    }
  }

  private assignItemTargetPath(item: DownloadItem, targetPath: string): string {
    const rawTargetPath = String(targetPath || "").trim();
    if (!rawTargetPath) {
      this.releaseTargetPath(item.id);
      item.targetPath = "";
      return "";
    }
    const normalizedTargetPath = path.resolve(rawTargetPath);
    const claimed = this.claimTargetPath(item.id, normalizedTargetPath);
    item.targetPath = claimed;
    return claimed;
  }

  private abortPostProcessing(reason: string): void {
    for (const [packageId, controller] of this.packagePostProcessAbortControllers.entries()) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }

      const pkg = this.session.packages[packageId];
      if (!pkg) {
        continue;
      }

      if (pkg.status === "extracting" || pkg.status === "integrity_check") {
        pkg.status = (pkg.enabled && !this.session.paused) ? "queued" : "paused";
        pkg.updatedAt = nowMs();
      }

      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item || item.status !== "completed") {
          continue;
        }
        const ft = (item.fullStatus || "").trim();
        if (/^Entpacken/i.test(ft)) {
          // Only mark items with active extraction progress as "abgebrochen".
          // Items that were just pending ("Ausstehend", "Warten auf Parts") weren't
          // actively being extracted, so keep their label as-is.
          if (ft !== "Entpacken - Ausstehend" && ft !== "Entpacken - Warten auf Parts") {
            item.fullStatus = "Entpacken abgebrochen (wird fortgesetzt)";
            item.updatedAt = nowMs();
          }
        }
      }
    }

    // H1: Globaler Stop/Shutdown/clearAll/external muss AUCH das Deferred-Post-
    // Processing (MKV-Move, Cleanup, Rename) und die Hybrid-Promises abbrechen,
    // sonst rasen FS-Operationen gegen den Shutdown-Save und schreiben halbe
    // Verschiebungen / löschen halbe Archive. Per-Package wird das von
    // abortPackagePostProcessing erledigt — hier der globale Sweep.
    for (const controller of this.packageDeferredPostProcessAbortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
    for (const hybridSet of this.packageHybridPostProcessControllers.values()) {
      for (const controller of hybridSet) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      }
    }
  }

  private async acquirePostProcessSlot(packageId: string): Promise<void> {
    // Honor the user-facing "Parallele Entpackungen" setting for package-level
    // post-processing so multiple episodes/packages can extract concurrently.
    const maxConcurrent = Math.max(1, Math.min(8, this.settings.maxParallelExtract || 1));
    if (this.packagePostProcessActive < maxConcurrent) {
      this.packagePostProcessActive += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.packagePostProcessWaiters.push({ packageId, resolve });
    });
    // Guard: stop() may have reset the counter to 0 while we were waiting.
    // Only increment if below max to avoid phantom slot usage.
    if (this.packagePostProcessActive < maxConcurrent) {
      this.packagePostProcessActive += 1;
    }
  }

  private releasePostProcessSlot(): void {
    // Guard: stop() resets active to 0, but old tasks (aborted waiters) still
    // call release in their finally blocks.  Without this guard, the counter
    // goes negative, letting multiple packages through on the next session.
    if (this.packagePostProcessActive <= 0) {
      this.packagePostProcessActive = 0;
      return;
    }
    this.packagePostProcessActive -= 1;
    if (this.packagePostProcessWaiters.length === 0) return;
    // Pick the waiter whose package appears earliest in packageOrder
    const order = this.session.packageOrder;
    let bestIdx = 0;
    let bestOrder = order.indexOf(this.packagePostProcessWaiters[0].packageId);
    if (bestOrder === -1) bestOrder = Infinity;
    for (let i = 1; i < this.packagePostProcessWaiters.length; i++) {
      let pos = order.indexOf(this.packagePostProcessWaiters[i].packageId);
      if (pos === -1) pos = Infinity;
      if (pos < bestOrder) {
        bestOrder = pos;
        bestIdx = i;
      }
    }
    const [next] = this.packagePostProcessWaiters.splice(bestIdx, 1);
    next.resolve();
  }

  private runPackagePostProcessing(packageId: string): Promise<void> {
    const existing = this.packagePostProcessTasks.get(packageId);
    if (existing) {
      this.hybridExtractRequeue.add(packageId);
      return existing;
    }

    const abortController = new AbortController();
    this.packagePostProcessAbortControllers.set(packageId, abortController);

    const task = (async () => {
      const slotWaitStart = nowMs();
      await this.acquirePostProcessSlot(packageId);
      const slotWaitMs = nowMs() - slotWaitStart;
      if (slotWaitMs > 100) {
        logger.info(`Post-Process Slot erhalten nach ${(slotWaitMs / 1000).toFixed(1)}s Wartezeit: pkg=${packageId.slice(0, 8)}`);
        const pkg = this.session.packages[packageId];
        if (pkg) {
          this.logPackageForPackage(pkg, "INFO", "Post-Process-Slot erhalten", {
            slotWaitMs
          });
        }
      }
      try {
        let round = 0;
        do {
          round += 1;
          const hadRequeue = this.hybridExtractRequeue.has(packageId);
          this.hybridExtractRequeue.delete(packageId);
          const roundStart = nowMs();
          try {
            await this.handlePackagePostProcessing(packageId, abortController.signal);
          } catch (error) {
            logger.warn(`Post-Processing für Paket fehlgeschlagen: ${compactErrorText(error)}`);
          }
          const roundMs = nowMs() - roundStart;
          logger.info(`Post-Process Runde ${round} fertig in ${(roundMs / 1000).toFixed(1)}s (requeue=${hadRequeue}, nextRequeue=${this.hybridExtractRequeue.has(packageId)}): pkg=${packageId.slice(0, 8)}`);
          const pkg = this.session.packages[packageId];
          if (pkg) {
            this.logPackageForPackage(pkg, "INFO", "Post-Process-Runde abgeschlossen", {
              round,
              roundMs,
              hadRequeue,
              nextRequeue: this.hybridExtractRequeue.has(packageId)
            });
          }
          this.persistSoon();
          this.emitState();
          // If this round was very fast (no extraction work, just a
          // findReadyArchiveSets scan), consume pending requeues and
          // exit the loop.  The next download completion will trigger a
          // fresh post-processing task.  This prevents dozens of no-op
          // rounds when many small archive parts complete in rapid
          // succession (e.g. 15-20 × 101 MB parts per episode).
          if (roundMs < 2000 && this.hybridExtractRequeue.has(packageId)) {
            if (this.shouldCollapseQuickPostProcessRequeue(packageId)) {
              this.hybridExtractRequeue.delete(packageId);
            }
          }
        } while (this.hybridExtractRequeue.has(packageId));
      } finally {
        this.releasePostProcessSlot();
        this.packagePostProcessTasks.delete(packageId);
        this.packagePostProcessAbortControllers.delete(packageId);
        this.persistSoon();
        this.emitState();
        // Fallback: if an item completed between the while-check and task
        // deletion, the requeue flag is still set — spawn a new task so it
        // is not lost.  The new task will acquire the slot normally.
        if (this.hybridExtractRequeue.delete(packageId)) {
          void this.runPackagePostProcessing(packageId).catch((err) =>
            logger.warn(`runPackagePostProcessing Fehler (hybridRequeue): ${compactErrorText(err)}`)
          );
        }
      }
    })();

    this.packagePostProcessTasks.set(packageId, task);
    return task;
  }

  private shouldRecoverDeferredPostProcessingOnStartup(pkg: PackageEntry, items: DownloadItem[]): boolean {
    if (!this.settings.autoExtract) {
      return false;
    }
    if (this.packagePostProcessTasks.has(pkg.id) || this.hasDeferredPostProcessPending(pkg.id)) {
      return false;
    }
    const hasExtractedCompletedItem = items.some((item) =>
      item.status === "completed" && isExtractedLabel(item.fullStatus || "")
    );
    if (!hasExtractedCompletedItem) {
      return false;
    }
    return this.settings.autoRename4sf4sj
      || this.settings.collectMkvToLibrary
      || this.settings.removeLinkFilesAfterExtract
      || this.settings.removeSamplesAfterExtract
      || this.settings.cleanupMode !== "none"
      || this.settings.completedCleanupPolicy === "package_done"
      || this.settings.completedCleanupPolicy === "immediate";
  }

  private recoverPostProcessingOnStartup(): void {
    const packageIds = [...this.session.packageOrder];
    if (packageIds.length === 0) {
      return;
    }

    let changed = false;
    for (const packageId of packageIds) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }

      const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
      if (items.length === 0) {
        continue;
      }

      const success = items.filter((item) => item.status === "completed").length;
      const failed = items.filter((item) => item.status === "failed").length;
      const cancelled = items.filter((item) => item.status === "cancelled").length;
      const allDone = this.areAllPackageItemRefsFinished(pkg);
      if (!allDone && success + failed + cancelled >= items.length) {
        logger.warn(
          `Post-Processing wartet trotz gefiltert fertiger Items: ` +
          `pkg=${pkg.name}, tracked=${pkg.itemIds.length}, resolved=${items.length}, ` +
          `success=${success}, failed=${failed}, cancelled=${cancelled}`
        );
      }

      // Hybrid extraction recovery: not all items done, but some completed
      // with pending extraction status → re-label and trigger post-processing
      // so extraction picks up where it left off.
      if (!allDone && this.settings.autoExtract && this.settings.hybridExtract && success > 0 && failed === 0) {
        const needsExtraction = items.some((item) => item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus));
        if (needsExtraction) {
          pkg.status = "queued";
          pkg.updatedAt = nowMs();
          for (const item of items) {
            if (item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus)) {
              if (!shouldPreserveExtractionResumeLabel(item.fullStatus)) {
                item.fullStatus = "Entpacken - Ausstehend";
              }
              item.updatedAt = nowMs();
            }
          }
          changed = true;
          // Don't trigger extraction here — it will be triggered when the
          // session starts via triggerPendingExtractions or item completions.
        }
      }

      if (!allDone) {
        continue;
      }

      if (this.settings.autoExtract && failed === 0 && success > 0) {
        const needsExtraction = items.some((item) => item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus));
        if (needsExtraction) {
          pkg.status = "queued";
          pkg.updatedAt = nowMs();
          for (const item of items) {
            if (item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus)) {
              if (!shouldPreserveExtractionResumeLabel(item.fullStatus)) {
                item.fullStatus = "Entpacken - Ausstehend";
              }
              item.updatedAt = nowMs();
            }
          }
          changed = true;
          void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (recoverPostProcessing): ${compactErrorText(err)}`));
        } else if (pkg.status !== "completed") {
          pkg.status = "completed";
          pkg.updatedAt = nowMs();
          changed = true;
        }
        if (!needsExtraction && this.shouldRecoverDeferredPostProcessingOnStartup(pkg, items)) {
          logger.info(`Deferred Post-Processing via Startup ausgelöst: pkg=${pkg.name}`);
          void this.runDeferredPostExtraction(packageId, pkg, success, failed, true, 0).catch((err) =>
            logger.warn(`runDeferredPostExtraction Fehler (recoverPostProcessing): ${compactErrorText(err)}`)
          );
        }
        continue;
      }

      const targetStatus = failed > 0
        ? "failed"
        : cancelled > 0
          ? (success > 0 ? "completed" : "cancelled")
          : "completed";
      if (pkg.status !== targetStatus) {
        pkg.status = targetStatus;
        pkg.updatedAt = nowMs();
        changed = true;
      }
      if (this.shouldRecoverDeferredPostProcessingOnStartup(pkg, items)) {
        logger.info(`Deferred Post-Processing via Startup ausgelöst: pkg=${pkg.name}`);
        void this.runDeferredPostExtraction(packageId, pkg, success, failed, true, 0).catch((err) =>
          logger.warn(`runDeferredPostExtraction Fehler (recoverPostProcessing): ${compactErrorText(err)}`)
        );
      }
    }

    if (changed) {
      this.persistSoon();
      this.emitState();
    }
  }

  private triggerPendingExtractions(): void {
    if (!this.settings.autoExtract) {
      return;
    }
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      if (this.packagePostProcessTasks.has(packageId)) {
        continue;
      }
      const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
      if (items.length === 0) {
        continue;
      }
      const success = items.filter((item) => item.status === "completed").length;
      const failed = items.filter((item) => item.status === "failed").length;
      const cancelled = items.filter((item) => item.status === "cancelled").length;
      const allDone = this.areAllPackageItemRefsFinished(pkg);
      if (!allDone && success + failed + cancelled >= items.length) {
        logger.warn(
          `Post-Processing wartet trotz gefiltert fertiger Items: ` +
          `pkg=${pkg.name}, tracked=${pkg.itemIds.length}, resolved=${items.length}, ` +
          `success=${success}, failed=${failed}, cancelled=${cancelled}`
        );
      }

      // Full extraction: all items done, no failures
      if (allDone && failed === 0 && success > 0) {
        const needsExtraction = items.some((item) =>
          item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus)
        );
        if (needsExtraction) {
          pkg.status = "queued";
          pkg.updatedAt = nowMs();
          for (const item of items) {
            if (item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus)) {
              item.fullStatus = "Entpacken - Ausstehend";
              item.updatedAt = nowMs();
            }
          }
          logger.info(`Entpacken via Start ausgelöst: pkg=${pkg.name}`);
          void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (triggerPending): ${compactErrorText(err)}`));
        }
        continue;
      }

      // Hybrid extraction: not all items done, but some completed and no failures
      if (!allDone && this.settings.hybridExtract && success > 0 && failed === 0) {
        const needsExtraction = items.some((item) =>
          item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus)
        );
        if (needsExtraction) {
          pkg.status = "queued";
          pkg.updatedAt = nowMs();
          for (const item of items) {
            if (item.status === "completed" && shouldAutoRetryExtraction(item.fullStatus)) {
              item.fullStatus = "Entpacken - Ausstehend";
              item.updatedAt = nowMs();
            }
          }
          logger.info(`Hybrid-Entpacken via Start ausgelöst: pkg=${pkg.name}, completed=${success}/${items.length}`);
          void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (triggerPendingHybrid): ${compactErrorText(err)}`));
        }
      }
    }
  }

  public retryExtraction(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) return;
    if (this.packagePostProcessTasks.has(packageId)) return;
    this.clearHybridArchiveState(packageId);
    const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
    const completedItems = items.filter((item) => item.status === "completed");
    const targetItems = completedItems.filter((item) => !isExtractedLabel(item.fullStatus));
    if (targetItems.length === 0) return;
    pkg.status = "queued";
    pkg.updatedAt = nowMs();
    for (const item of targetItems) {
      if (!isExtractedLabel(item.fullStatus)) {
        item.fullStatus = "Entpacken - Ausstehend";
        item.updatedAt = nowMs();
      }
    }
    logger.info(`Extraktion manuell wiederholt: pkg=${pkg.name}`);
    this.logPackageForPackage(pkg, "INFO", "Extraktion manuell wiederholt", {
      completedItems: completedItems.length,
      targetedItems: targetItems.length
    });
    this.persistSoon();
    this.emitState(true);
    void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (retryExtraction): ${compactErrorText(err)}`));
  }

  public extractNow(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg || pkg.cancelled) return;
    if (this.packagePostProcessTasks.has(packageId)) return;
    this.clearHybridArchiveState(packageId);
    if (!pkg.enabled) {
      pkg.enabled = true;
    }
    const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
    const completedItems = items.filter((item) => item.status === "completed");
    const targetItems = completedItems.filter((item) => !isExtractedLabel(item.fullStatus));
    if (targetItems.length === 0) return;
    pkg.status = "queued";
    pkg.updatedAt = nowMs();
    for (const item of targetItems) {
      item.fullStatus = "Entpacken - Ausstehend";
      item.updatedAt = nowMs();
    }
    logger.info(`Jetzt entpacken: pkg=${pkg.name}, completed=${completedItems.length}, targeted=${targetItems.length}`);
    this.logPackageForPackage(pkg, "INFO", "Jetzt entpacken ausgelöst", {
      completedItems: completedItems.length,
      targetedItems: targetItems.length
    });
    this.persistSoon();
    this.emitState(true);
    void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (extractNow): ${compactErrorText(err)}`));
  }

  private notePackageDownloadStarted(pkg: PackageEntry, startedAt = nowMs()): void {
    if ((pkg.downloadStartedAt || 0) <= 0) {
      pkg.downloadStartedAt = startedAt;
    }
  }

  private notePackageDownloadCompleted(pkg: PackageEntry, completedAt = nowMs()): void {
    this.notePackageDownloadStarted(pkg, completedAt);
    pkg.downloadCompletedAt = Math.max(pkg.downloadCompletedAt || 0, completedAt);
  }

  private getPackageHistoryDurationSeconds(pkg: PackageEntry): number {
    const startedAt = (pkg.downloadStartedAt || 0) > 0 ? (pkg.downloadStartedAt || 0) : pkg.createdAt;
    const finishedAtCandidate = (pkg.downloadCompletedAt || 0) > 0 ? (pkg.downloadCompletedAt || 0) : nowMs();
    const finishedAt = Math.max(startedAt || 0, finishedAtCandidate || 0);
    if (startedAt <= 0 || finishedAt <= 0) {
      return 1;
    }
    return Math.max(1, Math.floor((finishedAt - startedAt) / 1000));
  }

  private recordPackageHistory(packageId: string, pkg: PackageEntry, items: DownloadItem[]): void {
    if (!this.onHistoryEntryCallback || this.historyRecordedPackages.has(packageId)) {
      return;
    }
    const completedItems = items.filter(item => item.status === "completed");
    if (completedItems.length === 0) {
      return;
    }
    this.historyRecordedPackages.add(packageId);
    const totalBytes = completedItems.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
    const durationSeconds = this.getPackageHistoryDurationSeconds(pkg);
    const providers = new Set(completedItems.map(item => item.provider).filter(Boolean));
    const provider = providers.size === 1 ? [...providers][0] : null;
    const entry: HistoryEntry = {
      id: generateHistoryId(),
      name: pkg.name,
      totalBytes,
      downloadedBytes: totalBytes,
      fileCount: completedItems.length,
      provider,
      completedAt: nowMs(),
      durationSeconds,
      status: "completed",
      outputDir: pkg.outputDir,
      urls: completedItems.map(item => item.url).filter(Boolean),
    };
    this.onHistoryEntryCallback(entry);
  }

  private removePackageFromSession(packageId: string, itemIds: string[], reason: "completed" | "deleted" = "deleted"): void {
    const pkg = this.session.packages[packageId];
    if (pkg) {
      this.logPackageForPackage(pkg, "INFO", "Paket aus Session entfernt", {
        reason,
        removedItemCount: itemIds.length
      });
    }
    // Only create history here for deletions — completions are handled by recordPackageHistory
    if (pkg && this.onHistoryEntryCallback && reason === "deleted" && !this.historyRecordedPackages.has(packageId)) {
      const allItems = itemIds.map(id => this.session.items[id]).filter(Boolean) as DownloadItem[];
      const completedItems = allItems.filter(item => item.status === "completed");
      const completedCount = completedItems.length;
      if (completedCount > 0) {
        const totalBytes = completedItems.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
        const durationSeconds = this.getPackageHistoryDurationSeconds(pkg);
        const providers = new Set(completedItems.map(item => item.provider).filter(Boolean));
        const provider = providers.size === 1 ? [...providers][0] : null;
        const entry: HistoryEntry = {
          id: generateHistoryId(),
          name: pkg.name,
          totalBytes,
          downloadedBytes: totalBytes,
          fileCount: completedCount,
          provider,
          completedAt: nowMs(),
          durationSeconds,
          status: "deleted",
          outputDir: pkg.outputDir,
          urls: completedItems.map(item => item.url).filter(Boolean),
        };
        this.onHistoryEntryCallback(entry);
      }
    }
    this.historyRecordedPackages.delete(packageId);
    this.abortPackagePostProcessing(packageId, "package_removed");
    for (const itemId of itemIds) {
      this.retryAfterByItem.delete(itemId);
      this.retryStateByItem.delete(itemId);
      this.releaseTargetPath(itemId);
      this.dropItemContribution(itemId);
      delete this.session.items[itemId];
      this.itemCount = Math.max(0, this.itemCount - 1);
    }
    delete this.session.packages[packageId];
    this.session.packageOrder = this.session.packageOrder.filter((id) => id !== packageId);
    // Keep runPackageIds intact — ghost entries (deleted packages) are harmless:
    // findNextQueuedItem() won't find items for them, so the scheduler naturally
    // terminates via finishRun() which clears runPackageIds. Pruning them here
    // would make runPackageIds empty, disabling the "size > 0" filter guard and
    // causing "Start Selected" to continue with ALL packages after cleanup.
    this.runCompletedPackages.delete(packageId);
    this.resetSessionTotalsIfQueueEmpty();
  }

  // ── Provider Circuit Breaker ──────────────────────────────────────────

  private recordProviderFailure(provider: string): void {
    const key = String(provider || "").trim() || "unknown";
    const now = nowMs();
    const entry = this.providerFailures.get(key) || { count: 0, lastFailAt: 0, cooldownUntil: 0 };
    // Decay: if last failure was >120s ago, reset count (transient burst is over)
    if (entry.lastFailAt > 0 && now - entry.lastFailAt > 120000) {
      entry.count = 0;
    }
    // Debounce: simultaneous failures (within 2s) count as one failure
    // This prevents 8 parallel downloads failing at once from immediately hitting the threshold
    if (entry.lastFailAt > 0 && now - entry.lastFailAt < 2000) {
      entry.lastFailAt = now;
      this.providerFailures.set(key, entry);
      return;
    }
    entry.count += 1;
    entry.lastFailAt = now;
    // Escalating cooldown: 20 failures→30s, 35→60s, 50→120s, 80+→300s
    if (entry.count >= 20) {
      const tier = entry.count >= 80 ? 3 : entry.count >= 50 ? 2 : entry.count >= 35 ? 1 : 0;
      const cooldownMs = [30000, 60000, 120000, 300000][tier];
      entry.cooldownUntil = now + cooldownMs;
      logger.warn(`Provider Circuit-Breaker: ${key} ${entry.count} konsekutive Fehler, Cooldown ${cooldownMs / 1000}s`);
      // Invalidate mega-debrid session on cooldown to force fresh login
      if ((key === "megadebrid" || key === "megadebrid-api" || key === "megadebrid-web") && this.invalidateMegaSessionFn) {
        try {
          this.invalidateMegaSessionFn();
        } catch { /* ignore */ }
      }
    }
    this.providerFailures.set(key, entry);
  }

  private recordProviderSuccess(provider: string): void {
    const key = String(provider || "").trim() || "unknown";
    if (this.providerFailures.has(key)) {
      this.providerFailures.delete(key);
    }
  }

  private applyProviderBusyBackoff(provider: string, cooldownMs: number): void {
    const key = String(provider || "").trim() || "unknown";
    const now = nowMs();
    const entry = this.providerFailures.get(key) || { count: 0, lastFailAt: 0, cooldownUntil: 0 };
    entry.lastFailAt = now;
    entry.cooldownUntil = Math.max(entry.cooldownUntil, now + Math.max(0, Math.floor(cooldownMs)));
    this.providerFailures.set(key, entry);
  }

  private getProviderCooldownRemaining(provider: string): number {
    const key = String(provider || "").trim() || "unknown";
    const entry = this.providerFailures.get(key);
    if (!entry || entry.cooldownUntil <= 0) {
      return 0;
    }
    const remaining = entry.cooldownUntil - nowMs();
    if (remaining <= 0) {
      // Cooldown expired — reset count so a single new failure doesn't re-trigger
      entry.count = 0;
      entry.cooldownUntil = 0;
      return 0;
    }
    return remaining;
  }

  private ensureProviderDailyUsageFresh(now = nowMs(), persist = false): void {
    const currentDay = getProviderUsageDayKey(now);
    if (this.settings.providerDailyUsageDay === currentDay) {
      return;
    }
    this.settings.providerDailyUsageDay = currentDay;
    this.settings.providerDailyUsageBytes = {};
    this.settings.debridLinkApiKeyDailyUsageBytes = {};
    this.statsCache = null;
    this.statsCacheAt = 0;
    if (persist) {
      this.lastSettingsPersistAt = now;
      void saveSettingsAsync(this.storagePaths, this.settings).catch((err) => logger.warn(`saveSettingsAsync Fehler: ${compactErrorText(err as Error)}`));
    }
  }

  private recordProviderDownloadedBytes(provider: DownloadItem["provider"], byteDelta: number, providerAccountId?: string): void {
    if (!provider) {
      return;
    }
    const effectiveProvider = resolveMegaDebridProvider(this.settings, provider) || provider;
    const nextUsage = addProviderDailyUsageBytes(this.settings, effectiveProvider, byteDelta);
    const nextTotalUsage = addProviderTotalUsageBytes(this.settings, effectiveProvider, byteDelta);
    this.settings.providerDailyUsageDay = nextUsage.providerDailyUsageDay;
    this.settings.providerDailyUsageBytes = nextUsage.providerDailyUsageBytes;
    this.settings.providerTotalUsageBytes = nextTotalUsage.providerTotalUsageBytes;
    if (effectiveProvider === "debridlink" && providerAccountId) {
      const nextKeyUsage = addDebridLinkApiKeyDailyUsageBytes(this.settings, providerAccountId, byteDelta);
      const nextKeyTotalUsage = addDebridLinkApiKeyTotalUsageBytes(this.settings, providerAccountId, byteDelta);
      this.settings.providerDailyUsageDay = nextKeyUsage.providerDailyUsageDay;
      this.settings.debridLinkApiKeyDailyUsageBytes = nextKeyUsage.debridLinkApiKeyDailyUsageBytes;
      this.settings.debridLinkApiKeyTotalUsageBytes = nextKeyTotalUsage.debridLinkApiKeyTotalUsageBytes;
    }
    // Bug-Fix: Mega-Debrid Per-Account-Verbrauch wurde nie erfasst (nur Debrid-Link),
    // sodass die "Heute"/"Insgesamt"-Statistik pro Mega-Account immer 0 anzeigte.
    if ((effectiveProvider === "megadebrid-api" || effectiveProvider === "megadebrid-web") && providerAccountId) {
      const nextAcctUsage = addMegaDebridAccountDailyUsageBytes(this.settings, providerAccountId, byteDelta);
      const nextAcctTotalUsage = addMegaDebridAccountTotalUsageBytes(this.settings, providerAccountId, byteDelta);
      this.settings.providerDailyUsageDay = nextAcctUsage.providerDailyUsageDay;
      this.settings.megaDebridAccountDailyUsageBytes = nextAcctUsage.megaDebridAccountDailyUsageBytes;
      this.settings.megaDebridAccountTotalUsageBytes = nextAcctTotalUsage.megaDebridAccountTotalUsageBytes;
    }
  }

  private isProviderConfigured(provider: DebridProvider): boolean {
    this.ensureProviderDailyUsageFresh(nowMs());
    const effectiveProvider = resolveMegaDebridProvider(this.settings, provider) || provider;
    if ((this.settings.disabledProviders || []).includes(provider) || (this.settings.disabledProviders || []).includes(effectiveProvider)) {
      return false;
    }
    if (isProviderDailyLimitReached(this.settings, effectiveProvider)) {
      return false;
    }
    if (effectiveProvider === "realdebrid") {
      return Boolean(this.settings.realDebridUseWebLogin || this.settings.token.trim());
    }
    if (effectiveProvider === "megadebrid-api") {
      const hasMegaCreds = Boolean(this.settings.megaCredentials.trim() || (this.settings.megaLogin.trim() && this.settings.megaPassword.trim()));
      return Boolean(hasMegaCreds && (resolveMegaDebridProvider(this.settings, "megadebrid") === "megadebrid-api" || this.settings.megaDebridApiEnabled));
    }
    if (effectiveProvider === "megadebrid-web") {
      const hasMegaCreds = Boolean(this.settings.megaCredentials.trim() || (this.settings.megaLogin.trim() && this.settings.megaPassword.trim()));
      return Boolean(hasMegaCreds && (resolveMegaDebridProvider(this.settings, "megadebrid") === "megadebrid-web" || this.settings.megaDebridWebEnabled));
    }
    if (effectiveProvider === "bestdebrid") {
      return Boolean(this.settings.bestDebridUseWebLogin || this.settings.bestToken.trim());
    }
    if (effectiveProvider === "alldebrid") {
      return Boolean(this.settings.allDebridUseWebLogin || this.settings.allDebridToken.trim());
    }
    if (effectiveProvider === "ddownload") {
      return Boolean(this.settings.ddownloadLogin.trim() && this.settings.ddownloadPassword.trim());
    }
    if (effectiveProvider === "onefichier") {
      return Boolean(this.settings.oneFichierApiKey.trim());
    }
    if (effectiveProvider === "debridlink") {
      const configuredKeys = parseDebridLinkApiKeys(this.settings.debridLinkApiKeys);
      return configuredKeys.length > 0 && getAvailableDebridLinkApiKeys(this.settings).length > 0;
    }
    if (provider === "linksnappy") {
      return Boolean(this.settings.linkSnappyLogin.trim() && this.settings.linkSnappyPassword.trim());
    }
    return false;
  }

  private getProviderOrder(): DebridProvider[] {
    if (this.settings.providerOrder && this.settings.providerOrder.length > 0) {
      return [...this.settings.providerOrder];
    }
    return [
      this.settings.providerPrimary,
      this.settings.providerSecondary !== "none" ? this.settings.providerSecondary : null,
      this.settings.providerTertiary !== "none" ? this.settings.providerTertiary : null
    ].filter(Boolean) as DebridProvider[];
  }

  /** Returns the first configured provider from the order that is NOT in cooldown. */
  private findFallbackProviderNotInCooldown(item: DownloadItem): DebridProvider | null {
    const hosterKey = extractHosterKey(item.url);
    for (const provider of this.getProviderOrder()) {
      if (!this.isProviderConfigured(provider)) continue;
      const key = hosterKey && provider === "alldebrid" ? `${provider}:${hosterKey}` : provider;
      if (this.getProviderCooldownRemaining(key) === 0) return provider;
    }
    return null;
  }

  private getExpectedProviderForItem(item: DownloadItem): DebridProvider | null {
    if (item.provider) {
      const resolvedProvider = resolveMegaDebridProvider(this.settings, item.provider);
      if (resolvedProvider && this.isProviderConfigured(resolvedProvider)) {
        return resolvedProvider;
      }
    }

    const hosterKey = extractHosterKey(item.url);
    const routing = this.settings.hosterRouting || {};
    const routedProvider = hosterKey ? routing[hosterKey] : undefined;
    if (routedProvider && this.isProviderConfigured(routedProvider)) {
      return routedProvider;
    }

    const seen = new Set<DebridProvider>();
    for (const provider of this.getProviderOrder()) {
      if (seen.has(provider)) {
        continue;
      }
      seen.add(provider);
      if (this.isProviderConfigured(provider)) {
        return provider;
      }
    }

    return null;
  }

  private getProviderFailureKeyForItem(item: DownloadItem, providerOverride?: DebridProvider | string | null): string {
    const provider = String(providerOverride || item.provider || this.getExpectedProviderForItem(item) || "unknown").trim() || "unknown";
    const hosterKey = extractHosterKey(item.url);
    if (provider === "alldebrid" && hosterKey) {
      return `${provider}:${hosterKey}`;
    }
    return provider;
  }

  private getActiveTaskCountForFailureKey(failureKey: string, excludeItemId?: string): number {
    let count = 0;
    for (const active of this.activeTasks.values()) {
      if (excludeItemId && active.itemId === excludeItemId) {
        continue;
      }
      const activeItem = this.session.items[active.itemId];
      if (!activeItem) {
        continue;
      }
      if (this.getProviderFailureKeyForItem(activeItem) === failureKey) {
        count += 1;
      }
    }
    return count;
  }

  private getProviderActiveTaskCount(provider: DebridProvider): number {
    let count = 0;
    for (const active of this.activeTasks.values()) {
      const activeItem = this.session.items[active.itemId];
      if (!activeItem) {
        continue;
      }
      if (this.getExpectedProviderForItem(activeItem) === provider) {
        count += 1;
      }
    }
    return count;
  }

  private getPacedStartKeyForItem(item: DownloadItem): string | null {
    const provider = this.getExpectedProviderForItem(item);
    if (provider !== "alldebrid") {
      return null;
    }
    return provider;
  }

  private countFuturePacedStarts(paceKey: string, now: number, excludeItemId?: string): number {
    let count = 0;
    for (const [itemId, reservedAt] of this.pacedStartReservationByItem.entries()) {
      if (excludeItemId && itemId === excludeItemId) {
        continue;
      }
      if (reservedAt <= now) {
        continue;
      }
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      if (this.getPacedStartKeyForItem(item) !== paceKey) {
        continue;
      }
      if (item.status !== "queued" && item.status !== "reconnect_wait") {
        continue;
      }
      count += 1;
    }
    return count;
  }

  private getProviderValidatingTaskCount(provider: DebridProvider, excludeItemId?: string): number {
    let count = 0;
    for (const active of this.activeTasks.values()) {
      if (excludeItemId && active.itemId === excludeItemId) {
        continue;
      }
      const activeItem = this.session.items[active.itemId];
      if (!activeItem || activeItem.status !== "validating") {
        continue;
      }
      const expectedProvider = resolveMegaDebridProvider(this.settings, this.getExpectedProviderForItem(activeItem));
      if (expectedProvider === provider) {
        count += 1;
      }
    }
    return count;
  }

  private getSerializedValidatingLimit(provider: DebridProvider | null): number {
    if (provider === "megadebrid-web") {
      return 1;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private delayPacedStartForItem(item: DownloadItem, now: number): boolean {
    const paceKey = this.getPacedStartKeyForItem(item);
    if (!paceKey) {
      return false;
    }

    const existingReadyAt = this.retryAfterByItem.get(item.id) || 0;
    const existingPacedAt = this.pacedStartReservationByItem.get(item.id) || 0;
    if (existingPacedAt > 0 && existingPacedAt <= now) {
      this.pacedStartReservationByItem.delete(item.id);
      return false;
    }
    if (existingPacedAt > now) {
      const scheduledAt = Math.max(existingReadyAt, existingPacedAt);
      this.retryAfterByItem.set(item.id, scheduledAt);
      item.status = "queued";
      item.speedBps = 0;
      item.fullStatus = `AllDebrid Start in ${Math.max(1, Math.ceil((scheduledAt - now) / 1000))}s`;
      item.updatedAt = now;
      return true;
    }

    const failureKey = this.getProviderFailureKeyForItem(item, "alldebrid");
    const startLimit = this.getAllDebridStartLimit(extractHosterKey(item.url));
    const activeProviderTasks = this.activeTasks.size;
    const activeHosterTasks = this.getActiveTaskCountForFailureKey(failureKey);
    const futureReservations = this.countFuturePacedStarts(paceKey, now, item.id);
    const remainingGlobalSlots = Math.max(0, Math.max(1, Number(this.settings.maxParallel) || 1) - activeProviderTasks - futureReservations);
    const remainingHosterSlots = Number.isFinite(startLimit)
      ? Math.max(0, startLimit - activeHosterTasks - futureReservations)
      : Number.MAX_SAFE_INTEGER;
    const availableReservationSlots = Math.min(remainingGlobalSlots, remainingHosterSlots);
    if (availableReservationSlots <= 0) {
      this.pacedStartReservationByItem.delete(item.id);
      if ((item.fullStatus || "").startsWith("AllDebrid Start in ")) {
        item.fullStatus = "Wartet";
        item.updatedAt = now;
      }
      return true;
    }

    const scheduledAt = Math.max(existingReadyAt, now + ALLDEBRID_START_STAGGER_MS);
    if (scheduledAt <= now) {
      this.pacedStartReservationByItem.delete(item.id);
      return false;
    }
    this.retryAfterByItem.set(item.id, scheduledAt);
    this.pacedStartReservationByItem.set(item.id, scheduledAt);
    item.status = "queued";
    item.speedBps = 0;
    item.fullStatus = `AllDebrid Start in ${Math.max(1, Math.ceil((scheduledAt - now) / 1000))}s`;
    item.updatedAt = now;
    return true;
  }

  private notePacedStartForItem(item: DownloadItem, now: number): void {
    const paceKey = this.getPacedStartKeyForItem(item);
    if (!paceKey) {
      return;
    }

    const reservedAt = this.pacedStartReservationByItem.get(item.id) || 0;
    if (reservedAt > 0) {
      this.pacedStartReservationByItem.delete(item.id);
    }
    if (this.countFuturePacedStarts(paceKey, now) <= 0) {
      this.providerStartReservations.delete(paceKey);
    }
  }

  private getConfiguredAllDebridStartLimit(): number {
    const configured = Math.floor(Number(this.settings.maxParallel || 1));
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return 1;
  }

  private getAllDebridStartLimit(hosterKey: string): number {
    if (hosterKey !== "rapidgator") {
      return Number.MAX_SAFE_INTEGER;
    }
    const configuredLimit = this.getConfiguredAllDebridStartLimit();
    const cached = this.allDebridHostInfoCache.get(hosterKey);
    const apiLimit = cached?.info.limitSimuDl;
    if (Number.isFinite(apiLimit) && (apiLimit as number) > 0) {
      return Math.max(1, Math.min(configuredLimit, Math.floor(apiLimit as number)));
    }
    return configuredLimit;
  }

  private shouldDelayStartForItem(item: DownloadItem): boolean {
    const provider = resolveMegaDebridProvider(this.settings, this.getExpectedProviderForItem(item));
    const serializedValidatingLimit = this.getSerializedValidatingLimit(provider);
    if (provider && Number.isFinite(serializedValidatingLimit) && serializedValidatingLimit < Number.MAX_SAFE_INTEGER) {
      return this.getProviderValidatingTaskCount(provider, item.id) >= serializedValidatingLimit;
    }
    if (provider !== "alldebrid") {
      return false;
    }
    const hosterKey = extractHosterKey(item.url);
    if (hosterKey !== "rapidgator") {
      return false;
    }
    const failureKey = this.getProviderFailureKeyForItem(item, provider);
    const startLimit = this.getAllDebridStartLimit(hosterKey);
    return this.getActiveTaskCountForFailureKey(failureKey) >= startLimit;
  }

  private async getAllDebridHostInfoCached(hosterKey: string, signal?: AbortSignal, forceRefresh = false): Promise<AllDebridHostInfo | null> {
    const normalizedHost = String(hosterKey || "").trim().toLowerCase();
    if (!normalizedHost || this.settings.allDebridUseWebLogin) {
      return null;
    }
    const token = this.settings.allDebridToken.trim();
    if (!token) {
      return null;
    }

    const cached = this.allDebridHostInfoCache.get(normalizedHost);
    if (!forceRefresh && cached && nowMs() - cached.cachedAt <= ALLDEBRID_HOST_INFO_TTL_MS) {
      return cached.info;
    }

    try {
      const info = await fetchAllDebridHostInfo(token, normalizedHost, signal);
      this.allDebridHostInfoCache.set(normalizedHost, { info, cachedAt: nowMs() });
      return info;
    } catch (error) {
      const errorText = compactErrorText(error);
      logger.warn(`AllDebrid Host-Info Fehler für ${normalizedHost}: ${errorText}`);
      return cached?.info || null;
    }
  }

  private async maybeApplyAllDebridRapidgatorBackoff(item: DownloadItem, active: ActiveTask): Promise<boolean> {
    const provider = this.getExpectedProviderForItem(item);
    if (provider !== "alldebrid") {
      return false;
    }

    const hosterKey = extractHosterKey(item.url);
    if (hosterKey !== "rapidgator") {
      return false;
    }

    const failureKey = this.getProviderFailureKeyForItem(item, provider);
    const activePeers = this.getActiveTaskCountForFailureKey(failureKey, item.id);
    const info = await this.getAllDebridHostInfoCached(hosterKey, active.abortController.signal, activePeers <= 0);
    const startLimit = this.getAllDebridStartLimit(hosterKey);

    if (activePeers >= startLimit) {
      const delayMs = Math.min(45000, 5000 + activePeers * 3000);
      this.queueRetry(item, active, delayMs, `AllDebrid ${hosterKey}: Slot belegt (${activePeers}/${startLimit})`);
      return true;
    }

    if (!info) {
      return false;
    }

    if (info.state === "down") {
      const delayMs = 60000;
      this.applyProviderBusyBackoff(failureKey, delayMs);
      this.queueRetry(item, active, delayMs + 1000, `AllDebrid ${info.host}: ${info.statusLabel}`);
      return true;
    }

    if (info.limitSimuDl !== null && info.limitSimuDl <= 0) {
      const delayMs = 45000;
      this.applyProviderBusyBackoff(failureKey, delayMs);
      this.queueRetry(item, active, delayMs + 1000, `AllDebrid ${info.host}: keine freien Slots`);
      return true;
    }

    if (info.quota !== null && info.quota <= 0) {
      const delayMs = 120000;
      this.applyProviderBusyBackoff(failureKey, delayMs);
      this.queueRetry(item, active, delayMs + 1000, `AllDebrid ${info.host}: Quota aufgebraucht`);
      return true;
    }

    return false;
  }

  private resetStaleRetryState(): void {
    const now = nowMs();
    // Reset retry counters for items queued >10 min without progress
    for (const [itemId, retryState] of this.retryStateByItem) {
      const item = this.session.items[itemId];
      if (!item || item.status !== "queued") {
        continue;
      }
      if (this.activeTasks.has(itemId)) {
        continue;
      }
      const retryAfter = this.retryAfterByItem.get(itemId) || 0;
      if (retryAfter > now) {
        continue;
      }
      const staleMs = now - item.updatedAt;
      if (staleMs > 600000) {
        retryState.stallRetries = 0;
        retryState.unrestrictRetries = 0;
        retryState.genericErrorRetries = 0;
        retryState.freshRetryUsed = false;
        retryState.resumeHardResetUsed = false;
        logger.info(`Soft-Reset: Retry-Counter zurückgesetzt für ${item.fileName || itemId} (${Math.floor(staleMs / 60000)} min stale)`);
      }
    }
    // Reset provider failures older than 15 min
    for (const [provider, entry] of this.providerFailures) {
      if (now - entry.lastFailAt > 900000) {
        this.providerFailures.delete(provider);
        logger.info(`Soft-Reset: Provider-Failures zurückgesetzt für ${provider}`);
      }
    }
    // Prune AllDebrid host info cache entries older than 5 min (TTL is 60s,
    // so 5 min is well past usable - just unbounded growth otherwise).
    let allDebridPruned = 0;
    for (const [host, entry] of this.allDebridHostInfoCache) {
      if (now - entry.cachedAt > 5 * 60 * 1000) {
        this.allDebridHostInfoCache.delete(host);
        allDebridPruned += 1;
      }
    }
    // Prune expired Debrid-Link / Mega-Debrid runtime state (module-level Maps
    // that would otherwise grow over 24/7 operation).
    const dlPruned = pruneExpiredDebridLinkRuntimeState(now);
    const mdPruned = pruneExpiredMegaDebridRuntimeState(now);
    if (allDebridPruned > 0 || dlPruned > 0 || mdPruned > 0) {
      logger.info(`Soft-Reset: pruned ${allDebridPruned} AllDebrid host entries, ${dlPruned} Debrid-Link entries, ${mdPruned} Mega-Debrid entries`);
    }
  }

  // ── Scheduler ──────────────────────────────────────────────────────────

  private async ensureScheduler(): Promise<void> {
    if (this.scheduleRunning) {
      return;
    }
    this.scheduleRunning = true;
    const myGeneration = this.schedulerGeneration;
    logger.info(`Scheduler gestartet (gen=${myGeneration})`);
    try {
      while (this.session.running && this.schedulerGeneration === myGeneration) {
        const now = nowMs();
        if (now - this.lastSchedulerHeartbeatAt >= 60000) {
          this.lastSchedulerHeartbeatAt = now;
          logger.info(`Scheduler Heartbeat: active=${this.activeTasks.size}, queued=${this.countQueuedItems()}, reconnect=${this.reconnectActive()}, paused=${this.session.paused}, postProcess=${this.packagePostProcessTasks.size}`);
        }
        // Periodic soft-reset every 10 min: clear stale retry counters & provider failures
        if (now - this.lastStaleResetAt >= 600000) {
          this.lastStaleResetAt = now;
          this.resetStaleRetryState();
        }

        if (this.session.paused) {
          await sleep(120);
          continue;
        }

        if (this.reconnectActive()) {
          const markNow = nowMs();
          if (markNow - this.lastReconnectMarkAt >= 900) {
            this.lastReconnectMarkAt = markNow;
            const changed = this.markQueuedAsReconnectWait();
            if (!changed) {
              this.emitState();
            }
          }
          await sleep(220);
          continue;
        }

        while (this.activeTasks.size < Math.max(1, this.settings.maxParallel)) {
          const next = this.findNextQueuedItem();
          if (!next) {
            break;
          }
          this.startItem(next.packageId, next.itemId);
        }

        this.runGlobalStallWatchdog(now);

        // Single-pass queue presence check (saves one full O(n) iteration per tick)
        const queuePresence = this.activeTasks.size === 0 ? this.getQueuePresence(now) : { hasImmediate: true, hasDelayed: false };
        const downloadsComplete = this.activeTasks.size === 0 && !queuePresence.hasImmediate && !queuePresence.hasDelayed;
        const postProcessComplete = this.packagePostProcessTasks.size === 0 && !this.hasAnyDeferredPostProcessPending();
        if (downloadsComplete && (postProcessComplete || this.settings.autoExtractWhenStopped)) {
          this.finishRun();
          break;
        }

        const maxParallel = Math.max(1, this.settings.maxParallel);
        const schedulerSleepMs = this.activeTasks.size >= maxParallel ? 170 : 120;
        await sleep(schedulerSleepMs);
      }
    } finally {
      this.scheduleRunning = false;
      logger.info(`Scheduler beendet (gen=${myGeneration})`);
    }
  }

  private reconnectActive(): boolean {
    if (this.session.reconnectUntil <= 0) {
      return false;
    }
    const now = nowMs();
    // Safety: if reconnectUntil is unreasonably far in the future (clock regression),
    // clamp it to reconnectWaitSeconds * 2 from now
    const maxWaitMs = this.settings.reconnectWaitSeconds * 2 * 1000;
    if (this.session.reconnectUntil - now > maxWaitMs) {
      this.session.reconnectUntil = now + maxWaitMs;
    }
    return this.session.reconnectUntil > now;
  }

  private runGlobalStallWatchdog(now: number): void {
    const timeoutMs = getGlobalStallWatchdogTimeoutMs();
    if (timeoutMs <= 0) {
      return;
    }

    if (!this.session.running || this.session.paused || this.reconnectActive()) {
      this.lastGlobalProgressBytes = this.session.totalDownloadedBytes;
      this.lastGlobalProgressAt = now;
      return;
    }

    // Per-item validating watchdog: abort items stuck longer than the unrestrict timeout + buffer
    const VALIDATING_STUCK_MS = getUnrestrictTimeoutMs() + 15000;
    for (const active of this.activeTasks.values()) {
      if (active.abortController.signal.aborted) {
        continue;
      }
      const item = this.session.items[active.itemId];
      if (!item || item.status !== "validating") {
        continue;
      }
      const ageMs = item.updatedAt > 0 ? now - item.updatedAt : 0;
      if (ageMs > VALIDATING_STUCK_MS) {
        logger.warn(`Validating-Stuck erkannt: item=${item.fileName || active.itemId}, ${Math.floor(ageMs / 1000)}s ohne Fortschritt`);
        active.abortReason = "stall";
        active.abortController.abort("stall");
      }
    }

    if (this.session.totalDownloadedBytes !== this.lastGlobalProgressBytes) {
      this.lastGlobalProgressBytes = this.session.totalDownloadedBytes;
      this.lastGlobalProgressAt = now;
      return;
    }

    if (now - this.lastGlobalProgressAt < timeoutMs) {
      return;
    }

    // Only items that are actually DOWNLOADING (have an open HTTP body that
    // should be making progress) count toward the global stall watchdog.
    // Items in "validating" are still in the unrestrict phase — they're handled
    // by the per-item validating watchdog above (VALIDATING_STUCK_MS) which
    // gives the multi-account/multi-key rotation enough time. Without this
    // exclusion the global watchdog would abort the unrestrict mid-rotation
    // (e.g. account 3 of 3 still being tested) just because no bytes had been
    // downloaded recently — which is correct, since unrestrict doesn't
    // produce download bytes.
    let stalledCount = 0;
    let diskBlockedCount = 0;
    for (const active of this.activeTasks.values()) {
      if (active.abortController.signal.aborted) {
        continue;
      }
      if (active.blockedOnDiskWrite) {
        diskBlockedCount += 1;
        continue;
      }
      const item = this.session.items[active.itemId];
      if (item && item.status === "downloading") {
        stalledCount += 1;
      }
    }
    if (stalledCount === 0) {
      this.lastGlobalProgressAt = now;
      return;
    }

    logger.warn(`Globaler Download-Stall erkannt (${Math.floor((now - this.lastGlobalProgressAt) / 1000)}s ohne Fortschritt), ${stalledCount} Task(s) neu starten, diskBlocked=${diskBlockedCount}`);
    for (const active of this.activeTasks.values()) {
      if (active.abortController.signal.aborted) {
        continue;
      }
      if (active.blockedOnDiskWrite) {
        continue;
      }
      const item = this.session.items[active.itemId];
      if (item && item.status === "downloading") {
        active.abortReason = "stall";
        active.abortController.abort("stall");
      }
    }
    this.lastGlobalProgressAt = now;
  }

  private requestReconnect(reason: string): void {
    if (!this.settings.autoReconnect) {
      return;
    }

    // Only increment when not already inside an active reconnect window to avoid
    // inflating the backoff counter when multiple parallel downloads hit 429/503.
    if (this.session.reconnectUntil <= nowMs()) {
      this.consecutiveReconnects += 1;
    }
    const backoffMultiplier = Math.min(this.consecutiveReconnects, 5);
    const waitMs = this.settings.reconnectWaitSeconds * 1000 * backoffMultiplier;
    const maxWaitMs = this.settings.reconnectWaitSeconds * 2 * 1000;
    const cappedWaitMs = Math.min(waitMs, maxWaitMs);
    const until = nowMs() + cappedWaitMs;
    this.session.reconnectUntil = Math.max(this.session.reconnectUntil, until);
    // Safety cap: never let reconnectUntil exceed reconnectWaitSeconds * 2 from now
    const absoluteMax = nowMs() + maxWaitMs;
    if (this.session.reconnectUntil > absoluteMax) {
      this.session.reconnectUntil = absoluteMax;
    }
    this.session.reconnectReason = reason;
    this.lastReconnectMarkAt = 0;

    for (const active of this.activeTasks.values()) {
      active.abortReason = "reconnect";
      active.abortController.abort("reconnect");
    }

    logger.warn(`Reconnect angefordert: ${reason} (consecutive=${this.consecutiveReconnects}, wait=${Math.ceil(cappedWaitMs / 1000)}s)`);
    this.emitState();
  }

  private markQueuedAsReconnectWait(): boolean {
    let changed = false;
    const waitSeconds = Math.max(0, Math.ceil((this.session.reconnectUntil - nowMs()) / 1000));
    const waitText = `Reconnect-Wait (${waitSeconds}s)`;
    // Iterate without allocating an Object.keys() array (called every 900ms
    // during reconnect; with 5000+ items that's a 5000-string allocation per tick).
    const updateItem = (itemId: string): void => {
      const item = this.session.items[itemId];
      if (!item) return;
      const pkg = this.session.packages[item.packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) return;
      if (item.status === "queued") {
        item.status = "reconnect_wait";
        item.fullStatus = waitText;
        item.updatedAt = nowMs();
        changed = true;
      }
    };
    if (this.runItemIds.size > 0) {
      for (const itemId of this.runItemIds) updateItem(itemId);
    } else {
      // for-in iterates own enumerable string keys without allocating an array
      for (const itemId in this.session.items) updateItem(itemId);
    }
    if (changed) {
      this.emitState();
    }
    return changed;
  }

  private findNextQueuedItem(): { packageId: string; itemId: string } | null {
    const now = nowMs();
    // Single-pass priority selection: instead of iterating all packages 3 times
    // (once per priority tier), iterate once and remember the best
    // normal/low candidate found. "high" priority returns immediately. This
    // saves up to 2x O(n) passes per scheduler tick on large queues where
    // most packages have the default "normal" priority.
    let normalCandidate: { packageId: string; itemId: string } | null = null;
    let lowCandidate: { packageId: string; itemId: string } | null = null;

    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) continue;
      if (this.runPackageIds.size > 0 && !this.runPackageIds.has(packageId)) continue;
      const pkgPrio = pkg.priority || "normal";
      // Once we've found a normal candidate we don't need to scan low-priority
      // packages anymore — they would lose anyway.
      if (normalCandidate && pkgPrio === "low") continue;
      // If we already have a normal candidate and this package is also normal,
      // keep scanning anyway (we still need to check if it has a startable
      // item — but the first one wins, this is just for correctness).
      if (normalCandidate && pkgPrio === "normal") continue;

      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) continue;
        const retryAfter = this.retryAfterByItem.get(itemId) || 0;
        if (retryAfter > now) continue;
        if (item.status !== "queued" && item.status !== "reconnect_wait") continue;
        if (this.delayPacedStartForItem(item, now)) continue;
        if (this.shouldDelayStartForItem(item)) continue;

        const candidate = { packageId, itemId };
        if (pkgPrio === "high") {
          if (retryAfter > 0) this.retryAfterByItem.delete(itemId);
          return candidate; // highest priority — return immediately
        }
        if (pkgPrio === "normal") {
          normalCandidate = candidate;
        } else if (!lowCandidate) {
          lowCandidate = candidate;
        }
        break; // stop scanning items in this package
      }
    }

    const chosen = normalCandidate || lowCandidate;
    if (chosen) {
      const retryAfter = this.retryAfterByItem.get(chosen.itemId) || 0;
      if (retryAfter > 0) this.retryAfterByItem.delete(chosen.itemId);
    }
    return chosen;
  }

  /** Single-pass alternative to hasQueuedItems + hasDelayedQueuedItems.
   *  Returns both flags so the scheduler termination check needs only ONE
   *  iteration over packages/items per tick instead of two separate scans. */
  private getQueuePresence(now = nowMs()): { hasImmediate: boolean; hasDelayed: boolean } {
    let hasImmediate = false;
    let hasDelayed = false;
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) continue;
      if (this.runPackageIds.size > 0 && !this.runPackageIds.has(packageId)) continue;
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) continue;
        if (item.status !== "queued" && item.status !== "reconnect_wait") continue;
        const retryAfter = this.retryAfterByItem.get(itemId) || 0;
        if (retryAfter > now) {
          hasDelayed = true;
        } else {
          hasImmediate = true;
        }
        if (hasImmediate && hasDelayed) return { hasImmediate, hasDelayed };
      }
    }
    return { hasImmediate, hasDelayed };
  }

  private hasQueuedItems(): boolean {
    return this.getQueuePresence().hasImmediate;
  }

  private hasDelayedQueuedItems(): boolean {
    return this.getQueuePresence().hasDelayed;
  }

  private countQueuedItems(): number {
    let count = 0;
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      if (this.runPackageIds.size > 0 && !this.runPackageIds.has(packageId)) {
        continue;
      }
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        if (item.status === "queued" || item.status === "reconnect_wait") {
          count += 1;
        }
      }
    }
    return count;
  }

  private queueRetry(item: DownloadItem, active: ActiveTask, delayMs: number, statusText: string): void {
    const waitMs = Math.max(0, Math.floor(delayMs));
    item.status = "queued";
    item.speedBps = 0;
    item.fullStatus = statusText;
    item.updatedAt = nowMs();
    item.attempts = 0;
    active.abortController = new AbortController();
    active.abortReason = "none";
    this.retryStateByItem.set(item.id, {
      freshRetryUsed: Boolean(active.freshRetryUsed),
      resumeHardResetUsed: Boolean(active.resumeHardResetUsed),
      stallRetries: Number(active.stallRetries || 0),
      genericErrorRetries: Number(active.genericErrorRetries || 0),
      unrestrictRetries: Number(active.unrestrictRetries || 0)
    });
    this.logPackageForItem(item, "WARN", "Retry eingeplant", {
      delayMs: waitMs,
      statusText,
      stallRetries: Number(active.stallRetries || 0),
      unrestrictRetries: Number(active.unrestrictRetries || 0),
      genericRetries: Number(active.genericErrorRetries || 0),
      freshRetryUsed: Boolean(active.freshRetryUsed),
      resumeHardResetUsed: Boolean(active.resumeHardResetUsed)
    });
    // Caller returns immediately after this; startItem().finally releases the active slot,
    // so the retry backoff never blocks a worker.
    this.retryAfterByItem.set(item.id, nowMs() + waitMs);
  }

  private scheduleHttp416Retry(
    item: DownloadItem,
    active: ActiveTask,
    retryDisplayLimit: string,
    errorText: string,
    claimedTargetPath: string
  ): void {
    active.genericErrorRetries = Number(active.genericErrorRetries || 0) + 1;
    item.retries += 1;
    if (claimedTargetPath) {
      try {
        fs.rmSync(claimedTargetPath, { force: true });
      } catch {
        // ignore
      }
    }
    this.releaseTargetPath(item.id);
    this.dropItemContribution(item.id);
    item.lastError = errorText;
    item.downloadedBytes = 0;
    item.totalBytes = null;
    item.progressPercent = 0;
    item.speedBps = 0;
    const delayMs = retryDelayWithJitter(active.genericErrorRetries, 200);
    logger.warn(
      `HTTP 416 erkannt: item=${item.fileName || item.id}, ` +
      `retry=${active.genericErrorRetries}/${retryDisplayLimit}, error=${errorText}, provider=${item.provider || "?"}`
    );
    this.queueRetry(item, active, delayMs, `HTTP 416 erkannt, Retry ${active.genericErrorRetries}/${retryDisplayLimit}`);
  }

  private startItem(packageId: string, itemId: string): void {
    const item = this.session.items[itemId];
    const pkg = this.session.packages[packageId];
    if (!item || !pkg || pkg.cancelled || !pkg.enabled) {
      return;
    }
    if (item.status !== "queued" && item.status !== "reconnect_wait") {
      return;
    }
    if (this.activeTasks.has(itemId)) {
      return;
    }
    const maxParallel = Math.max(1, Number(this.settings.maxParallel) || 1);
    if (this.activeTasks.size >= maxParallel) {
      logger.warn(`startItem übersprungen (Parallel-Limit): active=${this.activeTasks.size}, max=${maxParallel}, item=${item.fileName || item.id}`);
      return;
    }

    this.retryAfterByItem.delete(itemId);

    const preflightReason = `${item.fullStatus || ""} ${item.lastError || ""}`.trim();
    if (shouldPreflightFinalizeItemFromDisk(item)
      && this.tryFinalizeItemFromDisk(pkg, item, "Start-Preflight", preflightReason)) {
      this.retryStateByItem.delete(item.id);
      this.refreshPackageStatus(pkg);
      this.persistSoon();
      return;
    }

    this.notePackageDownloadStarted(pkg);
    item.status = "validating";
    item.fullStatus = "Link wird umgewandelt";
    item.speedBps = 0;
    // Reset stale progress so UI doesn't show old % while re-validating
    if (item.downloadedBytes === 0) {
      item.progressPercent = 0;
    }
    item.updatedAt = nowMs();
    pkg.status = "downloading";
    pkg.updatedAt = nowMs();
    this.logPackageForItem(item, "INFO", "Download-Slot gestartet", {
      packageId,
      maxParallel: Math.max(1, Number(this.settings.maxParallel) || 1)
    });

    const active: ActiveTask = {
      itemId,
      packageId,
      abortController: new AbortController(),
      abortReason: "none",
      resumable: true,
      nonResumableCounted: false,
      blockedOnDiskWrite: false,
      blockedOnDiskSince: 0
    };
    this.activeTasks.set(itemId, active);
    this.notePacedStartForItem(item, nowMs());
    this.emitState();

    void this.processItem(active).catch((err) => {
      logger.warn(`processItem unbehandelt (${itemId}): ${compactErrorText(err)}`);
    }).finally(() => {
      if (!this.retryAfterByItem.has(item.id)) {
        this.releaseTargetPath(item.id);
      }
      if (active.nonResumableCounted) {
        this.nonResumableActive = Math.max(0, this.nonResumableActive - 1);
      }
      this.activeTasks.delete(itemId);
      this.persistSoon();
      this.emitState();
    });
  }

  private async processItem(active: ActiveTask): Promise<void> {
    const item = this.session.items[active.itemId];
    const pkg = this.session.packages[active.packageId];
    if (!item || !pkg) {
      return;
    }

    const retryState = this.retryStateByItem.get(item.id) || {
      freshRetryUsed: false,
      resumeHardResetUsed: false,
      stallRetries: 0,
      genericErrorRetries: 0,
      unrestrictRetries: 0
    };
    this.retryStateByItem.set(item.id, retryState);
    active.freshRetryUsed = retryState.freshRetryUsed;
    active.resumeHardResetUsed = retryState.resumeHardResetUsed;
    active.stallRetries = retryState.stallRetries;
    active.genericErrorRetries = retryState.genericErrorRetries;
    active.unrestrictRetries = retryState.unrestrictRetries;
    const configuredRetryLimit = normalizeRetryLimit(this.settings.retryLimit);
    const retryDisplayLimit = retryLimitLabel(configuredRetryLimit);
    const maxItemRetries = retryLimitToMaxRetries(configuredRetryLimit);
    const maxItemAttempts = configuredRetryLimit <= 0 ? Number.MAX_SAFE_INTEGER : maxItemRetries + 1;
    const maxGenericErrorRetries = maxItemRetries;
    const maxUnrestrictRetries = maxItemRetries;
    const maxStallRetries = maxItemRetries;
    const maxHttp416Retries = configuredRetryLimit <= 0 ? 3 : Math.max(1, Math.min(maxItemRetries, 3));
    while (true) {
      try {
        const preflightReason = `${item.fullStatus || ""} ${item.lastError || ""}`.trim();
        if (shouldPreflightFinalizeItemFromDisk(item)
          && this.tryFinalizeItemFromDisk(pkg, item, "Process-Preflight", preflightReason)) {
          this.retryStateByItem.delete(item.id);
          return;
        }
        this.logPackageForItem(item, "INFO", "Link-Umwandlung gestartet", {
          url: item.url,
          retryLimit: retryDisplayLimit
        });
        // Wait while paused — don't check cooldown or unrestrict while paused
        while (this.session.paused && this.session.running && !active.abortController.signal.aborted) {
          item.status = "paused";
          item.fullStatus = "Pausiert";
          item.speedBps = 0;
          this.emitState();
          await sleep(120);
        }
        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }
        // Check provider cooldown before attempting unrestrict
        const cooldownProvider = this.getProviderFailureKeyForItem(item);
        const cooldownMs = this.getProviderCooldownRemaining(cooldownProvider);
        if (cooldownMs > 0) {
          // If autoProviderFallback is enabled and another provider is ready, switch to it
          // instead of waiting out the full cooldown.
          if (this.settings.autoProviderFallback) {
            const fallback = this.findFallbackProviderNotInCooldown(item);
            if (fallback) {
              logger.info(`Provider-Cooldown: ${cooldownProvider} noch ${Math.ceil(cooldownMs / 1000)}s, wechsle zu ${fallback} für ${item.fileName || item.url}`);
              this.logPackageForItem(item, "WARN", "Provider-Cooldown erkannt, Fallback gewählt", {
                provider: cooldownProvider,
                remainingMs: cooldownMs,
                fallback
              });
              item.provider = null;
              // Continue — debrid.ts will attempt providers in order and reach the fallback
            } else {
              this.logPackageForItem(item, "WARN", "Provider-Cooldown blockiert Unrestrict", {
                provider: cooldownProvider,
                remainingMs: cooldownMs
              });
              const delayMs = Math.min(cooldownMs + 1000, 310000);
              this.queueRetry(item, active, delayMs, `Provider-Cooldown (${Math.ceil(delayMs / 1000)}s)`);
              this.persistSoon();
              this.emitState();
              return;
            }
          } else {
            this.logPackageForItem(item, "WARN", "Provider-Cooldown blockiert Unrestrict", {
              provider: cooldownProvider,
              remainingMs: cooldownMs
            });
            const delayMs = Math.min(cooldownMs + 1000, 310000);
            this.queueRetry(item, active, delayMs, `Provider-Cooldown (${Math.ceil(delayMs / 1000)}s)`);
            this.persistSoon();
            this.emitState();
            return;
          }
        }
        if (await this.maybeApplyAllDebridRapidgatorBackoff(item, active)) {
          this.persistSoon();
          this.emitState();
          return;
        }
        const unrestrictTimeoutSignal = AbortSignal.timeout(getUnrestrictTimeoutMs());
        const unrestrictedSignal = AbortSignal.any([active.abortController.signal, unrestrictTimeoutSignal]);
        let unrestricted;
        try {
          unrestricted = await this.debridService.unrestrictLink(item.url, unrestrictedSignal);
        } catch (unrestrictError) {
          if (!active.abortController.signal.aborted && unrestrictTimeoutSignal.aborted) {
            // Record failure for all providers since we don't know which one timed out
            this.recordProviderFailure(cooldownProvider);
            throw new Error(`Unrestrict Timeout nach ${Math.ceil(getUnrestrictTimeoutMs() / 1000)}s`);
          }
          // Record failure for the provider that errored
          const errText = compactErrorText(unrestrictError);
          if (isUnrestrictFailure(errText) && !isHosterUnavailableError(errText)) {
            this.recordProviderFailure(cooldownProvider);
            if (isProviderBusyUnrestrictError(errText) || isTemporaryUnrestrictError(errText)) {
              const busyCooldownMs = isTemporaryUnrestrictError(errText)
                ? Math.min(180000, 20000 + Number(active.unrestrictRetries || 0) * 10000)
                : Math.min(60000, 12000 + Number(active.unrestrictRetries || 0) * 3000);
              this.applyProviderBusyBackoff(cooldownProvider, busyCooldownMs);
            }
          }
          throw unrestrictError;
        }
        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }
        // Unrestrict succeeded - reset provider failure counter
        this.recordProviderSuccess(this.getProviderFailureKeyForItem(item, unrestricted.provider));
        item.provider = unrestricted.provider;
        item.providerLabel = unrestricted.providerLabel;
        item.providerAccountId = unrestricted.sourceAccountId;
        item.providerAccountLabel = unrestricted.sourceAccountLabel;
        item.retries += unrestricted.retriesUsed;
        item.fileName = sanitizeFilename(unrestricted.fileName || filenameFromUrl(item.url));
        let directHost = "";
        try {
          directHost = new URL(unrestricted.directUrl).host;
        } catch {
          directHost = "";
        }
        try {
          fs.mkdirSync(pkg.outputDir, { recursive: true });
        } catch (mkdirError) {
          throw new Error(`Zielordner kann nicht erstellt werden: ${compactErrorText(mkdirError)}`);
        }
        const existingTargetPath = String(item.targetPath || "").trim();
        const canReuseExistingTarget = existingTargetPath
          && isPathInsideDir(existingTargetPath, pkg.outputDir)
          && (item.downloadedBytes > 0 || fs.existsSync(existingTargetPath));
        const preferredTargetPath = canReuseExistingTarget
          ? existingTargetPath
          : path.join(pkg.outputDir, item.fileName);
        item.targetPath = this.claimTargetPath(item.id, preferredTargetPath, Boolean(canReuseExistingTarget));
        item.totalBytes = unrestricted.fileSize;
        item.status = "downloading";
        const pLabel = unrestricted.providerLabel;
        const statusLabel = providerLabel(unrestricted.provider) || pLabel;
        item.fullStatus = `Starte... (${statusLabel})`;
        item.updatedAt = nowMs();
        this.emitState();
        logger.info(`Download Start: ${item.fileName} (${humanSize(unrestricted.fileSize || 0)}) via ${pLabel}, pkg=${pkg.name}`);
        this.logPackageForItem(item, "INFO", "Link umgewandelt", {
          provider: unrestricted.provider,
          providerLabel: unrestricted.providerLabel || "",
          accountId: unrestricted.sourceAccountId || "",
          accountLabel: unrestricted.sourceAccountLabel || "",
          sizeBytes: unrestricted.fileSize,
          targetPath: item.targetPath,
          directHost,
          directUrl: unrestricted.directUrl,
          resumableHint: unrestricted.retriesUsed >= 0
        });

        const maxAttempts = maxItemAttempts;
        let done = false;
        while (!done && item.attempts < maxAttempts) {
          item.attempts += 1;
          this.logPackageForItem(item, "INFO", "Download-Versuch startet", {
            attempt: item.attempts,
            maxAttempts: maxAttempts === Number.MAX_SAFE_INTEGER ? "infinite" : maxAttempts,
            provider: unrestricted.provider,
            targetPath: item.targetPath,
            existingBytes: item.downloadedBytes,
            totalBytes: item.totalBytes
          });
          if (item.status !== "downloading") {
            item.status = "downloading";
            item.fullStatus = `Download läuft (${statusLabel})`;
            item.updatedAt = nowMs();
            this.emitState();
          }
          const result = await this.downloadToFile(active, unrestricted.directUrl, item.targetPath, item.totalBytes, unrestricted.skipTlsVerify, pLabel);
          active.resumable = result.resumable;
          if (!active.resumable && !active.nonResumableCounted) {
            active.nonResumableCounted = true;
            this.nonResumableActive += 1;
          }

          if (active.abortController.signal.aborted) {
            throw new Error(`aborted:${active.abortReason}`);
          }

          if (this.settings.enableIntegrityCheck) {
            item.status = "integrity_check";
            item.fullStatus = "CRC-Check läuft";
            item.updatedAt = nowMs();
            this.emitState();

            const validation = await validateFileAgainstManifest(item.targetPath, pkg.outputDir);
            if (active.abortController.signal.aborted) {
              throw new Error(`aborted:${active.abortReason}`);
            }
            if (!validation.ok) {
              item.lastError = validation.message;
              item.fullStatus = `${validation.message}, Neuversuch`;
              try {
                fs.rmSync(item.targetPath, { force: true });
              } catch {
                // ignore
              }
              if (item.attempts < maxAttempts) {
                item.status = "integrity_check";
                item.progressPercent = 0;
                this.dropItemContribution(item.id);
                item.downloadedBytes = 0;
                item.totalBytes = unrestricted.fileSize;
                this.emitState();
                await sleep(300);
                continue;
              }
              throw new Error(`Integritätsprüfung fehlgeschlagen (${validation.message})`);
            }
          }

          if (active.abortController.signal.aborted) {
            throw new Error(`aborted:${active.abortReason}`);
          }

          const finalTargetPath = String(item.targetPath || "").trim();
          let fileSizeOnDisk = item.downloadedBytes;
          if (finalTargetPath) {
            try {
              const stat = await fs.promises.stat(finalTargetPath);
              fileSizeOnDisk = stat.size;
            } catch {
              // file does not exist
            }
          }
          const tooSmall = shouldRejectSuspiciousSmallDownload(
            finalTargetPath,
            item.fileName,
            fileSizeOnDisk,
            item.totalBytes
          );
          if (tooSmall) {
            try {
              fs.rmSync(finalTargetPath, { force: true });
            } catch {
              // ignore
            }
            this.releaseTargetPath(item.id);
            this.dropItemContribution(item.id);
            item.downloadedBytes = 0;
            item.progressPercent = 0;
            item.totalBytes = (item.totalBytes || 0) > 0 ? item.totalBytes : null;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            throw new Error(`Datei zu klein (${humanSize(fileSizeOnDisk)}, erwartet ${item.totalBytes ? humanSize(item.totalBytes) : ">= 100 KB"})`);
          }

          done = true;
        }

        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }

        const completedAt = nowMs();
        item.status = "completed";
        item.fullStatus = this.settings.autoExtract
          ? "Entpacken - Ausstehend"
          : `Fertig (${humanSize(item.downloadedBytes)})`;
        item.progressPercent = 100;
        item.speedBps = 0;
        item.updatedAt = completedAt;
        this.notePackageDownloadCompleted(pkg, completedAt);
        pkg.updatedAt = completedAt;
        this.recordRunOutcome(item.id, "completed");
        logger.info(`Download fertig: ${item.fileName} (${humanSize(item.downloadedBytes)}), pkg=${pkg.name}`);
        this.logPackageForItem(item, "INFO", "Download abgeschlossen", {
          downloadedBytes: item.downloadedBytes,
          totalBytes: item.totalBytes,
          autoExtract: this.settings.autoExtract
        });

        if (this.session.running && !active.abortController.signal.aborted) {
          void this.runPackagePostProcessing(pkg.id).catch((err) => {
            logger.warn(`runPackagePostProcessing Fehler (processItem): ${compactErrorText(err)}`);
          }).finally(() => {
            this.applyCompletedCleanupPolicy(pkg.id, item.id);
            this.persistSoon();
            this.emitState();
          });
        }
        this.persistSoon();
        this.emitState();
        this.retryStateByItem.delete(item.id);
        return;
      } catch (error) {
        if (this.session.items[item.id] !== item) {
          return;
        }
        const reason = active.abortReason;
        const claimedTargetPath = this.claimedTargetPathByItem.get(item.id) || "";
        if (reason === "cancel") {
          this.logPackageForItem(item, "WARN", "Download abgebrochen durch Entfernen", {
            reason
          });
          item.status = "cancelled";
          item.fullStatus = "Entfernt";
          this.recordRunOutcome(item.id, "cancelled");
          if (claimedTargetPath) {
            try {
              fs.rmSync(claimedTargetPath, { force: true });
            } catch {
              // ignore
            }
          }
          item.downloadedBytes = 0;
          item.progressPercent = 0;
          item.totalBytes = null;
          this.dropItemContribution(item.id);
          this.retryStateByItem.delete(item.id);
        } else if (reason === "stop") {
          this.logPackageForItem(item, "WARN", "Download gestoppt", {
            reason
          });
          // If a new start() has already re-queued this item, don't overwrite
          // its status with "cancelled"/"Gestoppt" — the new run owns it now.
          if (!this.session.running) {
            item.status = "cancelled";
            item.fullStatus = "Gestoppt";
            this.recordRunOutcome(item.id, "cancelled");
          }
          if (!active.resumable && claimedTargetPath && !fs.existsSync(claimedTargetPath)) {
            item.downloadedBytes = 0;
            item.progressPercent = 0;
            item.totalBytes = null;
            this.dropItemContribution(item.id);
          }
          this.retryStateByItem.delete(item.id);
        } else if (reason === "shutdown") {
          this.logPackageForItem(item, "WARN", "Download für Shutdown geparkt", {
            reason
          });
          item.status = "queued";
          item.speedBps = 0;
          const activePkg = this.session.packages[item.packageId];
          item.fullStatus = activePkg && !activePkg.enabled ? "Paket gestoppt" : "Wartet";
          this.retryStateByItem.delete(item.id);
        } else if (reason === "reconnect") {
          this.logPackageForItem(item, "WARN", "Download wartet auf Reconnect", {
            reason
          });
          item.status = "queued";
          item.speedBps = 0;
          item.fullStatus = "Wartet auf Reconnect";
          // Persist retry counters so shelve logic survives reconnect interruption
          this.retryStateByItem.set(item.id, {
            freshRetryUsed: Boolean(active.freshRetryUsed),
            resumeHardResetUsed: Boolean(active.resumeHardResetUsed),
            stallRetries: Number(active.stallRetries || 0),
            genericErrorRetries: Number(active.genericErrorRetries || 0),
            unrestrictRetries: Number(active.unrestrictRetries || 0)
          });
        } else if (reason === "reset") {
          // Item was reset externally by resetItems/resetPackage — state already set, do nothing
          this.retryStateByItem.delete(item.id);
        } else if (reason === "package_toggle") {
          this.logPackageForItem(item, "WARN", "Download wegen Paket-Toggle pausiert", {
            reason
          });
          item.status = "queued";
          item.speedBps = 0;
          item.fullStatus = "Paket gestoppt";
          this.retryStateByItem.set(item.id, {
            freshRetryUsed: Boolean(active.freshRetryUsed),
            resumeHardResetUsed: Boolean(active.resumeHardResetUsed),
            stallRetries: Number(active.stallRetries || 0),
            genericErrorRetries: Number(active.genericErrorRetries || 0),
            unrestrictRetries: Number(active.unrestrictRetries || 0)
          });
        } else if (reason === "stall") {
          const stallErrorText = compactErrorText(error);
          this.logPackageForItem(item, "WARN", "Stall erkannt", {
            error: stallErrorText,
            downloadedBytes: item.downloadedBytes
          });
          const isSlowThroughput = stallErrorText.includes("slow_throughput");
          const wasValidating = item.status === "validating";
          active.stallRetries += 1;
          logger.warn(`Stall erkannt: item=${item.fileName || item.id}, phase=${wasValidating ? "validating" : "downloading"}, retry=${active.stallRetries}/${retryDisplayLimit}, bytes=${item.downloadedBytes}, error=${stallErrorText || "none"}, provider=${item.provider || "?"}`);
          // Shelve check: too many consecutive failures → pause with fresh provider (like manual reset)
          const totalFailures = (active.stallRetries || 0) + (active.unrestrictRetries || 0) + (active.genericErrorRetries || 0);
          if (totalFailures >= 15) {
            item.retries += 1;
            active.stallRetries = Math.floor((active.stallRetries || 0) / 2);
            active.unrestrictRetries = Math.floor((active.unrestrictRetries || 0) / 2);
            active.genericErrorRetries = Math.floor((active.genericErrorRetries || 0) / 2);
            const oldProvider = item.provider;
            item.provider = null; // fresh provider selection after shelve (like manual reset)
            if (oldProvider) {
              this.providerFailures.delete(oldProvider); // clear circuit breaker for old provider
            }
            const shelveDurationMs = 90000; // 90s instead of 5 min — manual restart works immediately, so no need for long pause
            logger.warn(`Item shelved: ${item.fileName || item.id}, totalFailures=${totalFailures}, oldProvider=${oldProvider || "?"}, provider+circuit-breaker reset, pause=${shelveDurationMs}ms`);
            this.queueRetry(item, active, shelveDurationMs, `Viele Fehler (${totalFailures}x), Pause ${Math.ceil(shelveDurationMs / 1000)}s`);
            item.lastError = stallErrorText;
            this.persistSoon();
            this.emitState();
            return;
          }
          if (active.stallRetries <= maxStallRetries) {
            item.retries += 1;
            // Before deleting and retrying, check if the file is actually
            // complete on disk.  Some servers delay closing the connection
            // after all data has been sent, which triggers the stall timeout
            // even though the download finished successfully.
            if (item.downloadedBytes > 0) {
              const targetFile = this.claimedTargetPathByItem.get(item.id) || "";
              if (this.tryFinalizeItemFromDisk(pkg, item, "Stall-Recovery", stallErrorText)) {
                return;
              }
              if (targetFile) {
                try { fs.rmSync(targetFile, { force: true }); } catch { /* ignore */ }
              }
              this.releaseTargetPath(item.id);
              item.downloadedBytes = 0;
              item.progressPercent = 0;
              item.totalBytes = null;
              this.dropItemContribution(item.id);
            }
            let stallDelayMs = retryDelayWithJitter(active.stallRetries, 200);
            // Respect provider cooldown
            const providerCooldownKey = this.getProviderFailureKeyForItem(item);
            const providerCooldown = this.getProviderCooldownRemaining(providerCooldownKey);
            if (providerCooldown > stallDelayMs) {
              stallDelayMs = providerCooldown + 1000;
            }
            const retryText = wasValidating
              ? `Link-Umwandlung hing, Retry ${active.stallRetries}/${retryDisplayLimit}`
              : isSlowThroughput
                ? `Zu wenig Datenfluss, Retry ${active.stallRetries}/${retryDisplayLimit}`
                : `Keine Daten empfangen, Retry ${active.stallRetries}/${retryDisplayLimit}`;
            this.queueRetry(item, active, stallDelayMs, retryText);
            item.lastError = "";
            this.persistSoon();
            this.emitState();
            return;
          }
          item.status = "failed";
          item.lastError = wasValidating ? "Link-Umwandlung hing wiederholt" : "Download hing wiederholt";
          item.fullStatus = `Fehler: ${item.lastError}`;
          this.recordRunOutcome(item.id, "failed");
          this.retryStateByItem.delete(item.id);
        } else {
          const errorText = compactErrorText(error);
          if (this.tryFinalizeItemFromDisk(pkg, item, "Error-Recovery", errorText)) {
            return;
          }
          this.logPackageForItem(item, "WARN", "Download-Fehlerpfad erreicht", {
            error: errorText,
            abortReason: reason || "none"
          });
          const directLinkRetryMatch = errorText.match(/^(?:Error:\s*)?direct_link_retry_exhausted:(.+)$/);
          if (directLinkRetryMatch) {
            const exhaustedReason = compactErrorText(directLinkRetryMatch[1] || errorText).replace(/^Error:\s*/i, "");
            if (item.provider === "debridlink") {
              await sleep(450);
              if (this.tryFinalizeItemFromDisk(pkg, item, "DebridLink-Settle-Recovery", exhaustedReason)) {
                return;
              }
            }
            if (isHttp416Text(exhaustedReason) && active.genericErrorRetries < maxHttp416Retries) {
              this.scheduleHttp416Retry(item, active, retryDisplayLimit, exhaustedReason, claimedTargetPath);
              this.persistSoon();
              this.emitState();
              return;
            }
            if (isResumeHardResetReason(exhaustedReason) && !active.resumeHardResetUsed) {
              active.resumeHardResetUsed = true;
              item.retries += 1;
              logger.warn(`Resume-Neustart: item=${item.fileName || item.id}, error=${exhaustedReason}, provider=${item.provider || "?"}`);
              const resetTargetPath = claimedTargetPath || String(item.targetPath || "").trim();
              if (resetTargetPath) {
                try {
                  fs.rmSync(resetTargetPath, { force: true });
                } catch {
                  // ignore
                }
              }
              this.releaseTargetPath(item.id);
              this.dropItemContribution(item.id);
              item.lastError = exhaustedReason;
              item.downloadedBytes = 0;
              item.totalBytes = null;
              item.progressPercent = 0;
              this.queueRetry(item, active, 300, "Resume-Fehler erkannt, kompletter Neuversuch");
              this.persistSoon();
              this.emitState();
              return;
            }
          }
          if (directLinkRetryMatch && active.genericErrorRetries < maxGenericErrorRetries) {
            active.genericErrorRetries += 1;
            item.retries += 1;
            const exhaustedReason = compactErrorText(directLinkRetryMatch[1] || errorText).replace(/^Error:\s*/i, "");
            const refreshDelayMs = retryDelayWithJitter(active.genericErrorRetries, 200);
            logger.warn(
              `Direktlink erschöpft: item=${item.fileName || item.id}, ` +
              `retry=${active.genericErrorRetries}/${retryDisplayLimit}, error=${exhaustedReason}, provider=${item.provider || "?"}`
            );
            this.queueRetry(
              item,
              active,
              refreshDelayMs,
              exhaustedReason.startsWith("range_ignored_on_resume:")
                ? `Resume-Link erneuern, Retry ${active.genericErrorRetries}/${retryDisplayLimit}`
                : `Direktlink erneuern, Retry ${active.genericErrorRetries}/${retryDisplayLimit}`
            );
            item.lastError = exhaustedReason;
            this.persistSoon();
            this.emitState();
            return;
          }
          const shouldFreshRetry = !active.freshRetryUsed && isFetchFailure(errorText);
          const isHttp416 = isHttp416Text(errorText);
          if (isHttp416) {
            if (active.genericErrorRetries < maxHttp416Retries) {
              this.scheduleHttp416Retry(item, active, retryDisplayLimit, errorText, claimedTargetPath);
              this.persistSoon();
              this.emitState();
              return;
            }
            item.status = "failed";
            this.recordRunOutcome(item.id, "failed");
            item.lastError = errorText;
            item.fullStatus = `Fehler: ${item.lastError}`;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            this.persistSoon();
            this.emitState();
            this.retryStateByItem.delete(item.id);
            return;
          }
          if (shouldFreshRetry) {
            active.freshRetryUsed = true;
            item.retries += 1;
            logger.warn(`Netzwerkfehler: item=${item.fileName || item.id}, fresh retry, error=${errorText}, provider=${item.provider || "?"}`);
            if (claimedTargetPath) {
              try {
                fs.rmSync(claimedTargetPath, { force: true });
              } catch {
                // ignore
              }
            }
            this.releaseTargetPath(item.id);
            this.dropItemContribution(item.id);
            this.queueRetry(item, active, 300, "Netzwerkfehler erkannt, frischer Retry");
            item.lastError = "";
            item.downloadedBytes = 0;
            item.totalBytes = null;
            item.progressPercent = 0;
            this.persistSoon();
            this.emitState();
            return;
          }

          // Permanent link errors (dead link, file removed, hoster unavailable) → fail immediately
          // Check BEFORE shelve to avoid 5-min pause on dead links
          if (isPermanentLinkError(errorText)) {
            logger.error(`Link permanent ungültig: item=${item.fileName || item.id}, error=${errorText}, link=${item.url.slice(0, 80)}`);
            item.status = "failed";
            this.recordRunOutcome(item.id, "failed");
            item.lastError = errorText;
            item.fullStatus = `Link ungültig: ${errorText}`;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            this.retryStateByItem.delete(item.id);
            this.persistSoon();
            this.emitState();
            return;
          }

          // Shelve check for non-stall errors (after permanent link error check)
          const totalNonStallFailures = (active.stallRetries || 0) + (active.unrestrictRetries || 0) + (active.genericErrorRetries || 0);
          if (totalNonStallFailures >= 15) {
            item.retries += 1;
            active.stallRetries = Math.floor((active.stallRetries || 0) / 2);
            active.unrestrictRetries = Math.floor((active.unrestrictRetries || 0) / 2);
            active.genericErrorRetries = Math.floor((active.genericErrorRetries || 0) / 2);
            const oldProvider = item.provider;
            item.provider = null; // fresh provider selection after shelve (like manual reset)
            if (oldProvider) {
              this.providerFailures.delete(oldProvider); // clear circuit breaker for old provider
            }
            const shelveDurationMs = 90000;
            logger.warn(`Item shelved (error path): ${item.fileName || item.id}, totalFailures=${totalNonStallFailures}, error=${errorText}, oldProvider=${oldProvider || "?"}, provider+circuit-breaker reset, pause=${shelveDurationMs}ms`);
            this.queueRetry(item, active, shelveDurationMs, `Viele Fehler (${totalNonStallFailures}x), Pause ${Math.ceil(shelveDurationMs / 1000)}s`);
            item.lastError = errorText;
            this.persistSoon();
            this.emitState();
            return;
          }

          // hosterNotAvailable: hoster issue, not provider issue — reset provider
          // and retry quickly with fresh provider selection (like manual reset)
          if (isHosterUnavailableError(errorText) && active.unrestrictRetries < maxUnrestrictRetries) {
            active.unrestrictRetries += 1;
            item.retries += 1;
            item.provider = null; // fresh provider selection on next attempt
            // Cap backoff at 30s — hoster issues often resolve quickly
            const hosterDelayMs = Math.min(30000, Math.floor(5000 * Math.pow(1.5, Math.min(active.unrestrictRetries - 1, 5))));
            logger.warn(`Hoster nicht verfügbar: item=${item.fileName || item.id}, retry=${active.unrestrictRetries}/${retryDisplayLimit}, delay=${hosterDelayMs}ms, link=${item.url.slice(0, 80)}`);
            if (item.downloadedBytes > 0) {
              const targetFile = this.claimedTargetPathByItem.get(item.id) || "";
              if (targetFile) {
                try { fs.rmSync(targetFile, { force: true }); } catch { /* ignore */ }
              }
              this.releaseTargetPath(item.id);
              item.downloadedBytes = 0;
              item.progressPercent = 0;
              item.totalBytes = null;
              this.dropItemContribution(item.id);
            }
            this.queueRetry(item, active, hosterDelayMs, `Hoster nicht verfügbar, Retry ${active.unrestrictRetries}/${retryDisplayLimit} (${Math.ceil(hosterDelayMs / 1000)}s)`);
            item.lastError = errorText;
            this.persistSoon();
            this.emitState();
            return;
          }

          const debridLinkTerminalFailure = parseDebridLinkTerminalFailure(errorText);
          if (debridLinkTerminalFailure) {
            item.status = "failed";
            this.recordRunOutcome(item.id, "failed");
            item.lastError = debridLinkTerminalFailure.detail;
            item.fullStatus = `Debrid-Link: ${debridLinkTerminalFailure.detail}`;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            this.retryStateByItem.delete(item.id);
            this.persistSoon();
            this.emitState();
            return;
          }

          if (isUnrestrictFailure(errorText) && active.unrestrictRetries < maxUnrestrictRetries) {
            const debridLinkCooldown = parseDebridLinkCooldownRetry(errorText);
            if (debridLinkCooldown) {
              active.unrestrictRetries += 1;
              item.retries += 1;
              // Do NOT call recordProviderFailure/applyProviderBusyBackoff here —
              // Debrid-Link key cooldowns are managed in debrid.ts per-key.
              // Adding a provider-wide cooldown on top causes double-blocking.
              logger.warn(
                `Debrid-Link-Cooldown: item=${item.fileName || item.id}, ` +
                `retry=${active.unrestrictRetries}/${retryDisplayLimit}, delay=${debridLinkCooldown.delayMs}ms, ` +
                `detail=${debridLinkCooldown.detail || errorText}, link=${item.url.slice(0, 80)}`
              );
              this.queueRetry(
                item,
                active,
                debridLinkCooldown.delayMs,
                `Debrid-Link Cooldown, Retry ${active.unrestrictRetries}/${retryDisplayLimit} (${Math.ceil(debridLinkCooldown.delayMs / 1000)}s)`
              );
              item.lastError = debridLinkCooldown.detail || errorText;
              this.persistSoon();
              this.emitState();
              return;
            }

            active.unrestrictRetries += 1;
            item.retries += 1;
            const failureProvider = this.getProviderFailureKeyForItem(item);
            // Debrid-Link manages its own per-key cooldowns in debrid.ts. The
            // provider-wide circuit breaker would double-block all Debrid-Link
            // keys when only one key (or a transient transport hiccup) failed.
            // Skip recordProviderFailure / applyProviderBusyBackoff entirely
            // for any Debrid-Link-flavoured error message, not just the
            // debrid_link_cooldown sentinel that's caught above.
            const isDebridLinkError = /debrid-link|debrid_link/i.test(errorText) || failureProvider === "debridlink";
            if (!isDebridLinkError) {
              this.recordProviderFailure(failureProvider);
              if (isProviderBusyUnrestrictError(errorText) || isTemporaryUnrestrictError(errorText)) {
                const busyCooldownMs = isTemporaryUnrestrictError(errorText)
                  ? Math.min(180000, 20000 + Number(active.unrestrictRetries || 0) * 10000)
                  : Math.min(60000, 12000 + Number(active.unrestrictRetries || 0) * 3000);
                this.applyProviderBusyBackoff(failureProvider, busyCooldownMs);
              }
            }
            // Escalating backoff: 5s, 7.5s, 11s, 17s, 25s, 38s, ... up to 120s
            let unrestrictDelayMs = Math.min(120000, Math.floor(5000 * Math.pow(1.5, active.unrestrictRetries - 1)));
            // Respect provider cooldown
            const providerCooldown = this.getProviderCooldownRemaining(failureProvider);
            if (providerCooldown > unrestrictDelayMs) {
              unrestrictDelayMs = providerCooldown + 1000;
            }
            logger.warn(`Unrestrict-Fehler: item=${item.fileName || item.id}, retry=${active.unrestrictRetries}/${retryDisplayLimit}, delay=${unrestrictDelayMs}ms, error=${errorText}, link=${item.url.slice(0, 80)}`);
            // Reset partial download so next attempt starts fresh
            if (item.downloadedBytes > 0) {
              const targetFile = this.claimedTargetPathByItem.get(item.id) || "";
              if (targetFile) {
                try { fs.rmSync(targetFile, { force: true }); } catch { /* ignore */ }
              }
              this.releaseTargetPath(item.id);
              item.downloadedBytes = 0;
              item.progressPercent = 0;
              item.totalBytes = null;
              this.dropItemContribution(item.id);
            }
            this.queueRetry(
              item,
              active,
              unrestrictDelayMs,
              `Link-Umwandlung erneut, Versuch ${active.unrestrictRetries}/${retryDisplayLimit} (${Math.ceil(unrestrictDelayMs / 1000)}s)`
            );
            item.lastError = errorText;
            this.persistSoon();
            this.emitState();
            return;
          }

          if (active.genericErrorRetries < maxGenericErrorRetries) {
            active.genericErrorRetries += 1;
            item.retries += 1;
            const genericDelayMs = retryDelayWithJitter(active.genericErrorRetries, 250);
            logger.warn(`Generic-Fehler: item=${item.fileName || item.id}, retry=${active.genericErrorRetries}/${retryDisplayLimit}, error=${errorText}, provider=${item.provider || "?"}`);
            this.queueRetry(item, active, genericDelayMs, `Fehler erkannt, Auto-Retry ${active.genericErrorRetries}/${retryDisplayLimit}`);
            item.lastError = errorText;
            this.persistSoon();
            this.emitState();
            return;
          }

          item.status = "failed";
          this.recordRunOutcome(item.id, "failed");
          item.lastError = errorText;
          item.fullStatus = `Fehler: ${item.lastError}`;
          logger.error(`Item endgültig fehlgeschlagen: item=${item.fileName || item.id}, error=${errorText}, provider=${item.provider || "?"}, stallRetries=${active.stallRetries}, unrestrictRetries=${active.unrestrictRetries}, genericRetries=${active.genericErrorRetries}`);
          this.retryStateByItem.delete(item.id);
        }
        item.speedBps = 0;
        item.updatedAt = nowMs();
        // Refresh package status so it reflects "failed" when all items are done
        const failPkg = this.session.packages[item.packageId];
        if (failPkg) this.refreshPackageStatus(failPkg);
        this.persistSoon();
        this.emitState();
        return;
      }
    }
  }

  private async downloadToFile(
    active: ActiveTask,
    directUrl: string,
    targetPath: string,
    knownTotal: number | null,
    skipTlsVerify?: boolean,
    pLabel?: string
  ): Promise<{ resumable: boolean }> {
    const label = providerLabel(this.session.items[active.itemId]?.provider) || pLabel || "Debrid";
    const item = this.session.items[active.itemId];
    if (!item) {
      throw new Error("Download-Item fehlt");
    }
    const logAttemptEvent = (level: "INFO" | "WARN" | "ERROR", message: string, fields?: Record<string, unknown>): void => {
      this.logPackageForItem(item, level, message, fields);
    };

    const configuredRetryLimit = normalizeRetryLimit(this.settings.retryLimit);
    const retryDisplayLimit = retryLimitLabel(configuredRetryLimit);
    const maxAttemptsBySetting = configuredRetryLimit <= 0 ? Number.MAX_SAFE_INTEGER : configuredRetryLimit + 1;
    const maxAttempts = Math.max(1, Math.min(MAX_SAME_DIRECT_URL_ATTEMPTS, maxAttemptsBySetting));

    let lastError = "";
    let effectiveTargetPath = targetPath;
    let resumeRewindBytesNextAttempt = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let existingBytes = 0;
      try {
        const stat = await fs.promises.stat(effectiveTargetPath);
        existingBytes = stat.size;
      } catch {
        // file does not exist
      }
      if (existingBytes > 0 && resumeRewindBytesNextAttempt > 0) {
        const previousBytes = existingBytes;
        const rewindBytes = Math.min(existingBytes, resumeRewindBytesNextAttempt);
        const resumeStart = Math.max(0, existingBytes - rewindBytes);
        try {
          await fs.promises.truncate(effectiveTargetPath, resumeStart);
          existingBytes = resumeStart;
          item.downloadedBytes = Math.min(item.downloadedBytes, existingBytes);
          logAttemptEvent("WARN", "Resume-Schutz aktiv: Teil-Datei vor Retry zurueckgespult", {
            attempt,
            previousBytes,
            rewindBytes,
            resumeStart
          });
        } catch (rewindError) {
          logAttemptEvent("WARN", "Resume-Schutz: Rueckspulen der Teil-Datei fehlgeschlagen", {
            attempt,
            previousBytes,
            rewindBytes,
            error: compactErrorText(rewindError)
          });
        } finally {
          resumeRewindBytesNextAttempt = 0;
        }
      } else if (resumeRewindBytesNextAttempt > 0) {
        resumeRewindBytesNextAttempt = 0;
      }
      const persistedBytes = Math.max(0, Math.floor(Number(item.downloadedBytes) || 0));
      const preallocMismatchThreshold = resolvePreallocResumeMismatchThreshold(item.fileName || effectiveTargetPath || "");
      // Guard against pre-allocated sparse files from a crashed session:
      // if file size exceeds persisted downloadedBytes beyond the allowed
      // mismatch threshold, the file was likely pre-allocated but only
      // partially written before a hard crash.
      // This must also run for persistedBytes=0, otherwise startup-resume can
      // send Range=full-size and incorrectly accept HTTP 416 as "complete".
      if (existingBytes > 0 && existingBytes > persistedBytes + preallocMismatchThreshold) {
        try {
          const previousBytes = existingBytes;
          await fs.promises.truncate(effectiveTargetPath, persistedBytes);
          existingBytes = persistedBytes;
          logAttemptEvent("WARN", "Pre-alloc-Rest erkannt, Teil-Datei auf persistierte Bytes gekuerzt", {
            attempt,
            previousBytes,
            persistedBytes
          });
        } catch {
          if (persistedBytes === 0) {
            try {
              await fs.promises.rm(effectiveTargetPath, { force: true });
              existingBytes = 0;
            } catch {
              // ignore
            }
          }
        }
      }
      const suspiciousResumeFootprint = existingBytes > 0
        && existingBytes > persistedBytes + preallocMismatchThreshold;
      const headers: Record<string, string> = {};
      if (existingBytes > 0) {
        headers.Range = `bytes=${existingBytes}-`;
      }
      logAttemptEvent("INFO", "HTTP-Download-Versuch vorbereitet", {
        attempt,
        maxAttempts: maxAttempts === Number.MAX_SAFE_INTEGER ? "infinite" : maxAttempts,
        directUrl,
        targetPath: effectiveTargetPath,
        knownTotal,
        existingBytes,
        rangeHeader: headers.Range || ""
      });

      while (this.reconnectActive()) {
        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }
        await sleep(250);
      }

      let response: Response;
      const connectTimeoutMs = getDownloadConnectTimeoutMs();
      let connectTimer: NodeJS.Timeout | null = null;
      const connectAbortController = new AbortController();
      if (skipTlsVerify) acquireTlsSkip();
      try {
        if (connectTimeoutMs > 0) {
          connectTimer = setTimeout(() => {
            connectAbortController.abort("connect_timeout");
          }, connectTimeoutMs);
        }
        response = await fetch(directUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.any([active.abortController.signal, connectAbortController.signal])
        });
      } catch (error) {
        if (active.abortController.signal.aborted || String(error).includes("aborted:")) {
          throw error;
        }
        lastError = compactErrorText(error);
        logAttemptEvent("WARN", "HTTP-Verbindung fehlgeschlagen", {
          attempt,
          error: lastError
        });
        if (attempt < maxAttempts) {
          item.retries += 1;
          item.fullStatus = `Verbindungsfehler, retry ${attempt}/${retryDisplayLimit}`;
          this.emitState();
          await sleep(retryDelayWithJitter(attempt, 200));
          continue;
        }
        throw error;
      } finally {
        if (skipTlsVerify) releaseTlsSkip();
        if (connectTimer) {
          clearTimeout(connectTimer);
        }
      }

      if (!response.ok) {
        logAttemptEvent(response.status >= 500 ? "WARN" : "ERROR", "HTTP-Antwort nicht erfolgreich", {
          attempt,
          status: response.status,
          statusText: response.statusText,
          existingBytes
        });
        if (response.status === 416 && existingBytes > 0) {
          await response.arrayBuffer().catch(() => undefined);
          const rangeTotal = parseContentRangeTotal(response.headers.get("content-range"));
          const expectedTotal = rangeTotal && rangeTotal > 0
            ? rangeTotal
            : (knownTotal && knownTotal > 0 ? knownTotal : null);
          const sizeToleranceBytes = isLargeBinaryLikePath(item.fileName || effectiveTargetPath) ? 0 : ALLOCATION_UNIT_SIZE;
          const closeEnoughToExpected = expectedTotal != null
            && Math.abs(existingBytes - expectedTotal) <= sizeToleranceBytes;
          if (expectedTotal != null && closeEnoughToExpected && !suspiciousResumeFootprint) {
            const finalizedTotal = Math.max(existingBytes, expectedTotal);
            item.totalBytes = finalizedTotal;
            item.downloadedBytes = existingBytes;
            item.progressPercent = 100;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            logAttemptEvent("INFO", "HTTP 416 als vollständig behandelt", {
              existingBytes,
              expectedTotal: finalizedTotal
            });
            return { resumable: true };
          }
          if (expectedTotal != null && closeEnoughToExpected && suspiciousResumeFootprint) {
            logAttemptEvent("WARN", "HTTP 416 trotz Vollgroesse nicht als fertig gewertet (vermutlich pre-alloc)", {
              attempt,
              existingBytes,
              persistedBytes,
              expectedTotal
            });
          }

          try {
            await fs.promises.rm(effectiveTargetPath, { force: true });
          } catch {
            // ignore
          }
          this.dropItemContribution(active.itemId);
          item.downloadedBytes = 0;
          item.totalBytes = knownTotal && knownTotal > 0 ? knownTotal : null;
          item.progressPercent = 0;
          item.speedBps = 0;
          item.fullStatus = `Range-Konflikt (HTTP 416), starte neu ${attempt}/${retryDisplayLimit}`;
          item.updatedAt = nowMs();
          this.emitState();
          if (item.provider === "debridlink") {
            logAttemptEvent("WARN", "Debrid-Link HTTP 416: Direktlink sofort verwerfen", {
              attempt,
              existingBytes,
              expectedTotal: expectedTotal || null
            });
            throw new Error("direct_link_retry_exhausted:HTTP 416");
          }
          if (attempt < maxAttempts) {
            item.retries += 1;
            await sleep(retryDelayWithJitter(attempt, 200));
            continue;
          }
          lastError = "HTTP 416";
          throw new Error(lastError);
        }
        const text = await response.text();
        lastError = `HTTP ${response.status}`;
        const responseText = compactErrorText(text || "");
        if (responseText && responseText !== "Unbekannter Fehler" && !/(^|\b)http\s*\d{3}\b/i.test(responseText)) {
          lastError = `HTTP ${response.status}: ${responseText}`;
        }
        if (attempt < maxAttempts) {
          item.retries += 1;
          item.fullStatus = `Serverfehler ${response.status}, retry ${attempt}/${retryDisplayLimit}`;
          this.emitState();
          await sleep(retryDelayWithJitter(attempt, 250));
          continue;
        }
        if (this.settings.autoReconnect && [429, 503].includes(response.status)) {
          this.requestReconnect(`HTTP ${response.status}`);
          logAttemptEvent("WARN", "Reconnect angefordert wegen HTTP-Status", {
            status: response.status
          });
          throw new Error(lastError);
        }
        throw new Error(lastError);
      }

      const acceptRanges = (response.headers.get("accept-ranges") || "").toLowerCase().includes("bytes");
      let preAllocated = false;
      let written = 0;
      try {
        if (existingBytes === 0) {
          const rawHeaderName = parseContentDispositionFilename(response.headers.get("content-disposition")).trim();
          const fromHeader = rawHeaderName ? sanitizeFilename(rawHeaderName) : "";
          if (fromHeader && !looksLikeOpaqueFilename(fromHeader) && fromHeader !== item.fileName) {
            const pkg = this.session.packages[item.packageId];
            if (pkg) {
              this.releaseTargetPath(item.id);
              effectiveTargetPath = this.claimTargetPath(item.id, path.join(pkg.outputDir, fromHeader));
              item.fileName = fromHeader;
              item.targetPath = effectiveTargetPath;
              item.updatedAt = nowMs();
              this.emitState();
              logAttemptEvent("INFO", "Dateiname aus Content-Disposition übernommen", {
                headerFileName: fromHeader,
                newTargetPath: effectiveTargetPath
              });
            }
          }
        }

        const resumable = response.status === 206 || acceptRanges;
        active.resumable = resumable;

        const rawContentLength = Number(response.headers.get("content-length") || 0);
        const contentLength = Number.isFinite(rawContentLength) && rawContentLength > 0 ? rawContentLength : 0;
        const parsedContentRange = parseContentRange(response.headers.get("content-range"));
        const totalFromRange = parsedContentRange?.total ?? null;
        const serverIgnoredRange = existingBytes > 0 && response.status === 200;
        const allowFreshOverwriteAfterResumeReset = serverIgnoredRange
          && active.resumeHardResetUsed
          && isRealDebridProvider(item.provider);
        if (serverIgnoredRange && !allowFreshOverwriteAfterResumeReset) {
          logger.warn(`Server ignorierte Range-Header (HTTP 200 statt 206), verwerfe Direktlink und behalte Teil-Datei: ${item.fileName}`);
          logAttemptEvent("WARN", "Server ignorierte Range-Header beim Resume", {
            attempt,
            existingBytes,
            contentLength,
            directUrl
          });
          try {
            await response.body?.cancel();
          } catch {
            // ignore
          }
          throw new Error(`range_ignored_on_resume:${existingBytes}/${contentLength || 0}`);
        }
        if (allowFreshOverwriteAfterResumeReset) {
          logger.warn(
            `Server ignorierte Range-Header nach Resume-Reset, ueberschreibe alte Teil-Datei frisch: ${item.fileName}`
          );
          logAttemptEvent("WARN", "Range ignoriert nach Resume-Reset, frischer Vollstart erlaubt", {
            attempt,
            existingBytes,
            contentLength,
            directUrl
          });
        }
        if (existingBytes > 0 && response.status === 206) {
          if (!parsedContentRange) {
            logAttemptEvent("WARN", "Resume-Range-Header ungueltig oder fehlt", {
              attempt,
              existingBytes,
              contentRange: response.headers.get("content-range") || ""
            });
            try {
              await response.body?.cancel();
            } catch {
              // ignore
            }
            throw new Error(`range_mismatch_on_resume:${existingBytes}/invalid`);
          }
          if (parsedContentRange.start !== existingBytes) {
            const sizeToleranceBytes = isLargeBinaryLikePath(item.fileName || effectiveTargetPath) ? 0 : ALLOCATION_UNIT_SIZE;
            const canTreatAsAlreadyComplete = contentLength === 0
              && parsedContentRange.start === 0
              && parsedContentRange.total != null
              && Math.abs(existingBytes - parsedContentRange.total) <= sizeToleranceBytes;
            if (canTreatAsAlreadyComplete) {
              item.totalBytes = parsedContentRange.total;
              item.downloadedBytes = existingBytes;
              item.progressPercent = 100;
              item.speedBps = 0;
              item.updatedAt = nowMs();
              logAttemptEvent("WARN", "Resume-Range-Start abweichend, Datei aber bereits vollstaendig", {
                attempt,
                existingBytes,
                totalFromRange: parsedContentRange.total,
                contentLength
              });
              return { resumable: true };
            }
            logAttemptEvent("WARN", "Resume-Range-Start stimmt nicht mit lokaler Dateigroesse ueberein", {
              attempt,
              expectedStart: existingBytes,
              actualStart: parsedContentRange.start,
              actualEnd: parsedContentRange.end,
              totalFromRange,
              directUrl
            });
            try {
              await response.body?.cancel();
            } catch {
              // ignore
            }
            throw new Error(`range_mismatch_on_resume:${existingBytes}/${parsedContentRange.start}`);
          }
        }

        const correctedRealDebridTotal = getAuthoritativeRealDebridTotal(
          item.provider,
          knownTotal || 0,
          existingBytes,
          response.status,
          contentLength,
          totalFromRange,
          Boolean(active.resumeHardResetUsed)
        );
        if (correctedRealDebridTotal) {
          item.totalBytes = correctedRealDebridTotal.totalBytes;
          logger.warn(
            `Real-Debrid-Zielgroesse korrigiert: ${item.fileName} ` +
            `known=${knownTotal}, corrected=${correctedRealDebridTotal.totalBytes}, ` +
            `source=${correctedRealDebridTotal.source}`
          );
          logAttemptEvent("WARN", "Real-Debrid-Zielgroesse aus HTTP korrigiert", {
            attempt,
            source: correctedRealDebridTotal.source,
            knownTotal,
            correctedTotal: correctedRealDebridTotal.totalBytes,
            mismatchBytes: correctedRealDebridTotal.mismatchBytes,
            existingBytes,
            contentLength,
            totalFromRange
          });
        } else if (knownTotal && knownTotal > 0) {
          item.totalBytes = knownTotal;
        } else if (totalFromRange) {
          item.totalBytes = totalFromRange;
        } else if (contentLength > 0) {
          // Only add existingBytes for 206 responses; for 200 the Content-Length is the full file
          item.totalBytes = response.status === 206 ? existingBytes + contentLength : contentLength;
        }
        const completionPlan = planDownloadCompletion({
          existingBytes,
          responseStatus: response.status,
          contentLength,
          totalFromRange,
          knownTotal,
          correctedTotal: correctedRealDebridTotal?.totalBytes || null
        });

        const writeMode = existingBytes > 0 && response.status === 206 ? "a" : "w";
        logAttemptEvent("INFO", "HTTP-Antwort akzeptiert", {
          attempt,
          status: response.status,
          acceptRanges,
          resumable,
          contentLength,
          totalFromRange,
          totalBytes: item.totalBytes,
          writeMode
        });
        if (writeMode === "w") {
          // Starting fresh: subtract any previously counted bytes for this item to avoid double-counting on retry
          const previouslyContributed = this.itemContributedBytes.get(active.itemId) || 0;
          if (previouslyContributed > 0) {
            this.session.totalDownloadedBytes = Math.max(0, this.session.totalDownloadedBytes - previouslyContributed);
            this.sessionDownloadedBytes = Math.max(0, this.sessionDownloadedBytes - previouslyContributed);
            this.itemContributedBytes.set(active.itemId, 0);
          }
          if (existingBytes > 0) {
            await fs.promises.rm(effectiveTargetPath, { force: true });
          }
        }

        await fs.promises.mkdir(path.dirname(effectiveTargetPath), { recursive: true });

        // Sparse file pre-allocation (Windows only, new files with known size)
        if (writeMode === "w" && item.totalBytes && item.totalBytes > 0 && process.platform === "win32") {
          try {
            const fd = await fs.promises.open(effectiveTargetPath, "w");
            try {
              await fd.truncate(item.totalBytes);
              preAllocated = true;
            } finally {
              await fd.close();
            }
          } catch { /* best-effort */ }
        }

        const stream = fs.createWriteStream(effectiveTargetPath, {
          flags: preAllocated ? "r+" : writeMode,
          start: preAllocated ? 0 : undefined,
          highWaterMark: STREAM_HIGH_WATER_MARK
        });
        written = writeMode === "a" ? existingBytes : 0;
        let windowBytes = 0;
        let windowStarted = nowMs();
        let lastPackageLogAt = 0;
        let lastLoggedPercent = -1;
        const itemCount = this.itemCount;
        const uiUpdateIntervalMs = itemCount >= 1500
          ? 500
          : itemCount >= 700
            ? 350
            : itemCount >= 250
              ? 220
              : 120;
        let lastUiEmitAt = 0;
        const stallTimeoutMs = getDownloadStallTimeoutMs();
        const drainTimeoutMs = Math.max(30000, Math.min(300000, stallTimeoutMs > 0 ? stallTimeoutMs * 12 : 120000));
        let lastDiskBusyEmitAt = 0;
        let diskBusySince = 0;  // timestamp when writableLength first became > 0
        const diskBusyStatusVisible = (nowTick: number): boolean => {
          const blockedSince = active.blockedOnDiskSince || 0;
          if (blockedSince > 0 && nowTick - blockedSince >= DISK_BUSY_STATUS_THRESHOLD_MS) {
            return true;
          }
          return diskBusySince > 0 && nowTick - diskBusySince >= DISK_BUSY_STATUS_THRESHOLD_MS;
        };

        const waitDrain = (): Promise<void> => new Promise((resolve, reject) => {
          if (active.abortController.signal.aborted) {
            reject(new Error(`aborted:${active.abortReason}`));
            return;
          }

          active.blockedOnDiskWrite = true;
          active.blockedOnDiskSince = nowMs();
          if (item.status !== "paused" && !this.session.paused) {
            const nowTick = nowMs();
              if (diskBusyStatusVisible(nowTick) && nowTick - lastDiskBusyEmitAt >= 1200) {
                item.status = "downloading";
                item.speedBps = 0;
                item.fullStatus = `Warte auf Festplatte (${label})`;
                item.updatedAt = nowTick;
                this.emitState();
                lastDiskBusyEmitAt = nowTick;
                logAttemptEvent("WARN", "Schreibtask wartet auf Festplatte", {
                  attempt,
                  writableLength: stream.writableLength
                });
              }
            }

          let settled = false;
          let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            // Do NOT abort the controller here – drain timeout means disk is slow,
            // not network stall.  Rejecting without abort lets the inner retry loop
            // handle it (resume download) instead of escalating to processItem's
            // stall handler which would re-unrestrict and record provider failures.
            reject(new Error("write_drain_timeout"));
          }, drainTimeoutMs);

          const cleanup = (): void => {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            active.blockedOnDiskWrite = false;
            active.blockedOnDiskSince = 0;
            stream.off("drain", onDrain);
            stream.off("error", onError);
            active.abortController.signal.removeEventListener("abort", onAbort);
          };

          const onDrain = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve();
          };
          const onError = (streamError: Error): void => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            reject(streamError);
          };
          const onAbort = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            reject(new Error(`aborted:${active.abortReason}`));
          };

          stream.once("drain", onDrain);
          stream.once("error", onError);
          active.abortController.signal.addEventListener("abort", onAbort, { once: true });
        });

        // Write-buffer with 4KB NTFS alignment (JDownloader-style)
        const writeBuf = Buffer.allocUnsafe(WRITE_BUFFER_SIZE);
        let writeBufPos = 0;
        let lastFlushAt = nowMs();

        const alignedFlush = async (final = false): Promise<void> => {
          if (writeBufPos === 0) return;
          let toWrite = writeBufPos;
          if (!final && toWrite > ALLOCATION_UNIT_SIZE) {
            toWrite = toWrite - (toWrite % ALLOCATION_UNIT_SIZE);
          }
          const slice = Buffer.from(writeBuf.subarray(0, toWrite));
          if (!stream.write(slice)) {
            await waitDrain();
          }
          if (toWrite < writeBufPos) {
            writeBuf.copy(writeBuf, 0, toWrite, writeBufPos);
          }
          writeBufPos -= toWrite;
          lastFlushAt = nowMs();
        };

        let bodyError: unknown = null;
        try {
          const body = response.body;
          if (!body) {
            throw new Error("Leerer Response-Body");
          }
          const reader = body.getReader();
          let lastDataAt = nowMs();
          let lastIdleEmitAt = 0;
          const lowThroughputTimeoutMs = getLowThroughputTimeoutMs();
          const lowThroughputMinBytes = getLowThroughputMinBytes();
          let throughputWindowStartedAt = nowMs();
          let throughputWindowBytes = 0;
          const idlePulseMs = Math.max(1500, Math.min(3500, Math.floor(stallTimeoutMs / 4) || 2000));
          const idleTimer = setInterval(() => {
            if (active.abortController.signal.aborted) {
              return;
            }
            const nowTick = nowMs();
            if (active.blockedOnDiskWrite) {
              if (item.status === "paused" || this.session.paused) {
                return;
              }
              if (diskBusyStatusVisible(nowTick) && nowTick - lastIdleEmitAt >= idlePulseMs) {
                item.status = "downloading";
                item.speedBps = 0;
                item.fullStatus = `Warte auf Festplatte (${label})`;
                item.updatedAt = nowTick;
                this.emitState();
                lastIdleEmitAt = nowTick;
                lastDiskBusyEmitAt = nowTick;
              }
              return;
            }
            if (nowTick - lastDataAt < idlePulseMs) {
              return;
            }
            if (item.status === "paused" || this.session.paused) {
              return;
            }
            item.status = "downloading";
            item.speedBps = 0;
            item.fullStatus = `Warte auf Daten (${label})`;
            if (nowTick - lastIdleEmitAt >= idlePulseMs) {
              item.updatedAt = nowTick;
              this.emitState();
              lastIdleEmitAt = nowTick;
              logAttemptEvent("WARN", "Download wartet auf Daten", {
                attempt,
                idleForMs: nowTick - lastDataAt
              });
            }
          }, idlePulseMs);
          const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
            if (stallTimeoutMs <= 0) {
              return reader.read();
            }
            return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) {
                  return;
                }
                settled = true;
                active.abortReason = "stall";
                active.abortController.abort("stall");
                reject(new Error("stall_timeout"));
              }, stallTimeoutMs);

              reader.read().then((result) => {
                if (settled) {
                  return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(result);
              }).catch((error) => {
                if (settled) {
                  return;
                }
                settled = true;
                clearTimeout(timer);
                reject(error);
              });
            });
          };

          try {
            while (true) {
              const { done, value } = await readWithTimeout();
              if (done) {
                break;
              }
              const chunk = value;
              lastDataAt = nowMs();
              if (active.abortController.signal.aborted) {
                throw new Error(`aborted:${active.abortReason}`);
              }
              let pausedDuringWait = false;
              while (this.session.paused && this.session.running && !active.abortController.signal.aborted) {
                pausedDuringWait = true;
                item.status = "paused";
                item.fullStatus = "Pausiert";
                this.emitState();
                await sleep(120);
              }
              if (pausedDuringWait) {
                throughputWindowStartedAt = nowMs();
                throughputWindowBytes = 0;
              }
              if (active.abortController.signal.aborted) {
                throw new Error(`aborted:${active.abortReason}`);
              }
              if (this.reconnectActive()) {
                active.abortReason = "reconnect";
                active.abortController.abort("reconnect");
                throw new Error("aborted:reconnect");
              }

              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              await this.applySpeedLimit(buffer.length, windowBytes, windowStarted, active.abortController.signal);
              if (active.abortController.signal.aborted) {
                throw new Error(`aborted:${active.abortReason}`);
              }

              // Buffer incoming data for aligned writes
              let srcOffset = 0;
              while (srcOffset < buffer.length) {
                const space = WRITE_BUFFER_SIZE - writeBufPos;
                const toCopy = Math.min(space, buffer.length - srcOffset);
                buffer.copy(writeBuf, writeBufPos, srcOffset, srcOffset + toCopy);
                writeBufPos += toCopy;
                srcOffset += toCopy;
                if (writeBufPos >= Math.floor(WRITE_BUFFER_SIZE * 0.80)) {
                  await alignedFlush(false);
                }
              }
              // Time-based flush
              if (writeBufPos > 0 && nowMs() - lastFlushAt >= WRITE_FLUSH_TIMEOUT_MS) {
                await alignedFlush(false);
              }

              // Proactive disk-busy detection: if the stream's internal buffer
              // hasn't drained for DISK_BUSY_THRESHOLD_MS, the OS write calls are
              // lagging — typically because the physical disk can't keep up.  Show
              // "Warte auf Festplatte" immediately instead of waiting for full
              // backpressure (stream.write returning false).
              if (stream.writableLength > 0) {
                if (diskBusySince === 0) diskBusySince = nowMs();
                const busyMs = nowMs() - diskBusySince;
                if (busyMs >= DISK_BUSY_STATUS_THRESHOLD_MS && item.status !== "paused" && !this.session.paused) {
                  const nowTick = nowMs();
                  if (nowTick - lastDiskBusyEmitAt >= 1200) {
                    item.status = "downloading";
                    item.speedBps = 0;
                    item.fullStatus = `Warte auf Festplatte (${label})`;
                    item.updatedAt = nowTick;
                    this.emitState();
                    lastDiskBusyEmitAt = nowTick;
                    logAttemptEvent("WARN", "Festplatten-Backpressure erkannt", {
                      attempt,
                      busyMs
                    });
                  }
                }
              } else {
                diskBusySince = 0;
              }

              written += buffer.length;
              windowBytes += buffer.length;
              this.session.totalDownloadedBytes += buffer.length;
              this.sessionDownloadedBytes += buffer.length;
              this.settings.totalDownloadedAllTime += buffer.length;
              this.recordProviderDownloadedBytes(item.provider, buffer.length, item.providerAccountId);
              this.itemContributedBytes.set(active.itemId, (this.itemContributedBytes.get(active.itemId) || 0) + buffer.length);
              this.recordSpeed(buffer.length, item.packageId);
              throughputWindowBytes += buffer.length;

              // All expected bytes received — break immediately instead of waiting
              // for the server to close the connection.  Some servers/CDNs delay
              // the FIN packet, which would trigger the stall timeout even though
              // the file is already complete.  This especially affects small
              // multi-part archives (e.g. 15-20 × 101 MB) on fast connections.
              // Use totalBytes (from unrestrict or Content-Length header) as
              // primary check, fall back to raw contentLength for providers
              // that don't report fileSize (e.g. Mega-Debrid Web).
              if (completionPlan.canFinishEarly && completionPlan.expectedTotal && written >= completionPlan.expectedTotal) {
                break;
              }

              const throughputNow = nowMs();
              if (lowThroughputTimeoutMs > 0 && throughputNow - throughputWindowStartedAt >= lowThroughputTimeoutMs) {
                if (throughputWindowBytes < lowThroughputMinBytes) {
                  active.abortReason = "stall";
                  active.abortController.abort("stall");
                  throw new Error(`slow_throughput:${throughputWindowBytes}/${lowThroughputMinBytes}`);
                }
                throughputWindowStartedAt = throughputNow;
                throughputWindowBytes = 0;
              }

              const elapsed = Math.max((nowMs() - windowStarted) / 1000, 0.2);
              const speed = windowBytes / elapsed;
              if (elapsed >= 0.5) {
                windowStarted = nowMs();
                windowBytes = 0;
              }

              item.status = "downloading";
              item.downloadedBytes = written;
              item.progressPercent = item.totalBytes ? Math.max(0, Math.min(100, Math.floor((written / item.totalBytes) * 100))) : 0;
              // Keep "Warte auf Festplatte" label if disk is busy; otherwise show normal status
              const diskBusy = diskBusyStatusVisible(nowMs());
              if (diskBusy) {
                item.speedBps = 0;
                item.fullStatus = `Warte auf Festplatte (${label})`;
              } else {
                item.speedBps = Math.max(0, Math.floor(speed));
                item.fullStatus = `Download läuft (${label})`;
              }
              const progressNow = nowMs();
              const currentPercent = item.totalBytes ? Math.max(0, Math.min(100, Math.floor((written / item.totalBytes) * 100))) : 0;
              const shouldLogProgress = currentPercent >= lastLoggedPercent + 10
                || progressNow - lastPackageLogAt >= 5000
                || (item.totalBytes ? written >= item.totalBytes : false);
              if (shouldLogProgress) {
                lastPackageLogAt = progressNow;
                lastLoggedPercent = currentPercent;
                logAttemptEvent("INFO", "Download-Fortschritt", {
                  attempt,
                  written,
                  totalBytes: item.totalBytes,
                  percent: currentPercent,
                  speedBps: item.speedBps,
                  diskBusy
                });
              }
              const nowTick = nowMs();
              if (nowTick - lastUiEmitAt >= uiUpdateIntervalMs) {
                item.updatedAt = nowTick;
                this.emitState();
                lastUiEmitAt = nowTick;
              }
            }
          } finally {
            clearInterval(idleTimer);
            try {
              // Cancel pending reads before releasing the lock so the
              // underlying TCP connection is torn down promptly.
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            } catch {
              // ignore
            }
          }
        } catch (error) {
          bodyError = error;
          logAttemptEvent("WARN", "Download-Body fehlgeschlagen", {
            attempt,
            error: compactErrorText(error)
          });
          throw error;
        } finally {
          // Flush remaining buffered data before closing stream
          try {
            await alignedFlush(true);
          } catch (flushError) {
            if (!bodyError) {
              bodyError = flushError;
            }
          }
          try {
            await new Promise<void>((resolve, reject) => {
              if (stream.closed || stream.destroyed) {
                resolve();
                return;
              }
              const onDone = (): void => {
                stream.off("error", onError);
                stream.off("finish", onDone);
                stream.off("close", onDone);
                resolve();
              };
              const onError = (streamError: Error): void => {
                stream.off("finish", onDone);
                stream.off("close", onDone);
                reject(streamError);
              };
              stream.once("finish", onDone);
              stream.once("close", onDone);
              stream.once("error", onError);
              stream.end();
            });
          } catch (streamCloseError) {
            // Ensure stream is destroyed before re-throwing to avoid file-handle leaks on Windows
            if (!stream.destroyed) {
              stream.destroy();
            }
            if (!bodyError) {
              throw streamCloseError;
            }
            logger.warn(`Stream-Abschlussfehler unterdrückt: ${compactErrorText(streamCloseError)}`);
          }
          // Ensure stream is fully destroyed before potential retry opens new handle
          if (!stream.destroyed) {
            stream.destroy();
          }
          // fsync for pre-allocated files: force OS to flush all pending writes to
          // disk so extraction processes opening the file immediately after download
          // see the complete data (prevents "Checksum error" on Windows when file
          // handles haven't been fully released yet).
          if (!bodyError && preAllocated) {
            try {
              const syncFd = await fs.promises.open(effectiveTargetPath, "r");
              try {
                await syncFd.datasync();
              } finally {
                await syncFd.close();
              }
            } catch { /* best-effort; extraction retry will catch any remaining issues */ }
          }
          // If the body read succeeded but the final flush or stream close failed,
          // propagate the error so the download is retried instead of marked complete.
          if (bodyError) {
            throw bodyError;
          }
        }

        try {
          const finalizedStat = await fs.promises.stat(effectiveTargetPath);
          if (Number.isFinite(finalizedStat.size) && finalizedStat.size >= 0 && finalizedStat.size !== written) {
            logAttemptEvent("WARN", "Dateigroesse nach Stream-Abschluss korrigiert", {
              attempt,
              previousWritten: written,
              statSize: finalizedStat.size
            });
            written = finalizedStat.size;
          }
        } catch {
          // ignore stat race; validation below will handle empty/missing files
        }

        // Detect tiny error-response files (e.g. hoster returning "Forbidden" with HTTP 200).
        // No legitimate file-hoster download is < 512 bytes, EXCEPT known small metadata
        // files like .sfv (checksum verification), .nfo (release info), etc.
        if (written > 0 && written < 512) {
          const knownSmallFile = KNOWN_SMALL_FILE_RE.test(item.fileName || effectiveTargetPath);
          if (knownSmallFile && ((!item.totalBytes || item.totalBytes <= 0) || written >= item.totalBytes)) {
            logger.info(`Kleine Metadaten-Datei akzeptiert (${written} B): ${item.fileName || effectiveTargetPath}`);
          } else {
            let snippet = "";
            try {
              snippet = await fs.promises.readFile(effectiveTargetPath, "utf8");
              snippet = snippet.slice(0, 200).replace(/[\r\n]+/g, " ").trim();
            } catch { /* ignore */ }
            const exactTinyBinary = Boolean(
              item.totalBytes
              && item.totalBytes > 0
              && written >= item.totalBytes
              && isLargeBinaryLikePath(item.fileName || effectiveTargetPath)
            );
            const snippetSuggestsError = /<(?:!doctype|html|body)\b|\b(?:forbidden|access denied|error|not found|expired|unavailable)\b/i.test(snippet);
            if (exactTinyBinary && !snippetSuggestsError) {
              logger.info(`Tiny Binary akzeptiert (${written} B): ${item.fileName || effectiveTargetPath}`);
            } else {
              logger.warn(`Tiny download erkannt (${written} B): "${snippet}"`);
              try {
                await fs.promises.rm(effectiveTargetPath, { force: true });
              } catch { /* ignore */ }
              this.releaseTargetPath(active.itemId);
              this.dropItemContribution(active.itemId);
              item.downloadedBytes = 0;
              item.progressPercent = 0;
              throw new Error(`Download zu klein (${written} B) – Hoster-Fehlerseite?${snippet ? ` Inhalt: "${snippet}"` : ""}`);
            }
          }
        }

        const completionValidation = validateDownloadedFileCompletion({
          actualBytes: written,
          plan: completionPlan,
          toleranceBytes: isLargeBinaryLikePath(item.fileName || effectiveTargetPath) ? 0 : ALLOCATION_UNIT_SIZE
        });
        if (!completionValidation.ok) {
          const shortfall = Math.max(0, completionValidation.totalBytes - written);
          if (preAllocated) {
            try {
              await fs.promises.truncate(effectiveTargetPath, written);
            } catch { /* best-effort */ }
          }
          logger.warn(`Download-Underflow: erwartet=${completionValidation.totalBytes}, erhalten=${written}, shortfall=${shortfall} fuer ${item.fileName}`);
          item.downloadedBytes = written;
          item.progressPercent = completionValidation.totalBytes > 0
            ? Math.max(0, Math.min(99, Math.floor((written / completionValidation.totalBytes) * 100)))
            : 0;
          item.speedBps = 0;
          throw new Error(completionValidation.error || `download_underflow:${written}/${completionValidation.totalBytes}`);
        }

        if (completionValidation.acceptedMetadataMismatch) {
          logger.warn(
            `Provider-Groesseninfo verworfen, HTTP-EOF als vollstaendig akzeptiert: ` +
            `${item.fileName} erwartet=${completionPlan.expectedTotal}, erhalten=${written}`
          );
          logAttemptEvent("WARN", "Provider-Groesseninfo weicht von finaler Dateigroesse ab", {
            attempt,
            expectedTotal: completionPlan.expectedTotal,
            actualBytes: written,
            source: completionPlan.source
          });
        }

        // Truncate pre-allocated files to actual bytes written to prevent zero-padded tail
        if (preAllocated && item.totalBytes && written < item.totalBytes) {
          try {
            await fs.promises.truncate(effectiveTargetPath, written);
          } catch { /* best-effort */ }
          logger.warn(`Pre-alloc underflow: erwartet=${item.totalBytes}, erhalten=${written} für ${item.fileName}`);
        }

        item.downloadedBytes = written;
        item.totalBytes = completionValidation.totalBytes > 0 ? completionValidation.totalBytes : item.totalBytes;
        item.progressPercent = item.totalBytes ? Math.max(0, Math.min(100, Math.floor((written / item.totalBytes) * 100))) : 100;
        item.speedBps = 0;
        item.fullStatus = "Finalisierend...";
        item.updatedAt = nowMs();
        this.emitState();
        logAttemptEvent("INFO", "HTTP-Download-Versuch abgeschlossen", {
          attempt,
          resumable,
          written,
          finalBytes: item.downloadedBytes,
          totalBytes: item.totalBytes,
          targetPath: effectiveTargetPath
        });
        return { resumable };
      } catch (error) {
        // Truncate pre-allocated sparse file to actual written bytes so that
        // stat.size on the next retry reflects real data, not the pre-allocated size.
        // Without this, the retry reads stat.size = totalBytes and either sends an
        // impossible Range header (→ 416 → false complete) or appends to a zero-padded file.
        if (preAllocated && item.totalBytes && written < item.totalBytes) {
          try { await fs.promises.truncate(effectiveTargetPath, written); } catch { /* best-effort */ }
        }
        if (active.abortController.signal.aborted || String(error).includes("aborted:")) {
          throw error;
        }
        lastError = compactErrorText(error);
        const normalizedLastError = lastError.replace(/^Error:\s*/i, "");
        logAttemptEvent("WARN", "HTTP-Download-Versuch fehlgeschlagen", {
          attempt,
          error: lastError,
          targetPath: effectiveTargetPath
        });
        if (
          normalizedLastError.startsWith("range_ignored_on_resume:")
          || normalizedLastError.startsWith("range_mismatch_on_resume:")
        ) {
          throw new Error(`direct_link_retry_exhausted:${normalizedLastError}`);
        }
        if (attempt < maxAttempts && written > existingBytes && shouldRewindResumeTail(normalizedLastError)) {
          resumeRewindBytesNextAttempt = Math.max(resumeRewindBytesNextAttempt, RESUME_REWIND_BYTES);
          logAttemptEvent("WARN", "Resume-Schutz vorgemerkt: naechster Retry startet mit Rewind", {
            attempt,
            existingBytes,
            written,
            appendedBytes: Math.max(0, written - existingBytes),
            rewindBytes: resumeRewindBytesNextAttempt,
            error: normalizedLastError
          });
        }
        if (attempt < maxAttempts) {
          item.retries += 1;
          item.fullStatus = `Downloadfehler, retry ${attempt}/${maxAttempts} (Direktlink)`;
          this.emitState();
          await sleep(retryDelayWithJitter(attempt, 250));
          continue;
        }
        if (maxAttemptsBySetting > maxAttempts) {
          const exhaustedError = existingBytes > 0 && normalizedLastError.startsWith("download_underflow:")
            ? `resume_download_underflow:${normalizedLastError.slice("download_underflow:".length)}`
            : (normalizedLastError || lastError || "Download fehlgeschlagen");
          throw new Error(`direct_link_retry_exhausted:${exhaustedError}`);
        }
        throw new Error(normalizedLastError || lastError || "Download fehlgeschlagen");
      }
    }

    if (maxAttemptsBySetting > maxAttempts) {
      throw new Error(`direct_link_retry_exhausted:${lastError || "Download fehlgeschlagen"}`);
    }
    throw new Error(lastError || "Download fehlgeschlagen");
  }

  private async recoverRetryableItems(trigger: "startup" | "start"): Promise<number> {
    let recovered = 0;
    let finalized = 0;
    const touchedPackages = new Set<string>();
    const configuredRetryLimit = normalizeRetryLimit(this.settings.retryLimit);
    const maxAutoRetryFailures = retryLimitToMaxRetries(configuredRetryLimit);

    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled) {
        continue;
      }

      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item || this.activeTasks.has(itemId)) {
          continue;
        }
        // Only check failed or completed items — skip queued/cancelled to avoid
        // expensive fs.stat calls on hundreds of items (caused 5-10s freeze on start).
        const canFinalizeFromDisk = item.status === "failed"
          || item.status === "completed"
          || item.status === "queued"
          || item.status === "reconnect_wait";
        if (canFinalizeFromDisk) {
          const recoveryReason = `${item.fullStatus || ""} ${item.lastError || ""}`.trim();
          if (shouldPreflightFinalizeItemFromDisk(item)
            && this.tryFinalizeItemFromDisk(pkg, item, `Recovery-${trigger}`, recoveryReason)) {
            finalized += 1;
            touchedPackages.add(pkg.id);
            this.retryAfterByItem.delete(item.id);
            this.retryStateByItem.delete(item.id);
            continue;
          }
        }
        if (item.status !== "failed" && item.status !== "completed") {
          continue;
        }

        const is416Failure = item.status === "failed" && this.isHttp416Failure(item);
        const hasZeroByteArchive = await this.hasZeroByteArchiveArtifact(item);

        if (item.status === "failed") {
          if (!is416Failure && !hasZeroByteArchive && item.retries >= maxAutoRetryFailures) {
            continue;
          }
          this.queueItemForRetry(item, {
            hardReset: is416Failure || hasZeroByteArchive,
            reason: is416Failure
              ? "Wartet (Auto-Retry: HTTP 416)"
              : hasZeroByteArchive
                ? "Wartet (Auto-Retry: 0B-Datei)"
                : "Wartet (Auto-Retry)"
          });
          recovered += 1;
          touchedPackages.add(pkg.id);
          continue;
        }

        if (item.status === "completed" && hasZeroByteArchive) {
          const maxCompletedZeroByteAutoRetries = retryLimitToMaxRetries(configuredRetryLimit);
          if (item.retries >= maxCompletedZeroByteAutoRetries) {
            continue;
          }
          item.retries += 1;
          this.queueItemForRetry(item, {
            hardReset: true,
            reason: "Wartet (Auto-Retry: 0B-Datei)"
          });
          recovered += 1;
          touchedPackages.add(pkg.id);
        }
      }
    }

    if (recovered > 0 || finalized > 0) {
      for (const packageId of touchedPackages) {
        const pkg = this.session.packages[packageId];
        if (!pkg) {
          continue;
        }
        this.refreshPackageStatus(pkg);
      }
      logger.warn(
        `Auto-Retry-Recovery (${trigger}): ${recovered} Item(s) wieder in Queue gesetzt, ` +
        `${finalized} Item(s) direkt von Disk vervollstaendigt`
      );
      this.persistSoon();
      this.emitState();
    }

    return recovered + finalized;
  }

  private queueItemForRetry(item: DownloadItem, options: { hardReset: boolean; reason: string }): void {
    this.retryStateByItem.delete(item.id);
    const targetPath = String(item.targetPath || "").trim();
    if (options.hardReset && targetPath) {
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        // ignore
      }
      this.releaseTargetPath(item.id);
      item.downloadedBytes = 0;
      item.totalBytes = null;
      item.progressPercent = 0;
      this.dropItemContribution(item.id);
    }

    item.status = "queued";
    item.speedBps = 0;
    item.attempts = 0;
    item.lastError = "";
    item.resumable = true;
    item.fullStatus = options.reason;
    item.updatedAt = nowMs();
  }

  private isHttp416Failure(item: DownloadItem): boolean {
    const text = `${item.lastError} ${item.fullStatus}`;
    return /(^|\D)416(\D|$)/.test(text);
  }

  private async hasZeroByteArchiveArtifact(item: DownloadItem): Promise<boolean> {
    const targetPath = String(item.targetPath || "").trim();
    const archiveCandidate = isArchiveLikePath(targetPath || item.fileName);
    if (!archiveCandidate) {
      return false;
    }

    if (targetPath) {
      try {
        const stat = await fs.promises.stat(targetPath);
        return stat.size <= 0;
      } catch {
        // file does not exist
      }
    }

    if (item.downloadedBytes <= 0 && item.progressPercent >= 100) {
      return true;
    }

    return /\b0\s*B\b/i.test(item.fullStatus || "");
  }

  private refreshPackageStatus(pkg: PackageEntry): void {
    let pending = 0;
    let success = 0;
    let failed = 0;
    let cancelled = 0;
    let total = 0;
    for (const itemId of pkg.itemIds) {
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      total += 1;
      const s = item.status;
      if (s === "completed") {
        success += 1;
      } else if (s === "failed") {
        failed += 1;
      } else if (s === "cancelled") {
        cancelled += 1;
      } else {
        pending += 1;
      }
    }
    if (total === 0) {
      return;
    }

    if (pending > 0) {
      pkg.status = pkg.enabled ? "queued" : "paused";
      pkg.updatedAt = nowMs();
      return;
    }

    if (failed > 0) {
      pkg.status = "failed";
    } else if (cancelled > 0) {
      pkg.status = success > 0 ? "completed" : "cancelled";
    } else if (success > 0) {
      pkg.status = "completed";
    }
    pkg.updatedAt = nowMs();
  }

  private cachedSpeedLimitKbps = 0;

  private cachedSpeedLimitAt = 0;

  private globalSpeedLimitQueue: Promise<void> = Promise.resolve();

  private globalSpeedLimitNextAt = 0;

  private getEffectiveSpeedLimitKbps(): number {
    const now = nowMs();
    if (now - this.cachedSpeedLimitAt < 2000) {
      return this.cachedSpeedLimitKbps;
    }
    this.cachedSpeedLimitAt = now;
    const schedules = this.settings.bandwidthSchedules;
    if (schedules.length > 0) {
      const hour = new Date().getHours();
      let allDayLimit: number | null = null;
      for (const entry of schedules) {
        if (!entry.enabled) {
          continue;
        }
        if (entry.startHour === entry.endHour) {
          // "All day" schedule — use as fallback, don't block more specific schedules
          if (allDayLimit === null) {
            allDayLimit = entry.speedLimitKbps;
          }
          continue;
        }
        const wraps = entry.startHour > entry.endHour;
        const inRange = wraps
          ? hour >= entry.startHour || hour < entry.endHour
          : hour >= entry.startHour && hour < entry.endHour;
        if (inRange) {
          this.cachedSpeedLimitKbps = entry.speedLimitKbps;
          return this.cachedSpeedLimitKbps;
        }
      }
      if (allDayLimit !== null) {
        this.cachedSpeedLimitKbps = allDayLimit;
        return this.cachedSpeedLimitKbps;
      }
    }
    if (this.settings.speedLimitEnabled && this.settings.speedLimitKbps > 0) {
      this.cachedSpeedLimitKbps = this.settings.speedLimitKbps;
      return this.cachedSpeedLimitKbps;
    }
    this.cachedSpeedLimitKbps = 0;
    return 0;
  }

  private async applyGlobalSpeedLimit(chunkBytes: number, bytesPerSecond: number, signal?: AbortSignal): Promise<void> {
    const task = this.globalSpeedLimitQueue
      .catch(() => undefined)
      .then(async () => {
        if (signal?.aborted) {
          throw new Error("aborted:speed_limit");
        }
        const now = nowMs();
        const waitMs = Math.max(0, this.globalSpeedLimitNextAt - now);
        if (waitMs > 0) {
          await new Promise<void>((resolve, reject) => {
            let timer: NodeJS.Timeout | null = setTimeout(() => {
              timer = null;
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              resolve();
            }, waitMs);

            const onAbort = (): void => {
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              signal?.removeEventListener("abort", onAbort);
              reject(new Error("aborted:speed_limit"));
            };

            if (signal) {
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        }

        if (signal?.aborted) {
          throw new Error("aborted:speed_limit");
        }

        const startAt = Math.max(nowMs(), this.globalSpeedLimitNextAt);
        const durationMs = Math.max(1, Math.ceil((chunkBytes / bytesPerSecond) * 1000));
        this.globalSpeedLimitNextAt = startAt + durationMs;
      });

    this.globalSpeedLimitQueue = task;
    await task;
  }

  private async applySpeedLimit(chunkBytes: number, localWindowBytes: number, localWindowStarted: number, signal?: AbortSignal): Promise<void> {
    const limitKbps = this.getEffectiveSpeedLimitKbps();
    if (limitKbps <= 0) {
      return;
    }
    const bytesPerSecond = limitKbps * 1024;
    const now = nowMs();
    const elapsed = Math.max((now - localWindowStarted) / 1000, 0.1);
    if (this.settings.speedLimitMode === "per_download") {
      const projected = localWindowBytes + chunkBytes;
      const allowed = bytesPerSecond * elapsed;
      if (projected > allowed) {
        const sleepMs = Math.ceil(((projected - allowed) / bytesPerSecond) * 1000);
        if (sleepMs > 0) {
          await new Promise<void>((resolve, reject) => {
            let timer: NodeJS.Timeout | null = setTimeout(() => {
              timer = null;
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              resolve();
            }, Math.min(300, sleepMs));

            const onAbort = (): void => {
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              signal?.removeEventListener("abort", onAbort);
              reject(new Error("aborted:speed_limit"));
            };

            if (signal) {
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        }
      }
      return;
    }

    await this.applyGlobalSpeedLimit(chunkBytes, bytesPerSecond, signal);
  }

  private async findReadyArchiveSets(pkg: PackageEntry): Promise<Set<string>> {
    const ready = new Set<string>();
    if (!pkg.outputDir) {
      return ready;
    }
    try {
      await fs.promises.access(pkg.outputDir);
    } catch {
      return ready;
    }

    const completedPaths = new Set<string>();
    const pendingPaths = new Set<string>();
    for (const itemId of pkg.itemIds) {
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      if (item.status === "completed" && item.targetPath) {
        completedPaths.add(pathKey(item.targetPath));
      } else {
        if (item.targetPath) {
          pendingPaths.add(pathKey(item.targetPath));
        }
        // Items that haven't started yet have no targetPath but may have a fileName.
        // Include their projected path so the archive-readiness check doesn't
        // prematurely trigger extraction while parts are still queued.
        if (item.fileName && pkg.outputDir) {
          pendingPaths.add(pathKey(path.join(pkg.outputDir, item.fileName)));
        }
      }
    }
    if (completedPaths.size === 0) {
      return ready;
    }

    const candidates = await findArchiveCandidates(pkg.outputDir);
    if (candidates.length === 0) {
      return ready;
    }

    let dirFiles: string[] | undefined;
    try {
      dirFiles = (await fs.promises.readdir(pkg.outputDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return ready;
    }

    const packageItems = pkg.itemIds
      .map((itemId) => this.session.items[itemId])
      .filter(Boolean) as DownloadItem[];

    for (const candidate of candidates) {
      const partsOnDisk = collectArchiveCleanupTargets(candidate, dirFiles);
      const allPartsCompleted = partsOnDisk.every((part) => completedPaths.has(pathKey(part)));
      if (allPartsCompleted) {
        const hasUnstartedParts = [...pendingPaths].some((pendingPath) => {
          const pendingName = path.basename(pendingPath).toLowerCase();
          const candidateStem = path.basename(candidate).toLowerCase();
          return this.looksLikeArchivePart(pendingName, candidateStem);
        });
        if (hasUnstartedParts) {
          continue;
        }
        ready.add(pathKey(candidate));
        continue;
      }

      // Safe disk-fallback: only allow extraction when every tracked archive item
      // already exists on disk at full size and the persisted byte counters
      // also indicate a finished download. This recovers stale status after a
      // crash without letting unrelated .rev files or freshly re-queued items
      // look "ready".
      const archiveItems = resolveArchiveItemsFromList(path.basename(candidate), packageItems);
      if (archiveItems.length === 0) {
        continue;
      }
      const hasActiveArchiveItem = archiveItems.some((item) =>
        item.status === "downloading" || item.status === "validating" || item.status === "integrity_check"
      );
      if (hasActiveArchiveItem) {
        continue;
      }
      const allArchiveItemsReadyOnDisk = archiveItems.every((item) => inspectPackageItemDiskState(pkg, item).reason === "ok");
      if (!allArchiveItemsReadyOnDisk) {
        continue;
      }
      const nonCompletedCount = archiveItems.filter((item) => item.status !== "completed").length;
      logger.info(`Hybrid-Extract Disk-Fallback: ${path.basename(candidate)} (${nonCompletedCount} Part(s) laut Session ohne completed-Status)`);
      ready.add(pathKey(candidate));
      continue;
    }

    return ready;
  }

  private findItemByDiskPath(pkg: PackageEntry, diskPath: string): DownloadItem | undefined {
    const key = pathKey(diskPath);
    for (const itemId of pkg.itemIds) {
      const item = this.session.items[itemId];
      if (!item) continue;
      if (item.targetPath && pathKey(item.targetPath) === key) return item;
      if (item.fileName && pkg.outputDir && pathKey(path.join(pkg.outputDir, item.fileName)) === key) return item;
    }
    return undefined;
  }

  private looksLikeArchivePart(fileName: string, entryPointName: string): boolean {
    const multipartMatch = entryPointName.match(/^(.*)\.part0*1\.rar$/i);
    if (multipartMatch) {
      const prefix = multipartMatch[1].toLowerCase();
      return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.part\\d+\\.rar$`, "i").test(fileName);
    }
    if (/\.rar$/i.test(entryPointName) && !/\.part\d+\.rar$/i.test(entryPointName)) {
      const stem = entryPointName.replace(/\.rar$/i, "").toLowerCase();
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}\\.r(ar|\\d{2,3})$`, "i").test(fileName);
    }
    if (/\.zip\.001$/i.test(entryPointName)) {
      const stem = entryPointName.replace(/\.zip\.001$/i, "").toLowerCase();
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}\\.zip(\\.\\d+)?$`, "i").test(fileName);
    }
    if (/\.7z\.001$/i.test(entryPointName)) {
      const stem = entryPointName.replace(/\.7z\.001$/i, "").toLowerCase();
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}\\.7z(\\.\\d+)?$`, "i").test(fileName);
    }
    // Generic .NNN splits (e.g., movie.001, movie.002)
    if (/\.001$/i.test(entryPointName) && !/\.(zip|7z)\.001$/i.test(entryPointName)) {
      const stem = entryPointName.replace(/\.001$/i, "").toLowerCase();
      const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}\\.\\d{3}$`, "i").test(fileName);
    }
    return false;
  }

  private async runHybridExtraction(packageId: string, pkg: PackageEntry, items: DownloadItem[], signal?: AbortSignal): Promise<number> {
    // Fix obfuscated archive filenames before archive discovery.
    const completedForDeobfuscation = items.filter((item) => item.status === "completed");
    await this.deobfuscateArchiveFiles(pkg, completedForDeobfuscation, signal);
    if (signal?.aborted) return 0;

    const findReadyStart = nowMs();
    const readyArchives = await this.findReadyArchiveSets(pkg);
    const findReadyMs = nowMs() - findReadyStart;
    if (findReadyMs > 200) {
      logger.info(`findReadyArchiveSets dauerte ${(findReadyMs / 1000).toFixed(1)}s: pkg=${pkg.name}, found=${readyArchives.size}`);
    }

    const completedItems = items.filter((item) => item.status === "completed");

    // Skip archives already attempted in the current package/archive state to prevent
    // infinite re-extraction of disk-fallback archives or repeated unchanged failures.
    const alreadyTried = this.hybridExtractedPaths.get(packageId);
    if (alreadyTried) {
      for (const key of [...readyArchives]) {
        if (alreadyTried.has(key)) {
          readyArchives.delete(key);
        }
      }
    }

    const failedArchiveStates = this.hybridFailedArchives.get(packageId);
    if (failedArchiveStates) {
      for (const archiveKey of [...readyArchives]) {
        const previousFailure = failedArchiveStates.get(archiveKey);
        if (!previousFailure) {
          continue;
        }

        const archiveItems = resolveArchiveItemsFromList(path.basename(archiveKey), completedItems);
        const allItemsStillInError = archiveItems.length > 0 && archiveItems.every((item) => isExtractErrorLabel(item.fullStatus));
        const retryMarker = this.buildHybridArchiveRetryMarker(pkg, items, archiveKey);
        if (!allItemsStillInError || previousFailure.marker !== retryMarker) {
          continue;
        }

        logger.info(
          `Hybrid-Extract Skip: ${path.basename(archiveKey)} unveraendert seit letztem Fehler ` +
          `(${compactErrorText(previousFailure.lastError)})`
        );
        readyArchives.delete(archiveKey);
      }
    }

    if (readyArchives.size === 0) {
      logger.info(`Hybrid-Extract: pkg=${pkg.name}, keine fertigen Archive-Sets`);
      return 0;
    }

    logger.info(`Hybrid-Extract Start: pkg=${pkg.name}, readyArchives=${readyArchives.size}`);
    pkg.status = "extracting";
    this.emitState();
    const hybridExtractStartMs = nowMs();

    // Build set of file names belonging to ready archives (for matching items)
    const hybridFileNames = new Set<string>();
    let dirFiles: string[] | undefined;
    try {
      dirFiles = (await fs.promises.readdir(pkg.outputDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch { /* ignore */ }
    const archiveStems = new Set<string>();
    for (const archiveKey of readyArchives) {
      const parts = collectArchiveCleanupTargets(archiveKey, dirFiles);
      for (const part of parts) {
        const partName = path.basename(part).toLowerCase();
        hybridFileNames.add(partName);
        // Collect archive base stems (strip all archive extensions) to find companion files
        const stem = partName
          .replace(/\.part\d+\.rar$/i, "")
          .replace(/\.(rar|r\d{2,3}|zip|z\d{2,3}|7z|tar|gz|bz2|xz|tgz|tbz2|txz|rev)$/i, "")
          .replace(/\.(zip|7z)\.\d{3}$/i, "")
          .replace(/\.\d{3}$/i, "");
        if (stem && stem !== partName) archiveStems.add(stem);
      }
      hybridFileNames.add(path.basename(archiveKey).toLowerCase());
    }
    // Include companion metadata files (.sfv, .nfo, etc.) that belong to the same archive set.
    // These files share the same basename stem as the archive parts.
    if (dirFiles && archiveStems.size > 0) {
      for (const fileName of dirFiles) {
        const lower = fileName.toLowerCase();
        if (!KNOWN_SMALL_FILE_RE.test(lower)) continue;
        const companionStem = lower.replace(/\.[^.]+$/, "");
        if (archiveStems.has(companionStem)) {
          hybridFileNames.add(lower);
        }
      }
    }
    const isHybridItem = (item: DownloadItem): boolean => {
      if (item.targetPath && hybridFileNames.has(path.basename(item.targetPath).toLowerCase())) {
        return true;
      }
      if (item.fileName && hybridFileNames.has(item.fileName.toLowerCase())) {
        return true;
      }
      return false;
    };
    const hybridItems = completedItems.filter(isHybridItem);

    // If all items belonging to ready archives are already extracted from
    // a previous hybrid round, there is nothing new to extract.
    if (hybridItems.length > 0 && hybridItems.every((item) => isExtractedLabel(item.fullStatus))) {
      logger.info(`Hybrid-Extract: pkg=${pkg.name}, alle ${hybridItems.length} Items bereits entpackt, überspringe`);
      return 0;
    }

    // Filter out archives whose items are ALL already extracted so we don't
    // re-extract them.  Build per-archive item map first.
    for (const archiveKey of [...readyArchives]) {
      const archiveParts = collectArchiveCleanupTargets(archiveKey, dirFiles);
      const archivePartNames = new Set<string>();
      archivePartNames.add(path.basename(archiveKey).toLowerCase());
      for (const part of archiveParts) {
        archivePartNames.add(path.basename(part).toLowerCase());
      }
      const archiveItems = completedItems.filter((item) => {
        const targetName = item.targetPath ? path.basename(item.targetPath).toLowerCase() : "";
        const fileName = (item.fileName || "").toLowerCase();
        return archivePartNames.has(targetName) || archivePartNames.has(fileName);
      });
      if (archiveItems.length > 0 && archiveItems.every((item) => isExtractedLabel(item.fullStatus))) {
        readyArchives.delete(archiveKey);
      }
    }
    if (readyArchives.size === 0) {
      logger.info(`Hybrid-Extract: pkg=${pkg.name}, alle fertigen Archive bereits entpackt`);
      return 0;
    }

    // Resolve archive items dynamically from ALL package items (not just
    // the stale completedItems snapshot) so items that complete during
    // extraction are included and get the correct "Done" label.
    const resolveArchiveItems = (archiveName: string): DownloadItem[] =>
      resolveArchiveItemsFromList(archiveName, items);

    const readyArchiveKeyByName = new Map<string, string>();
    const readyArchiveMarkers = new Map<string, string>();
    for (const archiveKey of readyArchives) {
      readyArchiveKeyByName.set(path.basename(archiveKey).toLowerCase(), archiveKey);
      readyArchiveMarkers.set(archiveKey, this.buildHybridArchiveRetryMarker(pkg, items, archiveKey));
    }

    // Track archives for parallel hybrid extraction progress
    const autoRecoveredArchives = new Set<string>();
    const failedArchiveErrors = new Map<string, string>();
    const hybridResolvedItems = new Map<string, DownloadItem[]>();
    const hybridStartTimes = new Map<string, number>();
    let hybridLastEmitAt = 0;
    let hybridLastProgressCurrent: number | null = null;

    // Mark items based on whether their archive is actually ready for extraction.
    // Only items whose archive is in readyArchives get "Ausstehend"; others keep
    // their current label to avoid flicker between hybrid runs.
    const allDownloaded = completedItems.length >= items.length;
    let labelsChanged = false;
    for (const entry of completedItems) {
      if (isExtractedLabel(entry.fullStatus)) {
        continue;
      }
      if (isExtractErrorLabel(entry.fullStatus)) {
        continue;
      }
      const belongsToReady = allDownloaded
        || hybridFileNames.has((entry.fileName || "").toLowerCase())
        || (entry.targetPath && hybridFileNames.has(path.basename(entry.targetPath).toLowerCase()));
      const targetLabel = belongsToReady ? "Entpacken - Ausstehend" : "Entpacken - Warten auf Parts";
      if (entry.fullStatus !== targetLabel) {
        entry.fullStatus = targetLabel;
        entry.updatedAt = nowMs();
        labelsChanged = true;
      }
    }
    if (labelsChanged) {
      this.emitState();
    }

    try {
      await this.waitForCompletedArchiveFilesToSettle(pkg, hybridItems, signal, "hybrid");
      if (signal?.aborted) {
        return 0;
      }

      const result = await extractPackageArchives({
        packageDir: pkg.outputDir,
        targetDir: pkg.extractDir,
        cleanupMode: this.settings.cleanupMode,
        conflictMode: this.settings.extractConflictMode,
        removeLinks: false,
        removeSamples: false,
        passwordList: this.settings.archivePasswordList,
        signal,
        onlyArchives: readyArchives,
        skipPostCleanup: true,
        packageId,
        hybridMode: true,
        maxParallel: this.settings.maxParallelExtract || 2,
        extractCpuPriority: "high",
        onLog: (level, message) => this.logExtractionForItems(pkg, items, "Hybrid-Extractor", level, message),
        onArchiveFailure: (failure) => {
          const failedArchiveKey = readyArchiveKeyByName.get(String(failure.archiveName || "").toLowerCase());
          if (failedArchiveKey) {
            failedArchiveErrors.set(failedArchiveKey, failure.errorText || failure.jvmFailureReason || "Entpacken fehlgeschlagen");
          }
          if (autoRecoveredArchives.has(failure.archiveName)) {
            return;
          }
          const changed = this.autoRecoverArchiveCrcFailure(pkg, items, failure, "hybrid");
          if (changed > 0) {
            autoRecoveredArchives.add(failure.archiveName);
          }
        },
        onProgress: (progress) => {
          if (progress.phase === "preparing") {
            pkg.postProcessLabel = progress.archiveName || "Vorbereiten...";
            this.emitState();
            return;
          }
          if (progress.phase === "done") {
            hybridResolvedItems.clear();
            hybridStartTimes.clear();
            hybridLastProgressCurrent = null;
            return;
          }

          const currentCount = Math.max(0, Number(progress.current ?? 0));
          const archiveFinished = progress.archiveDone === true
            || (hybridLastProgressCurrent !== null && currentCount > hybridLastProgressCurrent);
          hybridLastProgressCurrent = currentCount;

          if (progress.archiveName) {
            // Resolve items for this archive if not yet tracked
            if (!hybridResolvedItems.has(progress.archiveName)) {
              const resolved = resolveArchiveItems(progress.archiveName);
              hybridResolvedItems.set(progress.archiveName, resolved);
              hybridStartTimes.set(progress.archiveName, nowMs());
              if (resolved.length === 0) {
                logger.warn(`resolveArchiveItems (hybrid): KEINE Items gefunden für archiveName="${progress.archiveName}", items.length=${items.length}, itemNames=[${items.map((i) => path.basename(i.targetPath || i.fileName || "?")).join(", ")}]`);
              } else {
                logger.info(`resolveArchiveItems (hybrid): ${resolved.length} Items für archiveName="${progress.archiveName}"`);
                const initLabel = `Entpacken 0% · ${progress.archiveName}`;
                const initAt = nowMs();
                for (const entry of resolved) {
                  if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) {
                    continue;
                  }
                  if (!isExtractedLabel(entry.fullStatus)) {
                    entry.fullStatus = initLabel;
                    entry.updatedAt = initAt;
                  }
                }
                hybridLastEmitAt = initAt;
                this.emitState(true);
              }
            }
            const archItems = hybridResolvedItems.get(progress.archiveName) || [];

            // Only mark as finished on explicit archive-done signal (or real current increment),
            // never on raw 100% archivePercent, because password retries can report 100% mid-run.
            if (archiveFinished) {
              const doneAt = nowMs();
              const startedAt = hybridStartTimes.get(progress.archiveName) || doneAt;
              const doneLabel = progress.archiveSuccess === false
                ? "Entpacken - Error"
                : formatExtractDone(doneAt - startedAt);
              const archiveKey = readyArchiveKeyByName.get(progress.archiveName.toLowerCase());
              if (archiveKey && progress.archiveSuccess !== false) {
                this.clearHybridArchiveState(packageId, archiveKey);
              }
              for (const entry of archItems) {
                if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) continue;
                entry.fullStatus = doneLabel;
                entry.updatedAt = doneAt;
              }
              hybridResolvedItems.delete(progress.archiveName);
              hybridStartTimes.delete(progress.archiveName);
              // Show transitional label while next archive initializes
              const done = currentCount;
              if (done < progress.total) {
                pkg.postProcessLabel = `Entpacken (${done}/${progress.total}) - Nächstes Archiv...`;
                this.emitState();
              }
            } else {
              // Update this archive's items with per-archive progress
              const archiveLabel = ` · ${progress.archiveName}`;
              const elapsed = progress.elapsedMs && progress.elapsedMs >= 1000
                ? ` · ${Math.floor(progress.elapsedMs / 1000)}s`
                : "";
              const archivePct = Math.max(0, Math.min(100, Math.floor(Number(progress.archivePercent ?? 0))));
              const isFinalizing = archivePct >= 99;
              let label: string;
              if (progress.passwordFound) {
                label = `Passwort gefunden · ${progress.archiveName}`;
              } else if (progress.passwordAttempt && progress.passwordTotal && progress.passwordTotal > 1) {
                const pwPct = Math.round((progress.passwordAttempt / progress.passwordTotal) * 100);
                label = `Passwort knacken: ${pwPct}% (${progress.passwordAttempt}/${progress.passwordTotal}) · ${progress.archiveName}`;
              } else if (isFinalizing) {
                label = `Finalisieren${archiveLabel}${elapsed}`;
              } else {
                label = `Entpacken ${archivePct}%${archiveLabel}${elapsed}`;
              }
              const updatedAt = nowMs();
              for (const entry of archItems) {
                if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus) || entry.fullStatus === label) continue;
                entry.fullStatus = label;
                entry.updatedAt = updatedAt;
              }
            }
          }

          // Update package-level label with overall extraction progress
          const activeArchive = !archiveFinished && Number(progress.archivePercent ?? 0) > 0 ? 1 : 0;
          const currentDisplay = Math.max(0, Math.min(progress.total, progress.current + activeArchive));
          if (progress.passwordFound) {
            pkg.postProcessLabel = `Passwort gefunden · ${progress.archiveName || ""}`;
          } else if (progress.passwordAttempt && progress.passwordTotal && progress.passwordTotal > 1) {
            const pwPct = Math.round((progress.passwordAttempt / progress.passwordTotal) * 100);
            pkg.postProcessLabel = `Passwort knacken: ${pwPct}%`;
          } else if (Number(progress.archivePercent ?? 0) >= 99) {
            const archive = progress.archiveName ? ` · ${progress.archiveName}` : "";
            const elapsed = progress.elapsedMs && progress.elapsedMs >= 1000
              ? ` · ${Math.floor(progress.elapsedMs / 1000)}s`
              : "";
            pkg.postProcessLabel = `Finalisieren (${currentDisplay}/${progress.total})${archive}${elapsed}`;
          } else {
            pkg.postProcessLabel = `Entpacken ${progress.percent}% (${currentDisplay}/${progress.total})`;
          }

          // Throttled emit — also promote "Warten auf Parts" items that
          // completed downloading in the meantime to "Ausstehend".
          const now = nowMs();
          if (now - hybridLastEmitAt >= EXTRACT_PROGRESS_EMIT_INTERVAL_MS) {
            hybridLastEmitAt = now;
            for (const entry of items) {
              if (entry.status === "completed" && entry.fullStatus === "Entpacken - Warten auf Parts") {
                entry.fullStatus = "Entpacken - Ausstehend";
                entry.updatedAt = now;
              }
            }
            this.emitState();
          }
        }
      });

      logger.info(`Hybrid-Extract Ende: pkg=${pkg.name}, extracted=${result.extracted}, failed=${result.failed}`);
      this.logPackageForPackage(pkg, "INFO", "Hybrid-Extract abgeschlossen", {
        extracted: result.extracted,
        failed: result.failed
      });
      // Mark all attempted archives as tried so they are not retried in subsequent
      // requeue rounds of the same post-processing session (prevents infinite loop
      // when disk-fallback archives have no corresponding session items).
      {
        let tried = this.hybridExtractedPaths.get(packageId);
        if (!tried) { tried = new Set(); this.hybridExtractedPaths.set(packageId, tried); }
        for (const key of readyArchives) { tried.add(key); }
      }
      if (failedArchiveErrors.size > 0) {
        let failed = this.hybridFailedArchives.get(packageId);
        if (!failed) {
          failed = new Map();
          this.hybridFailedArchives.set(packageId, failed);
        }
        const failedAt = nowMs();
        for (const [archiveKey, errorText] of failedArchiveErrors.entries()) {
          const marker = readyArchiveMarkers.get(archiveKey);
          if (!marker) {
            continue;
          }
          failed.set(archiveKey, {
            marker,
            lastError: errorText,
            updatedAt: failedAt
          });
        }
      }
      if (result.extracted > 0) {
        // Fire-and-forget: rename then collect MKVs in background so the
        // slot is not blocked and the next archive set can start immediately.
        // Both operations route through chainPackageFileOp so they cannot
        // race with the deferred-post-process pipe's rename / mkvMove for
        // the same package — without that, hybrid mkvMove could move a
        // file while deferred rename was still scanning it (ENOENT).
        //
        // Der Controller wird SYNCHRON (vor dem void-Promise) registriert, damit
        // es kein Zeitfenster gibt in dem packagePostProcessTasks leer UND die
        // Hybrid-Arbeit ungetrackt ist. shouldAbort stoppt Rename + MKV-Collect
        // bei Stop/Shutdown/Cancel/Reset oder wenn das Package ersetzt wurde. (H2)
        const hybridController = new AbortController();
        let hybridSet = this.packageHybridPostProcessControllers.get(packageId);
        if (!hybridSet) {
          hybridSet = new Set<AbortController>();
          this.packageHybridPostProcessControllers.set(packageId, hybridSet);
        }
        hybridSet.add(hybridController);
        const hybridShouldAbort = (): boolean => hybridController.signal.aborted || this.session.packages[packageId] !== pkg;
        void (async () => {
          // Atomare Kopplung von Rename + Collect in EINER chainPackageFileOp-Kette,
          // damit zwischen ihnen keine andere (ueberlappende) Hybrid-Runde ihren
          // Collect einschieben kann (das war der Rename-Race: ein Collect moved
          // eine Datei bevor der zugehoerige Rename lief). Wichtig: die IMPL-Variante
          // des Renames verwenden — die Public-Variante ruft selbst chainPackageFileOp
          // auf, was hier zu verschachteltem Chaining (Deadlock) fuehren wuerde.
          // deferFreshFiles=true: Dateien die der Rename als "noch frisch" auslaesst
          // werden vom Collect ebenfalls deferred (statt mit Original-Namen gemoved).
          try {
            await this.chainPackageFileOp(pkg.id, async () => {
              await this.autoRenameExtractedVideoFilesImpl(pkg.extractDir, pkg, hybridShouldAbort);
              await this.collectMkvFilesToLibrary(packageId, pkg, hybridShouldAbort, true);
            });
          } catch (err) {
            logger.warn(`Hybrid Post-Extract (Rename+Collect) Fehler: pkg=${pkg.name}, reason=${compactErrorText(err)}`);
          } finally {
            const set = this.packageHybridPostProcessControllers.get(packageId);
            if (set) {
              set.delete(hybridController);
              if (set.size === 0) {
                this.packageHybridPostProcessControllers.delete(packageId);
              }
            }
          }
        })();
      }
      if (result.failed > 0) {
        logger.warn(`Hybrid-Extract: ${result.failed} Archive fehlgeschlagen, werden erst nach echter Aenderung oder manuellem Retry erneut versucht`);
      }

      // Mark hybrid items with final status — only items whose archives were
      // actually in the extraction set (hybridItems), NOT all completedItems.
      // Using completedItems here would falsely mark items whose archives
      // weren't ready yet (e.g. part2 of an episode where part1 is still
      // downloading) as "Done".
      const updatedAt = nowMs();
      for (const entry of hybridItems) {
        if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) {
          continue;
        }
        const status = entry.fullStatus || "";
        if (/^Entpacken\b/i.test(status) || /^Passwort\b/i.test(status)) {
          if (result.failed > 0) {
            entry.fullStatus = "Entpacken - Error";
          } else if (result.extracted > 0) {
            entry.fullStatus = formatExtractDone(nowMs() - hybridExtractStartMs);
          } else if (KNOWN_SMALL_FILE_RE.test(entry.fileName || "")) {
            // Companion metadata files (.sfv, .nfo, .md5) are not archives themselves.
            // If no archives were extracted (already done in a prior round) and no
            // failures occurred, mark companions as extracted so they don't stay stuck.
            entry.fullStatus = "Entpackt (Metadaten)";
          }
          // extracted === 0 && failed === 0 for archive items: keep current status
          entry.updatedAt = updatedAt;
        }
      }
      return result.extracted;
    } catch (error) {
      const errorText = String(error || "");
      if (errorText.includes("aborted:extract")) {
        logger.info(`Hybrid-Extract abgebrochen: pkg=${pkg.name}`);
        const abortAt = nowMs();
        for (const entry of hybridItems) {
          if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus || "")) continue;
          if (/^Entpacken\b/i.test(entry.fullStatus || "") || /^Passwort\b/i.test(entry.fullStatus || "")) {
            entry.fullStatus = "Entpacken abgebrochen (wird fortgesetzt)";
            entry.updatedAt = abortAt;
          }
        }
        return 0;
      }
      logger.warn(`Hybrid-Extract Fehler: pkg=${pkg.name}, reason=${compactErrorText(error)}`);
      const errorAt = nowMs();
      for (const entry of hybridItems) {
        if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus || "")) continue;
        if (/^Entpacken\b/i.test(entry.fullStatus || "") || /^Passwort\b/i.test(entry.fullStatus || "")) {
          entry.fullStatus = `Entpacken - Error`;
          entry.updatedAt = errorAt;
        }
      }
    }
    return 0;
  }

  private async handlePackagePostProcessing(packageId: string, signal?: AbortSignal): Promise<void> {
    const handleStart = nowMs();
    const pkg = this.session.packages[packageId];
    if (!pkg || pkg.cancelled) {
      return;
    }
    if (signal?.aborted) {
      return;
    }
    const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];

    // Recover items whose file exists on disk but status was never set to "completed".
    // Only recover items in idle states (queued/paused), never active ones (downloading/validating).
    const recoveryStart = nowMs();
    for (const item of items) {
      if (isFinishedStatus(item.status)) {
        continue;
      }
      if (item.status === "downloading" || item.status === "validating" || item.status === "integrity_check") {
        continue;
      }
      if (!item.targetPath) {
        continue;
      }
      if (!isPathInsideDir(item.targetPath, pkg.outputDir)) {
        logger.warn(`Item-Recovery: Unsicherer targetPath verworfen (${item.fileName} -> ${item.targetPath})`);
        this.releaseTargetPath(item.id);
        this.dropItemContribution(item.id);
        item.targetPath = "";
        item.status = "queued";
        item.attempts = 0;
        item.downloadedBytes = 0;
        item.progressPercent = 0;
        item.speedBps = 0;
        item.fullStatus = "Wartet (ungueltiger Zielpfad)";
        item.updatedAt = nowMs();
        continue;
      }
      try {
        const stat = await fs.promises.stat(item.targetPath);
        // Require file to be essentially complete — within one allocation unit of the
        // expected size.  The old 50% threshold incorrectly recovered partial downloads
        // (e.g. 627 MB of 1001 MB) and triggered hybrid extraction on incomplete archives.
        const minSize = expectedMinBytes(item.totalBytes, isLargeBinaryLikePath(item.fileName || item.targetPath));
        const persistedBytes = Math.max(0, Math.floor(Number(item.downloadedBytes) || 0));
        const preallocMismatchThreshold = resolvePreallocResumeMismatchThreshold(item.fileName || item.targetPath || "");
        const suspiciousPreallocFootprint = item.totalBytes != null
          && item.totalBytes > 0
          && stat.size >= minSize
          && stat.size > persistedBytes + preallocMismatchThreshold;
        if (stat.size >= minSize) {
          // Re-check: another task may have started this item during the await
          const latestItem = this.session.items[item.id];
          if (!latestItem || this.activeTasks.has(item.id) || latestItem.status === "downloading"
            || latestItem.status === "validating" || latestItem.status === "integrity_check") {
            continue;
          }
          if (suspiciousPreallocFootprint) {
            logger.warn(
              `Item-Recovery: ${item.fileName} uebersprungen – pre-alloc-Verdacht ` +
              `(stat=${humanSize(stat.size)}, bytes=${humanSize(persistedBytes)}, total=${humanSize(item.totalBytes)})`
            );
            try {
              if (persistedBytes > 0) {
                fs.truncateSync(item.targetPath, persistedBytes);
              } else {
                fs.rmSync(item.targetPath, { force: true });
              }
            } catch {
              // best-effort
            }
            item.status = "queued";
            item.attempts = 0;
            item.downloadedBytes = persistedBytes;
            item.progressPercent = item.totalBytes > 0
              ? Math.max(0, Math.min(99, Math.floor((persistedBytes / item.totalBytes) * 100)))
              : 0;
            item.speedBps = 0;
            item.fullStatus = "Wartet (Auto-Recovery: pre-alloc)";
            item.updatedAt = nowMs();
            continue;
          }
          // Guard against pre-allocated sparse files from a hard crash: file has
          // the full expected size but downloadedBytes is significantly behind.
          if (item.downloadedBytes > 0 && item.totalBytes && item.totalBytes > 0
            && stat.size >= minSize
            && item.downloadedBytes < item.totalBytes * 0.95) {
            logger.warn(`Item-Recovery: ${item.fileName} uebersprungen – vermutlich pre-alloc (stat=${humanSize(stat.size)}, bytes=${humanSize(item.downloadedBytes)}, total=${humanSize(item.totalBytes)})`);
            continue;
          }
          logger.info(`Item-Recovery: ${item.fileName} war "${item.status}" aber Datei existiert (${humanSize(stat.size)}), setze auf completed`);
          item.status = "completed";
          item.fullStatus = this.settings.autoExtract ? "Entpacken - Ausstehend" : `Fertig (${humanSize(stat.size)})`;
          item.downloadedBytes = stat.size;
          item.progressPercent = 100;
          item.speedBps = 0;
          item.updatedAt = nowMs();
          this.recordRunOutcome(item.id, "completed");
        } else if (stat.size > 0) {
          // File exists but is clearly incomplete — delete and re-queue for download.
          logger.warn(`Item-Recovery: ${item.fileName} unvollstaendig (${humanSize(stat.size)}, erwartet mind. ${humanSize(minSize)}), loesche und re-queue`);
          try {
            fs.rmSync(item.targetPath, { force: true });
          } catch { /* ignore */ }
          this.releaseTargetPath(item.id);
          this.dropItemContribution(item.id);
          item.targetPath = "";
          item.status = "queued";
          item.attempts = 0;
          item.downloadedBytes = 0;
          item.progressPercent = 0;
          item.speedBps = 0;
          item.fullStatus = "Wartet (unvollständiger Download)";
          item.updatedAt = nowMs();
        }
      } catch {
        // file doesn't exist, nothing to recover
      }
    }

    const recoveryMs = nowMs() - recoveryStart;
    const success = items.filter((item) => item.status === "completed").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    const setupMs = nowMs() - handleStart;
    logger.info(`Post-Processing Start: pkg=${pkg.name}, success=${success}, failed=${failed}, cancelled=${cancelled}, autoExtract=${this.settings.autoExtract}, setupMs=${setupMs}, recoveryMs=${recoveryMs}`);
    this.logPackageForPackage(pkg, "INFO", "Post-Processing gestartet", {
      success,
      failed,
      cancelled,
      autoExtract: this.settings.autoExtract,
      setupMs,
      recoveryMs
    });

    const allDone = this.areAllPackageItemRefsFinished(pkg);
      if (!allDone && success + failed + cancelled >= items.length) {
        logger.warn(
          `Post-Processing wartet trotz gefiltert fertiger Items: ` +
          `pkg=${pkg.name}, tracked=${pkg.itemIds.length}, resolved=${items.length}, ` +
          `success=${success}, failed=${failed}, cancelled=${cancelled}`
        );
      }

    if (!allDone && this.settings.hybridExtract && this.settings.autoExtract && failed === 0 && success > 0) {
      pkg.postProcessLabel = "Entpacken vorbereiten...";
      this.emitState();
      const hybridExtracted = await this.runHybridExtraction(packageId, pkg, items, signal);
      if (signal?.aborted) {
        pkg.postProcessLabel = undefined;
        pkg.status = (pkg.enabled && this.session.running && !this.session.paused) ? "queued" : "paused";
        pkg.updatedAt = nowMs();
        return;
      }
      // Immediately clean up extracted items if "Sofort" policy is active
      if (this.settings.completedCleanupPolicy === "immediate") {
        for (const itemId of [...pkg.itemIds]) {
          this.applyCompletedCleanupPolicy(packageId, itemId);
        }
      }
      if (!this.session.packages[packageId]) {
        return;  // Package was fully cleaned up
      }
      // Self-requeue if we extracted something — more archive sets may have
      // become ready while we were extracting (items that completed before
      // this task started set the requeue flag once, which was already consumed).
      if (hybridExtracted > 0) {
        this.hybridExtractRequeue.add(packageId);
      }
      pkg.postProcessLabel = undefined;
      pkg.status = (pkg.enabled && this.session.running && !this.session.paused) ? "downloading" : "queued";
      pkg.updatedAt = nowMs();
      this.emitState();
      return;
    }

    if (!allDone) {
      pkg.postProcessLabel = undefined;
      pkg.status = (pkg.enabled && this.session.running && !this.session.paused) ? "downloading" : "queued";
      logger.info(`Post-Processing verschoben: pkg=${pkg.name}, noch offene items`);
      return;
    }

    const completedItems = items.filter((item) => item.status === "completed");
    const alreadyMarkedExtracted = completedItems.length > 0 && completedItems.every((item) => isExtractedLabel(item.fullStatus));
    let extractedCount = 0;

    if (this.settings.autoExtract && failed === 0 && success > 0 && !alreadyMarkedExtracted) {
      pkg.postProcessLabel = "Entpacken vorbereiten...";
      pkg.status = "extracting";
      this.emitState();

      // Fix obfuscated archive filenames before extraction attempts.
      await this.deobfuscateArchiveFiles(pkg, completedItems, signal);
      if (signal?.aborted) return;

      const extractionStartMs = nowMs();
      const preExtractStatuses = new Map<string, string>();

      const resolveArchiveItems = (archiveName: string): DownloadItem[] =>
        resolveArchiveItemsFromList(archiveName, completedItems);

      let lastExtractEmitAt = 0;
      const emitExtractStatus = (text: string, force = false): void => {
        const now = nowMs();
        if (!force && now - lastExtractEmitAt < EXTRACT_PROGRESS_EMIT_INTERVAL_MS) {
          return;
        }
        lastExtractEmitAt = now;
        pkg.postProcessLabel = text || "Entpacken...";
        this.emitState();
      };

      const extractTimeoutMs = getPostExtractTimeoutMs();
      const extractAbortController = new AbortController();
      let timedOut = false;
      const onParentAbort = (): void => {
        if (extractAbortController.signal.aborted) {
          return;
        }
        extractAbortController.abort("aborted:extract");
      };
      if (signal) {
        if (signal.aborted) {
          onParentAbort();
        } else {
          signal.addEventListener("abort", onParentAbort, { once: true });
        }
      }
      const extractDeadline = setTimeout(() => {
        if (signal?.aborted || extractAbortController.signal.aborted) {
          return;
        }
        timedOut = true;
        logger.error(`Post-Processing Extraction Timeout nach ${Math.ceil(extractTimeoutMs / 1000)}s: pkg=${pkg.name}`);
        if (!extractAbortController.signal.aborted) {
          extractAbortController.abort("extract_timeout");
        }
      }, extractTimeoutMs);
      try {
        // Track archives for parallel extraction progress
        const autoRecoveredArchives = new Set<string>();
        const fullFailedArchiveErrors = new Map<string, string>();
        const fullResolvedItems = new Map<string, DownloadItem[]>();
        const fullStartTimes = new Map<string, number>();
        let fullLastProgressCurrent: number | null = null;

        await this.waitForCompletedArchiveFilesToSettle(
          pkg,
          completedItems,
          extractAbortController.signal,
          "full"
        );
        if (extractAbortController.signal.aborted) {
          throw new Error(String(extractAbortController.signal.reason || "aborted:extract"));
        }

        const fullArchiveSet = await this.findFullExtractArchiveSet(pkg, completedItems);
        const fullExtractItemIds = new Set<string>();
        for (const archivePath of fullArchiveSet) {
          const archiveItems = resolveArchiveItems(path.basename(archivePath));
          for (const entry of archiveItems) {
            fullExtractItemIds.add(entry.id);
          }
        }
        const pendingAt = nowMs();
        for (const entry of completedItems) {
          if (!fullExtractItemIds.has(entry.id) || isExtractedLabel(entry.fullStatus)) {
            continue;
          }
          preExtractStatuses.set(entry.id, String(entry.fullStatus || "").trim());
          entry.fullStatus = "Entpacken - Ausstehend";
          entry.updatedAt = pendingAt;
        }
        this.emitState();
        const result = await extractPackageArchives({
          packageDir: pkg.outputDir,
          targetDir: pkg.extractDir,
          cleanupMode: this.settings.cleanupMode,
          conflictMode: this.settings.extractConflictMode,
          removeLinks: this.settings.removeLinkFilesAfterExtract,
          removeSamples: this.settings.removeSamplesAfterExtract,
          passwordList: this.settings.archivePasswordList,
          signal: extractAbortController.signal,
          packageId,
          onlyArchives: fullArchiveSet,
          skipPostCleanup: true,
          maxParallel: this.settings.maxParallelExtract || 2,
          // All downloads finished — use NORMAL OS priority so extraction runs at
          // full speed (matching manual 7-Zip/WinRAR speed).
          extractCpuPriority: "high",
          onLog: (level, message) => this.logExtractionForItems(pkg, completedItems, "Extractor", level, message),
          onArchiveFailure: (failure) => {
            if (autoRecoveredArchives.has(failure.archiveName)) {
              return;
            }
            const changed = this.autoRecoverArchiveCrcFailure(pkg, completedItems, failure, "full");
            if (changed > 0) {
              autoRecoveredArchives.add(failure.archiveName);
              fullFailedArchiveErrors.delete(failure.archiveName);
              return;
            }
            fullFailedArchiveErrors.set(
              failure.archiveName,
              failure.errorText || failure.jvmFailureReason || "Entpacken fehlgeschlagen"
            );
          },
          onProgress: (progress) => {
            if (progress.phase === "preparing") {
              pkg.postProcessLabel = progress.archiveName || "Vorbereiten...";
              this.emitState();
              return;
            }
            if (progress.phase === "done") {
              fullResolvedItems.clear();
              fullStartTimes.clear();
              fullLastProgressCurrent = null;
              emitExtractStatus("Entpacken 100%", true);
              return;
            }

            const currentCount = Math.max(0, Number(progress.current ?? 0));
            const archiveFinished = progress.archiveDone === true
              || (fullLastProgressCurrent !== null && currentCount > fullLastProgressCurrent);
            fullLastProgressCurrent = currentCount;

            if (progress.archiveName) {
              // Resolve items for this archive if not yet tracked
              if (!fullResolvedItems.has(progress.archiveName)) {
                const resolved = resolveArchiveItems(progress.archiveName);
                fullResolvedItems.set(progress.archiveName, resolved);
                fullStartTimes.set(progress.archiveName, nowMs());
                if (resolved.length === 0) {
                  logger.warn(`resolveArchiveItems (full): KEINE Items für archiveName="${progress.archiveName}", completedItems=${completedItems.length}, names=[${completedItems.map((i) => path.basename(i.targetPath || i.fileName || "?")).join(", ")}]`);
                } else {
                  logger.info(`resolveArchiveItems (full): ${resolved.length} Items für archiveName="${progress.archiveName}"`);
                  const initLabel = `Entpacken 0% · ${progress.archiveName}`;
                  const initAt = nowMs();
                  for (const entry of resolved) {
                    if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) continue;
                    entry.fullStatus = initLabel;
                    entry.updatedAt = initAt;
                  }
                  emitExtractStatus(`Entpacken ${progress.percent}% · ${progress.archiveName}`, true);
                }
              }
              const archiveItems = fullResolvedItems.get(progress.archiveName) || [];

              // Only finalize on explicit archive completion (or real current increment),
              // not on plain 100% archivePercent.
              if (archiveFinished) {
                const doneAt = nowMs();
                const startedAt = fullStartTimes.get(progress.archiveName) || doneAt;
                const doneLabel = progress.archiveSuccess === false
                  ? "Entpacken - Error"
                  : formatExtractDone(doneAt - startedAt);
                for (const entry of archiveItems) {
                  if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus)) continue;
                  entry.fullStatus = doneLabel;
                  entry.updatedAt = doneAt;
                }
                fullResolvedItems.delete(progress.archiveName);
                fullStartTimes.delete(progress.archiveName);
                // Show transitional label while next archive initializes
                const done = currentCount;
                if (done < progress.total) {
                  emitExtractStatus(`Entpacken (${done}/${progress.total}) - Nächstes Archiv...`, true);
                }
              } else {
                // Update this archive's items with per-archive progress
                const archiveTag = progress.archiveName ? ` · ${progress.archiveName}` : "";
                const elapsed = progress.elapsedMs && progress.elapsedMs >= 1000
                  ? ` · ${Math.floor(progress.elapsedMs / 1000)}s`
                  : "";
                const archivePct = Math.max(0, Math.min(100, Math.floor(Number(progress.archivePercent ?? 0))));
                const isFinalizing = archivePct >= 99;
                let label: string;
                if (progress.passwordFound) {
                  label = `Passwort gefunden · ${progress.archiveName}`;
                } else if (progress.passwordAttempt && progress.passwordTotal && progress.passwordTotal > 1) {
                  const pwPct = Math.round((progress.passwordAttempt / progress.passwordTotal) * 100);
                  label = `Passwort knacken: ${pwPct}% (${progress.passwordAttempt}/${progress.passwordTotal}) · ${progress.archiveName}`;
                } else if (isFinalizing) {
                  label = `Finalisieren${archiveTag}${elapsed}`;
                } else {
                  label = `Entpacken ${archivePct}%${archiveTag}${elapsed}`;
                }
                const updatedAt = nowMs();
                for (const entry of archiveItems) {
                  if (entry.status !== "completed" || isExtractedLabel(entry.fullStatus) || entry.fullStatus === label) continue;
                  entry.fullStatus = label;
                  entry.updatedAt = updatedAt;
                }
              }
            }

            // Emit overall status (throttled)
            const archive = progress.archiveName ? ` · ${progress.archiveName}` : "";
            const elapsed = progress.elapsedMs && progress.elapsedMs >= 1000
              ? ` · ${Math.floor(progress.elapsedMs / 1000)}s`
              : "";
            const activeArchive = !archiveFinished && Number(progress.archivePercent ?? 0) > 0 ? 1 : 0;
            const currentDisplay = Math.max(0, Math.min(progress.total, progress.current + activeArchive));
            let overallLabel: string;
            if (progress.passwordFound) {
              overallLabel = `Passwort gefunden · ${progress.archiveName || ""}`;
            } else if (progress.passwordAttempt && progress.passwordTotal && progress.passwordTotal > 1) {
              const pwPct = Math.round((progress.passwordAttempt / progress.passwordTotal) * 100);
              overallLabel = `Passwort knacken: ${pwPct}% (${progress.passwordAttempt}/${progress.passwordTotal}) · ${progress.archiveName || ""}`;
            } else if (Number(progress.archivePercent ?? 0) >= 99) {
              overallLabel = `Finalisieren (${currentDisplay}/${progress.total})${archive}${elapsed}`;
            } else {
              overallLabel = `Entpacken ${progress.percent}% (${currentDisplay}/${progress.total})${archive}${elapsed}`;
            }
            emitExtractStatus(overallLabel);
          }
        });
        logger.info(`Post-Processing Entpacken Ende: pkg=${pkg.name}, extracted=${result.extracted}, failed=${result.failed}, lastError=${result.lastError || ""}`);
        this.logPackageForPackage(pkg, "INFO", "Post-Processing Entpacken Ende", {
          extracted: result.extracted,
          failed: result.failed,
          lastError: result.lastError || ""
        });
        extractedCount = result.extracted;
        const autoRecoveredPending = completedItems.some((item) => item.status === "queued");

        // Auto-rename wird in runDeferredPostExtraction ausgeführt (im Hintergrund),
        // damit der Slot sofort freigegeben wird.

        if (autoRecoveredPending) {
          pkg.postProcessLabel = undefined;
          pkg.status = (pkg.enabled && this.session.running && !this.session.paused) ? "downloading" : "queued";
          pkg.updatedAt = nowMs();
          logger.warn(`Post-Processing: pkg=${pkg.name}, Archivfehler automatisch auf Re-Download umgestellt`);
          return;
        }

        if (result.failed > 0) {
          const reason = compactErrorText(result.lastError || "Entpacken fehlgeschlagen");
          const failAt = nowMs();
          if (fullFailedArchiveErrors.size > 0) {
            const archiveSummaries = [...fullFailedArchiveErrors.entries()]
              .slice(0, 3)
              .map(([archiveName, errorText]) => `${archiveName}: ${summarizeExtractFailureReason(errorText)}`)
              .join(" | ");
            logger.warn(`Post-Processing Entpacken Fehlerdetails: pkg=${pkg.name}, archives=${archiveSummaries}`);
            this.logPackageForPackage(pkg, "WARN", "Post-Processing Entpacken Fehlerdetails", {
              failedArchives: [...fullFailedArchiveErrors.keys()],
              summary: archiveSummaries
            });
          }
          this.applyPackageExtractFailureStatuses(
            completedItems,
            resolveArchiveItems,
            fullFailedArchiveErrors,
            reason,
            preExtractStatuses,
            failAt
          );
          pkg.status = "failed";
        } else {
          const hasExtractedOutput = await this.directoryHasAnyFiles(pkg.extractDir);
          const sourceExists = await this.existsAsync(pkg.outputDir);
          let finalStatusText = "";

          if (result.extracted > 0 || hasExtractedOutput) {
            finalStatusText = formatExtractDone(nowMs() - extractionStartMs);
          } else if (!sourceExists) {
            finalStatusText = "Entpackt (Quelle fehlt)";
            logger.warn(`Post-Processing ohne Quellordner: pkg=${pkg.name}, outputDir fehlt`);
          } else {
            finalStatusText = "Entpackt (keine Archive)";
          }

          const finalAt = nowMs();
          for (const entry of completedItems) {
            // Preserve per-archive duration labels (e.g. "Entpackt - Done (5.3s)")
            if (!isExtractedLabel(entry.fullStatus)) {
              entry.fullStatus = finalStatusText;
              entry.updatedAt = finalAt;
            }
          }
          pkg.status = "completed";
        }
      } catch (error) {
        const reasonRaw = String(error || "");
        const isExtractAbort = reasonRaw.includes("aborted:extract") || reasonRaw.includes("extract_timeout");
        let timeoutHandled = false;
        if (isExtractAbort) {
          if (timedOut) {
            const timeoutReason = `Entpacken Timeout nach ${Math.ceil(extractTimeoutMs / 1000)}s`;
            logger.error(`Post-Processing Entpacken Timeout: pkg=${pkg.name}`);
            for (const entry of completedItems) {
              if (entry.status === "completed" && !isExtractedLabel(entry.fullStatus)) {
                entry.fullStatus = formatExtractFailureLabel(timeoutReason);
                entry.updatedAt = nowMs();
              }
            }
            pkg.status = "failed";
            pkg.updatedAt = nowMs();
            timeoutHandled = true;
          } else {
            for (const entry of completedItems) {
              if (/^Entpacken/i.test(entry.fullStatus || "") || /^Passwort/i.test(entry.fullStatus || "")) {
                entry.fullStatus = "Entpacken abgebrochen (wird fortgesetzt)";
                entry.updatedAt = nowMs();
              }
            }
            pkg.status = (pkg.enabled && !this.session.paused) ? "queued" : "paused";
            pkg.updatedAt = nowMs();
            logger.info(`Post-Processing Entpacken abgebrochen: pkg=${pkg.name}`);
            return;
          }
        }
        if (!timeoutHandled) {
          const reason = compactErrorText(error);
          logger.error(`Post-Processing Entpacken Exception: pkg=${pkg.name}, reason=${reason}`);
          for (const entry of completedItems) {
            if (entry.status === "completed" && !isExtractedLabel(entry.fullStatus)) {
              entry.fullStatus = formatExtractFailureLabel(reason);
              entry.updatedAt = nowMs();
            }
          }
          pkg.status = "failed";
        }
      } finally {
        clearTimeout(extractDeadline);
        if (signal) {
          signal.removeEventListener("abort", onParentAbort);
        }
      }
    } else if (failed > 0) {
      pkg.status = "failed";
    } else if (cancelled > 0) {
      pkg.status = success > 0 ? "completed" : "cancelled";
    } else {
      pkg.status = "completed";
    }

    // Emit state immediately after status change so UI reflects completion
    // before potentially slow rename/MKV-collection steps.
    this.emitState();

    // Record history entry when package completes (regardless of cleanup policy)
    if (pkg.status === "completed" || (pkg.status === "failed" && success > 0)) {
      this.recordPackageHistory(packageId, pkg, items);
    }

    if (this.runPackageIds.has(packageId)) {
      if (pkg.status === "completed" || pkg.status === "failed") {
        this.runCompletedPackages.add(packageId);
      } else {
        this.runCompletedPackages.delete(packageId);
      }
    }
    pkg.postProcessLabel = undefined;
    pkg.updatedAt = nowMs();
    logger.info(`Post-Processing Ende: pkg=${pkg.name}, status=${pkg.status} (deferred work wird im Hintergrund ausgeführt)`);
    this.logPackageForPackage(pkg, "INFO", "Post-Processing Ende", {
      status: pkg.status,
      success,
      failed,
      extractedCount,
      alreadyMarkedExtracted
    });

    // Deferred post-extraction: Rename, MKV-Sammlung, Cleanup laufen im Hintergrund,
    // damit der Post-Process-Slot sofort freigegeben wird und das nächste Pack
    // ohne 10–15 Sekunden Pause entpacken kann.
    void this.runDeferredPostExtraction(packageId, pkg, success, failed, alreadyMarkedExtracted, extractedCount);
  }

  /**
   * Runs slow post-extraction work (rename, MKV collection, cleanup) in the background
   * so the post-process slot is released immediately and the next pack can start unpacking.
   */
  private async runDeferredPostExtraction(
    packageId: string,
    pkg: PackageEntry,
    success: number,
    failed: number,
    alreadyMarkedExtracted: boolean,
    extractedCount: number
  ): Promise<void> {
    const replacedController = this.packageDeferredPostProcessAbortControllers.get(packageId);
    if (replacedController && !replacedController.signal.aborted) {
      replacedController.abort("deferred_replaced");
    }
    const deferredController = new AbortController();
    this.packageDeferredPostProcessAbortControllers.set(packageId, deferredController);
    const deferredVersion = this.getPackagePostProcessVersion(packageId);
    const shouldAbort = (): boolean => !this.isDeferredPostProcessStillCurrent(packageId, pkg, deferredVersion, deferredController.signal);
    const throwIfAborted = (): void => this.throwIfDeferredPostProcessAborted(packageId, pkg, deferredVersion, deferredController.signal);
    const hasBlockingExtractError = pkg.itemIds.some((itemId) => {
      const item = this.session.items[itemId];
      return Boolean(item && item.status === "completed" && isExtractErrorLabel(item.fullStatus || ""));
    });

    try {
      throwIfAborted();
      // ── Nested extraction: extract archives found inside the extracted output ──
      if ((extractedCount > 0 || alreadyMarkedExtracted) && failed === 0 && this.settings.autoExtract) {
        const nestedBlacklist = /\.(iso|img|bin|dmg|vhd|vhdx|vmdk|wim)$/i;
        const nestedCandidates = (await findArchiveCandidates(pkg.extractDir))
          .filter((p) => !nestedBlacklist.test(p));
        if (nestedCandidates.length > 0) {
          pkg.postProcessLabel = "Nested Entpacken...";
          this.emitState();
          logger.info(`Deferred Nested-Extraction: ${nestedCandidates.length} Archive in ${pkg.extractDir}`);
          this.logPackageForPackage(pkg, "INFO", "Deferred Nested-Extraction gestartet", {
            nestedCandidates: nestedCandidates.length,
            extractDir: pkg.extractDir
          });
          const nestedResult = await extractPackageArchives({
            packageDir: pkg.extractDir,
            targetDir: pkg.extractDir,
            cleanupMode: this.settings.cleanupMode,
            conflictMode: this.settings.extractConflictMode,
            removeLinks: false,
            removeSamples: false,
            passwordList: this.settings.archivePasswordList,
            signal: deferredController.signal,
            packageId,
            onlyArchives: new Set(nestedCandidates.map((p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p))),
            maxParallel: this.settings.maxParallelExtract || 2,
            extractCpuPriority: this.settings.extractCpuPriority,
            onLog: (level, message) => this.logPackageForPackage(pkg, level, `Nested-Extractor: ${message}`),
          });
          throwIfAborted();
          extractedCount += nestedResult.extracted;
          logger.info(`Deferred Nested-Extraction Ende: extracted=${nestedResult.extracted}, failed=${nestedResult.failed}`);
          this.logPackageForPackage(pkg, "INFO", "Deferred Nested-Extraction Ende", {
            extracted: nestedResult.extracted,
            failed: nestedResult.failed
          });
        }
      }

      // ── Auto-Rename ──
      if (extractedCount > 0 || alreadyMarkedExtracted) {
        pkg.postProcessLabel = "Renaming...";
        this.emitState();
        this.logPackageForPackage(pkg, "INFO", "Deferred Auto-Rename gestartet", {
          extractDir: pkg.extractDir
        });
        throwIfAborted();
        // treatFilesAsStable=true: Final-Pass — die Extraktion (inkl. Nested oben) ist
        // abgeschlossen/awaited, es gibt keinen concurrent Extractor-Write mehr. Ohne
        // diesen Gate-Bypass wuerde eine eben extrahierte, noch frische (< 2s) Datei vom
        // Rename uebersprungen und vom nachfolgenden Collect (deferFreshFiles=false) mit
        // Original-Scene-Namen in die Library gemoved (1-2 unbenannte Dateien pro Staffel).
        await this.autoRenameExtractedVideoFiles(pkg.extractDir, pkg, shouldAbort, true);
      }

      // ── Archive cleanup (source archives in outputDir) ──
      // Also run when hybrid extraction already handled everything (extractedCount=0
      // but alreadyMarkedExtracted=true) so archives are still cleaned up.
      if ((extractedCount > 0 || alreadyMarkedExtracted) && failed === 0 && this.settings.cleanupMode !== "none") {
        pkg.postProcessLabel = "Aufräumen...";
        this.emitState();
        throwIfAborted();
        if (hasBlockingExtractError) {
          logger.info(`Deferred Archive-Cleanup uebersprungen: pkg=${pkg.name}, reason=extract_error`);
        } else {
          const sourceAndTargetEqual = path.resolve(pkg.outputDir).toLowerCase() === path.resolve(pkg.extractDir).toLowerCase();
          if (!sourceAndTargetEqual) {
            const candidates = await findArchiveCandidates(pkg.outputDir);
            if (candidates.length > 0) {
              const removed = await cleanupArchives(candidates, this.settings.cleanupMode, { shouldAbort });
              if (removed > 0) {
                logger.info(`Deferred Archive-Cleanup: pkg=${pkg.name}, entfernt=${removed}`);
              }
            }
          }
        }
      }

      // ── Hybrid archive cleanup (wenn bereits als extracted markiert) ──
      if (this.settings.autoExtract && alreadyMarkedExtracted && failed === 0 && success > 0 && this.settings.cleanupMode !== "none" && !hasBlockingExtractError) {
        throwIfAborted();
        const removedArchives = await this.cleanupRemainingArchiveArtifacts(pkg.outputDir, shouldAbort);
        if (removedArchives > 0) {
          logger.info(`Hybrid-Post-Cleanup entfernte Archive: pkg=${pkg.name}, entfernt=${removedArchives}`);
        }
      }

      // ── Link/Sample artifact removal ──
      if (extractedCount > 0 || alreadyMarkedExtracted) {
        throwIfAborted();
        if (this.settings.removeLinkFilesAfterExtract) {
          const removedLinks = await removeDownloadLinkArtifacts(pkg.extractDir, { shouldAbort });
          if (removedLinks > 0) {
            logger.info(`Deferred Link-Cleanup: pkg=${pkg.name}, entfernt=${removedLinks}`);
          }
        }
        if (this.settings.removeSamplesAfterExtract) {
          const removedSamples = await removeSampleArtifacts(pkg.extractDir, { shouldAbort });
          if (removedSamples.files > 0 || removedSamples.dirs > 0) {
            logger.info(`Deferred Sample-Cleanup: pkg=${pkg.name}, files=${removedSamples.files}, dirs=${removedSamples.dirs}`);
          }
        }
      }

      // ── Resume state cleanup ──
      if ((extractedCount > 0 || alreadyMarkedExtracted) && failed === 0) {
        throwIfAborted();
        await clearExtractResumeState(pkg.outputDir, packageId);
        // Backward compatibility: older versions used .rd_extract_progress.json without package suffix.
        await clearExtractResumeState(pkg.outputDir);
      }

      // ── Empty directory tree removal ──
      if ((extractedCount > 0 || alreadyMarkedExtracted) && failed === 0 && this.settings.cleanupMode === "delete") {
        throwIfAborted();
        if (!(await hasAnyFilesRecursive(pkg.outputDir))) {
          const removedDirs = await removeEmptyDirectoryTree(pkg.outputDir);
          if (removedDirs > 0) {
            logger.info(`Deferred leere Download-Ordner entfernt: pkg=${pkg.name}, dirs=${removedDirs}`);
          }
        }
      }

      // ── MKV collection ──
      if (success > 0 && (pkg.status === "completed" || pkg.status === "failed")) {
        throwIfAborted();
        pkg.postProcessLabel = "Verschiebe Videos...";
        this.emitState();
        // Route through chainPackageFileOp so this serializes against any
        // hybrid-pipe rename or mkvMove still pending for the same package.
        await this.chainPackageFileOp(pkg.id, () => this.collectMkvFilesToLibrary(packageId, pkg, shouldAbort));
      }

      throwIfAborted();
      pkg.postProcessLabel = undefined;
      pkg.updatedAt = nowMs();
      this.persistSoon();
      this.emitState();

      this.applyPackageDoneCleanup(packageId);
    } catch (error) {
      const reason = compactErrorText(error);
      if (reason.includes("aborted:deferred")
        || reason.includes("deferred_replaced")
        || reason.includes("package_removed")
        || reason === "reset"
        || reason === "cancel"
        || reason === "overwrite"
        || reason === "skip"
        || reason === "package_toggle") {
        logger.info(`Deferred Post-Extraction abgebrochen: pkg=${pkg.name}, reason=${reason}`);
      } else {
        logger.warn(`Deferred Post-Extraction Fehler: pkg=${pkg.name}, reason=${reason}`);
      }
    } finally {
      if (this.packageDeferredPostProcessAbortControllers.get(packageId) === deferredController) {
        this.packageDeferredPostProcessAbortControllers.delete(packageId);
      }
      if (this.session.packages[packageId] === pkg && this.getPackagePostProcessVersion(packageId) === deferredVersion) {
        pkg.postProcessLabel = undefined;
        pkg.updatedAt = nowMs();
        this.persistSoon();
        this.emitState();
      }
    }
  }

  private applyPackageDoneCleanup(packageId: string): void {
    const policy = this.settings.completedCleanupPolicy;
    if (policy !== "package_done" && policy !== "immediate") {
      return;
    }

    const pkg = this.session.packages[packageId];
    if (!pkg || (pkg.status !== "completed" && pkg.status !== "failed")) {
      return;
    }

    if (policy === "immediate") {
      for (const itemId of [...pkg.itemIds]) {
        this.applyCompletedCleanupPolicy(packageId, itemId, { ignoreDeferred: true });
      }
      return;
    }

    if (pkg.status !== "completed") {
      return;
    }

    const allDone = pkg.itemIds.every((itemId) => {
      const item = this.session.items[itemId];
      return !item || item.status === "completed" || item.status === "cancelled" || item.status === "failed";
    });
    if (!allDone) {
      return;
    }

    // With autoExtract: only remove once all completed items are extracted (failed/cancelled don't need extraction)
    if (this.settings.autoExtract) {
      const allExtracted = pkg.itemIds.every((itemId) => {
        const item = this.session.items[itemId];
        if (!item) return true;
        if (item.status === "failed" || item.status === "cancelled") return true;
        return isExtractedLabel(item.fullStatus || "");
      });
      if (!allExtracted) {
        return;
      }
    }

    this.removePackageFromSession(packageId, [...pkg.itemIds], "completed");
  }

  private applyCompletedCleanupPolicy(
    packageId: string,
    itemId: string,
    options?: { ignoreDeferred?: boolean }
  ): void {
    const policy = this.settings.completedCleanupPolicy;
    if (policy === "never" || policy === "on_start") {
      return;
    }

    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }

    if (!options?.ignoreDeferred && this.hasDeferredPostProcessPending(packageId)) {
      return;
    }

    if (policy === "immediate") {
      const item = this.session.items[itemId];
      if (!item || item.status !== "completed") {
        return;
      }
      if (this.settings.autoExtract) {
        const extracted = isExtractedLabel(item.fullStatus || "");
        if (!extracted) {
          return;
        }
      }
      pkg.itemIds = pkg.itemIds.filter((id) => id !== itemId);
      this.releaseTargetPath(itemId);
      this.dropItemContribution(itemId);
      delete this.session.items[itemId];
      this.itemCount = Math.max(0, this.itemCount - 1);
      this.retryAfterByItem.delete(itemId);
      this.pacedStartReservationByItem.delete(itemId);
      this.retryStateByItem.delete(itemId);
      if (pkg.itemIds.length === 0) {
        this.removePackageFromSession(packageId, []);
      }
      return;
    }

    if (policy === "package_done") {
      if (pkg.status !== "completed") {
        return;
      }
      const hasOpen = pkg.itemIds.some((id) => {
        const item = this.session.items[id];
        return item != null && item.status !== "completed" && item.status !== "cancelled" && item.status !== "failed";
      });
      if (!hasOpen) {
        // With autoExtract: only remove once completed items are extracted (failed/cancelled don't need extraction)
        if (this.settings.autoExtract) {
          const allExtracted = pkg.itemIds.every((id) => {
            const item = this.session.items[id];
            if (!item) return true;
            if (item.status === "failed" || item.status === "cancelled") return true;
            return isExtractedLabel(item.fullStatus || "");
          });
          if (!allExtracted) {
            return;
          }
        }
        this.removePackageFromSession(packageId, [...pkg.itemIds], "completed");
      }
    }
  }

  private finishRun(): void {
    const runStartedAt = this.session.runStartedAt;
    this.session.running = false;
    this.session.paused = false;
    this.session.runStartedAt = 0;
    const total = this.runItemIds.size;
    const outcomes = Array.from(this.runOutcomes.values());
    const success = outcomes.filter((status) => status === "completed").length;
    const failed = outcomes.filter((status) => status === "failed").length;
    const cancelled = outcomes.filter((status) => status === "cancelled").length;
    const extracted = this.runCompletedPackages.size;
    const duration = runStartedAt > 0 ? Math.max(1, Math.floor((nowMs() - runStartedAt) / 1000)) : 1;
    const avgSpeed = Math.floor(this.session.totalDownloadedBytes / duration);
    this.summary = {
      total,
      success,
      failed,
      cancelled,
      extracted,
      durationSeconds: duration,
      averageSpeedBps: avgSpeed
    };
    this.session.summaryText = `Summary: Dauer ${duration}s, Ø Speed ${humanSize(avgSpeed)}/s, Erfolg ${success}/${total}`;
    this.runItemIds.clear();
    this.runOutcomes.clear();
    // Keep runPackageIds and runCompletedPackages alive when post-processing tasks
    // are still running (autoExtractWhenStopped) so handlePackagePostProcessing()
    // can still update runCompletedPackages.  They are cleared by the next start().
    // M1: auch laufende Deferred/Hybrid-Arbeit berücksichtigen, sonst werden die
    // Run-Maps geleert während noch MKVs verschoben werden.
    if (this.packagePostProcessTasks.size === 0 && !this.hasAnyDeferredPostProcessPending()) {
      this.runPackageIds.clear();
      this.runCompletedPackages.clear();
    }
    this.retryAfterByItem.clear();
    this.providerStartReservations.clear();
    this.pacedStartReservationByItem.clear();
    this.retryStateByItem.clear();
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();
    this.itemContributedBytes.clear();
    this.speedEvents = [];
    this.speedEventsHead = 0;
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.globalSpeedLimitQueue = Promise.resolve();
    this.globalSpeedLimitNextAt = 0;
    this.nonResumableActive = 0;
    this.lastGlobalProgressBytes = this.session.totalDownloadedBytes;
    this.lastGlobalProgressAt = nowMs();
    this.lastSettingsPersistAt = 0; // force settings save on run finish
    this.persistNow();
    this.emitState();
  }

  public getSessionStats(): import("../shared/types").SessionStats {
    const now = nowMs();
    this.pruneSpeedEvents(now);

    const bandwidthSamples: import("../shared/types").BandwidthSample[] = [];
    for (let i = this.speedEventsHead; i < this.speedEvents.length; i += 1) {
      const event = this.speedEvents[i];
      if (event) {
        bandwidthSamples.push({
          timestamp: event.at,
          speedBps: Math.floor(event.bytes * (1000 / 120))
        });
      }
    }

    const paused = this.session.running && this.session.paused;
    const currentSpeedBps = !this.session.running || paused ? 0 : this.speedBytesLastWindow / SPEED_WINDOW_SECONDS;

    let maxSpeed = 0;
    for (let i = this.speedEventsHead; i < this.speedEvents.length; i += 1) {
      const event = this.speedEvents[i];
      if (event) {
        const speed = Math.floor(event.bytes * (1000 / 120));
        if (speed > maxSpeed) {
          maxSpeed = speed;
        }
      }
    }

    const sessionDurationSeconds = this.session.runStartedAt > 0
      ? Math.max(0, Math.floor((now - this.session.runStartedAt) / 1000))
      : 0;

    const averageSpeedBps = sessionDurationSeconds > 0
      ? Math.floor(this.session.totalDownloadedBytes / sessionDurationSeconds)
      : 0;

    let totalDownloads = 0;
    let completedDownloads = 0;
    let failedDownloads = 0;
    let activeDownloads = 0;
    let queuedDownloads = 0;

    for (const item of Object.values(this.session.items)) {
      totalDownloads += 1;
      if (item.status === "completed") {
        completedDownloads += 1;
      } else if (item.status === "failed") {
        failedDownloads += 1;
      } else if (item.status === "downloading" || item.status === "validating" || item.status === "integrity_check") {
        activeDownloads += 1;
      } else if (item.status === "queued" || item.status === "reconnect_wait" || item.status === "paused") {
        queuedDownloads += 1;
      }
    }

    return {
      bandwidth: {
        samples: bandwidthSamples.slice(-120),
        currentSpeedBps: Math.floor(currentSpeedBps),
        averageSpeedBps,
        maxSpeedBps: Math.floor(maxSpeed),
        totalBytesSession: this.session.totalDownloadedBytes,
        sessionDurationSeconds
      },
      totalDownloads,
      completedDownloads,
      failedDownloads,
      activeDownloads,
      queuedDownloads
    };
  }
}
