import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_VERSION } from "./constants";
import { getAuditLogPath } from "./audit-log";
import { getDebugSetupCheck } from "./debug-setup";
import { logger, getLogFilePath } from "./logger";
import { getRecentErrors } from "./error-ring";
import { getItemLogPath as getPersistedItemLogPath } from "./item-log";
import { getSessionLogPath } from "./session-log";
import { getPackageLogPath as getPersistedPackageLogPath } from "./package-log";
import { getRenameLogPath } from "./rename-log";
import { createStoragePaths, loadHistory, loadSettings } from "./storage";
import { buildAccountSummary, buildRedactedSettingsPayload, buildStatsPayload, summarizeHistoryEntry } from "./support-data";
import { buildSupportBundle, getSupportBundleDefaultFileName } from "./support-bundle";
import { getTraceConfig, getTraceConfigPath, getTraceLogPath, logTraceEvent, setTraceEnabled, updateTraceConfig } from "./trace-log";
import { getConversionLogPath } from "./conversion-trace";
import { getProviderRuntimeSnapshot } from "./debrid";
import { getWindowsHostDiagnostics } from "./windows-host-diagnostics";
import type { DownloadManager } from "./download-manager";
import type { DownloadItem, PackageEntry, UiSnapshot } from "../shared/types";

const DEFAULT_PORT = 9868;
const DEFAULT_HOST = "127.0.0.1";
const MAX_LOG_LINES = 10000;
const AI_MANIFEST_FILE = "debug_ai_manifest.json";

type DebugEndpointDescriptor = {
  method: "GET";
  path: string;
  queryExample?: string;
  description: string;
};

const DEBUG_ENDPOINTS: DebugEndpointDescriptor[] = [
  { method: "GET", path: "/health", description: "Basic health, uptime, and memory information." },
  { method: "GET", path: "/meta", description: "Lists runtime metadata and all available endpoints." },
  { method: "GET", path: "/debug/setup", description: "Checks whether the local debug setup is configured for support." },
  { method: "GET", path: "/self-check", description: "Extended support self-check with disk space, log sizes, and support bundle estimate." },
  { method: "GET", path: "/host/diagnostics", description: "Returns Windows host crash and dump diagnostics." },
  { method: "GET", path: "/log", queryExample: "lines=100&grep=keyword", description: "Legacy alias for the main application log tail." },
  { method: "GET", path: "/logs/main", queryExample: "lines=100&grep=keyword", description: "Reads the main application log tail." },
  { method: "GET", path: "/logs/audit", queryExample: "lines=100&grep=keyword", description: "Reads the audit log for support-relevant UI and admin actions." },
  { method: "GET", path: "/logs/rename", queryExample: "lines=100&grep=keyword", description: "Reads the dedicated rename and MKV move log." },
  { method: "GET", path: "/logs/trace", queryExample: "lines=100&grep=keyword", description: "Reads the optional support trace log." },
  { method: "GET", path: "/logs/session", queryExample: "lines=100&grep=keyword", description: "Reads the session log tail." },
  { method: "GET", path: "/logs/conversion", queryExample: "lines=100&grep=keyword", description: "Reads the per-item link conversion/unrestrict lifecycle log (token, API getLink, web, account rotation, aborts with timings)." },
  { method: "GET", path: "/logs/package", queryExample: "package=Release&lines=100&grep=keyword", description: "Reads the package log for a specific package name or id." },
  { method: "GET", path: "/logs/item", queryExample: "item=episode.part2.rar&lines=100&grep=keyword", description: "Reads the item log for a specific file name or item id." },
  { method: "GET", path: "/errors", queryExample: "level=ERROR&limit=100", description: "Returns the in-memory ring of the most recent WARN/ERROR log lines." },
  { method: "GET", path: "/trace/config", queryExample: "enable=1&note=support&durationMinutes=120", description: "Reads or updates the support trace configuration." },
  { method: "GET", path: "/settings", description: "Returns a redacted settings snapshot without raw secrets." },
  { method: "GET", path: "/accounts", description: "Returns a redacted account/provider configuration summary." },
  { method: "GET", path: "/providers", description: "Live provider runtime state: per-account/key cooldowns (until/remaining/reason/category), in-flight depth, Mega rotation cursor, empty-response streaks. The 'why is it cooling down right now' view." },
  { method: "GET", path: "/stats", description: "Returns live session stats plus persisted all-time totals." },
  { method: "GET", path: "/history", queryExample: "limit=50&status=completed", description: "Returns history entries with optional filters." },
  { method: "GET", path: "/status", description: "Returns a live high-level status overview." },
  { method: "GET", path: "/packages", queryExample: "package=Release&includeItems=1", description: "Lists packages and optional per-item detail." },
  { method: "GET", path: "/items", queryExample: "status=downloading&package=Release", description: "Lists items and supports status/package filters." },
  { method: "GET", path: "/session", queryExample: "package=Release", description: "Returns session-wide or package-scoped item state." },
  { method: "GET", path: "/support/bundle", description: "Downloads a ZIP support bundle with logs, diagnostics, and redacted state." },
  { method: "GET", path: "/diagnostics", queryExample: "package=Release&lines=150", description: "Returns a combined support snapshot with logs, status, settings, accounts, stats, history, and host diagnostics." }
];

