import fs from "node:fs";
import path from "node:path";
import { logTimestamp } from "./log-timestamp";

/**
 * Session-eigenes Rename-Protokoll auf dem DESKTOP des Nutzers.
 *
 * Ziel (User-Anforderung): bei zukuenftigen Renaming-Problemen eine luekenlose,
 * sofort auffindbare Uebersicht haben — JEDER Umbenenn-/Verschiebevorgang wird
 * protokolliert UND danach verifiziert (liegt die Datei wirklich unter dem
 * Zielnamen auf der Platte? ist die Quelle weg?). Nur weil fs.rename "ok" meldet,
 * heisst das nicht, dass das Ergebnis stimmt (Gross-/Kleinschreibung, Unicode-
 * Normalisierung, halb-fertiger EXDEV-Copy ohne geloeschte Quelle, ...).
 *
 * - Pro Programm-Sitzung eine eigene Datei: <Desktop>/Downloader-Log/rename-session_<ts>.txt
 * - Der Ordner wird beim Start angelegt UND vor JEDEM Schreibvorgang selbstheilend
 *   neu angelegt (mkdir recursive) — wird er zur Laufzeit geloescht, ist er beim
 *   naechsten Rename sofort wieder da, inkl. neu geschriebenem Session-Header.
 * - Synchroner Append (wie rename-log.ts), kein gepufferter Flush: Renames sind
 *   selten genug, und so gibt es kein "geloescht-waehrend-Flush"-Zeitfenster.
 * - Schlaegt das Logging fehl, wird der Fehler verschluckt — Logging darf einen
 *   Download niemals abbrechen.
 */

type DesktopRenameLevel = "INFO" | "WARN" | "ERROR";

const FOLDER_NAME = "Downloader-Log";

let logDir: string | null = null;
let logFilePath: string | null = null;
let sessionHeader = "";

/** Lokaler Zeitstempel fuer den DATEINAMEN (keine Doppelpunkte — unter Windows
 *  in Dateinamen verboten): YYYY-MM-DD_HH-MM-SS in lokaler Zeit. */
function fileTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
    + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

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

/** Stellt sicher, dass Ordner UND Session-Datei existieren (selbstheilend, auch
 *  wenn beides zur Laufzeit geloescht wurde). Gibt false zurueck, wenn das
 *  Logging nicht initialisiert ist oder das Anlegen scheitert. */
function ensureWritable(): boolean {
  if (!logDir || !logFilePath) {
    return false;
  }
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (!fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, sessionHeader, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/** Initialisiert das Desktop-Rename-Log fuer diese Sitzung. `desktopDir` ist der
 *  Desktop-Pfad (app.getPath("desktop")). Faellt still auf no-op zurueck, wenn der
 *  Pfad fehlt oder nicht beschreibbar ist. */
export function initDesktopRenameLog(desktopDir: string | null | undefined): void {
  try {
    const base = String(desktopDir || "").trim();
    if (!base) {
      logDir = null;
      logFilePath = null;
      return;
    }
    logDir = path.join(base, FOLDER_NAME);
    logFilePath = path.join(logDir, `rename-session_${fileTimestamp()}.txt`);
    sessionHeader = `=== Rename-Session gestartet: ${logTimestamp()} ===\n`
      + "Diese Datei protokolliert JEDEN Umbenenn-/Verschiebevorgang dieser Programm-Sitzung\n"
      + "und verifiziert nach jedem Vorgang, ob die Datei wirklich unter dem Zielnamen auf der\n"
      + "Platte liegt (und die Quelle verschwunden ist). [INFO]=ok, [ERROR]=Verifikation gescheitert.\n\n";
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logFilePath, sessionHeader, "utf8");
  } catch {
    logDir = null;
    logFilePath = null;
  }
}

/** Schreibt eine Zeile ins Desktop-Rename-Log. Tut nichts, wenn nicht
 *  initialisiert; verschluckt jeden Schreibfehler (darf nie einen Download
 *  abbrechen). */
export function logDesktopRename(level: DesktopRenameLevel, message: string, fields?: Record<string, unknown>): void {
  if (!ensureWritable() || !logFilePath) {
    return;
  }
  try {
    fs.appendFileSync(logFilePath, `${logTimestamp()} [${level}] ${message}${formatFields(fields)}\n`, "utf8");
  } catch {
    // Logging darf einen Download niemals abbrechen.
  }
}

export function getDesktopRenameLogPath(): string | null {
  if (!logFilePath) {
    return null;
  }
  try {
    return fs.existsSync(logFilePath) ? logFilePath : null;
  } catch {
    return null;
  }
}

export function shutdownDesktopRenameLog(): void {
  if (ensureWritable() && logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `=== Rename-Session beendet: ${logTimestamp()} ===\n`, "utf8");
    } catch {
      // ignore
    }
  }
  logDir = null;
  logFilePath = null;
}

