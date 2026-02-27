import path from "node:path";
import { app } from "electron";
import { AddLinksPayload, AppSettings, ParsedPackageInput, UiSnapshot } from "../shared/types";
import { importDlcContainers } from "./container";
import { APP_VERSION, defaultSettings } from "./constants";
import { DownloadManager } from "./download-manager";
import { parseCollectorInput } from "./link-parser";
import { configureLogger, logger } from "./logger";
import { createStoragePaths, emptySession, loadSession, loadSettings, saveSettings } from "./storage";

export class AppController {
  private settings: AppSettings;

  private manager: DownloadManager;

  private storagePaths = createStoragePaths(path.join(app.getPath("userData"), "runtime"));

  public constructor() {
    configureLogger(this.storagePaths.baseDir);
    this.settings = loadSettings(this.storagePaths);
    const session = loadSession(this.storagePaths);
    this.manager = new DownloadManager(this.settings, session, this.storagePaths);
    this.manager.on("state", (snapshot: UiSnapshot) => {
      this.onState?.(snapshot);
    });
    logger.info(`App gestartet v${APP_VERSION}`);

    if (this.settings.autoResumeOnStart) {
      const snapshot = this.manager.getSnapshot();
      const hasPending = Object.values(snapshot.session.items).some((item) => item.status === "queued" || item.status === "reconnect_wait");
      if (hasPending && this.settings.token.trim()) {
        this.manager.start();
        logger.info("Auto-Resume beim Start aktiviert");
      }
    }
  }

  public onState: ((snapshot: UiSnapshot) => void) | null = null;

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
    this.settings = {
      ...defaultSettings(),
      ...this.settings,
      ...partial
    };
    saveSettings(this.storagePaths, this.settings);
    this.manager.setSettings(this.settings);
    return this.settings;
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

  public shutdown(): void {
    this.manager.stop();
    logger.info("App beendet");
  }
}
