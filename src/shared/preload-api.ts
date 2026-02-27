import type { AddLinksPayload, AppSettings, UiSnapshot, UpdateCheckResult } from "./types";

export interface ElectronApi {
  getSnapshot: () => Promise<UiSnapshot>;
  getVersion: () => Promise<string>;
  checkUpdates: () => Promise<UpdateCheckResult>;
  openExternal: (url: string) => Promise<boolean>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  addLinks: (payload: AddLinksPayload) => Promise<{ addedPackages: number; addedLinks: number; invalidCount: number }>;
  addContainers: (filePaths: string[]) => Promise<{ addedPackages: number; addedLinks: number }>;
  clearAll: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  togglePause: () => Promise<boolean>;
  cancelPackage: (packageId: string) => Promise<void>;
  pickFolder: () => Promise<string | null>;
  pickContainers: () => Promise<string[]>;
  onStateUpdate: (callback: (snapshot: UiSnapshot) => void) => () => void;
}
