import { promises as fsp } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { APP_VERSION } from "./constants";
import { getAccountRotationLogPath } from "./account-rotation-log";
import { getConversionLogPath } from "./conversion-trace";
import { getAuditLogPath } from "./audit-log";
import { getDebugSetupCheck } from "./debug-setup";
import { getLogFilePath } from "./logger";
import { getRecentErrors } from "./error-ring";
import { getPackageLogPath } from "./package-log";
import { getRenameLogPath } from "./rename-log";
import { getDesktopRenameLogPath } from "./desktop-rename-log";
import { getSessionLogPath } from "./session-log";
import { createStoragePaths, loadHistory, loadSettings } from "./storage";
import { buildAccountSummary, buildRedactedSettingsPayload, buildStatsPayload, summarizeHistoryEntry } from "./support-data";
import { getTraceConfig, getTraceConfigPath, getTraceLogPath } from "./trace-log";
import { getCachedWindowsHostDiagnostics, getWindowsHostDiagnostics } from "./windows-host-diagnostics";
import type { DownloadManager } from "./download-manager";

const AI_MANIFEST_FILE = "debug_ai_manifest.json";

async function safeReadJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function addJson(zip: AdmZip, zipPath: string, value: unknown): void {
  zip.addFile(zipPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function addFileIfExists(zip: AdmZip, sourcePath: string | null, zipPath: string): Promise<void> {
  if (!sourcePath) {
    return;
  }
  try {
    const buffer = await fsp.readFile(sourcePath);
    zip.addFile(zipPath, buffer);
  } catch {
  }
}

async function addDirectoryIfExists(zip: AdmZip, dirPath: string, zipRoot: string): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = path.posix.join(zipRoot, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryIfExists(zip, fullPath, zipPath);
      continue;
    }
    await addFileIfExists(zip, fullPath, zipPath);
  }
}

async function addRecentDirectoryFiles(zip: AdmZip, dirPath: string, zipRoot: string, maxAgeMs: number): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let added = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      if ((await fsp.stat(fullPath)).mtimeMs >= cutoff) {
        await addFileIfExists(zip, fullPath, path.posix.join(zipRoot, entry.name));
        added += 1;
      }
    } catch {  }
  }
  return added;
}

function formatTimestampForFileName(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
}

export function getSupportBundleDefaultFileName(): string {
  return `rd-support-bundle-${formatTimestampForFileName(new Date())}.zip`;
}

type HostDiagnosticsMode = "full" | "cached" | "none";

interface BuildSupportBundleOptions {
  hostDiagnosticsMode?: HostDiagnosticsMode;
}

function createDeferredHostDiagnostics(reason: string): unknown {
  return {
    collectedAt: new Date().toISOString(),
    supported: process.platform === "win32",
    platform: process.platform,
    crashControl: null,
    recentKernelPower: [],
    recentWerKernel: [],
    recentKernelDump: [],
    recentAppCrashes: [],
    recentMinidumps: [],
    assessmentHints: [
      reason
    ],
    errors: []
  };
}

function resolveHostDiagnostics(mode: HostDiagnosticsMode): unknown {
  if (mode === "none") {
    return createDeferredHostDiagnostics("Host-Diagnose wurde fuer diesen Bundle-Export deaktiviert.");
  }
  if (mode === "cached") {
    const cached = getCachedWindowsHostDiagnostics();
    if (cached) {
      return cached;
    }
    return createDeferredHostDiagnostics("Host-Diagnose wurde uebersprungen, um den Export nicht zu blockieren. Fuer eine Voll-Diagnose /host/diagnostics nutzen.");
  }
  return getWindowsHostDiagnostics();
}