let server: http.Server | null = null;
let manager: DownloadManager | null = null;
let authToken = "";
let bindHost = DEFAULT_HOST;
let bindPort = DEFAULT_PORT;
let runtimeBaseDir = "";
let allowlist: string[] = [];

export interface DebugServerRuntimeStatus {
  running: boolean;
  host: string;
  port: number;
  hasToken: boolean;
  localOnly: boolean;
  allowlistCount: number;
}

function getStoragePaths() {
  return createStoragePaths(runtimeBaseDir);
}

function readSupportSettings() {
  return loadSettings(getStoragePaths());
}

function readSupportHistory() {
  return loadHistory(getStoragePaths());
}

function extractDebugClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedIp = String(forwardedValue || "").split(",")[0]?.trim();
  if (forwardedIp) {
    return forwardedIp;
  }
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (realIp) {
    return realIp;
  }
  const remote = String(req.socket.remoteAddress || req.socket.address()?.address || "").trim();
  return remote.replace(/^::ffff:/i, "");
}

function getAiManifestPath(baseDir: string = runtimeBaseDir): string {
  return path.join(baseDir, AI_MANIFEST_FILE);
}

function getDebugTokenPath(baseDir: string = runtimeBaseDir): string {
  return path.join(baseDir, "debug_token.txt");
}

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
  }
  return DEFAULT_HOST;
}

function getAllowlistPath(baseDir: string = runtimeBaseDir): string {
  return path.join(baseDir, "debug_allowlist.txt");
}