export interface RenameVerification {
  /** Gesamtergebnis: Datei liegt unter dem EXAKT erwarteten Namen vor und (sofern kein
   *  In-Place-Rename) die Quelle ist verschwunden. */
  ok: boolean;
  /** Empfohlenes Log-Level: ERROR (Rename nicht vollzogen / falscher Name),
   *  WARN (vollzogen, aber Schreibweise nicht pruefbar), INFO (alles ok). */
  level: "INFO" | "WARN" | "ERROR";
  /** Zieldatei (egal welche Schreibweise) auf der Platte vorhanden? */
  targetExists: boolean;
  /** Tatsaechlicher Name auf der Platte (Gross-/Kleinschreibung wie wirklich
   *  gespeichert), oder null wenn nicht gefunden / Verzeichnis nicht lesbar. */
  onDiskName: string | null;
  /** onDiskName === erwarteter Zielname (exakt, case-sensitive)? */
  nameMatches: boolean;
  /** Quelldatei verschwunden (Rename wirklich vollzogen, kein halb-fertiger Copy)? */
  sourceGone: boolean;
  /** Groesse der Zieldatei in Bytes, oder null. */
  targetSize: number | null;
  /** Menschenlesbarer Grund, wenn nicht sauber INFO. */
  reason: string;
}

/** Repliziert download-manager.toWindowsLongPathIfNeeded (ein Import waere zirkulaer:
 *  download-manager -> desktop-rename-log). Node fs-Aufrufe scheitern unter Windows fuer
 *  absolute Pfade >=248 Zeichen, sofern nicht mit \\?\ / \\?\UNC\ praefixiert — und genau
 *  solche langen Scene-Release-Pfade benennt diese App um. OHNE dieses Prefix wuerden
 *  statSync/readdirSync in der Verifikation auf langen Pfaden faelschlich scheitern
 *  (falsches "Ziel nicht gefunden" UND falsches "Quelle weg" -> falsches OK, das einen
 *  halb-fertigen Verschiebevorgang maskiert). */
