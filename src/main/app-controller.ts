import path from "node:path";
import { app } from "electron";
import {
  AddLinksPayload,
  AppSettings,
  DuplicatePolicy,
  HistoryEntry,
  ParsedPackageInput,
  SessionStats,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress,
  UpdateInstallResult
} from "../shared/types";
import { importDlcContainers } from "./container";
import { APP_VERSION } from "./constants";
import { DownloadManager } from "./download-manager";
import { parseCollectorInput } from "./link-parser";
import { configureLogger, getLogFilePath, logger } from "./logger";
import { initSessionLog, getSessionLogPath, shutdownSessionLog } from "./session-log";
import { MegaWebFallback } from "./mega-web-fallback";
import { addHistoryEntry, cancelPendingAsyncSaves, clearHistory, createStoragePaths, loadHistory, loadSession, loadSettings, normalizeLoadedSession, normalizeLoadedSessionTransientFields, normalizeSettings, removeHistoryEntry, saveSession, saveSettings } from "./storage";
import { abortActiveUpdateDownload, checkGitHubUpdate, installLatestUpdate } from "./update";
import { startDebugServer, stopDebugServer } from "./debug-server";

function sanitizeSettingsPatch(partial: Partial<AppSettings>): Partial<AppSettings> {
  const entries = Object.entries(partial || {}).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<AppSettings>;
}

function settingsFingerprint(settings: AppSettings): string {
  return JSON.stringify(normalizeSettings(settings));
}

export class AppController {
  private settings: AppSettings;

  private manager: DownloadManager;

  private megaWebFallback: MegaWebFallback;

  private lastUpdateCheck: UpdateCheckResult | null = null;

  private lastUpdateCheckAt = 0;

  private storagePaths = createStoragePaths(path.join(app.getPath("userData"), "runtime"));

  private onStateHandler: ((snapshot: UiSnapshot) => void) | null = null;

  private autoResumePending = false;

  public constructor() {
    configureLogger(this.storagePaths.baseDir);
    initSessionLog(this.storagePaths.baseDir);
    this.settings = loadSettings(this.storagePaths);
    const session = loadSession(this.storagePaths);
    this.megaWebFallback = new MegaWebFallback(() => ({
      login: this.settings.megaLogin,
      password: this.settings.megaPassword
    }));
    this.manager = new DownloadManager(this.settings, session, this.storagePaths, {
      megaWebUnrestrict: (link: string, signal?: AbortSignal) => this.megaWebFallback.unrestrict(link, signal),
      invalidateMegaSession: () => this.megaWebFallback.invalidateSession(),
      onHistoryEntry: (entry: HistoryEntry) => {
        addHistoryEntry(this.storagePaths, entry);
      }
    });
    this.manager.on("state", (snapshot: UiSnapshot) => {
      this.onStateHandler?.(snapshot);
    });
    logger.info(`App gestartet v${APP_VERSION}`);
    logger.info(`Log-Datei: ${getLogFilePath()}`);
    startDebugServer(this.manager, this.storagePaths.baseDir);

    if (this.settings.autoResumeOnStart) {
      const snapshot = this.manager.getSnapshot();
      const hasPending = Object.values(snapshot.session.items).some((item) => item.status === "queued" || item.status === "reconnect_wait");
      if (hasPending) {
        void this.manager.getStartConflicts().then((conflicts) => {
          const hasConflicts = conflicts.length > 0;
          if (this.hasAnyProviderToken(this.settings) && !hasConflicts) {
            // If the onState handler is already set (renderer connected), start immediately.
            // Otherwise mark as pending so the onState setter triggers the start.
            if (this.onStateHandler) {
              logger.info("Auto-Resume beim Start aktiviert (nach Konflikt-Check)");
              void this.manager.start().catch((err) => logger.warn(`Auto-Resume Start Fehler: ${String(err)}`));
            } else {
              this.autoResumePending = true;
              logger.info("Auto-Resume beim Start vorgemerkt");
            }
          } else if (hasConflicts) {
            logger.info("Auto-Resume übersprungen: Start-Konflikte erkannt");
          }
        }).catch((err) => logger.warn(`getStartConflicts Fehler (constructor): ${String(err)}`));
      }
    }
  }

