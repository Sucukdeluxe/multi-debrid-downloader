import path from "node:path";
import { app } from "electron";
import { getDebridLinkApiKeyIds } from "../shared/debrid-link-keys";
import {
  AddLinksPayload,
  AllDebridHostInfo,
  AppSettings,
  DebridProvider,
  DuplicatePolicy,
  HistoryEntry,
  PackagePriority,
  ParsedPackageInput,
  SessionStats,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress,
  UpdateInstallResult
} from "../shared/types";
import { resetDebridLinkApiKeyDailyUsage, resetProviderDailyUsage } from "../shared/provider-daily-limits";
import { importDlcContainers } from "./container";
import { APP_VERSION } from "./constants";
import { DownloadManager } from "./download-manager";
import { fetchAllDebridHostInfo, fetchDebridLinkHostLimits } from "./debrid";
import { parseCollectorInput } from "./link-parser";
import { configureLogger, getLogFilePath, logger } from "./logger";
import { AllDebridWebFallback } from "./all-debrid-web";
import { BestDebridWebFallback } from "./bestdebrid-web";
import { RealDebridWebFallback } from "./realdebrid-web";
import { getPackageLogPath, initPackageLogs, shutdownPackageLogs } from "./package-log";
import { initSessionLog, getSessionLogPath, shutdownSessionLog } from "./session-log";
import { MegaWebFallback } from "./mega-web-fallback";
import { addHistoryEntry, cancelPendingAsyncSaves, clearHistory, createStoragePaths, loadHistory, loadSession, loadSettings, normalizeHistoryEntry, normalizeLoadedSession, normalizeLoadedSessionTransientFields, normalizeSettings, removeHistoryEntry, saveHistory, saveSession, saveSettings } from "./storage";
import { abortActiveUpdateDownload, checkGitHubUpdate, installLatestUpdate } from "./update";
import { startDebugServer, stopDebugServer } from "./debug-server";
import { encryptBackup, decryptBackup } from "./backup-crypto";

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

  private realDebridWebFallback: RealDebridWebFallback;

  private allDebridWebFallback: AllDebridWebFallback;

  private bestDebridWebFallback: BestDebridWebFallback;

  private lastUpdateCheck: UpdateCheckResult | null = null;

  private lastUpdateCheckAt = 0;

  private storagePaths = createStoragePaths(path.join(app.getPath("userData"), "runtime"));

  private onStateHandler: ((snapshot: UiSnapshot) => void) | null = null;

  private autoResumePending = false;

  public constructor() {
    configureLogger(this.storagePaths.baseDir);
    initSessionLog(this.storagePaths.baseDir);
    initPackageLogs(this.storagePaths.baseDir);
    this.settings = loadSettings(this.storagePaths);
    const session = loadSession(this.storagePaths);
    this.megaWebFallback = new MegaWebFallback(() => ({
      login: this.settings.megaLogin,
      password: this.settings.megaPassword
    }));
    this.realDebridWebFallback = new RealDebridWebFallback(() => this.settings.rememberToken);
    this.allDebridWebFallback = new AllDebridWebFallback(() => this.settings.rememberToken);
    this.bestDebridWebFallback = new BestDebridWebFallback(() => this.settings.rememberToken);
    this.manager = new DownloadManager(this.settings, session, this.storagePaths, {
      megaWebUnrestrict: (link: string, signal?: AbortSignal) => this.megaWebFallback.unrestrict(link, signal),
      allDebridWebUnrestrict: (link: string, signal?: AbortSignal) => this.allDebridWebFallback.unrestrict(link, signal),
      realDebridWebUnrestrict: (link: string, signal?: AbortSignal) => this.realDebridWebFallback.unrestrict(link, signal),
      bestDebridWebUnrestrict: (link: string, signal?: AbortSignal) => this.bestDebridWebFallback.unrestrict(link, signal),
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
      || settings.realDebridUseWebLogin
      || (settings.megaLogin.trim() && settings.megaPassword.trim())
      || settings.bestToken.trim()
      || settings.bestDebridUseWebLogin
      || settings.allDebridUseWebLogin
      || settings.allDebridToken.trim()
      || (settings.ddownloadLogin.trim() && settings.ddownloadPassword.trim())
      || settings.oneFichierApiKey.trim()
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
    const previousSettings = this.settings;
    const nextSettings = normalizeSettings({
      ...previousSettings,
      ...sanitizedPatch
    });

    if (settingsFingerprint(nextSettings) === settingsFingerprint(previousSettings)) {
      return previousSettings;
    }

    // Preserve the live all-time counters from the download manager
    const liveSettings = this.manager.getSettings();
    nextSettings.totalDownloadedAllTime = Math.max(nextSettings.totalDownloadedAllTime || 0, liveSettings.totalDownloadedAllTime || 0);
    nextSettings.totalCompletedFilesAllTime = Math.max(nextSettings.totalCompletedFilesAllTime || 0, liveSettings.totalCompletedFilesAllTime || 0);
    nextSettings.providerDailyUsageDay = liveSettings.providerDailyUsageDay;
    nextSettings.providerDailyUsageBytes = { ...(liveSettings.providerDailyUsageBytes || {}) };
    nextSettings.providerTotalUsageBytes = { ...(liveSettings.providerTotalUsageBytes || {}) };
    nextSettings.debridLinkApiKeyDailyUsageBytes = Object.fromEntries(
      Object.entries(liveSettings.debridLinkApiKeyDailyUsageBytes || {}).filter(([keyId]) => getDebridLinkApiKeyIds(nextSettings.debridLinkApiKeys).includes(keyId))
    );
    nextSettings.debridLinkApiKeyTotalUsageBytes = Object.fromEntries(
      Object.entries(liveSettings.debridLinkApiKeyTotalUsageBytes || {}).filter(([keyId]) => getDebridLinkApiKeyIds(nextSettings.debridLinkApiKeys).includes(keyId))
    );
    this.settings = nextSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    if (previousSettings.rememberToken && !this.settings.rememberToken) {
      void this.realDebridWebFallback.clearSessions().catch((error) => {
        logger.warn(`Real-Debrid Web-Session konnte nicht gelöscht werden: ${String(error)}`);
      });
      void this.allDebridWebFallback.clearSessions().catch((error) => {
        logger.warn(`AllDebrid Web-Session konnte nicht gelöscht werden: ${String(error)}`);
      });
      void this.bestDebridWebFallback.clearSessions().catch((error) => {
        logger.warn(`BestDebrid Web-Session konnte nicht gelöscht werden: ${String(error)}`);
      });
    }
    return this.settings;
  }

  public resetProviderDailyUsage(provider: DebridProvider): AppSettings {
    const liveSettings = this.manager.getSettings();
    const nextSettings = normalizeSettings({
      ...liveSettings,
      ...resetProviderDailyUsage(liveSettings, provider)
    });
    this.settings = nextSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    return this.settings;
  }

  public resetDebridLinkApiKeyDailyUsage(keyId: string): AppSettings {
    const liveSettings = this.manager.getSettings();
    const nextSettings = normalizeSettings({
      ...liveSettings,
      ...resetDebridLinkApiKeyDailyUsage(liveSettings, keyId)
    });
    this.settings = nextSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    return this.settings;
  }

  public async openRealDebridLoginWindow(): Promise<void> {
    await this.realDebridWebFallback.openLoginWindow();
  }

  public async openAllDebridLoginWindow(): Promise<void> {
    await this.allDebridWebFallback.openLoginWindow();
  }

  public async importBestDebridCookies(filePath: string): Promise<number> {
    return this.bestDebridWebFallback.importCookiesFromFile(filePath);
  }

  public async getAllDebridHostInfo(host = "rapidgator"): Promise<AllDebridHostInfo> {
    if (this.settings.allDebridUseWebLogin) {
      return this.allDebridWebFallback.getHostInfo(host);
    }
    const token = this.settings.allDebridToken.trim();
    if (!token) {
      throw new Error("AllDebrid ist nicht konfiguriert");
    }
    return fetchAllDebridHostInfo(token, host);
  }

  public async getDebridLinkHostLimits(host = "rapidgator") {
    return fetchDebridLinkHostLimits(this.settings.debridLinkApiKeys, host);
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

  public resetSessionStats(): void {
    this.manager.resetSessionStats();
  }

  public resetDownloadStats(): void {
    this.manager.resetDownloadStats();
    this.settings = this.manager.getSettings();
  }

  public exportBackup(): Buffer {
    const settings = { ...this.settings };
    const session = this.manager.getSession();
    const history = loadHistory(this.storagePaths);
    const payload = JSON.stringify({
      version: 2,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      session,
      history
    });
    return encryptBackup(payload);
  }

  public importBackup(data: Buffer): { restored: boolean; message: string } {
    let parsed: Record<string, unknown>;
    try {
      // Try encrypted MDD format first
      const json = decryptBackup(data);
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      // Fallback: try legacy plaintext JSON (old backups)
      try {
        const json = data.toString("utf8");
        parsed = JSON.parse(json) as Record<string, unknown>;
      } catch {
        return { restored: false, message: "Backup-Datei konnte nicht entschlüsselt werden" };
      }
    }
    if (!parsed || typeof parsed !== "object" || !parsed.settings || !parsed.session) {
      return { restored: false, message: "Kein gültiges Backup (settings/session fehlen)" };
    }

    // Restore settings — ALL credentials are included (no more masking)
    const importedSettings = parsed.settings as AppSettings;
    // Legacy backup compatibility: if credentials were masked with ***, keep current values
    const SENSITIVE_KEYS: (keyof AppSettings)[] = [
      "token", "megaLogin", "megaPassword", "bestToken", "allDebridToken",
      "ddownloadLogin", "ddownloadPassword", "oneFichierApiKey",
      "debridLinkApiKeys", "linkSnappyLogin", "linkSnappyPassword"
    ];
    for (const key of SENSITIVE_KEYS) {
      const val = (importedSettings as Record<string, unknown>)[key];
      if (typeof val === "string" && val.startsWith("***")) {
        (importedSettings as Record<string, unknown>)[key] = (this.settings as Record<string, unknown>)[key];
      }
    }
    const restoredSettings = normalizeSettings(importedSettings);
    this.settings = restoredSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);

    // Full stop including extraction abort
    this.manager.stop();
    this.manager.abortAllPostProcessing();
    this.manager.clearPersistTimer();
    cancelPendingAsyncSaves();

    // Restore session
    const restoredSession = normalizeLoadedSessionTransientFields(
      normalizeLoadedSession(parsed.session)
    );
    saveSession(this.storagePaths, restoredSession);

    // Restore history (if present in backup)
    if (Array.isArray(parsed.history) && parsed.history.length > 0) {
      const normalizedHistory = (parsed.history as unknown[])
        .map((raw, idx) => normalizeHistoryEntry(raw, idx))
        .filter((entry): entry is HistoryEntry => entry !== null);
      if (normalizedHistory.length > 0) {
        saveHistory(this.storagePaths, normalizedHistory);
        logger.info(`Backup: ${normalizedHistory.length} History-Einträge wiederhergestellt`);
      }
    }

    // Prevent prepareForShutdown from overwriting the restored data
    this.manager.skipShutdownPersist = true;
    this.manager.blockAllPersistence = true;
    logger.info("Backup wiederhergestellt (verschlüsseltes Format)");
    return { restored: true, message: "Backup wiederhergestellt. Bitte App neustarten." };
  }

  public getSessionLogPath(): string | null {
    return getSessionLogPath();
  }

  public getPackageLogPath(packageId: string): string | null {
    return this.manager.getPackageLogPath(packageId) || getPackageLogPath(packageId);
  }

  public shutdown(): void {
    stopDebugServer();
    abortActiveUpdateDownload();
    this.manager.prepareForShutdown();
    this.megaWebFallback.dispose();
    this.realDebridWebFallback.dispose();
    this.allDebridWebFallback.dispose();
    this.bestDebridWebFallback.dispose();
    shutdownSessionLog();
    shutdownPackageLogs();
    logger.info("App beendet");
  }

  public getHistory(): HistoryEntry[] {
    return loadHistory(this.storagePaths);
  }

  public clearHistory(): void {
    clearHistory(this.storagePaths);
  }

  public setPackagePriority(packageId: string, priority: PackagePriority): void {
    this.manager.setPackagePriority(packageId, priority);
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
