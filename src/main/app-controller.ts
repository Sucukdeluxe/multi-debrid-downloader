import path from "node:path";
import { app } from "electron";
import {
  AddLinksPayload,
  AppSettings,
  DuplicatePolicy,
  ParsedPackageInput,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallResult
} from "../shared/types";
import { importDlcContainers } from "./container";
import { APP_VERSION } from "./constants";
import { DownloadManager } from "./download-manager";
import { parseCollectorInput } from "./link-parser";
import { configureLogger, getLogFilePath, logger } from "./logger";
import { MegaWebFallback } from "./mega-web-fallback";
import { createStoragePaths, loadSession, loadSettings, normalizeSettings, saveSettings } from "./storage";
import { abortActiveUpdateDownload, checkGitHubUpdate, installLatestUpdate } from "./update";

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
      megaWebUnrestrict: (link: string) => this.megaWebFallback.unrestrict(link)
    });
    this.manager.on("state", (snapshot: UiSnapshot) => {
      this.onStateHandler?.(snapshot);
    });
    logger.info(`App gestartet v${APP_VERSION}`);
    logger.info(`Log-Datei: ${getLogFilePath()}`);

    if (this.settings.autoResumeOnStart) {
      const snapshot = this.manager.getSnapshot();
      const hasPending = Object.values(snapshot.session.items).some((item) => item.status === "queued" || item.status === "reconnect_wait");
      const hasConflicts = this.manager.getStartConflicts().length > 0;
      if (hasPending && this.hasAnyProviderToken(this.settings) && !hasConflicts) {
        this.autoResumePending = true;
        logger.info("Auto-Resume beim Start vorgemerkt");
      } else if (hasPending && hasConflicts) {
        logger.info("Auto-Resume übersprungen: Start-Konflikte erkannt");
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
        this.manager.start();
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

  public async installUpdate(): Promise<UpdateInstallResult> {
    const cacheAgeMs = Date.now() - this.lastUpdateCheckAt;
    const cached = this.lastUpdateCheck && !this.lastUpdateCheck.error && cacheAgeMs <= 10 * 60 * 1000
      ? this.lastUpdateCheck
      : undefined;
    const result = await installLatestUpdate(this.settings.updateRepo, cached);
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
      links: pkg.links
    }));
    const result = this.manager.addPackages(merged);
    return result;
  }

  public getStartConflicts(): StartConflictEntry[] {
    return this.manager.getStartConflicts();
  }

  public async resolveStartConflict(packageId: string, policy: DuplicatePolicy): Promise<StartConflictResolutionResult> {
    return this.manager.resolveStartConflict(packageId, policy);
  }

  public clearAll(): void {
    this.manager.clearAll();
  }

  public start(): void {
    this.manager.start();
  }

  public stop(): void {
    this.manager.stop();
  }

  public togglePause(): boolean {
    return this.manager.togglePause();
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

  public shutdown(): void {
    abortActiveUpdateDownload();
    this.manager.prepareForShutdown();
    this.megaWebFallback.dispose();
    logger.info("App beendet");
  }
}
