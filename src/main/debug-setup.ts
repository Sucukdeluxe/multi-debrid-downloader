import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getSessionLogPath } from "./session-log";
import { createStoragePaths, loadSettings } from "./storage";
import type {
  DebugSetupCheckResult,
  SupportBundleEstimate,
  SupportDirectorySizeInfo,
  SupportDiskSpaceInfo,
  SupportFileSizeInfo,
  SupportTraceConfig
} from "../shared/types";

const DEFAULT_PORT = 9868;
const DEFAULT_HOST = "127.0.0.1";
const AI_MANIFEST_FILE = "debug_ai_manifest.json";
const LOW_FREE_BYTES_THRESHOLD = Number(process.env.RD_SELF_CHECK_LOW_FREE_BYTES || 20 * 1024 * 1024 * 1024);
const LOW_FREE_PERCENT_THRESHOLD = Number(process.env.RD_SELF_CHECK_LOW_FREE_PERCENT || 5);
const LOW_FREE_PERCENT_BYTES_GUARD = Number(process.env.RD_SELF_CHECK_LOW_FREE_PERCENT_BYTES_GUARD || 50 * 1024 * 1024 * 1024);
const LARGE_LOG_BYTES_THRESHOLD = Number(process.env.RD_SELF_CHECK_LARGE_LOG_BYTES || 250 * 1024 * 1024);
const LARGE_BUNDLE_BYTES_THRESHOLD = Number(process.env.RD_SELF_CHECK_LARGE_BUNDLE_BYTES || 150 * 1024 * 1024);
const BUNDLE_OVERVIEW_SLACK_BYTES = 256 * 1024;

function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readToken(baseDir: string): string {
  try {
    return fs.readFileSync(path.join(baseDir, "debug_token.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

function readPort(baseDir: string): number {
  try {
    const raw = Number(fs.readFileSync(path.join(baseDir, "debug_port.txt"), "utf8").trim());
    if (Number.isFinite(raw) && raw >= 1024 && raw <= 65535) {
      return raw;
    }
  } catch {
    // ignore
  }
  return DEFAULT_PORT;
}

function readHost(baseDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(baseDir, "debug_host.txt"), "utf8").trim();
    if (!raw) {
      return DEFAULT_HOST;
    }
    if (/^(localhost|0\.0\.0\.0|127\.0\.0\.1|::1)$/i.test(raw)) {
      return raw;
    }
    if (/^[a-z0-9.-]+$/i.test(raw)) {
      return raw;
    }
  } catch {
    // ignore
  }
  return DEFAULT_HOST;
}

function readTraceConfig(baseDir: string): SupportTraceConfig {
  const fallback: SupportTraceConfig = {
    enabled: false,
    includeMainLog: true,
    includeAudit: true,
    logDebugRequests: true,
    autoDisableAt: null,
    updatedAt: new Date(0).toISOString()
  };
  try {
    const filePath = path.join(baseDir, "trace_config.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SupportTraceConfig>;
    return {
      enabled: Boolean(parsed.enabled),
      includeMainLog: parsed.includeMainLog === undefined ? true : Boolean(parsed.includeMainLog),
      includeAudit: parsed.includeAudit === undefined ? true : Boolean(parsed.includeAudit),
      logDebugRequests: parsed.logDebugRequests === undefined ? true : Boolean(parsed.logDebugRequests),
      autoDisableAt: typeof parsed.autoDisableAt === "string" && parsed.autoDisableAt.trim() ? parsed.autoDisableAt : null,
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : fallback.updatedAt
    };
  } catch {
    return fallback;
  }
}

function getFileSizeInfo(filePath: string | null): SupportFileSizeInfo {
  if (!filePath) {
    return { path: null, exists: false, bytes: 0 };
  }
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      bytes: stat.size
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      bytes: 0
    };
  }
}

function getDirectorySizeInfo(dirPath: string, skipPath?: string | null): SupportDirectorySizeInfo {
  if (!fs.existsSync(dirPath)) {
    return {
      path: dirPath,
      exists: false,
      fileCount: 0,
      bytes: 0
    };
  }

  let bytes = 0;
  let fileCount = 0;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (skipPath && path.resolve(fullPath) === path.resolve(skipPath)) {
        continue;
      }
      try {
        bytes += fs.statSync(fullPath).size;
        fileCount += 1;
      } catch {
        // ignore unreadable files
      }
    }
  }

  return {
    path: dirPath,
    exists: true,
    fileCount,
    bytes
  };
}

