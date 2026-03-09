import { contextBridge, ipcRenderer } from "electron";
import {
  AddLinksPayload,
  AllDebridHostInfo,
  AppSettings,
  DebridLinkHostLimitInfo,
  DebridProvider,
  DuplicatePolicy,
  HistoryEntry,
  PackagePriority,
  SessionStats,
  StartConflictEntry,
  StartConflictResolutionResult,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress
} from "../shared/types";
import { IPC_CHANNELS } from "../shared/ipc";
import { ElectronApi } from "../shared/preload-api";

const api: ElectronApi = {
  getSnapshot: (): Promise<UiSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.GET_SNAPSHOT),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_VERSION),
  checkUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC_CHANNELS.CHECK_UPDATES),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.INSTALL_UPDATE),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  updateSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, settings),
  resetProviderDailyUsage: (provider: DebridProvider): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.RESET_PROVIDER_DAILY_USAGE, provider),
  resetDebridLinkApiKeyDailyUsage: (keyId: string): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.RESET_DEBRID_LINK_API_KEY_DAILY_USAGE, keyId),
  addLinks: (payload: AddLinksPayload): Promise<{ addedPackages: number; addedLinks: number; invalidCount: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_LINKS, payload),
  addContainers: (filePaths: string[]): Promise<{ addedPackages: number; addedLinks: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_CONTAINERS, filePaths),
  getStartConflicts: (): Promise<StartConflictEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_START_CONFLICTS),
  resolveStartConflict: (packageId: string, policy: DuplicatePolicy): Promise<StartConflictResolutionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.RESOLVE_START_CONFLICT, packageId, policy),
  clearAll: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_ALL),
  start: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.START),
  startPackages: (packageIds: string[]): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.START_PACKAGES, packageIds),
  stop: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.STOP),
  togglePause: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_PAUSE),
  cancelPackage: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_PACKAGE, packageId),
  renamePackage: (packageId: string, newName: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RENAME_PACKAGE, packageId, newName),
  reorderPackages: (packageIds: string[]): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.REORDER_PACKAGES, packageIds),
  removeItem: (itemId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.REMOVE_ITEM, itemId),
  togglePackage: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_PACKAGE, packageId),
  exportQueue: (): Promise<{ saved: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_QUEUE),
  importQueue: (json: string): Promise<{ addedPackages: number; addedLinks: number }> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_QUEUE, json),
  toggleClipboard: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_CLIPBOARD),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.PICK_FOLDER),
  pickContainers: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.PICK_CONTAINERS),
  getSessionStats: (): Promise<SessionStats> => ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_STATS),
  resetSessionStats: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RESET_SESSION_STATS),
  resetDownloadStats: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RESET_DOWNLOAD_STATS),
  restart: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RESTART),
  quit: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.QUIT),
  exportBackup: (): Promise<{ saved: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_BACKUP),
  importBackup: (): Promise<{ restored: boolean; message: string }> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_BACKUP),
  openLog: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_LOG),
  openSessionLog: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_SESSION_LOG),
  openPackageLog: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PACKAGE_LOG, packageId),
  openItemLog: (itemId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_ITEM_LOG, itemId),
  openRealDebridLogin: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_REALDEBRID_LOGIN),
  openAllDebridLogin: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_ALLDEBRID_LOGIN),
  importBestDebridCookies: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_BESTDEBRID_COOKIES),
  getAllDebridHostInfo: (): Promise<AllDebridHostInfo> => ipcRenderer.invoke(IPC_CHANNELS.GET_ALLDEBRID_HOST_INFO),
  getDebridLinkHostLimits: (): Promise<DebridLinkHostLimitInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_DEBRIDLINK_HOST_LIMITS),
  retryExtraction: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RETRY_EXTRACTION, packageId),
  extractNow: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_NOW, packageId),
  resetPackage: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RESET_PACKAGE, packageId),
  getHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_HISTORY),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_HISTORY),
  removeHistoryEntry: (entryId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.REMOVE_HISTORY_ENTRY, entryId),
  setPackagePriority: (packageId: string, priority: PackagePriority): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SET_PACKAGE_PRIORITY, packageId, priority),
  skipItems: (itemIds: string[]): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SKIP_ITEMS, itemIds),
  resetItems: (itemIds: string[]): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.RESET_ITEMS, itemIds),
  startItems: (itemIds: string[]): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.START_ITEMS, itemIds),
  onStateUpdate: (callback: (snapshot: UiSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: UiSnapshot): void => callback(snapshot);
    ipcRenderer.on(IPC_CHANNELS.STATE_UPDATE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STATE_UPDATE, listener);
    };
  },
  onClipboardDetected: (callback: (links: string[]) => void): (() => void) => {
    const listener = (_event: unknown, links: string[]): void => callback(links);
    ipcRenderer.on(IPC_CHANNELS.CLIPBOARD_DETECTED, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLIPBOARD_DETECTED, listener);
    };
  },
  onUpdateInstallProgress: (callback: (progress: UpdateInstallProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: UpdateInstallProgress): void => callback(progress);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_INSTALL_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_INSTALL_PROGRESS, listener);
    };
  }
};

contextBridge.exposeInMainWorld("rd", api);
