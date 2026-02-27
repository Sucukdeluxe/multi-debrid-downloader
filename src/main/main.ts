import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, shell } from "electron";
import { AddLinksPayload, AppSettings } from "../shared/types";
import { AppController } from "./app-controller";
import { IPC_CHANNELS } from "../shared/ipc";
import { logger } from "./logger";
import { APP_NAME } from "./constants";

let mainWindow: BrowserWindow | null = null;
const controller = new AppController();

function isDevMode(): boolean {
  return process.env.NODE_ENV === "development";
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: "#070b14",
    title: `${APP_NAME} v${controller.getVersion()}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "../preload/preload.js")
    }
  });

  if (isDevMode()) {
    void window.loadURL("http://localhost:5173");
  } else {
    void window.loadFile(path.join(app.getAppPath(), "build", "renderer", "index.html"));
  }

  return window;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GET_SNAPSHOT, () => controller.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.GET_VERSION, () => controller.getVersion());
  ipcMain.handle(IPC_CHANNELS.CHECK_UPDATES, async () => controller.checkUpdates());
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event: IpcMainInvokeEvent, rawUrl: string) => {
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return false;
      }
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, (_event: IpcMainInvokeEvent, partial: Partial<AppSettings>) => controller.updateSettings(partial ?? {}));
  ipcMain.handle(IPC_CHANNELS.ADD_LINKS, (_event: IpcMainInvokeEvent, payload: AddLinksPayload) => controller.addLinks(payload));
  ipcMain.handle(IPC_CHANNELS.ADD_CONTAINERS, async (_event: IpcMainInvokeEvent, filePaths: string[]) => controller.addContainers(filePaths ?? []));
  ipcMain.handle(IPC_CHANNELS.CLEAR_ALL, () => controller.clearAll());
  ipcMain.handle(IPC_CHANNELS.START, () => controller.start());
  ipcMain.handle(IPC_CHANNELS.STOP, () => controller.stop());
  ipcMain.handle(IPC_CHANNELS.TOGGLE_PAUSE, () => controller.togglePause());
  ipcMain.handle(IPC_CHANNELS.CANCEL_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string) => controller.cancelPackage(packageId));
  ipcMain.handle(IPC_CHANNELS.PICK_FOLDER, async () => {
    const options = {
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle(IPC_CHANNELS.PICK_CONTAINERS, async () => {
    const options = {
      properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
      filters: [
        { name: "Container", extensions: ["dlc"] },
        { name: "Alle Dateien", extensions: ["*"] }
      ]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  controller.onState = (snapshot) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IPC_CHANNELS.STATE_UPDATE, snapshot);
  };
}

app.whenReady().then(() => {
  registerIpcHandlers();
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  try {
    controller.shutdown();
  } catch (error) {
    logger.error(`Fehler beim Shutdown: ${String(error)}`);
  }
});