function resolveExistingPath(targetPath: string): string {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

function getWindowsDiskSpaceInfo(existingPath: string): SupportDiskSpaceInfo | null {
  if (process.platform !== "win32") {
    return null;
  }
  const root = path.parse(existingPath).root.replace(/[\\/]+$/g, "");
  const driveName = root.replace(":", "");
  if (!/^[A-Za-z]$/.test(driveName)) {
    return null;
  }
  try {
    const raw = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$drive = Get-PSDrive -Name '${driveName}'; if ($drive) { [pscustomobject]@{ FreeSpace = [int64]$drive.Free; Size = [int64]($drive.Used + $drive.Free) } | ConvertTo-Json -Compress }`
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      }
    ).trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { FreeSpace?: number | string; Size?: number | string };
    const totalBytes = Number(parsed.Size);
    const freeBytes = Number(parsed.FreeSpace);
    const freePercent = Number.isFinite(totalBytes) && totalBytes > 0
      ? Math.round((freeBytes / totalBytes) * 1000) / 10
      : null;
    return {
      path: existingPath,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
      freePercent
    };
  } catch {
    return null;
  }
}

function getDiskSpaceInfo(targetPath: string): SupportDiskSpaceInfo {
  const existingPath = resolveExistingPath(targetPath);
  try {
    const stat = fs.statfsSync(existingPath);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const freePercent = totalBytes > 0
      ? Math.round((freeBytes / totalBytes) * 1000) / 10
      : null;
    return {
      path: existingPath,
      totalBytes,
      freeBytes,
      freePercent
    };
  } catch {
    const windowsFallback = getWindowsDiskSpaceInfo(existingPath);
    if (windowsFallback) {
      return windowsFallback;
    }
    return {
      path: existingPath,
      totalBytes: null,
      freeBytes: null,
      freePercent: null
    };
  }
}

function getSupportBundleEstimate(
  baseDir: string,
  logSummary: DebugSetupCheckResult["logSummary"]
): SupportBundleEstimate {
  const storagePaths = createStoragePaths(baseDir);
  const staticFiles = [
    path.join(baseDir, AI_MANIFEST_FILE),
    path.join(baseDir, "debug_host.txt"),
    path.join(baseDir, "debug_port.txt"),
    storagePaths.configFile,
    storagePaths.sessionFile,
    storagePaths.historyFile,
    path.join(baseDir, "trace_config.json")
  ].map((filePath) => getFileSizeInfo(filePath));

  const staticBytes = staticFiles.reduce((sum, entry) => sum + entry.bytes, 0);
  const duplicatedLiveLogBytes = logSummary.session.bytes + logSummary.packageLogs.bytes + logSummary.itemLogs.bytes;
  const estimatedEntries = 10
    + staticFiles.filter((entry) => entry.exists).length
    + Number(logSummary.main.exists)
    + Number(logSummary.mainBackup.exists)
    + Number(logSummary.audit.exists)
    + Number(logSummary.auditBackup.exists)
    + Number(logSummary.session.exists)
    + Number(logSummary.trace.exists)
    + Number(logSummary.traceBackup.exists)
    + logSummary.sessionLogs.fileCount
    + logSummary.packageLogs.fileCount
    + logSummary.itemLogs.fileCount
    + logSummary.packageLogs.fileCount
    + logSummary.itemLogs.fileCount;

  return {
    estimatedBytes: staticBytes + logSummary.totalBytes + duplicatedLiveLogBytes + BUNDLE_OVERVIEW_SLACK_BYTES,
    estimatedEntries,
    duplicatedLiveLogBytes,
    note: "SchÃ¤tzwert vor ZIP-Komprimierung; aktueller Session-Log sowie Live-Paket-/Item-Logs werden im Bundle zusÃ¤tzlich gespiegelt."
  };
}

export function getDebugSetupCheck(baseDir: string): DebugSetupCheckResult {
  const host = readHost(baseDir);
  const port = readPort(baseDir);
  const token = readToken(baseDir);
  const storagePaths = createStoragePaths(baseDir);
  const settings = loadSettings(storagePaths);
  const tokenPath = path.join(baseDir, "debug_token.txt");
  const aiManifestPath = path.join(baseDir, AI_MANIFEST_FILE);
  const traceConfigPath = path.join(baseDir, "trace_config.json");
  const traceLogPath = path.join(baseDir, "trace.log");
  const traceConfig = readTraceConfig(baseDir);
  const sessionLogPath = getSessionLogPath();
  const localOnly = /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
  const warnings: string[] = [];
  const notes: string[] = [];

  const logSummary: DebugSetupCheckResult["logSummary"] = {
    main: getFileSizeInfo(path.join(baseDir, "rd_downloader.log")),
    mainBackup: getFileSizeInfo(path.join(baseDir, "rd_downloader.log.old")),
    audit: getFileSizeInfo(path.join(baseDir, "audit.log")),
    auditBackup: getFileSizeInfo(path.join(baseDir, "audit.log.old")),
    session: getFileSizeInfo(sessionLogPath),
    trace: getFileSizeInfo(traceLogPath),
    traceBackup: getFileSizeInfo(path.join(baseDir, "trace.log.old")),
    sessionLogs: getDirectorySizeInfo(path.join(baseDir, "session-logs"), sessionLogPath),
    packageLogs: getDirectorySizeInfo(path.join(baseDir, "package-logs")),
    itemLogs: getDirectorySizeInfo(path.join(baseDir, "item-logs")),
    totalBytes: 0
  };
  logSummary.totalBytes = [
    logSummary.main.bytes,
    logSummary.mainBackup.bytes,
    logSummary.audit.bytes,
    logSummary.auditBackup.bytes,
    logSummary.session.bytes,
    logSummary.trace.bytes,
    logSummary.traceBackup.bytes,
    logSummary.sessionLogs.bytes,
    logSummary.packageLogs.bytes,
    logSummary.itemLogs.bytes
  ].reduce((sum, value) => sum + value, 0);

  const diskSpace: DebugSetupCheckResult["diskSpace"] = {
    runtime: getDiskSpaceInfo(baseDir),
    output: getDiskSpaceInfo(settings.outputDir),
    extract: getDiskSpaceInfo(settings.extractDir)
  };
  const supportBundle = getSupportBundleEstimate(baseDir, logSummary);

  if (!token) {
    warnings.push("debug_token.txt fehlt oder ist leer. Der Debug-Server startet dann nicht.");
  }
  if (localOnly) {
    warnings.push("Der Debug-Server ist aktuell nur lokal erreichbar. FÃ¼r Remote-Support debug_host.txt auf 0.0.0.0 setzen.");
  } else {
    notes.push("Der Debug-Server ist fÃ¼r Remote-Zugriff konfiguriert. Firewall oder Provider-Regeln mÃ¼ssen separat offen sein.");
  }
  if (!fs.existsSync(aiManifestPath)) {
    warnings.push("debug_ai_manifest.json fehlt. App einmal neu starten, damit die KI-Support-Datei neu geschrieben wird.");
  }
  if (!fs.existsSync(traceConfigPath)) {
    warnings.push("trace_config.json fehlt. Trace-Funktionen sind lokal noch nicht initialisiert.");
  }
  if (traceConfig.enabled && !traceConfig.autoDisableAt) {
    warnings.push("Support-Trace ist aktiv ohne automatische Abschaltzeit. Einmal neu aktivieren, damit die 2-Stunden-Begrenzung gesetzt wird.");
  }
  if (traceConfig.enabled && traceConfig.autoDisableAt) {
    notes.push(`Support-Trace aktiv bis ${traceConfig.autoDisableAt}.`);
  }

  for (const entry of [
    { label: "Runtime", info: diskSpace.runtime },
    { label: "Download-Ziel", info: diskSpace.output },
    { label: "Entpack-Ziel", info: diskSpace.extract }
  ]) {
    if (entry.info.freeBytes === null || entry.info.totalBytes === null) {
      warnings.push(`${entry.label}: Freier Speicherplatz konnte nicht gelesen werden (${entry.info.path}).`);
      continue;
    }
    const lowByAbsolute = entry.info.freeBytes < LOW_FREE_BYTES_THRESHOLD;
    const lowByPercent = entry.info.freePercent !== null
      && entry.info.freePercent < LOW_FREE_PERCENT_THRESHOLD
      && entry.info.freeBytes < LOW_FREE_PERCENT_BYTES_GUARD;
    if (lowByAbsolute || lowByPercent) {
      warnings.push(`${entry.label}: wenig freier Speicherplatz (${formatByteCount(entry.info.freeBytes)} frei auf ${entry.info.path}).`);
    }
  }

  if (logSummary.totalBytes >= LARGE_LOG_BYTES_THRESHOLD) {
    warnings.push(`Support-Logs sind bereits recht groÃŸ (${formatByteCount(logSummary.totalBytes)}). Rotation greift, aber ein Bundle wird entsprechend umfangreicher.`);
  } else {
    notes.push(`Aktuelle Support-Logmenge: ${formatByteCount(logSummary.totalBytes)}.`);
  }

  if (supportBundle.estimatedBytes >= LARGE_BUNDLE_BYTES_THRESHOLD) {
    warnings.push(`Support-Bundle wird voraussichtlich groÃŸ (${formatByteCount(supportBundle.estimatedBytes)} vor ZIP-Komprimierung).`);
  } else {
    notes.push(`Support-Bundle-SchÃ¤tzung: etwa ${formatByteCount(supportBundle.estimatedBytes)}.`);
  }

  notes.push("Die App kann Netzwerk-Firewalls oder Provider-Sicherheitsgruppen nicht direkt prÃ¼fen.");

  return {
    status: warnings.length > 0 ? "warn" : "ok",
    enabled: Boolean(token),
    runtimeBaseDir: baseDir,
    host,
    port,
    localOnly,
    tokenConfigured: Boolean(token),
    tokenPath,
    aiManifestPath,
    aiManifestPresent: fs.existsSync(aiManifestPath),
    traceConfigPath: fs.existsSync(traceConfigPath) ? traceConfigPath : null,
    traceLogPath: fs.existsSync(traceLogPath) ? traceLogPath : null,
    traceEnabled: traceConfig.enabled,
    traceAutoDisableAt: traceConfig.autoDisableAt,
    diskSpace,
    logSummary,
    supportBundle,
    warnings,
    notes,
    localUrls: {
      health: `http://127.0.0.1:${port}/health?token=${token || "<TOKEN>"}`,
      meta: `http://127.0.0.1:${port}/meta?token=${token || "<TOKEN>"}`,
      diagnostics: `http://127.0.0.1:${port}/diagnostics?token=${token || "<TOKEN>"}`
    },
    remoteUrlTemplates: {
      health: `http://<SERVER_IP_OR_DNS>:${port}/health?token=${token || "<TOKEN>"}`,
      meta: `http://<SERVER_IP_OR_DNS>:${port}/meta?token=${token || "<TOKEN>"}`,
      diagnostics: `http://<SERVER_IP_OR_DNS>:${port}/diagnostics?token=${token || "<TOKEN>"}`
    }
  };
}
