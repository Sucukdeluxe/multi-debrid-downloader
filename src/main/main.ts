import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, IpcMainInvokeEvent, Menu, shell, Tray } from "electron";
import { AddLinksPayload, AppSettings } from "../shared/types";
import { AppController } from "./app-controller";
import { IPC_CHANNELS } from "../shared/ipc";
import { logger } from "./logger";
import { APP_NAME } from "./constants";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let clipboardTimer: ReturnType<typeof setInterval> | null = null;
let lastClipboardText = "";
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

function createTray(): void {
  if (tray) {
    return;
  }
  const iconPath = path.join(app.getAppPath(), "assets", "app_icon.ico");
  try {
    tray = new Tray(iconPath);
  } catch {
    return;
  }
  tray.setToolTip(APP_NAME);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Anzeigen", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Start", click: () => { controller.start(); } },
    { label: "Stop", click: () => { controller.stop(); } },
    { type: "separator" },
    { label: "Beenden", click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function extractLinksFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi);
  return matches ? Array.from(new Set(matches)) : [];
}

function startClipboardWatcher(): void {
  if (clipboardTimer) {
    return;
  }
  lastClipboardText = clipboard.readText();
  clipboardTimer = setInterval(() => {
    const text = clipboard.readText();
    if (text === lastClipboardText || !text.trim()) {
      return;
    }
    lastClipboardText = text;
    const links = extractLinksFromText(text);
    if (links.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.CLIPBOARD_DETECTED, links);
    }
  }, 2000);
}

function stopClipboardWatcher(): void {
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
}

function updateClipboardWatcher(): void {
  const settings = controller.getSettings();
  if (settings.clipboardWatch) {
    startClipboardWatcher();
  } else {
    stopClipboardWatcher();
  }
}

function updateTray(): void {
  const settings = controller.getSettings();
  if (settings.minimizeToTray) {
    createTray();
  } else {
    destroyTray();
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GET_SNAPSHOT, () => controller.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.GET_VERSION, () => controller.getVersion());
  ipcMain.handle(IPC_CHANNELS.CHECK_UPDATES, async () => controller.checkUpdates());
  ipcMain.handle(IPC_CHANNELS.INSTALL_UPDATE, async () => {
    const result = await controller.installUpdate();
    if (result.started) {
      setTimeout(() => {
        app.quit();
      }, 350);
    }
    return result;
  });
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
  ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, (_event: IpcMainInvokeEvent, partial: Partial<AppSettings>) => {
    const result = controller.updateSettings(partial ?? {});
    updateClipboardWatcher();
    updateTray();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.ADD_LINKS, (_event: IpcMainInvokeEvent, payload: AddLinksPayload) => controller.addLinks(payload));
  ipcMain.handle(IPC_CHANNELS.ADD_CONTAINERS, async (_event: IpcMainInvokeEvent, filePaths: string[]) => controller.addContainers(filePaths ?? []));
  ipcMain.handle(IPC_CHANNELS.GET_START_CONFLICTS, () => controller.getStartConflicts());
  ipcMain.handle(IPC_CHANNELS.RESOLVE_START_CONFLICT, (_event: IpcMainInvokeEvent, packageId: string, policy: "keep" | "skip" | "overwrite") =>
    controller.resolveStartConflict(packageId, policy));
  ipcMain.handle(IPC_CHANNELS.CLEAR_ALL, () => controller.clearAll());
  ipcMain.handle(IPC_CHANNELS.START, () => controller.start());
  ipcMain.handle(IPC_CHANNELS.STOP, () => controller.stop());
  ipcMain.handle(IPC_CHANNELS.TOGGLE_PAUSE, () => controller.togglePause());
  ipcMain.handle(IPC_CHANNELS.CANCEL_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string) => controller.cancelPackage(packageId));
  ipcMain.handle(IPC_CHANNELS.RENAME_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string, newName: string) => controller.renamePackage(packageId, newName));
  ipcMain.handle(IPC_CHANNELS.REORDER_PACKAGES, (_event: IpcMainInvokeEvent, packageIds: string[]) => controller.reorderPackages(packageIds));
  ipcMain.handle(IPC_CHANNELS.REMOVE_ITEM, (_event: IpcMainInvokeEvent, itemId: string) => controller.removeItem(itemId));
  ipcMain.handle(IPC_CHANNELS.TOGGLE_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string) => controller.togglePackage(packageId));
  ipcMain.handle(IPC_CHANNELS.EXPORT_QUEUE, () => controller.exportQueue());
  ipcMain.handle(IPC_CHANNELS.IMPORT_QUEUE, (_event: IpcMainInvokeEvent, json: string) => controller.importQueue(json));
  ipcMain.handle(IPC_CHANNELS.TOGGLE_CLIPBOARD, () => {
    const settings = controller.getSettings();
    const next = !settings.clipboardWatch;
    controller.updateSettings({ clipboardWatch: next });
    updateClipboardWatcher();
    return next;
  });
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
  updateClipboardWatcher();
  updateTray();

  mainWindow.on("close", (event) => {
    const settings = controller.getSettings();
    if (settings.minimizeToTray && tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

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
  stopClipboardWatcher();
  destroyTray();
  try {
    controller.shutdown();
  } catch (error) {
    logger.error(`Fehler beim Shutdown: ${String(error)}`);
  }
});