function loadAllowlist(baseDir: string): string[] {
  try {
    return fs.readFileSync(getAllowlistPath(baseDir), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function normalizeIp(ip: string): string {
  return String(ip || "").trim().replace(/^::ffff:/i, "").toLowerCase();
}

function isLoopbackIp(ip: string): boolean {
  const x = normalizeIp(ip);
  return x === "::1" || x === "localhost" || x.startsWith("127.");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    result = (result * 256) + value;
  }
  return result >>> 0;
}

function matchIpRule(clientIp: string, rule: string): boolean {
  const client = normalizeIp(clientIp);
  const r = rule.trim().toLowerCase();
  if (!r) {
    return false;
  }
  if (r === "*" || r === "0.0.0.0/0") {
    return true;
  }
  if (r === client) {
    return true;
  }
  const slash = r.indexOf("/");
  if (slash > 0) {
    const baseInt = ipv4ToInt(r.slice(0, slash));
    const clientInt = ipv4ToInt(client);
    const bits = Number(r.slice(slash + 1));
    if (baseInt === null || clientInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      return false;
    }
    if (bits === 0) {
      return true;
    }
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (clientInt & mask) === (baseInt & mask);
  }
  return false;
}

export function evaluateClientAllowed(clientIp: string, rules: string[]): boolean {
  const client = normalizeIp(clientIp);
  if (isLoopbackIp(client) || client === "") {
    return true;
  }
  if (rules.length === 0) {
    return false;
  }
  return rules.some((rule) => matchIpRule(client, rule));
}

export function getPeerIp(req: http.IncomingMessage): string {
  return normalizeIp(req.socket?.remoteAddress || "");
}

function isClientAllowed(clientIp: string): boolean {
  return evaluateClientAllowed(clientIp, allowlist);
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

function binaryResponse(
  res: http.ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  fileName?: string
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    ...(fileName ? { "Content-Disposition": `attachment; filename="${fileName}"` } : {})
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

function toBooleanQuery(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }
  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  return null;
}

function sanitizeRequestUrlForTrace(rawUrl: string): string {
  try {
    const url = new URL(rawUrl || "/", "http://localhost");
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "***");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(rawUrl || "/");
  }
}

function formatEndpointSummary(endpoint: DebugEndpointDescriptor): string {
  return `${endpoint.method} ${endpoint.path}${endpoint.queryExample ? `?${endpoint.queryExample}` : ""}`;
}

function getEndpointSummaries(): string[] {
  return DEBUG_ENDPOINTS.map((endpoint) => formatEndpointSummary(endpoint));
}

function buildAiManifest(baseDir: string): Record<string, unknown> {
  const remoteHostHint = bindHost === "0.0.0.0"
    ? "Use the server IP or DNS name for remote access. Ask the user only for that host value if it is unknown."
    : "If remote access is required and the bind host is local-only, switch debug_host.txt to 0.0.0.0 and reopen the firewall.";

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    runtimeBaseDir: baseDir,
    purpose: "Machine-readable support manifest for AI tools and remote troubleshooting.",
    quickstart: [
      "Read debug_token.txt and debug_port.txt from this runtime folder.",
      "If remote access is needed, ask the user only for the server IP or DNS name.",
      "Call /meta first to confirm the server is reachable and to re-read the endpoint list.",
      "Use /self-check or /debug/setup to quickly verify whether token, host, manifest, trace, disk space, and log sizes are in a good support state.",
      "Use /diagnostics for an overview, then drill into /logs/item, /logs/package, /logs/rename, /status, /packages, /items, /settings, /accounts, /stats, /history, or /logs/trace.",
      "For provider stalls/cooldowns, call /providers for the live cooldown state (until/remaining/reason per account/key) and /logs/conversion for the per-item resolve lifecycle (token, API, web, rotation, aborts with timings).",
      "If a full handoff is needed, download /support/bundle as a ZIP."
    ],
    auth: {
      required: true,
      methods: [
        "Authorization: Bearer <token>",
        "?token=<token>"
      ],
      tokenFile: path.join(baseDir, "debug_token.txt")
    },
    runtimeFiles: {
      hostFile: path.join(baseDir, "debug_host.txt"),
      portFile: path.join(baseDir, "debug_port.txt"),
      tokenFile: path.join(baseDir, "debug_token.txt"),
      mainLogFile: getLogFilePath(),
      auditLogFile: getAuditLogPath(),
      renameLogFile: getRenameLogPath(),
      traceLogFile: getTraceLogPath(),
      traceConfigFile: getTraceConfigPath(),
      sessionLogFile: getSessionLogPath(),
      packageLogDir: path.join(baseDir, "package-logs"),
      itemLogDir: path.join(baseDir, "item-logs"),
      settingsFile: path.join(baseDir, "rd_downloader_config.json"),
      sessionFile: path.join(baseDir, "rd_session_state.json"),
      historyFile: path.join(baseDir, "rd_history.json")
    },
    debugServer: {
      enabled: Boolean(authToken),
      host: bindHost,
      port: bindPort,
      localBaseUrl: `http://127.0.0.1:${bindPort}`,
      remoteBaseUrlTemplate: `http://<SERVER_IP_OR_DNS>:${bindPort}`,
      remoteHostHint
    },
    setupCheckEndpoint: "/debug/setup",
    selfCheckEndpoint: "/self-check",
    askUserFor: [
      "Server IP or DNS name, if remote access is required and not already known."
    ],
    endpoints: DEBUG_ENDPOINTS.map((endpoint) => ({
      ...endpoint,
      summary: formatEndpointSummary(endpoint)
    }))
  };
}

function writeAiManifest(baseDir: string): void {
  try {
    fs.writeFileSync(getAiManifestPath(baseDir), JSON.stringify(buildAiManifest(baseDir), null, 2), "utf8");
  } catch (error) {
    logger.warn(`Debug-Server: KI-Support-Datei konnte nicht geschrieben werden: ${String(error)}`);
  }
}

export function rotateDebugToken(baseDir: string = runtimeBaseDir): { path: string; token: string } {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenPath = getDebugTokenPath(baseDir);
  fs.writeFileSync(tokenPath, `${token}\n`, "utf8");
  if (baseDir === runtimeBaseDir) {
    authToken = token;
    writeAiManifest(baseDir);
  }
  logger.info(`Debug-Server Token rotiert: ${tokenPath}`);
  logTraceEvent("INFO", "support", "Debug-Token rotiert", { tokenPath });
  return { path: tokenPath, token };
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
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const traceConfig = getTraceConfig();
  if (traceConfig.enabled && traceConfig.logDebugRequests) {
    logTraceEvent("INFO", "debug-http", "Request", {
      method: req.method || "GET",
      url: sanitizeRequestUrlForTrace(req.url || "/"),
      clientIp: extractDebugClientIp(req)
    });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Allow-Methods": "GET,OPTIONS"
    });
    res.end();
    return;
  }

  const peerIp = getPeerIp(req);
  if (!isClientAllowed(peerIp)) {
    if (traceConfig.enabled && traceConfig.logDebugRequests) {
      logTraceEvent("WARN", "debug-http", "Durch Allowlist blockiert", {
        peerIp,
        forwardedFor: extractDebugClientIp(req),
        url: sanitizeRequestUrlForTrace(req.url || "/")
      });
    }
    jsonResponse(res, 403, { error: "Forbidden", reason: "Client-IP nicht in Allowlist", clientIp: peerIp });
    return;
  }

  if (!checkAuth(req)) {
    if (traceConfig.enabled && traceConfig.logDebugRequests) {
      logTraceEvent("WARN", "debug-http", "Unauthorized request", {
        method: req.method || "GET",
        url: sanitizeRequestUrlForTrace(req.url || "/"),
        clientIp: extractDebugClientIp(req)
      });
    }
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

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
      supportFiles: {
        aiManifest: getAiManifestPath(),
        traceConfig: getTraceConfigPath(),
        traceLog: getTraceLogPath()
      },
      supportChecks: {
        setup: "/debug/setup",
        selfCheck: "/self-check"
      },
      logPaths: {
        main: getLogFilePath(),
        audit: getAuditLogPath(),
        rename: getRenameLogPath(),
        session: getSessionLogPath(),
        trace: getTraceLogPath()
      },
      endpoints: getEndpointSummaries()
    });
    return;
  }

  if (pathname === "/debug/setup" || pathname === "/self-check") {
    jsonResponse(res, 200, getDebugSetupCheck(runtimeBaseDir));
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

  if (pathname === "/errors") {
    const levelFilter = (url.searchParams.get("level") || "").toUpperCase();
    const limit = normalizeLinesParam(url.searchParams.get("limit"), 100);
    let entries = getRecentErrors();
    if (levelFilter === "ERROR" || levelFilter === "WARN") {
      entries = entries.filter((entry) => entry.level === levelFilter);
    }
    const limited = entries.slice(-limit);
    jsonResponse(res, 200, { count: limited.length, total: entries.length, entries: limited });
    return;
  }

  if (pathname === "/logs/audit") {
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const logPath = getAuditLogPath();
    const lines = filterLines(readLogTailFromFile(logPath, count), grep);
    jsonResponse(res, 200, {
      path: logPath,
      lines,
      count: lines.length
    });
    return;
  }

  if (pathname === "/logs/rename") {
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const logPath = getRenameLogPath();
    const lines = filterLines(readLogTailFromFile(logPath, count), grep);
    jsonResponse(res, 200, {
      path: logPath,
      lines,
      count: lines.length
    });
    return;
  }

  if (pathname === "/logs/trace") {
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const logPath = getTraceLogPath();
    const lines = filterLines(readLogTailFromFile(logPath, count), grep);
    jsonResponse(res, 200, {
      path: logPath,
      configPath: getTraceConfigPath(),
      config: getTraceConfig(),
      lines,
      count: lines.length
    });
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

  if (pathname === "/logs/conversion") {
    const count = normalizeLinesParam(url.searchParams.get("lines"), 100);
    const grep = url.searchParams.get("grep") || "";
    const logPath = getConversionLogPath();
    const lines = logPath ? filterLines(readLogTailFromFile(logPath, count), grep) : [];
    jsonResponse(res, 200, {
      path: logPath,
      available: Boolean(logPath),
      lines,
      count: lines.length
    });
    return;
  }

  if (pathname === "/providers") {
    jsonResponse(res, 200, getProviderRuntimeSnapshot());
    return;
  }

  if (pathname === "/trace/config") {
    const patch: Record<string, unknown> = {};
    const enabled = toBooleanQuery(url.searchParams.get("enable"));
    const includeMainLog = toBooleanQuery(url.searchParams.get("includeMainLog"));
    const includeAudit = toBooleanQuery(url.searchParams.get("includeAudit"));
    const logDebugRequests = toBooleanQuery(url.searchParams.get("logDebugRequests"));
    if (enabled !== null) {
      patch.enabled = enabled;
    }
    if (includeMainLog !== null) {
      patch.includeMainLog = includeMainLog;
    }
    if (includeAudit !== null) {
      patch.includeAudit = includeAudit;
    }
    if (logDebugRequests !== null) {
      patch.logDebugRequests = logDebugRequests;
    }
    const note = String(url.searchParams.get("note") || "").trim();
    const durationMinutesRaw = Number(url.searchParams.get("durationMinutes") || "120");
    const durationMinutes = Number.isFinite(durationMinutesRaw) && durationMinutesRaw > 0
      ? Math.min(Math.floor(durationMinutesRaw), 24 * 60)
      : 120;
    let config = getTraceConfig();
    if (enabled !== null) {
      config = setTraceEnabled(enabled, note, durationMinutes * 60 * 1000);
    }
    const configPatch = { ...patch };
    delete configPatch.enabled;
    if (Object.keys(configPatch).length > 0) {
      config = updateTraceConfig(configPatch);
    }
    if (Object.keys(patch).length > 0) {
      logTraceEvent("INFO", "support", "Trace-Konfiguration über Debug-Server geändert", { ...patch, note, durationMinutes });
    }
    jsonResponse(res, 200, {
      path: getTraceConfigPath(),
      logPath: getTraceLogPath(),
      config
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

  if (pathname === "/settings") {
    const settings = readSupportSettings();
    jsonResponse(res, 200, buildRedactedSettingsPayload(settings));
    return;
  }

  if (pathname === "/accounts") {
    const settings = readSupportSettings();
    jsonResponse(res, 200, buildAccountSummary(settings));
    return;
  }

  if (pathname === "/stats") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const snapshot = manager.getSnapshot();
    const settings = readSupportSettings();
    jsonResponse(res, 200, {
      ...buildStatsPayload(snapshot),
      allTime: {
        totalDownloadedAllTime: settings.totalDownloadedAllTime,
        totalCompletedFilesAllTime: settings.totalCompletedFilesAllTime,
        totalRuntimeAllTimeMs: settings.totalRuntimeAllTimeMs
      }
    });
    return;
  }

  if (pathname === "/history") {
    const entries = readSupportHistory();
    const limit = normalizeLinesParam(url.searchParams.get("limit"), 50);
    const statusFilter = String(url.searchParams.get("status") || "").trim().toLowerCase();
    const grep = String(url.searchParams.get("grep") || "").trim().toLowerCase();
    let filtered = entries;
    if (statusFilter) {
      filtered = filtered.filter((entry) => String(entry.status || "").toLowerCase() === statusFilter);
    }
    if (grep) {
      filtered = filtered.filter((entry) => JSON.stringify(summarizeHistoryEntry(entry)).toLowerCase().includes(grep));
    }
    const sliced = filtered
      .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0))
      .slice(0, limit);
    jsonResponse(res, 200, {
      count: sliced.length,
      total: filtered.length,
      entries: sliced.map((entry) => summarizeHistoryEntry(entry))
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

  if (pathname === "/support/bundle") {
    if (!manager) {
      jsonResponse(res, 503, { error: "Manager not initialized" });
      return;
    }
    const fileName = getSupportBundleDefaultFileName();
    buildSupportBundle(manager, runtimeBaseDir)
      .then((body) => {
        logTraceEvent("INFO", "support", "Support-Bundle über Debug-Server heruntergeladen", {
          fileName,
          sizeBytes: body.length
        });
        binaryResponse(res, 200, body, "application/zip", fileName);
      })
      .catch((error) => {
        jsonResponse(res, 500, { error: String((error as { message?: string })?.message || error) });
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
        },
        setup: getDebugSetupCheck(runtimeBaseDir)
      },
      status: buildStatusPayload(snapshot),
      settings: buildRedactedSettingsPayload(readSupportSettings()),
      stats: buildStatsPayload(snapshot),
      accounts: buildAccountSummary(readSupportSettings()),
      providers: getProviderRuntimeSnapshot(),
      history: {
        total: readSupportHistory().length,
        recent: readSupportHistory()
          .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0))
          .slice(0, 10)
          .map((entry) => summarizeHistoryEntry(entry))
      },
      host: getWindowsHostDiagnostics(),
      selectedPackage: selectedPackage ? summarizePackage(snapshot, selectedPackage, true) : undefined,
      logs: {
        main: {
          path: mainLogPath,
          lines: filterLines(readLogTailFromFile(mainLogPath, lineCount), grep)
        },
        audit: {
          path: getAuditLogPath(),
          lines: filterLines(readLogTailFromFile(getAuditLogPath(), lineCount), grep)
        },
        rename: {
          path: getRenameLogPath(),
          lines: filterLines(readLogTailFromFile(getRenameLogPath(), lineCount), grep)
        },
        trace: {
          path: getTraceLogPath(),
          config: getTraceConfig(),
          lines: filterLines(readLogTailFromFile(getTraceLogPath(), lineCount), grep)
        },
        session: {
          path: sessionLogPath,
          lines: filterLines(readLogTailFromFile(sessionLogPath, lineCount), grep)
        },
        conversion: {
          path: getConversionLogPath(),
          lines: getConversionLogPath() ? filterLines(readLogTailFromFile(getConversionLogPath() as string, lineCount), grep) : []
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
    endpoints: getEndpointSummaries()
  });
}

function openServerSocket(): Promise<void> {
  return new Promise((resolve) => {
    authToken = loadToken(runtimeBaseDir);
    bindPort = getPort(runtimeBaseDir);
    bindHost = getHost(runtimeBaseDir);
    allowlist = loadAllowlist(runtimeBaseDir);
    writeAiManifest(runtimeBaseDir);
    if (!authToken) {
      logger.info("Debug-Server: Kein Token in debug_token.txt, Server wird nicht gestartet");
      resolve();
      return;
    }
    if (bindHost === "0.0.0.0" && allowlist.length === 0) {
      logger.warn("Debug-Server: Netzwerk-Bind ohne Allowlist - nur Loopback-Clients werden akzeptiert (fail-closed)");
    }
    const srv = http.createServer(handleRequest);
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.warn(`Debug-Server: Port ${bindPort} belegt (EADDRINUSE) - Server nicht gestartet`);
      } else {
        logger.warn(`Debug-Server Fehler: ${String(err)}`);
      }
      if (server === srv) {
        server = null;
      }
      settle();
    });
    srv.listen(bindPort, bindHost, () => {
      logger.info(`Debug-Server gestartet auf ${bindHost}:${bindPort} (Allowlist: ${allowlist.length})`);
      settle();
    });
    server = srv;
  });
}