export async function buildSupportBundle(manager: DownloadManager, baseDir: string, options: BuildSupportBundleOptions = {}): Promise<Buffer> {
  const zip = new AdmZip();
  const hostDiagnosticsMode = options.hostDiagnosticsMode || "full";
  const storagePaths = createStoragePaths(baseDir);
  const settings = loadSettings(storagePaths);
  const history = loadHistory(storagePaths);
  const snapshot = manager.getSnapshot();
  const packageIds = Object.keys(snapshot.session.packages);
  const itemIds = Object.keys(snapshot.session.items);
  const debugSetup = getDebugSetupCheck(baseDir);

  addJson(zip, "overview/meta.json", {
    appVersion: APP_VERSION,
    generatedAt: new Date().toISOString(),
    runtimeBaseDir: baseDir,
    packageCount: packageIds.length,
    itemCount: itemIds.length
  });
  addJson(zip, "overview/status.json", snapshot.session);
  addJson(zip, "overview/settings.json", buildRedactedSettingsPayload(settings));
  addJson(zip, "overview/accounts.json", buildAccountSummary(settings));
  addJson(zip, "overview/stats.json", {
    ...buildStatsPayload(snapshot),
    allTime: {
      totalDownloadedAllTime: settings.totalDownloadedAllTime,
      totalCompletedFilesAllTime: settings.totalCompletedFilesAllTime,
      totalRuntimeAllTimeMs: settings.totalRuntimeAllTimeMs
    }
  });
  addJson(zip, "overview/debug-setup.json", debugSetup);
  addJson(zip, "overview/self-check.json", debugSetup);
  addJson(zip, "overview/history.json", {
    total: history.length,
    entries: history.map((entry) => summarizeHistoryEntry(entry))
  });
  addJson(zip, "overview/packages.json", {
    count: packageIds.length,
    packages: packageIds.map((packageId) => snapshot.session.packages[packageId]).filter(Boolean)
  });
  addJson(zip, "overview/items.json", {
    count: itemIds.length,
    items: itemIds.map((itemId) => snapshot.session.items[itemId]).filter(Boolean)
  });
  addJson(zip, "overview/host-diagnostics.json", resolveHostDiagnostics(hostDiagnosticsMode));
  addJson(zip, "overview/trace-config.json", getTraceConfig());
  const recentErrors = getRecentErrors();
  addJson(zip, "overview/recent-errors.json", { count: recentErrors.length, entries: recentErrors });

  await addFileIfExists(zip, path.join(baseDir, AI_MANIFEST_FILE), `runtime/${AI_MANIFEST_FILE}`);
  await addFileIfExists(zip, path.join(baseDir, "debug_host.txt"), "runtime/debug_host.txt");
  await addFileIfExists(zip, path.join(baseDir, "debug_port.txt"), "runtime/debug_port.txt");
  await addFileIfExists(zip, getTraceConfigPath(), "runtime/trace_config.json");

  await addFileIfExists(zip, getLogFilePath(), "logs/rd_downloader.log");
  await addFileIfExists(zip, `${getLogFilePath()}.old`, "logs/rd_downloader.log.old");
  await addFileIfExists(zip, getAuditLogPath(), "logs/audit.log");
  await addFileIfExists(zip, getAuditLogPath() ? `${getAuditLogPath()}.old` : null, "logs/audit.log.old");
  await addFileIfExists(zip, getRenameLogPath(), "logs/rename.log");
  await addFileIfExists(zip, getRenameLogPath() ? `${getRenameLogPath()}.old` : null, "logs/rename.log.old");
  await addFileIfExists(zip, getDesktopRenameLogPath(), "logs/rename-session-desktop.txt");
  await addFileIfExists(zip, getSessionLogPath(), "logs/session.log");
  await addFileIfExists(zip, getTraceLogPath(), "logs/trace.log");
  await addFileIfExists(zip, getTraceLogPath() ? `${getTraceLogPath()}.old` : null, "logs/trace.log.old");
  await addFileIfExists(zip, getAccountRotationLogPath(), "logs/account-rotation.log");
  await addFileIfExists(zip, getAccountRotationLogPath() ? `${getAccountRotationLogPath()}.old` : null, "logs/account-rotation.log.old");
  await addFileIfExists(zip, getConversionLogPath(), "logs/conversion.log");
  await addFileIfExists(zip, getConversionLogPath() ? `${getConversionLogPath()}.old` : null, "logs/conversion.log.old");

  const SUPPORT_BUNDLE_LOG_WINDOW_MS = 8 * 60 * 60 * 1000;
  await addDirectoryIfExists(zip, path.join(baseDir, "session-logs"), "logs/session-logs");
  await addRecentDirectoryFiles(zip, path.join(baseDir, "package-logs"), "logs/package-logs", SUPPORT_BUNDLE_LOG_WINDOW_MS);
  await addRecentDirectoryFiles(zip, path.join(baseDir, "item-logs"), "logs/item-logs", SUPPORT_BUNDLE_LOG_WINDOW_MS);

  for (const packageId of packageIds) {
    await addFileIfExists(zip, manager.getPackageLogPath(packageId) || getPackageLogPath(packageId), `logs/live/package-${packageId}.txt`);
  }
  for (const itemId of itemIds) {
    await addFileIfExists(zip, manager.getItemLogPath(itemId), `logs/live/item-${itemId}.txt`);
  }

  const aiManifest = await safeReadJson(path.join(baseDir, AI_MANIFEST_FILE));
  if (aiManifest) {
    addJson(zip, "overview/ai-manifest.json", aiManifest);
  }

  return zip.toBuffer();
}