function toLongPath(filePath: string): string {
  const absolute = path.resolve(String(filePath || ""));
  if (process.platform !== "win32") {
    return absolute;
  }
  if (!absolute || absolute.startsWith("\\\\?\\")) {
    return absolute;
  }
  if (absolute.length < 248) {
    return absolute;
  }
  if (absolute.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${absolute.slice(2)}`;
  }
  return `\\\\?\\${absolute}`;
}

/** Echter On-Disk-Name (korrekte Schreibweise) fuer `requested` aus den
 *  Verzeichnis-Eintraegen, oder null wenn das Verzeichnis nicht lesbar war
 *  (entries===null) bzw. nichts passt. */
function resolveOnDiskName(requested: string, entries: string[] | null): string | null {
  if (entries === null) {
    return null;
  }
  const requestedLower = requested.toLowerCase();
  return entries.find((entry) => entry === requested)
    || entries.find((entry) => entry.toLowerCase() === requestedLower)
    || requested;
}

/** Baut das Verifikations-Ergebnis aus den (sync ODER async) erhobenen Roh-Fakten.
 *  `dirEntries`=null bedeutet "Zielverzeichnis war nicht lesbar". */
function buildVerification(
  sourcePath: string,
  targetPath: string,
  facts: { targetExists: boolean; targetSize: number | null; dirEntries: string[] | null; sourceExists: boolean }
): RenameVerification {
  const requested = path.basename(targetPath);
  const dirReadFailed = facts.targetExists && facts.dirEntries === null;
  const onDiskName = facts.targetExists ? resolveOnDiskName(requested, facts.dirEntries) : null;

  // In-Place-Rename (reine Gross-/Kleinschreibungs-Korrektur auf case-insensitivem FS):
  // Quelle == Ziel -> "Quelle weg" gilt nicht.
  const samePath = path.resolve(sourcePath).toLowerCase() === path.resolve(targetPath).toLowerCase();
  const sourceGone = samePath ? true : !facts.sourceExists;
  const nameMatches = facts.targetExists && !dirReadFailed && onDiskName === requested;

  const problems: string[] = [];
  let level: "INFO" | "WARN" | "ERROR" = "INFO";
  if (!facts.targetExists) {
    problems.push("Zieldatei nach Rename NICHT gefunden");
    level = "ERROR";
  } else if (!dirReadFailed && !nameMatches) {
    problems.push(`On-Disk-Name weicht ab (ist "${onDiskName}", erwartet "${requested}")`);
    level = "ERROR";
  }
  if (!samePath && facts.targetExists && !sourceGone) {
    problems.push("Quelldatei existiert noch (moeglicher halb-fertiger Verschiebevorgang)");
    level = "ERROR";
  }
  if (level === "INFO" && dirReadFailed) {
    // Datei da + Quelle weg, aber Schreibweise ungeprueft — KEIN stilles OK.
    problems.push("Zielverzeichnis nicht lesbar — Schreibweise nicht verifiziert");
    level = "WARN";
  }

  return {
    ok: level === "INFO",
    level,
    targetExists: facts.targetExists,
    onDiskName,
    nameMatches,
    sourceGone,
    targetSize: facts.targetSize,
    reason: problems.join("; ")
  };
}

/** Verifiziert NACH einem Rename SYNCHRON, ob das Ergebnis wirklich stimmt — der Kern
 *  der User-Anforderung ("nur weil er renaming sagt heisst es nicht das es klappt").
 *  Fuer die synchronen Rename-Sites (startup-Dedup, Suffix-Fix, Deobfuskation). Rein
 *  lesend, wirft nie. fs-Aufrufe ueber toLongPath (lange Windows-Pfade!). */
export function verifyRename(sourcePath: string, targetPath: string): RenameVerification {
  const longTarget = toLongPath(targetPath);
  let targetExists = false;
  let targetSize: number | null = null;
  try {
    const stat = fs.statSync(longTarget);
    targetExists = true;
    targetSize = stat.size;
  } catch {
    targetExists = false;
  }
  let dirEntries: string[] | null = null;
  if (targetExists) {
    try {
      dirEntries = fs.readdirSync(path.dirname(longTarget));
    } catch {
      dirEntries = null;
    }
  }
  let sourceExists = false;
  try {
    fs.statSync(toLongPath(sourcePath));
    sourceExists = true;
  } catch {
    sourceExists = false;
  }
  return buildVerification(sourcePath, targetPath, { targetExists, targetSize, dirEntries, sourceExists });
}

/** Asynchrone Verifikation — fuer den Media-Rename-Hot-Path (renamePathWithExdevFallback),
 *  damit KEIN synchrones statSync/readdirSync den Electron-Main-Loop in Saison-Pack-
 *  Rename-Schleifen blockiert (Projekt-Regel: kein sync I/O in Hot Paths). Wirft nie. */
export async function verifyRenameAsync(sourcePath: string, targetPath: string): Promise<RenameVerification> {
  const longTarget = toLongPath(targetPath);
  let targetExists = false;
  let targetSize: number | null = null;
  try {
    const stat = await fs.promises.stat(longTarget);
    targetExists = true;
    targetSize = stat.size;
  } catch {
    targetExists = false;
  }
  let dirEntries: string[] | null = null;
  if (targetExists) {
    try {
      dirEntries = await fs.promises.readdir(path.dirname(longTarget));
    } catch {
      dirEntries = null;
    }
  }
  let sourceExists = false;
  try {
    await fs.promises.stat(toLongPath(sourcePath));
    sourceExists = true;
  } catch {
    sourceExists = false;
  }
  return buildVerification(sourcePath, targetPath, { targetExists, targetSize, dirEntries, sourceExists });
}
