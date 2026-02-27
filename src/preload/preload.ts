import { contextBridge, ipcRenderer } from "electron";
import { AddLinksPayload, AppSettings, UiSnapshot, UpdateCheckResult } from "../shared/types";
import { IPC_CHANNELS } from "../shared/ipc";
import { ElectronApi } from "../shared/preload-api";

const api: ElectronApi = {
  getSnapshot: (): Promise<UiSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.GET_SNAPSHOT),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_VERSION),
  checkUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC_CHANNELS.CHECK_UPDATES),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.INSTALL_UPDATE),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  updateSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, settings),
  addLinks: (payload: AddLinksPayload): Promise<{ addedPackages: number; addedLinks: number; invalidCount: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_LINKS, payload),
  addContainers: (filePaths: string[]): Promise<{ addedPackages: number; addedLinks: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_CONTAINERS, filePaths),
  clearAll: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_ALL),
  start: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.START),
  stop: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.STOP),
  togglePause: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_PAUSE),
  cancelPackage: (packageId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_PACKAGE, packageId),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.PICK_FOLDER),
  pickContainers: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.PICK_CONTAINERS),
  onStateUpdate: (callback: (snapshot: UiSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: UiSnapshot): void => callback(snapshot);
    ipcRenderer.on(IPC_CHANNELS.STATE_UPDATE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STATE_UPDATE, listener);
    };
  }
};

contextBridge.exposeInMainWorld("rd", api);
