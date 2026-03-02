import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { logger, getLogFilePath } from "./logger";
import type { DownloadManager } from "./download-manager";

const DEFAULT_PORT = 9868;
const MAX_LOG_LINES = 10000;

let server: http.Server | null = null;
let manager: DownloadManager | null = null;
let authToken = "";

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

function readLogTail(lines: number): string[] {
  const logPath = getLogFilePath();
  try {
    const content = fs.readFileSync(logPath, "utf8");
    const allLines = content.split("\n").filter((l) => l.trim().length > 0);
    return allLines.slice(-Math.min(lines, MAX_LOG_LINES));
  } catch {
    return ["(Log-Datei nicht lesbar)"];
  }
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization"
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
      uptime: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
    return;
  }

  if (pathname === "/log") {
    const count = Math.min(Number(url.searchParams.get("lines") || "100"), MAX_LOG_LINES);
    const grep = url.searchParams.get("grep") || "";
    let lines = readLogTail(count);
    if (grep) {
      const pattern = grep.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(pattern));
    }
    jsonResponse(res, 200, { lines, count: lines.length });
    return;
  }

  if (pathname === "/status") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const items = Object.values(snapshot.session.items);
    const packages = Object.values(snapshot.session.packages);

    const byStatus: Record<string, number> = {};
    for (const item of items) {
      byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    }

    const activeItems = items
      .filter((i) => i.status === "downloading" || i.status === "validating")
      .map((i) => ({
        id: i.id,
        fileName: i.fileName,
        status: i.status,
        fullStatus: i.fullStatus,
        provider: i.provider,
        progress: i.progressPercent,
        speedMBs: +(i.speedBps / 1024 / 1024).toFixed(2),
        downloadedMB: +(i.downloadedBytes / 1024 / 1024).toFixed(1),
        totalMB: i.totalBytes ? +(i.totalBytes / 1024 / 1024).toFixed(1) : null,
        retries: i.retries,
        lastError: i.lastError
      }));

    const failedItems = items
      .filter((i) => i.status === "failed")
      .map((i) => ({
        fileName: i.fileName,
        lastError: i.lastError,
        retries: i.retries,
        provider: i.provider
      }));

    jsonResponse(res, 200, {
      running: snapshot.session.running,
      paused: snapshot.session.paused,
      speed: snapshot.speedText,
      eta: snapshot.etaText,
      itemCounts: byStatus,
      totalItems: items.length,
      packages: packages.map((p) => ({
        name: p.name,
        status: p.status,
        items: p.itemIds.length
      })),
      activeItems,
      failedItems: failedItems.length > 0 ? failedItems : undefined
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
      const pkgLower = pkg.toLowerCase();
      const matchedPkg = Object.values(snapshot.session.packages)
        .find((p) => p.name.toLowerCase().includes(pkgLower));
      if (matchedPkg) {
        const ids = new Set(matchedPkg.itemIds);
        items = items.filter((i) => ids.has(i.id));
      }
    }
    jsonResponse(res, 200, {
      count: items.length,
      items: items.map((i) => ({
        fileName: i.fileName,
        status: i.status,
        fullStatus: i.fullStatus,
        provider: i.provider,
        progress: i.progressPercent,
        speedMBs: +(i.speedBps / 1024 / 1024).toFixed(2),
        downloadedMB: +(i.downloadedBytes / 1024 / 1024).toFixed(1),
        totalMB: i.totalBytes ? +(i.totalBytes / 1024 / 1024).toFixed(1) : null,
        retries: i.retries,
        lastError: i.lastError
      }))
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
      const pkgLower = pkg.toLowerCase();
      const matchedPkg = Object.values(snapshot.session.packages)
        .find((p) => p.name.toLowerCase().includes(pkgLower));
      if (matchedPkg) {
        const ids = new Set(matchedPkg.itemIds);
        const pkgItems = Object.values(snapshot.session.items)
          .filter((i) => ids.has(i.id));
        jsonResponse(res, 200, {
          package: matchedPkg,
          items: pkgItems
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

  jsonResponse(res, 404, {
    error: "Not found",
    endpoints: [
      "GET /health",
      "GET /log?lines=100&grep=keyword",
      "GET /status",
      "GET /items?status=downloading&package=Bloodline",
      "GET /session?package=Criminal"
    ]
  });
}

export function startDebugServer(mgr: DownloadManager, baseDir: string): void {
  authToken = loadToken(baseDir);
  if (!authToken) {
    logger.info("Debug-Server: Kein Token in debug_token.txt, Server wird nicht gestartet");
    return;
  }

  manager = mgr;
  const port = getPort(baseDir);

  server = http.createServer(handleRequest);
  server.listen(port, "0.0.0.0", () => {
    logger.info(`Debug-Server gestartet auf Port ${port}`);
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
