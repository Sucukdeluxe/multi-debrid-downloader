import type {
  AddLinksPayload,
  AppSettings,
  DuplicatePolicy,
  SessionStats,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress,
  UpdateInstallResult
} from "./types";

export interface ElectronApi {
  getSnapshot: () => Promise<UiSnapshot>;
  getVersion: () => Promise<string>;
  checkUpdates: () => Promise<UpdateCheckResult>;
  installUpdate: () => Promise<UpdateInstallResult>;
  openExternal: (url: string) => Promise<boolean>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  addLinks: (payload: AddLinksPayload) => Promise<{ addedPackages: number; addedLinks: number; invalidCount: number }>;
  addContainers: (filePaths: string[]) => Promise<{ addedPackages: number; addedLinks: number }>;
  getStartConflicts: () => Promise<StartConflictEntry[]>;
  resolveStartConflict: (packageId: string, policy: DuplicatePolicy) => Promise<StartConflictResolutionResult>;
  clearAll: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  togglePause: () => Promise<boolean>;
  cancelPackage: (packageId: string) => Promise<void>;
  renamePackage: (packageId: string, newName: string) => Promise<void>;
  reorderPackages: (packageIds: string[]) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  togglePackage: (packageId: string) => Promise<void>;
  exportQueue: () => Promise<string>;
  importQueue: (json: string) => Promise<{ addedPackages: number; addedLinks: number }>;
  toggleClipboard: () => Promise<boolean>;
  pickFolder: () => Promise<string | null>;
  pickContainers: () => Promise<string[]>;
  getSessionStats: () => Promise<SessionStats>;
  restart: () => Promise<void>;
  quit: () => Promise<void>;
  exportBackup: () => Promise<{ saved: boolean }>;
  importBackup: () => Promise<{ restored: boolean; message: string }>;
  openLog: () => Promise<void>;
  onStateUpdate: (callback: (snapshot: UiSnapshot) => void) => () => void;
  onClipboardDetected: (callback: (links: string[]) => void) => () => void;
  onUpdateInstallProgress: (callback: (progress: UpdateInstallProgress) => void) => () => void;
}
