import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, IpcMainInvokeEvent, Menu, shell, Tray } from "electron";
import { AddLinksPayload, AppSettings, DebridProvider, EnableRemoteDiagnosticsInput, UpdateInstallProgress } from "../shared/types";
import { AppController } from "./app-controller";
import { IPC_CHANNELS } from "../shared/ipc";
import { getLogFilePath, logger } from "./logger";
import { getRecentErrors } from "./error-ring";
import { sendNotification } from "./notify";
import { APP_NAME } from "./constants";
import { extractHttpLinksFromText } from "./utils";
import { cleanupStaleSubstDrives, shutdownDaemon } from "./extractor";

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
const RESETTABLE_PROVIDER_KEYS = new Set<DebridProvider>([
  "realdebrid",
  "megadebrid-api",
  "megadebrid-web",
  "bestdebrid",
  "alldebrid",
  "ddownload",
  "onefichier",
  "debridlink",
  "linksnappy"
]);
function validateStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
    throw new Error(`${name} muss ein String-Array sein`);
  }
  return value as string[];
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
  process.exit(0);
}

process.on("uncaughtException", (error) => {
  logger.error(`Uncaught Exception: ${String(error?.stack || error)}`);
});
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  logger.error(`Unhandled Rejection: ${detail}`);
});
// Node-Warnungen (z.B. MaxListenersExceeded, DeprecationWarning) sind ein
// Frühindikator für Leaks/Fehlnutzung in einem langlaufenden Server-Prozess.
process.on("warning", (warning) => {
  logger.warn(`Node-Warnung: ${warning.name}: ${warning.message}${warning.stack ? ` | ${warning.stack.replace(/\s*\n\s*/g, " ⏎ ")}` : ""}`);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let clipboardTimer: ReturnType<typeof setInterval> | null = null;
let updateQuitTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledStartTimer: ReturnType<typeof setTimeout> | null = null;
let lastClipboardText = "";
const controller = new AppController();
const CLIPBOARD_MAX_TEXT_CHARS = 50_000;

function isDevMode(): boolean {
  return process.env.NODE_ENV === "development";
}

// Single owner of the scheduled-start timer. startOnPast: a past time entered
// interactively starts right away; at boot a stale past time is cleared instead
// (an unattended auto-start at boot would race autoResumeOnStart's conflict gate).
function armScheduledStart(schedMs: number, opts: { startOnPast: boolean }): void {
  if (scheduledStartTimer !== null) {
    clearTimeout(scheduledStartTimer);
    scheduledStartTimer = null;
  }
  if (!schedMs || schedMs <= 0) {
    return;
  }
  const delay = schedMs - Date.now();
  if (delay <= 0) {
    if (opts.startOnPast) {
      void controller.start().catch((err) => logger.warn(`Scheduled-Start Fehler: ${String(err)}`));
    } else {
      logger.warn(`Geplanter Start (${new Date(schedMs).toLocaleString()}) lag beim App-Start in der Vergangenheit — verworfen`);
    }
    controller.updateSettings({ scheduledStartEpochMs: 0 });
    return;
  }
  scheduledStartTimer = setTimeout(() => {
    scheduledStartTimer = null;
    void controller.start().catch((err) => logger.warn(`Scheduled-Start Fehler: ${String(err)}`));
    controller.updateSettings({ scheduledStartEpochMs: 0 });
  }, delay);
  logger.info(`Geplanter Start gearmt: ${new Date(schedMs).toLocaleString()}`);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.real-debrid.com https://codeberg.org https://bestdebrid.com https://api.alldebrid.com https://www.mega-debrid.eu https://git.24-music.de https://ddownload.com https://ddl.to https://debrid-link.com"
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

let rendererReloadTimes: number[] = [];
const RENDERER_RELOAD_WINDOW_MS = 5 * 60 * 1000;
const RENDERER_RELOAD_MAX = 3;

// Circuit breaker: recover from a one-off renderer crash by reloading, but stop
// after a few crashes in a short window so a reproducible crash can't spin into a
// reload loop that pegs an unattended server.
function allowRendererReload(): boolean {
  const now = Date.now();
  rendererReloadTimes = rendererReloadTimes.filter((t) => now - t < RENDERER_RELOAD_WINDOW_MS);
  if (rendererReloadTimes.length >= RENDERER_RELOAD_MAX) {
    return false;
  }
  rendererReloadTimes.push(now);
  return true;
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

  window.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`Renderer-Prozess beendet: reason=${details.reason} exitCode=${details.exitCode ?? "?"}`);
    if (details.reason === "clean-exit" || window.isDestroyed()) {
      return;
    }
    if (allowRendererReload()) {
      logger.warn("Renderer wird automatisch neu geladen (Wiederherstellung nach Absturz)");
      try {
        window.webContents.reload();
      } catch (error) {
        logger.error(`Renderer-Reload fehlgeschlagen: ${String(error)}`);
      }
    } else {
      logger.error(`Renderer-Absturz: Auto-Reload gestoppt (mehr als ${RENDERER_RELOAD_MAX} Abstürze in ${RENDERER_RELOAD_WINDOW_MS / 60000} Min) - manueller Neustart nötig`);
    }
  });

  // Nur protokollieren, niemals killen/neu laden: "unresponsive" feuert auch
  // während legitimer langer Sync-Arbeit (große JSON-Serialisierung) und erholt
  // sich meist von selbst. Eingreifen würde einen Schluckauf zum Ausfall machen.
  window.webContents.on("unresponsive", () => {
    logger.warn("Renderer reagiert nicht (unresponsive) - evtl. langer Sync-Task, warte auf Erholung");
  });
  window.webContents.on("responsive", () => {
    logger.info("Renderer wieder reaktionsfähig (responsive)");
  });
}

