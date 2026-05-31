import path from "node:path";
import { app } from "electron";
import { getDebridLinkApiKeyIds } from "../shared/debrid-link-keys";
import {
  AddLinksPayload,
  AllDebridHostInfo,
  AppSettings,
  DebridAccountStatus,
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
import { checkAllDebridAccounts, checkMegaDebridAccount } from "./account-check";
import { parseMegaDebridAccounts } from "../shared/mega-debrid-accounts";
import { parseCollectorInput } from "./link-parser";
import { configureLogger, getLogFilePath, logger } from "./logger";
import { AllDebridWebFallback } from "./all-debrid-web";
import { BestDebridWebFallback } from "./bestdebrid-web";
import { RealDebridWebFallback } from "./realdebrid-web";
import { getItemLogPath, initItemLogs, shutdownItemLogs } from "./item-log";
import { getPackageLogPath, initPackageLogs, shutdownPackageLogs } from "./package-log";
import { initSessionLog, getSessionLogPath, shutdownSessionLog } from "./session-log";
import { MegaWebFallback } from "./mega-web-fallback";
import { addHistoryEntry, addHistoryEntryForRetention, cancelPendingAsyncSaves, clearHistory, createStoragePaths, loadHistoryForRetention, loadSession, loadSettings, normalizeHistoryEntry, normalizeLoadedSession, normalizeLoadedSessionTransientFields, normalizeSettings, removeHistoryEntry, resetHistoryForRetention, saveHistory, saveSession, saveSettings } from "./storage";
import { abortActiveUpdateDownload, checkGitHubUpdate, installLatestUpdate } from "./update";
import { rotateDebugToken, startDebugServer, stopDebugServer } from "./debug-server";
import { encryptBackup, decryptBackup } from "./backup-crypto";
import { getAuditLogPath, initAuditLog, logAuditEvent, shutdownAuditLog } from "./audit-log";
import { initAccountRotationLog, shutdownAccountRotationLog } from "./account-rotation-log";
import { runStartupHealthCheck } from "./startup-health-check";
import { getDebugSetupCheck } from "./debug-setup";
import { buildLinkExportSelection, serializeLinkExportText } from "./link-export";
import { getRenameLogPath, initRenameLog, shutdownRenameLog } from "./rename-log";
import { buildAccountSummary, diffAccountSummary } from "./support-data";
import { buildSupportBundle, getSupportBundleDefaultFileName } from "./support-bundle";
import { getTraceConfig, getTraceLogPath, initTraceLog, logTraceEvent, setTraceEnabled, shutdownTraceLog } from "./trace-log";
import type { DebugSetupCheckResult, SupportTraceConfig } from "../shared/types";

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
  private runtimeStatsTimer: NodeJS.Timeout | null = null;

  public constructor() {
    configureLogger(this.storagePaths.baseDir);
    initSessionLog(this.storagePaths.baseDir);
    initPackageLogs(this.storagePaths.baseDir);
    initItemLogs(this.storagePaths.baseDir);
    initAuditLog(this.storagePaths.baseDir);
    initAccountRotationLog(this.storagePaths.baseDir);
    initRenameLog(this.storagePaths.baseDir);
    initTraceLog(this.storagePaths.baseDir);
    this.settings = loadSettings(this.storagePaths);
    resetHistoryForRetention(this.storagePaths, this.settings.historyRetentionMode);
    const session = loadSession(this.storagePaths);
    this.megaWebFallback = new MegaWebFallback(() => ({
      login: this.settings.megaLogin,
      password: this.settings.megaPassword
    }));
    this.realDebridWebFallback = new RealDebridWebFallback(() => this.settings.rememberToken);
    this.allDebridWebFallback = new AllDebridWebFallback(() => this.settings.rememberToken);
    this.bestDebridWebFallback = new BestDebridWebFallback(() => this.settings.rememberToken);
    this.manager = new DownloadManager(this.settings, session, this.storagePaths, {
      megaWebUnrestrict: (link: string, signal?: AbortSignal, account?: { login: string; password: string }) => this.megaWebFallback.unrestrict(link, signal, account),
      allDebridWebUnrestrict: (link: string, signal?: AbortSignal) => this.allDebridWebFallback.unrestrict(link, signal),
      realDebridWebUnrestrict: (link: string, signal?: AbortSignal) => this.realDebridWebFallback.unrestrict(link, signal),
      bestDebridWebUnrestrict: (link: string, signal?: AbortSignal) => this.bestDebridWebFallback.unrestrict(link, signal),
      invalidateMegaSession: () => this.megaWebFallback.invalidateSession(),
      onHistoryEntry: (entry: HistoryEntry) => {
        addHistoryEntryForRetention(this.storagePaths, this.settings.historyRetentionMode, entry);
      }
    });
    this.manager.on("state", (snapshot: UiSnapshot) => {
      this.onStateHandler?.(snapshot);
    });
    logger.info(`App gestartet v${APP_VERSION}`);
    logger.info(`Log-Datei: ${getLogFilePath()}`);
    logAuditEvent("INFO", "App gestartet", {
      appVersion: APP_VERSION,
      runtimeDir: this.storagePaths.baseDir
    });
    // Startup Health-Check: surface problematic state early (missing download
    // dir, low disk space, no provider configured, corrupted state file).
    // Never blocks startup — findings go into the normal log + audit log so
    // the user can diagnose issues before hitting them mid-download.
    try {
      const report = runStartupHealthCheck(this.settings, this.storagePaths);
      if (report.errorCount > 0 || report.warnCount > 0) {
        logger.warn(`Health-Check: ${report.errorCount} Fehler, ${report.warnCount} Warnungen, ${report.infoCount} Info`);
      } else {
        logger.info(`Health-Check: alles OK (${report.infoCount} Info)`);
      }
      for (const finding of report.findings) {
        const line = finding.hint
          ? `Health-Check [${finding.code}]: ${finding.message} — ${finding.hint}`
          : `Health-Check [${finding.code}]: ${finding.message}`;
        if (finding.severity === "ERROR") {
          logger.error(line);
        } else if (finding.severity === "WARN") {
          logger.warn(line);
        } else {
          logger.info(line);
        }
        if (finding.severity !== "INFO") {
          logAuditEvent(finding.severity, `Health-Check: ${finding.code}`, {
            message: finding.message,
            hint: finding.hint || ""
          });
        }
      }
    } catch (err) {
      logger.warn(`Health-Check uebersprungen (Fehler): ${String((err as Error).message || err)}`);
    }
    startDebugServer(this.manager, this.storagePaths.baseDir);
    this.runtimeStatsTimer = setInterval(() => {
      this.manager.persistRuntimeStats();
      this.settings = this.manager.getSettings();
    }, 60_000);
    this.runtimeStatsTimer.unref?.();

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

  public getAuditLogPath(): string | null {
    return getAuditLogPath();
  }

  public getRenameLogPath(): string | null {
    return getRenameLogPath();
  }

  public getTraceLogPath(): string | null {
    return getTraceLogPath();
  }

  public getTraceConfig(): SupportTraceConfig {
    return getTraceConfig();
  }

  public rotateDebugToken(): { path: string; token: string } {
    const rotated = rotateDebugToken(this.storagePaths.baseDir);
    this.audit("WARN", "Debug-Token rotiert", { path: rotated.path });
    return rotated;
  }

  public getDebugSetupCheck(): DebugSetupCheckResult {
    return getDebugSetupCheck(this.storagePaths.baseDir);
  }

  private audit(level: "INFO" | "WARN" | "ERROR", message: string, fields?: Record<string, unknown>): void {
    logAuditEvent(level, message, fields);
    logTraceEvent(level, "audit", message, fields);
  }

  public setTraceEnabled(enabled: boolean, note = "", durationMs?: number): SupportTraceConfig {
    const next = setTraceEnabled(enabled, note, durationMs);
    this.audit("INFO", enabled ? "Support-Trace aktiviert" : "Support-Trace deaktiviert", { note });
    return next;
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
    nextSettings.totalRuntimeAllTimeMs = Math.max(nextSettings.totalRuntimeAllTimeMs || 0, this.manager.getLiveTotalRuntimeMs());
    nextSettings.providerDailyUsageDay = liveSettings.providerDailyUsageDay;
    nextSettings.providerDailyUsageBytes = { ...(liveSettings.providerDailyUsageBytes || {}) };
    nextSettings.providerTotalUsageBytes = { ...(liveSettings.providerTotalUsageBytes || {}) };
    nextSettings.debridLinkApiKeyDailyUsageBytes = Object.fromEntries(
      Object.entries(liveSettings.debridLinkApiKeyDailyUsageBytes || {}).filter(([keyId]) => getDebridLinkApiKeyIds(nextSettings.debridLinkApiKeys).includes(keyId))
    );
    nextSettings.debridLinkApiKeyTotalUsageBytes = Object.fromEntries(
      Object.entries(liveSettings.debridLinkApiKeyTotalUsageBytes || {}).filter(([keyId]) => getDebridLinkApiKeyIds(nextSettings.debridLinkApiKeys).includes(keyId))
    );
    // debridAccountStatuses ist main-owned Runtime-State (wird NUR von
    // applyDebridAccountStatuses gesetzt). Der Renderer schickt in seinem Settings-
    // Patch eine evtl. veraltete Kopie mit; die Live-Version bewahren, damit ein
    // Settings-Save (z.B. direkt nach Hinzufuegen+Pruefen eines Mega-Accounts im
    // Dialog) einen frisch geprueften Status nicht ueberschreibt.
    nextSettings.debridAccountStatuses = { ...(liveSettings.debridAccountStatuses || {}) };
    const retentionChanged = previousSettings.historyRetentionMode !== nextSettings.historyRetentionMode;
    this.settings = nextSettings;
    if (retentionChanged) {
      resetHistoryForRetention(this.storagePaths, this.settings.historyRetentionMode);
    }
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    this.audit("INFO", "Einstellungen aktualisiert", {
      changedKeys: Object.keys(sanitizedPatch),
      accountChanges: diffAccountSummary(previousSettings, this.settings)
    });
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
    this.audit("INFO", "Provider-Tagesnutzung zurückgesetzt", { provider });
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
    this.audit("INFO", "Debrid-Link-Key-Tagesnutzung zurückgesetzt", { keyId });
    return this.settings;
  }

  public async openRealDebridLoginWindow(): Promise<void> {
    this.audit("INFO", "Real-Debrid Login-Fenster geöffnet");
    await this.realDebridWebFallback.openLoginWindow();
  }

  public async openAllDebridLoginWindow(): Promise<void> {
    this.audit("INFO", "AllDebrid Login-Fenster geöffnet");
    await this.allDebridWebFallback.openLoginWindow();
  }

  public async importBestDebridCookies(filePath: string): Promise<number> {
    const imported = await this.bestDebridWebFallback.importCookiesFromFile(filePath);
    this.audit("INFO", "BestDebrid Cookies importiert", {
      filePath,
      imported
    });
    return imported;
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

  /** Check login validity + premium expiry for ALL configured multi-account
   *  credentials (Mega-Debrid accounts + Debrid-Link keys), persist the result
   *  into settings (so badges survive restart), and return the statuses. */
public async checkDebridAccounts(): Promise<DebridAccountStatus[]> {
    const statuses = await checkAllDebridAccounts(this.settings);
    this.manager.applyDebridAccountStatuses(statuses);
    this.audit("INFO", "Debrid-Accounts geprueft", {
      total: statuses.length,
      valid: statuses.filter((s) => s.valid).length,
      premium: statuses.filter((s) => s.isPremium).length
    });
    return statuses;
  }

  /** Check a SINGLE Mega-Debrid account by raw credentials (used when an account
   *  is added in the dialog, before it is saved) and merge the result so the
   *  validity/premium badge updates immediately — without a full "Alle pruefen". */
  public async checkSingleMegaDebridAccount(login: string, password: string): Promise<DebridAccountStatus | null> {
    const entry = parseMegaDebridAccounts(`${login.trim()}:${password.trim()}`)[0];
    if (!entry) {
      return null;
    }
    const status = await checkMegaDebridAccount(entry);
    this.manager.applyDebridAccountStatuses([status]);
    this.audit("INFO", "Mega-Debrid-Account einzeln geprueft", { valid: status.valid, premium: status.isPremium });
    return status;
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
    // Flush any pending async saves BEFORE the update process starts.
    // This ensures the queue is fully persisted to disk so it survives the restart.
    this.manager.persistNowSync();

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
      this.audit("WARN", "Links hinzufügen ohne gültigen Inhalt", {
        hasPackageName: Boolean(payload.packageName)
      });
      return { addedPackages: 0, addedLinks: 0, invalidCount: 1 };
    }
    const result = this.manager.addPackages(parsed);
    this.audit("INFO", "Links hinzugefügt", {
      addedPackages: result.addedPackages,
      addedLinks: result.addedLinks,
      requestedPackages: parsed.length
    });
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
    this.audit("INFO", "Container importiert", {
      files: filePaths.length,
      addedPackages: result.addedPackages,
      addedLinks: result.addedLinks
    });
    return result;
  }

  public async getStartConflicts(): Promise<StartConflictEntry[]> {
    return this.manager.getStartConflicts();
  }

  public async resolveStartConflict(packageId: string, policy: DuplicatePolicy): Promise<StartConflictResolutionResult> {
    return this.manager.resolveStartConflict(packageId, policy);
  }

  public clearAll(): void {
    this.audit("WARN", "Queue komplett geleert");
    this.manager.clearAll();
  }

  public async start(): Promise<void> {
    this.audit("INFO", "Session-Start ausgelöst");
    await this.manager.start();
  }

  public async startPackages(packageIds: string[]): Promise<void> {
    this.audit("INFO", "Paket-Start ausgelöst", { packageIds });
    await this.manager.startPackages(packageIds);
  }

  public async startItems(itemIds: string[]): Promise<void> {
    this.audit("INFO", "Item-Start ausgelöst", { itemIds });
    await this.manager.startItems(itemIds);
  }

  public stop(): void {
    this.audit("INFO", "Session-Stopp ausgelöst");
    this.manager.stop();
  }

  public togglePause(): boolean {
    const paused = this.manager.togglePause();
    this.audit("INFO", "Pause umgeschaltet", { paused });
    return paused;
  }

  public retryExtraction(packageId: string): void {
    this.audit("INFO", "Extraktion manuell wiederholt", { packageId });
    this.manager.retryExtraction(packageId);
  }

  public extractNow(packageId: string): void {
    this.audit("INFO", "Jetzt entpacken ausgelöst", { packageId });
    this.manager.extractNow(packageId);
  }

  public resetPackage(packageId: string): void {
    this.audit("INFO", "Paket zurückgesetzt", { packageId });
    this.manager.resetPackage(packageId);
  }

  public cancelPackage(packageId: string): void {
    this.audit("WARN", "Paket abgebrochen", { packageId });
    this.manager.cancelPackage(packageId);
  }

  public renamePackage(packageId: string, newName: string): void {
    this.audit("INFO", "Paket umbenannt", { packageId, newName });
    this.manager.renamePackage(packageId, newName);
  }

  public reorderPackages(packageIds: string[]): void {
    this.audit("INFO", "Paketreihenfolge geändert", { packageIds });
    this.manager.reorderPackages(packageIds);
  }

  public removeItem(itemId: string): void {
    this.audit("WARN", "Item entfernt", { itemId });
    this.manager.removeItem(itemId);
  }

  public togglePackage(packageId: string): void {
    this.audit("INFO", "Paket aktiviert/deaktiviert", { packageId });
    this.manager.togglePackage(packageId);
  }

  public exportPackageSelection(packageIds: string[]): { text: string; defaultFileName: string; packageCount: number; linkCount: number } {
    const selection = buildLinkExportSelection(this.manager.getSnapshot(), packageIds, []);
    this.audit("INFO", "Paket-Auswahl exportiert", {
      packageCount: selection.packageCount,
      linkCount: selection.linkCount,
      packageIds
    });
    return {
      text: serializeLinkExportText(selection.packages),
      defaultFileName: selection.defaultFileName,
      packageCount: selection.packageCount,
      linkCount: selection.linkCount
    };
  }

  public exportItemSelection(itemIds: string[]): { text: string; defaultFileName: string; packageCount: number; linkCount: number } {
    const selection = buildLinkExportSelection(this.manager.getSnapshot(), [], itemIds);
    this.audit("INFO", "Item-Auswahl exportiert", {
      packageCount: selection.packageCount,
      linkCount: selection.linkCount,
      itemIds
    });
    return {
      text: serializeLinkExportText(selection.packages),
      defaultFileName: selection.defaultFileName,
      packageCount: selection.packageCount,
      linkCount: selection.linkCount
    };
  }

  public exportQueue(): string {
    return this.manager.exportQueue();
  }

  public importQueue(json: string): { addedPackages: number; addedLinks: number } {
    const result = this.manager.importQueue(json);
    this.audit("INFO", "Import-Datei verarbeitet", result);
    return result;
  }

  public getSessionStats(): SessionStats {
    return this.manager.getSessionStats();
  }

  public resetSessionStats(): void {
    this.audit("INFO", "Session-Statistik zurückgesetzt");
    this.manager.resetSessionStats();
  }

  public resetDownloadStats(): void {
    this.manager.resetDownloadStats();
    this.settings = this.manager.getSettings();
    this.audit("INFO", "Download-Statistik zurückgesetzt");
  }

  public exportBackup(): Buffer {
    const settings = { ...this.settings };
    const session = this.manager.getSession();
    const history = loadHistoryForRetention(this.storagePaths, this.settings.historyRetentionMode);
    const payload = JSON.stringify({
      version: 2,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      session,
      history
    });
    this.audit("INFO", "Backup exportiert", {
      historyEntries: history.length,
      sessionItems: Object.keys(session.items).length,
      sessionPackages: Object.keys(session.packages).length
    });
    return encryptBackup(payload);
  }

  public exportSupportBundle(): { buffer: Buffer; defaultFileName: string } {
    this.audit("INFO", "Support-Bundle exportiert");
    logTraceEvent("INFO", "support", "Support-Bundle erstellt", {
      packageCount: Object.keys(this.manager.getSnapshot().session.packages).length,
      itemCount: Object.keys(this.manager.getSnapshot().session.items).length
    });
    return {
      buffer: buildSupportBundle(this.manager, this.storagePaths.baseDir, { hostDiagnosticsMode: "cached" }),
      defaultFileName: getSupportBundleDefaultFileName()
    };
  }

  public getSupportBundleDefaultFileName(): string {
    return getSupportBundleDefaultFileName();
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
    const importedSettingsRecord = importedSettings as unknown as Record<string, unknown>;
    const currentSettingsRecord = this.settings as unknown as Record<string, unknown>;
    // Legacy backup compatibility: if credentials were masked with ***, keep current values
    const SENSITIVE_KEYS: (keyof AppSettings)[] = [
      "token", "megaLogin", "megaPassword", "bestToken", "allDebridToken",
      "ddownloadLogin", "ddownloadPassword", "oneFichierApiKey",
      "debridLinkApiKeys", "linkSnappyLogin", "linkSnappyPassword"
    ];
    for (const key of SENSITIVE_KEYS) {
      const val = importedSettingsRecord[key];
      if (typeof val === "string" && val.startsWith("***")) {
        importedSettingsRecord[key] = currentSettingsRecord[key];
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

    resetHistoryForRetention(this.storagePaths, this.settings.historyRetentionMode);

    // Block runtime + shutdown persistence so the STALE in-memory session (the
    // manager still holds the PRE-import session — importBackup only wrote to disk)
    // cannot overwrite the restored data in the brief window before the auto-relaunch.
    // The relaunch (triggered in main.ts when restored===true) starts a fresh process
    // that loads the restored session cleanly via the normal startup path, so these
    // flags never linger in a live session.
    // M2-Fix: vorher blieb blockAllPersistence dauerhaft true wenn der User die
    // manuelle "Bitte neustarten"-Aufforderung ignorierte → stille Persistenz-Blockade,
    // alle weiteren Änderungen gingen bei hartem Crash verloren. Jetzt: Auto-Relaunch.
    this.manager.skipShutdownPersist = true;
    this.manager.blockAllPersistence = true;
    logger.info("Backup wiederhergestellt — App startet automatisch neu");
    this.audit("WARN", "Backup importiert", {
      historyEntries: Array.isArray(parsed.history) ? parsed.history.length : 0,
      accountSummary: buildAccountSummary(this.settings)
    });
    return { restored: true, message: "Backup wiederhergestellt – App startet automatisch neu…" };
  }

  public getSessionLogPath(): string | null {
    return getSessionLogPath();
  }

  public getPackageLogPath(packageId: string): string | null {
    return this.manager.getPackageLogPath(packageId) || getPackageLogPath(packageId);
  }

  public getItemLogPath(itemId: string): string | null {
    return this.manager.getItemLogPath(itemId) || getItemLogPath(itemId);
  }

  public shutdown(): void {
    if (this.runtimeStatsTimer) {
      clearInterval(this.runtimeStatsTimer);
      this.runtimeStatsTimer = null;
    }
    stopDebugServer();
    abortActiveUpdateDownload();
    this.manager.prepareForShutdown();
    this.megaWebFallback.dispose();
    this.realDebridWebFallback.dispose();
    this.allDebridWebFallback.dispose();
    this.bestDebridWebFallback.dispose();
    shutdownSessionLog();
    shutdownPackageLogs();
    shutdownItemLogs();
    shutdownRenameLog();
    this.audit("INFO", "App beendet");
    shutdownTraceLog();
    shutdownAccountRotationLog();
    shutdownAuditLog();
    if (this.settings.historyRetentionMode === "session") {
      clearHistory(this.storagePaths);
    }
    logger.info("App beendet");
  }

  public getHistory(): HistoryEntry[] {
    return loadHistoryForRetention(this.storagePaths, this.settings.historyRetentionMode);
  }

  public clearHistory(): void {
    this.audit("WARN", "Verlauf geleert");
    clearHistory(this.storagePaths);
  }

  public setPackagePriority(packageId: string, priority: PackagePriority): void {
    this.audit("INFO", "Paket-Priorität geändert", { packageId, priority });
    this.manager.setPackagePriority(packageId, priority);
  }

  public skipItems(itemIds: string[]): void {
    this.audit("INFO", "Items übersprungen", { itemIds });
    this.manager.skipItems(itemIds);
  }

  public resetItems(itemIds: string[]): void {
    this.audit("INFO", "Items zurückgesetzt", { itemIds });
    this.manager.resetItems(itemIds);
  }

  public removeHistoryEntry(entryId: string): void {
    this.audit("INFO", "Verlaufseintrag entfernt", { entryId });
    removeHistoryEntry(this.storagePaths, entryId);
  }

  public addToHistory(entry: HistoryEntry): void {
    this.audit("INFO", "Verlaufseintrag hinzugefügt", {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      provider: entry.provider,
      fileCount: entry.fileCount
    });
    addHistoryEntry(this.storagePaths, entry);
  }
}
