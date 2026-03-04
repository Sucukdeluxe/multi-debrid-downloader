import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, IpcMainInvokeEvent, Menu, shell, Tray } from "electron";
import { AddLinksPayload, AppSettings, UpdateInstallProgress } from "../shared/types";
import { AppController } from "./app-controller";
import { IPC_CHANNELS } from "../shared/ipc";
import { getLogFilePath, logger } from "./logger";
import { APP_NAME } from "./constants";
import { extractHttpLinksFromText } from "./utils";

/* ── IPC validation helpers ────────────────────────────────────── */
function validateString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} muss ein String sein`);
  }
  return value;
}

function validatePlainObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} muss ein Objekt sein`);
  }
  return value as Record<string, unknown>;
}

const IMPORT_QUEUE_MAX_BYTES = 10 * 1024 * 1024;
const RENAME_PACKAGE_MAX_CHARS = 240;
function validateStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
    throw new Error(`${name} muss ein String-Array sein`);
  }
  return value as string[];
}

/* ── Single Instance Lock ───────────────────────────────────────── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
  process.exit(0);
}

/* ── Unhandled error protection ─────────────────────────────────── */
process.on("uncaughtException", (error) => {
  logger.error(`Uncaught Exception: ${String(error?.stack || error)}`);
});
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled Rejection: ${String(reason)}`);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let clipboardTimer: ReturnType<typeof setInterval> | null = null;
let lastClipboardText = "";
const controller = new AppController();
const CLIPBOARD_MAX_TEXT_CHARS = 50_000;

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
    title: `${APP_NAME} - v${controller.getVersion()}`,
    icon: path.join(app.getAppPath(), "assets", "app_icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "../preload/preload.js")
    }
  });

  if (!isDevMode()) {
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.real-debrid.com https://codeberg.org https://bestdebrid.com https://api.alldebrid.com https://www.mega-debrid.eu"
          ]
        }
      });
    });
  }

  window.setMenuBarVisibility(false);
  window.setAutoHideMenuBar(true);

  if (isDevMode()) {
    void window.loadURL("http://localhost:5173");
  } else {
    void window.loadFile(path.join(app.getAppPath(), "build", "renderer", "index.html"));
  }

  return window;
}

function bindMainWindowLifecycle(window: BrowserWindow): void {
  window.on("close", (event) => {
    const settings = controller.getSettings();
    if (settings.minimizeToTray && tray) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
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
  return extractHttpLinksFromText(text);
}

function normalizeClipboardText(text: string): string {
  const truncateUnicodeSafe = (value: string, maxChars: number): string => {
    if (value.length <= maxChars) {
      return value;
    }
    const points = Array.from(value);
    if (points.length <= maxChars) {
      return value;
    }
    return points.slice(0, maxChars).join("");
  };

  const normalized = String(text || "");
  if (normalized.length <= CLIPBOARD_MAX_TEXT_CHARS) {
    return normalized;
  }
  const truncated = truncateUnicodeSafe(normalized, CLIPBOARD_MAX_TEXT_CHARS);
  const lastBreak = Math.max(
    truncated.lastIndexOf("\n"),
    truncated.lastIndexOf("\r"),
    truncated.lastIndexOf("\t"),
    truncated.lastIndexOf(" ")
  );
  if (lastBreak >= Math.floor(CLIPBOARD_MAX_TEXT_CHARS * 0.7)) {
    return truncated.slice(0, lastBreak);
  }
  return truncated;
}

function startClipboardWatcher(): void {
  if (clipboardTimer) {
    return;
  }
  lastClipboardText = normalizeClipboardText(clipboard.readText());
  clipboardTimer = setInterval(() => {
    const text = normalizeClipboardText(clipboard.readText());
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
    const result = await controller.installUpdate((progress: UpdateInstallProgress) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send(IPC_CHANNELS.UPDATE_INSTALL_PROGRESS, progress);
    });
    if (result.started) {
      setTimeout(() => {
        app.quit();
      }, 800);
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
    const validated = validatePlainObject(partial ?? {}, "partial");
    const result = controller.updateSettings(validated as Partial<AppSettings>);
    updateClipboardWatcher();
    updateTray();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.ADD_LINKS, (_event: IpcMainInvokeEvent, payload: AddLinksPayload) => {
    validatePlainObject(payload ?? {}, "payload");
    validateString(payload?.rawText, "rawText");
    if (payload.packageName !== undefined) {
      validateString(payload.packageName, "packageName");
    }
    if (payload.duplicatePolicy !== undefined && payload.duplicatePolicy !== "keep" && payload.duplicatePolicy !== "skip" && payload.duplicatePolicy !== "overwrite") {
      throw new Error("duplicatePolicy muss 'keep', 'skip' oder 'overwrite' sein");
    }
    return controller.addLinks(payload);
  });
  ipcMain.handle(IPC_CHANNELS.ADD_CONTAINERS, async (_event: IpcMainInvokeEvent, filePaths: string[]) => {
    const validPaths = validateStringArray(filePaths ?? [], "filePaths");
    const safePaths = validPaths.filter((p) => path.isAbsolute(p));
    return controller.addContainers(safePaths);
  });
  ipcMain.handle(IPC_CHANNELS.GET_START_CONFLICTS, () => controller.getStartConflicts());
  ipcMain.handle(IPC_CHANNELS.RESOLVE_START_CONFLICT, (_event: IpcMainInvokeEvent, packageId: string, policy: "keep" | "skip" | "overwrite") => {
    validateString(packageId, "packageId");
    validateString(policy, "policy");
    if (policy !== "keep" && policy !== "skip" && policy !== "overwrite") {
      throw new Error("policy muss 'keep', 'skip' oder 'overwrite' sein");
    }
    return controller.resolveStartConflict(packageId, policy);
  });
  ipcMain.handle(IPC_CHANNELS.CLEAR_ALL, () => controller.clearAll());
  ipcMain.handle(IPC_CHANNELS.START, () => controller.start());
  ipcMain.handle(IPC_CHANNELS.START_PACKAGES, (_event: IpcMainInvokeEvent, packageIds: string[]) => {
    if (!Array.isArray(packageIds)) throw new Error("packageIds muss ein Array sein");
    return controller.startPackages(packageIds);
  });
  ipcMain.handle(IPC_CHANNELS.START_ITEMS, (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    validateStringArray(itemIds ?? [], "itemIds");
    return controller.startItems(itemIds);
  });
  ipcMain.handle(IPC_CHANNELS.STOP, () => controller.stop());
  ipcMain.handle(IPC_CHANNELS.TOGGLE_PAUSE, () => controller.togglePause());
  ipcMain.handle(IPC_CHANNELS.CANCEL_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string) => {
    validateString(packageId, "packageId");
    return controller.cancelPackage(packageId);
  });
  ipcMain.handle(IPC_CHANNELS.RENAME_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string, newName: string) => {
    validateString(packageId, "packageId");
    validateString(newName, "newName");
    if (newName.length > RENAME_PACKAGE_MAX_CHARS) {
      throw new Error(`newName zu lang (max ${RENAME_PACKAGE_MAX_CHARS} Zeichen)`);
    }
    return controller.renamePackage(packageId, newName);
  });
  ipcMain.handle(IPC_CHANNELS.REORDER_PACKAGES, (_event: IpcMainInvokeEvent, packageIds: string[]) => {
    validateStringArray(packageIds, "packageIds");
    return controller.reorderPackages(packageIds);
  });
  ipcMain.handle(IPC_CHANNELS.REMOVE_ITEM, (_event: IpcMainInvokeEvent, itemId: string) => {
    validateString(itemId, "itemId");
    return controller.removeItem(itemId);
  });
  ipcMain.handle(IPC_CHANNELS.TOGGLE_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string) => {
    validateString(packageId, "packageId");
    return controller.togglePackage(packageId);
  });
  ipcMain.handle(IPC_CHANNELS.RETRY_EXTRACTION, (_event: IpcMainInvokeEvent, packageId: string) => {
    validateString(packageId, "packageId");
    return controller.retryExtraction(packageId);
  });
  ipcMain.handle(IPC_CHANNELS.EXTRACT_NOW, (_event: IpcMainInvokeEvent, packageId: string) => {
    validateString(packageId, "packageId");
    return controller.extractNow(packageId);
  });
  ipcMain.handle(IPC_CHANNELS.RESET_PACKAGE, (_event: IpcMainInvokeEvent, packageId: string) => {
    validateString(packageId, "packageId");
    return controller.resetPackage(packageId);
  });
  ipcMain.handle(IPC_CHANNELS.SET_PACKAGE_PRIORITY, (_event: IpcMainInvokeEvent, packageId: string, priority: string) => {
    validateString(packageId, "packageId");
    validateString(priority, "priority");
    return controller.setPackagePriority(packageId, priority as any);
  });
  ipcMain.handle(IPC_CHANNELS.SKIP_ITEMS, (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    if (!Array.isArray(itemIds)) throw new Error("itemIds must be an array");
    return controller.skipItems(itemIds);
  });
  ipcMain.handle(IPC_CHANNELS.RESET_ITEMS, (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    if (!Array.isArray(itemIds)) throw new Error("itemIds must be an array");
    return controller.resetItems(itemIds);
  });
  ipcMain.handle(IPC_CHANNELS.GET_HISTORY, () => controller.getHistory());
  ipcMain.handle(IPC_CHANNELS.CLEAR_HISTORY, () => controller.clearHistory());
  ipcMain.handle(IPC_CHANNELS.REMOVE_HISTORY_ENTRY, (_event: IpcMainInvokeEvent, entryId: string) => {
    validateString(entryId, "entryId");
    return controller.removeHistoryEntry(entryId);
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_QUEUE, async () => {
    const options = {
      defaultPath: `rd-queue-export.json`,
      filters: [{ name: "Queue Export", extensions: ["json"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }
    const json = controller.exportQueue();
    await fs.promises.writeFile(result.filePath, json, "utf8");
    return { saved: true };
  });
  ipcMain.handle(IPC_CHANNELS.IMPORT_QUEUE, (_event: IpcMainInvokeEvent, json: string) => {
    validateString(json, "json");
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > IMPORT_QUEUE_MAX_BYTES) {
      throw new Error(`Queue-Import zu groß (max ${IMPORT_QUEUE_MAX_BYTES} Bytes)`);
    }
    return controller.importQueue(json);
  });
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
  ipcMain.handle(IPC_CHANNELS.GET_SESSION_STATS, () => controller.getSessionStats());

  ipcMain.handle(IPC_CHANNELS.RESTART, () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle(IPC_CHANNELS.QUIT, () => {
    app.quit();
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_BACKUP, async () => {
    const options = {
      defaultPath: `mdd-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "Backup", extensions: ["json"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }
    const json = controller.exportBackup();
    await fs.promises.writeFile(result.filePath, json, "utf8");
    return { saved: true };
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_LOG, async () => {
    const logPath = getLogFilePath();
    await shell.openPath(logPath);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_SESSION_LOG, async () => {
    const logPath = controller.getSessionLogPath();
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.IMPORT_BACKUP, async () => {
    const options = {
      properties: ["openFile"] as Array<"openFile">,
      filters: [
        { name: "Backup", extensions: ["json"] },
        { name: "Alle Dateien", extensions: ["*"] }
      ]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { restored: false, message: "Abgebrochen" };
    }
    const filePath = result.filePaths[0];
    const json = await fs.promises.readFile(filePath, "utf8");
    return controller.importBackup(json);
  });

  controller.onState = (snapshot) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IPC_CHANNELS.STATE_UPDATE, snapshot);
  };
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  registerIpcHandlers();
  mainWindow = createWindow();
  bindMainWindowLifecycle(mainWindow);
  updateClipboardWatcher();
  updateTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      bindMainWindowLifecycle(mainWindow);
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
