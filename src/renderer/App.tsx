import { CSSProperties, DragEvent, KeyboardEvent, ReactElement, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseDebridLinkApiKeys } from "../shared/debrid-link-keys";
import type {
  AllDebridHostInfo,
  AppSettings,
  AppTheme,
  BandwidthScheduleEntry,
  DebugSetupCheckResult,
  DebridFallbackProvider,
  DebridLinkHostLimitInfo,
  DebridProvider,
  DownloadItem,
  DownloadStats,
  DuplicatePolicy,
  HistoryEntry,
  PackageEntry,
  StartConflictEntry,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress
} from "../shared/types";
import {
  getDebridLinkApiKeyTotalUsageBytes,
  getDebridLinkApiKeyDailyLimitBytes,
  getDebridLinkApiKeyDailyRemainingBytes,
  getDebridLinkApiKeyDailyUsageBytes,
  getProviderDailyLimitBytes,
  getProviderDailyRemainingBytes,
  getProviderTotalUsageBytes,
  getProviderDailyUsageBytes,
  getProviderUsageDayKey
} from "../shared/provider-daily-limits";
import { reorderPackageOrderByDrop, sortPackageOrderByName, sortPackagesForDisplay } from "./package-order";

type Tab = "collector" | "downloads" | "history" | "statistics" | "settings";
type SettingsSubTab = "allgemein" | "accounts" | "entpacken" | "geschwindigkeit" | "bereinigung" | "updates";

interface CollectorTab {
  id: string;
  name: string;
  text: string;
}

interface StartConflictPromptState {
  entry: StartConflictEntry;
  applyToAll: boolean;
}

interface ConfirmPromptState {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  details?: string;
  detailsLabel?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  packageId: string;
  itemId?: string;
}

interface LinkPopupState {
  title: string;
  links: { name: string; url: string }[];
  isPackage: boolean;
}

type AccountService = "realdebrid" | "megadebrid-api" | "megadebrid-web" | "bestdebrid" | "alldebrid" | "ddownload" | "onefichier" | "debridlink" | "linksnappy";
type AccountKind =
  | "realdebrid-api"
  | "realdebrid-web"
  | "megadebrid-api"
  | "megadebrid-web"
  | "bestdebrid-api"
  | "bestdebrid-web"
  | "alldebrid-api"
  | "alldebrid-web"
  | "ddownload-login"
  | "onefichier-api"
  | "debridlink-api"
  | "linksnappy-login";

type AccountQuickAction = "realdebrid-login" | "bestdebrid-cookies" | "alldebrid-login" | "alldebrid-status";
type AccountColumnKey = "service" | "mode" | "status" | "secret";

interface AccountOption {
  kind: AccountKind;
  service: AccountService;
  serviceLabel: string;
  title: string;
  modeLabel: string;
  pickerDescription: string;
  needsToken?: boolean;
  needsCredentials?: boolean;
}

interface AccountDialogState {
  mode: "create" | "edit";
  kind: AccountKind | null;
  token: string;
  login: string;
  password: string;
  dailyLimitGb: string;
  keyDailyLimitGbById: Record<string, string>;
}

interface DebridLinkAccountKeyEntry {
  id: string;
  label: string;
  token: string;
  masked: string;
  disabled: boolean;
  dailyUsedBytes: number;
  totalUsedBytes: number;
  dailyLimitBytes: number;
  dailyRemainingBytes: number | null;
  dailyLimitReached: boolean;
}

interface ConfiguredAccountEntry {
  kind: AccountKind;
  service: AccountService;
  provider: DebridProvider;
  serviceLabel: string;
  modeLabel: string;
  statusLabel: string;
  summary: string;
  summaryLines: string[];
  note: string;
  disabled: boolean;
  dailyUsedBytes: number;
  totalUsedBytes: number;
  dailyLimitBytes: number;
  dailyRemainingBytes: number | null;
  dailyLimitReached: boolean;
  debridLinkKeys: DebridLinkAccountKeyEntry[];
}