export function startDebugServer(mgr: DownloadManager, baseDir: string): void {
  runtimeBaseDir = baseDir;
  manager = mgr;
  void openServerSocket();
}

export async function restartDebugServer(): Promise<DebugServerRuntimeStatus> {
  const old = server;
  if (old) {
    server = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      old.close(() => done());
      try {
        old.closeAllConnections?.();
      } catch {
      }
      setTimeout(done, 1500);
    });
  }
  await openServerSocket();
  return getDebugServerRuntimeStatus();
}

export function getDebugServerRuntimeStatus(): DebugServerRuntimeStatus {
  return {
    running: Boolean(server && server.listening),
    host: bindHost,
    port: bindPort,
    hasToken: Boolean(authToken),
    localOnly: isLoopbackIp(bindHost) || bindHost === "127.0.0.1",
    allowlistCount: allowlist.length
  };
}

export function getActiveDebugToken(): string {
  return authToken || loadToken(runtimeBaseDir);
}

export function getDebugAllowlist(): string[] {
  return [...allowlist];
}

export function writeDebugServerConfig(opts: { host?: string; port?: number; allowlist?: string[] }): void {
  if (opts.host !== undefined) {
    fs.writeFileSync(path.join(runtimeBaseDir, "debug_host.txt"), `${opts.host}\n`, "utf8");
  }
  if (opts.port !== undefined) {
    fs.writeFileSync(path.join(runtimeBaseDir, "debug_port.txt"), `${opts.port}\n`, "utf8");
  }
  if (opts.allowlist !== undefined) {
    const body = opts.allowlist.length > 0 ? opts.allowlist.join("\n") + "\n" : "";
    fs.writeFileSync(getAllowlistPath(), body, "utf8");
  }
}

export function clearDebugToken(): void {
  try {
    fs.unlinkSync(getDebugTokenPath());
  } catch {
  }
  authToken = "";
  writeAiManifest(runtimeBaseDir);
}

export function stopDebugServer(): void {
  if (server) {
    server.close();
    try {
      server.closeAllConnections?.();
    } catch {
    }
    server = null;
    logger.info("Debug-Server gestoppt");
  }
}
