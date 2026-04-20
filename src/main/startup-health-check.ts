import fs from "node:fs";
import path from "node:path";
import { AppSettings } from "../shared/types";
import { parseDebridLinkApiKeys } from "../shared/debrid-link-keys";
import { parseMegaDebridAccounts } from "../shared/mega-debrid-accounts";
import { StoragePaths } from "./storage";

/** Startup Health-Check: runs once at app boot and surfaces potential problem
 *  states BEFORE the user hits them mid-download.
 *
 *  Goals:
 *   - Warn on missing / unreachable download directory
 *   - Warn on low disk space (< 5 GB free)
 *   - Warn when no debrid provider is configured (app is effectively offline)
 *   - Warn when state file is suspiciously large (>50 MB → pruning recommended)
 *
 *  Non-goals: blocking startup. The check only logs — the app continues. */

export type HealthCheckSeverity = "INFO" | "WARN" | "ERROR";

export interface HealthCheckFinding {
  severity: HealthCheckSeverity;
  code: string;
  message: string;
  hint?: string;
}

export interface HealthCheckReport {
  findings: HealthCheckFinding[];
  errorCount: number;
  warnCount: number;
  infoCount: number;
}

const LOW_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const LARGE_STATE_FILE_BYTES = 50 * 1024 * 1024;     // 50 MB

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function getFileSizeBytes(p: string): number {
  try {
    const stat = fs.statSync(p);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Attempt a tiny write-probe in the given directory. Returns true on
 *  success, false if the directory isn't writable. We write and immediately
 *  delete a uniquely-named temp file so we never leave garbage behind. */
function isWritable(dir: string): boolean {
  const probe = path.join(dir, `.rddl-health-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(probe, "x", { encoding: "utf8" });
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Query free disk space for a given path. Returns null if unsupported or
 *  the query fails — callers treat null as "unknown" and skip the check. */
function getFreeDiskSpaceBytes(target: string): number | null {
  try {
    // fs.statfsSync is available on Node 18.15+; on Windows it still maps to
    // the underlying volume so it works for download dirs on any drive.
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync;
    if (typeof statfs !== "function") {
      return null;
    }
    const result = statfs(target);
    const bavail = BigInt(result.bavail);
    const bsize = BigInt(result.bsize);
    const free = bavail * bsize;
    if (free > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Number(free);
  } catch {
    return null;
  }
}

function countConfiguredProviders(settings: AppSettings): { count: number; providers: string[] } {
  const providers: string[] = [];
  if (settings.token?.trim() || settings.realDebridUseWebLogin) {
    providers.push("Real-Debrid");
  }
  if (settings.allDebridToken?.trim() || settings.allDebridUseWebLogin) {
    providers.push("AllDebrid");
  }
  if (settings.bestToken?.trim() || settings.bestDebridUseWebLogin) {
    providers.push("BestDebrid");
  }
  if (settings.oneFichierApiKey?.trim()) {
    providers.push("1Fichier");
  }
  if (settings.ddownloadLogin?.trim() && settings.ddownloadPassword?.trim()) {
    providers.push("DDownload");
  }
  if (settings.linkSnappyLogin?.trim() && settings.linkSnappyPassword?.trim()) {
    providers.push("LinkSnappy");
  }
  const dlKeys = parseDebridLinkApiKeys(settings.debridLinkApiKeys || "");
  if (dlKeys.length > 0) {
    providers.push(`Debrid-Link (${dlKeys.length} Key${dlKeys.length === 1 ? "" : "s"})`);
  }
  const megaAccounts = parseMegaDebridAccounts(settings.megaCredentials || "");
  const legacyMegaConfigured = Boolean(settings.megaLogin?.trim() && settings.megaPassword?.trim());
  if (megaAccounts.length > 0) {
    providers.push(`Mega-Debrid (${megaAccounts.length} Acc)`);
  } else if (legacyMegaConfigured) {
    providers.push("Mega-Debrid");
  }
  return { count: providers.length, providers };
}

/** Pure check function: takes inputs, returns findings. Kept side-effect-free
 *  so it's trivial to unit-test — the caller handles logging / persistence. */
export function runStartupHealthCheck(settings: AppSettings, storagePaths: StoragePaths): HealthCheckReport {
  const findings: HealthCheckFinding[] = [];

  // ── 1. Download directory ───────────────────────────────────────────────
  const outputDir = String(settings.outputDir || "").trim();
  if (!outputDir) {
    findings.push({
      severity: "WARN",
      code: "outputDir_missing",
      message: "Kein Download-Ziel-Verzeichnis konfiguriert",
      hint: "In den Einstellungen unter 'Downloads' einen Ziel-Ordner setzen, sonst koennen keine Downloads starten."
    });
  } else if (!safeExists(outputDir)) {
    findings.push({
      severity: "WARN",
      code: "outputDir_not_found",
      message: `Download-Ziel-Ordner existiert nicht: ${outputDir}`,
      hint: "Der Ordner wird beim ersten Download automatisch erstellt, sofern der Elternordner existiert und beschreibbar ist."
    });
  } else if (!isWritable(outputDir)) {
    findings.push({
      severity: "ERROR",
      code: "outputDir_not_writable",
      message: `Download-Ziel-Ordner ist NICHT beschreibbar: ${outputDir}`,
      hint: "Rechte pruefen oder anderen Ordner waehlen. Downloads werden sonst direkt scheitern."
    });
  } else {
    // Check available disk space only when the directory is actually usable
    const freeBytes = getFreeDiskSpaceBytes(outputDir);
    if (freeBytes !== null && freeBytes < LOW_DISK_SPACE_BYTES) {
      const freeMb = Math.round(freeBytes / (1024 * 1024));
      findings.push({
        severity: "WARN",
        code: "low_disk_space",
        message: `Wenig freier Speicher im Download-Ordner: ~${freeMb} MB verfuegbar (Schwelle ${LOW_DISK_SPACE_BYTES / (1024 * 1024 * 1024)} GB)`,
        hint: "Groessere Downloads koennen auf halbem Weg fehlschlagen. Vorher Platz schaffen oder anderen Ordner waehlen."
      });
    }
  }

  // ── 2. Provider-Credentials ─────────────────────────────────────────────
  const { count, providers } = countConfiguredProviders(settings);
  if (count === 0) {
    findings.push({
      severity: "WARN",
      code: "no_provider_configured",
      message: "Kein Debrid-Provider konfiguriert — Downloads werden nicht funktionieren",
      hint: "In den Einstellungen mindestens einen Provider (Real-Debrid, Mega-Debrid, Debrid-Link, ...) einrichten."
    });
  } else {
    findings.push({
      severity: "INFO",
      code: "providers_configured",
      message: `Konfigurierte Provider: ${providers.join(", ")}`
    });
  }

  // ── 3. State-File-Groesse ──────────────────────────────────────────────
  if (safeExists(storagePaths.sessionFile)) {
    const sizeBytes = getFileSizeBytes(storagePaths.sessionFile);
    if (sizeBytes > LARGE_STATE_FILE_BYTES) {
      const sizeMb = Math.round(sizeBytes / (1024 * 1024));
      findings.push({
        severity: "WARN",
        code: "large_state_file",
        message: `State-Datei ist sehr gross: ${sizeMb} MB (${path.basename(storagePaths.sessionFile)})`,
        hint: "Alte abgeschlossene Pakete aus der Queue entfernen, damit Startup + Save schneller werden."
      });
    }
  }

  // ── 4. Storage-Basis-Verzeichnis muss beschreibbar sein (fuer Logs) ────
  if (!safeExists(storagePaths.baseDir)) {
    findings.push({
      severity: "ERROR",
      code: "baseDir_missing",
      message: `Runtime-Verzeichnis existiert nicht: ${storagePaths.baseDir}`,
      hint: "Ohne Runtime-Verzeichnis koennen weder Settings noch Session-State persistiert werden."
    });
  } else if (!isWritable(storagePaths.baseDir)) {
    findings.push({
      severity: "ERROR",
      code: "baseDir_not_writable",
      message: `Runtime-Verzeichnis ist NICHT beschreibbar: ${storagePaths.baseDir}`,
      hint: "Rechte auf das Runtime-Verzeichnis pruefen (%APPDATA%/Real-Debrid-Downloader/runtime)."
    });
  }

  const errorCount = findings.filter((f) => f.severity === "ERROR").length;
  const warnCount = findings.filter((f) => f.severity === "WARN").length;
  const infoCount = findings.filter((f) => f.severity === "INFO").length;
  return { findings, errorCount, warnCount, infoCount };
}