function buildDebugSetupDetails(setup: DebugSetupCheckResult): string {
  const formatDiskLine = (label: string, value: DebugSetupCheckResult["diskSpace"]["runtime"]): string => {
    if (value.freeBytes === null || value.totalBytes === null) {
      return `${label}: unbekannt (${value.path})`;
    }
    return `${label}: ${humanSize(value.freeBytes)} frei von ${humanSize(value.totalBytes)} (${value.freePercent ?? "?"}% frei) | ${value.path}`;
  };

  const formatFileLine = (label: string, bytes: number): string => `${label}: ${humanSize(bytes)}`;
  const lines: string[] = [
    `Status: ${setup.status === "ok" ? "OK" : "Warnung"}`,
    `Debug-Server aktiv: ${setup.enabled ? "ja" : "nein"}`,
    `Runtime-Ordner: ${setup.runtimeBaseDir}`,
    `Host: ${setup.host}`,
    `Port: ${setup.port}`,
    `Token-Datei: ${setup.tokenPath}`,
    `KI-Manifest: ${setup.aiManifestPresent ? "vorhanden" : "fehlt"} (${setup.aiManifestPath})`,
    `Trace aktiv: ${setup.traceEnabled ? "ja" : "nein"}`,
    `Trace-Auto-Ende: ${setup.traceAutoDisableAt || "nicht gesetzt"}`,
    "",
    "Freier Speicherplatz:",
    formatDiskLine("Runtime", setup.diskSpace.runtime),
    formatDiskLine("Download-Ziel", setup.diskSpace.output),
    formatDiskLine("Entpack-Ziel", setup.diskSpace.extract),
    "",
    "Support-Logs:",
    formatFileLine("Gesamt", setup.logSummary.totalBytes),
    formatFileLine("Hauptlog", setup.logSummary.main.bytes + setup.logSummary.mainBackup.bytes),
    formatFileLine("Audit", setup.logSummary.audit.bytes + setup.logSummary.auditBackup.bytes),
    formatFileLine("Rename", setup.logSummary.rename.bytes + setup.logSummary.renameBackup.bytes),
    formatFileLine("Trace", setup.logSummary.trace.bytes + setup.logSummary.traceBackup.bytes),
    `${formatFileLine("Session-Logs", setup.logSummary.session.bytes + setup.logSummary.sessionLogs.bytes)} | Dateien: ${setup.logSummary.sessionLogs.fileCount}`,
    `${formatFileLine("Paket-Logs", setup.logSummary.packageLogs.bytes)} | Dateien: ${setup.logSummary.packageLogs.fileCount}`,
    `${formatFileLine("Item-Logs", setup.logSummary.itemLogs.bytes)} | Dateien: ${setup.logSummary.itemLogs.fileCount}`,
    "",
    "Support-Bundle:",
    `${formatFileLine("Schätzwert", setup.supportBundle.estimatedBytes)} | Einträge: ${setup.supportBundle.estimatedEntries}`,
    formatFileLine("Doppelte Live-Log-Spiegelung", setup.supportBundle.duplicatedLiveLogBytes),
    setup.supportBundle.note,
    "",
    "Lokale URLs:",
    setup.localUrls.health,
    setup.localUrls.meta,
    setup.localUrls.diagnostics,
    "",
    "Remote-Vorlagen:",
    setup.remoteUrlTemplates.health,
    setup.remoteUrlTemplates.meta,
    setup.remoteUrlTemplates.diagnostics
  ];

  if (setup.warnings.length > 0) {
    lines.push("", "Warnungen:");
    for (const warning of setup.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (setup.notes.length > 0) {
    lines.push("", "Hinweise:");
    for (const note of setup.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

const ACCOUNT_OPTIONS: AccountOption[] = [
  {
    kind: "realdebrid-api",
    service: "realdebrid",
    serviceLabel: "Real-Debrid",
    title: "Real-Debrid API",
    modeLabel: "API",
    pickerDescription: "Direkter Zugriff über API-Token.",
    needsToken: true
  },
  {
    kind: "realdebrid-web",
    service: "realdebrid",
    serviceLabel: "Real-Debrid",
    title: "Real-Debrid Web",
    modeLabel: "Web",
    pickerDescription: "Login über Browserfenster statt Token."
  },
  {
    kind: "megadebrid-api",
    service: "megadebrid-api",
    serviceLabel: "Mega-Debrid",
    title: "Mega-Debrid API",
    modeLabel: "API",
    pickerDescription: "Login nur über die API, ohne Web-Fallback.",
    needsCredentials: true
  },
  {
    kind: "megadebrid-web",
    service: "megadebrid-web",
    serviceLabel: "Mega-Debrid",
    title: "Mega-Debrid Web",
    modeLabel: "Web",
    pickerDescription: "Login nur über Web, ohne API-Fallback.",
    needsCredentials: true
  },
  {
    kind: "bestdebrid-api",
    service: "bestdebrid",
    serviceLabel: "BestDebrid",
    title: "BestDebrid API",
    modeLabel: "API",
    pickerDescription: "Direkter Zugriff über API-Token.",
    needsToken: true
  },
  {
    kind: "bestdebrid-web",
    service: "bestdebrid",
    serviceLabel: "BestDebrid",
    title: "BestDebrid Web",
    modeLabel: "Web",
    pickerDescription: "Cookie-Import aus dem Browser statt API-Token."
  },
  {
    kind: "alldebrid-api",
    service: "alldebrid",
    serviceLabel: "AllDebrid",
    title: "AllDebrid API",
    modeLabel: "API",
    pickerDescription: "Direkter Zugriff über API-Key.",
    needsToken: true
  },
  {
    kind: "alldebrid-web",
    service: "alldebrid",
    serviceLabel: "AllDebrid",
    title: "AllDebrid Web",
    modeLabel: "Web",
    pickerDescription: "Login über Browserfenster für reCAPTCHA.",
  },
  {
    kind: "ddownload-login",
    service: "ddownload",
    serviceLabel: "DDownload",
    title: "DDownload Login",
    modeLabel: "Login",
    pickerDescription: "Direkter Login für ddownload.com und ddl.to.",
    needsCredentials: true
  },
  {
    kind: "onefichier-api",
    service: "onefichier",
    serviceLabel: "1Fichier",
    title: "1Fichier API",
    modeLabel: "API",
    pickerDescription: "API-Key für 1fichier.com.",
    needsToken: true
  },
  {
    kind: "debridlink-api",
    service: "debridlink",
    serviceLabel: "Debrid-Link",
    title: "Debrid-Link API",
    modeLabel: "API",
    pickerDescription: "API-Key(s) für debrid-link.com. Mehrere Keys zeilenweise für Multi-Account.",
    needsToken: true
  },
  {
    kind: "linksnappy-login",
    service: "linksnappy",
    serviceLabel: "LinkSnappy",
    title: "LinkSnappy Web",
    modeLabel: "Web",
    pickerDescription: "Login für linksnappy.com mit Benutzername und Passwort.",
    needsCredentials: true
  }
];

const ACCOUNT_SERVICES: AccountService[] = ["realdebrid", "megadebrid-api", "megadebrid-web", "bestdebrid", "alldebrid", "ddownload", "onefichier", "debridlink", "linksnappy"];
const ACCOUNT_LIMIT_BYTES_PER_GIB = 1024 * 1024 * 1024;
const ACCOUNT_COLUMN_STORAGE_KEY = "rd-account-column-widths-v2";
const ACCOUNT_COLUMN_DEFAULT_WIDTHS: Record<AccountColumnKey, number> = {
  service: 240,
  mode: 96,
  status: 320,
  secret: 210
};
const ACCOUNT_COLUMN_MIN_WIDTHS: Record<AccountColumnKey, number> = {
  service: 180,
  mode: 80,
  status: 180,
  secret: 140
};

function loadAccountColumnWidths(): Record<AccountColumnKey, number> {
  if (typeof window === "undefined") {
    return { ...ACCOUNT_COLUMN_DEFAULT_WIDTHS };
  }
  try {
    const raw = window.localStorage.getItem(ACCOUNT_COLUMN_STORAGE_KEY);
    if (!raw) {
      return { ...ACCOUNT_COLUMN_DEFAULT_WIDTHS };
    }
    const parsed = JSON.parse(raw) as Partial<Record<AccountColumnKey, unknown>>;
    return {
      service: Math.max(ACCOUNT_COLUMN_MIN_WIDTHS.service, Number(parsed.service) || ACCOUNT_COLUMN_DEFAULT_WIDTHS.service),
      mode: Math.max(ACCOUNT_COLUMN_MIN_WIDTHS.mode, Number(parsed.mode) || ACCOUNT_COLUMN_DEFAULT_WIDTHS.mode),
      status: Math.max(ACCOUNT_COLUMN_MIN_WIDTHS.status, Number(parsed.status) || ACCOUNT_COLUMN_DEFAULT_WIDTHS.status),
      secret: Math.max(ACCOUNT_COLUMN_MIN_WIDTHS.secret, Number(parsed.secret) || ACCOUNT_COLUMN_DEFAULT_WIDTHS.secret)
    };
  } catch {
    return { ...ACCOUNT_COLUMN_DEFAULT_WIDTHS };
  }
}

function findAccountOption(kind: AccountKind): AccountOption {
  const option = ACCOUNT_OPTIONS.find((entry) => entry.kind === kind);
  if (!option) {
    throw new Error(`Unbekannter Account-Typ: ${kind}`);
  }
  return option;
}

function getAccountServiceProvider(service: AccountService): DebridProvider {
  return service as DebridProvider;
}

function formatAccountDailyLimitInput(limitBytes: number): string {
  if (limitBytes <= 0) {
    return "";
  }
  const gib = limitBytes / ACCOUNT_LIMIT_BYTES_PER_GIB;
  const precision = gib >= 100 ? 0 : gib >= 10 ? 1 : 2;
  return gib.toFixed(precision).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function parseAccountDailyLimitInputBytes(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed * ACCOUNT_LIMIT_BYTES_PER_GIB);
}

function buildDebridLinkKeyLimitInputs(rawKeys: string, values?: Record<string, string>, settings?: AppSettings): Record<string, string> {
  const next: Record<string, string> = {};
  for (const key of parseDebridLinkApiKeys(rawKeys)) {
    next[key.id] = values?.[key.id]
      ?? formatAccountDailyLimitInput(settings?.debridLinkApiKeyDailyLimitBytes?.[key.id] || 0);
  }
  return next;
}

function getAccountPickerFunctionLabel(option: AccountOption): string {
  switch (option.kind) {
    case "realdebrid-api":
    case "bestdebrid-api":
      return "API-Token";
    case "realdebrid-web":
    case "alldebrid-web":
      return "Browser-Login";
    case "megadebrid-api":
      return "Login + Passwort (API)";
    case "megadebrid-web":
      return "Login + Passwort (Web)";
    case "bestdebrid-web":
      return "Cookies.txt-Import";
    case "alldebrid-api":
    case "onefichier-api":
      return "API-Key";
    case "ddownload-login":
      return "Login + Passwort";
    default:
      return option.modeLabel;
  }
}

function hasMegaDebridCredentials(settings: AppSettings): boolean {
  return Boolean(settings.megaLogin.trim() && settings.megaPassword.trim());
}

function getConfiguredProvidersFromSettings(settings: AppSettings): DebridProvider[] {
  const list: DebridProvider[] = [];
  if (settings.token.trim() || settings.realDebridUseWebLogin) {
    list.push("realdebrid");
  }
  if (hasMegaDebridCredentials(settings) && settings.megaDebridApiEnabled) {
    list.push("megadebrid-api");
  }
  if (hasMegaDebridCredentials(settings) && settings.megaDebridWebEnabled) {
    list.push("megadebrid-web");
  }
  if (settings.bestDebridUseWebLogin || settings.bestToken.trim()) {
    list.push("bestdebrid");
  }
  if (settings.allDebridUseWebLogin || settings.allDebridToken.trim()) {
    list.push("alldebrid");
  }
  if ((settings.debridLinkApiKeys || "").trim()) {
    list.push("debridlink");
  }
  if ((settings.linkSnappyLogin || "").trim() && (settings.linkSnappyPassword || "").trim()) {
    list.push("linksnappy");
  }
  return list;
}

function getActiveProvidersFromSettings(settings: AppSettings): DebridProvider[] {
  const disabled = new Set(settings.disabledProviders || []);
  return getConfiguredProvidersFromSettings(settings).filter((p) => !disabled.has(p));
}

// Leitet die aktive Provider-Reihenfolge aus providerOrder ab,
// gefiltert auf tatsächlich konfigurierte und nicht deaktivierte Provider.
// Direkt-Hoster (onefichier, ddownload) werden ausgeschlossen.
const DIRECT_HOSTERS: ReadonlySet<DebridProvider> = new Set(["onefichier", "ddownload"]);

function normalizeProviderOrderForSettings(settings: AppSettings): DebridProvider[] {
  const active = new Set(getActiveProvidersFromSettings(settings).filter((p) => !DIRECT_HOSTERS.has(p)));
  // Behalte bestehende Reihenfolge aus providerOrder, filtere nicht-konfigurierte heraus
  const ordered = (settings.providerOrder || []).filter((p) => active.has(p));
  const inOrder = new Set(ordered);
  // Füge neue Provider hinten an, die noch nicht in der Reihenfolge sind
  for (const p of active) {
    if (!inOrder.has(p)) ordered.push(p);
  }
  return ordered;
}

function normalizeProviderSelectionForSettings(
  settings: AppSettings
): Pick<AppSettings, "providerOrder" | "providerPrimary" | "providerSecondary" | "providerTertiary"> {
  const providerOrder = normalizeProviderOrderForSettings(settings);
  return {
    providerOrder,
    providerPrimary: providerOrder[0] ?? settings.providerPrimary,
    providerSecondary: (providerOrder[1] ?? "none") as DebridFallbackProvider,
    providerTertiary: (providerOrder[2] ?? "none") as DebridFallbackProvider
  };
}

function getConfiguredAccountKind(settings: AppSettings, service: AccountService): AccountKind | null {
  switch (service) {
    case "realdebrid":
      if (settings.realDebridUseWebLogin) return "realdebrid-web";
      return settings.token.trim() ? "realdebrid-api" : null;
    case "megadebrid-api":
      return hasMegaDebridCredentials(settings) && settings.megaDebridApiEnabled ? "megadebrid-api" : null;
    case "megadebrid-web":
      return hasMegaDebridCredentials(settings) && settings.megaDebridWebEnabled ? "megadebrid-web" : null;
    case "bestdebrid":
      if (settings.bestDebridUseWebLogin) return "bestdebrid-web";
      return settings.bestToken.trim() ? "bestdebrid-api" : null;
    case "alldebrid":
      if (settings.allDebridUseWebLogin) return "alldebrid-web";
      return settings.allDebridToken.trim() ? "alldebrid-api" : null;
    case "ddownload":
      return settings.ddownloadLogin.trim() && settings.ddownloadPassword.trim() ? "ddownload-login" : null;
    case "onefichier":
      return settings.oneFichierApiKey.trim() ? "onefichier-api" : null;
    case "debridlink":
      return (settings.debridLinkApiKeys || "").trim() ? "debridlink-api" : null;
    case "linksnappy":
      return (settings.linkSnappyLogin || "").trim() && (settings.linkSnappyPassword || "").trim() ? "linksnappy-login" : null;
    default:
      return null;
  }
}

function maskValue(value: string, keepStart = 2, keepEnd = 2): string {
  const trimmed = value.trim();
  if (!trimmed) return "Nicht hinterlegt";
  if (trimmed.length <= keepStart + keepEnd) {
    return "*".repeat(trimmed.length);
  }
  return `${trimmed.slice(0, keepStart)}${"*".repeat(Math.max(4, trimmed.length - keepStart - keepEnd))}${trimmed.slice(-keepEnd)}`;
}

function summarizeAccount(kind: AccountKind, settings: AppSettings): string {
  switch (kind) {
    case "realdebrid-api":
      return maskValue(settings.token, 3, 3);
    case "realdebrid-web":
      return "Browser-Login";
    case "megadebrid-api":
    case "megadebrid-web":
      return settings.megaLogin.trim() ? maskValue(settings.megaLogin.trim(), 2, 6) : "Login + Passwort";
    case "bestdebrid-api":
      return maskValue(settings.bestToken, 3, 3);
    case "bestdebrid-web":
      return "Cookie-Import";
    case "alldebrid-api":
      return maskValue(settings.allDebridToken, 3, 3);
    case "alldebrid-web":
      return "Browser-Login";
    case "ddownload-login":
      return settings.ddownloadLogin.trim() ? maskValue(settings.ddownloadLogin.trim(), 2, 6) : "Login + Passwort";
    case "onefichier-api":
      return maskValue(settings.oneFichierApiKey, 3, 3);
    case "debridlink-api": {
      const keys = (settings.debridLinkApiKeys || "").split(/[\n,]+/).filter((k: string) => k.trim());
      if (keys.length > 1) return `${keys.length} API-Keys`;
      return keys.length === 1 ? maskValue(keys[0].trim(), 3, 3) : "Nicht hinterlegt";
    }
    case "linksnappy-login":
      return (settings.linkSnappyLogin || "").trim() ? maskValue((settings.linkSnappyLogin || "").trim(), 2, 4) : "Login + Passwort";
    default:
      return "Konfiguriert";
  }
}

function summarizeAccountLines(kind: AccountKind, settings: AppSettings): string[] {
  if (kind === "debridlink-api" && settings.accountListShowDetailedDebridLinkKeys) {
    const keys = parseDebridLinkApiKeys(settings.debridLinkApiKeys || "");
    if (keys.length > 1) {
      return keys.map((entry) => `${entry.label}: ${entry.masked}`);
    }
  }
  return [summarizeAccount(kind, settings)];
}

function createAccountDialogState(mode: "create" | "edit", kind: AccountKind | null, settings: AppSettings): AccountDialogState {
  if (!kind) {
    return {
      mode,
      kind: null,
      token: "",
      login: "",
      password: "",
      dailyLimitGb: "",
      keyDailyLimitGbById: {}
    };
  }
  const provider = getAccountServiceProvider(findAccountOption(kind).service);
  const dailyLimitGb = formatAccountDailyLimitInput(getProviderDailyLimitBytes(settings, provider));
  switch (kind) {
    case "realdebrid-api":
      return { mode, kind, token: settings.token, login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "realdebrid-web":
      return { mode, kind, token: "", login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "megadebrid-api":
    case "megadebrid-web":
      return { mode, kind, token: "", login: settings.megaLogin, password: settings.megaPassword, dailyLimitGb, keyDailyLimitGbById: {} };
    case "bestdebrid-api":
      return { mode, kind, token: settings.bestToken, login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "bestdebrid-web":
      return { mode, kind, token: "", login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "alldebrid-api":
      return { mode, kind, token: settings.allDebridToken, login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "alldebrid-web":
      return { mode, kind, token: "", login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "ddownload-login":
      return { mode, kind, token: "", login: settings.ddownloadLogin, password: settings.ddownloadPassword, dailyLimitGb, keyDailyLimitGbById: {} };
    case "onefichier-api":
      return { mode, kind, token: settings.oneFichierApiKey, login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
    case "debridlink-api":
      return {
        mode,
        kind,
        token: settings.debridLinkApiKeys || "",
        login: "",
        password: "",
        dailyLimitGb,
        keyDailyLimitGbById: buildDebridLinkKeyLimitInputs(settings.debridLinkApiKeys || "", undefined, settings)
      };
    case "linksnappy-login":
      return { mode, kind, token: "", login: settings.linkSnappyLogin || "", password: settings.linkSnappyPassword || "", dailyLimitGb, keyDailyLimitGbById: {} };
    default:
      return { mode, kind, token: "", login: "", password: "", dailyLimitGb, keyDailyLimitGbById: {} };
  }
}

function applyAccountDialogToSettings(settings: AppSettings, dialog: AccountDialogState): AppSettings {
  if (!dialog.kind) {
    return settings;
  }
  const token = dialog.token.trim();
  const login = dialog.login.trim();
  const password = dialog.password;
  const provider = getAccountServiceProvider(findAccountOption(dialog.kind).service);
  const nextProviderDailyLimitBytes = { ...(settings.providerDailyLimitBytes || {}) };
  const nextDebridLinkApiKeyDailyLimitBytes = dialog.kind === "debridlink-api"
    ? Object.fromEntries(
      parseDebridLinkApiKeys(dialog.token).flatMap((entry) => {
        const limitBytes = parseAccountDailyLimitInputBytes(dialog.keyDailyLimitGbById?.[entry.id] || "");
        return limitBytes && limitBytes > 0 ? [[entry.id, limitBytes]] : [];
      })
    ) as Record<string, number>
    : { ...(settings.debridLinkApiKeyDailyLimitBytes || {}) };
  const dailyLimitBytes = parseAccountDailyLimitInputBytes(dialog.dailyLimitGb);
  if (dailyLimitBytes && dailyLimitBytes > 0) {
    nextProviderDailyLimitBytes[provider] = dailyLimitBytes;
  } else {
    delete nextProviderDailyLimitBytes[provider];
  }
  switch (dialog.kind) {
    case "realdebrid-api":
      return { ...settings, token, realDebridUseWebLogin: false, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "realdebrid-web":
      return { ...settings, token: "", realDebridUseWebLogin: true, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "megadebrid-api":
      return { ...settings, megaLogin: login, megaPassword: password, megaDebridApiEnabled: true, megaDebridPreferApi: true, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "megadebrid-web":
      return { ...settings, megaLogin: login, megaPassword: password, megaDebridWebEnabled: true, megaDebridPreferApi: false, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "bestdebrid-api":
      return { ...settings, bestToken: token, bestDebridUseWebLogin: false, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "bestdebrid-web":
      return { ...settings, bestToken: "", bestDebridUseWebLogin: true, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "alldebrid-api":
      return { ...settings, allDebridToken: token, allDebridUseWebLogin: false, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "alldebrid-web":
      return { ...settings, allDebridToken: "", allDebridUseWebLogin: true, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "ddownload-login":
      return { ...settings, ddownloadLogin: login, ddownloadPassword: password, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "onefichier-api":
      return { ...settings, oneFichierApiKey: token, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    case "debridlink-api":
      return {
        ...settings,
        debridLinkApiKeys: token,
        providerDailyLimitBytes: nextProviderDailyLimitBytes,
        debridLinkApiKeyDailyLimitBytes: nextDebridLinkApiKeyDailyLimitBytes
      };
    case "linksnappy-login":
      return { ...settings, linkSnappyLogin: login, linkSnappyPassword: password, providerDailyLimitBytes: nextProviderDailyLimitBytes };
    default:
      return settings;
  }
}

function clearAccountServiceFromSettings(settings: AppSettings, service: AccountService): AppSettings {
  const provider = getAccountServiceProvider(service);
  const nextProviderDailyLimitBytes = { ...(settings.providerDailyLimitBytes || {}) };
  const nextProviderDailyUsageBytes = { ...(settings.providerDailyUsageBytes || {}) };
  const nextDebridLinkApiKeyDailyLimitBytes = { ...(settings.debridLinkApiKeyDailyLimitBytes || {}) };
  const nextDebridLinkApiKeyDailyUsageBytes = { ...(settings.debridLinkApiKeyDailyUsageBytes || {}) };
  delete nextProviderDailyLimitBytes[provider];
  delete nextProviderDailyUsageBytes[provider];
  if (service === "debridlink") {
    for (const key of parseDebridLinkApiKeys(settings.debridLinkApiKeys || "")) {
      delete nextDebridLinkApiKeyDailyLimitBytes[key.id];
      delete nextDebridLinkApiKeyDailyUsageBytes[key.id];
    }
  }
  switch (service) {
    case "realdebrid":
      return { ...settings, token: "", realDebridUseWebLogin: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "megadebrid-api":
      return settings.megaDebridWebEnabled
        ? { ...settings, megaDebridApiEnabled: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes }
        : { ...settings, megaLogin: "", megaPassword: "", megaDebridApiEnabled: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "megadebrid-web":
      return settings.megaDebridApiEnabled
        ? { ...settings, megaDebridWebEnabled: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes }
        : { ...settings, megaLogin: "", megaPassword: "", megaDebridWebEnabled: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "bestdebrid":
      return { ...settings, bestToken: "", bestDebridUseWebLogin: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "alldebrid":
      return { ...settings, allDebridToken: "", allDebridUseWebLogin: false, providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "ddownload":
      return { ...settings, ddownloadLogin: "", ddownloadPassword: "", providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "onefichier":
      return { ...settings, oneFichierApiKey: "", providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    case "debridlink":
      return {
        ...settings,
        debridLinkApiKeys: "",
        providerDailyLimitBytes: nextProviderDailyLimitBytes,
        providerDailyUsageBytes: nextProviderDailyUsageBytes,
        debridLinkApiKeyDailyLimitBytes: nextDebridLinkApiKeyDailyLimitBytes,
        debridLinkApiKeyDailyUsageBytes: nextDebridLinkApiKeyDailyUsageBytes
      };
    case "linksnappy":
      return { ...settings, linkSnappyLogin: "", linkSnappyPassword: "", providerDailyLimitBytes: nextProviderDailyLimitBytes, providerDailyUsageBytes: nextProviderDailyUsageBytes };
    default:
      return settings;
  }
}

function validateAccountDialog(dialog: AccountDialogState): string | null {
  if (!dialog.kind) {
    return "Bitte zuerst einen Account-Typ auswählen.";
  }
  const option = findAccountOption(dialog.kind);
  if (option.needsToken && !dialog.token.trim()) {
    return `${option.title}: Bitte Zugangstoken eintragen.`;
  }
  if (option.needsCredentials) {
    if (!dialog.login.trim()) {
      return `${option.title}: Bitte Login oder E-Mail eintragen.`;
    }
    if (!dialog.password) {
      return `${option.title}: Bitte Passwort eintragen.`;
    }
  }
  if (dialog.dailyLimitGb.trim()) {
    const parsed = Number(dialog.dailyLimitGb.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) {
      return `${option.title}: Tageslimit muss eine Zahl >= 0 sein.`;
    }
  }
  if (dialog.kind === "debridlink-api") {
    for (const key of parseDebridLinkApiKeys(dialog.token)) {
      const raw = dialog.keyDailyLimitGbById?.[key.id] || "";
      if (!raw.trim()) {
        continue;
      }
      const parsed = Number(raw.trim().replace(",", "."));
      if (!Number.isFinite(parsed) || parsed < 0) {
        return `${option.title}: ${key.label} Limit muss eine Zahl >= 0 sein.`;
      }
    }
  }
  return null;
}

const emptyStats = (): DownloadStats => ({
  totalDownloaded: 0,
  totalDownloadedAllTime: 0,
  totalFilesSession: 0,
  totalFilesAllTime: 0,
  totalPackages: 0,
  sessionStartedAt: 0
});

const emptySnapshot = (): UiSnapshot => ({
  settings: {
    token: "", realDebridUseWebLogin: false, megaLogin: "", megaPassword: "", megaDebridApiEnabled: false, megaDebridWebEnabled: false, megaDebridPreferApi: true, bestToken: "", bestDebridUseWebLogin: false, allDebridToken: "", allDebridUseWebLogin: false, ddownloadLogin: "", ddownloadPassword: "", oneFichierApiKey: "", debridLinkApiKeys: "", linkSnappyLogin: "", linkSnappyPassword: "",
    debridLinkDisabledKeyIds: [],
    archivePasswordList: "",
    rememberToken: true, providerOrder: [], providerPrimary: "realdebrid", providerSecondary: "none",
    providerTertiary: "none", autoProviderFallback: true, outputDir: "", packageName: "",
    autoExtract: true, autoRename4sf4sj: false, extractDir: "", createExtractSubfolder: true, hybridExtract: true,
    collectMkvToLibrary: false, mkvLibraryDir: "",
    cleanupMode: "none", extractConflictMode: "overwrite", removeLinkFilesAfterExtract: false,
    removeSamplesAfterExtract: false, enableIntegrityCheck: true, autoResumeOnStart: true,
    autoReconnect: false, reconnectWaitSeconds: 45, completedCleanupPolicy: "never",
    maxParallel: 4, maxParallelExtract: 2, extractCpuPriority: "high", retryLimit: 0, speedLimitEnabled: false, speedLimitKbps: 0, speedLimitMode: "global",
    updateRepo: "", autoUpdateCheck: true, clipboardWatch: false, minimizeToTray: false,
    theme: "dark", collapseNewPackages: true, autoSortPackagesByProgress: true, autoSkipExtracted: false, confirmDeleteSelection: true,
    accountListShowDetailedDebridLinkKeys: false,
    bandwidthSchedules: [], totalDownloadedAllTime: 0, totalCompletedFilesAllTime: 0,
    columnOrder: ["name", "size", "progress", "hoster", "account", "prio", "status", "speed"],
    autoExtractWhenStopped: true,
    disabledProviders: [],
    hosterRouting: {},
    providerDailyLimitBytes: {},
    providerDailyUsageBytes: {},
    providerTotalUsageBytes: {},
    debridLinkApiKeyDailyLimitBytes: {},
    debridLinkApiKeyDailyUsageBytes: {},
    debridLinkApiKeyTotalUsageBytes: {},
    providerDailyUsageDay: getProviderUsageDayKey(),
    scheduledStartEpochMs: 0
  },
  session: {
    version: 2, packageOrder: [], packages: {}, items: {}, runStartedAt: 0,
    totalDownloadedBytes: 0, summaryText: "", reconnectUntil: 0, reconnectReason: "",
    paused: false, running: false, updatedAt: Date.now()
  },
  summary: null, stats: emptyStats(), speedText: "Geschwindigkeit: 0 B/s", etaText: "ETA: --",
  canStart: true, canStop: false, canPause: false, clipboardActive: false, reconnectSeconds: 0, packageSpeedBps: {}
});

const cleanupLabels: Record<string, string> = {
  never: "Nie", immediate: "Sofort", on_start: "Beim App-Start", package_done: "Sobald Paket fertig ist"
};

const AUTO_RENDER_PACKAGE_LIMIT = 260;

const providerLabels: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid",
  megadebrid: "Mega-Debrid",
  "megadebrid-api": "Mega-Debrid API",
  "megadebrid-web": "Mega-Debrid Web",
  bestdebrid: "BestDebrid",
  alldebrid: "AllDebrid",
  ddownload: "DDownload",
  onefichier: "1Fichier",
  debridlink: "Debrid-Link",
  linksnappy: "LinkSnappy"
};

const KNOWN_HOSTERS: { id: string; label: string }[] = [
  { id: "rapidgator", label: "Rapidgator" },
  { id: "uploaded", label: "Uploaded" },
  { id: "1fichier", label: "1Fichier" },
  { id: "ddownload", label: "DDownload" },
  { id: "ddl", label: "DDL.to" },
  { id: "turbobit", label: "Turbobit" },
  { id: "nitroflare", label: "Nitroflare" },
  { id: "filefactory", label: "FileFactory" },
  { id: "katfile", label: "Katfile" },
  { id: "hitfile", label: "Hitfile" },
  { id: "alfafile", label: "Alfafile" },
  { id: "k2s", label: "Keep2Share" },
  { id: "keep2share", label: "Keep2Share (alt)" },
  { id: "tezfiles", label: "Tezfiles" },
  { id: "fileboom", label: "Fileboom" },
  { id: "mexashare", label: "Mexashare" },
  { id: "wdupload", label: "WDUpload" },
  { id: "rosefile", label: "Rosefile" },
  { id: "filejoker", label: "FileJoker" },
  { id: "worldbytez", label: "Worldbytez" },
  { id: "fileland", label: "Fileland" },
  { id: "depositfiles", label: "DepositFiles" },
  { id: "mediafire", label: "MediaFire" },
  { id: "mega", label: "Mega.nz" },
  { id: "frdl", label: "FreeDownload" },
  { id: "hexupload", label: "HexUpload" },
  { id: "isra", label: "Isra.cloud" }
];

function providerLabelWithMode(provider: DebridProvider, settings: AppSettings): string {
  const base = providerLabels[provider];
  if (provider === "megadebrid" || provider === "megadebrid-api" || provider === "megadebrid-web") {
    return base;
  }
  const kind = getConfiguredAccountKind(settings, provider as AccountService);
  if (!kind) return base;
  const opt = ACCOUNT_OPTIONS.find((o) => o.kind === kind);
  return opt?.modeLabel ? `${base} (${opt.modeLabel})` : base;
}

function compactProviderLabels(labels: string[]): string {
  const unique = [...new Set(labels)];
  const groups = new Map<string, string[]>();
  for (const label of unique) {
    const m = label.match(/^(.+?)\s*\((.+)\)$/);
    if (m) {
      const arr = groups.get(m[1]) || [];
      arr.push(m[2]);
      groups.set(m[1], arr);
    } else {
      groups.set(label, []);
    }
  }
  return [...groups.entries()].map(([base, details]) =>
    details.length === 0 ? base : `${base} (${details.join(" + ")})`
  ).join(", ");
}

function formatDateTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} - ${hh}:${min}`;
}

function extractHoster(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch { return ""; }
}

const settingsSubTabs: { key: SettingsSubTab; label: string }[] = [
  { key: "allgemein", label: "Allgemein" },
  { key: "accounts", label: "Accounts" },
  { key: "entpacken", label: "Entpacken" },
  { key: "geschwindigkeit", label: "Geschwindigkeit" },
  { key: "bereinigung", label: "Bereinigung" },
  { key: "updates", label: "Updates" },
];

function formatSpeedMbps(speedBps: number): string {
  const mbps = Math.max(0, speedBps || 0) / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
  if (bytes < 1024 * 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`; }
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(3)} TB`;
}

function formatAllDebridSourceLabel(source: AllDebridHostInfo["source"]): string {
  return source === "web" ? "Web-Login" : "API-Key";
}

function formatAllDebridQuota(info: AllDebridHostInfo): string {
  const suffix = info.quotaType ? ` (${info.quotaType})` : "";
  if (info.quota !== null && info.quotaMax !== null) {
    return `${info.quota} / ${info.quotaMax}${suffix}`;
  }
  if (info.quota !== null) {
    return `${info.quota}${suffix}`;
  }
  if (info.quotaMax !== null) {
    return `max. ${info.quotaMax}${suffix}`;
  }
  return info.source === "web" ? "Nur per API-Key sichtbar" : "Nicht angegeben";
}

function formatAllDebridSimuLimit(info: AllDebridHostInfo): string {
  if (info.limitSimuDl === null) {
    return info.source === "web" ? "Nur per API-Key sichtbar" : "Nicht angegeben";
  }
  return String(info.limitSimuDl);
}

function formatAllDebridTimestamp(info: AllDebridHostInfo): string {
  return formatDateTime(info.lastCheckedAt || info.fetchedAt);
}

function formatDebridLinkTraffic(info: DebridLinkHostLimitInfo | null | undefined): string {
  if (!info) {
    return "Lade...";
  }
  const toGb = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (info.trafficCurrentBytes !== null && info.trafficMaxBytes !== null) {
    return `${toGb(info.trafficCurrentBytes)} / ${toGb(info.trafficMaxBytes)}`;
  }
  if (info.trafficMaxBytes !== null) {
    return `max. ${toGb(info.trafficMaxBytes)}`;
  }
  if (info.trafficCurrentBytes !== null) {
    return toGb(info.trafficCurrentBytes);
  }
  return info.note || "Nicht verfügbar";
}

function formatDebridLinkCountQuota(info: DebridLinkHostLimitInfo | null | undefined): string {
  if (!info) {
    return "Lade...";
  }
  if (info.linksCurrent !== null && info.linksMax !== null) {
    return `${info.linksCurrent} / ${info.linksMax}`;
  }
  if (info.linksMax !== null) {
    return `max. ${info.linksMax}`;
  }
  if (info.linksCurrent !== null) {
    return String(info.linksCurrent);
  }
  return info.note || "Nicht verfügbar";
}

interface BandwidthChartProps {
  items: Record<string, DownloadItem>;
  running: boolean;
  paused: boolean;
  speedHistoryRef: React.MutableRefObject<{ time: number; speed: number }[]>;
}

const BandwidthChart = memo(function BandwidthChart({ items, running, paused, speedHistoryRef }: BandwidthChartProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpdateRef = useRef<number>(0);

  const animationFrameRef = useRef<number>(0);

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    const gridColor = isDark ? "rgba(35, 57, 84, 0.5)" : "rgba(199, 213, 234, 0.5)";
    const textColor = isDark ? "#90a4bf" : "#4e6482";
    const accentColor = isDark ? "#38bdf8" : "#1168d9";
    const fillColor = isDark ? "rgba(56, 189, 248, 0.15)" : "rgba(17, 104, 217, 0.15)";

    const history = speedHistoryRef.current;
    const now = Date.now();
    const maxTime = now;
    const minTime = now - 60000;

    let maxSpeed = 0;
    for (const point of history) {
      if (point.speed > maxSpeed) maxSpeed = point.speed;
    }
    maxSpeed = Math.max(maxSpeed, 1024 * 1024);
    const niceMax = Math.pow(2, Math.ceil(Math.log2(maxSpeed)));

    // Measure widest label to set dynamic left padding
    ctx.font = "11px 'Manrope', sans-serif";
    let maxLabelWidth = 0;
    for (let i = 0; i <= 5; i += 1) {
      const speedVal = niceMax * (1 - i / 5);
      const w = ctx.measureText(formatSpeedMbps(speedVal)).width;
      if (w > maxLabelWidth) maxLabelWidth = w;
    }
    const padding = { top: 20, right: 20, bottom: 30, left: Math.ceil(maxLabelWidth) + 16 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (chartHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    ctx.fillStyle = textColor;
    ctx.font = "11px 'Manrope', sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (chartHeight / 5) * i;
      const speedVal = niceMax * (1 - i / 5);
      ctx.fillText(formatSpeedMbps(speedVal), padding.left - 8, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("60s", padding.left, height - padding.bottom + 8);
    ctx.fillText("30s", padding.left + chartWidth / 2, height - padding.bottom + 8);
    ctx.fillText("0s", width - padding.right, height - padding.bottom + 8);

    if (history.length < 2) {
      ctx.fillStyle = textColor;
      ctx.font = "13px 'Manrope', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(running ? (paused ? "Pausiert" : "Sammle Daten...") : "Download starten für Statistiken", width / 2, height / 2);
      return;
    }

    const points: { x: number; y: number }[] = [];
    for (const point of history) {
      const x = padding.left + ((point.time - minTime) / 60000) * chartWidth;
      const y = padding.top + chartHeight - (point.speed / niceMax) * chartHeight;
      points.push({ x, y });
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
    ctx.lineTo(points[0].x, padding.top + chartHeight);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    const lastPoint = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = accentColor;
    ctx.fill();
  }, [running, paused]);

  useEffect(() => {
    const interval = setInterval(() => {
      drawChart();
    }, 250);
    return () => clearInterval(interval);
  }, [drawChart]);

  useEffect(() => {
    // Only record samples while the session is running and not paused
    if (!running || paused) return;

    const now = Date.now();
    const activeItems = Object.values(items).filter((item) => item.status === "downloading");
    if (activeItems.length === 0) return;

    const totalSpeed = activeItems.reduce((sum, item) => sum + (item.speedBps || 0), 0);

    const history = speedHistoryRef.current;
    history.push({ time: now, speed: totalSpeed });

    const cutoff = now - 60000;
    let trimIndex = 0;
    while (trimIndex < history.length && history[trimIndex].time < cutoff) {
      trimIndex += 1;
    }
    if (trimIndex > 0) {
      speedHistoryRef.current = history.slice(trimIndex);
    }

    lastUpdateRef.current = now;
  }, [items, paused, running]);

  useEffect(() => {
    const handleResize = () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(drawChart);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [drawChart]);

  useEffect(() => {
    drawChart();
  }, [drawChart, items, paused]);

  return (
    <div ref={containerRef} className="bandwidth-chart-container">
      <canvas ref={canvasRef} />
    </div>
  );
});

let nextCollectorId = 1;

function createScheduleId(): string {
  return `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}


function sortPackageOrderBySize(order: string[], packages: Record<string, PackageEntry>, items: Record<string, DownloadItem>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const sizeA = (packages[a]?.itemIds ?? []).reduce((sum, id) => sum + (items[id]?.totalBytes || items[id]?.downloadedBytes || 0), 0);
    const sizeB = (packages[b]?.itemIds ?? []).reduce((sum, id) => sum + (items[id]?.totalBytes || items[id]?.downloadedBytes || 0), 0);
    const cmp = sizeA - sizeB;
    return descending ? -cmp : cmp;
  });
  return sorted;
}

function sortPackageOrderByHoster(order: string[], packages: Record<string, PackageEntry>, items: Record<string, DownloadItem>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const hosterA = [...new Set((packages[a]?.itemIds ?? []).map((id) => extractHoster(items[id]?.url || "")).filter(Boolean))].join(",").toLowerCase();
    const hosterB = [...new Set((packages[b]?.itemIds ?? []).map((id) => extractHoster(items[id]?.url || "")).filter(Boolean))].join(",").toLowerCase();
    const cmp = hosterA.localeCompare(hosterB);
    return descending ? -cmp : cmp;
  });
  return sorted;
}

function sortPackageOrderByProgress(order: string[], packages: Record<string, PackageEntry>, items: Record<string, DownloadItem>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const progressA = computePackageProgress(packages[a], items);
    const progressB = computePackageProgress(packages[b], items);
    const cmp = progressA - progressB;
    return descending ? -cmp : cmp;
  });
  return sorted;
}

function computePackageProgress(pkg: PackageEntry | undefined, items: Record<string, DownloadItem>): number {
  if (!pkg) return 0;
  const ids = pkg.itemIds ?? [];
  if (ids.length === 0) return 0;
  let totalDown = 0;
  let totalSize = 0;
  for (const id of ids) {
    const item = items[id];
    if (!item) continue;
    totalDown += item.downloadedBytes || 0;
    totalSize += item.totalBytes || item.downloadedBytes || 0;
  }
  return totalSize > 0 ? totalDown / totalSize : 0;
}

type PkgSortColumn = "name" | "size" | "hoster" | "progress";

const DEFAULT_COLUMN_ORDER = ["name", "size", "progress", "hoster", "account", "prio", "status", "speed"];
const ALL_COLUMN_KEYS = ["name", "size", "progress", "hoster", "account", "prio", "status", "speed", "added"];
const COLUMN_DEFS: Record<string, { label: string; width: string; sortable?: PkgSortColumn }> = {
  name:     { label: "Name",            width: "minmax(0, 0.92fr)", sortable: "name" },
  size:     { label: "Geladen / Größe", width: "160px", sortable: "size" },
  progress: { label: "Fortschritt",     width: "80px",  sortable: "progress" },
  hoster:   { label: "Hoster",          width: "110px", sortable: "hoster" },
  account:  { label: "Service",         width: "132px" },
  prio:     { label: "Priorität",       width: "70px" },
  status:   { label: "Status",          width: "160px" },
  speed:    { label: "Geschwindigkeit", width: "90px" },
  added:    { label: "Hinzugefügt am",  width: "155px" },
};

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function formatMbpsInputFromKbps(kbps: number): string {
  const mbps = Math.max(0, Number(kbps) || 0) / 1024;
  return String(Number(mbps.toFixed(2)));
}

function parseMbpsInput(value: string): number | null {
  const normalized = String(value || "").trim().replace(/,/g, ".");
  if (!normalized) {
    return 0;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function formatUpdateInstallProgress(progress: UpdateInstallProgress): string {
  if (progress.stage === "downloading") {
    if (progress.totalBytes && progress.totalBytes > 0 && progress.percent !== null) {
      return `Update-Download: ${progress.percent}% (${humanSize(progress.downloadedBytes)} / ${humanSize(progress.totalBytes)})`;
    }
    return `Update-Download: ${humanSize(progress.downloadedBytes)}`;
  }
  if (progress.stage === "starting") {
    return "Update wird vorbereitet...";
  }
  if (progress.stage === "verifying") {
    return "Download fertig | Prüfe Integrität...";
  }
  if (progress.stage === "launching") {
    return "Starte Installer...";
  }
  if (progress.stage === "done") {
    return "Installer gestartet";
  }
  return `Update-Fehler: ${progress.message}`;
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<UiSnapshot>(emptySnapshot);
  const [appVersion, setAppVersion] = useState("");
  const [tab, setTab] = useState<Tab>("downloads");
  const [statusToast, setStatusToast] = useState("");
  const [updateInstallProgress, setUpdateInstallProgress] = useState<UpdateInstallProgress | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(emptySnapshot().settings);
  const [speedLimitInput, setSpeedLimitInput] = useState(() => formatMbpsInputFromKbps(emptySnapshot().settings.speedLimitKbps));
  const [scheduleSpeedInputs, setScheduleSpeedInputs] = useState<Record<string, string>>({});
  const [accountColumnWidths, setAccountColumnWidths] = useState<Record<AccountColumnKey, number>>(loadAccountColumnWidths);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
  const [scheduleTimeInput, setScheduleTimeInput] = useState("");
  const [scheduleCountdown, setScheduleCountdown] = useState("");
  const settingsDirtyRef = useRef(false);
  const settingsDraftRevisionRef = useRef(0);
  const panelDirtyRevisionRef = useRef(0);
  const latestStateRef = useRef<UiSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const tabRef = useRef(tab);
  const autoExpandedPkgsRef = useRef(new Set<string>());
  const manualCollapsedPkgsRef = useRef(new Set<string>());
  tabRef.current = tab;
  const stateFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onImportDlcRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [dragOver, setDragOver] = useState(false);
  const [draggedProvider, setDraggedProvider] = useState<DebridProvider | null>(null);
  const [providerDropTarget, setProviderDropTarget] = useState<DebridProvider | null>(null);
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [collectorTabs, setCollectorTabs] = useState<CollectorTab[]>([
    { id: `tab-${nextCollectorId++}`, name: "Tab 1", text: "" }
  ]);
  const [activeCollectorTab, setActiveCollectorTab] = useState(collectorTabs[0].id);
  const collectorTabsRef = useRef<CollectorTab[]>(collectorTabs);
  const activeCollectorTabRef = useRef(activeCollectorTab);
  const activeTabRef = useRef<Tab>(tab);
  const packageOrderRef = useRef<string[]>([]);
  const serverPackageOrderRef = useRef<string[]>([]);
  const pendingPackageOrderRef = useRef<string[] | null>(null);
  const pendingPackageOrderAtRef = useRef(0);
  const draggedPackageIdRef = useRef<string | null>(null);
  const [collapsedPackages, setCollapsedPackages] = useState<Record<string, boolean>>({});
  const [downloadSearch, setDownloadSearch] = useState("");
  const [downloadsSortColumn, setDownloadsSortColumn] = useState<PkgSortColumn>("name");
  const [downloadsSortDescending, setDownloadsSortDescending] = useState(false);
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);
  const actionUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [supportTraceEnabled, setSupportTraceEnabled] = useState(false);
  const dragOverRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>("allgemein");
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [startConflictPrompt, setStartConflictPrompt] = useState<StartConflictPromptState | null>(null);
  const startConflictResolverRef = useRef<((result: { policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null) => void) | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<ConfirmPromptState | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmQueueRef = useRef<Array<{ prompt: ConfirmPromptState; resolve: (confirmed: boolean) => void }>>([]);
  const importQueueFocusHandlerRef = useRef<(() => void) | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [linkPopup, setLinkPopup] = useState<LinkPopupState | null>(null);
  const [accountDialog, setAccountDialog] = useState<AccountDialogState | null>(null);
  const [accountDialogSearch, setAccountDialogSearch] = useState("");
  const [keyStatsPopup, setKeyStatsPopup] = useState<string | null>(null);
  const [debridLinkHostLimits, setDebridLinkHostLimits] = useState<Record<string, DebridLinkHostLimitInfo>>({});
  const [debridLinkHostLimitsLoading, setDebridLinkHostLimitsLoading] = useState(false);
  const [debridLinkHostLimitsError, setDebridLinkHostLimitsError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: Set<string>; dontAsk: boolean } | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => DEFAULT_COLUMN_ORDER);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dropTargetCol, setDropTargetCol] = useState<string | null>(null);
  const [colHeaderCtx, setColHeaderCtx] = useState<{ x: number; y: number } | null>(null);
  const colHeaderCtxRef = useRef<HTMLDivElement>(null);
  const colHeaderBarRef = useRef<HTMLDivElement>(null);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const historyEntriesRef = useRef<HistoryEntry[]>([]);
  const [historyCollapsed, setHistoryCollapsed] = useState<Record<string, boolean>>({});
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const [historyCtxMenu, setHistoryCtxMenu] = useState<{ x: number; y: number; entryId: string } | null>(null);
  const historyCtxMenuRef = useRef<HTMLDivElement>(null);
  const [allDebridHostInfo, setAllDebridHostInfo] = useState<AllDebridHostInfo | null>(null);
  const [allDebridHostLoading, setAllDebridHostLoading] = useState(false);
  const allDebridHostRequestRef = useRef(0);
  const debridLinkHostLimitsRequestRef = useRef(0);
  const accountColumnResizeRef = useRef<{ key: AccountColumnKey; startX: number; startWidth: number } | null>(null);
  const onAccountColumnResizeMove = useCallback((event: MouseEvent): void => {
    const active = accountColumnResizeRef.current;
    if (!active) {
      return;
    }
    const nextWidth = Math.max(
      ACCOUNT_COLUMN_MIN_WIDTHS[active.key],
      Math.round(active.startWidth + (event.clientX - active.startX))
    );
    setAccountColumnWidths((prev) => (
      prev[active.key] === nextWidth ? prev : { ...prev, [active.key]: nextWidth }
    ));
  }, []);

  const stopAccountColumnResize = useCallback((): void => {
    accountColumnResizeRef.current = null;
    window.removeEventListener("mousemove", onAccountColumnResizeMove);
    window.removeEventListener("mouseup", stopAccountColumnResize);
  }, [onAccountColumnResizeMove]);

  const startAccountColumnResize = useCallback((key: AccountColumnKey, clientX: number): void => {
    accountColumnResizeRef.current = {
      key,
      startX: clientX,
      startWidth: accountColumnWidths[key]
    };
    window.addEventListener("mousemove", onAccountColumnResizeMove);
    window.addEventListener("mouseup", stopAccountColumnResize);
  }, [accountColumnWidths, onAccountColumnResizeMove, stopAccountColumnResize]);

  // Load history when tab changes to history
  useEffect(() => {
    if (tab !== "history") return;
    const loadHistory = async (): Promise<void> => {
      try {
        const entries = await window.rd.getHistory();
        if (mountedRef.current && entries) {
          setHistoryEntries(entries);
        }
      } catch (err) {
        console.error("Failed to load history:", err);
      }
    };
    void loadHistory();
  }, [tab]);

  useEffect(() => { historyEntriesRef.current = historyEntries; }, [historyEntries]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ACCOUNT_COLUMN_STORAGE_KEY, JSON.stringify(accountColumnWidths));
    } catch {
      // Ignore local persistence failures for optional UI state.
    }
  }, [accountColumnWidths]);

  const resetAccountColumnWidths = useCallback((): void => {
    setAccountColumnWidths({ ...ACCOUNT_COLUMN_DEFAULT_WIDTHS });
    try {
      window.localStorage.removeItem(ACCOUNT_COLUMN_STORAGE_KEY);
    } catch {
      // Ignore local persistence failures for optional UI state.
    }
    showToast("Accounts-Spalten zurückgesetzt", 1800);
  }, []);

  // Sync column order from settings (value-based comparison to avoid reference issues)
  const columnOrderJson = JSON.stringify(snapshot.settings.columnOrder);
  useEffect(() => {
    const order = snapshot.settings.columnOrder;
    if (order && order.length > 0) {
      setColumnOrder(order);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnOrderJson]);

  const currentCollectorTab = collectorTabs.find((t) => t.id === activeCollectorTab) ?? collectorTabs[0];

  useEffect(() => {
    activeCollectorTabRef.current = activeCollectorTab;
  }, [activeCollectorTab]);

  useEffect(() => {
    collectorTabsRef.current = collectorTabs;
  }, [collectorTabs]);

  useEffect(() => {
    activeTabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    const incoming = snapshot.session.packageOrder;
    serverPackageOrderRef.current = incoming;

    const pending = pendingPackageOrderRef.current;
    if (!pending) {
      packageOrderRef.current = incoming;
      return;
    }

    if (sameStringArray(pending, incoming)) {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = incoming;
      return;
    }

    const maxOptimisticHoldMs = 1500;
    if (Date.now() - pendingPackageOrderAtRef.current >= maxOptimisticHoldMs) {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = incoming;
      return;
    }

    packageOrderRef.current = pending;
  }, [snapshot.session.packageOrder]);

  useEffect(() => {
    setSpeedLimitInput(formatMbpsInputFromKbps(settingsDraft.speedLimitKbps));
  }, [settingsDraft.speedLimitKbps]);

  useEffect(() => {
    const schedMs = snapshot.settings.scheduledStartEpochMs || 0;
    if (schedMs <= 0) { setScheduleCountdown(""); return; }
    const update = (): void => {
      const remaining = schedMs - Date.now();
      if (remaining <= 0) { setScheduleCountdown(""); return; }
      const totalSec = Math.ceil(remaining / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setScheduleCountdown(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [snapshot.settings.scheduledStartEpochMs]);

  const showToast = useCallback((message: string, timeoutMs = 2200): void => {
    setStatusToast(message);
    if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); }
    toastTimerRef.current = setTimeout(() => {
      setStatusToast("");
      toastTimerRef.current = null;
    }, timeoutMs);
  }, []);

  const loadAllDebridHostInfo = useCallback(async (silent = false): Promise<void> => {
    const requestId = allDebridHostRequestRef.current + 1;
    allDebridHostRequestRef.current = requestId;
    setAllDebridHostLoading(true);
    try {
      const info = await window.rd.getAllDebridHostInfo();
      if (!mountedRef.current || allDebridHostRequestRef.current !== requestId) {
        return;
      }
      setAllDebridHostInfo(info);
    } catch (error) {
      if (!mountedRef.current || allDebridHostRequestRef.current !== requestId) {
        return;
      }
      setAllDebridHostInfo(null);
      if (!silent) {
        showToast(`AllDebrid Status fehlgeschlagen: ${String(error)}`, 3200);
      }
    } finally {
      if (mountedRef.current && allDebridHostRequestRef.current === requestId) {
        setAllDebridHostLoading(false);
      }
    }
  }, [showToast]);

  const loadDebridLinkHostLimits = useCallback(async (silent = false): Promise<void> => {
    const requestId = debridLinkHostLimitsRequestRef.current + 1;
    debridLinkHostLimitsRequestRef.current = requestId;
    setDebridLinkHostLimitsLoading(true);
    setDebridLinkHostLimitsError("");
    setDebridLinkHostLimits({});
    try {
      const apiKeys = parseDebridLinkApiKeys(settingsDraft.debridLinkApiKeys || "");
      if (apiKeys.length === 0) {
        throw new Error("Debrid-Link ist nicht konfiguriert");
      }
      const limits = await window.rd.getDebridLinkHostLimits();
      if (!mountedRef.current || debridLinkHostLimitsRequestRef.current !== requestId) {
        return;
      }
      setDebridLinkHostLimits(
        Object.fromEntries(limits.map((info) => [info.keyId, info]))
      );
    } catch (error) {
      if (!mountedRef.current || debridLinkHostLimitsRequestRef.current !== requestId) {
        return;
      }
      setDebridLinkHostLimits({});
      setDebridLinkHostLimitsError(String(error));
      if (!silent) {
        showToast(`Debrid-Link Quota fehlgeschlagen: ${String(error)}`, 3200);
      }
    } finally {
      if (mountedRef.current && debridLinkHostLimitsRequestRef.current === requestId) {
        setDebridLinkHostLimitsLoading(false);
      }
    }
  }, [settingsDraft.debridLinkApiKeys, showToast]);

  useEffect(() => {
    if (keyStatsPopup !== "debridlink") {
      setDebridLinkHostLimits({});
      setDebridLinkHostLimitsError("");
      setDebridLinkHostLimitsLoading(false);
      return;
    }
    void loadDebridLinkHostLimits(true);
  }, [keyStatsPopup, loadDebridLinkHostLimits]);

  const clearImportQueueFocusListener = useCallback((): void => {
    const handler = importQueueFocusHandlerRef.current;
    if (!handler) {
      return;
    }
    window.removeEventListener("focus", handler);
    importQueueFocusHandlerRef.current = null;
  }, []);

  useEffect(() => {
    document.title = `Multi Debrid Downloader${appVersion ? ` - v${appVersion}` : ""}`;
  }, [appVersion]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let unsubClipboard: (() => void) | null = null;
    let unsubUpdateInstallProgress: (() => void) | null = null;
    void window.rd.getVersion().then((v) => { if (mountedRef.current) { setAppVersion(v); } }).catch(() => undefined);
    void window.rd.getTraceConfig().then((config) => {
      if (mountedRef.current) {
        setSupportTraceEnabled(config.enabled);
      }
    }).catch(() => undefined);
    void window.rd.getSnapshot().then((state) => {
      if (!mountedRef.current) {
        return;
      }
      setSnapshot(state);
      if (state.settings.columnOrder?.length > 0) {
        setColumnOrder(state.settings.columnOrder);
      }
      setSettingsDraft(state.settings);
      settingsDirtyRef.current = false;
      panelDirtyRevisionRef.current = 0;
      setSettingsDirty(false);
      applyTheme(state.settings.theme);
      if (state.settings.autoUpdateCheck) {
        void window.rd.checkUpdates().then((result) => {
          if (!mountedRef.current) {
            return;
          }
          void handleUpdateResult(result, "startup");
        }).catch(() => undefined);
      }
    }).catch((error) => {
      showToast(`Snapshot konnte nicht geladen werden: ${String(error)}`, 2800);
    });
    unsubscribe = window.rd.onStateUpdate((state) => {
      latestStateRef.current = state;
      if (stateFlushTimerRef.current) { return; }

      const itemCount = Object.keys(state.session.items).length;
      let flushDelay = itemCount >= 1500
        ? 900
        : itemCount >= 700
          ? 650
          : itemCount >= 250
            ? 400
            : 150;
      if (!state.session.running) {
        flushDelay = Math.min(flushDelay, 200);
      }
      if (activeTabRef.current !== "downloads") {
        flushDelay = Math.max(flushDelay, 800);
      }

      stateFlushTimerRef.current = setTimeout(() => {
        stateFlushTimerRef.current = null;
        if (latestStateRef.current) {
          const next = latestStateRef.current;
          setSnapshot(next);
          if (next.settings.columnOrder?.length > 0) {
            setColumnOrder(next.settings.columnOrder);
          }
          if (!settingsDirtyRef.current) {
            setSettingsDraft(next.settings);
          }
          latestStateRef.current = null;
        }
      }, flushDelay);
    });
    unsubClipboard = window.rd.onClipboardDetected((links) => {
      showToast(`Zwischenablage: ${links.length} Link(s) erkannt`, 3000);
      setCollectorTabs((prev) => {
        const active = prev.find((t) => t.id === activeCollectorTabRef.current) ?? prev[0];
        if (!active) { return prev; }
        const newText = active.text ? `${active.text}\n${links.join("\n")}` : links.join("\n");
        return prev.map((t) => t.id === active.id ? { ...t, text: newText } : t);
      });
    });
    unsubUpdateInstallProgress = window.rd.onUpdateInstallProgress((progress) => {
      if (!mountedRef.current) {
        return;
      }
      setUpdateInstallProgress(progress);
    });
    return () => {
      mountedRef.current = false;
      if (stateFlushTimerRef.current) { clearTimeout(stateFlushTimerRef.current); }
      if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); }
      if (actionUnlockTimerRef.current) { clearTimeout(actionUnlockTimerRef.current); }
      clearImportQueueFocusListener();
      if (startConflictResolverRef.current) {
        const resolver = startConflictResolverRef.current;
        startConflictResolverRef.current = null;
        resolver(null);
      }
      if (confirmResolverRef.current) {
        const resolver = confirmResolverRef.current;
        confirmResolverRef.current = null;
        resolver(false);
      }
      while (confirmQueueRef.current.length > 0) {
        const request = confirmQueueRef.current.shift();
        request?.resolve(false);
      }
      stopAccountColumnResize();
      if (unsubscribe) { unsubscribe(); }
      if (unsubClipboard) { unsubClipboard(); }
      if (unsubUpdateInstallProgress) { unsubUpdateInstallProgress(); }
    };
  }, [clearImportQueueFocusListener, stopAccountColumnResize]);

  const downloadsTabActive = tab === "downloads";
  const deferredDownloadSearch = useDeferredValue(downloadSearch);
  const downloadSearchQuery = deferredDownloadSearch.trim().toLowerCase();
  const downloadSearchActive = downloadSearchQuery.length > 0;
  const gridTemplate = useMemo(() => columnOrder.map((col) => COLUMN_DEFS[col]?.width ?? "100px").join(" "), [columnOrder]);
  const totalPackageCount = snapshot.session.packageOrder.length;
  const shouldLimitPackageRendering = downloadsTabActive
    && snapshot.session.running
    && !downloadSearchActive
    && totalPackageCount > AUTO_RENDER_PACKAGE_LIMIT
    && !showAllPackages;

  const packageIdsForView = useMemo(() => {
    if (!downloadsTabActive) {
      return [] as string[];
    }
    if (downloadSearchActive) {
      return snapshot.session.packageOrder;
    }
    if (shouldLimitPackageRendering) {
      return snapshot.session.packageOrder.slice(0, AUTO_RENDER_PACKAGE_LIMIT);
    }
    return snapshot.session.packageOrder;
  }, [downloadsTabActive, downloadSearchActive, shouldLimitPackageRendering, snapshot.session.packageOrder]);

  const packageOrderKey = useMemo(() => {
    if (!downloadsTabActive) {
      return "";
    }
    return packageIdsForView.join("|");
  }, [downloadsTabActive, packageIdsForView]);

  const packages = useMemo(() => {
    if (!downloadsTabActive) {
      return [] as PackageEntry[];
    }

    if (downloadSearchActive) {
      return snapshot.session.packageOrder
        .map((id: string) => snapshot.session.packages[id])
        .filter((pkg): pkg is PackageEntry => Boolean(pkg) && pkg.name.toLowerCase().includes(downloadSearchQuery));
    }

    return packageIdsForView
      .map((id) => snapshot.session.packages[id])
      .filter((pkg): pkg is PackageEntry => Boolean(pkg));
  }, [downloadsTabActive, downloadSearchActive, downloadSearchQuery, packageIdsForView, snapshot.session.packageOrder, snapshot.session.packages]);

  const packagePosition = useMemo(() => {
    if (!downloadsTabActive) {
      return new Map<string, number>();
    }
    const map = new Map<string, number>();
    snapshot.session.packageOrder.forEach((id, index) => {
      map.set(id, index);
    });
    return map;
  }, [downloadsTabActive, snapshot.session.packageOrder]);

  const itemsByPackage = useMemo(() => {
    if (!downloadsTabActive) {
      return new Map<string, DownloadItem[]>();
    }
    const map = new Map<string, DownloadItem[]>();
    for (const pkg of packages) {
      const items = pkg.itemIds
        .map((id) => snapshot.session.items[id])
        .filter(Boolean) as DownloadItem[];
      map.set(pkg.id, items);
    }
    return map;
  }, [downloadsTabActive, packageOrderKey, packages, snapshot.session.items]);

  useEffect(() => {
    if (!downloadsTabActive) {
      return;
    }
    setCollapsedPackages((prev) => {
      let changed = false;
      const next: Record<string, boolean> = { ...prev };
      const defaultCollapsed = totalPackageCount >= 24;
      for (const packageId of snapshot.session.packageOrder) {
        if (!(packageId in prev)) {
          next[packageId] = defaultCollapsed;
          changed = true;
        }
      }
      for (const packageId of Object.keys(next)) {
        if (!snapshot.session.packages[packageId]) {
          delete next[packageId];
          changed = true;
        }
      }
      for (const packageId of Array.from(manualCollapsedPkgsRef.current)) {
        if (!snapshot.session.packages[packageId]) {
          manualCollapsedPkgsRef.current.delete(packageId);
        }
      }
      return changed ? next : prev;
    });
  }, [downloadsTabActive, packageOrderKey, snapshot.session.packageOrder, snapshot.session.packages, totalPackageCount]);

  const hiddenPackageCount = shouldLimitPackageRendering
    ? Math.max(0, totalPackageCount - packages.length)
    : 0;
  const visiblePackages = useMemo(() => {
    return sortPackagesForDisplay(
      packages,
      snapshot.session.items,
      snapshot.session.running,
      settingsDraft.autoSortPackagesByProgress
    );
  }, [packages, settingsDraft.autoSortPackagesByProgress, snapshot.session.running, snapshot.session.items]);

  const hasSavedAllDebridAccount = Boolean(snapshot.settings.allDebridUseWebLogin || snapshot.settings.allDebridToken.trim());
  const allDebridSettingsDirty = snapshot.settings.allDebridUseWebLogin !== settingsDraft.allDebridUseWebLogin
    || snapshot.settings.allDebridToken !== settingsDraft.allDebridToken;

  useEffect(() => {
    if (!snapshot.session.running) {
      setShowAllPackages(false);
    }
  }, [snapshot.session.running]);

  useEffect(() => {
    if (settingsSubTab !== "accounts") {
      return;
    }
    if (!hasSavedAllDebridAccount) {
      setAllDebridHostInfo(null);
      setAllDebridHostLoading(false);
      return;
    }
    void loadAllDebridHostInfo(true);
  }, [settingsSubTab, hasSavedAllDebridAccount, snapshot.settings.allDebridToken, snapshot.settings.allDebridUseWebLogin, loadAllDebridHostInfo]);

  // Auto-expand packages that are currently extracting (only once per extraction cycle)
  useEffect(() => {
    const extractingPkgIds: string[] = [];
    const currentlyExtracting = new Set<string>();
    for (const pkg of packages) {
      const items = (pkg.itemIds ?? []).map((id) => snapshot.session.items[id]).filter(Boolean);
      const isExtracting = items.some((item) => item.fullStatus?.startsWith("Entpacken -") && !item.fullStatus?.includes("Done"));
      if (isExtracting) {
        currentlyExtracting.add(pkg.id);
        if (collapsedPackages[pkg.id]
          && !manualCollapsedPkgsRef.current.has(pkg.id)
          && !autoExpandedPkgsRef.current.has(pkg.id)) {
          extractingPkgIds.push(pkg.id);
          autoExpandedPkgsRef.current.add(pkg.id);
        }
      }
    }
    // Reset tracking for packages no longer extracting
    for (const id of autoExpandedPkgsRef.current) {
      if (!currentlyExtracting.has(id)) {
        autoExpandedPkgsRef.current.delete(id);
      }
    }
    if (extractingPkgIds.length > 0) {
      setCollapsedPackages((prev) => {
        const next = { ...prev };
        for (const id of extractingPkgIds) next[id] = false;
        return next;
      });
    }
  }, [packages, snapshot.session.items, collapsedPackages]);

  const allPackagesCollapsed = useMemo(() => (
    packages.length > 0 && packages.every((pkg) => collapsedPackages[pkg.id])
  ), [packages, collapsedPackages]);

  const configuredProviders = useMemo(() => getActiveProvidersFromSettings(settingsDraft), [settingsDraft]);

  // DDownload is a direct file hoster (not a debrid service) and is used automatically
  // for ddownload.com/ddl.to URLs. It counts as a configured account but does not
  // appear in the primary/secondary/tertiary provider dropdowns.
  const hasDdownloadAccount = useMemo(() =>
    Boolean((settingsDraft.ddownloadLogin || "").trim() && (settingsDraft.ddownloadPassword || "").trim()),
  [settingsDraft.ddownloadLogin, settingsDraft.ddownloadPassword]);

  const hasOneFichierAccount = useMemo(() =>
    Boolean((settingsDraft.oneFichierApiKey || "").trim()),
  [settingsDraft.oneFichierApiKey]);

  const totalConfiguredAccounts = configuredProviders.length + (hasDdownloadAccount ? 1 : 0) + (hasOneFichierAccount ? 1 : 0);

  // Dynamische Provider-Reihenfolge (ersetzt altes primary/secondary/tertiary)
  const activeProviderOrder = useMemo(() => normalizeProviderOrderForSettings(settingsDraft), [settingsDraft]);

  // Setzt providerOrder + backwards-kompatible Felder synchron
  const setProviderOrder = useCallback((newOrder: DebridProvider[]) => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      providerOrder: newOrder,
      providerPrimary: newOrder[0] ?? prev.providerPrimary,
      providerSecondary: newOrder[1] ?? "none",
      providerTertiary: newOrder[2] ?? "none"
    }));
  }, []);

  const onProviderDragStart = useCallback((event: DragEvent<HTMLDivElement>, provider: DebridProvider): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", provider);
    setDraggedProvider(provider);
    setProviderDropTarget(provider);
  }, []);

  const onProviderDragOver = useCallback((event: DragEvent<HTMLDivElement>, provider: DebridProvider): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (providerDropTarget !== provider) {
      setProviderDropTarget(provider);
    }
  }, [providerDropTarget]);

  const onProviderDrop = useCallback((event: DragEvent<HTMLDivElement>, provider: DebridProvider): void => {
    event.preventDefault();
    if (!draggedProvider || draggedProvider === provider) {
      return;
    }
    const currentOrder = [...activeProviderOrder];
    const fromIndex = currentOrder.indexOf(draggedProvider);
    const toIndex = currentOrder.indexOf(provider);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      return;
    }
    currentOrder.splice(fromIndex, 1);
    currentOrder.splice(toIndex, 0, draggedProvider);
    setProviderOrder(currentOrder);
    setProviderDropTarget(provider);
  }, [activeProviderOrder, draggedProvider, setProviderOrder]);

  const onProviderDragEnd = useCallback((): void => {
    setDraggedProvider(null);
    setProviderDropTarget(null);
  }, []);

  const normalizedSettingsDraft: AppSettings = useMemo(() => ({
    ...settingsDraft,
    ...normalizeProviderSelectionForSettings(settingsDraft)
  }), [settingsDraft]);

  const configuredAccounts = useMemo(() => {
    const entries: ConfiguredAccountEntry[] = [];
    for (const service of ACCOUNT_SERVICES) {
      const kind = getConfiguredAccountKind(settingsDraft, service);
      if (!kind) {
        continue;
      }
      const option = findAccountOption(kind);
      let statusLabel = "Aktiviert";
      let note = "";
      if (kind === "megadebrid-api") {
        note = "Nur API aktiv. Kein Web-Fallback.";
      } else if (kind === "megadebrid-web") {
        note = "Nur Web aktiv. Kein API-Fallback.";
      } else if (kind === "realdebrid-web") {
        note = "Login kann bei Bedarf direkt aus der Liste geöffnet werden.";
      } else if (kind === "bestdebrid-web") {
        note = "Cookie-Import lässt sich direkt aus der Liste erneut starten.";
      } else if (service === "alldebrid") {
        if (allDebridHostLoading) {
          statusLabel = "Lade Status";
          note = "Rapidgator-Status wird aktualisiert.";
        } else if (allDebridHostInfo) {
          statusLabel = allDebridHostInfo.statusLabel;
          note = allDebridHostInfo.note || `Update: ${formatAllDebridTimestamp(allDebridHostInfo)}`;
        } else if (hasSavedAllDebridAccount) {
          note = "Rapidgator-Status kann direkt aus der Liste geladen werden.";
        }
        if (allDebridSettingsDirty && hasSavedAllDebridAccount) {
          note = "Status basiert auf den zuletzt gespeicherten AllDebrid-Daten.";
        }
      }
      if (kind === "debridlink-api") {
        const keyCount = parseDebridLinkApiKeys(settingsDraft.debridLinkApiKeys || "").length;
        statusLabel = keyCount > 1 ? `${keyCount} API-Keys` : "Aktiviert";
      }
      const provider = getAccountServiceProvider(service);
      const dailyUsedBytes = getProviderDailyUsageBytes(snapshot.settings, provider);
      const totalUsedBytes = getProviderTotalUsageBytes(snapshot.settings, provider);
      const dailyLimitBytes = getProviderDailyLimitBytes(settingsDraft, provider);
      const dailyRemainingBytes = getProviderDailyRemainingBytes({
        providerDailyLimitBytes: settingsDraft.providerDailyLimitBytes,
        providerDailyUsageBytes: snapshot.settings.providerDailyUsageBytes,
        providerDailyUsageDay: snapshot.settings.providerDailyUsageDay
      }, provider);
      let dailyLimitReached = dailyLimitBytes > 0 && dailyUsedBytes >= dailyLimitBytes;
      const isDisabled = (settingsDraft.disabledProviders || []).includes(provider);
      const debridLinkKeys = kind === "debridlink-api"
        ? parseDebridLinkApiKeys(settingsDraft.debridLinkApiKeys || "").map((key) => {
          const keyDailyUsedBytes = getDebridLinkApiKeyDailyUsageBytes(snapshot.settings, key.id);
          const keyDailyLimitBytes = getDebridLinkApiKeyDailyLimitBytes(settingsDraft, key.id);
          const keyDailyRemainingBytes = getDebridLinkApiKeyDailyRemainingBytes({
            debridLinkApiKeyDailyLimitBytes: settingsDraft.debridLinkApiKeyDailyLimitBytes,
            debridLinkApiKeyDailyUsageBytes: snapshot.settings.debridLinkApiKeyDailyUsageBytes,
            providerDailyLimitBytes: settingsDraft.providerDailyLimitBytes,
            providerDailyUsageBytes: snapshot.settings.providerDailyUsageBytes,
            providerDailyUsageDay: snapshot.settings.providerDailyUsageDay
          }, key.id);
          return {
            id: key.id,
            label: key.label,
            token: key.token,
            masked: key.masked,
            disabled: (settingsDraft.debridLinkDisabledKeyIds || []).includes(key.id),
            dailyUsedBytes: keyDailyUsedBytes,
            totalUsedBytes: getDebridLinkApiKeyTotalUsageBytes(snapshot.settings, key.id),
            dailyLimitBytes: keyDailyLimitBytes,
            dailyRemainingBytes: keyDailyRemainingBytes,
            dailyLimitReached: keyDailyLimitBytes > 0 && keyDailyUsedBytes >= keyDailyLimitBytes
          };
        })
        : [];
      if (kind === "debridlink-api" && debridLinkKeys.length > 0) {
        const limitedCount = debridLinkKeys.filter((entry) => entry.dailyLimitReached).length;
        const disabledKeyCount = debridLinkKeys.filter((entry) => entry.disabled).length;
        const keyNotes: string[] = [];
        if (limitedCount > 0) {
          keyNotes.push(`${limitedCount}/${debridLinkKeys.length} API-Keys am Limit.`);
        }
        if (disabledKeyCount > 0) {
          keyNotes.push(`${disabledKeyCount}/${debridLinkKeys.length} API-Keys deaktiviert.`);
        }
        if (keyNotes.length > 0) {
          const combinedKeyNote = keyNotes.join(" ");
          note = note ? `${combinedKeyNote} ${note}` : combinedKeyNote;
        }
        if (debridLinkKeys.every((entry) => entry.disabled || entry.dailyLimitReached)) {
          dailyLimitReached = true;
        }
      }
      if (dailyLimitReached) {
        note = note
          ? `Tageslimit erreicht. Neue Links wechseln auf den nächsten Hoster. ${note}`
          : "Tageslimit erreicht. Neue Links wechseln auf den nächsten Hoster.";
      }
      entries.push({
        kind,
        service,
        provider,
        serviceLabel: option.serviceLabel,
        modeLabel: option.modeLabel,
        statusLabel: isDisabled ? "Deaktiviert" : statusLabel,
        summary: summarizeAccount(kind, settingsDraft),
        summaryLines: summarizeAccountLines(kind, settingsDraft),
        note,
        disabled: isDisabled,
        dailyUsedBytes,
        totalUsedBytes,
        dailyLimitBytes,
        dailyRemainingBytes,
        dailyLimitReached,
        debridLinkKeys
      });
    }
    return entries;
  }, [settingsDraft, snapshot.settings, allDebridHostInfo, allDebridHostLoading, hasSavedAllDebridAccount, allDebridSettingsDirty]);

  const configuredAccountServices = useMemo(() => new Set(configuredAccounts.map((entry) => entry.service)), [configuredAccounts]);
  const availableAccountOptions = useMemo(() => (
    ACCOUNT_OPTIONS.filter((option) => !configuredAccountServices.has(option.service))
  ), [configuredAccountServices]);
  const accountDialogOption = accountDialog?.kind ? findAccountOption(accountDialog.kind) : null;
  const accountDialogSelectableOptions = useMemo(() => {
    if (!accountDialog) {
      return [];
    }
    if (accountDialog.mode === "edit") {
      if (!accountDialogOption) {
        return [];
      }
      return ACCOUNT_OPTIONS.filter((option) => option.service === accountDialogOption.service);
    }
    return availableAccountOptions;
  }, [accountDialog, accountDialogOption, availableAccountOptions]);
  const accountDialogSearchQuery = accountDialogSearch.trim().toLowerCase();
  const filteredAccountDialogOptions = useMemo(() => (
    accountDialogSelectableOptions.filter((option) => {
      if (!accountDialogSearchQuery) {
        return true;
      }
      const haystack = [
        option.title,
        option.serviceLabel,
        option.modeLabel,
        option.pickerDescription,
        getAccountPickerFunctionLabel(option)
      ].join(" ").toLowerCase();
      return haystack.includes(accountDialogSearchQuery);
    })
  ), [accountDialogSearchQuery, accountDialogSelectableOptions]);
  const accountTableStyle = useMemo(() => ({
    "--account-col-service": `${accountColumnWidths.service}px`,
    "--account-col-mode": `${accountColumnWidths.mode}px`,
    "--account-col-status": `${accountColumnWidths.status}px`,
    "--account-col-secret": `${accountColumnWidths.secret}px`
  } as CSSProperties), [accountColumnWidths]);

  const handleUpdateResult = async (result: UpdateCheckResult, source: "manual" | "startup"): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }
    if (result.error) {
      if (source === "manual") { showToast(`Update-Check fehlgeschlagen: ${result.error}`, 2800); }
      return;
    }
    if (!result.updateAvailable) {
      setUpdateInstallProgress(null);
      if (source === "manual") { showToast(`Kein Update verfügbar (v${result.currentVersion})`, 2000); }
      return;
    }
    let changelogText = "";
    if (result.releaseNotes) {
      const lines = result.releaseNotes.split("\n");
      const compactLines: string[] = [];
      for (const line of lines) {
        if (/^\s{2,}[-*]/.test(line)) continue;
        if (/^#{1,6}\s/.test(line)) continue;
        if (!line.trim()) continue;
        let clean = line
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/^\s*[-*]\s+/, "- ")
          .trim();
        const colonIdx = clean.indexOf(":");
        if (colonIdx > 0 && colonIdx < clean.length - 1) {
          const afterColon = clean.slice(colonIdx + 1).trim();
          if (afterColon.length > 60) {
            clean = clean.slice(0, colonIdx + 1).trim();
          }
        }
        if (clean) compactLines.push(clean);
      }
      changelogText = compactLines.join("\n");
    }
    const approved = await askConfirmPrompt({
      title: "Update verfügbar",
      message: `${result.latestTag} (aktuell v${result.currentVersion})\n\nJetzt automatisch herunterladen und installieren?`,
      confirmLabel: "Jetzt installieren",
      details: changelogText || undefined
    });
    if (!mountedRef.current) {
      return;
    }
    if (!approved) { showToast(`Update verfügbar: ${result.latestTag}`, 2600); return; }
    setUpdateInstallProgress({
      stage: "starting",
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Update wird vorbereitet"
    });
    const install = await window.rd.installUpdate();
    if (!mountedRef.current) {
      return;
    }
    if (install.started) { showToast("Stilles Update gestartet - App wird neu gestartet", 2600); return; }
    setUpdateInstallProgress({
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: install.message
    });
    showToast(`Auto-Update fehlgeschlagen: ${install.message}`, 3200);
  };

  const onSaveSettings = async (): Promise<void> => {
    await performQuickAction(async () => {
      const result = await persistDraftSettings();
      applyTheme(result.theme);
      showToast("Einstellungen gespeichert", 1800);
    }, (error) => {
      showToast(`Einstellungen konnten nicht gespeichert werden: ${String(error)}`, 2800);
    });
  };

  const onOpenRealDebridLogin = async (): Promise<void> => {
    await performQuickAction(async () => {
      await persistDraftSettings();
      await window.rd.openRealDebridLogin();
      showToast("Real-Debrid Login-Fenster geöffnet", 2200);
    }, (error) => {
      showToast(`Real-Debrid Login fehlgeschlagen: ${String(error)}`, 2800);
    });
  };

  const onOpenAllDebridLogin = async (): Promise<void> => {
    await performQuickAction(async () => {
      await persistDraftSettings();
      await window.rd.openAllDebridLogin();
      showToast("AllDebrid Login-Fenster geöffnet", 2200);
    }, (error) => {
      showToast(`AllDebrid Login fehlgeschlagen: ${String(error)}`, 2800);
    });
  };

  const onImportBestDebridCookies = async (): Promise<void> => {
    await performQuickAction(async () => {
      await persistDraftSettings();
      const count = await window.rd.importBestDebridCookies();
      if (count > 0) {
        showToast(`${count} BestDebrid-Cookies importiert`, 2200);
      } else {
        showToast("Keine Cookie-Datei ausgewählt", 2200);
      }
    }, (error) => {
      showToast(`BestDebrid Cookie-Import fehlgeschlagen: ${String(error)}`, 2800);
    });
  };

  const applyPersistedSettings = (result: AppSettings): void => {
    setSettingsDraft(result);
    settingsDirtyRef.current = false;
    panelDirtyRevisionRef.current = 0;
    setSettingsDirty(false);
    applyTheme(result.theme);
  };

  const syncLiveProviderUsageSettings = (result: AppSettings): void => {
    setSnapshot((prev) => ({ ...prev, settings: result }));
    if (!settingsDirtyRef.current) {
      applyPersistedSettings(result);
      return;
    }
    setSettingsDraft((prev) => ({
      ...prev,
      totalDownloadedAllTime: Math.max(prev.totalDownloadedAllTime, result.totalDownloadedAllTime),
      providerDailyUsageDay: result.providerDailyUsageDay,
      providerDailyUsageBytes: { ...(result.providerDailyUsageBytes || {}) },
      providerTotalUsageBytes: { ...(result.providerTotalUsageBytes || {}) },
      debridLinkApiKeyDailyUsageBytes: { ...(result.debridLinkApiKeyDailyUsageBytes || {}) },
      debridLinkApiKeyTotalUsageBytes: { ...(result.debridLinkApiKeyTotalUsageBytes || {}) }
    }));
  };

  const persistSpecificSettings = async (nextDraft: AppSettings): Promise<AppSettings> => {
    const normalizedDraft = {
      ...nextDraft,
      ...normalizeProviderSelectionForSettings(nextDraft)
    };
    const result = await window.rd.updateSettings(normalizedDraft);
    applyPersistedSettings(result);
    return result;
  };

  const runAccountQuickAction = async (action: AccountQuickAction): Promise<void> => {
    switch (action) {
      case "realdebrid-login":
        await window.rd.openRealDebridLogin();
        showToast("Real-Debrid Login-Fenster geöffnet", 2200);
        return;
      case "bestdebrid-cookies": {
        const count = await window.rd.importBestDebridCookies();
        showToast(count > 0 ? `${count} BestDebrid-Cookies importiert` : "Keine Cookie-Datei ausgewählt", 2200);
        return;
      }
      case "alldebrid-login":
        await window.rd.openAllDebridLogin();
        showToast("AllDebrid Login-Fenster geöffnet", 2200);
        return;
      case "alldebrid-status":
        await loadAllDebridHostInfo(false);
        return;
      default:
        return;
    }
  };

  const getAccountQuickActionMeta = (kind: AccountKind): { label: string; action: AccountQuickAction } | null => {
    switch (kind) {
      case "realdebrid-web":
        return { label: "Login", action: "realdebrid-login" };
      case "bestdebrid-web":
        return { label: "Cookies", action: "bestdebrid-cookies" };
      case "alldebrid-api":
        return { label: "Status", action: "alldebrid-status" };
      case "alldebrid-web":
        return { label: "Login", action: "alldebrid-login" };
      default:
        return null;
    }
  };

  const openCreateAccountDialog = (): void => {
    setAccountDialogSearch("");
    setAccountDialog(createAccountDialogState("create", null, settingsDraft));
  };

  const openEditAccountDialog = (kind: AccountKind): void => {
    setAccountDialogSearch("");
    setAccountDialog(createAccountDialogState("edit", kind, settingsDraft));
  };

  const updateAccountDialogKind = (kind: AccountKind): void => {
    setAccountDialog((prev) => {
      const next = createAccountDialogState(prev?.mode ?? "create", kind, settingsDraft);
      if (!prev) {
        return next;
      }
      if (findAccountOption(kind).needsToken) {
        next.token = prev.token;
      }
      if (findAccountOption(kind).needsCredentials) {
        next.login = prev.login;
        next.password = prev.password;
      }
      next.dailyLimitGb = prev.dailyLimitGb;
      return next;
    });
  };

  const closeAccountDialog = useCallback((): void => {
    setAccountDialog(null);
    setAccountDialogSearch("");
  }, []);

  const onSaveAccountDialog = async (quickAction?: AccountQuickAction): Promise<void> => {
    if (!accountDialog) {
      return;
    }
    const validationError = validateAccountDialog(accountDialog);
    if (validationError) {
      showToast(validationError, 2800);
      return;
    }
    const dialogSnapshot = accountDialog;
    const selectedOption = dialogSnapshot.kind ? findAccountOption(dialogSnapshot.kind) : null;
    await performQuickAction(async () => {
      const nextDraft = applyAccountDialogToSettings(settingsDraft, dialogSnapshot);
      await persistSpecificSettings(nextDraft);
      closeAccountDialog();
      if (quickAction) {
        await runAccountQuickAction(quickAction);
      } else if (selectedOption) {
        showToast(`${selectedOption.title} gespeichert`, 2200);
      }
    }, (error) => {
      showToast(`Account konnte nicht gespeichert werden: ${String(error)}`, 3200);
    });
  };

  const onRemoveAccount = async (entry: ConfiguredAccountEntry): Promise<void> => {
    const confirmed = await askConfirmPrompt({
      title: `${entry.serviceLabel} entfernen`,
      message: `Soll ${entry.serviceLabel} wirklich aus der Accountliste entfernt werden?`,
      confirmLabel: "Entfernen",
      danger: true
    });
    if (!confirmed) {
      return;
    }
    await performQuickAction(async () => {
      const nextDraft = clearAccountServiceFromSettings(settingsDraft, entry.service);
      await persistSpecificSettings(nextDraft);
      if (entry.service === "alldebrid") {
        setAllDebridHostInfo(null);
      }
      showToast(`${entry.serviceLabel} entfernt`, 2200);
    }, (error) => {
      showToast(`Account konnte nicht entfernt werden: ${String(error)}`, 3200);
    });
  };

  const onResetAccountDailyUsage = async (entry: ConfiguredAccountEntry): Promise<void> => {
    await performQuickAction(async () => {
      const result = await window.rd.resetProviderDailyUsage(getAccountServiceProvider(entry.service));
      syncLiveProviderUsageSettings(result);
      showToast(`${entry.serviceLabel}: Tageszähler zurückgesetzt`, 2200);
    }, (error) => {
      showToast(`${entry.serviceLabel}: Reset fehlgeschlagen: ${String(error)}`, 3200);
    });
  };

  const onResetDebridLinkApiKeyDailyUsage = async (entry: ConfiguredAccountEntry, keyId: string, keyLabel: string): Promise<void> => {
    await performQuickAction(async () => {
      const result = await window.rd.resetDebridLinkApiKeyDailyUsage(keyId);
      syncLiveProviderUsageSettings(result);
      showToast(`${entry.serviceLabel} ${keyLabel}: Tageszähler zurückgesetzt`, 2200);
    }, (error) => {
      showToast(`${entry.serviceLabel} ${keyLabel}: Reset fehlgeschlagen: ${String(error)}`, 3200);
    });
  };

  const onToggleDebridLinkApiKeyEnabled = async (entry: ConfiguredAccountEntry, key: DebridLinkAccountKeyEntry): Promise<void> => {
    await performQuickAction(async () => {
      const currentDisabledIds = settingsDraft.debridLinkDisabledKeyIds || [];
      const nextDisabledIds = key.disabled
        ? currentDisabledIds.filter((existingId) => existingId !== key.id)
        : [...currentDisabledIds, key.id];
      const nextDraft: AppSettings = {
        ...settingsDraft,
        debridLinkDisabledKeyIds: nextDisabledIds
      };
      await persistSpecificSettings(nextDraft);
      showToast(
        key.disabled
          ? `${entry.serviceLabel} ${key.label} aktiviert`
          : `${entry.serviceLabel} ${key.label} deaktiviert`,
        2200
      );
    }, (error) => {
      showToast(`${entry.serviceLabel} ${key.label}: Umschalten fehlgeschlagen: ${String(error)}`, 3200);
    });
  };

  const onAccountRowQuickAction = async (entry: ConfiguredAccountEntry): Promise<void> => {
    const meta = getAccountQuickActionMeta(entry.kind);
    if (!meta) {
      return;
    }
    await performQuickAction(async () => {
      await runAccountQuickAction(meta.action);
    }, (error) => {
      showToast(`${entry.serviceLabel}: Aktion fehlgeschlagen: ${String(error)}`, 3200);
    });
  };

  const onToggleAccountEnabled = async (entry: ConfiguredAccountEntry): Promise<void> => {
    await performQuickAction(async () => {
      const provider = entry.service as DebridProvider;
      const current = settingsDraft.disabledProviders || [];
      const nextDisabledProviders = current.includes(provider)
        ? current.filter((existing) => existing !== provider)
        : [...current, provider];
      const nextDraft: AppSettings = {
        ...settingsDraft,
        disabledProviders: nextDisabledProviders
      };
      await persistSpecificSettings(nextDraft);
      showToast(
        nextDisabledProviders.includes(provider)
          ? `${entry.serviceLabel} deaktiviert`
          : `${entry.serviceLabel} aktiviert`,
        2200
      );
    }, (error) => {
      showToast(`${entry.serviceLabel} konnte nicht umgeschaltet werden: ${String(error)}`, 3200);
    });
  };

  const onCheckUpdates = async (): Promise<void> => {
    let updateResult: UpdateCheckResult | null = null;
    await performQuickAction(async () => {
      setUpdateInstallProgress(null);
      updateResult = await window.rd.checkUpdates();
    }, (error) => {
      showToast(`Update-Check fehlgeschlagen: ${String(error)}`, 2800);
    });
    if (updateResult) await handleUpdateResult(updateResult, "manual");
  };

  const persistDraftSettings = async (): Promise<AppSettings> => {
    const revisionAtStart = settingsDraftRevisionRef.current;
    const result = await window.rd.updateSettings(normalizedSettingsDraft);
    if (settingsDraftRevisionRef.current === revisionAtStart) {
      applyPersistedSettings(result);
    }
    return result;
  };

  const closeStartConflictPrompt = (result: { policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null): void => {
    const resolver = startConflictResolverRef.current;
    startConflictResolverRef.current = null;
    setStartConflictPrompt(null);
    if (resolver) {
      resolver(result);
    }
  };

  const askStartConflictDecision = (entry: StartConflictEntry): Promise<{ policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null> => {
    return new Promise((resolve) => {
      startConflictResolverRef.current = resolve;
      setStartConflictPrompt({
        entry,
        applyToAll: false
      });
    });
  };

  const pumpConfirmQueue = useCallback((): void => {
    if (confirmResolverRef.current) {
      return;
    }
    const next = confirmQueueRef.current.shift();
    if (!next) {
      return;
    }
    confirmResolverRef.current = next.resolve;
    setConfirmPrompt(next.prompt);
  }, []);

  const closeConfirmPrompt = useCallback((confirmed: boolean): void => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmPrompt(null);
    if (resolver) {
      resolver(confirmed);
    }
    pumpConfirmQueue();
  }, [pumpConfirmQueue]);

  const askConfirmPrompt = useCallback((prompt: ConfirmPromptState): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmQueueRef.current.push({ prompt, resolve });
      pumpConfirmQueue();
    });
  }, [pumpConfirmQueue]);

  const onStartDownloads = async (): Promise<void> => {
    await performQuickAction(async () => {
      if (totalConfiguredAccounts === 0) {
        setTab("settings");
        showToast("Bitte zuerst mindestens einen Hoster-Account eintragen", 3000);
        return;
      }

      await persistDraftSettings();
      const conflicts = await window.rd.getStartConflicts();
      let skipped = 0;
      let overwritten = 0;
      let rememberedPolicy: Extract<DuplicatePolicy, "skip" | "overwrite"> | null = null;

      if (settingsDraft.autoSkipExtracted && conflicts.length > 0) {
        rememberedPolicy = "skip";
      }

      for (const conflict of conflicts) {
        let decisionPolicy = rememberedPolicy;
        if (!decisionPolicy) {
          const decision = await askStartConflictDecision(conflict);
          if (!decision) {
            showToast("Start abgebrochen", 1800);
            return;
          }
          decisionPolicy = decision.policy;
          if (decision.applyToAll) {
            rememberedPolicy = decision.policy;
          }
        }

        const result = await window.rd.resolveStartConflict(conflict.packageId, decisionPolicy);
        if (result.skipped) {
          skipped += 1;
        }
        if (result.overwritten) {
          overwritten += 1;
        }
      }

      if (conflicts.length > 0 && !settingsDraft.autoSkipExtracted) {
        showToast(`Konflikte gelöst: ${overwritten} überschrieben, ${skipped} übersprungen`, 2800);
      }

      await window.rd.start();
    });
  };

  const collapseNewPackages = async (existingIds: Set<string>): Promise<void> => {
    const fresh = await window.rd.getSnapshot();
    const newIds = Object.keys(fresh.session.packages).filter((id) => !existingIds.has(id));
    if (newIds.length > 0) {
      setCollapsedPackages((prev) => {
        const next = { ...prev };
        for (const id of newIds) { next[id] = true; }
        return next;
      });
    }
  };

  const onAddLinks = async (): Promise<void> => {
    await performQuickAction(async () => {
      const activeId = activeCollectorTabRef.current;
      const active = collectorTabsRef.current.find((t) => t.id === activeId) ?? collectorTabsRef.current[0];
      const rawText = active?.text ?? "";
      const persisted = await persistDraftSettings();
      const existingIds = new Set(Object.keys(snapshotRef.current.session.packages));
      const result = await window.rd.addLinks({ rawText, packageName: persisted.packageName });
      if (result.addedLinks > 0) {
        showToast(`${result.addedPackages} Paket(e), ${result.addedLinks} Link(s) hinzugefügt`);
        setCollectorTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, text: "" } : t));
        if (snapshotRef.current.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
      } else {
        showToast("Keine gültigen Links gefunden");
      }
    }, (error) => {
      showToast(`Fehler beim Hinzufügen: ${String(error)}`, 2600);
    });
  };

  const onImportDlc = async (): Promise<void> => {
    await performQuickAction(async () => {
      const files = await window.rd.pickContainers();
      if (files.length === 0) { return; }
      await persistDraftSettings();
      const existingIds = new Set(Object.keys(snapshotRef.current.session.packages));
      const result = await window.rd.addContainers(files);
      if (result.addedLinks > 0) {
        showToast(`DLC importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
        if (snapshotRef.current.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
      } else {
        showToast("Keine gültigen Links in den DLC-Dateien gefunden", 3000);
      }
    }, (error) => {
      showToast(`Fehler beim DLC-Import: ${String(error)}`, 2600);
    });
  };

  const onExportPackageSelection = async (packageIds: string[]): Promise<void> => {
    closeMenus();
    await performQuickAction(async () => {
      const result = await window.rd.exportPackageSelection(packageIds);
      if (result.saved) {
        showToast(`${result.packageCount} Paket(e), ${result.linkCount} Link(s) exportiert`, 2800);
      }
    }, (error) => {
      showToast(`Export fehlgeschlagen: ${String(error)}`, 2600);
    });
  };

  const onExportItemSelection = async (itemIds: string[]): Promise<void> => {
    closeMenus();
    await performQuickAction(async () => {
      const result = await window.rd.exportItemSelection(itemIds);
      if (result.saved) {
        showToast(`${result.packageCount} Paket(e), ${result.linkCount} Link(s) exportiert`, 2800);
      }
    }, (error) => {
      showToast(`Export fehlgeschlagen: ${String(error)}`, 2600);
    });
  };

  onImportDlcRef.current = onImportDlc;

  const onDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault();
    dragDepthRef.current = 0;
    dragOverRef.current = false;
    setDragOver(false);
    const hasFiles = event.dataTransfer.types.includes("Files");
    const hasUri = event.dataTransfer.types.includes("text/uri-list");
    if (!hasFiles && !hasUri) { return; }
    const files = Array.from(event.dataTransfer.files ?? []) as File[];
    const dlc = files.filter((f) => f.name.toLowerCase().endsWith(".dlc")).map((f) => (f as unknown as { path?: string }).path).filter((v): v is string => !!v);
    const importFiles = files.filter((f) => /\.(json|txt)$/i.test(f.name));
    const droppedText = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list") || "";
    if (dlc.length > 0) {
      await performQuickAction(async () => {
        await persistDraftSettings();
        const existingIds = new Set(Object.keys(snapshotRef.current.session.packages));
        const result = await window.rd.addContainers(dlc);
        if (result.addedLinks > 0) {
          showToast(`Drag-and-Drop: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
          if (snapshotRef.current.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
        } else {
          showToast("Keine gültigen Links in den DLC-Dateien gefunden", 3000);
        }
      }, (error) => {
        showToast(`Fehler bei Drag-and-Drop: ${String(error)}`, 2600);
      });
    } else if (importFiles.length > 0) {
      await performQuickAction(async () => {
        await persistDraftSettings();
        const existingIds = new Set(Object.keys(snapshotRef.current.session.packages));
        let addedPackages = 0;
        let addedLinks = 0;
        for (const file of importFiles) {
          const text = await file.text();
          const result = await window.rd.importQueue(text);
          addedPackages += result.addedPackages;
          addedLinks += result.addedLinks;
        }
        if (addedLinks > 0) {
          showToast(`Importiert: ${addedPackages} Paket(e), ${addedLinks} Link(s)`);
          if (snapshotRef.current.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
        } else {
          showToast("Keine gültigen Links in den Import-Dateien gefunden", 3000);
        }
      }, (error) => {
        showToast(`Fehler bei Drag-and-Drop: ${String(error)}`, 2600);
      });
    } else if (droppedText.trim()) {
      const activeCollectorId = activeCollectorTabRef.current;
      setCollectorTabs((prev) => prev.map((t) => t.id === activeCollectorId
        ? { ...t, text: t.text ? `${t.text}\n${droppedText}` : droppedText } : t));
      setTab("collector");
      showToast("Links per Drag-and-Drop eingefügt");
    }
  };

  const onExportQueue = async (): Promise<void> => {
    await performQuickAction(async () => {
      const result = await window.rd.exportQueue();
      if (result.saved) {
        showToast("Queue exportiert");
      }
    }, (error) => {
      showToast(`Export fehlgeschlagen: ${String(error)}`, 2600);
    });
  };

  const onImportQueue = async (): Promise<void> => {
    if (actionBusyRef.current) {
      return;
    }

    actionBusyRef.current = true;
    setActionBusy(true);

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.txt";

    const releasePickerBusy = (): void => {
      actionBusyRef.current = false;
      setActionBusy(false);
    };

    const onWindowFocus = (): void => {
      clearImportQueueFocusListener();
      if (!input.files || input.files.length === 0) {
        releasePickerBusy();
      }
    };

    input.onchange = async () => {
      clearImportQueueFocusListener();
      const file = input.files?.[0];
      if (!file) {
        releasePickerBusy();
        return;
      }
      releasePickerBusy();
      await performQuickAction(async () => {
        await persistDraftSettings();
        const existingIds = new Set(Object.keys(snapshotRef.current.session.packages));
        const text = await file.text();
        const result = await window.rd.importQueue(text);
        if (result.addedLinks > 0) {
          showToast(`Importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
          if (snapshotRef.current.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
        } else {
          showToast("Keine gültigen Links in der Datei gefunden", 3000);
        }
      }, (error) => {
        showToast(`Import fehlgeschlagen: ${String(error)}`, 2600);
      });
    };

    clearImportQueueFocusListener();
    importQueueFocusHandlerRef.current = onWindowFocus;
    window.addEventListener("focus", onWindowFocus, { once: true });
    input.click();
  };

  const setBool = (key: keyof AppSettings, value: boolean): void => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };
  const setText = (key: keyof AppSettings, value: string): void => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };
  const setNum = (key: keyof AppSettings, value: number): void => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };
  const setSpeedLimitMbps = (value: number): void => {
    const mbps = Number.isFinite(value) ? Math.max(0, value) : 0;
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: Math.floor(mbps * 1024) }));
  };

  const performQuickAction = async (
    action: () => Promise<unknown>,
    onError?: (error: unknown) => void
  ): Promise<void> => {
    if (actionBusyRef.current) {
      return;
    }
    actionBusyRef.current = true;
    setActionBusy(true);
    try {
      await action();
    } catch (error) {
      if (onError) {
        onError(error);
      } else {
        showToast(`Fehler: ${String(error)}`, 2600);
      }
    } finally {
      if (actionUnlockTimerRef.current) {
        clearTimeout(actionUnlockTimerRef.current);
      }
      actionUnlockTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) {
          actionUnlockTimerRef.current = null;
          return;
        }
        actionBusyRef.current = false;
        setActionBusy(false);
        actionUnlockTimerRef.current = null;
      }, 80);
    }
  };

  const movePackage = useCallback((packageId: string, direction: "up" | "down") => {
    const currentOrder = packageOrderRef.current;
    const order = [...currentOrder];
    const idx = order.indexOf(packageId);
    if (idx < 0) { return; }
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= order.length) { return; }
    [order[idx], order[target]] = [order[target], order[idx]];
    setDownloadsSortDescending(false);
    pendingPackageOrderRef.current = [...order];
    pendingPackageOrderAtRef.current = Date.now();
    packageOrderRef.current = [...order];
    setSnapshot((prev) => {
      if (!prev) return prev;
      return { ...prev, session: { ...prev.session, packageOrder: [...order] } };
    });
    void window.rd.reorderPackages(order).catch((error) => {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = serverPackageOrderRef.current;
      setSnapshot((prev) => {
        if (!prev) return prev;
        return { ...prev, session: { ...prev.session, packageOrder: serverPackageOrderRef.current } };
      });
      showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const reorderPackagesByDrop = useCallback((draggedPackageId: string, targetPackageId: string) => {
    const currentOrder = packageOrderRef.current;
    const nextOrder = reorderPackageOrderByDrop(currentOrder, draggedPackageId, targetPackageId);
    const unchanged = nextOrder.length === currentOrder.length
      && nextOrder.every((id, index) => id === currentOrder[index]);
    if (unchanged) {
      return;
    }
    setDownloadsSortDescending(false);
    pendingPackageOrderRef.current = [...nextOrder];
    pendingPackageOrderAtRef.current = Date.now();
    packageOrderRef.current = [...nextOrder];
    setSnapshot((prev) => {
      if (!prev) return prev;
      return { ...prev, session: { ...prev.session, packageOrder: [...nextOrder] } };
    });
    void window.rd.reorderPackages(nextOrder).catch((error) => {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = serverPackageOrderRef.current;
      setSnapshot((prev) => {
        if (!prev) return prev;
        return { ...prev, session: { ...prev.session, packageOrder: serverPackageOrderRef.current } };
      });
      showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const addCollectorTab = (): void => {
    const id = `tab-${nextCollectorId++}`;
    setCollectorTabs((prev) => {
      const name = `Tab ${prev.length + 1}`;
      return [...prev, { id, name, text: "" }];
    });
    setActiveCollectorTab(id);
  };

  const removeCollectorTab = (id: string): void => {
    let fallbackId = "";
    setCollectorTabs((prev) => {
      if (prev.length <= 1) return prev;
      const index = prev.findIndex((tabEntry) => tabEntry.id === id);
      if (index < 0) return prev;
      const next = prev.filter((tabEntry) => tabEntry.id !== id);
      if (activeCollectorTabRef.current === id) {
        fallbackId = next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "";
      }
      return next;
    });
    if (fallbackId) setActiveCollectorTab(fallbackId);
  };

  const onPackageDragStart = useCallback((packageId: string) => {
    draggedPackageIdRef.current = packageId;
  }, []);

  const onPackageDrop = useCallback((targetPackageId: string) => {
    const draggedPackageId = draggedPackageIdRef.current;
    draggedPackageIdRef.current = null;
    if (!draggedPackageId || draggedPackageId === targetPackageId) {
      return;
    }
    reorderPackagesByDrop(draggedPackageId, targetPackageId);
  }, [reorderPackagesByDrop]);

  const onPackageDragEnd = useCallback(() => {
    draggedPackageIdRef.current = null;
  }, []);

  const onPackageStartEdit = useCallback((packageId: string, packageName: string): void => {
    setEditingPackageId(packageId);
    setEditingName(packageName);
  }, []);

  const onPackageFinishEdit = useCallback((packageId: string, currentName: string, nextName: string): void => {
    let shouldRename = false;
    setEditingPackageId((prev) => {
      if (prev !== packageId) return prev; // already finished (e.g. blur after Enter key)
      shouldRename = true;
      return null;
    });
    if (shouldRename) {
      const normalized = nextName.trim();
      if (normalized && normalized !== currentName.trim()) {
        void window.rd.renamePackage(packageId, normalized).catch((error) => {
          showToast(`Umbenennen fehlgeschlagen: ${String(error)}`, 2400);
        });
      }
    }
  }, [showToast]);

  const onPackageToggleCollapse = useCallback((packageId: string): void => {
    setCollapsedPackages((prev) => {
      const nextCollapsed = !(prev[packageId] ?? false);
      if (nextCollapsed) {
        manualCollapsedPkgsRef.current.add(packageId);
      } else {
        manualCollapsedPkgsRef.current.delete(packageId);
        autoExpandedPkgsRef.current.delete(packageId);
      }
      return { ...prev, [packageId]: nextCollapsed };
    });
  }, []);

  const onPackageCancel = useCallback((packageId: string): void => {
    setSnapshot((prev) => {
      if (!prev) { return prev; }
      const nextPackages = { ...prev.session.packages };
      const nextItems = { ...prev.session.items };
      const pkg = nextPackages[packageId];
      if (pkg) {
        for (const itemId of pkg.itemIds) {
          delete nextItems[itemId];
        }
        delete nextPackages[packageId];
      }
      return {
        ...prev,
        session: {
          ...prev.session,
          packages: nextPackages,
          items: nextItems,
          packageOrder: prev.session.packageOrder.filter((id) => id !== packageId)
        }
      };
    });
    void window.rd.cancelPackage(packageId).catch((error) => {
      showToast(`Paket-Löschung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const onPackageMoveUp = useCallback((packageId: string): void => {
    movePackage(packageId, "up");
  }, [movePackage]);

  const onPackageMoveDown = useCallback((packageId: string): void => {
    movePackage(packageId, "down");
  }, [movePackage]);

  const moveSelectedPackages = useCallback((direction: "up" | "down") => {
    const currentOrder = packageOrderRef.current;
    const selPkgs = new Set([...selectedIds].filter((id) => snapshot.session.packages[id]));
    if (selPkgs.size === 0) return;
    const order = [...currentOrder];
    if (direction === "up") {
      for (let i = 0; i < order.length; i++) {
        if (selPkgs.has(order[i]) && i > 0 && !selPkgs.has(order[i - 1])) {
          [order[i - 1], order[i]] = [order[i], order[i - 1]];
        }
      }
    } else {
      for (let i = order.length - 1; i >= 0; i--) {
        if (selPkgs.has(order[i]) && i < order.length - 1 && !selPkgs.has(order[i + 1])) {
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
        }
      }
    }
    const unchanged = order.length === currentOrder.length && order.every((id, idx) => id === currentOrder[idx]);
    if (unchanged) return;
    setDownloadsSortDescending(false);
    pendingPackageOrderRef.current = [...order];
    pendingPackageOrderAtRef.current = Date.now();
    packageOrderRef.current = [...order];
    // Optimistic UI update ? apply the new order immediately so the user
    // sees the change without waiting for the backend round-trip.
    setSnapshot((prev) => {
      if (!prev) return prev;
      return { ...prev, session: { ...prev.session, packageOrder: [...order] } };
    });
    void window.rd.reorderPackages(order).catch((error) => {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = serverPackageOrderRef.current;
      // Rollback: restore original order from server
      setSnapshot((prev) => {
        if (!prev) return prev;
        return { ...prev, session: { ...prev.session, packageOrder: serverPackageOrderRef.current } };
      });
      showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [selectedIds, snapshot.session.packages, showToast]);

  const onPackageToggle = useCallback((packageId: string): void => {
    let previousEnabled: boolean | null = null;
    setSnapshot((prev) => {
      const pkg = prev.session.packages[packageId];
      if (!pkg) {
        return prev;
      }
      previousEnabled = pkg.enabled;
      const nextEnabled = !pkg.enabled;
      const nextItems = { ...prev.session.items };
      if (!nextEnabled) {
        for (const itemId of pkg.itemIds) {
          const item = nextItems[itemId];
          if (!item) {
            continue;
          }
          if (item.status === "queued" || item.status === "reconnect_wait") {
            nextItems[itemId] = {
              ...item,
              fullStatus: "Paket gestoppt",
              updatedAt: Date.now()
            };
          }
        }
      } else {
        for (const itemId of pkg.itemIds) {
          const item = nextItems[itemId];
          if (!item) {
            continue;
          }
          if (item.status === "queued" && item.fullStatus === "Paket gestoppt") {
            nextItems[itemId] = {
              ...item,
              fullStatus: "Wartet",
              updatedAt: Date.now()
            };
          }
        }
      }
      const nextPkgStatus = !nextEnabled
        ? (pkg.status === "downloading" || pkg.status === "extracting" ? "paused" : pkg.status)
        : (pkg.status === "paused" ? "queued" : pkg.status);
      const nextSnapshot: UiSnapshot = {
        ...prev,
        session: {
          ...prev.session,
          items: nextItems,
          packages: {
            ...prev.session.packages,
            [packageId]: {
              ...pkg,
              enabled: nextEnabled,
              status: nextPkgStatus,
              updatedAt: Date.now()
            }
          },
          updatedAt: Date.now()
        }
      };
      latestStateRef.current = nextSnapshot;
      return nextSnapshot;
    });
    void window.rd.togglePackage(packageId).catch((error) => {
      if (previousEnabled !== null) {
        setSnapshot((prev) => {
          const pkg = prev.session.packages[packageId];
          if (!pkg) {
            return prev;
          }
          const revertedSnapshot: UiSnapshot = {
            ...prev,
            session: {
              ...prev.session,
              packages: {
                ...prev.session.packages,
                [packageId]: {
                  ...pkg,
                  enabled: previousEnabled,
                  status: previousEnabled && pkg.status === "paused" ? "queued" : pkg.status,
                  updatedAt: Date.now()
                }
              },
              updatedAt: Date.now()
            }
          };
          latestStateRef.current = revertedSnapshot;
          return revertedSnapshot;
        });
      }
      showToast(`Paket-Umschalten fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const onPackageRemoveItem = useCallback((itemId: string): void => {
    setSnapshot((prev) => {
      if (!prev) { return prev; }
      const item = prev.session.items[itemId];
      if (!item) { return prev; }
      const nextItems = { ...prev.session.items };
      delete nextItems[itemId];
      const nextPackages = { ...prev.session.packages };
      const pkg = nextPackages[item.packageId];
      if (pkg) {
        const nextItemIds = pkg.itemIds.filter((id) => id !== itemId);
        if (nextItemIds.length === 0) {
          delete nextPackages[item.packageId];
          return {
            ...prev,
            session: {
              ...prev.session,
              packages: nextPackages,
              items: nextItems,
              packageOrder: prev.session.packageOrder.filter((id) => id !== item.packageId)
            }
          };
        }
        nextPackages[item.packageId] = { ...pkg, itemIds: nextItemIds };
      }
      return { ...prev, session: { ...prev.session, packages: nextPackages, items: nextItems } };
    });
    void window.rd.removeItem(itemId).catch((error) => {
      showToast(`Entfernen fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const onPackageContextMenu = useCallback((packageId: string, itemId: string | undefined, x: number, y: number): void => {
    const clickedId = itemId ?? packageId;
    setSelectedIds((prev) => {
      if (prev.has(clickedId)) return prev;
      return new Set([clickedId]);
    });
    setContextMenu({ x, y, packageId, itemId });
  }, []);

  const speedHistoryRef = useRef<{ time: number; speed: number }[]>([]);
  const dragSelectRef = useRef(false);
  const dragAnchorRef = useRef<string | null>(null);
  const dragDidMoveRef = useRef(false);
  const lastClickedIdRef = useRef<string | null>(null);

  // Flat list of all visible IDs (package headers + their visible items) in display order
  const visibleOrderIds = useMemo(() => {
    const ids: string[] = [];
    for (const pkg of visiblePackages) {
      ids.push(pkg.id);
      if (!(collapsedPackages[pkg.id] ?? false)) {
        const items = itemsByPackage.get(pkg.id) ?? [];
        for (const item of items) {
          if (snapshot.settings.hideExtractedItems && item.fullStatus?.startsWith("Entpackt")) continue;
          ids.push(item.id);
        }
      }
    }
    return ids;
  }, [visiblePackages, collapsedPackages, itemsByPackage, snapshot.settings.hideExtractedItems]);

  const onSelectId = useCallback((id: string, ctrlKey: boolean, shiftKey: boolean): void => {
    if (dragDidMoveRef.current) return; // drag handled it, skip click
    if (shiftKey && lastClickedIdRef.current) {
      const anchorIdx = visibleOrderIds.indexOf(lastClickedIdRef.current);
      const targetIdx = visibleOrderIds.indexOf(id);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const from = Math.min(anchorIdx, targetIdx);
        const to = Math.max(anchorIdx, targetIdx);
        const rangeIds = visibleOrderIds.slice(from, to + 1);
        setSelectedIds((prev) => {
          const next = ctrlKey ? new Set(prev) : new Set<string>();
          for (const rid of rangeIds) next.add(rid);
          return next;
        });
        return;
      }
    }
    lastClickedIdRef.current = id;
    setSelectedIds((prev) => {
      if (ctrlKey) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      if (prev.size === 1 && prev.has(id)) return new Set();
      return new Set([id]);
    });
  }, [visibleOrderIds]);

  const onSelectMouseDown = useCallback((id: string, e: React.MouseEvent): void => {
    if (!e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    dragSelectRef.current = true;
    dragAnchorRef.current = id;
    dragDidMoveRef.current = false;
    const onUp = (): void => {
      dragSelectRef.current = false;
      dragAnchorRef.current = null;
      dragDidMoveRef.current = false;
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mouseup", onUp);
  }, []);

  const onSelectMouseEnter = useCallback((id: string): void => {
    if (!dragSelectRef.current) return;
    if (!dragDidMoveRef.current) {
      dragDidMoveRef.current = true;
      // Add anchor item now that we know it's a drag
      const anchor = dragAnchorRef.current;
      if (anchor) {
        setSelectedIds((prev) => { if (prev.has(anchor)) return prev; const next = new Set(prev); next.add(anchor); return next; });
      }
    }
    setSelectedIds((prev) => { if (prev.has(id)) return prev; const next = new Set(prev); next.add(id); return next; });
  }, []);

  const showLinksPopup = useCallback((packageId: string, itemId?: string): void => {
    const sel = selectedIds;
    const currentPackages = snapshotRef.current.session.packages;
    const currentItems = snapshotRef.current.session.items;
    // Multi-select: collect links from all selected packages/items
    if (sel.size > 1) {
      const allLinks: { name: string; url: string }[] = [];
      for (const id of sel) {
        const pkg = currentPackages[id];
        if (pkg) {
          for (const iid of pkg.itemIds) {
            const item = currentItems[iid];
            if (item) allLinks.push({ name: item.fileName, url: item.url });
          }
        } else {
          const item = currentItems[id];
          if (item) allLinks.push({ name: item.fileName, url: item.url });
        }
      }
      setLinkPopup({ title: `${sel.size} ausgewählt`, links: allLinks, isPackage: allLinks.length > 1 });
      setContextMenu(null);
      return;
    }
    const pkg = currentPackages[packageId];
    if (!pkg) { return; }
    if (itemId) {
      const item = currentItems[itemId];
      if (item) {
        setLinkPopup({ title: item.fileName, links: [{ name: item.fileName, url: item.url }], isPackage: false });
      }
    } else {
      const links = pkg.itemIds
        .map((id) => currentItems[id])
        .filter(Boolean)
        .map((item) => ({ name: item.fileName, url: item.url }));
      setLinkPopup({ title: pkg.name, links, isPackage: true });
    }
    setContextMenu(null);
  }, [selectedIds]);

  const schedules = settingsDraft.bandwidthSchedules ?? [];

  useEffect(() => {
    setScheduleSpeedInputs((prev) => {
      const syncFromSettings = !settingsDirtyRef.current;
      let changed = false;
      const next: Record<string, string> = {};
      for (let index = 0; index < schedules.length; index += 1) {
        const schedule = schedules[index];
        const key = schedule.id || `schedule-${index}`;
        const normalized = formatMbpsInputFromKbps(schedule.speedLimitKbps);
        if (syncFromSettings || !Object.prototype.hasOwnProperty.call(prev, key)) {
          next[key] = normalized;
          if (prev[key] !== normalized) {
            changed = true;
          }
        } else {
          next[key] = prev[key];
        }
      }
      const prevKeys = Object.keys(prev);
      if (prevKeys.length !== Object.keys(next).length) {
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [schedules, settingsDirty]);

  const addSchedule = (): void => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: [...(prev.bandwidthSchedules ?? []), { id: createScheduleId(), startHour: 0, endHour: 8, speedLimitKbps: 0, enabled: true }]
    }));
  };
  const removeSchedule = (idx: number): void => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: (prev.bandwidthSchedules ?? []).filter((_, i) => i !== idx)
    }));
  };
  const updateSchedule = (idx: number, field: keyof BandwidthScheduleEntry, value: number | boolean): void => {
    settingsDraftRevisionRef.current += 1;
    panelDirtyRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: (prev.bandwidthSchedules ?? []).map((s, i) => i === idx ? { ...s, [field]: value } : s)
    }));
  };

  const applyTheme = (theme: AppTheme): void => {
    document.documentElement.setAttribute("data-theme", theme);
  };

  const closeMenus = (): void => {
    setOpenMenu(null);
    setOpenSubmenu(null);
  };

  useEffect(() => {
    if (!contextMenu) { return; }
    const close = (): void => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !ctxMenuRef.current) return;
    const el = ctxMenuRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, contextMenu.y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(0, contextMenu.x - rect.width)}px`;
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!colHeaderCtx) return;
    const close = (e: MouseEvent): void => {
      // Don't close if click is inside the menu or on the header bar (re-position instead)
      if (colHeaderCtxRef.current && colHeaderCtxRef.current.contains(e.target as Node)) return;
      if (colHeaderBarRef.current && colHeaderBarRef.current.contains(e.target as Node)) return;
      setColHeaderCtx(null);
    };
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("mousedown", close);
    };
  }, [colHeaderCtx]);

  useLayoutEffect(() => {
    if (!colHeaderCtx || !colHeaderCtxRef.current) return;
    const el = colHeaderCtxRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, colHeaderCtx.y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(0, colHeaderCtx.x - rect.width)}px`;
    }
  }, [colHeaderCtx]);

  useEffect(() => {
    if (!historyCtxMenu) return;
    const close = (): void => setHistoryCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [historyCtxMenu]);

  useLayoutEffect(() => {
    if (!historyCtxMenu || !historyCtxMenuRef.current) return;
    const el = historyCtxMenuRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, historyCtxMenu.y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(0, historyCtxMenu.x - rect.width)}px`;
    }
  }, [historyCtxMenu]);

  const executeDeleteSelection = useCallback((ids: Set<string>): void => {
    const current = snapshotRef.current;
    const promises: Promise<void>[] = [];
    for (const id of ids) {
      if (current.session.items[id]) promises.push(window.rd.removeItem(id));
      else if (current.session.packages[id]) promises.push(window.rd.cancelPackage(id));
    }
    void Promise.all(promises).catch(() => {});
    setSelectedIds(new Set());
  }, []);

  const requestDeleteSelection = useCallback((): void => {
    if (selectedIds.size === 0) return;
    if (!settingsDraft.confirmDeleteSelection) {
      executeDeleteSelection(selectedIds);
      return;
    }
    setDeleteConfirm({ ids: new Set(selectedIds), dontAsk: false });
  }, [selectedIds, settingsDraft.confirmDeleteSelection, executeDeleteSelection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
          // Don't clear selection if an overlay is open ? let the overlay close first
          if (document.querySelector(".ctx-menu") || document.querySelector(".modal-backdrop")) return;
          if (tabRef.current === "downloads") setSelectedIds(new Set());
          else if (tabRef.current === "history") setSelectedHistoryIds(new Set());
        }
      }
      if (e.key === "Delete" && tabRef.current === "downloads" && selectedIds.size > 0) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        requestDeleteSelection();
      }
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest(".package-card") || target.closest(".ctx-menu") || target.closest(".modal-backdrop") || target.closest(".modal-card")) return;
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [selectedIds, requestDeleteSelection]);

  const onExportBackup = async (): Promise<void> => {
    closeMenus();
    await performQuickAction(async () => {
      const result = await window.rd.exportBackup();
      if (result.saved) {
        showToast("Sicherung exportiert");
      }
    }, (error) => {
      showToast(`Sicherung fehlgeschlagen: ${String(error)}`, 2600);
    });
  };

  const onImportBackup = async (): Promise<void> => {
    closeMenus();
    await performQuickAction(async () => {
      const result = await window.rd.importBackup();
      if (result.restored) {
        showToast(result.message, 4000);
      } else if (result.message !== "Abgebrochen") {
        showToast(`Sicherung laden fehlgeschlagen: ${result.message}`, 3000);
      }
    }, (error) => {
      showToast(`Sicherung laden fehlgeschlagen: ${String(error)}`, 2600);
    });
  };

  const onExportSupportBundle = async (): Promise<void> => {
    closeMenus();
    await performQuickAction(async () => {
      const result = await window.rd.exportSupportBundle();
      if (result.saved) {
        showToast("Support-Bundle exportiert", 2600);
      }
    }, (error) => {
      showToast(`Support-Bundle fehlgeschlagen: ${String(error)}`, 2800);
    });
  };

  const onToggleSupportTrace = async (): Promise<void> => {
    closeMenus();
    const nextEnabled = !supportTraceEnabled;
    await performQuickAction(async () => {
      const result = await window.rd.setTraceEnabled(nextEnabled, "UI support toggle", 120);
      setSupportTraceEnabled(result.enabled);
      showToast(result.enabled ? "Support-Trace für 2 Stunden aktiviert" : "Support-Trace deaktiviert", 2600);
    }, (error) => {
      showToast(`Support-Trace fehlgeschlagen: ${String(error)}`, 2800);
    });
  };

  const onRunDebugSetupCheck = async (): Promise<void> => {
    closeMenus();
    try {
      const setup = await window.rd.getDebugSetupCheck();
      const warningText = setup.warnings.length > 0 ? `Warnungen: ${setup.warnings.length}` : "Keine akuten Warnungen";
      const reachabilityText = setup.localOnly ? "Nur lokal gebunden" : "Remote-fähig konfiguriert";
      const details = buildDebugSetupDetails(setup);
      await askConfirmPrompt({
        title: "Debug-Setup prüfen",
        message: `${warningText}\n${reachabilityText}\nHost: ${setup.host}:${setup.port}`,
        confirmLabel: "Schließen",
        cancelLabel: "Schließen",
        details,
        detailsLabel: "Details anzeigen"
      });
    } catch (error) {
      showToast(`Debug-Setup-Check fehlgeschlagen: ${String(error)}`, 3000);
    }
  };

  const onRotateDebugToken = async (): Promise<void> => {
    closeMenus();
    const confirmed = await askConfirmPrompt({
      title: "Debug-Token rotieren",
      message: "Das aktuelle Debug-Token wird ersetzt. Externe Debug-Links mit altem Token funktionieren danach nicht mehr.",
      confirmLabel: "Token rotieren",
      danger: true
    });
    if (!confirmed) {
      return;
    }
    await performQuickAction(async () => {
      const result = await window.rd.rotateDebugToken();
      showToast(`Debug-Token rotiert: ${result.path}`, 4200);
    }, (error) => {
      showToast(`Token-Rotation fehlgeschlagen: ${String(error)}`, 3000);
    });
  };

  const onMenuRestart = (): void => {
    closeMenus();
    void window.rd.restart();
  };

  const onMenuQuit = (): void => {
    closeMenus();
    void window.rd.quit();
  };

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
        if (e.shiftKey && e.key.toLowerCase() === "r") {
          if (inInput) return;
          e.preventDefault();
          void window.rd.restart();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "q") {
          if (inInput) return;
          e.preventDefault();
          void window.rd.quit();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "l") {
          if (inInput) return;
          e.preventDefault();
          setTab("collector");
          setOpenMenu(null);
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "p") {
          if (inInput) return;
          e.preventDefault();
          setTab("settings");
          setOpenMenu(null);
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "o") {
          if (inInput) return;
          e.preventDefault();
          setOpenMenu(null);
          void onImportDlcRef.current();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "a") {
          if (inInput) return;
          if (tabRef.current === "downloads") {
            e.preventDefault();
            setSelectedIds(new Set(Object.keys(snapshotRef.current.session.packages)));
          } else if (tabRef.current === "history") {
            e.preventDefault();
            setSelectedHistoryIds(new Set(historyEntriesRef.current.map(e => e.id)));
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!openMenu) { return; }
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (!target.closest(".menu-bar")) {
        setOpenMenu(null);
        setOpenSubmenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenu]);

  const packageSpeedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const [pid, bps] of Object.entries(snapshot.packageSpeedBps)) {
      if (bps > 0) map.set(pid, bps);
    }
    return map;
  }, [snapshot.packageSpeedBps]);

  const itemStatusCounts = useMemo(() => {
    const counts = { downloading: 0, queued: 0, failed: 0 };
    for (const item of Object.values(snapshot.session.items)) {
      if (item.status === "downloading") {
        counts.downloading += 1;
      } else if (item.status === "queued" || item.status === "reconnect_wait") {
        counts.queued += 1;
      } else if (item.status === "failed") {
        counts.failed += 1;
      }
    }
    return counts;
  }, [snapshot.session.items]);

  const providerStats = useMemo(() => {
    const stats: Record<string, { total: number; completed: number; failed: number; bytes: number }> = {};
    for (const item of Object.values(snapshot.session.items)) {
      const hoster = extractHoster(item.url) || "unknown";
      if (!stats[hoster]) {
        stats[hoster] = { total: 0, completed: 0, failed: 0, bytes: 0 };
      }
      stats[hoster].total += 1;
      if (item.status === "completed") stats[hoster].completed += 1;
      if (item.status === "failed") stats[hoster].failed += 1;
      stats[hoster].bytes += item.downloadedBytes;
    }
    return Object.entries(stats);
  }, [snapshot.session.items]);

  return (
    <div
      className={`app-shell${dragOver ? " drag-over" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (draggedPackageIdRef.current) { return; }
        const hasFiles = event.dataTransfer.types.includes("Files");
        const hasUri = event.dataTransfer.types.includes("text/uri-list");
        if (!hasFiles && !hasUri) { return; }
        dragDepthRef.current += 1;
        if (!dragOverRef.current) {
          dragOverRef.current = true;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={() => {
        if (draggedPackageIdRef.current) { return; }
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0 && dragOverRef.current) {
          dragOverRef.current = false;
          setDragOver(false);
        }
      }}
      onDrop={onDrop}
    >
      <nav className="menu-bar">
        <div className="menu-bar-item">
          <button
            className={`menu-bar-trigger${openMenu === "datei" ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === "datei" ? null : "datei")}
            onMouseEnter={() => { if (openMenu && openMenu !== "datei") { setOpenMenu("datei"); setOpenSubmenu(null); } }}
          >
            Datei
          </button>
          {openMenu === "datei" && (
            <div className="menu-dropdown">
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); setTab("collector"); }}>
                <span>Text mit Links analysieren</span>
                <span className="shortcut">Strg+L</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void onImportQueue(); }}>
                <span>Datei importieren</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void onImportDlc(); }}>
                <span>Linkcontainer laden</span>
                <span className="shortcut">Strg+O</span>
              </button>
              <div className="menu-separator" />
              <div
                className="menu-submenu"
                onMouseEnter={() => setOpenSubmenu("sicherung")}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                <button className="menu-submenu-trigger">Sicherung</button>
                {openSubmenu === "sicherung" && (
                  <div className="menu-submenu-dropdown">
                    <button className="menu-dropdown-item" onClick={() => { void onExportBackup(); }}>Erstellen</button>
                    <button className="menu-dropdown-item" onClick={() => { void onImportBackup(); }}>Laden</button>
                  </div>
                )}
              </div>
              <div className="menu-separator" />
              <button className="menu-dropdown-item" onClick={onMenuRestart}>
                <span>Neustart</span>
                <span className="shortcut">Strg+Umschalt+R</span>
              </button>
              <button className="menu-dropdown-item" onClick={onMenuQuit}>
                <span>Beenden</span>
                <span className="shortcut">Strg+Q</span>
              </button>
            </div>
          )}
        </div>
        <div className="menu-bar-item">
          <button
            className={`menu-bar-trigger${openMenu === "einstellungen" ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === "einstellungen" ? null : "einstellungen")}
            onMouseEnter={() => { if (openMenu && openMenu !== "einstellungen") { setOpenMenu("einstellungen"); setOpenSubmenu(null); } }}
          >
            Einstellungen
          </button>
          {openMenu === "einstellungen" && (
            <div className="menu-dropdown">
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); setTab("settings"); }}>
                <span>Einstellungen</span>
                <span className="shortcut">Strg+P</span>
              </button>
              <div className="menu-separator" />
              <div className="menu-settings-grid" onClick={(e) => e.stopPropagation()}>
                <span>Max. gleichzeitige Downloads</span>
                <span />
                <div className="menu-spinner">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={settingsDraft.maxParallel}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(50, Number(e.target.value) || 1));
                      settingsDirtyRef.current = true;
                      const rev = ++settingsDraftRevisionRef.current;
                      setSettingsDraft((prev) => ({ ...prev, maxParallel: val }));
                      void window.rd.updateSettings({ maxParallel: val }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                    }}
                  />
                  <div className="menu-spinner-arrows">
                    <button onClick={() => {
                      const val = Math.min(50, settingsDraft.maxParallel + 1);
                      settingsDirtyRef.current = true;
                      const rev = ++settingsDraftRevisionRef.current;
                      setSettingsDraft((prev) => ({ ...prev, maxParallel: val }));
                      void window.rd.updateSettings({ maxParallel: val }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                    }}>&#9650;</button>
                    <button onClick={() => {
                      const val = Math.max(1, settingsDraft.maxParallel - 1);
                      settingsDirtyRef.current = true;
                      const rev = ++settingsDraftRevisionRef.current;
                      setSettingsDraft((prev) => ({ ...prev, maxParallel: val }));
                      void window.rd.updateSettings({ maxParallel: val }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                    }}>&#9660;</button>
                  </div>
                </div>
                <span />

                <span>Geschwindigkeitslimit</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.speedLimitEnabled}
                  onChange={(e) => {
                    const next = e.target.checked;
                    settingsDirtyRef.current = true;
                    const rev = ++settingsDraftRevisionRef.current;
                    setSettingsDraft((prev) => ({ ...prev, speedLimitEnabled: next }));
                    void window.rd.updateSettings({ speedLimitEnabled: next }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                  }}
                />
                <div className={`menu-spinner${!settingsDraft.speedLimitEnabled ? " disabled" : ""}`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={speedLimitInput}
                    onChange={(e) => {
                      setSpeedLimitInput(e.target.value);
                    }}
                    onBlur={() => {
                      const parsed = parseMbpsInput(speedLimitInput);
                      if (parsed === null) {
                        setSpeedLimitInput(formatMbpsInputFromKbps(settingsDraft.speedLimitKbps));
                        return;
                      }
                      const kbps = Math.floor(parsed * 1024);
                      settingsDirtyRef.current = true;
                      const rev = ++settingsDraftRevisionRef.current;
                      setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: kbps }));
                      void window.rd.updateSettings({ speedLimitKbps: kbps }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                      setSpeedLimitInput(formatMbpsInputFromKbps(kbps));
                    }}
                  />
                  <div className="menu-spinner-arrows">
                    <button onClick={() => {
                      const cur = (settingsDraft.speedLimitKbps || 0) / 1024;
                      const next = Math.floor((cur + 1) * 1024);
                      settingsDirtyRef.current = true;
                      const rev = ++settingsDraftRevisionRef.current;
                      setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: next }));
                      void window.rd.updateSettings({ speedLimitKbps: next }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                      setSpeedLimitInput(formatMbpsInputFromKbps(next));
                    }}>&#9650;</button>
                    <button onClick={() => {
                      const cur = (settingsDraft.speedLimitKbps || 0) / 1024;
                      const next = Math.max(0, Math.floor((cur - 1) * 1024));
                      settingsDirtyRef.current = true;
                      const rev = ++settingsDraftRevisionRef.current;
                      setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: next }));
                      void window.rd.updateSettings({ speedLimitKbps: next }).finally(() => { if (settingsDraftRevisionRef.current === rev && panelDirtyRevisionRef.current === 0) settingsDirtyRef.current = false; });
                      setSpeedLimitInput(formatMbpsInputFromKbps(next));
                    }}>&#9660;</button>
                  </div>
                </div>
                <span className="menu-speed-unit">MB/s</span>
              </div>
            </div>
          )}
        </div>
        <div className="menu-bar-item">
          <button
            className={`menu-bar-trigger${openMenu === "hilfe" ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === "hilfe" ? null : "hilfe")}
            onMouseEnter={() => { if (openMenu && openMenu !== "hilfe") { setOpenMenu("hilfe"); setOpenSubmenu(null); } }}
          >
            Hilfe
          </button>
          {openMenu === "hilfe" && (
            <div className="menu-dropdown">
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openLog().catch(() => {}); }}>
                <span>Log öffnen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openAuditLog().catch(() => {}); }}>
                <span>Audit-Log öffnen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openRenameLog().catch(() => {}); }}>
                <span>Rename-Log öffnen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openSessionLog().catch(() => {}); }}>
                <span>Session-Log öffnen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openTraceLog().catch(() => {}); }}>
                <span>Trace-Log öffnen</span>
              </button>
              <div className="menu-separator" />
              <button className="menu-dropdown-item" onClick={() => { void onExportSupportBundle(); }}>
                <span>Support-Bundle exportieren</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { void onToggleSupportTrace(); }}>
                <span>{supportTraceEnabled ? "Support-Trace deaktivieren" : "Support-Trace aktivieren"}</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { void onRunDebugSetupCheck(); }}>
                <span>Debug-Setup prüfen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { void onRotateDebugToken(); }}>
                <span>Debug-Token rotieren</span>
              </button>
              <div className="menu-separator" />
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void onCheckUpdates(); }}>
                <span>Suche Aktualisierungen</span>
              </button>
            </div>
          )}
        </div>
      </nav>

      <section className="control-strip">
        <div className="buttons buttons-left">
          <button
            className="ctrl-icon-btn ctrl-play"
            title={snapshot.session.paused ? "Fortsetzen" : "Start"}
            disabled={actionBusy || (!snapshot.canStart && !snapshot.session.paused)}
            onClick={() => {
              if (snapshot.session.paused) {
                setSnapshot((prev) => ({ ...prev, session: { ...prev.session, paused: false } }));
                void window.rd.togglePause().catch(() => {});
              } else {
                void onStartDownloads();
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><polygon points="6,3 20,12 6,21" fill="currentColor" /></svg>
          </button>
          <button
            className={`ctrl-icon-btn ctrl-pause${snapshot.session.paused ? " paused" : ""}`}
            title="Pause"
            disabled={!snapshot.canPause || snapshot.session.paused}
            onClick={() => {
              setSnapshot((prev) => ({ ...prev, session: { ...prev.session, paused: true } }));
              void window.rd.togglePause().catch(() => {});
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><rect x="5" y="3" width="4.5" height="18" rx="1" fill="currentColor" /><rect x="14.5" y="3" width="4.5" height="18" rx="1" fill="currentColor" /></svg>
          </button>
          <button
            className="ctrl-icon-btn ctrl-stop"
            title="Stop"
            disabled={actionBusy || !snapshot.canStop}
            onClick={() => { void performQuickAction(() => window.rd.stop()); }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" /></svg>
          </button>
          <div className="ctrl-separator" />
          <div className="schedule-ctrl">
            {(snapshot.settings.scheduledStartEpochMs || 0) > 0 ? (
              <div className="schedule-active">
                <span className="schedule-badge" title="Geplanter Start">â° {scheduleCountdown || new Date(snapshot.settings.scheduledStartEpochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <button className="schedule-cancel" title="Geplanten Start abbrechen" onClick={() => { void window.rd.updateSettings({ scheduledStartEpochMs: 0 }).catch(() => {}); }}>{"\u2715"}</button>
              </div>
            ) : (
              <button
                className={`ctrl-icon-btn schedule-btn${schedulePickerOpen ? " active" : ""}`}
                title="Download-Start planen"
                onClick={() => { setSchedulePickerOpen((v) => !v); setScheduleTimeInput(""); }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><polyline points="12,6 12,12 16,14"/></svg>
              </button>
            )}
            {schedulePickerOpen && (snapshot.settings.scheduledStartEpochMs || 0) === 0 && (
              <div className="schedule-picker">
                <span className="schedule-picker-label">Starten um</span>
                <input
                  type="time"
                  className="schedule-time-input"
                  value={scheduleTimeInput}
                  onChange={(e) => setScheduleTimeInput(e.target.value)}
                />
                <button className="btn btn-sm btn-primary" onClick={() => {
                  if (!scheduleTimeInput) return;
                  const [hStr, mStr] = scheduleTimeInput.split(":");
                  const now = new Date();
                  const target = new Date(now);
                  target.setHours(Number(hStr), Number(mStr), 0, 0);
                  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
                  void window.rd.updateSettings({ scheduledStartEpochMs: target.getTime() }).catch(() => {});
                  setSchedulePickerOpen(false);
                }}>Aktivieren</button>
              </div>
            )}
          </div>
          <div className="ctrl-separator" />
          <button
            className="ctrl-icon-btn ctrl-move"
            title="Ausgewählte nach oben"
            disabled={tab !== "downloads" || [...selectedIds].filter((id) => snapshot.session.packages[id]).length === 0}
            onClick={() => moveSelectedPackages("up")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 4l-7 7h4.5v9h5v-9H19z" fill="currentColor" /></svg>
          </button>
          <button
            className="ctrl-icon-btn ctrl-move"
            title="Ausgewählte nach unten"
            disabled={tab !== "downloads" || [...selectedIds].filter((id) => snapshot.session.packages[id]).length === 0}
            onClick={() => moveSelectedPackages("down")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 20l7-7h-4.5V4h-5v9H5z" fill="currentColor" /></svg>
          </button>
        </div>
        {snapshot.reconnectSeconds > 0 && tab !== "downloads" && (
          <div className="reconnect-badge" style={{ marginLeft: "auto" }}>Reconnect: {snapshot.reconnectSeconds}s</div>
        )}
      </section>

      <nav className="tabs">
        <button className={tab === "downloads" ? "tab active" : "tab"} onClick={() => setTab("downloads")}>Downloads</button>
        <button className={tab === "collector" ? "tab active" : "tab"} onClick={() => setTab("collector")}>Linksammler</button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>Einstellungen</button>
        <button className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>Verlauf</button>
        <button className={tab === "statistics" ? "tab active" : "tab"} onClick={() => setTab("statistics")}>Statistiken</button>
        <div className="tab-actions">
          {tab === "downloads" && (
            <input
              className="search-input tab-search"
              type="search"
              value={downloadSearch}
              onChange={(event) => setDownloadSearch(event.target.value)}
              placeholder="Pakete durchsuchen..."
            />
          )}
        </div>
      </nav>

      <main className="tab-content">
        {tab === "collector" && (
          <section className="grid-two">
            <article className="card wide">
              <div className="collector-header">
                <h3>Linksammler</h3>
                <div className="link-actions">
                  <button className="btn" disabled={actionBusy} onClick={onImportDlc}>DLC import</button>
                  <button className="btn" disabled={actionBusy} onClick={onExportQueue}>Queue Export</button>
                  <button className="btn" disabled={actionBusy} onClick={onImportQueue}>Datei Import</button>
                  <button className="btn accent" disabled={actionBusy} onClick={onAddLinks}>Zur Queue hinzufügen</button>
                </div>
              </div>
              <div className="collector-tabs">
                {collectorTabs.map((ct) => (
                  <div key={ct.id} className={`collector-tab${ct.id === activeCollectorTab ? " active" : ""}`}>
                    <button onClick={() => setActiveCollectorTab(ct.id)}>{ct.name}</button>
                    {collectorTabs.length > 1 && <button className="close-tab" onClick={() => removeCollectorTab(ct.id)}>x</button>}
                  </div>
                ))}
                <button className="btn add-tab" onClick={addCollectorTab}>+</button>
              </div>
              <textarea
                value={currentCollectorTab.text}
                onChange={(e) => setCollectorTabs((prev) => prev.map((t) => t.id === currentCollectorTab.id ? { ...t, text: e.target.value } : t))}
                onDragOver={(e) => e.preventDefault()}
                placeholder={"# package: Release-Name\n# file: Folge 01.rar\nhttps://...\nhttps://...\n\nLinks, .dlc oder Export-Dateien hier ablegen"}
              />
            </article>
          </section>
        )}

        {tab === "downloads" && (
          <section className="downloads-view">
            {snapshot.reconnectSeconds > 0 && (
              <div className="reconnect-banner">
                Reconnect aktiv: {snapshot.reconnectSeconds}s verbleibend
                {snapshot.session.reconnectReason && <span> ({snapshot.session.reconnectReason})</span>}
              </div>
            )}
            {/* Action buttons moved to footer */}
            <div ref={colHeaderBarRef} className="pkg-column-header" style={{ gridTemplateColumns: gridTemplate }} onContextMenu={(e) => { e.preventDefault(); setColHeaderCtx({ x: e.clientX, y: e.clientY }); }}>
              {columnOrder.map((col) => {
                const def = COLUMN_DEFS[col];
                if (!def) return null;
                const sortCol = def.sortable;
                const isActive = sortCol ? downloadsSortColumn === sortCol : false;
                return (
                  <span
                    key={col}
                    className={`pkg-col pkg-col-${col}${sortCol ? " sortable" : ""}${isActive ? " sort-active" : ""}${dragColId === col ? " pkg-col-dragging" : ""}${dropTargetCol === col ? " pkg-col-drop-target" : ""}`}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragColId(col); }}
                    onDragOver={(e) => { if (dragColId && dragColId !== col) { e.preventDefault(); setDropTargetCol(col); } }}
                    onDragLeave={() => { if (dropTargetCol === col) setDropTargetCol(null); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropTargetCol(null);
                      if (!dragColId || dragColId === col) return;
                      const newOrder = [...columnOrder];
                      const fromIdx = newOrder.indexOf(dragColId);
                      const toIdx = newOrder.indexOf(col);
                      if (fromIdx < 0 || toIdx < 0) return;
                      newOrder.splice(fromIdx, 1);
                      newOrder.splice(toIdx, 0, dragColId);
                      setColumnOrder(newOrder);
                      setDragColId(null);
                      void window.rd.updateSettings({ columnOrder: newOrder }).catch(() => {});
                    }}
                    onDragEnd={() => { setDragColId(null); setDropTargetCol(null); }}
                    onClick={sortCol ? () => {
                      const nextDesc = isActive ? !downloadsSortDescending : false;
                      setDownloadsSortColumn(sortCol);
                      setDownloadsSortDescending(nextDesc);
                      const baseOrder = packageOrderRef.current.length > 0 ? packageOrderRef.current : snapshot.session.packageOrder;
                      let sorted: string[];
                      if (sortCol === "progress") {
                        sorted = sortPackageOrderByProgress(baseOrder, snapshot.session.packages, snapshot.session.items, nextDesc);
                      } else if (sortCol === "size") {
                        sorted = sortPackageOrderBySize(baseOrder, snapshot.session.packages, snapshot.session.items, nextDesc);
                      } else if (sortCol === "hoster") {
                        sorted = sortPackageOrderByHoster(baseOrder, snapshot.session.packages, snapshot.session.items, nextDesc);
                      } else {
                        sorted = sortPackageOrderByName(baseOrder, snapshot.session.packages, nextDesc);
                      }
                      pendingPackageOrderRef.current = [...sorted];
                      pendingPackageOrderAtRef.current = Date.now();
                      packageOrderRef.current = sorted;
                      setSnapshot((prev) => {
                        if (!prev) return prev;
                        return { ...prev, session: { ...prev.session, packageOrder: [...sorted] } };
                      });
                      void window.rd.reorderPackages(sorted).catch((error) => {
                        pendingPackageOrderRef.current = null;
                        pendingPackageOrderAtRef.current = 0;
                        packageOrderRef.current = serverPackageOrderRef.current;
                        setSnapshot((prev) => {
                          if (!prev) return prev;
                          return { ...prev, session: { ...prev.session, packageOrder: serverPackageOrderRef.current } };
                        });
                        showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
                      });
                    } : undefined}
                  >
                    {def.label} {isActive ? (downloadsSortDescending ? "\u25BC" : "\u25B2") : ""}
                  </span>
                );
              })}
            </div>
            {totalPackageCount === 0 && <div className="empty">Noch keine Pakete in der Queue.</div>}
            {totalPackageCount > 0 && packages.length === 0 && <div className="empty">Keine Pakete passend zur Suche.</div>}
            {hiddenPackageCount > 0 && (
              <div className="reconnect-banner">
                Performance-Modus aktiv: {hiddenPackageCount} Paket(e) sind temporar ausgeblendet.
                <button className="btn" onClick={() => setShowAllPackages(true)}>Alle trotzdem anzeigen</button>
              </div>
            )}
            {visiblePackages.map((pkg, idx) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                items={itemsByPackage.get(pkg.id) ?? []}
                packageSpeed={packageSpeedMap.get(pkg.id) ?? 0}
                stripeVariant={idx % 2 === 0 ? "a" : "b"}
                isFirst={idx === 0}
                isLast={idx === visiblePackages.length - 1}
                isEditing={editingPackageId === pkg.id}
                editingName={editingName}
                collapsed={collapsedPackages[pkg.id] ?? false}
                hideExtractedItems={snapshot.settings.hideExtractedItems}
                sessionRunning={snapshot.session.running}
                selectedIds={selectedIds}
                columnOrder={columnOrder}
                gridTemplate={gridTemplate}
                onSelect={onSelectId}
                onSelectMouseDown={onSelectMouseDown}
                onSelectMouseEnter={onSelectMouseEnter}
                onStartEdit={onPackageStartEdit}
                onFinishEdit={onPackageFinishEdit}
                onEditChange={setEditingName}
                onToggleCollapse={onPackageToggleCollapse}
                onCancel={onPackageCancel}
                onMoveUp={onPackageMoveUp}
                onMoveDown={onPackageMoveDown}
                onToggle={onPackageToggle}
                onRemoveItem={onPackageRemoveItem}
                onContextMenu={onPackageContextMenu}
                onDragStart={onPackageDragStart}
                onDrop={onPackageDrop}
                onDragEnd={onPackageDragEnd}
              />
            ))}
          </section>
        )}

        {tab === "history" && (
          <section className="history-view">
            <div className="history-toolbar">
              <span className="history-count">
                {selectedHistoryIds.size > 0
                  ? `${selectedHistoryIds.size} von ${historyEntries.length} ausgewählt`
                  : `${historyEntries.length} Paket${historyEntries.length !== 1 ? "e" : ""} im Verlauf`}
              </span>
              {selectedHistoryIds.size > 0 && (
                <button className="btn danger" onClick={() => {
                  const idSet = new Set(selectedHistoryIds);
                  void Promise.all([...idSet].map(id => window.rd.removeHistoryEntry(id))).then(() => {
                    setHistoryEntries((prev) => prev.filter((e) => !idSet.has(e.id)));
                    setSelectedHistoryIds(new Set());
                  }).catch(() => {
                    void window.rd.getHistory().then((entries) => { setHistoryEntries(entries); setSelectedHistoryIds(new Set()); }).catch(() => {});
                  });
                }}>Ausgewählte entfernen ({selectedHistoryIds.size})</button>
              )}
              {historyEntries.length > 0 && (
                <button className="btn danger" onClick={() => { void window.rd.clearHistory().then(() => { setHistoryEntries([]); setSelectedHistoryIds(new Set()); }).catch(() => {}); }}>Verlauf leeren</button>
              )}
            </div>
            {historyEntries.length === 0 && <div className="empty">Noch keine abgeschlossenen Pakete im Verlauf.</div>}
            {historyEntries.map((entry) => {
              const collapsed = historyCollapsed[entry.id] ?? true;
              const isSelected = selectedHistoryIds.has(entry.id);
              return (
                <article
                  key={entry.id}
                  className={`package-card history-card${isSelected ? " pkg-selected" : ""}`}
                  onClick={(e) => {
                    if (e.ctrlKey) {
                      e.preventDefault();
                      setSelectedHistoryIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                        return next;
                      });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedHistoryIds((prev) => prev.has(entry.id) ? prev : new Set([entry.id]));
                    setHistoryCtxMenu({ x: e.clientX, y: e.clientY, entryId: entry.id });
                  }}
                >
                  <header onClick={(e) => { if (e.ctrlKey) return; setHistoryCollapsed((prev) => ({ ...prev, [entry.id]: !collapsed })); }} style={{ cursor: "pointer" }}>
                    <div className="pkg-columns" style={{ gridTemplateColumns: gridTemplate }}>
                      {columnOrder.map((col) => {
                        switch (col) {
                          case "name": return (
                            <div key={col} className="pkg-col pkg-col-name">
                              <button className="pkg-toggle" title={collapsed ? "Ausklappen" : "Einklappen"}>{collapsed ? "+" : "\u2212"}</button>
                              <h4>{entry.name}</h4>
                            </div>
                          );
                          case "size": return (
                            <span key={col} className="pkg-col pkg-col-size">{(() => {
                              const pct = entry.totalBytes > 0 ? Math.min(100, Math.round((entry.downloadedBytes / entry.totalBytes) * 100)) : 0;
                              const label = `${humanSize(entry.downloadedBytes)} / ${humanSize(entry.totalBytes)}`;
                              return entry.totalBytes > 0 ? (
                                <span className="progress-size">
                                  <span className="progress-size-bar" style={{ width: `${pct}%` }} />
                                  <span className="progress-size-text">{label}</span>
                                  <span className="progress-size-text-filled" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{label}</span>
                                </span>
                              ) : "";
                            })()}</span>
                          );
                          case "progress": return <span key={col} className="pkg-col pkg-col-progress">{entry.status === "completed" ? "100%" : ""}</span>;
                          case "hoster": return <span key={col} className="pkg-col pkg-col-hoster"></span>;
                          case "account": return <span key={col} className="pkg-col pkg-col-account">{entry.provider ? providerLabels[entry.provider] : ""}</span>;
                          case "prio": return <span key={col} className="pkg-col pkg-col-prio"></span>;
                          case "status": return <span key={col} className="pkg-col pkg-col-status">{entry.status === "completed" ? "Abgeschlossen" : "Gelöscht"}</span>;
                          case "speed": return <span key={col} className="pkg-col pkg-col-speed"></span>;
                          case "added": return <span key={col} className="pkg-col pkg-col-added">{formatDateTime(entry.completedAt)}</span>;
                          default: return null;
                        }
                      })}
                    </div>
                  </header>
                  <div className="progress"><div className="progress-dl" style={{ width: entry.status === "completed" ? "100%" : "0%" }} /></div>
                  {!collapsed && (
                    <div className="history-details">
                      <div className="history-detail-grid">
                        <span className="history-label">Abgeschlossen am</span>
                        <span>{new Date(entry.completedAt).toLocaleString("de-DE")}</span>
                        <span className="history-label">Dateien</span>
                        <span>{entry.fileCount} Datei{entry.fileCount !== 1 ? "en" : ""}</span>
                        <span className="history-label">Gesamtgröße</span>
                        <span>{humanSize(entry.totalBytes)}</span>
                        <span className="history-label">Heruntergeladen</span>
                        <span>{humanSize(entry.downloadedBytes)}</span>
                        <span className="history-label">Dauer</span>
                        <span>{entry.durationSeconds >= 3600 ? `${Math.floor(entry.durationSeconds / 3600)}h ${Math.floor((entry.durationSeconds % 3600) / 60)}min` : entry.durationSeconds >= 60 ? `${Math.floor(entry.durationSeconds / 60)}min ${entry.durationSeconds % 60}s` : `${entry.durationSeconds}s`}</span>
                        <span className="history-label">Durchschnitt</span>
                        <span>{entry.durationSeconds > 0 ? formatSpeedMbps(Math.round(entry.downloadedBytes / entry.durationSeconds)) : ""}</span>
                        <span className="history-label">Provider</span>
                        <span>{entry.provider ? providerLabels[entry.provider] : ""}</span>
                        <span className="history-label">Zielordner</span>
                        <span className="history-path" title={entry.outputDir}>{entry.outputDir || ""}</span>
                        <span className="history-label">Status</span>
                        <span>{entry.status === "completed" ? "Abgeschlossen" : "Gelöscht"}</span>
                      </div>
                      <div className="history-actions">
                        <button className="btn" onClick={() => { void window.rd.removeHistoryEntry(entry.id).then(() => { setHistoryEntries((prev) => prev.filter((e) => e.id !== entry.id)); setSelectedHistoryIds((prev) => { const n = new Set(prev); n.delete(entry.id); return n; }); }).catch(() => {}); }}>Eintrag entfernen</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}

        {tab === "statistics" && (
          <section className="statistics-view">
            <article className="card stats-overview">
              <h3>Session-Übersicht</h3>
              <div className="stats-actions">
                <button className="btn btn-sm" onClick={() => {
                  void window.rd.resetSessionStats().then(() => {
                    showToast("Session-Statistik zurückgesetzt", 1800);
                  }).catch((error) => {
                    showToast(`Session-Reset fehlgeschlagen: ${String(error)}`, 2400);
                  });
                }}>Session zurücksetzen</button>
                <button className="btn btn-sm" onClick={() => {
                  void window.rd.resetDownloadStats().then(() => {
                    showToast("Gesamt-Downloadstatistik zurückgesetzt", 1800);
                  }).catch((error) => {
                    showToast(`Download-Reset fehlgeschlagen: ${String(error)}`, 2400);
                  });
                }}>Heruntergeladen zurücksetzen</button>
              </div>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Aktuelle Geschwindigkeit</span>
                  <span className="stat-value">{snapshot.speedText.replace("Geschwindigkeit: ", "")}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Heruntergeladen (Session)</span>
                  <span className="stat-value">{humanSize(snapshot.stats.totalDownloaded)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Heruntergeladen (Gesamt)</span>
                  <span className="stat-value">{humanSize(snapshot.stats.totalDownloadedAllTime)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fertige Dateien (Gesamt)</span>
                  <span className="stat-value">{snapshot.stats.totalFilesAllTime}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fertige Dateien (Session)</span>
                  <span className="stat-value">{snapshot.stats.totalFilesSession}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Pakete</span>
                  <span className="stat-value">{snapshot.stats.totalPackages}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Aktive Downloads</span>
                  <span className="stat-value">{itemStatusCounts.downloading}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">In Warteschlange</span>
                  <span className="stat-value">{itemStatusCounts.queued}</span>
                </div>
                <div
                  className={`stat-item${itemStatusCounts.failed > 0 ? " stat-item-clickable" : ""}`}
                  title={itemStatusCounts.failed > 0 ? "Klicken zum Zurücksetzen aller fehlerhaften Downloads" : undefined}
                  onClick={() => {
                    if (itemStatusCounts.failed === 0) return;
                    const failedIds = Object.values(snapshot.session.items)
                      .filter((it) => it.status === "failed")
                      .map((it) => it.id);
                    void window.rd.resetItems(failedIds).catch(() => {});
                  }}
                >
                  <span className="stat-label">Fehlerhaft</span>
                  <span className="stat-value danger">{itemStatusCounts.failed}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{snapshot.etaText.includes(": ") ? snapshot.etaText.slice(0, snapshot.etaText.indexOf(": ")) : snapshot.etaText}</span>
                  <span className="stat-value">{snapshot.etaText.includes(": ") ? snapshot.etaText.slice(snapshot.etaText.indexOf(": ") + 2) : "--"}</span>
                </div>
              </div>
            </article>

            <article className="card stats-chart-card">
              <h3>Bandbreitenverlauf</h3>
              <BandwidthChart items={snapshot.session.items} running={snapshot.session.running} paused={snapshot.session.paused} speedHistoryRef={speedHistoryRef} />
            </article>

            <article className="card stats-provider-card">
              <h3>Hoster-Statistik</h3>
              <div className="provider-stats">
                {providerStats.map(([provider, stats]) => (
                  <div key={provider} className="provider-stat-item">
                    <span className="provider-name">{provider === "unknown" ? "Unbekannt" : provider}</span>
                    <div className="provider-bars">
                      <div className="provider-bar">
                        <div className="bar-fill completed" style={{ width: `${stats.total > 0 ? (stats.completed / stats.total) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <span className="provider-detail">
                      {stats.completed}/{stats.total} fertig | {humanSize(stats.bytes)}
                      {stats.failed > 0 && <span className="danger"> | {stats.failed} Fehler</span>}
                    </span>
                  </div>
                ))}
                {Object.keys(snapshot.session.items).length === 0 && (
                  <div className="empty-provider">Noch keine Downloads vorhanden.</div>
                )}
              </div>
            </article>
          </section>
        )}

        {tab === "settings" && (
          <section className="settings-shell">
            <article className="card settings-toolbar">
              <div className="settings-toolbar-copy">
                <h3>Einstellungen</h3>
                <span>Kompakt, schnell auffindbar und direkt speicherbar.</span>
              </div>
              <div className="settings-toolbar-actions-wrap">
                <div className="settings-toolbar-actions">
                  <button className="btn accent" disabled={actionBusy} onClick={onSaveSettings}>Einstellungen speichern</button>
                </div>
              </div>
            </article>

            <div className="settings-body">
              <nav className="settings-sidebar">
                {settingsSubTabs.map((st) => (
                  <button key={st.key} className={`settings-sidebar-tab${settingsSubTab === st.key ? " active" : ""}`} onClick={() => setSettingsSubTab(st.key)}>{st.label}</button>
                ))}
              </nav>
              <div className="settings-content" key={settingsSubTab}>
                {settingsSubTab === "allgemein" && (
                  <div className="settings-section card">
                    <h3>Allgemein</h3>
                    <label>Download-Ordner</label>
                    <div className="input-row">
                      <input value={settingsDraft.outputDir} onChange={(e) => setText("outputDir", e.target.value)} />
                      <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("outputDir", s); } }); }}>Wählen</button>
                    </div>
                    <label>Paketname (optional)</label>
                    <input value={settingsDraft.packageName} onChange={(e) => setText("packageName", e.target.value)} />
                    <div className="field-grid two">
                      <div><label>Max. Downloads</label><input type="number" min={1} max={50} value={settingsDraft.maxParallel} onChange={(e) => setNum("maxParallel", Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></div>
                      <div><label>Auto-Retry Limit (0 = inf)</label><input type="number" min={0} max={99} value={settingsDraft.retryLimit} onChange={(e) => setNum("retryLimit", Math.max(0, Math.min(99, Number(e.target.value) || 0)))} /></div>
                    </div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoResumeOnStart} onChange={(e) => setBool("autoResumeOnStart", e.target.checked)} /> Auto-Resume beim Start</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.collapseNewPackages} onChange={(e) => setBool("collapseNewPackages", e.target.checked)} /> Neue Pakete eingeklappt</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoSortPackagesByProgress} onChange={(e) => setBool("autoSortPackagesByProgress", e.target.checked)} /> Automatisches Sortieren laufender Pakete nach Fortschritt</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.clipboardWatch} onChange={(e) => setBool("clipboardWatch", e.target.checked)} /> Zwischenablage überwachen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.minimizeToTray} onChange={(e) => setBool("minimizeToTray", e.target.checked)} /> In System Tray minimieren</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.confirmDeleteSelection} onChange={(e) => setBool("confirmDeleteSelection", e.target.checked)} /> Vor dem Löschen bestätigen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.theme === "light"} onChange={(e) => {
                      const next = e.target.checked ? "light" : "dark";
                      settingsDraftRevisionRef.current += 1;
                      panelDirtyRevisionRef.current += 1;
                      settingsDirtyRef.current = true;
                      setSettingsDirty(true);
                      setSettingsDraft((prev) => ({ ...prev, theme: next as AppTheme }));
                      applyTheme(next as AppTheme);
                    }} /> Light Mode</label>
                  </div>
                )}
                {settingsSubTab === "accounts" && (
                  <div className="account-settings-layout">
                    <div className="settings-section card account-board">
                      <div className="account-board-header">
                        <div>
                          <h3>Accounts</h3>
                          <div className="hint">Accounts werden als Liste verwaltet. Neue Einträge kommen über den Dialog oben rechts dazu.</div>
                        </div>
                        <button className="btn accent" disabled={actionBusy || availableAccountOptions.length === 0} onClick={openCreateAccountDialog}>
                          Account hinzufügen
                        </button>
                      </div>

                      <div className="account-board-summary">
                        <span className="account-inline-stat">{configuredAccounts.length} aktiv</span>
                        <span className="account-inline-stat">{availableAccountOptions.length} weitere Typen verfügbar</span>
                      </div>

                      <label className="toggle-line account-display-toggle">
                        <input
                          type="checkbox"
                          checked={settingsDraft.accountListShowDetailedDebridLinkKeys}
                          onChange={(e) => setBool("accountListShowDetailedDebridLinkKeys", e.target.checked)}
                        />
                        Debrid-Link-Keys im Feld "Zugang" einzeln untereinander anzeigen
                      </label>
                      <div className="account-display-actions">
                        <button className="btn btn-sm" disabled={actionBusy} onClick={resetAccountColumnWidths}>
                          Spalten zurücksetzen
                        </button>
                      </div>

                      {configuredAccounts.length === 0 && (
                        <div className="account-empty-state">
                          <strong>Noch keine Accounts hinterlegt</strong>
                          <span>Füge über "Account hinzufügen" den ersten Dienst hinzu. Danach erscheinen hier Status, Zugang und Aktionen als Liste.</span>
                        </div>
                      )}

                      {configuredAccounts.length > 0 && (
                        <div className="account-table" style={accountTableStyle}>
                          <div className="account-table-head">
                            <div className="account-header-cell">
                              <span>Account</span>
                              <button
                                className="account-resize-handle"
                                title="Spalte ziehen"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  startAccountColumnResize("service", event.clientX);
                                }}
                              />
                            </div>
                            <div className="account-header-cell">
                              <span>Typ</span>
                              <button
                                className="account-resize-handle"
                                title="Spalte ziehen"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  startAccountColumnResize("mode", event.clientX);
                                }}
                              />
                            </div>
                            <div className="account-header-cell">
                              <span>Status</span>
                              <button
                                className="account-resize-handle"
                                title="Spalte ziehen"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  startAccountColumnResize("status", event.clientX);
                                }}
                              />
                            </div>
                            <div className="account-header-cell">
                              <span>Info</span>
                            </div>
                            <div className="account-header-cell">
                              <span>Zugang</span>
                              <button
                                className="account-resize-handle"
                                title="Spalte ziehen"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  startAccountColumnResize("secret", event.clientX);
                                }}
                              />
                            </div>
                            <div className="account-header-cell">
                              <span>Aktionen</span>
                            </div>
                          </div>
                          {configuredAccounts.map((entry) => {
                            const option = findAccountOption(entry.kind);
                            const quickAction = getAccountQuickActionMeta(entry.kind);
                            const showStatusButton = entry.service === "alldebrid";
                            const showQuickActionButton = Boolean(quickAction && !(showStatusButton && quickAction.action === "alldebrid-status"));
                            const allDebridStateClass = entry.service === "alldebrid" && allDebridHostInfo ? ` account-status-${allDebridHostInfo.state}` : "";
                            return (
                              <div key={entry.service} className={`account-row${entry.disabled ? " account-row-disabled" : ""}`}>
                                <div className="account-cell account-service-cell">
                                  <strong>{entry.serviceLabel}</strong>
                                  <span>{option.title}</span>
                                </div>
                                <div className="account-cell">
                                  <span className="account-mode-pill">{entry.modeLabel}</span>
                                </div>
                                <div className="account-cell account-status-cell">
                                  <span className={`account-status-pill${entry.disabled ? " account-status-disabled" : ""}${allDebridStateClass}`}>{entry.statusLabel}</span>
                                  {entry.note && <span className="account-note">{entry.note}</span>}
                                </div>
                                <div className="account-cell account-info-cell">
                                  {entry.debridLinkKeys.length > 0 ? (
                                    <div className="account-usage-stack">
                                      <button className="btn btn-sm" onClick={() => setKeyStatsPopup(entry.service)}>
                                        Statistik
                                      </button>
                                      <span className="account-usage-total">Insgesamt: {humanSize(entry.totalUsedBytes)}</span>
                                    </div>
                                  ) : (
                                    <div className="account-usage-stack">
                                      <div className={`account-usage-stats${entry.dailyLimitReached ? " warning" : ""}`}>
                                        <span>Heute: {humanSize(entry.dailyUsedBytes)}</span>
                                        <span>{entry.dailyLimitBytes > 0 ? `Limit: ${humanSize(entry.dailyLimitBytes)}` : "Kein Tageslimit"}</span>
                                        {entry.dailyLimitBytes > 0 && (
                                          <span>{entry.dailyLimitReached ? "Fallback aktiv" : `Rest: ${humanSize(entry.dailyRemainingBytes || 0)}`}</span>
                                        )}
                                      </div>
                                      <span className="account-usage-total">Insgesamt: {humanSize(entry.totalUsedBytes)}</span>
                                    </div>
                                  )}
                                </div>
                                <div className="account-cell">
                                  {entry.summaryLines.length > 1 ? (
                                    <div className="account-secret account-secret-multiline">
                                      {entry.summaryLines.map((line) => (
                                        <span key={line}>{line}</span>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="account-secret">{entry.summary}</span>
                                  )}
                                </div>
                                <div className="account-cell account-row-actions">
                                  {showStatusButton && (
                                    <button className="btn" disabled={actionBusy || allDebridHostLoading || !hasSavedAllDebridAccount} onClick={() => { void performQuickAction(async () => { await runAccountQuickAction("alldebrid-status"); }, (error) => { showToast(`AllDebrid Status fehlgeschlagen: ${String(error)}`, 3200); }); }}>
                                      Status
                                    </button>
                                  )}
                                  {showQuickActionButton && quickAction && (
                                    <button className="btn" disabled={actionBusy} onClick={() => { void onAccountRowQuickAction(entry); }}>
                                      {quickAction.label}
                                    </button>
                                  )}
                                  <button className="btn" disabled={actionBusy} onClick={() => { void onToggleAccountEnabled(entry); }}>
                                    {entry.disabled ? "Aktivieren" : "Deaktivieren"}
                                  </button>
                                  <button className="btn" disabled={actionBusy || entry.dailyUsedBytes <= 0} onClick={() => { void onResetAccountDailyUsage(entry); }}>
                                    Reset Heute
                                  </button>
                                  <button className="btn" disabled={actionBusy} onClick={() => openEditAccountDialog(entry.kind)}>
                                    Bearbeiten
                                  </button>
                                  <button className="btn danger" disabled={actionBusy} onClick={() => { void onRemoveAccount(entry); }}>
                                    Entfernen
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="settings-section card">
                      <h3>Hoster-Reihenfolge</h3>
                      <div className="hint">
                        Lege fest, in welcher Reihenfolge die Debrid-Accounts für Links genutzt werden.
                        Der erste Eintrag ist der Hauptaccount. Direkt-Hoster (1Fichier, DDownload) laufen separat und erscheinen nicht hier.
                      </div>
                      {activeProviderOrder.length === 0 && (
                        <div className="account-empty-state compact">
                          <strong>Keine Debrid-Reihenfolge verfügbar</strong>
                          <span>Füge mindestens einen Debrid-Account hinzu, dann kannst Du die Reihenfolge festlegen.</span>
                        </div>
                      )}
                      {activeProviderOrder.length > 0 && (
                        <div className="provider-order-list">
                          {activeProviderOrder.map((provider, idx) => (
                            <div
                              key={provider}
                              className={`provider-order-row${draggedProvider === provider ? " dragging" : ""}${providerDropTarget === provider && draggedProvider !== provider ? " drag-target" : ""}`}
                              draggable
                              onDragStart={(event) => onProviderDragStart(event, provider)}
                              onDragOver={(event) => onProviderDragOver(event, provider)}
                              onDrop={(event) => onProviderDrop(event, provider)}
                              onDragEnd={onProviderDragEnd}
                            >
                              <span className="provider-order-num">{idx + 1}.</span>
                              <span className="provider-order-label">{providerLabelWithMode(provider, settingsDraft)}</span>
                              <div className="provider-order-actions">
                                <button
                                  className="btn btn-sm"
                                  disabled={idx === 0}
                                  onClick={() => {
                                    const next = [...activeProviderOrder];
                                    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                    setProviderOrder(next);
                                  }}
                                  title="Nach oben"
                                >{"\u25B2"}</button>
                                <button
                                  className="btn btn-sm"
                                  disabled={idx === activeProviderOrder.length - 1}
                                  onClick={() => {
                                    const next = [...activeProviderOrder];
                                    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                                    setProviderOrder(next);
                                  }}
                                  title="Nach unten"
                                >{"\u25BC"}</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoProviderFallback} onChange={(e) => setBool("autoProviderFallback", e.target.checked)} /> Bei Fehlern oder Fair-Use automatisch zum nächsten Provider wechseln</label>
                      <label className="toggle-line"><input type="checkbox" checked={settingsDraft.rememberToken} onChange={(e) => setBool("rememberToken", e.target.checked)} /> Zugangsdaten lokal speichern</label>
                    </div>

                    {configuredProviders.length >= 1 && (
                    <div className="settings-section card">
                      <h3>Hoster-Zuordnung</h3>
                      <div className="hint">Lege fest, welcher Debrid-Provider sich um welchen Filehoster kümmert. Nicht zugeordnete Hoster nutzen die Standard-Reihenfolge oben.</div>
                      {(() => {
                        const routing: Record<string, DebridProvider> = settingsDraft.hosterRouting || {};
                        const routingEntries = Object.entries(routing).sort(([a], [b]) => a.localeCompare(b));
                        const usedHosters = new Set(routingEntries.map(([h]) => h));
                        const availableHosters = KNOWN_HOSTERS.filter((h) => !usedHosters.has(h.id));

                        const setRouting = (newRouting: Record<string, DebridProvider>) => {
                          settingsDraftRevisionRef.current += 1;
                          panelDirtyRevisionRef.current += 1;
                          settingsDirtyRef.current = true;
                          setSettingsDirty(true);
                          setSettingsDraft((prev) => ({ ...prev, hosterRouting: newRouting }));
                        };

                        const addEntry = (hosterId: string) => {
                          if (!hosterId || routing[hosterId]) return;
                          setRouting({ ...routing, [hosterId]: configuredProviders[0] });
                        };

                        const removeEntry = (hosterId: string) => {
                          const copy = { ...routing };
                          delete copy[hosterId];
                          setRouting(copy);
                        };

                        const changeProvider = (hosterId: string, provider: DebridProvider) => {
                          setRouting({ ...routing, [hosterId]: provider });
                        };

                        return (
                          <>
                            {routingEntries.length > 0 && (
                              <div className="hoster-routing-table">
                                <div className="hoster-routing-header">
                                  <span>Filehoster</span>
                                  <span>Zuständiger Provider</span>
                                  <span></span>
                                </div>
                                {routingEntries.map(([hosterId, provider]) => {
                                  const hosterLabel = KNOWN_HOSTERS.find((h) => h.id === hosterId)?.label || hosterId;
                                  return (
                                    <div key={hosterId} className="hoster-routing-row">
                                      <span className="hoster-routing-label">{hosterLabel}</span>
                                      <select value={provider} onChange={(e) => changeProvider(hosterId, e.target.value as DebridProvider)}>
                                        {configuredProviders.map((p) => (
                                          <option key={p} value={p}>{providerLabelWithMode(p, settingsDraft)}</option>
                                        ))}
                                      </select>
                                      <button className="btn btn-sm btn-danger" onClick={() => removeEntry(hosterId)} title="Zuordnung entfernen">&times;</button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {routingEntries.length === 0 && (
                              <div className="hint" style={{ fontStyle: "italic", opacity: 0.7 }}>Noch keine Zuordnungen. Alle Hoster nutzen die Standard-Reihenfolge.</div>
                            )}
                            <div className="hoster-routing-add">
                              <select
                                value=""
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === "__custom") {
                                    const name = window.prompt("Hoster-Domain eingeben (z.B. rapidgator, turbobit):");
                                    const clean = (name || "").trim().toLowerCase().replace(/^www\./, "").split(".")[0];
                                    if (clean) addEntry(clean);
                                  } else {
                                    addEntry(val);
                                  }
                                  e.target.value = "";
                                }}
                              >
                                <option value="" disabled>Hoster hinzufügen...</option>
                                {availableHosters.map((h) => (
                                  <option key={h.id} value={h.id}>{h.label}</option>
                                ))}
                                <option value="" disabled>â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€</option>
                                <option value="__custom">Eigener Hoster...</option>
                              </select>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                    )}

                    <div hidden>
                  <div className="settings-section card">
                    <h3>Accounts</h3>
                    <label>Real-Debrid API Token</label>
                    <input type="password" value={settingsDraft.token} onChange={(e) => setText("token", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.realDebridUseWebLogin} onChange={(e) => setBool("realDebridUseWebLogin", e.target.checked)} /> Real-Debrid per Web-Login statt API-Token verwenden</label>
                    {settingsDraft.realDebridUseWebLogin && (
                      <>
                        <div className="hint">Beim ersten Link oder über den Button unten öffnet sich ein Real-Debrid-Browserfenster. Der Login läuft dort manuell über die Website.</div>
                        <button className="btn" disabled={actionBusy} onClick={() => { void onOpenRealDebridLogin(); }}>Real-Debrid Web-Login öffnen</button>
                      </>
                    )}
                    <label>Mega-Debrid Login</label>
                    <input value={settingsDraft.megaLogin} onChange={(e) => setText("megaLogin", e.target.value)} />
                    <label>Mega-Debrid Passwort</label>
                    <input type="password" value={settingsDraft.megaPassword} onChange={(e) => setText("megaPassword", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.megaDebridPreferApi} onChange={(e) => setBool("megaDebridPreferApi", e.target.checked)} /> Mega-Debrid bevorzugt über API (schneller, Fallback auf Web)</label>
                    <label>BestDebrid API Token</label>
                    <input type="password" value={settingsDraft.bestToken} onChange={(e) => setText("bestToken", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.bestDebridUseWebLogin} onChange={(e) => setBool("bestDebridUseWebLogin", e.target.checked)} /> BestDebrid per Cookie-Import statt API-Token verwenden</label>
                    {settingsDraft.bestDebridUseWebLogin && (
                      <>
                        <div className="hint">Exportiere deine BestDebrid-Cookies als Netscape-Textdatei (z.B. mit der Browser-Extension &quot;Get cookies.txt LOCALLY&quot;) und importiere sie hier.</div>
                        <button className="btn" disabled={actionBusy} onClick={() => { void onImportBestDebridCookies(); }}>BestDebrid Cookies importieren</button>
                      </>
                    )}
                    <label>AllDebrid API Key</label>
                    <input type="password" value={settingsDraft.allDebridToken} onChange={(e) => setText("allDebridToken", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.allDebridUseWebLogin} onChange={(e) => setBool("allDebridUseWebLogin", e.target.checked)} /> AllDebrid per Web-Login statt API-Key verwenden</label>
                    {settingsDraft.allDebridUseWebLogin && (
                      <>
                        <div className="hint">Beim ersten Link oder über den Button unten öffnet sich ein echtes AllDebrid-Browserfenster. Der Login läuft dort manuell, damit reCAPTCHA sauber funktioniert.</div>
                        <button className="btn" disabled={actionBusy} onClick={() => { void onOpenAllDebridLogin(); }}>AllDebrid Web-Login öffnen</button>
                      </>
                    )}
                    <div style={{ marginTop: 12, padding: 14, borderRadius: 14, border: "1px solid rgba(83, 168, 255, 0.22)", background: "rgba(10, 20, 35, 0.32)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <strong>AllDebrid Rapidgator Status</strong>
                        <button className="btn" disabled={allDebridHostLoading || !hasSavedAllDebridAccount} onClick={() => { void loadAllDebridHostInfo(false); }}>
                          {allDebridHostLoading ? "Lade..." : "Status aktualisieren"}
                        </button>
                      </div>
                      {!hasSavedAllDebridAccount && (
                        <div className="hint" style={{ marginTop: 10 }}>Nach dem Speichern eines AllDebrid-Accounts wird hier der Rapidgator-Status angezeigt.</div>
                      )}
                      {hasSavedAllDebridAccount && !allDebridHostInfo && !allDebridHostLoading && (
                        <div className="hint" style={{ marginTop: 10 }}>Noch keine Host-Information geladen.</div>
                      )}
                      {hasSavedAllDebridAccount && allDebridHostLoading && !allDebridHostInfo && (
                        <div className="hint" style={{ marginTop: 10 }}>Rapidgator-Status wird geladen...</div>
                      )}
                      {allDebridHostInfo && (
                        <>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
                            <div>
                              <div className="hint" style={{ margin: 0 }}>Status</div>
                              <div>{allDebridHostInfo.statusLabel}</div>
                            </div>
                            <div>
                              <div className="hint" style={{ margin: 0 }}>Quelle</div>
                              <div>{formatAllDebridSourceLabel(allDebridHostInfo.source)}</div>
                            </div>
                            <div>
                              <div className="hint" style={{ margin: 0 }}>Letztes Update</div>
                              <div>{formatAllDebridTimestamp(allDebridHostInfo)}</div>
                            </div>
                            <div>
                              <div className="hint" style={{ margin: 0 }}>Quota</div>
                              <div>{formatAllDebridQuota(allDebridHostInfo)}</div>
                            </div>
                            <div>
                              <div className="hint" style={{ margin: 0 }}>Simultan-Downloads</div>
                              <div>{formatAllDebridSimuLimit(allDebridHostInfo)}</div>
                            </div>
                          </div>
                          {allDebridHostInfo.note && (
                            <div className="hint" style={{ marginTop: 10 }}>{allDebridHostInfo.note}</div>
                          )}
                        </>
                      )}
                      {allDebridSettingsDirty && hasSavedAllDebridAccount && (
                        <div className="hint" style={{ marginTop: 10 }}>Status basiert auf den zuletzt gespeicherten AllDebrid-Einstellungen.</div>
                      )}
                    </div>
                    <label>DDownload Login</label>
                    <input value={settingsDraft.ddownloadLogin || ""} onChange={(e) => setText("ddownloadLogin", e.target.value)} />
                    <label>DDownload Passwort</label>
                    <input type="password" value={settingsDraft.ddownloadPassword || ""} onChange={(e) => setText("ddownloadPassword", e.target.value)} />
                    <label>1Fichier API Key</label>
                    <input type="password" value={settingsDraft.oneFichierApiKey || ""} onChange={(e) => setText("oneFichierApiKey", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.rememberToken} onChange={(e) => setBool("rememberToken", e.target.checked)} /> Zugangsdaten lokal speichern</label>
                  </div>
                    </div>
                  </div>
                )}
                {settingsSubTab === "entpacken" && (
                  <div className="settings-section card">
                    <h3>Entpacken</h3>
                    <label>Entpacken nach</label>
                    <div className="input-row">
                      <input value={settingsDraft.extractDir} onChange={(e) => setText("extractDir", e.target.value)} />
                      <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("extractDir", s); } }); }}>Wählen</button>
                    </div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoExtract} onChange={(e) => setBool("autoExtract", e.target.checked)} /> Auto-Extract</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoSkipExtracted} onChange={(e) => setBool("autoSkipExtracted", e.target.checked)} /> Bereits Entpacktes beim Start überspringen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.hideExtractedItems} onChange={(e) => setBool("hideExtractedItems", e.target.checked)} /> Entpackte Items in Paketliste ausblenden</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoRename4sf4sj} onChange={(e) => setBool("autoRename4sf4sj", e.target.checked)} /> Auto-Rename (Beta)</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.createExtractSubfolder} onChange={(e) => setBool("createExtractSubfolder", e.target.checked)} /> Entpackte Dateien in Paket-Unterordner speichern</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.hybridExtract} onChange={(e) => setBool("hybridExtract", e.target.checked)} /> Hybrid-Extract</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoExtractWhenStopped} onChange={(e) => setBool("autoExtractWhenStopped", e.target.checked)} /> Entpacken auch ohne laufende Session (bei Stopp / Programmstart)</label>
                    <div><label>Parallele Entpackungen</label><input type="number" min={1} max={8} value={settingsDraft.maxParallelExtract} onChange={(e) => setNum("maxParallelExtract", Math.max(1, Math.min(8, Number(e.target.value) || 2)))} /></div>
                    <div><label>Extraktions-Priorität</label><select value={settingsDraft.extractCpuPriority} onChange={(e) => setText("extractCpuPriority", e.target.value)}>
                      <option value="high">Hoch (80% CPU)</option>
                      <option value="middle">Mittel (50% CPU)</option>
                      <option value="low">Niedrig (25% CPU)</option>
                    </select></div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.collectMkvToLibrary} onChange={(e) => setBool("collectMkvToLibrary", e.target.checked)} /> MKV nach Paketabschluss in Sammelordner verschieben (flach)</label>
                    <label>MKV-Sammelordner</label>
                    <div className="input-row">
                      <input value={settingsDraft.mkvLibraryDir} onChange={(e) => setText("mkvLibraryDir", e.target.value)} disabled={!settingsDraft.collectMkvToLibrary} />
                      <button className="btn" disabled={!settingsDraft.collectMkvToLibrary} onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("mkvLibraryDir", s); } }); }}>Wählen</button>
                    </div>
                    <label>Passwortliste (eine Zeile pro Passwort)</label>
                    <textarea className="password-list" value={settingsDraft.archivePasswordList} onChange={(e) => setText("archivePasswordList", e.target.value)} placeholder={"serienfans.org\nserienjunkies.org\nmein-passwort"} />
                  </div>
                )}
                {settingsSubTab === "geschwindigkeit" && (
                  <div className="settings-section card">
                    <h3>Geschwindigkeit</h3>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.speedLimitEnabled} onChange={(e) => setBool("speedLimitEnabled", e.target.checked)} /> Speed-Limit aktivieren</label>
                    <div className="field-grid two">
                      <div>
                        <label>Limit (MB/s)</label>
                        <input type="number" min={0} step={0.1} value={speedLimitInput} onChange={(event) => setSpeedLimitInput(event.target.value)} onBlur={(event) => { const parsed = parseMbpsInput(event.target.value); if (parsed === null) { setSpeedLimitInput(formatMbpsInputFromKbps(settingsDraft.speedLimitKbps)); return; } setSpeedLimitMbps(parsed); setSpeedLimitInput(formatMbpsInputFromKbps(Math.floor(parsed * 1024))); }} disabled={!settingsDraft.speedLimitEnabled} />
                      </div>
                      <div>
                        <label>Limit-Modus</label>
                        <select value={settingsDraft.speedLimitMode} onChange={(e) => setText("speedLimitMode", e.target.value)} disabled={!settingsDraft.speedLimitEnabled}>
                          <option value="global">Global</option>
                          <option value="per_download">Pro Download</option>
                        </select>
                      </div>
                    </div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoReconnect} onChange={(e) => setBool("autoReconnect", e.target.checked)} /> Automatischer Reconnect</label>
                    <div><label>Reconnect-Wartezeit (Sek.)</label><input type="number" min={10} max={600} value={settingsDraft.reconnectWaitSeconds} onChange={(e) => setNum("reconnectWaitSeconds", Math.max(10, Math.min(600, Number(e.target.value) || 45)))} /></div>
                    <h4>Bandbreitenplanung</h4>
                    {schedules.map((s, i) => {
                      const scheduleKey = s.id || `schedule-${i}`;
                      const speedInput = scheduleSpeedInputs[scheduleKey] ?? formatMbpsInputFromKbps(s.speedLimitKbps);
                      return (
                        <div key={scheduleKey} className="schedule-row">
                          <input type="number" min={0} max={23} value={s.startHour} onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) updateSchedule(i, "startHour", Math.max(0, Math.min(23, v))); }} title="Von (Stunde)" />
                          <span>-</span>
                          <input type="number" min={0} max={23} value={s.endHour} onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) updateSchedule(i, "endHour", Math.max(0, Math.min(23, v))); }} title="Bis (Stunde)" />
                          <span>Uhr</span>
                          <input type="number" min={0} step={0.1} value={speedInput} onChange={(event) => { setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: event.target.value })); }} onBlur={(event) => { const parsed = parseMbpsInput(event.target.value); if (parsed === null) { setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: formatMbpsInputFromKbps(s.speedLimitKbps) })); return; } const nextKbps = Math.floor(parsed * 1024); setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: formatMbpsInputFromKbps(nextKbps) })); updateSchedule(i, "speedLimitKbps", nextKbps); }} title="MB/s (0=unbegrenzt)" />
                          <span>MB/s</span>
                          <input type="checkbox" checked={s.enabled} onChange={(e) => updateSchedule(i, "enabled", e.target.checked)} />
                          <button className="btn danger" onClick={() => removeSchedule(i)}>X</button>
                        </div>
                      );
                    })}
                    <button className="btn" onClick={addSchedule}>Zeitregel hinzufügen</button>
                  </div>
                )}
                {settingsSubTab === "bereinigung" && (
                  <div className="settings-section card">
                    <h3>Bereinigung</h3>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.enableIntegrityCheck} onChange={(e) => setBool("enableIntegrityCheck", e.target.checked)} /> SFV/CRC/MD5/SHA1 prüfen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.removeLinkFilesAfterExtract} onChange={(e) => setBool("removeLinkFilesAfterExtract", e.target.checked)} /> Link-Dateien nach Entpacken entfernen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.removeSamplesAfterExtract} onChange={(e) => setBool("removeSamplesAfterExtract", e.target.checked)} /> Samples nach Entpacken entfernen</label>
                    <label>Fertiggestellte Downloads entfernen</label>
                    <select value={settingsDraft.completedCleanupPolicy} onChange={(e) => setText("completedCleanupPolicy", e.target.value)}>
                      {Object.entries(cleanupLabels).map(([key, label]) => (<option key={key} value={key}>{label}</option>))}
                    </select>
                    <div className="field-grid two">
                      <div><label>Cleanup nach Entpacken</label><select value={settingsDraft.cleanupMode} onChange={(e) => setText("cleanupMode", e.target.value)}>
                        <option value="none">keine Archive löschen</option>
                        <option value="trash">Archive in Papierkorb</option>
                        <option value="delete">Archive löschen</option>
                      </select></div>
                      <div><label>Konfliktmodus</label><select value={settingsDraft.extractConflictMode} onChange={(e) => setText("extractConflictMode", e.target.value)}>
                        <option value="overwrite">überschreiben</option>
                        <option value="skip">überspringen</option>
                        <option value="rename">umbenennen</option>
                        <option value="ask">nachfragen</option>
                      </select></div>
                    </div>
                  </div>
                )}
                {settingsSubTab === "updates" && (
                  <div className="settings-section card">
                    <h3>Updates</h3>
                    <label>Codeberg Repo</label>
                    <input value={settingsDraft.updateRepo} onChange={(e) => setText("updateRepo", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoUpdateCheck} onChange={(e) => setBool("autoUpdateCheck", e.target.checked)} /> Beim Start auf Updates prüfen</label>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {confirmPrompt && (
        <div className="modal-backdrop" onClick={() => closeConfirmPrompt(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>{confirmPrompt.title}</h3>
            <p style={{ whiteSpace: "pre-line" }}>{confirmPrompt.message}</p>
            {confirmPrompt.details && (
              <details className="modal-details">
                <summary>{confirmPrompt.detailsLabel || "Details anzeigen"}</summary>
                <pre>{confirmPrompt.details}</pre>
              </details>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => closeConfirmPrompt(false)}>{confirmPrompt.cancelLabel || "Abbrechen"}</button>
              <button
                className={confirmPrompt.danger ? "btn danger" : "btn"}
                onClick={() => closeConfirmPrompt(true)}
              >
                {confirmPrompt.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (() => {
        const itemCount = [...deleteConfirm.ids].filter((id) => snapshot.session.items[id]).length;
        const pkgCount = [...deleteConfirm.ids].filter((id) => snapshot.session.packages[id]).length;
        const removedItemIds = new Set<string>();
        for (const id of deleteConfirm.ids) {
          if (snapshot.session.items[id]) removedItemIds.add(id);
          const pkg = snapshot.session.packages[id];
          if (pkg) { for (const iid of pkg.itemIds) removedItemIds.add(iid); }
        }
        const totalRemaining = Math.max(0, Object.keys(snapshot.session.items).length - removedItemIds.size);
        const parts: string[] = [];
        if (pkgCount > 0) parts.push(`${pkgCount} Paket(e)`);
        if (itemCount > 0) parts.push(`${itemCount} Link(s)`);
        return (
          <div className="modal-backdrop" onClick={() => setDeleteConfirm(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <h3>Bist Du Dir sicher?</h3>
              <p>Möchtest Du wirklich diese Aufräumaktion(en) durchführen?<br />Ausgewählte Links löschen</p>
              <p><strong>Zu erledigende Aufgaben:</strong><br />{parts.join(" + ")} löschen ? {totalRemaining} Link(s) verbleiben!</p>
              <label className="toggle-line">
                <input type="checkbox" checked={deleteConfirm.dontAsk} onChange={(e) => setDeleteConfirm((prev) => prev ? { ...prev, dontAsk: e.target.checked } : prev)} />
                Nicht mehr anzeigen
              </label>
              <div className="modal-actions">
                <button className="btn" onClick={() => setDeleteConfirm(null)}>Abbrechen</button>
                <button className="btn danger" onClick={() => {
                  if (deleteConfirm.dontAsk) {
                    setSettingsDraft((prev) => ({ ...prev, confirmDeleteSelection: false }));
                    void window.rd.updateSettings({ confirmDeleteSelection: false }).catch(() => {});
                  }
                  executeDeleteSelection(deleteConfirm.ids);
                  setDeleteConfirm(null);
                }}>Fortfahren</button>
              </div>
            </div>
          </div>
        );
      })()}

      {startConflictPrompt && (
        <div className="modal-backdrop" onClick={() => closeStartConflictPrompt(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Paket bereits entpackt</h3>
            <p>
              <strong>{startConflictPrompt.entry.packageName}</strong> ist im Ziel bereits vorhanden.
            </p>
            <p>Bei "überspringen" wird nur das erneute Entpacken übersprungen - offene Downloads bleiben in der Queue.</p>
            <p className="modal-path" title={startConflictPrompt.entry.extractDir}>{startConflictPrompt.entry.extractDir}</p>
            <label className="toggle-line">
              <input
                type="checkbox"
                checked={startConflictPrompt.applyToAll}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setStartConflictPrompt((prev) => prev ? { ...prev, applyToAll: checked } : prev);
                }}
              />
              Für alle weiteren Pakete dieselbe Auswahl verwenden
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => closeStartConflictPrompt(null)}>Abbrechen</button>
              <button
                className="btn"
                onClick={() => closeStartConflictPrompt({ policy: "skip", applyToAll: startConflictPrompt.applyToAll })}
              >
                Entpacktes überspringen
              </button>
              <button
                className="btn danger"
                onClick={() => closeStartConflictPrompt({ policy: "overwrite", applyToAll: startConflictPrompt.applyToAll })}
              >
                überschreiben
              </button>
            </div>
          </div>
        </div>
      )}

      {accountDialog && (
        <div className="modal-backdrop" onClick={closeAccountDialog}>
          <div className="modal-card account-modal" onClick={(event) => event.stopPropagation()}>
            <div className="account-modal-header">
              <div>
                <h3>{accountDialog.mode === "edit" ? "Account bearbeiten" : "Account hinzufügen"}</h3>
                <p>Wie in JDownloader: oben Account-Typ auswaehlen, unten Zugangsdaten direkt eintragen.</p>
              </div>
            </div>

            <div className="account-modal-body">
              <div className="account-dialog-step">
                <div className="account-dialog-step-label">1. Account-Typ auswaehlen</div>
                <input
                  className="account-picker-search"
                  placeholder="Dienst oder Typ suchen"
                  value={accountDialogSearch}
                  onChange={(event) => setAccountDialogSearch(event.target.value)}
                />
                <div className="account-picker-table">
                  <div className="account-picker-head">
                    <span>Account</span>
                    <span>Typ / Funktion</span>
                  </div>
                  {filteredAccountDialogOptions.length === 0 && (
                    <div className="account-empty-state compact">
                      <strong>Kein passender Account-Typ gefunden</strong>
                      <span>
                        {accountDialogSelectableOptions.length === 0
                          ? "Alle verfügbaren Typen sind bereits vorhanden."
                          : "Passe den Suchbegriff an oder waehle einen Eintrag aus der Liste."}
                      </span>
                    </div>
                  )}
                  {filteredAccountDialogOptions.map((option) => (
                    <button
                      key={option.kind}
                      className={`account-picker-row${accountDialog.kind === option.kind ? " active" : ""}`}
                      onClick={() => updateAccountDialogKind(option.kind)}
                    >
                      <div>
                        <strong>{option.title}</strong>
                        <span>{option.serviceLabel}</span>
                      </div>
                      <div>
                        <strong>{getAccountPickerFunctionLabel(option)}</strong>
                        <span>{option.pickerDescription}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="account-dialog-step">
                <div className="account-dialog-step-label">
                  {accountDialogOption ? `2. ${accountDialogOption.serviceLabel} - Zugangsdaten eingeben` : "2. Zugangsdaten eingeben"}
                </div>

                {!accountDialogOption && (
                  <div className="account-empty-state compact">
                    <strong>Oben zuerst einen Account-Typ wählen</strong>
                    <span>Danach erscheinen hier direkt die passenden Felder für Login, Passwort oder API-Token.</span>
                  </div>
                )}

                {accountDialogOption && (
                  <>
                    <div className="account-form-summary">
                      <strong>{accountDialogOption.title}</strong>
                      <span>{accountDialogOption.pickerDescription}</span>
                    </div>

                    <div className="account-modal-fields">
                      {accountDialogOption.needsToken && (
                        <div>
                          <label>{accountDialogOption.service === "alldebrid" || accountDialogOption.service === "onefichier" || accountDialogOption.service === "debridlink" ? "API-Key(s)" : "Token"}</label>
                          {accountDialogOption.service === "debridlink" ? (
                            <textarea
                              rows={4}
                              placeholder="Ein API-Key pro Zeile"
                              value={accountDialog.token}
                              onChange={(event) => setAccountDialog((prev) => prev ? {
                                ...prev,
                                token: event.target.value,
                                keyDailyLimitGbById: buildDebridLinkKeyLimitInputs(event.target.value, prev.keyDailyLimitGbById, settingsDraft)
                              } : prev)}
                              style={{ fontFamily: "monospace", resize: "vertical" }}
                            />
                          ) : (
                            <input type="password" value={accountDialog.token} onChange={(event) => setAccountDialog((prev) => prev ? { ...prev, token: event.target.value } : prev)} />
                          )}
                        </div>
                      )}

                      {accountDialogOption.needsCredentials && (
                        <div className="field-grid two">
                          <div>
                            <label>Login / E-Mail</label>
                            <input value={accountDialog.login} onChange={(event) => setAccountDialog((prev) => prev ? { ...prev, login: event.target.value } : prev)} />
                          </div>
                          <div>
                            <label>Passwort</label>
                            <input type="password" value={accountDialog.password} onChange={(event) => setAccountDialog((prev) => prev ? { ...prev, password: event.target.value } : prev)} />
                          </div>
                        </div>
                      )}

                      <div>
                        <label>Tageslimit (GB, optional)</label>
                        <input
                          inputMode="decimal"
                          placeholder="z.B. 250"
                          value={accountDialog.dailyLimitGb}
                          onChange={(event) => setAccountDialog((prev) => prev ? { ...prev, dailyLimitGb: event.target.value } : prev)}
                        />
                        <div className="account-modal-note">Ab 00:00 wird der Zähler automatisch zurückgesetzt. Wenn das Limit erreicht ist, nutzt die App den nächsten Hoster aus der Reihenfolge.</div>
                      </div>

                      {accountDialog.kind === "debridlink-api" && parseDebridLinkApiKeys(accountDialog.token).length > 0 && (
                        <div>
                          <label>API-Key Limits (GB, optional pro Key)</label>
                          <div className="account-dl-key-limit-list">
                            {parseDebridLinkApiKeys(accountDialog.token).map((key) => (
                              <div key={key.id} className="account-dl-key-limit-row">
                                <div className="account-dl-key-meta">
                                  <strong>{key.label}</strong>
                                  <span>{key.masked}</span>
                                </div>
                                <input
                                  inputMode="decimal"
                                  placeholder="Kein Limit"
                                  value={accountDialog.keyDailyLimitGbById[key.id] || ""}
                                  onChange={(event) => setAccountDialog((prev) => prev ? {
                                    ...prev,
                                    keyDailyLimitGbById: {
                                      ...prev.keyDailyLimitGbById,
                                      [key.id]: event.target.value
                                    }
                                  } : prev)}
                                />
                              </div>
                            ))}
                          </div>
                          <div className="account-modal-note">Leer lassen = unbegrenzt. Die Limits gelten pro API-Key und werden täglich um 00:00 zurückgesetzt.</div>
                        </div>
                      )}

                      {accountDialog.kind === "realdebrid-web" && (
                        <div className="account-modal-note">Nach dem Speichern kannst Du direkt das Browserfenster für den Web-Login öffnen.</div>
                      )}
                      {accountDialog.kind === "bestdebrid-web" && (
                        <div className="account-modal-note">Der Web-Account arbeitet über einen Cookies.txt-Import aus dem Browser.</div>
                      )}
                      {accountDialog.kind === "alldebrid-web" && (
                        <div className="account-modal-note">Der Web-Login nutzt ein echtes Browserfenster, damit reCAPTCHA sauber läuft.</div>
                      )}
                      {accountDialog.kind === "megadebrid-api" && (
                        <div className="account-modal-note">Dieser Account nutzt nur die Mega-Debrid API. Kein Web-Fallback.</div>
                      )}
                      {accountDialog.kind === "megadebrid-web" && (
                        <div className="account-modal-note">Dieser Account nutzt nur Mega-Debrid Web. Kein API-Fallback.</div>
                      )}

                      {accountDialogOption.service === "alldebrid" && allDebridHostInfo && (
                        <div className="account-status-grid">
                          <div>
                            <span className="hint">Rapidgator-Status</span>
                            <strong>{allDebridHostInfo.statusLabel}</strong>
                          </div>
                          <div>
                            <span className="hint">Quelle</span>
                            <strong>{formatAllDebridSourceLabel(allDebridHostInfo.source)}</strong>
                          </div>
                          <div>
                            <span className="hint">Quota</span>
                            <strong>{formatAllDebridQuota(allDebridHostInfo)}</strong>
                          </div>
                          <div>
                            <span className="hint">Simultan</span>
                            <strong>{formatAllDebridSimuLimit(allDebridHostInfo)}</strong>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="modal-actions">
                      <button className="btn" onClick={closeAccountDialog}>Abbrechen</button>
                      {accountDialog.kind === "realdebrid-web" && (
                        <button className="btn" disabled={actionBusy} onClick={() => { void onSaveAccountDialog("realdebrid-login"); }}>
                          Speichern + Login
                        </button>
                      )}
                      {accountDialog.kind === "bestdebrid-web" && (
                        <button className="btn" disabled={actionBusy} onClick={() => { void onSaveAccountDialog("bestdebrid-cookies"); }}>
                          Speichern + Cookies
                        </button>
                      )}
                      {accountDialog.kind === "alldebrid-web" && (
                        <button className="btn" disabled={actionBusy} onClick={() => { void onSaveAccountDialog("alldebrid-login"); }}>
                          Speichern + Login
                        </button>
                      )}
                      <button className="btn accent" disabled={actionBusy || !accountDialog.kind} onClick={() => { void onSaveAccountDialog(); }}>
                        Speichern
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="status-bar">
        <span>Pakete: {snapshot.stats.totalPackages}</span>
        <span>Links: {Object.keys(snapshot.session.items).length}</span>
        <span>Session: {humanSize(snapshot.stats.totalDownloaded)}</span>
        <span>Gesamt: {humanSize(snapshot.stats.totalDownloadedAllTime)}</span>
        <span>Hoster: {providerStats.length}</span>
        <span>{snapshot.speedText}</span>
        <span>{snapshot.etaText}</span>
        <span className="footer-spacer" />
        {totalPackageCount > 0 && (
          <button className="btn footer-btn" title={allPackagesCollapsed ? "Alle Pakete in der Liste ausklappen und Details anzeigen" : "Alle Pakete in der Liste einklappen und nur die Kopfzeilen anzeigen"} onClick={() => {
            setCollapsedPackages((prev) => {
              const next: Record<string, boolean> = { ...prev };
              const targetState = !allPackagesCollapsed;
              for (const pkg of packages) {
                next[pkg.id] = targetState;
                if (targetState) {
                  manualCollapsedPkgsRef.current.add(pkg.id);
                } else {
                  manualCollapsedPkgsRef.current.delete(pkg.id);
                  autoExpandedPkgsRef.current.delete(pkg.id);
                }
              }
              return next;
            });
          }}>{allPackagesCollapsed ? "Ausklappen" : "Einklappen"}</button>
        )}
        {totalPackageCount > 0 && (
          <button className="btn footer-btn" title="Alle Pakete und Links aus der Download-Queue entfernen" disabled={actionBusy} onClick={() => {
            void performQuickAction(async () => {
              const confirmed = await askConfirmPrompt({ title: "Queue löschen", message: "Wirklich alle Einträge aus der Queue löschen?", confirmLabel: "Alles löschen", danger: true });
              if (!confirmed) return;
              await window.rd.clearAll();
            });
          }}>Leeren</button>
        )}
        {snapshot.clipboardActive && (
          <button className="btn footer-btn btn-active" title="Zwischenablage-Überwachung ist aktiv ? kopierte Links werden automatisch erkannt und zur Queue hinzugefügt. Zum Deaktivieren: Einstellungen ? Zwischenablage überwachen" disabled={actionBusy} onClick={() => { void performQuickAction(() => window.rd.toggleClipboard()); }}>
            Clipboard: An
          </button>
        )}
      </footer>

      {updateInstallProgress && (
        <div className={`update-popup update-popup-${updateInstallProgress.stage}`}>
          <div className="update-popup-header">
            <span className="update-popup-title">Update</span>
            {(updateInstallProgress.stage === "done" || updateInstallProgress.stage === "error") && (
              <button className="update-popup-close" onClick={() => setUpdateInstallProgress(null)} title="Schließen">&times;</button>
            )}
          </div>
          <div className="update-popup-message">{formatUpdateInstallProgress(updateInstallProgress)}</div>
          {updateInstallProgress.stage === "downloading" && updateInstallProgress.percent !== null && (
            <div className="update-popup-bar-track">
              <div className="update-popup-bar-fill" style={{ width: `${updateInstallProgress.percent}%` }} />
            </div>
          )}
        </div>
      )}
      {statusToast && <div className="toast">{statusToast}</div>}
      {dragOver && <div className="drop-overlay">Links, .dlc oder Export-Dateien hier ablegen</div>}
      {contextMenu && (() => {
        const multi = selectedIds.size > 1;
        const selectedPackageIds = [...selectedIds].filter((id) => snapshot.session.packages[id]);
        const selectedItemIds = [...selectedIds].filter((id) => snapshot.session.items[id]);
        const hasPackages = selectedPackageIds.length > 0;
        const startableStatuses = new Set(["queued", "cancelled", "reconnect_wait"]);
        const hasStartableItems = [...selectedIds].some((id) => { const it = snapshot.session.items[id]; return it && startableStatuses.has(it.status); });
        const hasItems = selectedItemIds.length > 0;
        return (
        <div ref={ctxMenuRef} className="ctx-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          {(hasPackages || hasStartableItems) && (
            <button className="ctx-menu-item" onClick={() => {
              const pkgIds = selectedPackageIds;
              const itemIds = selectedItemIds.filter((id) => { const it = snapshot.session.items[id]; return it && startableStatuses.has(it.status); });
              if (pkgIds.length > 0) void window.rd.startPackages(pkgIds).catch(() => {});
              if (itemIds.length > 0) void window.rd.startItems(itemIds).catch(() => {});
              setContextMenu(null);
            }}>Ausgewählte Downloads starten{multi ? ` (${selectedIds.size})` : ""}</button>
          )}
          <button className="ctx-menu-item" onClick={() => { void window.rd.start().catch(() => {}); setContextMenu(null); }}>Alle Downloads starten</button>
          <div className="ctx-menu-sep" />
          <button className="ctx-menu-item" onClick={() => showLinksPopup(contextMenu.packageId, contextMenu.itemId)}>Linkadressen anzeigen</button>
          {hasPackages && !contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              void onExportPackageSelection(selectedPackageIds);
              setContextMenu(null);
            }}>{multi ? `Ausgewählte Pakete exportieren (${selectedPackageIds.length})` : "Paket exportieren"}</button>
          )}
          {contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              void onExportItemSelection(multi ? selectedItemIds : [contextMenu.itemId!]);
              setContextMenu(null);
            }}>{multi ? `Ausgewählte Dateien exportieren (${selectedItemIds.length})` : "Datei exportieren"}</button>
          )}
          {hasPackages && !contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              for (const id of selectedPackageIds) {
                void window.rd.openPackageLog(id).catch(() => {});
              }
              setContextMenu(null);
            }}>Log öffnen{multi ? ` (${selectedPackageIds.length})` : ""}</button>
          )}
          {contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              const itemIds = multi ? selectedItemIds : [contextMenu.itemId!];
              for (const id of itemIds) {
                void window.rd.openItemLog(id).catch(() => {});
              }
              setContextMenu(null);
            }}>Item-Log Ã¶ffnen{multi ? ` (${selectedItemIds.length})` : ""}</button>
          )}
          <div className="ctx-menu-sep" />
          {hasPackages && !contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              for (const id of selectedIds) { if (snapshot.session.packages[id]) onPackageToggle(id); }
              setContextMenu(null);
            }}>
              {multi ? `Alle ${selectedIds.size} umschalten` : (snapshot.session.packages[contextMenu.packageId]?.enabled ? "Deaktivieren" : "Aktivieren")}
            </button>
          )}
          {!multi && contextMenu.itemId && (
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              setContextMenu(null);
              const ids = new Set([contextMenu.itemId!]);
              if (settingsDraft.confirmDeleteSelection) { setDeleteConfirm({ ids, dontAsk: false }); }
              else { executeDeleteSelection(ids); }
            }}>Entfernen</button>
          )}
          {selectedItemIds.length > 1 && !hasPackages && (
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              setContextMenu(null);
              const ids = new Set(selectedItemIds);
              if (settingsDraft.confirmDeleteSelection) { setDeleteConfirm({ ids, dontAsk: false }); }
              else { executeDeleteSelection(ids); }
            }}>Ausgewählte Dateien entfernen ({selectedItemIds.length})</button>
          )}
          {hasPackages && !contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              for (const id of selectedPackageIds) void window.rd.resetPackage(id).catch(() => {});
              setContextMenu(null);
            }}>Zurücksetzen{multi ? ` (${selectedPackageIds.length})` : ""}</button>
          )}
          {contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              const itemIds = multi ? selectedItemIds : [contextMenu.itemId!];
              void window.rd.resetItems(itemIds).catch(() => {});
              setContextMenu(null);
            }}>Zurücksetzen{multi ? ` (${selectedItemIds.length})` : ""}</button>
          )}
          {hasPackages && !multi && (() => {
            const pkg = snapshot.session.packages[contextMenu.packageId];
            const items = pkg?.itemIds.map((id) => snapshot.session.items[id]).filter(Boolean) || [];
            const someCompleted = items.some((item) => item && item.status === "completed");
            return (<>
              {someCompleted && (
                <button className="ctx-menu-item" onClick={() => { void window.rd.extractNow(contextMenu.packageId).catch(() => {}); setContextMenu(null); }}>Jetzt entpacken</button>
              )}
            </>);
          })()}
          {hasPackages && !contextMenu.itemId && (<>
            <div className="ctx-menu-sep" />
            <div className="ctx-menu-sub">
              <button className="ctx-menu-item">Priorität &gt;</button>
              <div className="ctx-menu-sub-items">
                {(["high", "normal", "low"] as const).map((p) => {
                  const label = p === "high" ? "Hoch" : p === "low" ? "Niedrig" : "Standard";
                  const pkgIds = selectedPackageIds;
                  const allMatch = pkgIds.every((id) => (snapshot.session.packages[id]?.priority || "normal") === p);
                  return <button key={p} className={`ctx-menu-item${allMatch ? " ctx-menu-active" : ""}`} onClick={() => { for (const id of pkgIds) void window.rd.setPackagePriority(id, p).catch(() => {}); setContextMenu(null); }}>{allMatch ? `[Aktiv] ${label}` : label}</button>;
                })}
              </div>
            </div>
          </>)}
          {hasItems && (() => {
            const itemIds = selectedItemIds;
            const skippable = itemIds.filter((id) => { const it = snapshot.session.items[id]; return it && (it.status === "queued" || it.status === "reconnect_wait"); });
            if (skippable.length === 0) return null;
            return <button className="ctx-menu-item" onClick={() => { void window.rd.skipItems(skippable).catch(() => {}); setContextMenu(null); }}>überspringen{skippable.length > 1 ? ` (${skippable.length})` : ""}</button>;
          })()}
          {hasPackages && (
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              setContextMenu(null);
              const ids = new Set(selectedPackageIds);
              if (settingsDraft.confirmDeleteSelection) { setDeleteConfirm({ ids, dontAsk: false }); }
              else { executeDeleteSelection(ids); }
            }}>{multi ? `Ausgewählte entfernen (${selectedPackageIds.length})` : "Paket entfernen"}</button>
          )}
        </div>
        );
      })()}
      {colHeaderCtx && (
        <div ref={colHeaderCtxRef} className="ctx-menu" style={{ left: colHeaderCtx.x, top: colHeaderCtx.y }} onClick={(e) => e.stopPropagation()}>
          {ALL_COLUMN_KEYS.map((col) => {
            const def = COLUMN_DEFS[col];
            if (!def) return null;
            const isVisible = columnOrder.includes(col);
            const isRequired = col === "name";
            return (
              <button
                key={col}
                className={`ctx-menu-item${isRequired ? " ctx-menu-disabled" : ""}${isVisible ? " ctx-menu-active" : ""}`}
                disabled={isRequired}
                onClick={() => {
                  if (isRequired) return;
                  let newOrder: string[];
                  if (isVisible) {
                    newOrder = columnOrder.filter((c) => c !== col);
                  } else {
                    // Insert at original default position relative to existing columns
                    newOrder = [...columnOrder];
                    const defaultIdx = ALL_COLUMN_KEYS.indexOf(col);
                    let insertAt = newOrder.length;
                    for (let i = 0; i < newOrder.length; i++) {
                      if (ALL_COLUMN_KEYS.indexOf(newOrder[i]) > defaultIdx) {
                        insertAt = i;
                        break;
                      }
                    }
                    newOrder.splice(insertAt, 0, col);
                  }
                  setColumnOrder(newOrder);
                  void window.rd.updateSettings({ columnOrder: newOrder }).catch(() => {});
                }}
              >
                {isVisible ? "\u2713 " : "\u2003 "}{def.label}
              </button>
            );
          })}
        </div>
      )}
      {historyCtxMenu && (() => {
        const multi = selectedHistoryIds.size > 1;
        const contextEntry = historyEntries.find(e => e.id === historyCtxMenu.entryId);
        const hasUrls = (contextEntry?.urls?.length ?? 0) > 0;
        const removeSelected = (): void => {
          const idSet = new Set(selectedHistoryIds);
          void Promise.all([...idSet].map(id => window.rd.removeHistoryEntry(id))).then(() => {
            setHistoryEntries((prev) => prev.filter((e) => !idSet.has(e.id)));
            setSelectedHistoryIds(new Set());
          }).catch(() => {
            void window.rd.getHistory().then((entries) => { setHistoryEntries(entries); setSelectedHistoryIds(new Set()); }).catch(() => {});
          });
          setHistoryCtxMenu(null);
        };
        return (
          <div ref={historyCtxMenuRef} className="ctx-menu" style={{ left: historyCtxMenu.x, top: historyCtxMenu.y }} onClick={(e) => e.stopPropagation()}>
            <button className="ctx-menu-item ctx-danger" onClick={removeSelected}>
              {multi ? `Ausgewählte entfernen (${selectedHistoryIds.size})` : "Eintrag entfernen"}
            </button>
            {hasUrls && !multi && (
              <>
                <div className="ctx-menu-sep" />
                <button className="ctx-menu-item" onClick={() => {
                  const rawText = contextEntry!.urls!.join("\n");
                  void window.rd.addLinks({ rawText, packageName: contextEntry!.name }).then((result) => {
                    if (result.addedLinks > 0) showToast(`${result.addedLinks} Link(s) zur Queue hinzugefügt`);
                    else showToast("Keine Links hinzugefügt");
                  }).catch(() => showToast("Fehler beim Hinzufügen"));
                  setHistoryCtxMenu(null);
                }}>Erneut herunterladen</button>
                <button className="ctx-menu-item" onClick={() => {
                  const urls = contextEntry!.urls!;
                  const links = urls.map((u) => ({ name: u, url: u }));
                  setLinkPopup({ title: contextEntry!.name, links, isPackage: links.length > 1 });
                  setHistoryCtxMenu(null);
                }}>Linkadressen anzeigen</button>
              </>
            )}
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              void window.rd.clearHistory().then(() => { setHistoryEntries([]); setSelectedHistoryIds(new Set()); }).catch(() => {});
              setHistoryCtxMenu(null);
            }}>Verlauf leeren</button>
          </div>
        );
      })()}
      {keyStatsPopup && (() => {
        const entry = configuredAccounts.find((a) => a.service === keyStatsPopup);
        if (!entry || entry.debridLinkKeys.length === 0) return null;
        const totalUsed = entry.debridLinkKeys.reduce((s, k) => s + k.dailyUsedBytes, 0);
        const limitedCount = entry.debridLinkKeys.filter((k) => k.dailyLimitReached).length;
        const disabledCount = entry.debridLinkKeys.filter((k) => k.disabled).length;
        const loadedQuotaCount = entry.debridLinkKeys.filter((k) => Boolean(debridLinkHostLimits[k.id])).length;
        return (
          <div className="modal-backdrop" onClick={() => setKeyStatsPopup(null)}>
            <div className="modal-card key-stats-popup" onClick={(e) => e.stopPropagation()}>
              <div className="key-stats-popup-header">
                <div>
                  <h3>API-Key Statistik</h3>
                  <p className="key-stats-summary">
                    {entry.debridLinkKeys.length} Keys &middot; Heute: {humanSize(totalUsed)}
                    {limitedCount > 0 && <span className="key-stats-warn"> &middot; {limitedCount} am Limit</span>}
                    {disabledCount > 0 && <span className="key-stats-warn"> &middot; {disabledCount} deaktiviert</span>}
                    {debridLinkHostLimitsLoading && <span> &middot; Rapidgator-Quota wird geladen ({loadedQuotaCount}/{entry.debridLinkKeys.length})</span>}
                    {!debridLinkHostLimitsLoading && !debridLinkHostLimitsError && <span> &middot; Rapidgator API-Quota</span>}
                    {debridLinkHostLimitsError && <span className="key-stats-warn"> &middot; API-Quota konnte nicht geladen werden</span>}
                  </p>
                </div>
                <button className="update-popup-close" onClick={() => setKeyStatsPopup(null)}>&times;</button>
              </div>
              <div className="account-subkey-table">
                <div className="account-subkey-table-head">
                  <span className="col-key">#</span>
                  <span className="col-masked">Key</span>
                  <span className="col-usage">Heute</span>
                  <span className="col-limit">Lokal</span>
                  <span className="col-traffic">RG Traffic</span>
                  <span className="col-links">RG Links</span>
                  <span className="col-action"></span>
                </div>
                {entry.debridLinkKeys.map((key, ki) => (
                  <div key={key.id} className={`account-subkey-table-row${key.dailyLimitReached ? " warning" : ""}${key.disabled ? " disabled" : ""}`}>
                    {(() => {
                      const hostInfo = debridLinkHostLimits[key.id];
                      return (
                        <>
                    <span className="col-key">{ki + 1}</span>
                    <span
                      className="col-masked link-popup-click"
                      title={`${key.masked}\nKlicken zum Kopieren`}
                      onClick={() => {
                        void navigator.clipboard.writeText(key.token)
                          .then(() => showToast(`${key.label} kopiert`, 1800))
                          .catch(() => showToast("Kopieren fehlgeschlagen", 2200));
                      }}
                    >
                      {key.masked}
                    </span>
                    <span className="col-usage">{humanSize(key.dailyUsedBytes)}</span>
                    <span className="col-limit">{key.disabled ? "Deaktiviert" : key.dailyLimitBytes > 0 ? humanSize(key.dailyLimitBytes) : "Kein Limit"}</span>
                    <span className="col-traffic" title={hostInfo?.note || ""}>{formatDebridLinkTraffic(hostInfo)}</span>
                    <span className="col-links" title={hostInfo?.note || ""}>{formatDebridLinkCountQuota(hostInfo)}</span>
                    <span className="col-action">
                      <button
                        className={`btn btn-sm ${key.disabled ? "success" : "danger"}`}
                        disabled={actionBusy}
                        onClick={() => { void onToggleDebridLinkApiKeyEnabled(entry, key); }}
                      >
                        {key.disabled ? "Aktivieren" : "Deaktivieren"}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={actionBusy || key.dailyUsedBytes <= 0}
                        onClick={() => { void onResetDebridLinkApiKeyDailyUsage(entry, key.id, key.label); }}
                      >
                        Reset
                      </button>
                    </span>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setKeyStatsPopup(null)}>Schließen</button>
              </div>
            </div>
          </div>
        );
      })()}
      {linkPopup && (
        <div className="modal-backdrop" onClick={() => setLinkPopup(null)}>
          <div className="modal-card link-popup" onClick={(e) => e.stopPropagation()}>
            <h3>Linkadressen anzeigen</h3>
            <p>{linkPopup.title}</p>
            <div className="link-popup-list">
              {linkPopup.links.map((link, i) => (
                <div key={i} className="link-popup-row">
                  <span className="link-popup-name link-popup-click" title={`${link.name}\nKlicken zum Kopieren`} onClick={() => { void navigator.clipboard.writeText(link.name).then(() => showToast("Name kopiert")).catch(() => showToast("Kopieren fehlgeschlagen")); }}>{link.name}</span>
                  <span className="link-popup-url link-popup-click" title={`${link.url}\nKlicken zum Kopieren`} onClick={() => { void navigator.clipboard.writeText(link.url).then(() => showToast("Link kopiert")).catch(() => showToast("Kopieren fehlgeschlagen")); }}>{link.url}</span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              {linkPopup.isPackage && (
                <button className="btn" onClick={() => {
                  const text = linkPopup.links.map((l) => l.name).join("\n");
                  void navigator.clipboard.writeText(text).then(() => showToast("Alle Namen kopiert")).catch(() => showToast("Kopieren fehlgeschlagen"));
                }}>Alle Namen kopieren</button>
              )}
              {linkPopup.isPackage && (
                <button className="btn" onClick={() => {
                  const text = linkPopup.links.map((l) => l.url).join("\n");
                  void navigator.clipboard.writeText(text).then(() => showToast("Alle Links kopiert")).catch(() => showToast("Kopieren fehlgeschlagen"));
                }}>Alle Links kopieren</button>
              )}
              <button className="btn" onClick={() => setLinkPopup(null)}>Schließen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface PackageCardProps {
  pkg: PackageEntry;
  items: DownloadItem[];
  packageSpeed: number;
  stripeVariant: "a" | "b";
  isFirst: boolean;
  isLast: boolean;
  isEditing: boolean;
  editingName: string;
  collapsed: boolean;
  hideExtractedItems: boolean;
  sessionRunning: boolean;
  selectedIds: Set<string>;
  columnOrder: string[];
  gridTemplate: string;
  onSelect: (id: string, ctrlKey: boolean, shiftKey: boolean) => void;
  onSelectMouseDown: (id: string, e: React.MouseEvent) => void;
  onSelectMouseEnter: (id: string) => void;
  onStartEdit: (packageId: string, packageName: string) => void;
  onFinishEdit: (packageId: string, currentName: string, nextName: string) => void;
  onEditChange: (name: string) => void;
  onToggleCollapse: (packageId: string) => void;
  onCancel: (packageId: string) => void;
  onMoveUp: (packageId: string) => void;
  onMoveDown: (packageId: string) => void;
  onToggle: (packageId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onContextMenu: (packageId: string, itemId: string | undefined, x: number, y: number) => void;
  onDragStart: (packageId: string) => void;
  onDrop: (packageId: string) => void;
  onDragEnd: () => void;
}

const PackageCard = memo(function PackageCard({ pkg, items, packageSpeed, stripeVariant, isFirst, isLast, isEditing, editingName, collapsed, hideExtractedItems, sessionRunning, selectedIds, columnOrder, gridTemplate, onSelect, onSelectMouseDown, onSelectMouseEnter, onStartEdit, onFinishEdit, onEditChange, onToggleCollapse, onCancel, onMoveUp, onMoveDown, onToggle, onRemoveItem, onContextMenu, onDragStart, onDrop, onDragEnd }: PackageCardProps): ReactElement {
  const done = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const extracted = items.filter((item) => item.fullStatus?.startsWith("Entpackt")).length;
  const extracting = items.some((item) => item.fullStatus?.startsWith("Entpacken"));
  const total = Math.max(1, items.length);
  // Use 50/50 split when extraction is active OR package is in extracting state
  // (prevents bar jumping from 100% to 50% when extraction starts)
  const allDownloaded = done + failed + cancelled >= total;
  const allExtracted = extracted >= total;
  const useExtractSplit = extracting || pkg.status === "extracting" || (allDownloaded && !allExtracted && done > 0 && extracted > 0 && failed === 0 && cancelled === 0);
  // Include fractional progress from active downloads so the bar moves continuously
  const activeProgress = items.reduce((sum, item) => {
    if (item.status === "downloading" || (item.status === "queued" && (item.progressPercent || 0) > 0)) {
      return sum + (item.progressPercent || 0) / 100;
    }
    return sum;
  }, 0);
  const dlProgress = Math.min(useExtractSplit ? 50 : 100, Math.floor(((done + activeProgress) / total) * (useExtractSplit ? 50 : 100)));
  // Include fractional progress from items currently being extracted
  const extractingProgress = items.reduce((sum, item) => {
    const fs = item.fullStatus || "";
    if (fs.startsWith("Entpackt")) return sum;
    const m = fs.match(/^Entpacken\s+(\d+)%/);
    if (m) return sum + Number(m[1]) / 100;
    return sum;
  }, 0);
  const exProgress = Math.min(50, Math.floor(((extracted + extractingProgress) / total) * 50));
  const combinedProgress = Math.min(100, useExtractSplit ? dlProgress + exProgress : dlProgress);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { onFinishEdit(pkg.id, pkg.name, editingName); }
    if (e.key === "Escape") { onFinishEdit(pkg.id, pkg.name, pkg.name); }
  };

  const getDisplayedItemStatus = (item: DownloadItem): string => {
    const statusText = String(item.fullStatus || "").trim();
    if (statusText === "Wartet") {
      return "";
    }
    if (sessionRunning) {
      return statusText;
    }
    if (item.status !== "queued" && item.status !== "reconnect_wait") {
      return statusText;
    }
    if (statusText === "Paket gestoppt") {
      return statusText;
    }
    if (/^Entpacken\b/i.test(statusText) || /^Entpackt\b/i.test(statusText) || /^Entpack-Fehler\b/i.test(statusText) || /^Fertig\b/i.test(statusText)) {
      return statusText;
    }
    return "";
  };

  return (
    <article
      className={`package-card queue-package-card pkg-stripe-${stripeVariant}${pkg.enabled ? "" : " disabled-pkg"}${selectedIds.has(pkg.id) ? " pkg-selected" : ""}`}
      draggable
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(pkg.id, undefined, e.clientX, e.clientY); }}
      onClick={(e) => { if (e.ctrlKey || e.shiftKey) onSelect(pkg.id, e.ctrlKey, e.shiftKey); }}
      onMouseDown={(e) => onSelectMouseDown(pkg.id, e)}
      onMouseEnter={() => onSelectMouseEnter(pkg.id)}
      onDragStart={(event) => { event.stopPropagation(); onDragStart(pkg.id); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDrop(pkg.id); }}
      onDragEnd={(event) => { event.stopPropagation(); onDragEnd(); }}
    >
      <header onClick={(e) => {
        if (e.ctrlKey) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
        onToggleCollapse(pkg.id);
      }} style={{ cursor: "pointer" }}>
        <div className="pkg-columns" style={{ gridTemplateColumns: gridTemplate }}>
          {columnOrder.map((col) => {
            switch (col) {
              case "name": return (
                <div key={col} className="pkg-col pkg-col-name">
                  <button className="pkg-toggle" onClick={() => onToggleCollapse(pkg.id)} title={collapsed ? "Ausklappen" : "Einklappen"}>{collapsed ? "+" : "\u2212"}</button>
                  <input type="checkbox" checked={pkg.enabled} onChange={() => onToggle(pkg.id)} title={pkg.enabled ? "Paket aktiv" : "Paket deaktiviert"} />
                  {isEditing ? (
                    <input className="rename-input" value={editingName} onChange={(e) => onEditChange(e.target.value)} onBlur={() => onFinishEdit(pkg.id, pkg.name, editingName)} onKeyDown={onKeyDown} autoFocus />
                  ) : (
                    <h4 onClick={(e) => { e.stopPropagation(); onStartEdit(pkg.id, pkg.name); }} title="Klicken zum Umbenennen">{pkg.name}</h4>
                  )}
                </div>
              );
              case "size": return (
                <span key={col} className="pkg-col pkg-col-size">{(() => {
                  const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || item.downloadedBytes || 0), 0);
                  const dlBytes = items.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
                  const pct = totalBytes > 0 ? Math.min(100, Math.round((dlBytes / totalBytes) * 100)) : 0;
                  const label = `${humanSize(dlBytes)} / ${humanSize(totalBytes)}`;
                  return totalBytes > 0 ? (
                    <span className="progress-size">
                      <span className="progress-size-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-size-text">{label}</span>
                      <span className="progress-size-text-filled" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{label}</span>
                    </span>
                  ) : "";
                })()}</span>
              );
              case "progress": return (
                <span key={col} className="pkg-col pkg-col-progress">
                  <span className="progress-inline">
                    <span className="progress-inline-bar" style={{ width: `${combinedProgress}%` }} />
                    <span className="progress-inline-text">{combinedProgress}%</span>
                    <span className="progress-inline-text-filled" style={{ clipPath: `inset(0 ${100 - combinedProgress}% 0 0)` }}>{combinedProgress}%</span>
                  </span>
                </span>
              );
              case "hoster": {
                const hosterText = [...new Set(items.map((item) => extractHoster(item.url)).filter(Boolean))].join(", ");
                return <span key={col} className="pkg-col pkg-col-hoster" title={hosterText}>{hosterText}</span>;
              }
              case "account": {
                const accountText = compactProviderLabels(items.map((item) => item.providerLabel || (item.provider ? providerLabels[item.provider] : "")).filter(Boolean));
                return <span key={col} className="pkg-col pkg-col-account" title={accountText}>{accountText}</span>;
              }
              case "prio": return (
                <span key={col} className={`pkg-col pkg-col-prio${pkg.priority === "high" ? " prio-high" : pkg.priority === "low" ? " prio-low" : ""}`}>{pkg.priority === "high" ? "Hoch" : pkg.priority === "low" ? "Niedrig" : ""}</span>
              );
              case "status": return (
                <span key={col} className="pkg-col pkg-col-status">[{done}/{total}{done === total && total > 0 ? " - Done" : ""}{failed > 0 ? ` | ${failed} Fehler` : ""}{cancelled > 0 ? ` | ${cancelled} abgebr.` : ""}]{pkg.postProcessLabel ? ` - ${pkg.postProcessLabel}` : ""}</span>
              );
              case "speed": return (
                <span key={col} className="pkg-col pkg-col-speed">{packageSpeed > 0 ? formatSpeedMbps(packageSpeed) : ""}</span>
              );
              case "added": return (
                <span key={col} className="pkg-col pkg-col-added">{formatDateTime(pkg.createdAt)}</span>
              );
              default: return null;
            }
          })}
        </div>
      </header>
      <div className="progress">
        <div className="progress-dl" style={{ width: `${dlProgress}%` }} />
        {useExtractSplit && <div className="progress-ex" style={{ width: `${exProgress}%` }} />}
      </div>
      {!collapsed && items.filter((item) => !hideExtractedItems || !item.fullStatus?.startsWith("Entpackt")).map((item) => (
        <div key={item.id} className={`item-row${selectedIds.has(item.id) ? " item-selected" : ""}`} style={{ gridTemplateColumns: gridTemplate }} onClick={(e) => { e.stopPropagation(); onSelect(item.id, e.ctrlKey, e.shiftKey); }} onMouseDown={(e) => { e.stopPropagation(); onSelectMouseDown(item.id, e); }} onMouseEnter={() => onSelectMouseEnter(item.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(pkg.id, item.id, e.clientX, e.clientY); }}>
          {columnOrder.map((col) => {
            switch (col) {
              case "name": return (
                <span key={col} className="pkg-col pkg-col-name item-indent" title={item.fileName}>
                  {item.onlineStatus && <span className={`link-status-dot ${item.onlineStatus}`} title={item.onlineStatus === "online" ? "Online" : item.onlineStatus === "offline" ? "Offline" : "Wird geprüft..."} />}
                  {item.fileName}
                </span>
              );
              case "size": return (
                <span key={col} className="pkg-col pkg-col-size">{(() => {
                  const total = item.totalBytes || item.downloadedBytes || 0;
                  const dl = item.downloadedBytes || 0;
                  const pct = total > 0 ? Math.min(100, Math.round((dl / total) * 100)) : 0;
                  const label = `${humanSize(dl)} / ${humanSize(total)}`;
                  return total > 0 ? (
                    <span className="progress-size progress-size-small">
                      <span className="progress-size-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-size-text">{label}</span>
                      <span className="progress-size-text-filled" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{label}</span>
                    </span>
                  ) : "";
                })()}</span>
              );
              case "progress": return (
                <span key={col} className="pkg-col pkg-col-progress">
                  {item.totalBytes > 0 ? (
                    <span className="progress-inline progress-inline-small">
                      <span className="progress-inline-bar" style={{ width: `${item.progressPercent}%` }} />
                      <span className="progress-inline-text">{item.progressPercent}%</span>
                      <span className="progress-inline-text-filled" style={{ clipPath: `inset(0 ${100 - (item.progressPercent || 0)}% 0 0)` }}>{item.progressPercent}%</span>
                    </span>
                  ) : ""}
                </span>
              );
              case "hoster": { const h = extractHoster(item.url) || ""; return <span key={col} className="pkg-col pkg-col-hoster" title={h}>{h}</span>; }
              case "account": return <span key={col} className="pkg-col pkg-col-account">{item.providerLabel || (item.provider ? providerLabels[item.provider] : "")}</span>;
              case "prio": return <span key={col} className="pkg-col pkg-col-prio"></span>;
              case "status": return (
                <span key={col} className="pkg-col pkg-col-status" title={(() => {
                  const displayStatus = getDisplayedItemStatus(item);
                  if (!displayStatus) {
                    return "";
                  }
                  return item.retries > 0 ? `${displayStatus} ? R${item.retries}` : displayStatus;
                })()}>
                  {getDisplayedItemStatus(item)}
                </span>
              );
              case "speed": return <span key={col} className="pkg-col pkg-col-speed">{item.speedBps > 0 ? formatSpeedMbps(item.speedBps) : ""}</span>;
              case "added": return <span key={col} className="pkg-col pkg-col-added">{formatDateTime(item.createdAt)}</span>;
              default: return null;
            }
          })}
        </div>
      ))}
    </article>
  );
}, (prev, next) => {
  if (prev.pkg.id !== next.pkg.id) {
    return false;
  }
  if (prev.pkg.updatedAt !== next.pkg.updatedAt
    || prev.pkg.status !== next.pkg.status
    || prev.pkg.enabled !== next.pkg.enabled
    || prev.pkg.name !== next.pkg.name
    || prev.pkg.priority !== next.pkg.priority
    || prev.pkg.createdAt !== next.pkg.createdAt) {
    return false;
  }
  if (prev.packageSpeed !== next.packageSpeed
    || prev.isFirst !== next.isFirst
    || prev.isLast !== next.isLast
    || prev.isEditing !== next.isEditing
    || prev.collapsed !== next.collapsed
    || prev.hideExtractedItems !== next.hideExtractedItems
    || prev.selectedIds !== next.selectedIds
    || prev.columnOrder !== next.columnOrder
    || prev.gridTemplate !== next.gridTemplate) {
    return false;
  }
  if ((prev.isEditing || next.isEditing) && prev.editingName !== next.editingName) {
    return false;
  }
  if (prev.pkg.itemIds.length !== next.pkg.itemIds.length) {
    return false;
  }
  for (let index = 0; index < prev.pkg.itemIds.length; index += 1) {
    if (prev.pkg.itemIds[index] !== next.pkg.itemIds[index]) {
      return false;
    }
  }
  if (prev.items.length !== next.items.length) {
    return false;
  }
  for (let index = 0; index < prev.items.length; index += 1) {
    const a = prev.items[index];
    const b = next.items[index];
    if (!a || !b) {
      return false;
    }
    if (a.id !== b.id
      || a.updatedAt !== b.updatedAt
      || a.url !== b.url
      || a.status !== b.status
      || a.fileName !== b.fileName
      || a.progressPercent !== b.progressPercent
      || a.speedBps !== b.speedBps
      || a.retries !== b.retries
      || a.provider !== b.provider
      || a.fullStatus !== b.fullStatus
      || a.onlineStatus !== b.onlineStatus
      || a.downloadedBytes !== b.downloadedBytes
      || a.totalBytes !== b.totalBytes) {
      return false;
    }
  }
  return true;
});