function createTray(): void {
  if (tray) {
    return;
  }
  const iconPath = path.join(app.getAppPath(), "assets", "app_icon.ico");
  try {
    tray = new Tray(iconPath);
  } catch (error) {
    logger.warn(`Tray-Icon konnte nicht erstellt werden (Headless/RDP/Service?): ${String(error)} - Minimize-to-Tray steht nicht zur Verfuegung, Fenster bleibt sichtbar.`);
    return;
  }
  tray.setToolTip(APP_NAME);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Anzeigen", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Start", click: () => { void controller.start().catch((err) => logger.warn(`Tray Start Fehler: ${String(err)}`)); } },
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
    let text: string;
    try {
      text = normalizeClipboardText(clipboard.readText());
    } catch {
      return;
    }
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
      updateQuitTimer = setTimeout(() => {
        app.quit();
      }, 5000);
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
    armScheduledStart(result.scheduledStartEpochMs || 0, { startOnPast: true });
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.RESET_PROVIDER_DAILY_USAGE, (_event: IpcMainInvokeEvent, provider: string) => {
    const validatedProvider = validateString(provider, "provider") as DebridProvider;
    if (!RESETTABLE_PROVIDER_KEYS.has(validatedProvider)) {
      throw new Error("provider ist ungültig");
    }
    return controller.resetProviderDailyUsage(validatedProvider);
  });
  ipcMain.handle(IPC_CHANNELS.RESET_DEBRID_LINK_API_KEY_DAILY_USAGE, (_event: IpcMainInvokeEvent, keyId: string) => {
    const validatedKeyId = validateString(keyId, "keyId").trim();
    if (!validatedKeyId) {
      throw new Error("keyId ist ungültig");
    }
    return controller.resetDebridLinkApiKeyDailyUsage(validatedKeyId);
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
  ipcMain.handle(IPC_CHANNELS.START, () => {
    if (scheduledStartTimer !== null) {
      clearTimeout(scheduledStartTimer);
      scheduledStartTimer = null;
      controller.updateSettings({ scheduledStartEpochMs: 0 });
    }
    return controller.start();
  });
  ipcMain.handle(IPC_CHANNELS.START_PACKAGES, (_event: IpcMainInvokeEvent, packageIds: string[]) => {
    validateStringArray(packageIds ?? [], "packageIds");
    return controller.startPackages(packageIds ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.START_ITEMS, (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    validateStringArray(itemIds ?? [], "itemIds");
    return controller.startItems(itemIds ?? []);
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
  ipcMain.handle(IPC_CHANNELS.EXPORT_PACKAGE_SELECTION, async (_event: IpcMainInvokeEvent, packageIds: string[]) => {
    const validPackageIds = validateStringArray(packageIds ?? [], "packageIds");
    const exported = controller.exportPackageSelection(validPackageIds);
    if (exported.packageCount === 0 || exported.linkCount === 0) {
      return { saved: false, packageCount: 0, linkCount: 0 };
    }
    const options = {
      defaultPath: exported.defaultFileName,
      filters: [{ name: "Link Export", extensions: ["txt"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false, packageCount: exported.packageCount, linkCount: exported.linkCount };
    }
    await fs.promises.writeFile(result.filePath, exported.text, "utf8");
    return { saved: true, packageCount: exported.packageCount, linkCount: exported.linkCount, filePath: result.filePath };
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_ITEM_SELECTION, async (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    const validItemIds = validateStringArray(itemIds ?? [], "itemIds");
    const exported = controller.exportItemSelection(validItemIds);
    if (exported.packageCount === 0 || exported.linkCount === 0) {
      return { saved: false, packageCount: 0, linkCount: 0 };
    }
    const options = {
      defaultPath: exported.defaultFileName,
      filters: [{ name: "Link Export", extensions: ["txt"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false, packageCount: exported.packageCount, linkCount: exported.linkCount };
    }
    await fs.promises.writeFile(result.filePath, exported.text, "utf8");
    return { saved: true, packageCount: exported.packageCount, linkCount: exported.linkCount, filePath: result.filePath };
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
    if (priority !== "high" && priority !== "normal" && priority !== "low") {
      throw new Error("priority muss 'high', 'normal' oder 'low' sein");
    }
    return controller.setPackagePriority(packageId, priority);
  });
  ipcMain.handle(IPC_CHANNELS.SKIP_ITEMS, (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    validateStringArray(itemIds ?? [], "itemIds");
    return controller.skipItems(itemIds ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.RESET_ITEMS, (_event: IpcMainInvokeEvent, itemIds: string[]) => {
    validateStringArray(itemIds ?? [], "itemIds");
    return controller.resetItems(itemIds ?? []);
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
  ipcMain.handle(IPC_CHANNELS.RESET_SESSION_STATS, () => controller.resetSessionStats());
  ipcMain.handle(IPC_CHANNELS.RESET_DOWNLOAD_STATS, () => controller.resetDownloadStats());

  ipcMain.handle(IPC_CHANNELS.RESTART, () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle(IPC_CHANNELS.QUIT, () => {
    app.quit();
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_BACKUP, async () => {
    const options = {
      defaultPath: `mdd-backup-${new Date().toISOString().slice(0, 10)}.mdd`,
      filters: [{ name: "MDD Backup", extensions: ["mdd"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }
    const encrypted = controller.exportBackup();
    await fs.promises.writeFile(result.filePath, encrypted);
    return { saved: true };
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_SUPPORT_BUNDLE, async () => {
    const options = {
      defaultPath: controller.getSupportBundleDefaultFileName(),
      filters: [{ name: "Support Bundle", extensions: ["zip"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }
    const exported = await controller.exportSupportBundle();
    await fs.promises.writeFile(result.filePath, exported.buffer);
    return { saved: true, filePath: result.filePath };
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_LOG, async () => {
    const logPath = getLogFilePath();
    await shell.openPath(logPath);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_AUDIT_LOG, async () => {
    const logPath = controller.getAuditLogPath();
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_RENAME_LOG, async () => {
    const logPath = controller.getRenameLogPath();
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_SESSION_LOG, async () => {
    const logPath = controller.getSessionLogPath();
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_TRACE_LOG, async () => {
    const logPath = controller.getTraceLogPath();
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_PACKAGE_LOG, async (_event: IpcMainInvokeEvent, packageId: string) => {
    validateString(packageId, "packageId");
    const logPath = controller.getPackageLogPath(packageId);
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_DEBUG_SETUP_CHECK, async () => controller.getDebugSetupCheck());

  ipcMain.handle(IPC_CHANNELS.GET_RECENT_ERRORS, async () => getRecentErrors());

  ipcMain.handle(IPC_CHANNELS.TEST_NOTIFY, async (_event: IpcMainInvokeEvent, url: string, mention: string) => {
    validateString(url, "url");
    return sendNotification(url, {
      title: "🔔 Test-Benachrichtigung",
      message: "Webhook funktioniert — Benachrichtigungen kommen hier an.",
      mention: typeof mention === "string" ? mention : ""
    });
  });

  ipcMain.handle(IPC_CHANNELS.GET_TRACE_CONFIG, async () => controller.getTraceConfig());

  ipcMain.handle(IPC_CHANNELS.SET_TRACE_ENABLED, async (_event: IpcMainInvokeEvent, enabled: boolean, note?: string, durationMinutes?: number) => {
    if (typeof enabled !== "boolean") {
      throw new Error("enabled muss ein Boolean sein");
    }
    if (note !== undefined) {
      validateString(note, "note");
    }
    if (durationMinutes !== undefined && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
      throw new Error("durationMinutes muss eine positive Zahl sein");
    }
    return controller.setTraceEnabled(enabled, note, durationMinutes ? durationMinutes * 60 * 1000 : undefined);
  });

  ipcMain.handle(IPC_CHANNELS.ROTATE_DEBUG_TOKEN, async () => {
    const rotated = controller.rotateDebugToken();
    return { path: rotated.path };
  });

  ipcMain.handle(IPC_CHANNELS.GET_REMOTE_DIAGNOSTICS, async () => {
    return controller.getRemoteDiagnostics();
  });

  ipcMain.handle(IPC_CHANNELS.ENABLE_REMOTE_DIAGNOSTICS, async (_event: IpcMainInvokeEvent, input: EnableRemoteDiagnosticsInput) => {
    if (!input || (input.hostMode !== "local" && input.hostMode !== "network")) {
      throw new Error("hostMode muss 'local' oder 'network' sein");
    }
    const allowlist = Array.isArray(input.allowlist) ? input.allowlist.map((entry) => String(entry)) : [];
    return controller.enableRemoteDiagnostics({
      hostMode: input.hostMode,
      publicHost: String(input.publicHost || ""),
      port: input.port ? Number(input.port) : undefined,
      allowlist,
      name: input.name ? String(input.name) : undefined,
      rotateToken: Boolean(input.rotateToken)
    });
  });

  ipcMain.handle(IPC_CHANNELS.DISABLE_REMOTE_DIAGNOSTICS, async () => {
    return controller.disableRemoteDiagnostics();
  });

  ipcMain.handle(IPC_CHANNELS.ROTATE_REMOTE_DIAGNOSTICS_TOKEN, async () => {
    return controller.rotateRemoteDiagnosticsToken();
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_ITEM_LOG, async (_event: IpcMainInvokeEvent, itemId: string) => {
    validateString(itemId, "itemId");
    const logPath = controller.getItemLogPath(itemId);
    if (logPath) {
      await shell.openPath(logPath);
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_REALDEBRID_LOGIN, async () => {
    await controller.openRealDebridLoginWindow();
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_ALLDEBRID_LOGIN, async () => {
    await controller.openAllDebridLoginWindow();
  });

  ipcMain.handle(IPC_CHANNELS.IMPORT_BESTDEBRID_COOKIES, async () => {
    const options = {
      properties: ["openFile"] as Array<"openFile">,
      filters: [
        { name: "Cookie-Datei", extensions: ["txt"] },
        { name: "Alle Dateien", extensions: ["*"] }
      ]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return 0;
    }
    return controller.importBestDebridCookies(result.filePaths[0]);
  });

  ipcMain.handle(IPC_CHANNELS.GET_ALLDEBRID_HOST_INFO, async () => {
    return controller.getAllDebridHostInfo();
  });

  ipcMain.handle(IPC_CHANNELS.GET_DEBRIDLINK_HOST_LIMITS, async () => {
    return controller.getDebridLinkHostLimits();
  });

  ipcMain.handle(IPC_CHANNELS.CHECK_DEBRID_ACCOUNTS, async () => {
    return controller.checkDebridAccounts();
  });

  ipcMain.handle(IPC_CHANNELS.CHECK_MEGA_DEBRID_ACCOUNT, async (_event, login: string, password: string) => {
    return controller.checkSingleMegaDebridAccount(String(login || ""), String(password || ""));
  });

  ipcMain.handle(IPC_CHANNELS.IMPORT_BACKUP, async () => {
    const options = {
      properties: ["openFile"] as Array<"openFile">,
      filters: [
        { name: "MDD Backup", extensions: ["mdd"] },
        { name: "Legacy Backup (JSON)", extensions: ["json"] },
        { name: "Alle Dateien", extensions: ["*"] }
      ]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { restored: false, message: "Abgebrochen" };
    }
    const filePath = result.filePaths[0];
    const stat = await fs.promises.stat(filePath);
    const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
    if (stat.size > BACKUP_MAX_BYTES) {
      return { restored: false, message: `Backup-Datei zu groß (max 50 MB, Datei hat ${(stat.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const data = await fs.promises.readFile(filePath);
    const importResult = controller.importBackup(data);
    // Only a full restore (queue swapped) needs the auto-relaunch. A settings-
    // only import applied live — relaunching would be pointless and would drop
    // the running queue.
    if (importResult.restored && importResult.relaunch) {
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 1500);
    }
    return importResult;
  });

  ipcMain.on(IPC_CHANNELS.LOG_RENDERER_ERROR, (_event, rawReport: unknown) => {
    try {
      logger.error(formatRendererErrorReport(rawReport));
    } catch (error) {
      logger.error(`[Renderer] Fehlerbericht konnte nicht verarbeitet werden: ${String(error)}`);
    }
  });

  controller.onState = (snapshot) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(IPC_CHANNELS.STATE_UPDATE, snapshot);
  };
}

function formatRendererErrorReport(rawReport: unknown): string {
  const report = (rawReport && typeof rawReport === "object" ? rawReport : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const num = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "");
  const kind = str(report.kind) || "error";
  const message = (str(report.message) || "(ohne Nachricht)").slice(0, 2000);
  const source = str(report.source);
  const line = num(report.line);
  const column = num(report.column);
  const stack = str(report.stack).slice(0, 4000);
  const componentStack = str(report.componentStack).slice(0, 4000);

  const parts: string[] = [`[Renderer:${kind}] ${message}`];
  if (source) {
    parts.push(`@ ${source}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`);
  }
  if (stack) {
    parts.push(`| stack: ${stack.replace(/\s*\n\s*/g, " ⏎ ")}`);
  }
  if (componentStack) {
    parts.push(`| react: ${componentStack.replace(/\s*\n\s*/g, " ⏎ ")}`);
  }
  return parts.join(" ");
}

app.on("child-process-gone", (_event, details) => {
  const killed = details.reason !== "clean-exit" && details.reason !== "killed";
  const line = `Subprozess beendet: type=${details.type} reason=${details.reason} exitCode=${details.exitCode ?? "?"}${details.name ? ` name=${details.name}` : ""}${details.serviceName ? ` service=${details.serviceName}` : ""}`;
  if (killed) {
    logger.error(line);
  } else {
    logger.warn(line);
  }
});

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
  cleanupStaleSubstDrives();
  registerIpcHandlers();
  mainWindow = createWindow();
  bindMainWindowLifecycle(mainWindow);
  updateClipboardWatcher();
  updateTray();
  // A scheduled start persists in the settings but its timer lived only in this
  // process — without re-arming it here, any restart (auto-update, reboot,
  // crash) silently swallowed the planned run.
  armScheduledStart(controller.getSettings().scheduledStartEpochMs || 0, { startOnPast: false });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      bindMainWindowLifecycle(mainWindow);
    }
  });
}).catch((error) => {
  console.error("App startup failed:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (updateQuitTimer) { clearTimeout(updateQuitTimer); updateQuitTimer = null; }
  stopClipboardWatcher();
  destroyTray();
  shutdownDaemon();
  try {
    controller.shutdown();
  } catch (error) {
    logger.error(`Fehler beim Shutdown: ${String(error)}`);
  }
});
