import type { AppSettings, SessionState, HistoryEntry } from "../shared/types";

export type BackupKind = "full" | "settings-only";

export interface BackupMcpRemote {
  allowlist: string[];
  port: number;
  hostMode: "local" | "network";
}

export interface BackupPayload {
  version: 2;
  kind: BackupKind;
  appVersion: string;
  exportedAt: string;
  settings: AppSettings;
  session?: SessionState;
  history?: HistoryEntry[];
  mcpRemote?: BackupMcpRemote;
}

export interface BuildBackupInput {
  settings: AppSettings;
  appVersion: string;
  exportedAt: string;
  /** Only bundled when includeDownloads is true. */
  session: SessionState;
  history: HistoryEntry[];
  mcpRemote?: BackupMcpRemote;
}

/**
 * Build the backup payload. By default ("Download-Liste mitsichern" off) the
 * payload contains ONLY settings — no session, no history. The download list is
 * bundled solely when settings.backupIncludeDownloads is true. An explicit kind
 * marker makes the import side unambiguous and survives hand-edited files.
 */
export function buildBackupPayload(input: BuildBackupInput): BackupPayload {
  const includeDownloads = Boolean(input.settings.backupIncludeDownloads);
  const base: BackupPayload = {
    version: 2,
    kind: includeDownloads ? "full" : "settings-only",
    appVersion: input.appVersion,
    exportedAt: input.exportedAt,
    settings: input.settings
  };
  if (includeDownloads) {
    base.session = input.session;
    base.history = input.history;
  }
  if (Boolean(input.settings.backupIncludeMcp) && input.mcpRemote) {
    base.mcpRemote = input.mcpRemote;
  }
  return base;
}

export interface McpRemoteRestore {
  host?: "127.0.0.1" | "0.0.0.0";
  port?: number;
  allowlist?: string[];
}

export function resolveMcpRemoteRestore(section: unknown): McpRemoteRestore | null {
  if (!section || typeof section !== "object") {
    return null;
  }
  const s = section as { allowlist?: unknown; port?: unknown; hostMode?: unknown };
  const allowlist = Array.isArray(s.allowlist)
    ? s.allowlist.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : undefined;
  const port = (typeof s.port === "number" && Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535) ? s.port : undefined;
  let host: "127.0.0.1" | "0.0.0.0" | undefined;
  if (s.hostMode === "network") {
    host = allowlist && allowlist.length > 0 ? "0.0.0.0" : "127.0.0.1";
  } else if (s.hostMode === "local") {
    host = "127.0.0.1";
  }
  if (host === undefined && port === undefined && allowlist === undefined) {
    return null;
  }
  return { host, port, allowlist };
}

export interface ImportPlan {
  valid: boolean;
  /** Restore the download list (session + history) and relaunch. */
  restoreDownloads: boolean;
  message: string;
}

/**
 * Decide how to apply an imported backup based on what the FILE physically
 * contains — NOT the local toggle. A backup without a session restores settings
 * only (no queue wipe, no relaunch); a full backup (with session) restores the
 * queue too. This way an old full backup still restores fully even if the local
 * toggle is currently off, and a settings-only backup never disturbs a running
 * queue.
 */
export function planBackupImport(parsed: unknown): ImportPlan {
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, restoreDownloads: false, message: "Kein gültiges Backup (settings fehlen)" };
  }
  const record = parsed as Record<string, unknown>;
  if (!record.settings || typeof record.settings !== "object") {
    return { valid: false, restoreDownloads: false, message: "Kein gültiges Backup (settings fehlen)" };
  }
  const hasSession = Boolean(record.session) && typeof record.session === "object";
  return {
    valid: true,
    restoreDownloads: hasSession,
    message: hasSession
      ? "Backup wiederhergestellt – App startet automatisch neu…"
      : "Einstellungen wiederhergestellt"
  };
}