  private hasAnyProviderToken(settings: AppSettings): boolean {
    return Boolean(
      settings.token.trim()
      || (settings.megaLogin.trim() && settings.megaPassword.trim())
      || settings.bestToken.trim()
      || settings.allDebridToken.trim()
    );
  }

  public get onState(): ((snapshot: UiSnapshot) => void) | null {
    return this.onStateHandler;
  }

  public set onState(handler: ((snapshot: UiSnapshot) => void) | null) {
    this.onStateHandler = handler;
    if (handler) {
      handler(this.manager.getSnapshot());
      if (this.autoResumePending) {
        this.autoResumePending = false;
        void this.manager.start().catch((err) => logger.warn(`Auto-Resume Start Fehler: ${String(err)}`));
        logger.info("Auto-Resume beim Start aktiviert");
      } else {
        // Trigger pending extractions without starting the session
        this.manager.triggerIdleExtractions();
      }
    }
  }

  public getSnapshot(): UiSnapshot {
    return this.manager.getSnapshot();
  }

  public getVersion(): string {
    return APP_VERSION;
  }

  public getSettings(): AppSettings {
    return this.settings;
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    const sanitizedPatch = sanitizeSettingsPatch(partial);
    const nextSettings = normalizeSettings({
      ...this.settings,
      ...sanitizedPatch
    });

    if (settingsFingerprint(nextSettings) === settingsFingerprint(this.settings)) {
      return this.settings;
    }

    // Preserve the live totalDownloadedAllTime from the download manager
    const liveSettings = this.manager.getSettings();
    nextSettings.totalDownloadedAllTime = Math.max(nextSettings.totalDownloadedAllTime || 0, liveSettings.totalDownloadedAllTime || 0);
    this.settings = nextSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    return this.settings;
  }

  public async checkUpdates(): Promise<UpdateCheckResult> {
    const result = await checkGitHubUpdate(this.settings.updateRepo);
    if (!result.error) {
      this.lastUpdateCheck = result;
      this.lastUpdateCheckAt = Date.now();
    }
    return result;
  }

  public async installUpdate(onProgress?: (progress: UpdateInstallProgress) => void): Promise<UpdateInstallResult> {
    // Stop active downloads before installing. Extractions may continue briefly
    // until prepareForShutdown() is called during app quit.
    if (this.manager.isSessionRunning()) {
      this.manager.stop();
    }

    const cacheAgeMs = Date.now() - this.lastUpdateCheckAt;
    const cached = this.lastUpdateCheck && !this.lastUpdateCheck.error && cacheAgeMs <= 10 * 60 * 1000
      ? this.lastUpdateCheck
      : undefined;
    const result = await installLatestUpdate(this.settings.updateRepo, cached, onProgress);
    if (result.started) {
      this.lastUpdateCheck = null;
      this.lastUpdateCheckAt = 0;
    }
    return result;
  }

  public addLinks(payload: AddLinksPayload): { addedPackages: number; addedLinks: number; invalidCount: number } {
    const parsed = parseCollectorInput(payload.rawText, payload.packageName || this.settings.packageName);
    if (parsed.length === 0) {
      return { addedPackages: 0, addedLinks: 0, invalidCount: 1 };
    }
    const result = this.manager.addPackages(parsed);
    return { ...result, invalidCount: 0 };
  }

  public async addContainers(filePaths: string[]): Promise<{ addedPackages: number; addedLinks: number }> {
    const packages = await importDlcContainers(filePaths);
    const merged: ParsedPackageInput[] = packages.map((pkg) => ({
      name: pkg.name,
      links: pkg.links,
      ...(pkg.fileNames ? { fileNames: pkg.fileNames } : {})
    }));
    const result = this.manager.addPackages(merged);
    return result;
  }

  public async getStartConflicts(): Promise<StartConflictEntry[]> {
    return this.manager.getStartConflicts();
  }

  public async resolveStartConflict(packageId: string, policy: DuplicatePolicy): Promise<StartConflictResolutionResult> {
    return this.manager.resolveStartConflict(packageId, policy);
  }

