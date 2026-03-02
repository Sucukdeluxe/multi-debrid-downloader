import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import {
  AppSettings,
  DownloadItem,
  DownloadStats,
  DownloadSummary,
  DownloadStatus,
  DuplicatePolicy,
  HistoryEntry,
  PackageEntry,
  ParsedPackageInput,
  SessionState,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot
} from "../shared/types";
import { REQUEST_RETRIES, SAMPLE_VIDEO_EXTENSIONS } from "./constants";
import { cleanupCancelledPackageArtifactsAsync } from "./cleanup";
import { DebridService, MegaWebUnrestrictor } from "./debrid";
import { collectArchiveCleanupTargets, extractPackageArchives, findArchiveCandidates } from "./extractor";
import { validateFileAgainstManifest } from "./integrity";
import { logger } from "./logger";
import { StoragePaths, saveSession, saveSessionAsync, saveSettings, saveSettingsAsync } from "./storage";
import { compactErrorText, ensureDirPath, filenameFromUrl, formatEta, humanSize, looksLikeOpaqueFilename, nowMs, sanitizeFilename, sleep } from "./utils";

type ActiveTask = {
  itemId: string;
  packageId: string;
  abortController: AbortController;
  abortReason: "stop" | "cancel" | "reconnect" | "package_toggle" | "stall" | "shutdown" | "none";
  resumable: boolean;
  nonResumableCounted: boolean;
  freshRetryUsed?: boolean;
  stallRetries?: number;
  genericErrorRetries?: number;
  unrestrictRetries?: number;
  blockedOnDiskWrite?: boolean;
  blockedOnDiskSince?: number;
};

const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 10000;

const DEFAULT_DOWNLOAD_CONNECT_TIMEOUT_MS = 25000;

const DEFAULT_GLOBAL_STALL_WATCHDOG_TIMEOUT_MS = 60000;

const DEFAULT_POST_EXTRACT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const EXTRACT_PROGRESS_EMIT_INTERVAL_MS = 260;

const DEFAULT_UNRESTRICT_TIMEOUT_MS = 60000;

const DEFAULT_LOW_THROUGHPUT_TIMEOUT_MS = 120000;

const DEFAULT_LOW_THROUGHPUT_MIN_BYTES = 64 * 1024;

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
  invalidateMegaSession?: () => void;
  onHistoryEntry?: HistoryEntryCallback;
};

