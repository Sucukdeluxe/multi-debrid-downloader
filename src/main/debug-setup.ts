import fs from "node:fs";
import path from "node:path";
import type { DebugSetupCheckResult, SupportTraceConfig } from "../shared/types";

const DEFAULT_PORT = 9868;
const DEFAULT_HOST = "127.0.0.1";
const AI_MANIFEST_FILE = "debug_ai_manifest.json";

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

export function getDebugSetupCheck(baseDir: string): DebugSetupCheckResult {
  const host = readHost(baseDir);
  const port = readPort(baseDir);
  const token = readToken(baseDir);
  const tokenPath = path.join(baseDir, "debug_token.txt");
  const aiManifestPath = path.join(baseDir, AI_MANIFEST_FILE);
  const traceConfigPath = path.join(baseDir, "trace_config.json");
  const traceLogPath = path.join(baseDir, "trace.log");
  const traceConfig = readTraceConfig(baseDir);
  const localOnly = /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!token) {
    warnings.push("debug_token.txt fehlt oder ist leer. Der Debug-Server startet dann nicht.");
  }
  if (localOnly) {
    warnings.push("Der Debug-Server ist aktuell nur lokal erreichbar. Für Remote-Support debug_host.txt auf 0.0.0.0 setzen.");
  } else {
    notes.push("Der Debug-Server ist für Remote-Zugriff konfiguriert. Firewall oder Provider-Regeln müssen separat offen sein.");
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
  notes.push("Die App kann Netzwerk-Firewalls oder Provider-Sicherheitsgruppen nicht direkt prüfen.");

  return {
    enabled: Boolean(token),
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