  public clearAll(): void {
    this.manager.clearAll();
  }

  public async start(): Promise<void> {
    await this.manager.start();
  }

  public async startPackages(packageIds: string[]): Promise<void> {
    await this.manager.startPackages(packageIds);
  }

  public async startItems(itemIds: string[]): Promise<void> {
    await this.manager.startItems(itemIds);
  }

  public stop(): void {
    this.manager.stop();
  }

  public togglePause(): boolean {
    return this.manager.togglePause();
  }

  public retryExtraction(packageId: string): void {
    this.manager.retryExtraction(packageId);
  }

  public extractNow(packageId: string): void {
    this.manager.extractNow(packageId);
  }

  public resetPackage(packageId: string): void {
    this.manager.resetPackage(packageId);
  }

  public cancelPackage(packageId: string): void {
    this.manager.cancelPackage(packageId);
  }

  public renamePackage(packageId: string, newName: string): void {
    this.manager.renamePackage(packageId, newName);
  }

  public reorderPackages(packageIds: string[]): void {
    this.manager.reorderPackages(packageIds);
  }

  public removeItem(itemId: string): void {
    this.manager.removeItem(itemId);
  }

  public togglePackage(packageId: string): void {
    this.manager.togglePackage(packageId);
  }

  public exportQueue(): string {
    return this.manager.exportQueue();
  }

  public importQueue(json: string): { addedPackages: number; addedLinks: number } {
    return this.manager.importQueue(json);
  }

  public getSessionStats(): SessionStats {
    return this.manager.getSessionStats();
  }

  public exportBackup(): string {
    const settings = this.settings;
    const session = this.manager.getSession();
    return JSON.stringify({ version: 1, settings, session }, null, 2);
  }

  public importBackup(json: string): { restored: boolean; message: string } {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return { restored: false, message: "Ungültiges JSON" };
    }
    if (!parsed || typeof parsed !== "object" || !parsed.settings || !parsed.session) {
      return { restored: false, message: "Kein gültiges Backup (settings/session fehlen)" };
    }
    const restoredSettings = normalizeSettings(parsed.settings as AppSettings);
    this.settings = restoredSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    // Full stop including extraction abort — the old session is being replaced,
    // so no extraction tasks from it should keep running.
    this.manager.stop();
    this.manager.abortAllPostProcessing();
    // Cancel any deferred persist timer and queued async writes so the old
    // in-memory session does not overwrite the restored session file on disk.
    this.manager.clearPersistTimer();
    cancelPendingAsyncSaves();
    const restoredSession = normalizeLoadedSessionTransientFields(
      normalizeLoadedSession(parsed.session)
    );
    saveSession(this.storagePaths, restoredSession);
    // Prevent prepareForShutdown from overwriting the restored session file
    // with the old in-memory session when the app quits after backup restore.
    this.manager.skipShutdownPersist = true;
    // Block all persistence (including persistSoon from any IPC operations
    // the user might trigger before restarting) to protect the restored backup.
    this.manager.blockAllPersistence = true;
    return { restored: true, message: "Backup wiederhergestellt. Bitte App neustarten." };
  }

  public getSessionLogPath(): string | null {
    return getSessionLogPath();
  }

  public shutdown(): void {
    stopDebugServer();
    abortActiveUpdateDownload();
    this.manager.prepareForShutdown();
    this.megaWebFallback.dispose();
    shutdownSessionLog();
    logger.info("App beendet");
  }

  public getHistory(): HistoryEntry[] {
    return loadHistory(this.storagePaths);
  }

  public clearHistory(): void {
    clearHistory(this.storagePaths);
  }

  public setPackagePriority(packageId: string, priority: string): void {
    this.manager.setPackagePriority(packageId, priority as any);
  }

  public skipItems(itemIds: string[]): void {
    this.manager.skipItems(itemIds);
  }

  public resetItems(itemIds: string[]): void {
    this.manager.resetItems(itemIds);
  }

  public removeHistoryEntry(entryId: string): void {
    removeHistoryEntry(this.storagePaths, entryId);
  }

  public addToHistory(entry: HistoryEntry): void {
    addHistoryEntry(this.storagePaths, entry);
  }
}
