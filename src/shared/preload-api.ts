import type {
  AddLinksPayload,
  AllDebridHostInfo,
  AppSettings,
  DebugSetupCheckResult,
  DebridLinkHostLimitInfo,
  DebridProvider,
  DuplicatePolicy,
  HistoryEntry,
  PackagePriority,
  SessionStats,
  StartConflictEntry,
  StartConflictResolutionResult,
  SupportTraceConfig,
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
  resetProviderDailyUsage: (provider: DebridProvider) => Promise<AppSettings>;
  resetDebridLinkApiKeyDailyUsage: (keyId: string) => Promise<AppSettings>;
  addLinks: (payload: AddLinksPayload) => Promise<{ addedPackages: number; addedLinks: number; invalidCount: number }>;
  addContainers: (filePaths: string[]) => Promise<{ addedPackages: number; addedLinks: number }>;
  getStartConflicts: () => Promise<StartConflictEntry[]>;
  resolveStartConflict: (packageId: string, policy: DuplicatePolicy) => Promise<StartConflictResolutionResult>;
  clearAll: () => Promise<void>;
  start: () => Promise<void>;
  startPackages: (packageIds: string[]) => Promise<void>;
  stop: () => Promise<void>;
  togglePause: () => Promise<boolean>;
  cancelPackage: (packageId: string) => Promise<void>;
  renamePackage: (packageId: string, newName: string) => Promise<void>;
  reorderPackages: (packageIds: string[]) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  togglePackage: (packageId: string) => Promise<void>;
  exportPackageSelection: (packageIds: string[]) => Promise<{ saved: boolean; packageCount: number; linkCount: number; filePath?: string }>;
  exportItemSelection: (itemIds: string[]) => Promise<{ saved: boolean; packageCount: number; linkCount: number; filePath?: string }>;
  exportQueue: () => Promise<{ saved: boolean }>;
  importQueue: (json: string) => Promise<{ addedPackages: number; addedLinks: number }>;
  toggleClipboard: () => Promise<boolean>;
  pickFolder: () => Promise<string | null>;
  pickContainers: () => Promise<string[]>;
  getSessionStats: () => Promise<SessionStats>;
  resetSessionStats: () => Promise<void>;
  resetDownloadStats: () => Promise<void>;
  restart: () => Promise<void>;
  quit: () => Promise<void>;
  exportBackup: () => Promise<{ saved: boolean }>;
  importBackup: () => Promise<{ restored: boolean; message: string }>;
  exportSupportBundle: () => Promise<{ saved: boolean; filePath?: string }>;
  openLog: () => Promise<void>;
  openAuditLog: () => Promise<void>;
  openSessionLog: () => Promise<void>;
  openTraceLog: () => Promise<void>;
  openPackageLog: (packageId: string) => Promise<void>;
  openItemLog: (itemId: string) => Promise<void>;
  getDebugSetupCheck: () => Promise<DebugSetupCheckResult>;
  getTraceConfig: () => Promise<SupportTraceConfig>;
  setTraceEnabled: (enabled: boolean, note?: string, durationMinutes?: number) => Promise<SupportTraceConfig>;
  rotateDebugToken: () => Promise<{ path: string }>;
  openRealDebridLogin: () => Promise<void>;
  openAllDebridLogin: () => Promise<void>;
  importBestDebridCookies: () => Promise<number>;
  getAllDebridHostInfo: () => Promise<AllDebridHostInfo>;
  getDebridLinkHostLimits: () => Promise<DebridLinkHostLimitInfo[]>;
  retryExtraction: (packageId: string) => Promise<void>;
  extractNow: (packageId: string) => Promise<void>;
  resetPackage: (packageId: string) => Promise<void>;
  getHistory: () => Promise<HistoryEntry[]>;
  clearHistory: () => Promise<void>;
  removeHistoryEntry: (entryId: string) => Promise<void>;
  setPackagePriority: (packageId: string, priority: PackagePriority) => Promise<void>;
  skipItems: (itemIds: string[]) => Promise<void>;
  resetItems: (itemIds: string[]) => Promise<void>;
  startItems: (itemIds: string[]) => Promise<void>;
  onStateUpdate: (callback: (snapshot: UiSnapshot) => void) => () => void;
  onClipboardDetected: (callback: (links: string[]) => void) => () => void;
  onUpdateInstallProgress: (callback: (progress: UpdateInstallProgress) => void) => () => void;
}
