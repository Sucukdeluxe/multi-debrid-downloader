import fs from "node:fs";
import path from "node:path";
import { addLogListener, removeLogListener } from "./logger";
import type { SupportTraceConfig } from "../shared/types";

type TraceLevel = "INFO" | "WARN" | "ERROR";

const TRACE_LOG_FLUSH_INTERVAL_MS = 200;
const TRACE_CONFIG_FILE = "trace_config.json";
const TRACE_LOG_MAX_FILE_BYTES = Number(process.env.RD_TRACE_LOG_MAX_BYTES || 10 * 1024 * 1024);
const TRACE_LOG_RETENTION_DAYS = Number(process.env.RD_TRACE_LOG_RETENTION_DAYS || 30);
const TRACE_DEFAULT_AUTO_DISABLE_MS = Number(process.env.RD_TRACE_AUTO_DISABLE_MS || 2 * 60 * 60 * 1000);

const DEFAULT_TRACE_CONFIG: SupportTraceConfig = {
  enabled: false,
  includeMainLog: true,
  includeAudit: true,
  logDebugRequests: true,
  autoDisableAt: null,
  updatedAt: new Date(0).toISOString()
};

let traceLogPath: string | null = null;
let traceConfigPath: string | null = null;
let traceConfig: SupportTraceConfig = { ...DEFAULT_TRACE_CONFIG };
let pendingLines: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let autoDisableTimer: NodeJS.Timeout | null = null;

function sanitizeFieldValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.replace(/\r?\n/g, "\\n");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value).replace(/\r?\n/g, "\\n");
  } catch {
    return String(value);
  }
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) {
    return "";
  }
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && sanitizeFieldValue(value) !== "")
    .map(([key, value]) => `${key}=${sanitizeFieldValue(value)}`);
  return parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
}

function flushPending(): void {
  if (!traceLogPath || pendingLines.length === 0) {
    return;
  }
  const chunk = pendingLines.join("");
  pendingLines = [];
  try {
    fs.appendFileSync(traceLogPath, chunk, "utf8");
  } catch {
    // ignore
  }
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < TRACE_LOG_MAX_FILE_BYTES) {
      return;
    }
    const backup = `${filePath}.old`;
    try {
      fs.rmSync(backup, { force: true });
    } catch {
      // ignore
    }
    fs.renameSync(filePath, backup);
  } catch {
    // ignore
  }
}

function cleanupOldBackup(filePath: string): void {
  const backup = `${filePath}.old`;
  try {
    const stat = fs.statSync(backup);
    const cutoff = Date.now() - TRACE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(backup, { force: true });
    }
  } catch {
    // ignore
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, TRACE_LOG_FLUSH_INTERVAL_MS);
}

function appendTraceLine(line: string): void {
  if (!traceLogPath) {
    return;
  }
  rotateIfNeeded(traceLogPath);
  if (!fs.existsSync(traceLogPath)) {
    try {
      fs.writeFileSync(traceLogPath, "", "utf8");
    } catch {
      return;
    }
  }
  pendingLines.push(line);
  scheduleFlush();
}

function normalizeTraceConfig(raw: unknown): SupportTraceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_TRACE_CONFIG };
  }
  const value = raw as Partial<SupportTraceConfig>;
  return {
    enabled: Boolean(value.enabled),
    includeMainLog: value.includeMainLog === undefined ? DEFAULT_TRACE_CONFIG.includeMainLog : Boolean(value.includeMainLog),
    includeAudit: value.includeAudit === undefined ? DEFAULT_TRACE_CONFIG.includeAudit : Boolean(value.includeAudit),
    logDebugRequests: value.logDebugRequests === undefined ? DEFAULT_TRACE_CONFIG.logDebugRequests : Boolean(value.logDebugRequests),
    autoDisableAt: typeof value.autoDisableAt === "string" && value.autoDisableAt.trim()
      ? value.autoDisableAt
      : null,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? value.updatedAt
      : DEFAULT_TRACE_CONFIG.updatedAt
  };
}

function loadTraceConfig(): SupportTraceConfig {
  if (!traceConfigPath) {
    return { ...DEFAULT_TRACE_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(traceConfigPath, "utf8")) as unknown;
    return normalizeTraceConfig(parsed);
  } catch {
    return { ...DEFAULT_TRACE_CONFIG };
  }
}

function persistTraceConfig(): void {
  if (!traceConfigPath) {
    return;
  }
  try {
    fs.writeFileSync(traceConfigPath, `${JSON.stringify(traceConfig, null, 2)}\n`, "utf8");
  } catch {
    // ignore
  }
}

