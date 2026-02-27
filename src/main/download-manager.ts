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
  PackageEntry,
  ParsedPackageInput,
  SessionState,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot
} from "../shared/types";
import { REQUEST_RETRIES } from "./constants";
import { cleanupCancelledPackageArtifactsAsync } from "./cleanup";
import { DebridService, MegaWebUnrestrictor } from "./debrid";
import { collectArchiveCleanupTargets, extractPackageArchives } from "./extractor";
import { validateFileAgainstManifest } from "./integrity";
import { logger } from "./logger";
import { StoragePaths, saveSession } from "./storage";
import { compactErrorText, ensureDirPath, filenameFromUrl, formatEta, humanSize, looksLikeOpaqueFilename, nowMs, sanitizeFilename, sleep } from "./utils";

type ActiveTask = {
  itemId: string;
  packageId: string;
  abortController: AbortController;
  abortReason: "stop" | "cancel" | "reconnect" | "package_toggle" | "stall" | "shutdown" | "none";
  resumable: boolean;
  speedEvents: Array<{ at: number; bytes: number }>;
  nonResumableCounted: boolean;
};

const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 60000;

function getDownloadStallTimeoutMs(): number {
  const fromEnv = Number(process.env.RD_STALL_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(fromEnv) && fromEnv >= 2000 && fromEnv <= 600000) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS;
}

type DownloadManagerOptions = {
  megaWebUnrestrict?: MegaWebUnrestrictor;
};

