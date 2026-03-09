import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "./constants";
import { logger, getLogFilePath } from "./logger";
import { getItemLogPath as getPersistedItemLogPath } from "./item-log";
import { getSessionLogPath } from "./session-log";
import { getPackageLogPath as getPersistedPackageLogPath } from "./package-log";
import { getWindowsHostDiagnostics } from "./windows-host-diagnostics";
import type { DownloadManager } from "./download-manager";
import type { DownloadItem, PackageEntry, UiSnapshot } from "../shared/types";

const DEFAULT_PORT = 9868;
const DEFAULT_HOST = "127.0.0.1";
const MAX_LOG_LINES = 10000;

let server: http.Server | null = null;
let manager: DownloadManager | null = null;
let authToken = "";
let bindHost = DEFAULT_HOST;
let bindPort = DEFAULT_PORT;
let runtimeBaseDir = "";

function loadToken(baseDir: string): string {
  const tokenPath = path.join(baseDir, "debug_token.txt");
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

function getPort(baseDir: string): number {
  const portPath = path.join(baseDir, "debug_port.txt");
  try {
    const n = Number(fs.readFileSync(portPath, "utf8").trim());
    if (Number.isFinite(n) && n >= 1024 && n <= 65535) {
      return n;
    }
  } catch {
    // ignore
  }
  return DEFAULT_PORT;
}

function getHost(baseDir: string): string {
  const hostPath = path.join(baseDir, "debug_host.txt");
  try {
    const raw = fs.readFileSync(hostPath, "utf8").trim();
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

function checkAuth(req: http.IncomingMessage): boolean {
  if (!authToken) {
    return false;
  }
  const header = req.headers.authorization || "";
  if (header === `Bearer ${authToken}`) {
    return true;
  }
  const url = new URL(req.url || "/", "http://localhost");
  return url.searchParams.get("token") === authToken;
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache"
  });
  res.end(body);
}

function normalizeLinesParam(rawValue: string | null, fallback: number): number {
  const parsed = Number(rawValue || String(fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(parsed), MAX_LOG_LINES));
}

function readLogTailFromFile(filePath: string | null, lines: number): string[] {
  if (!filePath) {
    return ["(Log-Datei nicht gefunden)"];
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const allLines = content.split("\n").filter((l) => l.trim().length > 0);
    return allLines.slice(-Math.min(lines, MAX_LOG_LINES));
  } catch {
    return ["(Log-Datei nicht lesbar)"];
  }
}

function filterLines(lines: string[], grep: string): string[] {
  const pattern = String(grep || "").trim().toLowerCase();
  if (!pattern) {
    return lines;
  }
  return lines.filter((line) => line.toLowerCase().includes(pattern));
}

function summarizeItem(item: DownloadItem): Record<string, unknown> {
  return {
    id: item.id,
    packageId: item.packageId,
    fileName: item.fileName,
    status: item.status,
    fullStatus: item.fullStatus,
    provider: item.provider,
    providerLabel: item.providerLabel || "",
    progress: item.progressPercent,
    speedMBs: +(item.speedBps / 1024 / 1024).toFixed(2),
    downloadedMB: +(item.downloadedBytes / 1024 / 1024).toFixed(1),
    totalMB: item.totalBytes ? +(item.totalBytes / 1024 / 1024).toFixed(1) : null,
    retries: item.retries,
    lastError: item.lastError,
    targetPath: item.targetPath,
    updatedAt: item.updatedAt
  };
}

function summarizePackage(snapshot: UiSnapshot, pkg: PackageEntry, includeItems: boolean): Record<string, unknown> {
  const ids = new Set(pkg.itemIds);
  const packageItems = Object.values(snapshot.session.items).filter((item) => ids.has(item.id));
  const byStatus: Record<string, number> = {};
  for (const item of packageItems) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  }
  return {
    id: pkg.id,
    name: pkg.name,
    status: pkg.status,
    enabled: pkg.enabled,
    cancelled: pkg.cancelled,
    outputDir: pkg.outputDir,
    extractDir: pkg.extractDir,
    postProcessLabel: pkg.postProcessLabel || "",
    itemCount: pkg.itemIds.length,
    itemCounts: byStatus,
    updatedAt: pkg.updatedAt,
    items: includeItems ? packageItems.map((item) => summarizeItem(item)) : undefined
  };
}

function findPackage(snapshot: UiSnapshot, query: string): PackageEntry | null {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return null;
  }
  return Object.values(snapshot.session.packages).find((pkg) =>
    pkg.id.toLowerCase() === needle || pkg.name.toLowerCase().includes(needle)
  ) || null;
}

function findItem(snapshot: UiSnapshot, query: string): DownloadItem | null {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return null;
  }
  return Object.values(snapshot.session.items).find((item) =>
    item.id.toLowerCase() === needle || item.fileName.toLowerCase().includes(needle)
  ) || null;
}

