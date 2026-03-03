import os from "node:os";
import path from "node:path";
import { app } from "electron";
import {
  AddLinksPayload,
  AppSettings,
  DuplicatePolicy,
  HistoryEntry,
  ParsedPackageInput,
  ProviderAccountInfo,
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
import { MegaWebFallback } from "./mega-web-fallback";
import { addHistoryEntry, clearHistory, createStoragePaths, loadHistory, loadSession, loadSettings, normalizeSettings, removeHistoryEntry, saveSession, saveSettings } from "./storage";
import { abortActiveUpdateDownload, checkGitHubUpdate, installLatestUpdate } from "./update";
import { startDebugServer, stopDebugServer } from "./debug-server";
import { decryptCredentials, encryptCredentials, SENSITIVE_KEYS } from "./backup-crypto";
import { compactErrorText } from "./utils";

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
            this.autoResumePending = true;
            logger.info("Auto-Resume beim Start vorgemerkt");
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
    const settingsCopy = { ...this.settings } as Record<string, unknown>;
    const sensitiveFields: Record<string, string> = {};
    for (const key of SENSITIVE_KEYS) {
      sensitiveFields[key] = String(settingsCopy[key] ?? "");
      delete settingsCopy[key];
    }
    const username = os.userInfo().username;
    const credentials = encryptCredentials(sensitiveFields, username);
    const session = this.manager.getSession();
    return JSON.stringify({ version: 2, settings: settingsCopy, credentials, session }, null, 2);
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

    const version = typeof parsed.version === "number" ? parsed.version : 1;
    let settingsObj = parsed.settings as Record<string, unknown>;

    if (version >= 2) {
      const creds = parsed.credentials as { salt: string; iv: string; tag: string; data: string } | undefined;
      if (!creds || !creds.salt || !creds.iv || !creds.tag || !creds.data) {
        return { restored: false, message: "Backup v2: Verschlüsselte Zugangsdaten fehlen" };
      }
      try {
        const username = os.userInfo().username;
        const decrypted = decryptCredentials(creds, username);
        settingsObj = { ...settingsObj, ...decrypted };
      } catch {
        return {
          restored: false,
          message: "Entschlüsselung fehlgeschlagen. Das Backup wurde mit einem anderen Benutzer erstellt."
        };
      }
    }

    const restoredSettings = normalizeSettings(settingsObj as AppSettings);
    this.settings = restoredSettings;
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    const restoredSession = parsed.session as ReturnType<typeof loadSession>;
    saveSession(this.storagePaths, restoredSession);
    return { restored: true, message: "Backup wiederhergestellt. Bitte App neustarten." };
  }

  public shutdown(): void {
    stopDebugServer();
    abortActiveUpdateDownload();
    this.manager.prepareForShutdown();
    this.megaWebFallback.dispose();
    logger.info("App beendet");
  }

  public getHistory(): HistoryEntry[] {
    return loadHistory(this.storagePaths);
  }

  public clearHistory(): void {
    clearHistory(this.storagePaths);
  }

  public removeHistoryEntry(entryId: string): void {
    removeHistoryEntry(this.storagePaths, entryId);
  }

  public async checkMegaAccount(): Promise<ProviderAccountInfo> {
    return this.megaWebFallback.getAccountInfo();
  }

  public async checkRealDebridAccount(): Promise<ProviderAccountInfo> {
    try {
      const response = await fetch("https://api.real-debrid.com/rest/1.0/user", {
        headers: { Authorization: `Bearer ${this.settings.token}` }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { provider: "realdebrid", username: "", accountType: "", daysRemaining: null, loyaltyPoints: null, error: `HTTP ${response.status}: ${compactErrorText(text)}` };
      }
      const data = await response.json() as Record<string, unknown>;
      const username = String(data.username ?? "");
      const type = String(data.type ?? "");
      const expiration = data.expiration ? new Date(String(data.expiration)) : null;
      const daysRemaining = expiration ? Math.max(0, Math.round((expiration.getTime() - Date.now()) / 86400000)) : null;
      const points = typeof data.points === "number" ? data.points : null;
      return { provider: "realdebrid", username, accountType: type === "premium" ? "Premium" : type, daysRemaining, loyaltyPoints: points as number | null };
    } catch (err) {
      return { provider: "realdebrid", username: "", accountType: "", daysRemaining: null, loyaltyPoints: null, error: compactErrorText(err) };
    }
  }

  public async checkAllDebridAccount(): Promise<ProviderAccountInfo> {
    try {
      const response = await fetch("https://api.alldebrid.com/v4/user", {
        headers: { Authorization: `Bearer ${this.settings.allDebridToken}` }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { provider: "alldebrid", username: "", accountType: "", daysRemaining: null, loyaltyPoints: null, error: `HTTP ${response.status}: ${compactErrorText(text)}` };
      }
      const data = await response.json() as Record<string, unknown>;
      const userData = (data.data as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined;
      if (!userData) {
        return { provider: "alldebrid", username: "", accountType: "", daysRemaining: null, loyaltyPoints: null, error: "Ungültige API-Antwort" };
      }
      const username = String(userData.username ?? "");
      const isPremium = Boolean(userData.isPremium);
      const premiumUntil = typeof userData.premiumUntil === "number" ? userData.premiumUntil : 0;
      const daysRemaining = premiumUntil > 0 ? Math.max(0, Math.round((premiumUntil * 1000 - Date.now()) / 86400000)) : null;
      return { provider: "alldebrid", username, accountType: isPremium ? "Premium" : "Free", daysRemaining, loyaltyPoints: null };
    } catch (err) {
      return { provider: "alldebrid", username: "", accountType: "", daysRemaining: null, loyaltyPoints: null, error: compactErrorText(err) };
    }
  }

  public async checkBestDebridAccount(): Promise<ProviderAccountInfo> {
    if (!this.settings.bestToken.trim()) {
      return { provider: "bestdebrid", username: "", accountType: "", daysRemaining: null, loyaltyPoints: null, error: "Kein Token konfiguriert" };
    }
    return { provider: "bestdebrid", username: "(Token konfiguriert)", accountType: "Konfiguriert", daysRemaining: null, loyaltyPoints: null };
  }

  public addToHistory(entry: HistoryEntry): void {
    addHistoryEntry(this.storagePaths, entry);
  }
}