const mainLogListener = (line: string): void => {
  if (!traceConfig.enabled || !traceConfig.includeMainLog) {
    return;
  }
  appendTraceLine(line);
};

function clearAutoDisableTimer(): void {
  if (autoDisableTimer) {
    clearTimeout(autoDisableTimer);
    autoDisableTimer = null;
  }
}

function disableTraceDueToExpiry(): void {
  clearAutoDisableTimer();
  if (!traceConfig.enabled) {
    return;
  }
  traceConfig = normalizeTraceConfig({
    ...traceConfig,
    enabled: false,
    autoDisableAt: null,
    updatedAt: new Date().toISOString()
  });
  persistTraceConfig();
  appendTraceLine(`${new Date().toISOString()} [INFO] [trace] Support-Trace automatisch deaktiviert | reason=expired\n`);
}

function scheduleAutoDisable(): void {
  clearAutoDisableTimer();
  if (!traceConfig.enabled || !traceConfig.autoDisableAt) {
    return;
  }
  const until = Date.parse(traceConfig.autoDisableAt);
  if (!Number.isFinite(until)) {
    return;
  }
  const remainingMs = until - Date.now();
  if (remainingMs <= 0) {
    disableTraceDueToExpiry();
    return;
  }
  autoDisableTimer = setTimeout(() => {
    autoDisableTimer = null;
    disableTraceDueToExpiry();
  }, Math.min(remainingMs, 2_147_483_647));
}

export function initTraceLog(baseDir: string): void {
  traceLogPath = path.join(baseDir, "trace.log");
  traceConfigPath = path.join(baseDir, TRACE_CONFIG_FILE);
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    cleanupOldBackup(traceLogPath);
    if (!fs.existsSync(traceLogPath)) {
      fs.writeFileSync(traceLogPath, "", "utf8");
    }
    rotateIfNeeded(traceLogPath);
    if (!fs.existsSync(traceLogPath)) {
      fs.writeFileSync(traceLogPath, "", "utf8");
    }
    traceConfig = loadTraceConfig();
    persistTraceConfig();
    fs.appendFileSync(traceLogPath, `=== Trace-Log Start: ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    traceLogPath = null;
    traceConfigPath = null;
    traceConfig = { ...DEFAULT_TRACE_CONFIG };
    return;
  }
  addLogListener(mainLogListener);
  scheduleAutoDisable();
}

export function getTraceLogPath(): string | null {
  if (!traceLogPath) {
    return null;
  }
  return fs.existsSync(traceLogPath) ? traceLogPath : null;
}

export function getTraceConfigPath(): string | null {
  if (!traceConfigPath) {
    return null;
  }
  return fs.existsSync(traceConfigPath) ? traceConfigPath : null;
}

export function getTraceConfig(): SupportTraceConfig {
  return { ...traceConfig };
}

export function updateTraceConfig(patch: Partial<SupportTraceConfig>): SupportTraceConfig {
  traceConfig = normalizeTraceConfig({
    ...traceConfig,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  persistTraceConfig();
  scheduleAutoDisable();
  appendTraceLine(`${new Date().toISOString()} [INFO] [trace] Konfiguration aktualisiert${formatFields(traceConfig)}\n`);
  return getTraceConfig();
}

export function setTraceEnabled(enabled: boolean, note = "", durationMs: number = TRACE_DEFAULT_AUTO_DISABLE_MS): SupportTraceConfig {
  const autoDisableAt = enabled && durationMs > 0
    ? new Date(Date.now() + durationMs).toISOString()
    : null;
  const next = updateTraceConfig({ enabled, autoDisableAt });
  appendTraceLine(`${new Date().toISOString()} [INFO] [trace] Support-Trace ${enabled ? "aktiviert" : "deaktiviert"}${formatFields({ note, autoDisableAt })}\n`);
  return next;
}

export function logTraceEvent(
  level: TraceLevel,
  category: string,
  message: string,
  fields?: Record<string, unknown>
): void {
  if (!traceConfig.enabled) {
    return;
  }
  if (category === "audit" && !traceConfig.includeAudit) {
    return;
  }
  appendTraceLine(`${new Date().toISOString()} [${level}] [${category}] ${message}${formatFields(fields)}\n`);
}

export function shutdownTraceLog(): void {
  removeLogListener(mainLogListener);
  clearAutoDisableTimer();
  if (!traceLogPath) {
    return;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushPending();
  try {
    fs.appendFileSync(traceLogPath, `=== Trace-Log Ende: ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    // ignore
  }
  traceLogPath = null;
  traceConfigPath = null;
  traceConfig = { ...DEFAULT_TRACE_CONFIG };
}