function getPackageLogPathForQuery(snapshot: UiSnapshot, query: string): { pkg: PackageEntry | null; logPath: string | null } {
  const pkg = findPackage(snapshot, query);
  if (pkg) {
    const livePath = manager?.getPackageLogPath(pkg.id) || null;
    return { pkg, logPath: livePath || getPersistedPackageLogPath(pkg.id) };
  }
  const directPath = getPersistedPackageLogPath(String(query || "").trim());
  return { pkg: null, logPath: directPath };
}

function getItemLogPathForQuery(snapshot: UiSnapshot, query: string): { item: DownloadItem | null; logPath: string | null } {
  const item = findItem(snapshot, query);
  if (item) {
    const livePath = manager?.getItemLogPath(item.id) || null;
    return { item, logPath: livePath || getPersistedItemLogPath(item.id) };
  }
  const directPath = getPersistedItemLogPath(String(query || "").trim());
  return { item: null, logPath: directPath };
}

function buildStatusPayload(snapshot: UiSnapshot): Record<string, unknown> {
  const items = Object.values(snapshot.session.items);
  const packages = Object.values(snapshot.session.packages);

  const byStatus: Record<string, number> = {};
  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  }

  const activeItems = items
    .filter((item) => item.status === "downloading" || item.status === "validating")
    .map((item) => summarizeItem(item));

  const failedItems = items
    .filter((item) => item.status === "failed")
    .map((item) => summarizeItem(item));

  return {
    running: snapshot.session.running,
    paused: snapshot.session.paused,
    speed: snapshot.speedText,
    eta: snapshot.etaText,
    itemCounts: byStatus,
    totalItems: items.length,
    totalPackages: packages.length,
    packages: packages.map((pkg) => summarizePackage(snapshot, pkg, false)),
    activeItems,
    failedItems: failedItems.length > 0 ? failedItems : undefined
  };
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Allow-Methods": "GET,OPTIONS"
    });
    res.end();
    return;
  }

  if (!checkAuth(req)) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/health") {
    jsonResponse(res, 200, {
      status: "ok",
      appVersion: APP_VERSION,
      uptime: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
    return;
  }

  if (pathname === "/meta") {
    jsonResponse(res, 200, {
      appVersion: APP_VERSION,
      runtimeBaseDir,
      debugServer: {
        host: bindHost,
        port: bindPort
      },
      logPaths: {
        main: getLogFilePath(),
        session: getSessionLogPath()
      },
      endpoints: [
        "GET /health",
        "GET /meta",
        "GET /host/diagnostics",
        "GET /log?lines=100&grep=keyword",
        "GET /logs/main?lines=100&grep=keyword",
        "GET /logs/session?lines=100&grep=keyword",
        "GET /logs/package?package=Release&lines=100&grep=keyword",
        "GET /logs/item?item=episode.part2.rar&lines=100&grep=keyword",
        "GET /status",
        "GET /packages?package=Release&includeItems=1",
        "GET /items?status=downloading&package=Release",
        "GET /session?package=Release",
        "GET /diagnostics?package=Release&lines=150"
      ]
    });
    return;
  }

  if (pathname === "/host/diagnostics") {
    jsonResponse(res, 200, getWindowsHostDiagnostics());
    return;
  }

  if (pathname === "/log" || pathname === "/logs/main") {
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const lines = filterLines(readLogTailFromFile(getLogFilePath(), count), grep);
    jsonResponse(res, 200, { lines, count: lines.length });
    return;
  }

  if (pathname === "/logs/session") {
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const logPath = getSessionLogPath();
    const lines = filterLines(readLogTailFromFile(logPath, count), grep);
    jsonResponse(res, 200, {
      path: logPath,
      lines,
      count: lines.length
    });
    return;
  }

  if (pathname === "/logs/package") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const packageQuery = url.searchParams.get("package") || url.searchParams.get("packageId") || "";
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const resolved = getPackageLogPathForQuery(snapshot, packageQuery);
    if (!resolved.logPath) {
      jsonResponse(res, 404, { error: "Package log not found", package: packageQuery });
      return;
    }
    const lines = filterLines(readLogTailFromFile(resolved.logPath, count), grep);
    jsonResponse(res, 200, {
      package: resolved.pkg ? summarizePackage(snapshot, resolved.pkg, false) : undefined,
      path: resolved.logPath,
      lines,
      count: lines.length
    });
    return;
  }

  if (pathname === "/logs/item") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const itemQuery = url.searchParams.get("item") || url.searchParams.get("itemId") || "";
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const resolved = getItemLogPathForQuery(snapshot, itemQuery);
    if (!resolved.logPath) {
      jsonResponse(res, 404, { error: "Item log not found", item: itemQuery });
      return;
    }
    const lines = filterLines(readLogTailFromFile(resolved.logPath, count), grep);
    jsonResponse(res, 200, {
      item: resolved.item ? summarizeItem(resolved.item) : undefined,
      path: resolved.logPath,
      lines,
      count: lines.length
    });
    return;
  }

  if (pathname === "/status") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    jsonResponse(res, 200, buildStatusPayload(snapshot));
    return;
  }

  if (pathname === "/packages") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const packageQuery = url.searchParams.get("package") || "";
    const includeItems = /^(1|true|yes)$/i.test(String(url.searchParams.get("includeItems") || ""));
    let packages = Object.values(snapshot.session.packages);
    if (packageQuery) {
      const needle = packageQuery.toLowerCase();
      packages = packages.filter((pkg) => pkg.id.toLowerCase() === needle || pkg.name.toLowerCase().includes(needle));
    }
    jsonResponse(res, 200, {
      count: packages.length,
      packages: packages.map((pkg) => summarizePackage(snapshot, pkg, includeItems))
    });
    return;
  }

  if (pathname === "/items") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const filter = url.searchParams.get("status");
    const pkg = url.searchParams.get("package");
    let items = Object.values(snapshot.session.items);
    if (filter) {
      items = items.filter((i) => i.status === filter);
    }
    if (pkg) {
      const matchedPkg = findPackage(snapshot, pkg);
      if (matchedPkg) {
        const ids = new Set(matchedPkg.itemIds);
        items = items.filter((i) => ids.has(i.id));
      }
    }
    jsonResponse(res, 200, {
      count: items.length,
      items: items.map((i) => summarizeItem(i))
    });
    return;
  }

  if (pathname === "/session") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const pkg = url.searchParams.get("package");
    if (pkg) {
      const matchedPkg = findPackage(snapshot, pkg);
      if (matchedPkg) {
        const ids = new Set(matchedPkg.itemIds);
        const pkgItems = Object.values(snapshot.session.items)
          .filter((i) => ids.has(i.id));
        jsonResponse(res, 200, {
          package: summarizePackage(snapshot, matchedPkg, false),
          items: pkgItems.map((item) => summarizeItem(item))
        });
        return;
      }
    }
    jsonResponse(res, 200, {
      running: snapshot.session.running,
      paused: snapshot.session.paused,
      packageCount: Object.keys(snapshot.session.packages).length,
      itemCount: Object.keys(snapshot.session.items).length,
      packages: Object.values(snapshot.session.packages).map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        items: p.itemIds.length
      }))
    });
    return;
  }

  if (pathname === "/diagnostics") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const lineCount = normalizeLinesParam(url.searchParams.get("lines"), 150);
    const grep = url.searchParams.get("grep") || "";
    const packageQuery = url.searchParams.get("package") || "";
    const mainLogPath = getLogFilePath();
    const sessionLogPath = getSessionLogPath();
    const selectedPackage = packageQuery ? findPackage(snapshot, packageQuery) : null;
    const packageLogPath = selectedPackage
      ? manager.getPackageLogPath(selectedPackage.id) || getPersistedPackageLogPath(selectedPackage.id)
      : null;
    jsonResponse(res, 200, {
      meta: {
        appVersion: APP_VERSION,
        serverTime: new Date().toISOString(),
        runtimeBaseDir,
        debugServer: {
          host: bindHost,
          port: bindPort
        }
      },
      status: buildStatusPayload(snapshot),
      host: getWindowsHostDiagnostics(),
      selectedPackage: selectedPackage ? summarizePackage(snapshot, selectedPackage, true) : undefined,
      logs: {
        main: {
          path: mainLogPath,
          lines: filterLines(readLogTailFromFile(mainLogPath, lineCount), grep)
        },
        session: {
          path: sessionLogPath,
          lines: filterLines(readLogTailFromFile(sessionLogPath, lineCount), grep)
        },
        package: selectedPackage ? {
          path: packageLogPath,
          lines: filterLines(readLogTailFromFile(packageLogPath, lineCount), grep)
        } : undefined
      }
    });
    return;
  }

  jsonResponse(res, 404, {
    error: "Not found",
    endpoints: [
      "GET /health",
      "GET /meta",
      "GET /host/diagnostics",
      "GET /log?lines=100&grep=keyword",
      "GET /logs/main?lines=100&grep=keyword",
      "GET /logs/session?lines=100&grep=keyword",
      "GET /logs/package?package=Release&lines=100&grep=keyword",
      "GET /logs/item?item=episode.part2.rar&lines=100&grep=keyword",
      "GET /status",
      "GET /packages?package=Release&includeItems=1",
      "GET /items?status=downloading&package=Bloodline",
      "GET /session?package=Criminal",
      "GET /diagnostics?package=Criminal&lines=150"
    ]
  });
}

export function startDebugServer(mgr: DownloadManager, baseDir: string): void {
  runtimeBaseDir = baseDir;
  authToken = loadToken(baseDir);
  if (!authToken) {
    logger.info("Debug-Server: Kein Token in debug_token.txt, Server wird nicht gestartet");
    return;
  }

  manager = mgr;
  bindPort = getPort(baseDir);
  bindHost = getHost(baseDir);

  server = http.createServer(handleRequest);
  server.listen(bindPort, bindHost, () => {
    logger.info(`Debug-Server gestartet auf ${bindHost}:${bindPort}`);
  });
  server.on("error", (err) => {
    logger.warn(`Debug-Server Fehler: ${String(err)}`);
    server = null;
  });
}

export function stopDebugServer(): void {
  if (server) {
    server.close();
    server = null;
    logger.info("Debug-Server gestoppt");
  }
}
