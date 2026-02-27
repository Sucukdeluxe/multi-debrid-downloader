import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import { AppSettings, DownloadItem, DownloadSummary, DownloadStatus, PackageEntry, ParsedPackageInput, SessionState, UiSnapshot } from "../shared/types";
import { CHUNK_SIZE, REQUEST_RETRIES } from "./constants";
import { cleanupCancelledPackageArtifacts, removeDownloadLinkArtifacts, removeSampleArtifacts } from "./cleanup";
import { DebridService, MegaWebUnrestrictor } from "./debrid";
import { extractPackageArchives } from "./extractor";
import { validateFileAgainstManifest } from "./integrity";
import { logger } from "./logger";
import { StoragePaths, saveSession } from "./storage";
import { compactErrorText, ensureDirPath, filenameFromUrl, formatEta, humanSize, looksLikeOpaqueFilename, nowMs, sanitizeFilename, sleep } from "./utils";

type ActiveTask = {
  itemId: string;
  packageId: string;
  abortController: AbortController;
  abortReason: "stop" | "cancel" | "reconnect" | "none";
  resumable: boolean;
  speedEvents: Array<{ at: number; bytes: number }>;
  nonResumableCounted: boolean;
};

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

function canRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
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

function nextAvailablePath(targetPath: string): string {
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }
  const parsed = path.parse(targetPath);
  let i = 1;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    i += 1;
  }
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

  public constructor(settings: AppSettings, session: SessionState, storagePaths: StoragePaths, options: DownloadManagerOptions = {}) {
    super();
    this.settings = settings;
    this.session = cloneSession(session);
    this.storagePaths = storagePaths;
    this.debridService = new DebridService(settings, { megaWebUnrestrict: options.megaWebUnrestrict });
    this.applyOnStartCleanupPolicy();
    this.normalizeSessionStatuses();
  }

  public setSettings(next: AppSettings): void {
    this.settings = next;
    this.debridService.setSettings(next);
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
    const speedBps = this.speedBytesLastWindow / 3;

    const totalItems = Object.keys(this.session.items).length;
    const doneItems = Object.values(this.session.items).filter((item) => isFinishedStatus(item.status)).length;
    const elapsed = this.session.runStartedAt > 0 ? (now - this.session.runStartedAt) / 1000 : 0;
    const rate = doneItems > 0 && elapsed > 0 ? doneItems / elapsed : 0;
    const remaining = totalItems - doneItems;
    const eta = remaining > 0 && rate > 0 ? remaining / rate : -1;

    return {
      settings: this.settings,
      session: this.getSession(),
      summary: this.summary,
      speedText: `Geschwindigkeit: ${humanSize(Math.max(0, Math.floor(speedBps)))}/s`,
      etaText: `ETA: ${formatEta(eta)}`,
      canStart: !this.session.running,
      canStop: this.session.running,
      canPause: this.session.running
    };
  }

  public clearAll(): void {
    this.stop();
    this.session.packageOrder = [];
    this.session.packages = {};
    this.session.items = {};
    this.session.summaryText = "";
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

  private async resolveQueuedFilenames(unresolvedByLink: Map<string, string[]>): Promise<void> {
    try {
      const resolved = await this.debridService.resolveFilenames(Array.from(unresolvedByLink.keys()));
      if (resolved.size === 0) {
        return;
      }

      let changed = false;
      for (const [link, itemIds] of unresolvedByLink.entries()) {
        const fileName = resolved.get(link);
        if (!fileName || fileName.toLowerCase() === "download.bin") {
          continue;
        }
        const normalized = sanitizeFilename(fileName);
        if (!normalized || normalized.toLowerCase() === "download.bin") {
          continue;
        }

        for (const itemId of itemIds) {
          const item = this.session.items[itemId];
          if (!item) {
            continue;
          }
          if (!looksLikeOpaqueFilename(item.fileName)) {
            continue;
          }
          item.fileName = normalized;
          item.targetPath = path.join(this.session.packages[item.packageId]?.outputDir || this.settings.outputDir, normalized);
          item.updatedAt = nowMs();
          changed = true;
        }
      }

      if (changed) {
        this.persistSoon();
        this.emitState();
      }
    } catch (error) {
      logger.warn(`Dateinamen-Resolve fehlgeschlagen: ${compactErrorText(error)}`);
    }
  }

  public cancelPackage(packageId: string): void {
    const pkg = this.session.packages[packageId];
    if (!pkg) {
      return;
    }
    const itemIds = [...pkg.itemIds];

    for (const itemId of itemIds) {
      const item = this.session.items[itemId];
      if (!item) {
        continue;
      }
      const active = this.activeTasks.get(itemId);
      if (active) {
        active.abortReason = "cancel";
        active.abortController.abort("cancel");
      }
    }

    const removed = cleanupCancelledPackageArtifacts(pkg.outputDir);
    this.removePackageFromSession(packageId, itemIds);
    logger.info(`Paket ${pkg.name} abgebrochen, ${removed} Artefakte gelöscht`);
    this.persistSoon();
    this.emitState(true);
  }

  public start(): void {
    if (this.session.running) {
      return;
    }
    this.session.running = true;
    this.session.paused = false;
    this.session.runStartedAt = this.session.runStartedAt || nowMs();
    this.summary = null;
    this.persistSoon();
    this.emitState(true);
    this.ensureScheduler();
  }

  public stop(): void {
    this.session.running = false;
    this.session.paused = false;
    for (const active of this.activeTasks.values()) {
      active.abortReason = "stop";
      active.abortController.abort("stop");
    }
    this.persistSoon();
    this.emitState(true);
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
    for (const item of Object.values(this.session.items)) {
      if (item.provider !== "realdebrid" && item.provider !== "megadebrid" && item.provider !== "bestdebrid" && item.provider !== "alldebrid") {
        item.provider = null;
      }
      if (item.status === "downloading" || item.status === "validating" || item.status === "extracting" || item.status === "integrity_check") {
        item.status = "queued";
        item.speedBps = 0;
      }
    }
    for (const pkg of Object.values(this.session.packages)) {
      if (pkg.status === "downloading" || pkg.status === "validating" || pkg.status === "extracting" || pkg.status === "integrity_check") {
        pkg.status = "queued";
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
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.emit("state", this.getSnapshot());
    }, 140);
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
    this.speedEvents.push({ at: now, bytes });
    this.speedBytesLastWindow += bytes;
    this.pruneSpeedEvents(now);
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
    try {
      while (this.session.running) {
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

        if (this.activeTasks.size === 0 && !this.hasQueuedItems()) {
          this.finishRun();
          break;
        }

        await sleep(120);
      }
    } finally {
      this.scheduleRunning = false;
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
      if (!pkg || pkg.cancelled) {
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
    return Object.values(this.session.items).some((item) => item.status === "queued" || item.status === "reconnect_wait");
  }

  private startItem(packageId: string, itemId: string): void {
    const item = this.session.items[itemId];
    const pkg = this.session.packages[packageId];
    if (!item || !pkg || pkg.cancelled) {
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

    try {
      const unrestricted = await this.debridService.unrestrictLink(item.url);
      item.provider = unrestricted.provider;
      item.retries = unrestricted.retriesUsed;
      item.fileName = sanitizeFilename(unrestricted.fileName || filenameFromUrl(item.url));
      fs.mkdirSync(pkg.outputDir, { recursive: true });
      item.targetPath = nextAvailablePath(path.join(pkg.outputDir, item.fileName));
      item.totalBytes = unrestricted.fileSize;
      item.status = "downloading";
      item.fullStatus = `Download läuft (${unrestricted.providerLabel})`;
      item.updatedAt = nowMs();
      this.emitState();

      const maxAttempts = REQUEST_RETRIES;
      let done = false;
      let downloadRetries = 0;
      while (!done && item.attempts < maxAttempts) {
        item.attempts += 1;
        const result = await this.downloadToFile(active, unrestricted.directUrl, item.targetPath, item.totalBytes);
        downloadRetries += result.retriesUsed;
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

        done = true;
      }

      item.retries += downloadRetries;
      item.status = "completed";
      item.fullStatus = `Fertig (${humanSize(item.downloadedBytes)})`;
      item.progressPercent = 100;
      item.speedBps = 0;
      item.updatedAt = nowMs();
      pkg.updatedAt = nowMs();

      await this.handlePackagePostProcessing(pkg.id);
      this.applyCompletedCleanupPolicy(pkg.id, item.id);
      this.persistSoon();
      this.emitState();
    } catch (error) {
      const reason = active.abortReason;
      if (reason === "cancel") {
        item.status = "cancelled";
        item.fullStatus = "Entfernt";
      } else if (reason === "stop") {
        item.status = "cancelled";
        item.fullStatus = "Gestoppt";
      } else if (reason === "reconnect") {
        item.status = "queued";
        item.fullStatus = "Wartet auf Reconnect";
      } else {
        item.status = "failed";
        item.lastError = compactErrorText(error);
        item.fullStatus = `Fehler: ${item.lastError}`;
      }
      item.speedBps = 0;
      item.updatedAt = nowMs();
      this.persistSoon();
      this.emitState();
    }
  }

  private async downloadToFile(
    active: ActiveTask,
    directUrl: string,
    targetPath: string,
    knownTotal: number | null
  ): Promise<{ retriesUsed: number; resumable: boolean }> {
    const item = this.session.items[active.itemId];
    if (!item) {
      throw new Error("Download-Item fehlt");
    }

    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      const existingBytes = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
      const headers: Record<string, string> = {};
      if (existingBytes > 0) {
        headers.Range = `bytes=${existingBytes}-`;
      }

      if (this.reconnectActive()) {
        await sleep(250);
        continue;
      }

      let response: Response;
      try {
        response = await fetch(directUrl, {
          method: "GET",
          headers,
          signal: active.abortController.signal
        });
      } catch (error) {
        lastError = compactErrorText(error);
        if (attempt < REQUEST_RETRIES) {
          item.fullStatus = `Verbindungsfehler, retry ${attempt + 1}/${REQUEST_RETRIES}`;
          this.emitState();
          await sleep(300 * attempt);
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        const text = await response.text();
        lastError = compactErrorText(text || `HTTP ${response.status}`);
        if (this.settings.autoReconnect && [429, 503].includes(response.status)) {
          this.requestReconnect(`HTTP ${response.status}`);
        }
        if (canRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
          item.fullStatus = `Serverfehler ${response.status}, retry ${attempt + 1}/${REQUEST_RETRIES}`;
          this.emitState();
          await sleep(350 * attempt);
          continue;
        }
        throw new Error(lastError);
      }

      const acceptRanges = (response.headers.get("accept-ranges") || "").toLowerCase().includes("bytes");
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
        fs.rmSync(targetPath, { force: true });
      }

      const stream = fs.createWriteStream(targetPath, { flags: writeMode });
      let written = writeMode === "a" ? existingBytes : 0;
      let windowBytes = 0;
      let windowStarted = nowMs();

      try {
        const body = response.body;
        if (!body) {
          throw new Error("Leerer Response-Body");
        }
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
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
          if (this.reconnectActive() && active.resumable) {
            active.abortReason = "reconnect";
            active.abortController.abort("reconnect");
            throw new Error("aborted:reconnect");
          }

          const buffer = Buffer.from(chunk);
          await this.applySpeedLimit(buffer.length, windowBytes, windowStarted);
          stream.write(buffer);
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
        await new Promise<void>((resolve) => {
          stream.end(() => resolve());
        });
      }

      item.downloadedBytes = written;
      item.progressPercent = item.totalBytes ? Math.max(0, Math.min(100, Math.floor((written / item.totalBytes) * 100))) : 100;
      item.speedBps = 0;
      item.updatedAt = nowMs();
      return { retriesUsed: attempt - 1, resumable };
    }

    throw new Error(lastError || "Download fehlgeschlagen");
  }

  private async applySpeedLimit(chunkBytes: number, localWindowBytes: number, localWindowStarted: number): Promise<void> {
    if (!this.settings.speedLimitEnabled || this.settings.speedLimitKbps <= 0) {
      return;
    }
    const bytesPerSecond = this.settings.speedLimitKbps * 1024;
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

    if (success + failed + cancelled < items.length) {
      pkg.status = "downloading";
      return;
    }

    if (this.settings.autoExtract && failed === 0 && success > 0) {
      pkg.status = "extracting";
      this.emitState();
      const result = await extractPackageArchives({
        packageDir: pkg.outputDir,
        targetDir: pkg.extractDir,
        cleanupMode: this.settings.cleanupMode,
        conflictMode: this.settings.extractConflictMode,
        removeLinks: this.settings.removeLinkFilesAfterExtract,
        removeSamples: this.settings.removeSamplesAfterExtract
      });
      if (result.failed > 0) {
        pkg.status = "failed";
      } else {
        pkg.status = "completed";
      }
    } else if (failed > 0) {
      pkg.status = "failed";
    } else if (cancelled > 0 && success === 0) {
      pkg.status = "cancelled";
    } else {
      pkg.status = "completed";
    }
    pkg.updatedAt = nowMs();
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
    const items = Object.values(this.session.items);
    const total = items.length;
    const success = items.filter((item) => item.status === "completed").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    const extracted = Object.values(this.session.packages).filter((pkg) => pkg.status === "completed").length;
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
    this.session.summaryText = `Summary: Dauer ${duration}s, Ø Speed ${humanSize(avgSpeed)}/s, Erfolg ${success}/${Math.max(total, 1)}`;
    this.persistNow();
    this.emitState();
  }
}