function generateHistoryId(): string {
  return `hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSession(session: SessionState): SessionState {
  const clonedItems: Record<string, DownloadItem> = {};
  for (const key of Object.keys(session.items)) {
    clonedItems[key] = { ...session.items[key] };
  }
  const clonedPackages: Record<string, PackageEntry> = {};
  for (const key of Object.keys(session.packages)) {
    const pkg = session.packages[key];
    clonedPackages[key] = { ...pkg, itemIds: [...pkg.itemIds] };
  }
  return {
    ...session,
    packageOrder: [...session.packageOrder],
    packages: clonedPackages,
    items: clonedItems
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    bandwidthSchedules: (settings.bandwidthSchedules || []).map((entry) => ({ ...entry }))
  };
}

function parseContentRangeTotal(contentRange: string | null): number | null {
  if (!contentRange) {
    return null;
  }
  const match = contentRange.match(/\/(\d+)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
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

function isFetchFailure(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("fetch failed") || text.includes("socket hang up") || text.includes("econnreset") || text.includes("network error");
}

function isPermanentLinkError(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("permanent ungültig")
    || text.includes("hosternotavailable")
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
  return text.includes("unrestrict") || text.includes("mega-web") || text.includes("mega-debrid")
    || text.includes("bestdebrid") || text.includes("alldebrid") || text.includes("kein debrid")
    || text.includes("session") || text.includes("login");
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

function isFinishedStatus(status: DownloadStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isExtractedLabel(statusText: string): boolean {
  return /^entpackt\b/i.test(String(statusText || "").trim());
}

function providerLabel(provider: DownloadItem["provider"]): string {
  if (provider === "realdebrid") {
    return "Real-Debrid";
  }
  if (provider === "megadebrid") {
    return "Mega-Debrid";
  }
  if (provider === "bestdebrid") {
    return "BestDebrid";
  }
  if (provider === "alldebrid") {
    return "AllDebrid";
  }
  return "Debrid";
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

function isIgnorableEmptyDirFileName(fileName: string): boolean {
  return EMPTY_DIR_IGNORED_FILE_NAMES.has(String(fileName || "").trim().toLowerCase());
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
const SCENE_EPISODE_RE = /(?:^|[._\-\s])s(\d{1,2})e(\d{1,3})(?:e(\d{1,3}))?(?:[._\-\s]|$)/i;
const SCENE_SEASON_ONLY_RE = /(^|[._\-\s])s\d{1,2}(?=[._\-\s]|$)/i;
const SCENE_SEASON_CAPTURE_RE = /(?:^|[._\-\s])s(\d{1,2})(?=[._\-\s]|$)/i;
const SCENE_EPISODE_ONLY_RE = /(?:^|[._\-\s])e(?:p(?:isode)?)?\s*0*(\d{1,3})(?:[._\-\s]|$)/i;
const SCENE_PART_TOKEN_RE = /(?:^|[._\-\s])(?:teil|part)\s*0*(\d{1,3})(?=[._\-\s]|$)/i;
const SCENE_COMPACT_EPISODE_CODE_RE = /(?:^|[._\-\s])(\d{3,4})(?=$|[._\-\s])/;
const SCENE_RP_TOKEN_RE = /(?:^|[._\-\s])rp(?:[._\-\s]|$)/i;
const SCENE_REPACK_TOKEN_RE = /(?:^|[._\-\s])repack(?:[._\-\s]|$)/i;
const SCENE_QUALITY_TOKEN_RE = /([._\-\s])((?:4320|2160|1440|1080|720|576|540|480|360)p)(?=[._\-\s]|$)/i;
const SCENE_GROUP_SUFFIX_FALLBACK_RE = /-([A-Za-z0-9]{2,})$/;
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

function hasSceneGroupSuffix(fileName: string): boolean {
  const text = String(fileName || "").trim();
  if (!text) {
    return false;
  }

  if (SCENE_GROUP_SUFFIX_RE.test(text)) {
    return true;
  }

  const fallbackMatch = text.match(SCENE_GROUP_SUFFIX_FALLBACK_RE);
  const suffix = String(fallbackMatch?.[1] || "").trim();
  if (!suffix) {
    return false;
  }

  const lower = suffix.toLowerCase();
  if (SCENE_NON_GROUP_SUFFIXES.has(lower)) {
    return false;
  }
  if (/^\d+p$/.test(lower) || /^\d+$/.test(lower)) {
    return false;
  }
  if (/^\d/.test(suffix)) {
    return false;
  }
  if (/4s(?:f|j)/i.test(suffix) && !/^(?:4sf|4sj)$/i.test(suffix)) {
    return false;
  }
  return /[a-z]/i.test(suffix);
}

export function extractEpisodeToken(fileName: string): string | null {
  const match = String(fileName || "").match(SCENE_EPISODE_RE);
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
  if (code === "2160" || code === "1080" || code === "0720" || code === "720" || code === "0576" || code === "576") {
    return null;
  }

  const toToken = (season: number, episode: number): string | null => {
    if (!Number.isFinite(season) || !Number.isFinite(episode) || season < 0 || season > 99 || episode <= 0 || episode > 999) {
      return null;
    }
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
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

  const episodeRe = /(^|[._\-\s])s\d{1,2}e\d{1,3}(?:e\d{1,3})?(?=[._\-\s]|$)/i;
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

    if (globalRepackHint) {
      target = ensureRepackToken(removeRpTokens(target));
    }
    return sanitizeFilename(target);
  }

  return null;
}

function resolveArchiveItemsFromList(archiveName: string, items: DownloadItem[]): DownloadItem[] {
  const entryLower = archiveName.toLowerCase();
  const multipartMatch = entryLower.match(/^(.*)\.part0*1\.rar$/);
  if (multipartMatch) {
    const prefix = multipartMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${prefix}\\.part\\d+\\.rar$`, "i");
    return items.filter((item) => {
      const name = path.basename(item.targetPath || item.fileName || "");
      return pattern.test(name);
    });
  }
  const rarMatch = entryLower.match(/^(.*)\.rar$/);
  if (rarMatch) {
    const stem = rarMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${stem}\\.r(ar|\\d{2,3})$`, "i");
    return items.filter((item) => {
      const name = path.basename(item.targetPath || item.fileName || "");
      return pattern.test(name);
    });
  }
  return items.filter((item) => {
    const name = path.basename(item.targetPath || item.fileName || "").toLowerCase();
    return name === entryLower;
  });
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

  private debridService: DebridService;

  private invalidateMegaSessionFn?: () => void;

  private activeTasks = new Map<string, ActiveTask>();

  private scheduleRunning = false;

  private persistTimer: NodeJS.Timeout | null = null;

  private speedEvents: Array<{ at: number; bytes: number; pid: string }> = [];

  private summary: DownloadSummary | null = null;

  private nonResumableActive = 0;

  private stateEmitTimer: NodeJS.Timeout | null = null;
  private lastStateEmitAt = 0;

  private speedBytesLastWindow = 0;

  private sessionDownloadedBytes = 0;

  private statsCache: DownloadStats | null = null;

  private statsCacheAt = 0;

  private lastPersistAt = 0;
  private lastSettingsPersistAt = 0;

  private cleanupQueue: Promise<void> = Promise.resolve();

  private packagePostProcessQueue: Promise<void> = Promise.resolve();

  private packagePostProcessTasks = new Map<string, Promise<void>>();

  private packagePostProcessAbortControllers = new Map<string, AbortController>();

  private hybridExtractRequeue = new Set<string>();

  private reservedTargetPaths = new Map<string, string>();

  private claimedTargetPathByItem = new Map<string, string>();

  private itemContributedBytes = new Map<string, number>();

  private runItemIds = new Set<string>();

  private runPackageIds = new Set<string>();

  private runOutcomes = new Map<string, "completed" | "failed" | "cancelled">();

  private runCompletedPackages = new Set<string>();

  private itemCount = 0;

  private lastSchedulerHeartbeatAt = 0;

  private lastReconnectMarkAt = 0;

  private consecutiveReconnects = 0;

  private lastGlobalProgressBytes = 0;

  private lastGlobalProgressAt = 0;

  private retryAfterByItem = new Map<string, number>();

  private retryStateByItem = new Map<string, {
    freshRetryUsed: boolean;
    stallRetries: number;
    genericErrorRetries: number;
    unrestrictRetries: number;
  }>();

  private providerFailures = new Map<string, { count: number; lastFailAt: number; cooldownUntil: number }>();

  private lastStaleResetAt = 0;

  private onHistoryEntryCallback?: HistoryEntryCallback;

  public constructor(settings: AppSettings, session: SessionState, storagePaths: StoragePaths, options: DownloadManagerOptions = {}) {
    super();
    this.settings = settings;
    this.session = cloneSession(session);
    this.itemCount = Object.keys(this.session.items).length;
    this.storagePaths = storagePaths;
    this.debridService = new DebridService(settings, { megaWebUnrestrict: options.megaWebUnrestrict });
    this.invalidateMegaSessionFn = options.invalidateMegaSession;
    this.onHistoryEntryCallback = options.onHistoryEntry;
    this.applyOnStartCleanupPolicy();
    this.normalizeSessionStatuses();
    void this.recoverRetryableItems("startup").catch((err) => logger.warn(`recoverRetryableItems Fehler (startup): ${compactErrorText(err)}`));
    this.recoverPostProcessingOnStartup();
    this.resolveExistingQueuedOpaqueFilenames();
    void this.cleanupExistingExtractedArchives().catch((err) => logger.warn(`cleanupExistingExtractedArchives Fehler (constructor): ${compactErrorText(err)}`));
  }

  public setSettings(next: AppSettings): void {
    next.totalDownloadedAllTime = Math.max(next.totalDownloadedAllTime || 0, this.settings.totalDownloadedAllTime || 0);
    this.settings = next;
    this.debridService.setSettings(next);
    this.resolveExistingQueuedOpaqueFilenames();
    void this.cleanupExistingExtractedArchives().catch((err) => logger.warn(`cleanupExistingExtractedArchives Fehler (setSettings): ${compactErrorText(err)}`));
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

  public getSnapshot(): UiSnapshot {
    const now = nowMs();
    this.pruneSpeedEvents(now);
    const paused = this.session.running && this.session.paused;
    const speedBps = paused ? 0 : this.speedBytesLastWindow / 3;

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
    const snapshotSettings = cloneSettings(this.settings);
    const snapshotSummary = this.summary
      ? { ...this.summary }
      : null;

    return {
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
      packageSpeedBps: paused ? {} : Object.fromEntries(
        [...this.speedBytesPerPackage].map(([pid, bytes]) => [pid, Math.floor(bytes / 3)])
      )
    };
  }

  public getStats(now = nowMs()): DownloadStats {
    const itemCount = this.itemCount;
    if (this.statsCache && this.session.running && itemCount >= 500 && now - this.statsCacheAt < 1500) {
      return this.statsCache;
    }

    this.resetSessionTotalsIfQueueEmpty();

    let totalFiles = 0;
    for (const item of Object.values(this.session.items)) {
      if (item.status === "completed") {
        totalFiles += 1;
      }
    }

    const stats = {
      totalDownloaded: this.sessionDownloadedBytes,
      totalDownloadedAllTime: this.settings.totalDownloadedAllTime,
      totalFiles,
      totalPackages: this.session.packageOrder.length,
      sessionStartedAt: this.session.runStartedAt
    };
    this.statsCache = stats;
    this.statsCacheAt = now;
    return stats;
  }

  private resetSessionTotalsIfQueueEmpty(): void {
    if (this.itemCount > 0 || this.session.packageOrder.length > 0) {
      return;
    }
    if (Object.keys(this.session.items).length > 0 || Object.keys(this.session.packages).length > 0) {
      return;
    }

    this.session.totalDownloadedBytes = 0;
    this.session.runStartedAt = 0;
    this.lastGlobalProgressBytes = 0;
    this.lastGlobalProgressAt = nowMs();
    this.speedEvents = [];
    this.speedEventsHead = 0;
    this.speedBytesLastWindow = 0;
    this.speedBytesPerPackage.clear();
    this.statsCache = null;
    this.statsCacheAt = 0;
  }

  public renamePackage(packageId: string, newName: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }
    pkg.name = sanitizeFilename(newName) || pkg.name;
    pkg.updatedAt = nowMs();
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
    const remaining = this.session.packageOrder.filter((id) => !valid.includes(id));
    this.session.packageOrder = [...valid, ...remaining];
    this.persistSoon();
    this.emitState(true);
  }

  public removeItem(itemId: string): void {
    const item = this.session.items[itemId];
    if (!item) {
      return;
    }
    this.recordRunOutcome(itemId, "cancelled");
    const active = this.activeTasks.get(itemId);
    const hasActiveTask = Boolean(active);
    if (active) {
      active.abortReason = "cancel";
      active.abortController.abort("cancel");
    }
    const pkg = this.session.packages[item.packageId];
    if (pkg) {
      pkg.itemIds = pkg.itemIds.filter((id) => id !== itemId);
      if (pkg.itemIds.length === 0) {
        this.removePackageFromSession(item.packageId, []);
      } else {
        pkg.updatedAt = nowMs();
      }
    }
    delete this.session.items[itemId];
    this.itemCount = Math.max(0, this.itemCount - 1);
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
      const postProcessController = this.packagePostProcessAbortControllers.get(packageId);
      if (postProcessController && !postProcessController.signal.aborted) {
        postProcessController.abort("package_toggle");
      }
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
        return {
          name: pkg.name,
          links: pkg.itemIds
            .map((itemId) => this.session.items[itemId]?.url)
            .filter(Boolean)
        };
      }).filter(Boolean)
    };
    return JSON.stringify(exportData, null, 2);
  }

  public importQueue(json: string): { addedPackages: number; addedLinks: number } {
    let data: { packages?: Array<{ name: string; links: string[] }> };
    try {
      data = JSON.parse(json) as { packages?: Array<{ name: string; links: string[] }> };
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
        const links = linksRaw
          .filter((link) => typeof link === "string")
          .map((link) => link.trim())
          .filter(Boolean);
        return { name, links };
      })
      .filter((pkg) => pkg.name.trim().length > 0 && pkg.links.length > 0);
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
    this.retryAfterByItem.clear();
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
    this.hybridExtractRequeue.clear();
    this.packagePostProcessQueue = Promise.resolve();
    this.summary = null;
    this.nonResumableActive = 0;
    this.retryAfterByItem.clear();
    this.retryStateByItem.clear();
    this.resetSessionTotalsIfQueueEmpty();
    this.persistNow();
    this.emitState(true);
  }

  public addPackages(packages: ParsedPackageInput[]): { addedPackages: number; addedLinks: number } {
    let addedPackages = 0;
    let addedLinks = 0;
    const unresolvedByLink = new Map<string, string[]>();
    for (const pkg of packages) {
      const links = pkg.links.filter((link) => !!link.trim());
      if (links.length === 0) {
        continue;
      }
      const packageId = uuidv4();
      const outputDir = ensureDirPath(this.settings.outputDir, pkg.name);
      const extractBase = this.settings.extractDir || path.join(this.settings.outputDir, "_entpackt");
      const extractDir = this.settings.createExtractSubfolder ? ensureDirPath(extractBase, pkg.name) : extractBase;
      const packageEntry: PackageEntry = {
        id: packageId,
        name: sanitizeFilename(pkg.name),
        outputDir,
        extractDir,
        status: "queued",
        itemIds: [],
        cancelled: false,
        enabled: true,
        createdAt: nowMs(),
        updatedAt: nowMs()
      };

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
        addedLinks += 1;
      }

      this.session.packages[packageId] = packageEntry;
      this.session.packageOrder.push(packageId);
      addedPackages += 1;
    }

    this.persistSoon();
    this.emitState();
    if (unresolvedByLink.size > 0) {
      void this.resolveQueuedFilenames(unresolvedByLink).catch((err) => logger.warn(`resolveQueuedFilenames Fehler (addPackages): ${compactErrorText(err)}`));
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

        if (!this.session.running) {
          this.runItemIds.delete(itemId);
          this.runOutcomes.delete(itemId);
        }

        this.retryAfterByItem.delete(itemId);
        this.retryStateByItem.delete(itemId);
      }

      const postProcessController = this.packagePostProcessAbortControllers.get(packageId);
      if (postProcessController && !postProcessController.signal.aborted) {
        postProcessController.abort("skip");
      }
      this.packagePostProcessAbortControllers.delete(packageId);
      this.packagePostProcessTasks.delete(packageId);
      this.hybridExtractRequeue.delete(packageId);

      if (!this.session.running) {
        this.runPackageIds.delete(packageId);
      }
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
      return { skipped: true, overwritten: false };
    }

    if (policy === "overwrite") {
      const postProcessController = this.packagePostProcessAbortControllers.get(packageId);
      if (postProcessController && !postProcessController.signal.aborted) {
        postProcessController.abort("overwrite");
      }
      this.packagePostProcessAbortControllers.delete(packageId);
      this.packagePostProcessTasks.delete(packageId);
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
          active.abortReason = "cancel";
          active.abortController.abort("cancel");
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
        item.updatedAt = nowMs();
        this.assignItemTargetPath(item, path.join(pkg.outputDir, sanitizeFilename(item.fileName || filenameFromUrl(item.url))));
        this.runOutcomes.delete(itemId);
        this.itemContributedBytes.delete(itemId);
        this.retryAfterByItem.delete(itemId);
        if (this.session.running) {
          this.runItemIds.add(itemId);
        }
      }
      this.runCompletedPackages.delete(packageId);
      pkg.status = "queued";
      pkg.updatedAt = nowMs();
      this.persistSoon();
      this.emitState(true);
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
        if (entry.isFile()) {
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

  private async renamePathWithExdevFallback(sourcePath: string, targetPath: string): Promise<void> {
    const sourceFsPath = toWindowsLongPathIfNeeded(sourcePath);
    const targetFsPath = toWindowsLongPathIfNeeded(targetPath);
    try {
      await fs.promises.rename(sourceFsPath, targetFsPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code || "")
        : "";
      if (code !== "EXDEV") {
        throw error;
      }
    }

    await fs.promises.copyFile(sourceFsPath, targetFsPath);
    await fs.promises.rm(sourceFsPath, { force: true });
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

  private async autoRenameExtractedVideoFiles(extractDir: string): Promise<number> {
    if (!this.settings.autoRename4sf4sj) {
      return 0;
    }

    const videoFiles = await this.collectVideoFiles(extractDir);
    let renamed = 0;

    for (const sourcePath of videoFiles) {
      const sourceName = path.basename(sourcePath);
      const sourceExt = path.extname(sourceName);
      const sourceBaseName = path.basename(sourceName, sourceExt);
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
      const targetBaseName = buildAutoRenameBaseNameFromFoldersWithOptions(folderCandidates, sourceBaseName, {
        forceEpisodeForSeasonFolder: true
      });
      if (!targetBaseName) {
        continue;
      }

      let targetPath = this.buildSafeAutoRenameTargetPath(sourcePath, targetBaseName, sourceExt);
      if (!targetPath) {
        const fallbackBaseName = this.buildShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName);
        if (fallbackBaseName) {
          targetPath = this.buildSafeAutoRenameTargetPath(sourcePath, fallbackBaseName, sourceExt);
          if (targetPath) {
            logger.warn(`Auto-Rename Fallback wegen Pfadlänge: ${sourceName} -> ${path.basename(targetPath)}`);
          }
        }
        if (!targetPath) {
          const veryShortFallback = this.buildVeryShortPackageFallbackBaseName(folderCandidates, sourceBaseName, targetBaseName);
          if (veryShortFallback) {
            targetPath = this.buildSafeAutoRenameTargetPath(sourcePath, veryShortFallback, sourceExt);
            if (targetPath) {
              logger.warn(`Auto-Rename Kurz-Fallback wegen Pfadlänge: ${sourceName} -> ${path.basename(targetPath)}`);
            }
          }
        }
      }
      if (!targetPath) {
        logger.warn(`Auto-Rename übersprungen (Zielpfad zu lang/ungültig): ${sourcePath}`);
        continue;
      }
      if (pathKey(targetPath) === pathKey(sourcePath)) {
        continue;
      }
      if (await this.existsAsync(targetPath)) {
        logger.warn(`Auto-Rename übersprungen (Ziel existiert): ${targetPath}`);
        continue;
      }

      try {
        await this.renamePathWithExdevFallback(sourcePath, targetPath);
        renamed += 1;
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
              await this.renamePathWithExdevFallback(sourcePath, fallbackPath);
              logger.warn(`Auto-Rename Fallback wegen Pfadlänge: ${sourceName} -> ${path.basename(fallbackPath)}`);
              renamed += 1;
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
      }
    }

    if (renamed > 0) {
      logger.info(`Auto-Rename (Scene): ${renamed} Datei(en) umbenannt`);
    }
    return renamed;
  }

  private async moveFileWithExdevFallback(sourcePath: string, targetPath: string): Promise<void> {
    await this.renamePathWithExdevFallback(sourcePath, targetPath);
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
        if (extension === ".mkv") {
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

  private async cleanupRemainingArchiveArtifacts(packageDir: string): Promise<number> {
    if (this.settings.cleanupMode === "none") {
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
            await this.renamePathWithExdevFallback(targetPath, candidate);
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

  private async buildUniqueFlattenTargetPath(targetDir: string, sourcePath: string, reserved: Set<string>): Promise<string> {
    const parsed = path.parse(path.basename(sourcePath));
    const extension = parsed.ext || ".mkv";
    const baseName = sanitizeFilename(parsed.name || "video");

    let index = 1;
    while (true) {
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
  }

  private async collectMkvFilesToLibrary(packageId: string, pkg: PackageEntry): Promise<void> {
    if (!this.settings.collectMkvToLibrary) {
      return;
    }

    const sourceDir = this.settings.autoExtract ? pkg.extractDir : pkg.outputDir;
    const targetDirRaw = String(this.settings.mkvLibraryDir || "").trim();
    if (!sourceDir || !targetDirRaw) {
      logger.warn(`MKV-Sammelordner übersprungen: pkg=${pkg.name}, ungültiger Pfad`);
      return;
    }
    const targetDir = path.resolve(targetDirRaw);
    if (!await this.existsAsync(sourceDir)) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, Quelle fehlt (${sourceDir})`);
      return;
    }

    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
    } catch (error) {
      logger.warn(`MKV-Sammelordner konnte nicht erstellt werden: pkg=${pkg.name}, dir=${targetDir}, reason=${compactErrorText(error)}`);
      return;
    }

    const mkvFiles = await this.collectFilesByExtensions(sourceDir, new Set([".mkv"]));
    if (mkvFiles.length === 0) {
      logger.info(`MKV-Sammelordner: pkg=${pkg.name}, keine MKV gefunden`);
      return;
    }

    const reservedTargets = new Set<string>();
    let moved = 0;
    let skipped = 0;
    let failed = 0;

    for (const sourcePath of mkvFiles) {
      if (isPathInsideDir(sourcePath, targetDir)) {
        skipped += 1;
        continue;
      }
      const targetPath = await this.buildUniqueFlattenTargetPath(targetDir, sourcePath, reservedTargets);
      if (pathKey(sourcePath) === pathKey(targetPath)) {
        skipped += 1;
        continue;
      }

      try {
        await this.moveFileWithExdevFallback(sourcePath, targetPath);
        moved += 1;
      } catch (error) {
        failed += 1;
        logger.warn(`MKV verschieben fehlgeschlagen: ${sourcePath} -> ${targetPath} (${compactErrorText(error)})`);
      }
    }

    if (moved > 0 && await this.existsAsync(sourceDir)) {
      const removedResidual = await this.cleanupNonMkvResidualFiles(sourceDir, targetDir);
      if (removedResidual > 0) {
        logger.info(`MKV-Sammelordner entfernte Restdateien: pkg=${pkg.name}, entfernt=${removedResidual}`);
      }
      const removedDirs = await this.removeEmptyDirectoryTree(sourceDir);
      if (removedDirs > 0) {
        logger.info(`MKV-Sammelordner entfernte leere Ordner: pkg=${pkg.name}, entfernt=${removedDirs}`);
      }
    }

    logger.info(`MKV-Sammelordner: pkg=${pkg.name}, packageId=${packageId}, moved=${moved}, skipped=${skipped}, failed=${failed}, target=${targetDir}`);
  }

  public cancelPackage(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }
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
      this.recordRunOutcome(itemId, "cancelled");
      const active = this.activeTasks.get(itemId);
      if (active) {
        active.abortReason = "cancel";
        active.abortController.abort("cancel");
      }
    }

    const postProcessController = this.packagePostProcessAbortControllers.get(packageId);
    if (postProcessController && !postProcessController.signal.aborted) {
      postProcessController.abort("cancel");
    }

    this.removePackageFromSession(packageId, itemIds);
    this.persistSoon();
    this.emitState(true);

    this.cleanupQueue = this.cleanupQueue
      .then(async () => {
        const removed = await cleanupCancelledPackageArtifactsAsync(outputDir);
        logger.info(`Paket ${packageName} abgebrochen, ${removed} Artefakte gelöscht`);
      })
      .catch((error) => {
        logger.warn(`Cleanup für Paket ${packageName} fehlgeschlagen: ${compactErrorText(error)}`);
      });
  }

  public async start(): Promise<void> {
    if (this.session.running) {
      return;
    }

    const recoveredItems = await this.recoverRetryableItems("start");

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
      this.reservedTargetPaths.clear();
      this.claimedTargetPathByItem.clear();
      this.session.running = false;
      this.session.paused = false;
      this.session.runStartedAt = 0;
      this.session.totalDownloadedBytes = 0;
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

    this.session.running = true;
    this.session.paused = false;
    // By design: runStartedAt and totalDownloadedBytes reset on each start/resume so that
    // duration, average speed, and ETA are calculated relative to the current run, not cumulative.
    this.session.runStartedAt = nowMs();
    this.session.totalDownloadedBytes = 0;
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
    this.session.running = false;
    this.session.paused = false;
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.retryAfterByItem.clear();
    this.lastGlobalProgressBytes = this.session.totalDownloadedBytes;
    this.lastGlobalProgressAt = nowMs();
    this.abortPostProcessing("stop");
    for (const active of this.activeTasks.values()) {
      active.abortReason = "stop";
      active.abortController.abort("stop");
    }
    this.persistSoon();
    this.emitState(true);
  }

  public prepareForShutdown(): void {
    logger.info(`Shutdown-Vorbereitung gestartet: active=${this.activeTasks.size}, running=${this.session.running}, paused=${this.session.paused}`);
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
      if (item.status === "completed" && /^Entpacken/i.test(item.fullStatus || "")) {
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
    this.nonResumableActive = 0;
    this.session.summaryText = "";
    this.lastSettingsPersistAt = 0; // force settings save on shutdown
    this.persistNow();
    this.emitState(true);
    logger.info(`Shutdown-Vorbereitung beendet: requeued=${requeuedItems}`);
  }

  public togglePause(): boolean {
    if (!this.session.running) {
      return false;
    }
    const wasPaused = this.session.paused;
    this.session.paused = !this.session.paused;

    // When pausing: abort active extractions so they don't continue during pause
    if (!wasPaused && this.session.paused) {
      this.abortPostProcessing("pause");
    }

    // When unpausing: clear all retry delays so stuck queued items restart immediately,
    // and abort long-stuck validating/downloading tasks so they get retried fresh.
    if (wasPaused && !this.session.paused) {
      this.retryAfterByItem.clear();
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
      if (item.provider !== "realdebrid" && item.provider !== "megadebrid" && item.provider !== "bestdebrid" && item.provider !== "alldebrid") {
        item.provider = null;
      }
      if (item.status === "cancelled" && item.fullStatus === "Gestoppt") {
        item.status = "queued";
        item.fullStatus = "Wartet";
        item.lastError = "";
        item.speedBps = 0;
        continue;
      }
      if (item.status === "downloading"
        || item.status === "validating"
        || item.status === "extracting"
        || item.status === "integrity_check"
        || item.status === "paused"
        || item.status === "reconnect_wait") {
        item.status = "queued";
        item.fullStatus = "Wartet";
        item.speedBps = 0;
      }
      // Clear stale transient status texts from previous session
      if (item.status === "queued" && item.fullStatus) {
        const fs = item.fullStatus.toLowerCase();
        if (fs.includes("provider-cooldown") || fs.includes("warte auf daten") || fs.includes("keine daten")
          || fs.includes("link wird umgewandelt") || fs.includes("verbindungsfehler")) {
          item.fullStatus = "Wartet";
        }
      }
    }
    for (const pkg of Object.values(this.session.packages)) {
      if (pkg.enabled === undefined) {
        pkg.enabled = true;
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
        pkg.status = success > 0 ? "failed" : "cancelled";
      } else if (success > 0) {
        pkg.status = "completed";
      }
    }
    this.resetSessionTotalsIfQueueEmpty();
    this.persistSoon();
  }

  private applyOnStartCleanupPolicy(): void {
    if (this.settings.completedCleanupPolicy !== "on_start") {
      return;
    }
    for (const pkgId of [...this.session.packageOrder]) {
      const pkg = this.session.packages[pkgId];
      if (!pkg) {
        continue;
      }
      pkg.itemIds = pkg.itemIds.filter((itemId) => {
        const item = this.session.items[itemId];
        if (!item) {
          return false;
        }
        if (item.status === "completed") {
          delete this.session.items[itemId];
          this.itemCount = Math.max(0, this.itemCount - 1);
          return false;
        }
        return true;
      });
      if (pkg.itemIds.length === 0) {
        delete this.session.packages[pkgId];
        this.session.packageOrder = this.session.packageOrder.filter((id) => id !== pkgId);
      }
    }
  }

  private clearPersistTimer(): void {
    if (!this.persistTimer) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  private persistSoon(): void {
    if (this.persistTimer) {
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
      this.lastSettingsPersistAt = now;
      void saveSettingsAsync(this.storagePaths, this.settings).catch((err) => logger.warn(`saveSettingsAsync Fehler: ${compactErrorText(err as Error)}`));
    }
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
        this.emit("state", this.getSnapshot());
        return;
      }
      // Too soon — schedule deferred forced emit
      if (!this.stateEmitTimer) {
        this.stateEmitTimer = setTimeout(() => {
          this.stateEmitTimer = null;
          this.lastStateEmitAt = nowMs();
          this.emit("state", this.getSnapshot());
        }, MIN_FORCE_GAP_MS - sinceLastEmit);
      }
      return;
    }
    if (this.stateEmitTimer) {
      return;
    }
    const itemCount = this.itemCount;
    const emitDelay = this.session.running
      ? itemCount >= 1500
        ? 1200
        : itemCount >= 700
          ? 900
          : itemCount >= 250
            ? 560
            : 320
      : 260;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.lastStateEmitAt = nowMs();
      this.emit("state", this.getSnapshot());
    }, emitDelay);
  }

  private speedEventsHead = 0;
  private speedBytesPerPackage = new Map<string, number>();

  private pruneSpeedEvents(now: number): void {
    const cutoff = now - 3000;
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
    this.runOutcomes.set(itemId, status);
  }

  private dropItemContribution(itemId: string): void {
    const contributed = this.itemContributedBytes.get(itemId) || 0;
    if (contributed > 0) {
      this.session.totalDownloadedBytes = Math.max(0, this.session.totalDownloadedBytes - contributed);
    }
    this.itemContributedBytes.delete(itemId);
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
    this.reservedTargetPaths.set(pathKey(preferredPath), itemId);
    this.claimedTargetPathByItem.set(itemId, preferredPath);
    return preferredPath;
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
        if (/^Entpacken/i.test(item.fullStatus || "")) {
          item.fullStatus = "Entpacken abgebrochen (wird fortgesetzt)";
          item.updatedAt = nowMs();
        }
      }
    }
  }

  private runPackagePostProcessing(packageId: string): Promise<void> {
    const existing = this.packagePostProcessTasks.get(packageId);
    if (existing) {
      this.hybridExtractRequeue.add(packageId);
      return existing;
    }

    const abortController = new AbortController();
    this.packagePostProcessAbortControllers.set(packageId, abortController);

    const task = this.packagePostProcessQueue
      .catch(() => undefined)
      .then(async () => {
        await this.handlePackagePostProcessing(packageId, abortController.signal);
      })
      .catch((error) => {
        logger.warn(`Post-Processing für Paket fehlgeschlagen: ${compactErrorText(error)}`);
      })
      .finally(() => {
        this.packagePostProcessTasks.delete(packageId);
        this.packagePostProcessAbortControllers.delete(packageId);
        this.persistSoon();
        this.emitState();
        if (this.hybridExtractRequeue.delete(packageId)) {
          void this.runPackagePostProcessing(packageId).catch((err) =>
            logger.warn(`runPackagePostProcessing Fehler (hybridRequeue): ${compactErrorText(err)}`)
          );
        }
      });

    this.packagePostProcessTasks.set(packageId, task);
    this.packagePostProcessQueue = task;
    return task;
  }

  private recoverPostProcessingOnStartup(): void {
    const packageIds = [...this.session.packageOrder];
    if (packageIds.length === 0) {
      return;
    }

    let changed = false;
    for (const packageId of packageIds) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled) {
        continue;
      }

      const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
      if (items.length === 0) {
        continue;
      }

      const success = items.filter((item) => item.status === "completed").length;
      const failed = items.filter((item) => item.status === "failed").length;
      const cancelled = items.filter((item) => item.status === "cancelled").length;
      if (success + failed + cancelled < items.length) {
        continue;
      }

      if (this.settings.autoExtract && failed === 0 && success > 0) {
        const needsPostProcess = pkg.status !== "completed"
          || items.some((item) => item.status === "completed" && !isExtractedLabel(item.fullStatus));
        if (needsPostProcess) {
          pkg.status = "queued";
          pkg.updatedAt = nowMs();
          for (const item of items) {
            if (item.status === "completed" && !isExtractedLabel(item.fullStatus)) {
              item.fullStatus = "Entpacken - Ausstehend";
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
        continue;
      }

      const targetStatus = failed > 0
        ? "failed"
        : cancelled > 0
          ? (success > 0 ? "failed" : "cancelled")
          : "completed";
      if (pkg.status !== targetStatus) {
        pkg.status = targetStatus;
        pkg.updatedAt = nowMs();
        changed = true;
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
      if (success + failed + cancelled < items.length || failed > 0 || cancelled > 0 || success === 0) {
        continue;
      }
      const needsExtraction = items.some((item) =>
        item.status === "completed" && !isExtractedLabel(item.fullStatus)
      );
      if (!needsExtraction) {
        continue;
      }
      pkg.status = "queued";
      pkg.updatedAt = nowMs();
      for (const item of items) {
        if (item.status === "completed" && !isExtractedLabel(item.fullStatus)) {
          item.fullStatus = "Entpacken - Ausstehend";
          item.updatedAt = nowMs();
        }
      }
      logger.info(`Entpacken via Start ausgelöst: pkg=${pkg.name}`);
      void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (triggerPending): ${compactErrorText(err)}`));
    }
  }

  public retryExtraction(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) return;
    if (this.packagePostProcessTasks.has(packageId)) return;
    const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
    const completedItems = items.filter((item) => item.status === "completed");
    if (completedItems.length === 0) return;
    pkg.status = "queued";
    pkg.updatedAt = nowMs();
    for (const item of completedItems) {
      if (!isExtractedLabel(item.fullStatus)) {
        item.fullStatus = "Entpacken - Ausstehend";
        item.updatedAt = nowMs();
      }
    }
    logger.info(`Extraktion manuell wiederholt: pkg=${pkg.name}`);
    this.persistSoon();
    this.emitState(true);
    void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (retryExtraction): ${compactErrorText(err)}`));
  }

  public extractNow(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg || pkg.cancelled) return;
    if (this.packagePostProcessTasks.has(packageId)) return;
    const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
    const completedItems = items.filter((item) => item.status === "completed");
    if (completedItems.length === 0) return;
    pkg.status = "queued";
    pkg.updatedAt = nowMs();
    for (const item of completedItems) {
      item.fullStatus = "Entpacken - Ausstehend";
      item.updatedAt = nowMs();
    }
    logger.info(`Jetzt entpacken: pkg=${pkg.name}, completed=${completedItems.length}`);
    this.persistSoon();
    this.emitState(true);
    void this.runPackagePostProcessing(packageId).catch((err) => logger.warn(`runPackagePostProcessing Fehler (extractNow): ${compactErrorText(err)}`));
  }

  private removePackageFromSession(packageId: string, itemIds: string[], reason: "completed" | "deleted" = "deleted"): void {
    const pkg = this.session.packages[packageId];
    if (pkg && this.onHistoryEntryCallback) {
      const completedItems = itemIds.map(id => this.session.items[id]).filter(Boolean) as DownloadItem[];
      const completedCount = completedItems.filter(item => item.status === "completed").length;
      if (completedCount > 0 && (reason === "completed" || pkg.status === "completed")) {
        const totalBytes = completedItems.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
        const durationSeconds = pkg.createdAt > 0 ? Math.max(1, Math.floor((nowMs() - pkg.createdAt) / 1000)) : 1;
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
          status: reason === "completed" ? "completed" : "deleted",
          outputDir: pkg.outputDir
        };
        this.onHistoryEntryCallback(entry);
      }
    }
    const postProcessController = this.packagePostProcessAbortControllers.get(packageId);
    if (postProcessController && !postProcessController.signal.aborted) {
      postProcessController.abort("package_removed");
    }
    this.packagePostProcessAbortControllers.delete(packageId);
    this.packagePostProcessTasks.delete(packageId);
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
    this.runPackageIds.delete(packageId);
    this.runCompletedPackages.delete(packageId);
    this.hybridExtractRequeue.delete(packageId);
    this.resetSessionTotalsIfQueueEmpty();
  }

  // ── Provider Circuit Breaker ──────────────────────────────────────────

  private recordProviderFailure(provider: string): void {
    const now = nowMs();
    const entry = this.providerFailures.get(provider) || { count: 0, lastFailAt: 0, cooldownUntil: 0 };
    // Decay: if last failure was >120s ago, reset count (transient burst is over)
    if (entry.lastFailAt > 0 && now - entry.lastFailAt > 120000) {
      entry.count = 0;
    }
    // Debounce: simultaneous failures (within 2s) count as one failure
    // This prevents 8 parallel downloads failing at once from immediately hitting the threshold
    if (entry.lastFailAt > 0 && now - entry.lastFailAt < 2000) {
      entry.lastFailAt = now;
      this.providerFailures.set(provider, entry);
      return;
    }
    entry.count += 1;
    entry.lastFailAt = now;
    // Escalating cooldown: 20 failures→30s, 35→60s, 50→120s, 80+→300s
    if (entry.count >= 20) {
      const tier = entry.count >= 80 ? 3 : entry.count >= 50 ? 2 : entry.count >= 35 ? 1 : 0;
      const cooldownMs = [30000, 60000, 120000, 300000][tier];
      entry.cooldownUntil = now + cooldownMs;
      logger.warn(`Provider Circuit-Breaker: ${provider} ${entry.count} konsekutive Fehler, Cooldown ${cooldownMs / 1000}s`);
      // Invalidate mega-debrid session on cooldown to force fresh login
      if (provider === "megadebrid" && this.invalidateMegaSessionFn) {
        try {
          this.invalidateMegaSessionFn();
        } catch { /* ignore */ }
      }
    }
    this.providerFailures.set(provider, entry);
  }

  private recordProviderSuccess(provider: string): void {
    if (this.providerFailures.has(provider)) {
      this.providerFailures.delete(provider);
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
    const entry = this.providerFailures.get(provider);
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
  }

  // ── Scheduler ──────────────────────────────────────────────────────────

  private async ensureScheduler(): Promise<void> {
    if (this.scheduleRunning) {
      return;
    }
    this.scheduleRunning = true;
    logger.info("Scheduler gestartet");
    try {
      while (this.session.running) {
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

        if (this.activeTasks.size === 0 && !this.hasQueuedItems() && !this.hasDelayedQueuedItems() && this.packagePostProcessTasks.size === 0) {
          this.finishRun();
          break;
        }

        const maxParallel = Math.max(1, this.settings.maxParallel);
        const schedulerSleepMs = this.activeTasks.size >= maxParallel ? 170 : 120;
        await sleep(schedulerSleepMs);
      }
    } finally {
      this.scheduleRunning = false;
      logger.info("Scheduler beendet");
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
      if (item && (item.status === "downloading" || item.status === "validating")) {
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
      if (item && (item.status === "downloading" || item.status === "validating")) {
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

    this.consecutiveReconnects += 1;
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
      if (active.resumable) {
        active.abortReason = "reconnect";
        active.abortController.abort("reconnect");
      }
    }

    logger.warn(`Reconnect angefordert: ${reason} (consecutive=${this.consecutiveReconnects}, wait=${Math.ceil(cappedWaitMs / 1000)}s)`);
    this.emitState();
  }

  private markQueuedAsReconnectWait(): boolean {
    let changed = false;
    const waitSeconds = Math.max(0, Math.ceil((this.session.reconnectUntil - nowMs()) / 1000));
    const waitText = `Reconnect-Wait (${waitSeconds}s)`;
    const itemIds = this.runItemIds.size > 0 ? this.runItemIds : Object.keys(this.session.items);
    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      const pkg = this.session.packages[item.packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      if (item.status === "queued") {
        item.status = "reconnect_wait";
        item.fullStatus = waitText;
        item.updatedAt = nowMs();
        changed = true;
      }
    }
    if (changed) {
      this.emitState();
    }
    return changed;
  }

  private findNextQueuedItem(): { packageId: string; itemId: string } | null {
    const now = nowMs();
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        const retryAfter = this.retryAfterByItem.get(itemId) || 0;
        if (retryAfter > now) {
          continue;
        }
        if (retryAfter > 0) {
          this.retryAfterByItem.delete(itemId);
        }
        if (item.status === "queued" || item.status === "reconnect_wait") {
          return { packageId, itemId };
        }
      }
    }
    return null;
  }

  private hasQueuedItems(): boolean {
    const now = nowMs();
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        const retryAfter = this.retryAfterByItem.get(itemId) || 0;
        if (retryAfter > now) {
          continue;
        }
        if (item.status === "queued" || item.status === "reconnect_wait") {
          return true;
        }
      }
    }
    return false;
  }

  private hasDelayedQueuedItems(): boolean {
    const now = nowMs();
    for (const [itemId, readyAt] of this.retryAfterByItem.entries()) {
      if (readyAt <= now) {
        continue;
      }
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      if (item.status !== "queued" && item.status !== "reconnect_wait") {
        continue;
      }
      const pkg = this.session.packages[item.packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      return true;
    }
    return false;
  }

  private countQueuedItems(): number {
    let count = 0;
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
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
      stallRetries: Number(active.stallRetries || 0),
      genericErrorRetries: Number(active.genericErrorRetries || 0),
      unrestrictRetries: Number(active.unrestrictRetries || 0)
    });
    // Caller returns immediately after this; startItem().finally releases the active slot,
    // so the retry backoff never blocks a worker.
    this.retryAfterByItem.set(item.id, nowMs() + waitMs);
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
      stallRetries: 0,
      genericErrorRetries: 0,
      unrestrictRetries: 0
    };
    this.retryStateByItem.set(item.id, retryState);
    active.freshRetryUsed = retryState.freshRetryUsed;
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
    while (true) {
      try {
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
        const cooldownProvider = item.provider || this.settings.providerPrimary || "unknown";
        const cooldownMs = this.getProviderCooldownRemaining(cooldownProvider);
        if (cooldownMs > 0) {
          const delayMs = Math.min(cooldownMs + 1000, 310000);
          this.queueRetry(item, active, delayMs, `Provider-Cooldown (${Math.ceil(delayMs / 1000)}s)`);
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
          if (isUnrestrictFailure(errText)) {
            this.recordProviderFailure(cooldownProvider);
            if (isProviderBusyUnrestrictError(errText)) {
              const busyCooldownMs = Math.min(60000, 12000 + Number(active.unrestrictRetries || 0) * 3000);
              this.applyProviderBusyBackoff(cooldownProvider, busyCooldownMs);
            }
          }
          throw unrestrictError;
        }
        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }
        // Unrestrict succeeded - reset provider failure counter
        this.recordProviderSuccess(unrestricted.provider);
        item.provider = unrestricted.provider;
        item.retries += unrestricted.retriesUsed;
        item.fileName = sanitizeFilename(unrestricted.fileName || filenameFromUrl(item.url));
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
        item.fullStatus = `Download läuft (${unrestricted.providerLabel})`;
        item.updatedAt = nowMs();
        this.emitState();

        const maxAttempts = maxItemAttempts;
        let done = false;
        while (!done && item.attempts < maxAttempts) {
          item.attempts += 1;
          if (item.status !== "downloading") {
            item.status = "downloading";
            item.fullStatus = `Download läuft (${providerLabel(item.provider)})`;
            item.updatedAt = nowMs();
            this.emitState();
          }
          const result = await this.downloadToFile(active, unrestricted.directUrl, item.targetPath, item.totalBytes);
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
          const expectsNonEmptyFile = (item.totalBytes || 0) > 0 || isArchiveLikePath(finalTargetPath || item.fileName);
          // Catch both empty files (0 B) and suspiciously small error-response files.
          // A real archive part or video file should be at least 1 KB.
          const tooSmall = expectsNonEmptyFile && (
            fileSizeOnDisk <= 0
            || fileSizeOnDisk < 512
            || (item.totalBytes && item.totalBytes > 10240 && fileSizeOnDisk < 1024)
          );
          if (tooSmall) {
            try {
              fs.rmSync(finalTargetPath, { force: true });
            } catch {
              // ignore
            }
            this.releaseTargetPath(item.id);
            item.downloadedBytes = 0;
            item.progressPercent = 0;
            item.totalBytes = (item.totalBytes || 0) > 0 ? item.totalBytes : null;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            throw new Error(`Datei zu klein (${humanSize(fileSizeOnDisk)}, erwartet ${item.totalBytes ? humanSize(item.totalBytes) : ">1 KB"})`);
          }

          done = true;
        }

        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }

        item.status = "completed";
        item.fullStatus = this.settings.autoExtract
          ? "Entpacken - Ausstehend"
          : `Fertig (${humanSize(item.downloadedBytes)})`;
        item.progressPercent = 100;
        item.speedBps = 0;
        item.updatedAt = nowMs();
        pkg.updatedAt = nowMs();
        this.recordRunOutcome(item.id, "completed");

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
          item.status = "cancelled";
          item.fullStatus = "Gestoppt";
          this.recordRunOutcome(item.id, "cancelled");
          if (!active.resumable && claimedTargetPath && !fs.existsSync(claimedTargetPath)) {
            item.downloadedBytes = 0;
            item.progressPercent = 0;
            item.totalBytes = null;
            this.dropItemContribution(item.id);
          }
          this.retryStateByItem.delete(item.id);
        } else if (reason === "shutdown") {
          item.status = "queued";
          item.speedBps = 0;
          const activePkg = this.session.packages[item.packageId];
          item.fullStatus = activePkg && !activePkg.enabled ? "Paket gestoppt" : "Wartet";
          this.retryStateByItem.delete(item.id);
        } else if (reason === "reconnect") {
          item.status = "queued";
          item.speedBps = 0;
          item.fullStatus = "Wartet auf Reconnect";
          // Persist retry counters so shelve logic survives reconnect interruption
          this.retryStateByItem.set(item.id, {
            freshRetryUsed: Boolean(active.freshRetryUsed),
            stallRetries: Number(active.stallRetries || 0),
            genericErrorRetries: Number(active.genericErrorRetries || 0),
            unrestrictRetries: Number(active.unrestrictRetries || 0)
          });
        } else if (reason === "package_toggle") {
          item.status = "queued";
          item.speedBps = 0;
          item.fullStatus = "Paket gestoppt";
          this.retryStateByItem.set(item.id, {
            freshRetryUsed: Boolean(active.freshRetryUsed),
            stallRetries: Number(active.stallRetries || 0),
            genericErrorRetries: Number(active.genericErrorRetries || 0),
            unrestrictRetries: Number(active.unrestrictRetries || 0)
          });
        } else if (reason === "stall") {
          const stallErrorText = compactErrorText(error);
          const isSlowThroughput = stallErrorText.includes("slow_throughput");
          const wasValidating = item.status === "validating";
          active.stallRetries += 1;
          logger.warn(`Stall erkannt: item=${item.fileName || item.id}, phase=${wasValidating ? "validating" : "downloading"}, retry=${active.stallRetries}/${retryDisplayLimit}, bytes=${item.downloadedBytes}, error=${stallErrorText || "none"}, provider=${item.provider || "?"}`);
          // Shelve check: too many consecutive failures → long pause
          const totalFailures = (active.stallRetries || 0) + (active.unrestrictRetries || 0) + (active.genericErrorRetries || 0);
          if (totalFailures >= 15) {
            item.retries += 1;
            active.stallRetries = Math.floor((active.stallRetries || 0) / 2);
            active.unrestrictRetries = Math.floor((active.unrestrictRetries || 0) / 2);
            active.genericErrorRetries = Math.floor((active.genericErrorRetries || 0) / 2);
            logger.warn(`Item shelved: ${item.fileName || item.id}, totalFailures=${totalFailures}`);
            this.queueRetry(item, active, 300000, `Viele Fehler (${totalFailures}x), Pause 5 min`);
            item.lastError = stallErrorText;
            this.persistSoon();
            this.emitState();
            return;
          }
          if (active.stallRetries <= maxStallRetries) {
            item.retries += 1;
            // Reset partial download so next attempt uses a fresh link
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
            let stallDelayMs = retryDelayWithJitter(active.stallRetries, 300);
            // Respect provider cooldown
            if (item.provider) {
              const providerCooldown = this.getProviderCooldownRemaining(item.provider);
              if (providerCooldown > stallDelayMs) {
                stallDelayMs = providerCooldown + 1000;
              }
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
          const shouldFreshRetry = !active.freshRetryUsed && isFetchFailure(errorText);
          const isHttp416 = /(^|\D)416(\D|$)/.test(errorText);
          if (isHttp416) {
            try {
              fs.rmSync(item.targetPath, { force: true });
            } catch {
              // ignore
            }
            this.releaseTargetPath(item.id);
            item.downloadedBytes = 0;
            item.totalBytes = null;
            item.progressPercent = 0;
            this.dropItemContribution(item.id);
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
            try {
              fs.rmSync(item.targetPath, { force: true });
            } catch {
              // ignore
            }
            this.releaseTargetPath(item.id);
            this.queueRetry(item, active, 450, "Netzwerkfehler erkannt, frischer Retry");
            item.lastError = "";
            item.downloadedBytes = 0;
            item.totalBytes = null;
            item.progressPercent = 0;
            this.persistSoon();
            this.emitState();
            return;
          }

          // Shelve check for non-stall errors
          const totalNonStallFailures = (active.stallRetries || 0) + (active.unrestrictRetries || 0) + (active.genericErrorRetries || 0);
          if (totalNonStallFailures >= 15) {
            item.retries += 1;
            active.stallRetries = Math.floor((active.stallRetries || 0) / 2);
            active.unrestrictRetries = Math.floor((active.unrestrictRetries || 0) / 2);
            active.genericErrorRetries = Math.floor((active.genericErrorRetries || 0) / 2);
            logger.warn(`Item shelved (error path): ${item.fileName || item.id}, totalFailures=${totalNonStallFailures}, error=${errorText}`);
            this.queueRetry(item, active, 300000, `Viele Fehler (${totalNonStallFailures}x), Pause 5 min`);
            item.lastError = errorText;
            this.persistSoon();
            this.emitState();
            return;
          }

          // Permanent link errors (dead link, file removed, hoster unavailable) → fail immediately
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

          if (isUnrestrictFailure(errorText) && active.unrestrictRetries < maxUnrestrictRetries) {
            active.unrestrictRetries += 1;
            item.retries += 1;
            const failureProvider = item.provider || this.settings.providerPrimary || "unknown";
            this.recordProviderFailure(failureProvider);
            if (isProviderBusyUnrestrictError(errorText)) {
              const busyCooldownMs = Math.min(60000, 12000 + Number(active.unrestrictRetries || 0) * 3000);
              this.applyProviderBusyBackoff(failureProvider, busyCooldownMs);
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
            this.queueRetry(item, active, unrestrictDelayMs, `Unrestrict-Fehler, Retry ${active.unrestrictRetries}/${retryDisplayLimit} (${Math.ceil(unrestrictDelayMs / 1000)}s)`);
            item.lastError = errorText;
            this.persistSoon();
            this.emitState();
            return;
          }

          if (active.genericErrorRetries < maxGenericErrorRetries) {
            active.genericErrorRetries += 1;
            item.retries += 1;
            const genericDelayMs = retryDelayWithJitter(active.genericErrorRetries, 400);
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
    knownTotal: number | null
  ): Promise<{ resumable: boolean }> {
    const item = this.session.items[active.itemId];
    if (!item) {
      throw new Error("Download-Item fehlt");
    }

    const configuredRetryLimit = normalizeRetryLimit(this.settings.retryLimit);
    const retryDisplayLimit = retryLimitLabel(configuredRetryLimit);
    const maxAttempts = configuredRetryLimit <= 0 ? Number.MAX_SAFE_INTEGER : configuredRetryLimit + 1;

    let lastError = "";
    let effectiveTargetPath = targetPath;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let existingBytes = 0;
      try {
        const stat = await fs.promises.stat(effectiveTargetPath);
        existingBytes = stat.size;
      } catch {
        // file does not exist
      }
      const headers: Record<string, string> = {};
      if (existingBytes > 0) {
        headers.Range = `bytes=${existingBytes}-`;
      }

      while (this.reconnectActive()) {
        if (active.abortController.signal.aborted) {
          throw new Error(`aborted:${active.abortReason}`);
        }
        await sleep(250);
      }

      let response: Response;
      const connectTimeoutMs = getDownloadConnectTimeoutMs();
      let connectTimer: NodeJS.Timeout | null = null;
      try {
        if (connectTimeoutMs > 0) {
          connectTimer = setTimeout(() => {
            if (active.abortController.signal.aborted) {
              return;
            }
            active.abortReason = "stall";
            active.abortController.abort("stall");
          }, connectTimeoutMs);
        }
        response = await fetch(directUrl, {
          method: "GET",
          headers,
          signal: active.abortController.signal
        });
      } catch (error) {
        if (active.abortController.signal.aborted || String(error).includes("aborted:")) {
          throw error;
        }
        lastError = compactErrorText(error);
        if (attempt < maxAttempts) {
          item.retries += 1;
          item.fullStatus = `Verbindungsfehler, retry ${attempt}/${retryDisplayLimit}`;
          this.emitState();
          await sleep(retryDelayWithJitter(attempt, 300));
          continue;
        }
        throw error;
      } finally {
        if (connectTimer) {
          clearTimeout(connectTimer);
        }
      }

      if (!response.ok) {
        if (response.status === 416 && existingBytes > 0) {
          await response.arrayBuffer().catch(() => undefined);
          const rangeTotal = parseContentRangeTotal(response.headers.get("content-range"));
          const expectedTotal = knownTotal && knownTotal > 0 ? knownTotal : rangeTotal;
          if (expectedTotal && existingBytes === expectedTotal) {
            item.totalBytes = expectedTotal;
            item.downloadedBytes = existingBytes;
            item.progressPercent = 100;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            return { resumable: true };
          }
          // No total available but we have substantial data - assume file is complete
          // This prevents deleting multi-GB files when the server sends 416 without Content-Range
          if (!expectedTotal && existingBytes > 1048576) {
            logger.warn(`HTTP 416 ohne Größeninfo, ${humanSize(existingBytes)} vorhanden – als vollständig behandelt: ${item.fileName}`);
            item.totalBytes = existingBytes;
            item.downloadedBytes = existingBytes;
            item.progressPercent = 100;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            return { resumable: true };
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
          if (attempt < maxAttempts) {
            item.retries += 1;
            await sleep(retryDelayWithJitter(attempt, 280));
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
        if (this.settings.autoReconnect && [429, 503].includes(response.status)) {
          this.requestReconnect(`HTTP ${response.status}`);
        }
        if (attempt < maxAttempts) {
          item.retries += 1;
          item.fullStatus = `Serverfehler ${response.status}, retry ${attempt}/${retryDisplayLimit}`;
          this.emitState();
          await sleep(retryDelayWithJitter(attempt, 350));
          continue;
        }
        throw new Error(lastError);
      }

      const acceptRanges = (response.headers.get("accept-ranges") || "").toLowerCase().includes("bytes");
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
            }
          }
        }

        const resumable = response.status === 206 || acceptRanges;
        active.resumable = resumable;

        // CRITICAL: If we sent Range header but server responded 200 (not 206),
        // it's sending the full file. We MUST write in truncate mode, not append.
        const serverIgnoredRange = existingBytes > 0 && response.status === 200;
        if (serverIgnoredRange) {
          logger.warn(`Server ignorierte Range-Header (HTTP 200 statt 206), starte von vorne: ${item.fileName}`);
        }

        const rawContentLength = Number(response.headers.get("content-length") || 0);
        const contentLength = Number.isFinite(rawContentLength) && rawContentLength > 0 ? rawContentLength : 0;
        const totalFromRange = parseContentRangeTotal(response.headers.get("content-range"));
        if (knownTotal && knownTotal > 0) {
          item.totalBytes = knownTotal;
        } else if (totalFromRange) {
          item.totalBytes = totalFromRange;
        } else if (contentLength > 0) {
          // Only add existingBytes for 206 responses; for 200 the Content-Length is the full file
          item.totalBytes = response.status === 206 ? existingBytes + contentLength : contentLength;
        }

        const writeMode = existingBytes > 0 && response.status === 206 ? "a" : "w";
        if (writeMode === "w") {
          // Starting fresh: subtract any previously counted bytes for this item to avoid double-counting on retry
          const previouslyContributed = this.itemContributedBytes.get(active.itemId) || 0;
          if (previouslyContributed > 0) {
            this.session.totalDownloadedBytes = Math.max(0, this.session.totalDownloadedBytes - previouslyContributed);
            this.itemContributedBytes.set(active.itemId, 0);
          }
          if (existingBytes > 0) {
            await fs.promises.rm(effectiveTargetPath, { force: true });
          }
        }

        await fs.promises.mkdir(path.dirname(effectiveTargetPath), { recursive: true });
        const stream = fs.createWriteStream(effectiveTargetPath, { flags: writeMode });
        let written = writeMode === "a" ? existingBytes : 0;
        let windowBytes = 0;
        let windowStarted = nowMs();
        const itemCount = this.itemCount;
        const uiUpdateIntervalMs = itemCount >= 1500
          ? 650
          : itemCount >= 700
            ? 420
            : itemCount >= 250
              ? 280
              : 170;
        let lastUiEmitAt = 0;
        const stallTimeoutMs = getDownloadStallTimeoutMs();
        const drainTimeoutMs = Math.max(30000, Math.min(300000, stallTimeoutMs > 0 ? stallTimeoutMs * 12 : 120000));
        let lastDiskBusyEmitAt = 0;

        const waitDrain = (): Promise<void> => new Promise((resolve, reject) => {
          if (active.abortController.signal.aborted) {
            reject(new Error(`aborted:${active.abortReason}`));
            return;
          }

          active.blockedOnDiskWrite = true;
          active.blockedOnDiskSince = nowMs();
          if (item.status !== "paused" && !this.session.paused) {
            const nowTick = nowMs();
            if (nowTick - lastDiskBusyEmitAt >= 1200) {
              item.status = "downloading";
              item.speedBps = 0;
              item.fullStatus = `Warte auf Festplatte (${providerLabel(item.provider)})`;
              item.updatedAt = nowTick;
              this.emitState();
              lastDiskBusyEmitAt = nowTick;
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
              if (nowTick - lastIdleEmitAt >= idlePulseMs) {
                item.status = "downloading";
                item.speedBps = 0;
                item.fullStatus = `Warte auf Festplatte (${providerLabel(item.provider)})`;
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
            item.fullStatus = `Warte auf Daten (${providerLabel(item.provider)})`;
            if (nowTick - lastIdleEmitAt >= idlePulseMs) {
              item.updatedAt = nowTick;
              this.emitState();
              lastIdleEmitAt = nowTick;
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
              if (this.reconnectActive() && active.resumable) {
                active.abortReason = "reconnect";
                active.abortController.abort("reconnect");
                throw new Error("aborted:reconnect");
              }

              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              await this.applySpeedLimit(buffer.length, windowBytes, windowStarted, active.abortController.signal);
              if (active.abortController.signal.aborted) {
                throw new Error(`aborted:${active.abortReason}`);
              }
              if (!stream.write(buffer)) {
                await waitDrain();
              }
              written += buffer.length;
              windowBytes += buffer.length;
              this.session.totalDownloadedBytes += buffer.length;
              this.sessionDownloadedBytes += buffer.length;
              this.settings.totalDownloadedAllTime += buffer.length;
              this.itemContributedBytes.set(active.itemId, (this.itemContributedBytes.get(active.itemId) || 0) + buffer.length);
              this.recordSpeed(buffer.length, item.packageId);
              throughputWindowBytes += buffer.length;

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

              const elapsed = Math.max((nowMs() - windowStarted) / 1000, 0.5);
              const speed = windowBytes / elapsed;
              if (elapsed >= 1.2) {
                windowStarted = nowMs();
                windowBytes = 0;
              }

              item.status = "downloading";
              item.speedBps = Math.max(0, Math.floor(speed));
              item.downloadedBytes = written;
              item.progressPercent = item.totalBytes ? Math.max(0, Math.min(100, Math.floor((written / item.totalBytes) * 100))) : 0;
              item.fullStatus = `Download läuft (${providerLabel(item.provider)})`;
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
              reader.releaseLock();
            } catch {
              // ignore
            }
          }
        } catch (error) {
          bodyError = error;
          throw error;
        } finally {
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
            if (!bodyError) {
              throw streamCloseError;
            }
            logger.warn(`Stream-Abschlussfehler unterdrückt: ${compactErrorText(streamCloseError)}`);
          }
          // Ensure stream is fully destroyed before potential retry opens new handle
          if (!stream.destroyed) {
            stream.destroy();
          }
        }

        // Detect tiny error-response files (e.g. hoster returning "Forbidden" with HTTP 200).
        // No legitimate file-hoster download is < 512 bytes.
        if (written > 0 && written < 512) {
          let snippet = "";
          try {
            snippet = await fs.promises.readFile(effectiveTargetPath, "utf8");
            snippet = snippet.slice(0, 200).replace(/[\r\n]+/g, " ").trim();
          } catch { /* ignore */ }
          logger.warn(`Tiny download erkannt (${written} B): "${snippet}"`);
          try {
            await fs.promises.rm(effectiveTargetPath, { force: true });
          } catch { /* ignore */ }
          this.dropItemContribution(active.itemId);
          item.downloadedBytes = 0;
          item.progressPercent = 0;
          throw new Error(`Download zu klein (${written} B) – Hoster-Fehlerseite?${snippet ? ` Inhalt: "${snippet}"` : ""}`);
        }

        item.downloadedBytes = written;
        item.progressPercent = item.totalBytes ? Math.max(0, Math.min(100, Math.floor((written / item.totalBytes) * 100))) : 100;
        item.speedBps = 0;
        item.updatedAt = nowMs();
        return { resumable };
      } catch (error) {
        if (active.abortController.signal.aborted || String(error).includes("aborted:")) {
          throw error;
        }
        lastError = compactErrorText(error);
        if (attempt < maxAttempts) {
          item.retries += 1;
          item.fullStatus = `Downloadfehler, retry ${attempt}/${retryDisplayLimit}`;
          this.emitState();
          await sleep(retryDelayWithJitter(attempt, 350));
          continue;
        }
        throw new Error(lastError || "Download fehlgeschlagen");
      }
    }

    throw new Error(lastError || "Download fehlgeschlagen");
  }

  private async recoverRetryableItems(trigger: "startup" | "start"): Promise<number> {
    let recovered = 0;
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

    if (recovered > 0) {
      for (const packageId of touchedPackages) {
        const pkg = this.session.packages[packageId];
        if (!pkg) {
          continue;
        }
        this.refreshPackageStatus(pkg);
      }
      logger.warn(`Auto-Retry-Recovery (${trigger}): ${recovered} Item(s) wieder in Queue gesetzt`);
    }

    return recovered;
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
      pkg.status = success > 0 ? "failed" : "cancelled";
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
      for (const entry of schedules) {
        if (!entry.enabled) {
          continue;
        }
        if (entry.startHour === entry.endHour) {
          this.cachedSpeedLimitKbps = entry.speedLimitKbps;
          return this.cachedSpeedLimitKbps;
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
      } else if (item.targetPath) {
        pendingPaths.add(pathKey(item.targetPath));
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

    // Build lookup: pathKey → item status for pending items
    const pendingItemStatus = new Map<string, string>();
    for (const itemId of pkg.itemIds) {
      const item = this.session.items[itemId];
      if (item && item.targetPath && item.status !== "completed") {
        pendingItemStatus.set(pathKey(item.targetPath), item.status);
      }
    }

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

      // Disk-fallback: if all parts exist on disk but some items lack "completed" status,
      // allow extraction if none of those parts are actively downloading/validating.
      // This handles items that finished downloading but whose status was not updated.
      const missingParts = partsOnDisk.filter((part) => !completedPaths.has(pathKey(part)));
      let allMissingExistOnDisk = true;
      for (const part of missingParts) {
        try {
          const stat = fs.statSync(part);
          if (stat.size < 10240) {
            allMissingExistOnDisk = false;
            break;
          }
        } catch {
          allMissingExistOnDisk = false;
          break;
        }
      }
      if (!allMissingExistOnDisk) {
        continue;
      }
      const anyActivelyProcessing = missingParts.some((part) => {
        const status = pendingItemStatus.get(pathKey(part));
        return status !== undefined && status !== "failed" && status !== "cancelled";
      });
      if (anyActivelyProcessing) {
        continue;
      }
      logger.info(`Hybrid-Extract Disk-Fallback: ${path.basename(candidate)} (${missingParts.length} Part(s) auf Disk ohne completed-Status)`);
      ready.add(pathKey(candidate));
    }

    return ready;
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
    return false;
  }

  private async runHybridExtraction(packageId: string, pkg: PackageEntry, items: DownloadItem[], signal?: AbortSignal): Promise<void> {
    const readyArchives = await this.findReadyArchiveSets(pkg);
    if (readyArchives.size === 0) {
      logger.info(`Hybrid-Extract: pkg=${pkg.name}, keine fertigen Archive-Sets`);
      return;
    }

    logger.info(`Hybrid-Extract Start: pkg=${pkg.name}, readyArchives=${readyArchives.size}`);
    pkg.status = "extracting";
    this.emitState();

    const completedItems = items.filter((item) => item.status === "completed");

    // Build set of item targetPaths belonging to ready archives
    const hybridItemPaths = new Set<string>();
    let dirFiles: string[] | undefined;
    try {
      dirFiles = (await fs.promises.readdir(pkg.outputDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch { /* ignore */ }
    for (const archiveKey of readyArchives) {
      const parts = collectArchiveCleanupTargets(archiveKey, dirFiles);
      for (const part of parts) {
        hybridItemPaths.add(pathKey(part));
      }
      hybridItemPaths.add(pathKey(archiveKey));
    }
    const hybridItems = completedItems.filter((item) =>
      item.targetPath && hybridItemPaths.has(pathKey(item.targetPath))
    );

    const resolveArchiveItems = (archiveName: string): DownloadItem[] =>
      resolveArchiveItemsFromList(archiveName, hybridItems);

    // Only update the items currently being extracted, not all hybrid items at once
    let currentArchiveItems: DownloadItem[] = [];
    const updateExtractingStatus = (text: string): void => {
      const normalized = String(text || "");
      if (hybridLastStatusText === normalized) {
        return;
      }
      hybridLastStatusText = normalized;
      const updatedAt = nowMs();
      for (const entry of currentArchiveItems) {
        if (isExtractedLabel(entry.fullStatus)) {
          continue;
        }
        if (entry.fullStatus === normalized) {
          continue;
        }
        entry.fullStatus = normalized;
        entry.updatedAt = updatedAt;
      }
    };

    let hybridLastStatusText = "";
    let hybridLastEmitAt = 0;
    let lastHybridArchiveName = "";
    const emitHybridStatus = (text: string, force = false): void => {
      updateExtractingStatus(text);
      const now = nowMs();
      if (!force && now - hybridLastEmitAt < EXTRACT_PROGRESS_EMIT_INTERVAL_MS) {
        return;
      }
      hybridLastEmitAt = now;
      this.emitState();
    };

    // Mark items not yet being extracted as pending
    for (const entry of hybridItems) {
      if (!isExtractedLabel(entry.fullStatus)) {
        entry.fullStatus = "Entpacken - Ausstehend";
        entry.updatedAt = nowMs();
      }
    }
    this.emitState();

    try {
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
        onProgress: (progress) => {
          if (progress.phase === "done") {
            return;
          }
          // When a new archive starts, mark the previous archive's items as done
          if (progress.archiveName && progress.archiveName !== lastHybridArchiveName) {
            if (lastHybridArchiveName && currentArchiveItems.length > 0) {
              const doneAt = nowMs();
              for (const entry of currentArchiveItems) {
                if (!isExtractedLabel(entry.fullStatus)) {
                  entry.fullStatus = "Entpackt - Done";
                  entry.updatedAt = doneAt;
                }
              }
            }
            lastHybridArchiveName = progress.archiveName;
            const resolved = resolveArchiveItems(progress.archiveName);
            currentArchiveItems = resolved;
          }
          const archive = progress.archiveName ? ` · ${progress.archiveName}` : "";
          const elapsed = progress.elapsedMs && progress.elapsedMs >= 1000
            ? ` · ${Math.floor(progress.elapsedMs / 1000)}s`
            : "";
          const activeArchive = Number(progress.archivePercent ?? 0) > 0 ? 1 : 0;
          const currentDisplay = Math.max(0, Math.min(progress.total, progress.current + activeArchive));
          const label = `Entpacken ${progress.percent}% (${currentDisplay}/${progress.total})${archive}${elapsed}`;
          emitHybridStatus(label);
        }
      });

      logger.info(`Hybrid-Extract Ende: pkg=${pkg.name}, extracted=${result.extracted}, failed=${result.failed}`);
      if (result.extracted > 0) {
        await this.autoRenameExtractedVideoFiles(pkg.extractDir);
      }
      if (result.failed > 0) {
        logger.warn(`Hybrid-Extract: ${result.failed} Archive fehlgeschlagen, wird beim finalen Durchlauf erneut versucht`);
      }

      // Mark hybrid items with final status
      const updatedAt = nowMs();
      const targetItems = result.extracted > 0 && result.failed === 0 ? completedItems : hybridItems;
      for (const entry of targetItems) {
        if (isExtractedLabel(entry.fullStatus)) {
          continue;
        }
        const status = entry.fullStatus || "";
        if (/^Entpacken\b/i.test(status) || /^Fertig\b/i.test(status)) {
          if (result.extracted > 0 && result.failed === 0) {
            entry.fullStatus = "Entpackt - Done";
          } else {
            entry.fullStatus = `Fertig (${humanSize(entry.downloadedBytes)})`;
          }
          entry.updatedAt = updatedAt;
        }
      }
    } catch (error) {
      const errorText = String(error || "");
      if (errorText.includes("aborted:extract")) {
        logger.info(`Hybrid-Extract abgebrochen: pkg=${pkg.name}`);
        return;
      }
      logger.warn(`Hybrid-Extract Fehler: pkg=${pkg.name}, reason=${compactErrorText(error)}`);
    }
  }

  private async handlePackagePostProcessing(packageId: string, signal?: AbortSignal): Promise<void> {
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
      try {
        const stat = fs.statSync(item.targetPath);
        // Require file to be either ≥50% of expected size or at least 10 KB to avoid
        // recovering tiny error-response files (e.g. 9-byte "Forbidden" pages).
        const minSize = item.totalBytes && item.totalBytes > 0
          ? Math.max(10240, Math.floor(item.totalBytes * 0.5))
          : 10240;
        if (stat.size >= minSize) {
          logger.info(`Item-Recovery: ${item.fileName} war "${item.status}" aber Datei existiert (${humanSize(stat.size)}), setze auf completed`);
          item.status = "completed";
          item.fullStatus = this.settings.autoExtract ? "Entpacken - Ausstehend" : `Fertig (${humanSize(stat.size)})`;
          item.downloadedBytes = stat.size;
          item.progressPercent = 100;
          item.speedBps = 0;
          item.updatedAt = nowMs();
          this.recordRunOutcome(item.id, "completed");
        } else if (stat.size > 0) {
          logger.warn(`Item-Recovery: ${item.fileName} übersprungen – Datei zu klein (${humanSize(stat.size)}, erwartet mind. ${humanSize(minSize)})`);
        }
      } catch {
        // file doesn't exist, nothing to recover
      }
    }

    const success = items.filter((item) => item.status === "completed").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    logger.info(`Post-Processing Start: pkg=${pkg.name}, success=${success}, failed=${failed}, cancelled=${cancelled}, autoExtract=${this.settings.autoExtract}`);

    const allDone = success + failed + cancelled >= items.length;

    if (!allDone && this.settings.hybridExtract && this.settings.autoExtract && failed === 0 && success > 0) {
      await this.runHybridExtraction(packageId, pkg, items, signal);
      if (signal?.aborted) {
        pkg.status = (pkg.enabled && !this.session.paused) ? "queued" : "paused";
        pkg.updatedAt = nowMs();
        return;
      }
      pkg.status = (pkg.enabled && !this.session.paused) ? "downloading" : "paused";
      pkg.updatedAt = nowMs();
      this.emitState();
      return;
    }

    if (!allDone) {
      pkg.status = (pkg.enabled && !this.session.paused) ? "downloading" : "paused";
      logger.info(`Post-Processing verschoben: pkg=${pkg.name}, noch offene items`);
      return;
    }

    const completedItems = items.filter((item) => item.status === "completed");
    const alreadyMarkedExtracted = completedItems.length > 0 && completedItems.every((item) => isExtractedLabel(item.fullStatus));

    if (this.settings.autoExtract && failed === 0 && success > 0 && !alreadyMarkedExtracted) {
      pkg.status = "extracting";
      this.emitState();

      const resolveArchiveItems = (archiveName: string): DownloadItem[] =>
        resolveArchiveItemsFromList(archiveName, completedItems);

      // Only update items of the currently extracting archive, not all items
      let currentArchiveItems: DownloadItem[] = [];
      const updateExtractingStatus = (text: string): void => {
        const normalized = String(text || "");
        if (lastExtractStatusText === normalized) {
          return;
        }
        lastExtractStatusText = normalized;
        const updatedAt = nowMs();
        for (const entry of currentArchiveItems) {
          if (isExtractedLabel(entry.fullStatus)) {
            continue;
          }
          if (entry.fullStatus === normalized) {
            continue;
          }
          entry.fullStatus = normalized;
          entry.updatedAt = updatedAt;
        }
      };

      let lastExtractStatusText = "";
      let lastExtractEmitAt = 0;
      let lastExtractArchiveName = "";
      const emitExtractStatus = (text: string, force = false): void => {
        updateExtractingStatus(text);
        const now = nowMs();
        if (!force && now - lastExtractEmitAt < EXTRACT_PROGRESS_EMIT_INTERVAL_MS) {
          return;
        }
        lastExtractEmitAt = now;
        this.emitState();
      };

      // Mark all items as pending before extraction starts
      for (const entry of completedItems) {
        if (!isExtractedLabel(entry.fullStatus)) {
          entry.fullStatus = "Entpacken - Ausstehend";
          entry.updatedAt = nowMs();
        }
      }
      this.emitState();

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
          onProgress: (progress) => {
            // When a new archive starts, mark the previous archive's items as done
            if (progress.archiveName && progress.archiveName !== lastExtractArchiveName) {
              if (lastExtractArchiveName && currentArchiveItems.length > 0) {
                const doneAt = nowMs();
                for (const entry of currentArchiveItems) {
                  if (!isExtractedLabel(entry.fullStatus)) {
                    entry.fullStatus = "Entpackt - Done";
                    entry.updatedAt = doneAt;
                  }
                }
              }
              lastExtractArchiveName = progress.archiveName;
              currentArchiveItems = resolveArchiveItems(progress.archiveName);
            }
            const label = progress.phase === "done"
              ? "Entpacken 100%"
              : (() => {
                const archive = progress.archiveName ? ` · ${progress.archiveName}` : "";
                const elapsed = progress.elapsedMs && progress.elapsedMs >= 1000
                  ? ` · ${Math.floor(progress.elapsedMs / 1000)}s`
                  : "";
                const activeArchive = Number(progress.archivePercent ?? 0) > 0 ? 1 : 0;
                const currentDisplay = Math.max(0, Math.min(progress.total, progress.current + activeArchive));
                return `Entpacken ${progress.percent}% (${currentDisplay}/${progress.total})${archive}${elapsed}`;
              })();
            emitExtractStatus(label);
          }
        });
        logger.info(`Post-Processing Entpacken Ende: pkg=${pkg.name}, extracted=${result.extracted}, failed=${result.failed}, lastError=${result.lastError || ""}`);
        if (result.failed > 0) {
          const reason = compactErrorText(result.lastError || "Entpacken fehlgeschlagen");
          for (const entry of completedItems) {
            entry.fullStatus = `Entpack-Fehler: ${reason}`;
            entry.updatedAt = nowMs();
          }
          pkg.status = "failed";
        } else {
          const hasExtractedOutput = await this.directoryHasAnyFiles(pkg.extractDir);
          if (result.extracted > 0 || hasExtractedOutput) {
            await this.autoRenameExtractedVideoFiles(pkg.extractDir);
          }
          const sourceExists = await this.existsAsync(pkg.outputDir);
          let finalStatusText = "";

          if (result.extracted > 0 || hasExtractedOutput) {
            finalStatusText = "Entpackt - Done";
          } else if (!sourceExists) {
            finalStatusText = "Entpackt (Quelle fehlt)";
            logger.warn(`Post-Processing ohne Quellordner: pkg=${pkg.name}, outputDir fehlt`);
          } else {
            finalStatusText = "Entpackt (keine Archive)";
          }

          for (const entry of completedItems) {
            entry.fullStatus = finalStatusText;
            entry.updatedAt = nowMs();
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
              entry.fullStatus = `Entpack-Fehler: ${timeoutReason}`;
              entry.updatedAt = nowMs();
            }
            pkg.status = "failed";
            pkg.updatedAt = nowMs();
            timeoutHandled = true;
          } else {
            for (const entry of completedItems) {
              if (/^Entpacken/i.test(entry.fullStatus || "")) {
                entry.fullStatus = "Entpacken abgebrochen (wird fortgesetzt)";
              }
              entry.updatedAt = nowMs();
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
            entry.fullStatus = `Entpack-Fehler: ${reason}`;
            entry.updatedAt = nowMs();
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
      pkg.status = success > 0 ? "failed" : "cancelled";
    } else {
      pkg.status = "completed";
    }

    if (this.settings.autoExtract && alreadyMarkedExtracted && failed === 0 && success > 0 && this.settings.cleanupMode !== "none") {
      const removedArchives = await this.cleanupRemainingArchiveArtifacts(pkg.outputDir);
      if (removedArchives > 0) {
        logger.info(`Hybrid-Post-Cleanup entfernte Archive: pkg=${pkg.name}, entfernt=${removedArchives}`);
      }
    }

    if (success > 0 && (pkg.status === "completed" || pkg.status === "failed")) {
      await this.collectMkvFilesToLibrary(packageId, pkg);
    }
    if (this.runPackageIds.has(packageId)) {
      if (pkg.status === "completed") {
        this.runCompletedPackages.add(packageId);
      } else {
        this.runCompletedPackages.delete(packageId);
      }
    }
    pkg.updatedAt = nowMs();
    logger.info(`Post-Processing Ende: pkg=${pkg.name}, status=${pkg.status}`);

    this.applyPackageDoneCleanup(packageId);
  }

  private applyPackageDoneCleanup(packageId: string): void {
    const policy = this.settings.completedCleanupPolicy;
    if (policy !== "package_done" && policy !== "immediate") {
      return;
    }

    const pkg = this.session.packages[packageId];
    if (!pkg || pkg.status !== "completed") {
      return;
    }

    if (policy === "immediate") {
      for (const itemId of [...pkg.itemIds]) {
        this.applyCompletedCleanupPolicy(packageId, itemId);
      }
      return;
    }

    const allCompleted = pkg.itemIds.every((itemId) => {
      const item = this.session.items[itemId];
      return !item || item.status === "completed";
    });
    if (!allCompleted) {
      return;
    }

    // With autoExtract: only remove once ALL items are extracted, not just downloaded
    if (this.settings.autoExtract) {
      const allExtracted = pkg.itemIds.every((itemId) => {
        const item = this.session.items[itemId];
        return !item || isExtractedLabel(item.fullStatus || "");
      });
      if (!allExtracted) {
        return;
      }
    }

    this.removePackageFromSession(packageId, [...pkg.itemIds], "completed");
  }

  private applyCompletedCleanupPolicy(packageId: string, itemId: string): void {
    const policy = this.settings.completedCleanupPolicy;
    if (policy === "never" || policy === "on_start") {
      return;
    }

    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }

    if (policy === "immediate") {
      if (this.settings.autoExtract) {
        const item = this.session.items[itemId];
        const extracted = item ? isExtractedLabel(item.fullStatus || "") : false;
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
      if (pkg.itemIds.length === 0) {
        this.removePackageFromSession(packageId, []);
      }
      return;
    }

    if (policy === "package_done") {
      const hasOpen = pkg.itemIds.some((id) => {
        const item = this.session.items[id];
        return item != null && item.status !== "completed";
      });
      if (!hasOpen) {
        // With autoExtract: only remove once ALL items are extracted, not just downloaded
        if (this.settings.autoExtract) {
          const allExtracted = pkg.itemIds.every((id) => {
            const item = this.session.items[id];
            return !item || isExtractedLabel(item.fullStatus || "");
          });
          if (!allExtracted) {
            return;
          }
        }
        this.removePackageFromSession(packageId, [...pkg.itemIds]);
      }
    }
  }

  private finishRun(): void {
    this.session.running = false;
    this.session.paused = false;
    const total = this.runItemIds.size;
    const outcomes = Array.from(this.runOutcomes.values());
    const success = outcomes.filter((status) => status === "completed").length;
    const failed = outcomes.filter((status) => status === "failed").length;
    const cancelled = outcomes.filter((status) => status === "cancelled").length;
    const extracted = this.runCompletedPackages.size;
    const duration = this.session.runStartedAt > 0 ? Math.max(1, Math.floor((nowMs() - this.session.runStartedAt) / 1000)) : 1;
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
    this.runPackageIds.clear();
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.retryAfterByItem.clear();
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
          speedBps: event.bytes * 3
        });
      }
    }

    const paused = this.session.running && this.session.paused;
    const currentSpeedBps = paused ? 0 : this.speedBytesLastWindow / 3;

    let totalBytes = 0;
    let maxSpeed = 0;
    for (let i = this.speedEventsHead; i < this.speedEvents.length; i += 1) {
      const event = this.speedEvents[i];
      if (event) {
        totalBytes += event.bytes;
        const speed = event.bytes * 3;
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
      } else if (item.status === "downloading" || item.status === "validating") {
        activeDownloads += 1;
      } else if (item.status === "queued" || item.status === "reconnect_wait") {
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