function cloneSession(session: SessionState): SessionState {
  return JSON.parse(JSON.stringify(session)) as SessionState;
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
    value = value.replace(/^UTF-8''/i, "");
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

function canRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isArchiveLikePath(filePath: string): boolean {
  const lower = path.basename(filePath).toLowerCase();
  return /\.(?:part\d+\.rar|rar|r\d{2}|zip|z\d{2}|7z|7z\.\d{3})$/i.test(lower);
}

function isFetchFailure(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return text.includes("fetch failed") || text.includes("socket hang up") || text.includes("econnreset") || text.includes("network error");
}

function isFinishedStatus(status: DownloadStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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

export class DownloadManager extends EventEmitter {
  private settings: AppSettings;

  private session: SessionState;

  private storagePaths: StoragePaths;

  private debridService: DebridService;

  private activeTasks = new Map<string, ActiveTask>();

  private scheduleRunning = false;

  private persistTimer: NodeJS.Timeout | null = null;

  private speedEvents: Array<{ at: number; bytes: number }> = [];

  private summary: DownloadSummary | null = null;

  private nonResumableActive = 0;

  private stateEmitTimer: NodeJS.Timeout | null = null;

  private speedBytesLastWindow = 0;

  private cleanupQueue: Promise<void> = Promise.resolve();

  private packagePostProcessQueue: Promise<void> = Promise.resolve();

  private packagePostProcessTasks = new Map<string, Promise<void>>();

  private reservedTargetPaths = new Map<string, string>();

  private claimedTargetPathByItem = new Map<string, string>();

  private runItemIds = new Set<string>();

  private runPackageIds = new Set<string>();

  private runOutcomes = new Map<string, "completed" | "failed" | "cancelled">();

  private runCompletedPackages = new Set<string>();

  private lastSchedulerHeartbeatAt = 0;

  public constructor(settings: AppSettings, session: SessionState, storagePaths: StoragePaths, options: DownloadManagerOptions = {}) {
    super();
    this.settings = settings;
    this.session = cloneSession(session);
    this.storagePaths = storagePaths;
    this.debridService = new DebridService(settings, { megaWebUnrestrict: options.megaWebUnrestrict });
    this.applyOnStartCleanupPolicy();
    this.normalizeSessionStatuses();
    this.recoverRetryableItems("startup");
    this.recoverPostProcessingOnStartup();
    this.resolveExistingQueuedOpaqueFilenames();
    this.cleanupExistingExtractedArchives();
  }

  public setSettings(next: AppSettings): void {
    this.settings = next;
    this.debridService.setSettings(next);
    this.resolveExistingQueuedOpaqueFilenames();
    this.cleanupExistingExtractedArchives();
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

    let totalItems = Object.keys(this.session.items).length;
    let doneItems = Object.values(this.session.items).filter((item) => isFinishedStatus(item.status)).length;
    if (this.session.running && this.runItemIds.size > 0) {
      totalItems = this.runItemIds.size;
      doneItems = 0;
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
    }
    const elapsed = this.session.runStartedAt > 0 ? (now - this.session.runStartedAt) / 1000 : 0;
    const rate = doneItems > 0 && elapsed > 0 ? doneItems / elapsed : 0;
    const remaining = totalItems - doneItems;
    const eta = remaining > 0 && rate > 0 ? remaining / rate : -1;

    const reconnectMs = Math.max(0, this.session.reconnectUntil - now);

    return {
      settings: this.settings,
      session: this.session,
      summary: this.summary,
      stats: this.getStats(),
      speedText: `Geschwindigkeit: ${humanSize(Math.max(0, Math.floor(speedBps)))}/s`,
      etaText: paused ? "ETA: --" : `ETA: ${formatEta(eta)}`,
      canStart: !this.session.running,
      canStop: this.session.running,
      canPause: this.session.running,
      clipboardActive: this.settings.clipboardWatch,
      reconnectSeconds: Math.ceil(reconnectMs / 1000)
    };
  }

  public getStats(): DownloadStats {
    let totalDownloaded = 0;
    let totalFiles = 0;
    for (const item of Object.values(this.session.items)) {
      if (item.status === "completed") {
        totalDownloaded += item.downloadedBytes;
        totalFiles += 1;
      }
    }

    if (this.session.running) {
      let visibleRunBytes = 0;
      for (const itemId of this.runItemIds) {
        const item = this.session.items[itemId];
        if (item) {
          visibleRunBytes += item.downloadedBytes;
        }
      }
      totalDownloaded += Math.max(0, this.session.totalDownloadedBytes - visibleRunBytes);
    } else {
      totalDownloaded = Math.max(totalDownloaded, this.session.totalDownloadedBytes);
    }

    return {
      totalDownloaded,
      totalFiles,
      totalPackages: Object.keys(this.session.packages).length,
      sessionStartedAt: this.session.runStartedAt
    };
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
    const valid = packageIds.filter((id) => this.session.packages[id]);
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
    this.releaseTargetPath(itemId);
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
      if (pkg.status === "downloading") {
        pkg.status = "paused";
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
      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item) {
          continue;
        }
        if (item.status === "queued" && item.fullStatus === "Paket gestoppt") {
          item.fullStatus = "Wartet";
          item.updatedAt = nowMs();
        }
      }
      if (this.session.running) {
        void this.ensureScheduler();
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
    const data = JSON.parse(json) as { packages?: Array<{ name: string; links: string[] }> };
    if (!Array.isArray(data.packages)) {
      return { addedPackages: 0, addedLinks: 0 };
    }
    const inputs: ParsedPackageInput[] = data.packages
      .filter((pkg) => pkg.name && Array.isArray(pkg.links) && pkg.links.length > 0)
      .map((pkg) => ({ name: pkg.name, links: pkg.links }));
    return this.addPackages(inputs);
  }

  public clearAll(): void {
    this.stop();
    this.session.packageOrder = [];
    this.session.packages = {};
    this.session.items = {};
    this.session.summaryText = "";
    this.runItemIds.clear();
    this.runPackageIds.clear();
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();
    this.packagePostProcessTasks.clear();
    this.packagePostProcessQueue = Promise.resolve();
    this.summary = null;
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

      for (const link of links) {
        const itemId = uuidv4();
        const fileName = filenameFromUrl(link);
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
          targetPath: path.join(outputDir, fileName),
          resumable: true,
          attempts: 0,
          lastError: "",
          fullStatus: "Wartet",
          createdAt: nowMs(),
          updatedAt: nowMs()
        };
        packageEntry.itemIds.push(itemId);
        this.session.items[itemId] = item;
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
      void this.resolveQueuedFilenames(unresolvedByLink);
    }
    return { addedPackages, addedLinks };
  }

  public getStartConflicts(): StartConflictEntry[] {
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
        : this.directoryHasAnyFiles(pkg.extractDir);
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
      for (const itemId of pkg.itemIds) {
        const active = this.activeTasks.get(itemId);
        if (active) {
          active.abortReason = "cancel";
          active.abortController.abort("cancel");
        }
        this.releaseTargetPath(itemId);
        delete this.session.items[itemId];
      }
      delete this.session.packages[packageId];
      this.session.packageOrder = this.session.packageOrder.filter((id) => id !== packageId);
      this.persistSoon();
      this.emitState(true);
      return { skipped: true, overwritten: false };
    }

    if (policy === "overwrite") {
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
        item.targetPath = path.join(pkg.outputDir, sanitizeFilename(item.fileName || filenameFromUrl(item.url)));
      }
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
          item.targetPath = path.join(this.session.packages[item.packageId]?.outputDir || this.settings.outputDir, normalized);
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
      void this.resolveQueuedFilenames(unresolvedByLink);
    }
  }

  private cleanupExistingExtractedArchives(): void {
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
    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled || pkg.status !== "completed") {
        continue;
      }

      const items = pkg.itemIds
        .map((itemId) => this.session.items[itemId])
        .filter(Boolean) as DownloadItem[];
      if (items.length === 0 || !items.every((item) => item.status === "completed")) {
        continue;
      }

      const hasExtractMarker = items.some((item) => /entpack/i.test(item.fullStatus));
      const extractDirIsUnique = (extractDirUsage.get(pathKey(pkg.extractDir)) || 0) === 1;
      const hasExtractedOutput = extractDirIsUnique && this.directoryHasAnyFiles(pkg.extractDir);
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
        for (const cleanupTarget of collectArchiveCleanupTargets(targetPath)) {
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

          logger.info(`Nachträgliches Cleanup geprüft: pkg=${pkg.name}, targets=${targets.size}, marker=${pkg.itemIds.some((id) => /entpack/i.test(this.session.items[id]?.fullStatus || ""))}`);

          let removed = 0;
          for (const targetPath of targets) {
            if (!fs.existsSync(targetPath)) {
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
            if (!this.directoryHasAnyFiles(pkg.outputDir)) {
              const removedDirs = this.removeEmptyDirectoryTree(pkg.outputDir);
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

  private directoryHasAnyFiles(rootDir: string): boolean {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return false;
    }
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
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

  private removeEmptyDirectoryTree(rootDir: string): number {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return 0;
    }

    const dirs = [rootDir];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
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
        const entries = fs.readdirSync(dirPath);
        if (entries.length === 0) {
          fs.rmdirSync(dirPath);
          removed += 1;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  }

  public cancelPackage(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }
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

  public start(): void {
    if (this.session.running) {
      return;
    }

    const recoveredItems = this.recoverRetryableItems("start");
    if (recoveredItems > 0) {
      this.persistSoon();
      this.emitState(true);
    }

    const runItems = Object.values(this.session.items)
      .filter((item) => {
        if (item.status !== "queued" && item.status !== "reconnect_wait") {
          return false;
        }
        const pkg = this.session.packages[item.packageId];
        return Boolean(pkg && !pkg.cancelled && pkg.enabled);
      });
    if (runItems.length === 0) {
      this.runItemIds.clear();
      this.runPackageIds.clear();
      this.runOutcomes.clear();
      this.runCompletedPackages.clear();
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
      this.summary = null;
      this.persistSoon();
      this.emitState(true);
      return;
    }
    this.runItemIds = new Set(runItems.map((item) => item.id));
    this.runPackageIds = new Set(runItems.map((item) => item.packageId));
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();

    this.session.running = true;
    this.session.paused = false;
    this.session.runStartedAt = nowMs();
    this.session.totalDownloadedBytes = 0;
    this.session.summaryText = "";
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.summary = null;
    this.persistSoon();
    this.emitState(true);
    this.ensureScheduler();
  }

  public stop(): void {
    this.session.running = false;
    this.session.paused = false;
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";
    for (const active of this.activeTasks.values()) {
      active.abortReason = "stop";
      active.abortController.abort("stop");
    }
    this.persistSoon();
    this.emitState(true);
  }

  public prepareForShutdown(): void {
    logger.info(`Shutdown-Vorbereitung gestartet: active=${this.activeTasks.size}, running=${this.session.running}, paused=${this.session.paused}`);
    this.session.running = false;
    this.session.paused = false;
    this.session.reconnectUntil = 0;
    this.session.reconnectReason = "";

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

    this.speedEvents = [];
    this.speedBytesLastWindow = 0;
    this.runItemIds.clear();
    this.runPackageIds.clear();
    this.runOutcomes.clear();
    this.runCompletedPackages.clear();
    this.session.summaryText = "";
    this.persistNow();
    this.emitState(true);
    logger.info(`Shutdown-Vorbereitung beendet: requeued=${requeuedItems}`);
  }

  public togglePause(): boolean {
    if (!this.session.running) {
      return false;
    }
    this.session.paused = !this.session.paused;
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
        item.speedBps = 0;
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
        || item.status === "validating"
        || item.status === "downloading"
        || item.status === "paused"
        || item.status === "extracting"
        || item.status === "integrity_check"
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
      } else if (cancelled > 0 && success === 0) {
        pkg.status = "cancelled";
      } else if (success > 0) {
        pkg.status = "completed";
      }
    }
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

  private persistSoon(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 250);
  }

  private persistNow(): void {
    saveSession(this.storagePaths, this.session);
  }

  private emitState(force = false): void {
    if (force) {
      if (this.stateEmitTimer) {
        clearTimeout(this.stateEmitTimer);
        this.stateEmitTimer = null;
      }
      this.emit("state", this.getSnapshot());
      return;
    }
    if (this.stateEmitTimer) {
      return;
    }
    const itemCount = Object.keys(this.session.items).length;
    const emitDelay = this.session.running
      ? itemCount >= 1500
        ? 900
        : itemCount >= 700
          ? 650
          : itemCount >= 250
            ? 420
            : 280
      : 260;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.emit("state", this.getSnapshot());
    }, emitDelay);
  }

  private pruneSpeedEvents(now: number): void {
    while (this.speedEvents.length > 0 && this.speedEvents[0].at < now - 3000) {
      const event = this.speedEvents.shift();
      if (event) {
        this.speedBytesLastWindow = Math.max(0, this.speedBytesLastWindow - event.bytes);
      }
    }
  }

  private recordSpeed(bytes: number): void {
    const now = nowMs();
    const bucket = now - (now % 120);
    const last = this.speedEvents[this.speedEvents.length - 1];
    if (last && last.at === bucket) {
      last.bytes += bytes;
    } else {
      this.speedEvents.push({ at: bucket, bytes });
    }
    this.speedBytesLastWindow += bytes;
    this.pruneSpeedEvents(now);
  }

  private recordRunOutcome(itemId: string, status: "completed" | "failed" | "cancelled"): void {
    if (!this.runItemIds.has(itemId)) {
      return;
    }
    this.runOutcomes.set(itemId, status);
  }

  private claimTargetPath(itemId: string, preferredPath: string, allowExistingFile = false): string {
    const existingClaim = this.claimedTargetPathByItem.get(itemId);
    if (existingClaim) {
      const owner = this.reservedTargetPaths.get(pathKey(existingClaim));
      if (owner === itemId) {
        return existingClaim;
      }
      this.claimedTargetPathByItem.delete(itemId);
    }

    const parsed = path.parse(preferredPath);
    let index = 0;
    while (true) {
      const candidate = index === 0
        ? preferredPath
        : path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
      const key = pathKey(candidate);
      const owner = this.reservedTargetPaths.get(key);
      const existsOnDisk = fs.existsSync(candidate);
      const allowExistingCandidate = allowExistingFile && index === 0;
      if ((!owner || owner === itemId) && (owner === itemId || !existsOnDisk || allowExistingCandidate)) {
        this.reservedTargetPaths.set(key, itemId);
        this.claimedTargetPathByItem.set(itemId, candidate);
        return candidate;
      }
      index += 1;
    }
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

  private runPackagePostProcessing(packageId: string): Promise<void> {
    const existing = this.packagePostProcessTasks.get(packageId);
    if (existing) {
      return existing;
    }

    const task = this.packagePostProcessQueue
      .catch(() => undefined)
      .then(async () => {
        await this.handlePackagePostProcessing(packageId);
      })
      .catch((error) => {
        logger.warn(`Post-Processing für Paket fehlgeschlagen: ${compactErrorText(error)}`);
      })
      .finally(() => {
        this.packagePostProcessTasks.delete(packageId);
        this.persistSoon();
        this.emitState();
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
          || items.some((item) => item.status === "completed" && item.fullStatus !== "Entpackt");
        if (needsPostProcess) {
          void this.runPackagePostProcessing(packageId);
        } else if (pkg.status !== "completed") {
          pkg.status = "completed";
          pkg.updatedAt = nowMs();
          changed = true;
        }
        continue;
      }

      const targetStatus = failed > 0 ? "failed" : cancelled > 0 && success === 0 ? "cancelled" : "completed";
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

  private removePackageFromSession(packageId: string, itemIds: string[]): void {
    for (const itemId of itemIds) {
      delete this.session.items[itemId];
    }
    delete this.session.packages[packageId];
    this.session.packageOrder = this.session.packageOrder.filter((id) => id !== packageId);
  }

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

        if (this.session.paused) {
          await sleep(120);
          continue;
        }

        if (this.reconnectActive() && (this.nonResumableActive > 0 || this.activeTasks.size === 0)) {
          this.markQueuedAsReconnectWait();
          await sleep(200);
          continue;
        }

        while (this.activeTasks.size < Math.max(1, this.settings.maxParallel)) {
          const next = this.findNextQueuedItem();
          if (!next) {
            break;
          }
          this.startItem(next.packageId, next.itemId);
        }

        if (this.activeTasks.size === 0 && !this.hasQueuedItems() && this.packagePostProcessTasks.size === 0) {
          this.finishRun();
          break;
        }

        await sleep(120);
      }
    } finally {
      this.scheduleRunning = false;
      logger.info("Scheduler beendet");
    }
  }

  private reconnectActive(): boolean {
    return this.session.reconnectUntil > nowMs();
  }

  private requestReconnect(reason: string): void {
    if (!this.settings.autoReconnect) {
      return;
    }

    const until = nowMs() + this.settings.reconnectWaitSeconds * 1000;
    this.session.reconnectUntil = Math.max(this.session.reconnectUntil, until);
    this.session.reconnectReason = reason;

    for (const active of this.activeTasks.values()) {
      if (active.resumable) {
        active.abortReason = "reconnect";
        active.abortController.abort("reconnect");
      }
    }

    logger.warn(`Reconnect angefordert: ${reason}`);
    this.emitState();
  }

  private markQueuedAsReconnectWait(): void {
    for (const item of Object.values(this.session.items)) {
      const pkg = this.session.packages[item.packageId];
      if (!pkg || pkg.cancelled || !pkg.enabled) {
        continue;
      }
      if (item.status === "queued") {
        item.status = "reconnect_wait";
        item.fullStatus = `Reconnect-Wait (${Math.ceil((this.session.reconnectUntil - nowMs()) / 1000)}s)`;
        item.updatedAt = nowMs();
      }
    }
    this.emitState();
  }

  private findNextQueuedItem(): { packageId: string; itemId: string } | null {
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
          return { packageId, itemId };
        }
      }
    }
    return null;
  }

  private hasQueuedItems(): boolean {
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
          return true;
        }
      }
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

  private startItem(packageId: string, itemId: string): void {
    const item = this.session.items[itemId];
    const pkg = this.session.packages[packageId];
    if (!item || !pkg || pkg.cancelled || !pkg.enabled) {
      return;
    }

    item.status = "validating";
    item.fullStatus = "Link wird umgewandelt";
    item.updatedAt = nowMs();
    pkg.status = "downloading";
    pkg.updatedAt = nowMs();

    const active: ActiveTask = {
      itemId,
      packageId,
      abortController: new AbortController(),
      abortReason: "none",
      resumable: true,
      speedEvents: [],
      nonResumableCounted: false
    };
    this.activeTasks.set(itemId, active);
    this.emitState();

    void this.processItem(active).finally(() => {
      this.releaseTargetPath(item.id);
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

    let freshRetryUsed = false;
    let stallRetries = 0;
    let genericErrorRetries = 0;
    const maxGenericErrorRetries = Math.max(2, REQUEST_RETRIES);
    while (true) {
      try {
        const unrestricted = await this.debridService.unrestrictLink(item.url);
        item.provider = unrestricted.provider;
        item.retries += unrestricted.retriesUsed;
        item.fileName = sanitizeFilename(unrestricted.fileName || filenameFromUrl(item.url));
        fs.mkdirSync(pkg.outputDir, { recursive: true });
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

        const maxAttempts = REQUEST_RETRIES;
        let done = false;
        while (!done && item.attempts < maxAttempts) {
          item.attempts += 1;
          const result = await this.downloadToFile(active, unrestricted.directUrl, item.targetPath, item.totalBytes);
          active.resumable = result.resumable;
          if (!active.resumable && !active.nonResumableCounted) {
            active.nonResumableCounted = true;
            this.nonResumableActive += 1;
          }

          if (this.settings.enableIntegrityCheck) {
            item.status = "integrity_check";
            item.fullStatus = "CRC-Check läuft";
            item.updatedAt = nowMs();
            this.emitState();

            const validation = await validateFileAgainstManifest(item.targetPath, pkg.outputDir);
            if (!validation.ok) {
              item.lastError = validation.message;
              item.fullStatus = `${validation.message}, Neuversuch`;
              try {
                fs.rmSync(item.targetPath, { force: true });
              } catch {
                // ignore
              }
              if (item.attempts < maxAttempts) {
                item.status = "queued";
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

          const finalTargetPath = String(item.targetPath || "").trim();
          const fileSizeOnDisk = finalTargetPath && fs.existsSync(finalTargetPath)
            ? fs.statSync(finalTargetPath).size
            : item.downloadedBytes;
          const expectsNonEmptyFile = (item.totalBytes || 0) > 0 || isArchiveLikePath(finalTargetPath || item.fileName);
          if (expectsNonEmptyFile && fileSizeOnDisk <= 0) {
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
            throw new Error("Leere Datei erkannt (0 B)");
          }

          done = true;
        }
        item.status = "completed";
        item.fullStatus = `Fertig (${humanSize(item.downloadedBytes)})`;
        item.progressPercent = 100;
        item.speedBps = 0;
        item.updatedAt = nowMs();
        pkg.updatedAt = nowMs();
        this.recordRunOutcome(item.id, "completed");

        void this.runPackagePostProcessing(pkg.id).finally(() => {
          this.applyCompletedCleanupPolicy(pkg.id, item.id);
          this.persistSoon();
          this.emitState();
        });
        this.persistSoon();
        this.emitState();
        return;
      } catch (error) {
        const reason = active.abortReason;
        if (reason === "cancel") {
          item.status = "cancelled";
          item.fullStatus = "Entfernt";
          this.recordRunOutcome(item.id, "cancelled");
          try {
            fs.rmSync(item.targetPath, { force: true });
          } catch {
            // ignore
          }
        } else if (reason === "stop") {
          item.status = "cancelled";
          item.fullStatus = "Gestoppt";
          this.recordRunOutcome(item.id, "cancelled");
          try {
            fs.rmSync(item.targetPath, { force: true });
          } catch {
            // ignore
          }
        } else if (reason === "shutdown") {
          item.status = "queued";
          item.speedBps = 0;
          const activePkg = this.session.packages[item.packageId];
          item.fullStatus = activePkg && !activePkg.enabled ? "Paket gestoppt" : "Wartet";
        } else if (reason === "reconnect") {
          item.status = "queued";
          item.fullStatus = "Wartet auf Reconnect";
        } else if (reason === "package_toggle") {
          item.status = "queued";
          item.speedBps = 0;
          item.fullStatus = "Paket gestoppt";
        } else if (reason === "stall") {
          stallRetries += 1;
          if (stallRetries <= 2) {
            item.retries += 1;
            item.status = "queued";
            item.speedBps = 0;
            item.fullStatus = `Keine Daten empfangen, Retry ${stallRetries}/2`;
            item.lastError = "";
            item.attempts = 0;
            item.updatedAt = nowMs();
            active.abortController = new AbortController();
            active.abortReason = "none";
            this.persistSoon();
            this.emitState();
            await sleep(350 * stallRetries);
            continue;
          }
          item.status = "failed";
          item.lastError = "Download hing wiederholt";
          item.fullStatus = `Fehler: ${item.lastError}`;
          this.recordRunOutcome(item.id, "failed");
        } else {
          const errorText = compactErrorText(error);
          const shouldFreshRetry = !freshRetryUsed && isFetchFailure(errorText);
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
          }
          if (shouldFreshRetry) {
            freshRetryUsed = true;
            item.retries += 1;
            try {
              fs.rmSync(item.targetPath, { force: true });
            } catch {
              // ignore
            }
            this.releaseTargetPath(item.id);
            item.status = "queued";
            item.fullStatus = "Netzwerkfehler erkannt, frischer Retry";
            item.lastError = "";
            item.attempts = 0;
            item.downloadedBytes = 0;
            item.totalBytes = null;
            item.progressPercent = 0;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            this.persistSoon();
            this.emitState();
            await sleep(450);
            continue;
          }

          if (genericErrorRetries < maxGenericErrorRetries) {
            genericErrorRetries += 1;
            item.retries += 1;
            item.status = "queued";
            item.fullStatus = `Fehler erkannt, Auto-Retry ${genericErrorRetries}/${maxGenericErrorRetries}`;
            item.lastError = errorText;
            item.attempts = 0;
            item.speedBps = 0;
            item.updatedAt = nowMs();
            active.abortController = new AbortController();
            active.abortReason = "none";
            this.persistSoon();
            this.emitState();
            await sleep(Math.min(1200, 300 * genericErrorRetries));
            continue;
          }

          item.status = "failed";
          this.recordRunOutcome(item.id, "failed");
          item.lastError = errorText;
          item.fullStatus = `Fehler: ${item.lastError}`;
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

    let lastError = "";
    let effectiveTargetPath = targetPath;
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      const existingBytes = fs.existsSync(effectiveTargetPath) ? fs.statSync(effectiveTargetPath).size : 0;
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
      try {
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
        if (attempt < REQUEST_RETRIES) {
          item.retries += 1;
          item.fullStatus = `Verbindungsfehler, retry ${attempt + 1}/${REQUEST_RETRIES}`;
          this.emitState();
          await sleep(300 * attempt);
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        if (response.status === 416 && existingBytes > 0) {
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

          try {
            fs.rmSync(effectiveTargetPath, { force: true });
          } catch {
            // ignore
          }
          item.downloadedBytes = 0;
          item.totalBytes = knownTotal && knownTotal > 0 ? knownTotal : null;
          item.progressPercent = 0;
          item.speedBps = 0;
          item.fullStatus = `Range-Konflikt (HTTP 416), starte neu ${Math.min(REQUEST_RETRIES, attempt + 1)}/${REQUEST_RETRIES}`;
          item.updatedAt = nowMs();
          this.emitState();
          if (attempt < REQUEST_RETRIES) {
            item.retries += 1;
            await sleep(280 * attempt);
            continue;
          }
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
        if (attempt < REQUEST_RETRIES) {
          item.retries += 1;
          item.fullStatus = `Serverfehler ${response.status}, retry ${attempt + 1}/${REQUEST_RETRIES}`;
          this.emitState();
          await sleep(350 * attempt);
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

        const contentLength = Number(response.headers.get("content-length") || 0);
        const totalFromRange = parseContentRangeTotal(response.headers.get("content-range"));
        if (knownTotal && knownTotal > 0) {
          item.totalBytes = knownTotal;
        } else if (totalFromRange) {
          item.totalBytes = totalFromRange;
        } else if (contentLength > 0) {
          item.totalBytes = existingBytes + contentLength;
        }

        const writeMode = existingBytes > 0 && response.status === 206 ? "a" : "w";
        if (writeMode === "w" && existingBytes > 0) {
          fs.rmSync(effectiveTargetPath, { force: true });
        }

        const stream = fs.createWriteStream(effectiveTargetPath, { flags: writeMode });
        let written = writeMode === "a" ? existingBytes : 0;
        let windowBytes = 0;
        let windowStarted = nowMs();

        const waitDrain = (): Promise<void> => new Promise((resolve, reject) => {
          const onDrain = (): void => {
            stream.off("error", onError);
            resolve();
          };
          const onError = (streamError: Error): void => {
            stream.off("drain", onDrain);
            reject(streamError);
          };
          stream.once("drain", onDrain);
          stream.once("error", onError);
        });

        try {
          const body = response.body;
          if (!body) {
            throw new Error("Leerer Response-Body");
          }
          const reader = body.getReader();
          const stallTimeoutMs = getDownloadStallTimeoutMs();
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

          while (true) {
            const { done, value } = await readWithTimeout();
            if (done) {
              break;
            }
            const chunk = value;
            if (active.abortController.signal.aborted) {
              throw new Error(`aborted:${active.abortReason}`);
            }
            while (this.session.paused && this.session.running && !active.abortController.signal.aborted) {
              item.status = "paused";
              item.fullStatus = "Pausiert";
              this.emitState();
              await sleep(120);
            }
            if (active.abortController.signal.aborted) {
              throw new Error(`aborted:${active.abortReason}`);
            }
            if (this.reconnectActive() && active.resumable) {
              active.abortReason = "reconnect";
              active.abortController.abort("reconnect");
              throw new Error("aborted:reconnect");
            }

            const buffer = Buffer.from(chunk);
            await this.applySpeedLimit(buffer.length, windowBytes, windowStarted);
            if (active.abortController.signal.aborted) {
              throw new Error(`aborted:${active.abortReason}`);
            }
            if (!stream.write(buffer)) {
              await waitDrain();
            }
            written += buffer.length;
            windowBytes += buffer.length;
            this.session.totalDownloadedBytes += buffer.length;
            this.recordSpeed(buffer.length);

            const elapsed = Math.max((nowMs() - windowStarted) / 1000, 0.1);
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
            item.updatedAt = nowMs();
            this.emitState();
          }
        } finally {
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
        if (attempt < REQUEST_RETRIES) {
          item.retries += 1;
          item.fullStatus = `Downloadfehler, retry ${attempt + 1}/${REQUEST_RETRIES}`;
          this.emitState();
          await sleep(350 * attempt);
          continue;
        }
        throw new Error(lastError || "Download fehlgeschlagen");
      }
    }

    throw new Error(lastError || "Download fehlgeschlagen");
  }

  private recoverRetryableItems(trigger: "startup" | "start"): number {
    let recovered = 0;
    const touchedPackages = new Set<string>();

    for (const packageId of this.session.packageOrder) {
      const pkg = this.session.packages[packageId];
      if (!pkg || pkg.cancelled) {
        continue;
      }

      for (const itemId of pkg.itemIds) {
        const item = this.session.items[itemId];
        if (!item || item.status === "cancelled") {
          continue;
        }

        const is416Failure = this.isHttp416Failure(item);
        const hasZeroByteArchive = this.hasZeroByteArchiveArtifact(item);

        if (item.status === "failed") {
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

  private hasZeroByteArchiveArtifact(item: DownloadItem): boolean {
    const targetPath = String(item.targetPath || "").trim();
    const archiveCandidate = isArchiveLikePath(targetPath || item.fileName);
    if (!archiveCandidate) {
      return false;
    }

    if (targetPath && fs.existsSync(targetPath)) {
      try {
        return fs.statSync(targetPath).size <= 0;
      } catch {
        return false;
      }
    }

    if (item.downloadedBytes <= 0 && item.progressPercent >= 100) {
      return true;
    }

    return /\b0\s*B\b/i.test(item.fullStatus || "");
  }

  private refreshPackageStatus(pkg: PackageEntry): void {
    const items = pkg.itemIds
      .map((itemId) => this.session.items[itemId])
      .filter(Boolean) as DownloadItem[];
    if (items.length === 0) {
      return;
    }

    const hasPending = items.some((item) => (
      item.status === "queued"
      || item.status === "reconnect_wait"
      || item.status === "validating"
      || item.status === "downloading"
      || item.status === "paused"
      || item.status === "extracting"
      || item.status === "integrity_check"
    ));
    if (hasPending) {
      pkg.status = pkg.enabled ? "queued" : "paused";
      pkg.updatedAt = nowMs();
      return;
    }

    const success = items.filter((item) => item.status === "completed").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;

    if (failed > 0) {
      pkg.status = "failed";
    } else if (cancelled > 0 && success === 0) {
      pkg.status = "cancelled";
    } else if (success > 0) {
      pkg.status = "completed";
    }
    pkg.updatedAt = nowMs();
  }

  private getEffectiveSpeedLimitKbps(): number {
    const schedules = this.settings.bandwidthSchedules;
    if (schedules.length > 0) {
      const hour = new Date().getHours();
      for (const entry of schedules) {
        if (!entry.enabled) {
          continue;
        }
        const wraps = entry.startHour > entry.endHour;
        const inRange = wraps
          ? hour >= entry.startHour || hour < entry.endHour
          : hour >= entry.startHour && hour < entry.endHour;
        if (inRange) {
          return entry.speedLimitKbps;
        }
      }
    }
    if (this.settings.speedLimitEnabled && this.settings.speedLimitKbps > 0) {
      return this.settings.speedLimitKbps;
    }
    return 0;
  }

  private async applySpeedLimit(chunkBytes: number, localWindowBytes: number, localWindowStarted: number): Promise<void> {
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
          await sleep(Math.min(300, sleepMs));
        }
      }
      return;
    }

    this.pruneSpeedEvents(now);
    const globalBytes = this.speedBytesLastWindow + chunkBytes;
    const globalAllowed = bytesPerSecond * 3;
    if (globalBytes > globalAllowed) {
      await sleep(Math.min(250, Math.ceil(((globalBytes - globalAllowed) / bytesPerSecond) * 1000)));
    }
  }

  private async handlePackagePostProcessing(packageId: string): Promise<void> {
    const pkg = this.session.packages[packageId];
    if (!pkg || pkg.cancelled) {
      return;
    }
    const items = pkg.itemIds.map((id) => this.session.items[id]).filter(Boolean) as DownloadItem[];
    const success = items.filter((item) => item.status === "completed").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    logger.info(`Post-Processing Start: pkg=${pkg.name}, success=${success}, failed=${failed}, cancelled=${cancelled}, autoExtract=${this.settings.autoExtract}`);

    if (success + failed + cancelled < items.length) {
      pkg.status = "downloading";
      logger.info(`Post-Processing verschoben: pkg=${pkg.name}, noch offene items`);
      return;
    }

    const completedItems = items.filter((item) => item.status === "completed");
    const alreadyMarkedExtracted = completedItems.length > 0 && completedItems.every((item) => item.fullStatus === "Entpackt");

    if (this.settings.autoExtract && failed === 0 && success > 0 && !alreadyMarkedExtracted) {
      pkg.status = "extracting";
      this.emitState();

      const updateExtractingStatus = (text: string): void => {
        for (const entry of completedItems) {
          entry.fullStatus = text;
          entry.updatedAt = nowMs();
        }
      };

      updateExtractingStatus("Entpacken 0%");
      this.emitState();

      try {
        const result = await extractPackageArchives({
          packageDir: pkg.outputDir,
          targetDir: pkg.extractDir,
          cleanupMode: this.settings.cleanupMode,
          conflictMode: this.settings.extractConflictMode,
          removeLinks: this.settings.removeLinkFilesAfterExtract,
          removeSamples: this.settings.removeSamplesAfterExtract,
          passwordList: this.settings.archivePasswordList,
          onProgress: (progress) => {
            const label = progress.phase === "done"
              ? "Entpacken 100%"
              : `Entpacken ${progress.percent}% (${progress.current}/${progress.total})`;
            updateExtractingStatus(label);
            this.emitState();
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
          if (result.extracted > 0) {
            for (const entry of completedItems) {
              entry.fullStatus = "Entpackt";
              entry.updatedAt = nowMs();
            }
          }
          pkg.status = "completed";
        }
      } catch (error) {
        const reason = compactErrorText(error);
        logger.error(`Post-Processing Entpacken Exception: pkg=${pkg.name}, reason=${reason}`);
        for (const entry of completedItems) {
          entry.fullStatus = `Entpack-Fehler: ${reason}`;
          entry.updatedAt = nowMs();
        }
        pkg.status = "failed";
      }
    } else if (failed > 0) {
      pkg.status = "failed";
    } else if (cancelled > 0 && success === 0) {
      pkg.status = "cancelled";
    } else {
      pkg.status = "completed";
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
      pkg.itemIds = pkg.itemIds.filter((id) => id !== itemId);
      delete this.session.items[itemId];
    }

    if (policy === "package_done") {
      const hasOpen = pkg.itemIds.some((id) => {
        const item = this.session.items[id];
        if (!item) {
          return false;
        }
        return item.status !== "completed";
      });
      if (!hasOpen) {
        for (const id of pkg.itemIds) {
          delete this.session.items[id];
        }
        delete this.session.packages[packageId];
        this.session.packageOrder = this.session.packageOrder.filter((id) => id !== packageId);
      }
    }

    if (pkg.itemIds.length === 0) {
      delete this.session.packages[packageId];
      this.session.packageOrder = this.session.packageOrder.filter((id) => id !== packageId);
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
    this.reservedTargetPaths.clear();
    this.claimedTargetPathByItem.clear();
    this.persistNow();
    this.emitState();
  }
}
