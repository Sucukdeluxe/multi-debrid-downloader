import { parseDebridLinkApiKeys } from "../shared/debrid-link-keys";
import { parseMegaDebridAccounts, type MegaDebridAccountEntry } from "../shared/mega-debrid-accounts";
import { AllDebridHostInfo, AppSettings, DebridFallbackProvider, DebridLinkHostLimitInfo, DebridProvider } from "../shared/types";
import { isDebridLinkApiKeyDailyLimitReached, isMegaDebridAccountDisabled, isMegaDebridAccountDailyLimitReached, isProviderDailyLimitReached } from "../shared/provider-daily-limits";
import { APP_VERSION, REQUEST_RETRIES } from "./constants";
import { logger } from "./logger";
import { RealDebridClient, UnrestrictedLink } from "./realdebrid";
import { compactErrorText, filenameFromUrl, looksLikeOpaqueFilename, sleep } from "./utils";

const API_TIMEOUT_MS = 30000;
const DEBRID_USER_AGENT = `RD-Node-Downloader/${APP_VERSION}`;
const RAPIDGATOR_SCAN_MAX_BYTES = 512 * 1024;

const BEST_DEBRID_API_BASE = "https://bestdebrid.com/api/v1";
const ALL_DEBRID_API_BASE = "https://api.alldebrid.com/v4";
const ALL_DEBRID_API_BASE_V41 = "https://api.alldebrid.com/v4.1";

const MEGA_DEBRID_API_BASE = "https://www.mega-debrid.eu/api.php";

const ONEFICHIER_API_BASE = "https://api.1fichier.com/v1";
const ONEFICHIER_URL_RE = /^https?:\/\/(?:www\.)?(?:1fichier\.com|alterupload\.com|cjoint\.net|desfichiers\.com|dfichiers\.com|megadl\.fr|mesfichiers\.org|piecejointe\.net|pjointe\.com|tenvoi\.com|dl4free\.com)\/\?([a-z0-9]{5,20})$/i;

const DEBRID_LINK_API_BASE = "https://debrid-link.com/api/v2";
const DEBRID_LINK_QUOTA_ERRORS = new Set(["maxLink", "maxLinkHost", "maxData", "maxDataHost"]);
const DEBRID_LINK_INVALID_TOKEN_ERRORS = new Set(["badToken", "hidedToken", "expired_token"]);
const DEBRID_LINK_RATE_LIMIT_ERRORS = new Set(["floodDetected"]);
const DEBRID_LINK_RETRYABLE_ERRORS = new Set(["internalError", "server_error"]);
const DEBRID_LINK_PROVIDER_WIDE_ERRORS = new Set(["notDebrid"]);
/** Errors where the key can't handle this link — skip to next key immediately, no retries */
const DEBRID_LINK_SKIP_KEY_ERRORS = new Set([
  "disabledServerHost",
  "notFreeHost",
  "serverNotAllowed",
  "freeServerOverload",
  "maintenanceHost",
  "noServerHost",
  "fileNotAvailable"
]);
const DEBRID_LINK_FATAL_LINK_ERRORS = new Set(["badArguments", "badFileUrl", "badFilePassword", "fileNotFound", "hostNotValid"]);
/** Per-key cooldown cache: keyId → expiry timestamp. Parallel items skip keys that recently failed. */
const debridLinkKeyCooldowns = new Map<string, number>();
type DebridLinkCooldownCategory = "invalid" | "rate_limit" | "quota" | "temporary" | "skip";
type DebridLinkCooldownDetail = { message: string; category: DebridLinkCooldownCategory };
type DebridLinkRuntimeState = DebridLinkHostLimitInfo["state"];
type DebridLinkRuntimeStatus = {
  state: DebridLinkRuntimeState;
  detail: string;
  updatedAt: number;
};
const debridLinkKeyCooldownDetails = new Map<string, DebridLinkCooldownDetail>();
const debridLinkKeyRuntimeStatuses = new Map<string, DebridLinkRuntimeStatus>();
const DEBRID_LINK_KEY_COOLDOWN_MS = 120_000; // 2 min cooldown per failed key
const DEBRID_LINK_INVALID_KEY_COOLDOWN_MS = 60 * 60 * 1000;
const DEBRID_LINK_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

export function resetDebridLinkRuntimeStateForTests(): void {
  debridLinkKeyCooldowns.clear();
  debridLinkKeyCooldownDetails.clear();
  debridLinkKeyRuntimeStatuses.clear();
}

export function primeDebridLinkRuntimeCooldownForTests(keyId: string, cooldownMs: number, message = "Debrid-Link Key im Cooldown"): void {
  setDebridLinkKeyCooldownState(keyId, cooldownMs, message, "temporary");
}

function clearDebridLinkKeyCooldownState(keyId: string): void {
  debridLinkKeyCooldowns.delete(keyId);
  debridLinkKeyCooldownDetails.delete(keyId);
}

function setDebridLinkKeyRuntimeStatus(keyId: string, state: DebridLinkRuntimeState, detail: string): void {
  debridLinkKeyRuntimeStatuses.set(keyId, {
    state,
    detail: String(detail || "").trim(),
    updatedAt: Date.now()
  });
}

function getDebridLinkKeyRuntimeStatus(keyId: string): DebridLinkRuntimeStatus | null {
  return debridLinkKeyRuntimeStatuses.get(keyId) || null;
}

function mapDebridLinkCooldownCategoryToRuntimeState(category: DebridLinkCooldownCategory): DebridLinkRuntimeState {
  if (category === "invalid") {
    return "invalid";
  }
  if (category === "quota") {
    return "quota";
  }
  if (category === "rate_limit") {
    return "rate_limit";
  }
  return "cooldown";
}

function setDebridLinkKeyCooldownState(
  keyId: string,
  cooldownMs: number,
  message: string,
  category: DebridLinkCooldownCategory
): void {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    clearDebridLinkKeyCooldownState(keyId);
    return;
  }
  debridLinkKeyCooldowns.set(keyId, Date.now() + Math.max(1000, Math.floor(cooldownMs)));
  debridLinkKeyCooldownDetails.set(keyId, { message, category });
  setDebridLinkKeyRuntimeStatus(keyId, mapDebridLinkCooldownCategoryToRuntimeState(category), message);
}

function getDebridLinkKeyCooldownState(
  keyId: string,
  now = Date.now()
): { until: number; remainingMs: number; message: string; category: DebridLinkCooldownCategory } | null {
  const until = Number(debridLinkKeyCooldowns.get(keyId) || 0);
  if (!until) {
    return null;
  }
  if (until <= now) {
    clearDebridLinkKeyCooldownState(keyId);
    return null;
  }
  const detail = debridLinkKeyCooldownDetails.get(keyId);
  return {
    until,
    remainingMs: until - now,
    message: detail?.message || "Debrid-Link Key im Cooldown",
    category: detail?.category || "temporary"
  };
}

/** Per-account cooldown cache for Mega-Debrid: accountId → expiry timestamp. */
type MegaDebridCooldownCategory = "invalid" | "rate_limit" | "quota" | "temporary" | "skip";
type MegaDebridCooldownDetail = { until: number; message: string; category: MegaDebridCooldownCategory };
const megaDebridAccountCooldowns = new Map<string, MegaDebridCooldownDetail>();
const MEGA_DEBRID_ACCOUNT_COOLDOWN_MS = 120_000; // 2 min cooldown per failed account
const MEGA_DEBRID_INVALID_ACCOUNT_COOLDOWN_MS = 60 * 60 * 1000;

export function resetMegaDebridRuntimeStateForTests(): void {
  megaDebridAccountCooldowns.clear();
}

export function primeMegaDebridRuntimeCooldownForTests(accountId: string, cooldownMs: number, message = "Mega-Debrid Account im Cooldown"): void {
  setMegaDebridAccountCooldownState(accountId, cooldownMs, message, "temporary");
}

function clearMegaDebridAccountCooldownState(accountId: string): void {
  megaDebridAccountCooldowns.delete(accountId);
}

function setMegaDebridAccountCooldownState(
  accountId: string,
  cooldownMs: number,
  message: string,
  category: MegaDebridCooldownCategory
): void {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    clearMegaDebridAccountCooldownState(accountId);
    return;
  }
  megaDebridAccountCooldowns.set(accountId, {
    until: Date.now() + Math.max(1000, Math.floor(cooldownMs)),
    message,
    category
  });
}

export function getMegaDebridAccountCooldownState(
  accountId: string,
  now = Date.now()
): { until: number; remainingMs: number; message: string; category: MegaDebridCooldownCategory } | null {
  const detail = megaDebridAccountCooldowns.get(accountId);
  if (!detail) {
    return null;
  }
  if (detail.until <= now) {
    clearMegaDebridAccountCooldownState(accountId);
    return null;
  }
  return {
    until: detail.until,
    remainingMs: detail.until - now,
    message: detail.message,
    category: detail.category
  };
}

const LINKSNAPPY_API_BASE = "https://linksnappy.com/api";

const PROVIDER_LABELS: Record<DebridProvider, string> = {
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

function extractHosterFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return "";
  }
}

interface ProviderUnrestrictedLink extends UnrestrictedLink {
  provider: DebridProvider;
  providerLabel: string;
}

export type MegaWebUnrestrictor = (link: string, signal?: AbortSignal) => Promise<UnrestrictedLink | null>;
export type AllDebridWebUnrestrictor = (link: string, signal?: AbortSignal) => Promise<UnrestrictedLink | null>;
export type RealDebridWebUnrestrictor = (link: string, signal?: AbortSignal) => Promise<UnrestrictedLink | null>;
export type BestDebridWebUnrestrictor = (link: string, signal?: AbortSignal) => Promise<UnrestrictedLink | null>;

interface DebridServiceOptions {
  megaWebUnrestrict?: MegaWebUnrestrictor;
  allDebridWebUnrestrict?: AllDebridWebUnrestrictor;
  realDebridWebUnrestrict?: RealDebridWebUnrestrictor;
  bestDebridWebUnrestrict?: BestDebridWebUnrestrictor;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    bandwidthSchedules: (settings.bandwidthSchedules || []).map((entry) => ({ ...entry })),
    debridLinkDisabledKeyIds: [...(settings.debridLinkDisabledKeyIds || [])],
    providerDailyLimitBytes: { ...(settings.providerDailyLimitBytes || {}) },
    providerDailyUsageBytes: { ...(settings.providerDailyUsageBytes || {}) },
    providerTotalUsageBytes: { ...(settings.providerTotalUsageBytes || {}) },
    debridLinkApiKeyDailyLimitBytes: { ...(settings.debridLinkApiKeyDailyLimitBytes || {}) },
    debridLinkApiKeyDailyUsageBytes: { ...(settings.debridLinkApiKeyDailyUsageBytes || {}) },
    debridLinkApiKeyTotalUsageBytes: { ...(settings.debridLinkApiKeyTotalUsageBytes || {}) },
    megaDebridDisabledAccountIds: [...(settings.megaDebridDisabledAccountIds || [])],
    megaDebridAccountDailyLimitBytes: { ...(settings.megaDebridAccountDailyLimitBytes || {}) },
    megaDebridAccountDailyUsageBytes: { ...(settings.megaDebridAccountDailyUsageBytes || {}) },
    megaDebridAccountTotalUsageBytes: { ...(settings.megaDebridAccountTotalUsageBytes || {}) }
  };
}

export function isDebridLinkApiKeyDisabled(settings: AppSettings, keyId: string): boolean {
  return (settings.debridLinkDisabledKeyIds || []).includes(keyId);
}

export function getAvailableDebridLinkApiKeys(settings: AppSettings, epochMs = Date.now()) {
  return parseDebridLinkApiKeys(settings.debridLinkApiKeys).filter(
    (entry) => !isDebridLinkApiKeyDisabled(settings, entry.id) && !isDebridLinkApiKeyDailyLimitReached(settings, entry.id, epochMs)
  );
}

/** Returns Mega-Debrid accounts that are not disabled and not daily-limited. */
export function getAvailableMegaDebridAccounts(settings: AppSettings, epochMs = Date.now()): MegaDebridAccountEntry[] {
  return getMegaDebridAccountList(settings).filter(
    (entry) => !isMegaDebridAccountDisabled(settings, entry.id) && !isMegaDebridAccountDailyLimitReached(settings, entry.id, epochMs)
  );
}

/** Resolves the full list of Mega-Debrid accounts from settings (multi-account or legacy single). */
function getMegaDebridAccountList(settings: AppSettings): MegaDebridAccountEntry[] {
  // Multi-account format: newline-separated "login:password" pairs in megaCredentials
  const multiAccounts = parseMegaDebridAccounts(settings.megaCredentials || "");
  if (multiAccounts.length > 0) {
    return multiAccounts;
  }
  // Backward compat: single legacy megaLogin/megaPassword
  if (settings.megaLogin?.trim() && settings.megaPassword?.trim()) {
    return parseMegaDebridAccounts(settings.megaLogin.trim(), settings.megaPassword.trim());
  }
  return [];
}

function hasMegaDebridCredentials(settings: AppSettings): boolean {
  return getMegaDebridAccountList(settings).length > 0;
}

function isMegaDebridModeEnabled(settings: AppSettings, mode: "api" | "web"): boolean {
  if (mode === "api") {
    return settings.megaDebridApiEnabled
      || (hasMegaDebridCredentials(settings) && !settings.megaDebridApiEnabled && !settings.megaDebridWebEnabled && settings.megaDebridPreferApi);
  }
  return settings.megaDebridWebEnabled
    || (hasMegaDebridCredentials(settings) && !settings.megaDebridApiEnabled && !settings.megaDebridWebEnabled && !settings.megaDebridPreferApi);
}

function resolveMegaDebridProvider(settings: AppSettings, provider: DebridProvider): DebridProvider {
  if (provider !== "megadebrid") {
    return provider;
  }
  if (isMegaDebridModeEnabled(settings, "api") && !isMegaDebridModeEnabled(settings, "web")) {
    return "megadebrid-api";
  }
  if (isMegaDebridModeEnabled(settings, "web") && !isMegaDebridModeEnabled(settings, "api")) {
    return "megadebrid-web";
  }
  return settings.megaDebridPreferApi ? "megadebrid-api" : "megadebrid-web";
}

type BestDebridRequest = {
  url: string;
  useAuthHeader: boolean;
};

function canonicalLink(link: string): string {
  try {
    const parsed = new URL(link);
    return `${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return link.trim().toLowerCase();
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(attempt: number): number {
  return Math.min(5000, 400 * 2 ** attempt);
}

function parseRetryAfterMs(value: string | null): number {
  const text = String(value || "").trim();
  if (!text) {
    return 0;
  }

  // Cap at 1 hour — floodDetected can mandate "retry after 1 hour"
  const maxRetryMs = 60 * 60 * 1000;
  const asSeconds = Number(text);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(maxRetryMs, Math.floor(asSeconds * 1000));
  }

  const asDate = Date.parse(text);
  if (Number.isFinite(asDate)) {
    return Math.min(maxRetryMs, Math.max(0, asDate - Date.now()));
  }

  return 0;
}

function retryDelayForResponse(response: Response, attempt: number): number {
  if (response.status !== 429) {
    return retryDelay(attempt);
  }
  const fromHeader = parseRetryAfterMs(response.headers.get("retry-after"));
  return fromHeader > 0 ? fromHeader : retryDelay(attempt);
}

function readHttpStatusFromErrorText(text: string): number {
  const match = String(text || "").match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : 0;
}

function isRetryableErrorText(text: string): boolean {
  const status = readHttpStatusFromErrorText(text);
  if (status === 429 || status >= 500) {
    return true;
  }
  const lower = String(text || "").toLowerCase();
  return lower.includes("timeout")
    || lower.includes("network")
    || lower.includes("fetch failed")
    || lower.includes("aborted")
    || lower.includes("econnreset")
    || lower.includes("enotfound")
    || lower.includes("etimedout")
    || lower.includes("html statt json");
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw new Error("aborted:debrid");
  }
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));

    const onAbort = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted:debrid"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function pickString(payload: Record<string, unknown> | null, keys: string[]): string {
  if (!payload) {
    return "";
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function pickNumber(payload: Record<string, unknown> | null, keys: string[]): number | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    const value = Number(payload[key] ?? NaN);
    if (Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return null;
}

function parseError(status: number, responseText: string, payload: Record<string, unknown> | null): string {
  const fromPayload = pickString(payload, ["response_text", "error", "message", "detail", "error_description"]);
  if (fromPayload) {
    return fromPayload;
  }
  const compact = compactErrorText(responseText);
  if (compact && compact !== "Unbekannter Fehler") {
    return compact;
  }
  return `HTTP ${status}`;
}

function parseAllDebridError(payload: Record<string, unknown> | null): string {
  const errorValue = payload?.error;
  if (typeof errorValue === "string" && errorValue.trim()) {
    return errorValue.trim();
  }
  const errorObj = asRecord(errorValue);
  return pickString(errorObj, ["message", "code"]) || "AllDebrid API error";
}

function normalizeAllDebridHostKey(value: string): string {
  return String(value || "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function toAllDebridHostState(value: unknown): AllDebridHostInfo["state"] {
  if (value === true) {
    return "up";
  }
  if (value === false) {
    return "down";
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "up" || normalized === "online" || normalized === "available") {
    return "up";
  }
  if (normalized === "down" || normalized === "offline" || normalized === "unavailable") {
    return "down";
  }
  if (normalized === "not_tracked" || normalized === "not tracked") {
    return "not_tracked";
  }
  return "unknown";
}

function toAllDebridHostStatusLabel(state: AllDebridHostInfo["state"]): string {
  if (state === "up") {
    return "Verfügbar";
  }
  if (state === "down") {
    return "Unverfügbar";
  }
  if (state === "not_tracked") {
    return "Nicht getrackt";
  }
  return "Unbekannt";
}

function normalizeDebridLinkHostKey(value: string): string {
  return String(value || "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function parseDebridLinkSuccess(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }
  if (typeof payload.success === "boolean") {
    return payload.success;
  }
  return pickString(payload, ["result"]).toUpperCase() === "OK";
}

function parseDebridLinkHosters(payload: Record<string, unknown> | null): Record<string, unknown>[] {
  const value = asRecord(payload?.value);
  const hosters = value?.hosters ?? payload?.hosters;
  if (Array.isArray(hosters)) {
    return hosters.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry))).map((entry) => entry as Record<string, unknown>);
  }
  return [];
}

function findDebridLinkHostEntry(payload: Record<string, unknown> | null, host: string): Record<string, unknown> | null {
  const wanted = normalizeDebridLinkHostKey(host);
  for (const entry of parseDebridLinkHosters(payload)) {
    const name = normalizeDebridLinkHostKey(pickString(entry, ["name", "host"]));
    if (name === wanted) {
      return entry;
    }
  }
  return null;
}

function parseDebridLinkErrorCode(payload: Record<string, unknown> | null): string {
  return pickString(payload, ["error", "ERR"]);
}

function parseDebridLinkErrorDescription(payload: Record<string, unknown> | null): string {
  return pickString(payload, ["error_description", "message", "detail", "response_text", "error", "ERR"]);
}

function looksLikeHtmlResponse(contentType: string, body: string): boolean {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml+xml")) {
    return true;
  }
  return /^\s*<(!doctype\s+html|html\b)/i.test(String(body || ""));
}

function parsePositiveNumber(value: unknown): number | null {
  const numeric = Number(value ?? NaN);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function parseDebridLinkNextResetMs(payload: Record<string, unknown> | null): number {
  const value = asRecord(payload?.value);
  const nextReset = value?.nextResetSeconds;
  const nextResetRecord = asRecord(nextReset);
  const seconds = parsePositiveNumber(nextReset)
    ?? parsePositiveNumber(nextResetRecord?.current)
    ?? parsePositiveNumber(nextResetRecord?.value);
  if (!seconds) {
    return 0;
  }
  return Math.min(24 * 60 * 60 * 1000, seconds * 1000);
}

function parseDebridLinkLinkEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }
  const entry = asRecord(value);
  return entry ? [entry] : [];
}

class DebridLinkApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryAfterMs: number;
  public readonly payload: Record<string, unknown> | null;

  public constructor(
    status: number,
    code: string,
    description: string,
    retryAfterMs: number,
    payload: Record<string, unknown> | null
  ) {
    super(description || code || `HTTP ${status || 0}`);
    this.name = "DebridLinkApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.payload = payload;
  }
}

function toDebridLinkKeyStateLabel(state: DebridLinkHostLimitInfo["state"]): string {
  if (state === "ready") {
    return "Bereit";
  }
  if (state === "cooldown") {
    return "Cooldown";
  }
  if (state === "invalid") {
    return "Ungueltig";
  }
  if (state === "quota") {
    return "Quota";
  }
  if (state === "rate_limit") {
    return "Rate-Limit";
  }
  if (state === "error") {
    return "Fehler";
  }
  return "Unbekannt";
}

function toDebridLinkHostStateLabel(state: DebridLinkHostLimitInfo["hostState"]): string {
  if (state === "up") {
    return "Online";
  }
  if (state === "down") {
    return "Offline";
  }
  return "Unbekannt";
}

function shouldRetryDebridLinkApiError(error: DebridLinkApiError, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) {
    return false;
  }
  if (error.status === 429 || error.status >= 500) {
    return true;
  }
  return DEBRID_LINK_RETRYABLE_ERRORS.has(error.code);
}

function retryDelayForDebridLinkApiError(error: DebridLinkApiError, attempt: number): number {
  if (error.retryAfterMs > 0) {
    return error.retryAfterMs;
  }
  return retryDelay(attempt);
}

async function requestDebridLinkPayloadWithKey(
  apiKey: { token: string },
  method: "GET" | "POST" | "DELETE",
  apiPath: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  maxAttempts = REQUEST_RETRIES
): Promise<Record<string, unknown>> {
  let lastTransportError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey.token}`,
        "User-Agent": DEBRID_USER_AGENT
      };
      let payloadBody: string | undefined;
      if (method !== "GET" && method !== "DELETE" && body) {
        headers["Content-Type"] = "application/json";
        payloadBody = JSON.stringify(body);
      }

      const response = await fetch(`${DEBRID_LINK_API_BASE}${apiPath}`, {
        method,
        headers,
        body: payloadBody,
        signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
      });
      const responseText = await response.text();
      const payload = parseJsonSafe(responseText);
      if (!payload) {
        const description = looksLikeHtmlResponse(response.headers.get("content-type") || "", responseText)
          ? `Debrid-Link lieferte HTML statt JSON (HTTP ${response.status})`
          : compactErrorText(responseText) || `Debrid-Link lieferte kein JSON (HTTP ${response.status})`;
        const error = new DebridLinkApiError(
          response.status,
          "requestError",
          description,
          parseRetryAfterMs(response.headers.get("retry-after")),
          null
        );
        if (shouldRetryDebridLinkApiError(error, attempt, maxAttempts)) {
          await sleepWithSignal(retryDelayForDebridLinkApiError(error, attempt), signal);
          continue;
        }
        throw error;
      }

      if (!response.ok || !parseDebridLinkSuccess(payload)) {
        const error = new DebridLinkApiError(
          response.status,
          parseDebridLinkErrorCode(payload) || `HTTP ${response.status}`,
          parseDebridLinkErrorDescription(payload) || `HTTP ${response.status}`,
          parseRetryAfterMs(response.headers.get("retry-after")),
          payload
        );
        if (shouldRetryDebridLinkApiError(error, attempt, maxAttempts)) {
          await sleepWithSignal(retryDelayForDebridLinkApiError(error, attempt), signal);
          continue;
        }
        throw error;
      }

      return payload;
    } catch (error) {
      if (error instanceof DebridLinkApiError) {
        throw error;
      }
      lastTransportError = compactErrorText(error);
      if (signal?.aborted || (/aborted/i.test(lastTransportError) && !/timeout/i.test(lastTransportError))) {
        throw error;
      }
      if (attempt >= maxAttempts || !isRetryableErrorText(lastTransportError)) {
        throw new Error(lastTransportError || "Debrid-Link Request fehlgeschlagen");
      }
      await sleepWithSignal(retryDelay(attempt), signal);
    }
  }
  throw new Error(lastTransportError || "Debrid-Link Request fehlgeschlagen");
}

async function fetchDebridLinkPublicHostInfo(
  host: string,
  signal?: AbortSignal
): Promise<Pick<DebridLinkHostLimitInfo, "hostState" | "hostStateLabel" | "hostNote">> {
  const hostLabel = host.trim() || "rapidgator";
  try {
    const response = await fetch(`${DEBRID_LINK_API_BASE}/downloader/hosts?keys=name,status,domains`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": DEBRID_USER_AGENT
      },
      signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
    });
    const responseText = await response.text();
    const payload = parseJsonSafe(responseText);
    if (!response.ok || !payload || !parseDebridLinkSuccess(payload)) {
      throw new Error(parseError(response.status, responseText, payload));
    }
    const entries = Array.isArray(payload.value)
      ? payload.value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
      : [];
    const wanted = normalizeDebridLinkHostKey(hostLabel);
    const hostEntry = entries.find((entry) => {
      const name = normalizeDebridLinkHostKey(pickString(entry, ["name"]));
      if (name === wanted) {
        return true;
      }
      const domains = Array.isArray(entry.domains) ? entry.domains.map((value) => normalizeDebridLinkHostKey(String(value || ""))) : [];
      return domains.some((domain) => domain === wanted);
    });
    if (!hostEntry) {
      return {
        hostState: "unknown",
        hostStateLabel: toDebridLinkHostStateLabel("unknown"),
        hostNote: `${hostLabel} nicht in /downloader/hosts gefunden.`
      };
    }
    const statusValue = Number(hostEntry.status ?? NaN);
    const hostState: DebridLinkHostLimitInfo["hostState"] = Number.isFinite(statusValue)
      ? (statusValue >= 1 ? "up" : "down")
      : "unknown";
    return {
      hostState,
      hostStateLabel: toDebridLinkHostStateLabel(hostState),
      hostNote: hostState === "down"
        ? `${hostLabel} ist laut Debrid-Link /downloader/hosts aktuell offline.`
        : `${hostLabel} ist laut Debrid-Link /downloader/hosts erreichbar.`
    };
  } catch (error) {
    return {
      hostState: "unknown",
      hostStateLabel: toDebridLinkHostStateLabel("unknown"),
      hostNote: `Hoststatus konnte nicht geladen werden: ${compactErrorText(error)}`
    };
  }
}

async function fetchDebridLinkHostLimitForKey(apiKey: { id: string; label: string; token: string }, host: string, signal?: AbortSignal): Promise<DebridLinkHostLimitInfo> {
  let lastError = "";
  const hostLabel = host.trim() || "rapidgator";
  const endpoints = [`${DEBRID_LINK_API_BASE}/downloader/limits/all`, `${DEBRID_LINK_API_BASE}/downloader/limits`];

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey.token}`,
            "User-Agent": DEBRID_USER_AGENT
          },
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });
        const text = await response.text();
        const payload = parseJsonSafe(text);

        if (response.status === 404 && endpoint.endsWith("/all")) {
          break;
        }

        if (!response.ok) {
          const reason = parseError(response.status, text, payload);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
            continue;
          }
          throw new Error(reason);
        }

        if (!payload) {
          throw new Error("Debrid-Link Limits Antwort ist kein JSON-Objekt");
        }
        if (!parseDebridLinkSuccess(payload)) {
          throw new Error(pickString(payload, ["error_description", "error", "message"]) || "Debrid-Link Limits fehlgeschlagen");
        }

        const hostEntry = findDebridLinkHostEntry(payload, hostLabel);
        if (!hostEntry) {
          if (endpoint.endsWith("/all")) {
            break;
          }
          return {
            keyId: apiKey.id,
            keyLabel: apiKey.label,
            host: hostLabel,
            fetchedAt: Date.now(),
            trafficCurrentBytes: null,
            trafficMaxBytes: null,
            linksCurrent: null,
            linksMax: null,
            note: `${hostLabel} nicht in der Debrid-Link-Limits-Antwort vorhanden.`,
            state: "unknown",
            stateLabel: toDebridLinkKeyStateLabel("unknown"),
            stateDetail: "",
            cooldownUntil: null,
            cooldownRemainingMs: 0,
            lastCheckedAt: Date.now(),
            hostState: "unknown",
            hostStateLabel: toDebridLinkHostStateLabel("unknown"),
            hostNote: ""
          };
        }

        const daySize = asRecord(hostEntry.daySize);
        const dayCount = asRecord(hostEntry.dayCount);
        return {
          keyId: apiKey.id,
          keyLabel: apiKey.label,
          host: pickString(hostEntry, ["name", "host"]) || hostLabel,
          fetchedAt: Date.now(),
          trafficCurrentBytes: pickNumber(daySize, ["current"]),
          trafficMaxBytes: pickNumber(daySize, ["value", "max"]),
          linksCurrent: pickNumber(dayCount, ["current"]),
          linksMax: pickNumber(dayCount, ["value", "max"]),
          note: "",
          state: "ready",
          stateLabel: toDebridLinkKeyStateLabel("ready"),
          stateDetail: "API erreichbar",
          cooldownUntil: null,
          cooldownRemainingMs: 0,
          lastCheckedAt: Date.now(),
          hostState: "unknown",
          hostStateLabel: toDebridLinkHostStateLabel("unknown"),
          hostNote: ""
        };
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          break;
        }
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleepWithSignal(retryDelay(attempt), signal);
      }
    }
  }

  throw new Error(String(lastError || `Debrid-Link Limits für ${apiKey.label} fehlgeschlagen`).replace(/^Error:\s*/i, ""));
}

async function fetchDebridLinkHostLimitForKeyDetailed(
  apiKey: { id: string; label: string; token: string },
  host: string,
  publicHostInfo: Pick<DebridLinkHostLimitInfo, "hostState" | "hostStateLabel" | "hostNote">,
  signal?: AbortSignal
): Promise<DebridLinkHostLimitInfo> {
  const hostLabel = host.trim() || "rapidgator";
  const runtimeStatus = getDebridLinkKeyRuntimeStatus(apiKey.id);
  const buildInfo = (overrides: Partial<DebridLinkHostLimitInfo>): DebridLinkHostLimitInfo => ({
    keyId: apiKey.id,
    keyLabel: apiKey.label,
    host: hostLabel,
    fetchedAt: Date.now(),
    trafficCurrentBytes: null,
    trafficMaxBytes: null,
    linksCurrent: null,
    linksMax: null,
    note: "",
    state: runtimeStatus?.state || "unknown",
    stateLabel: toDebridLinkKeyStateLabel(runtimeStatus?.state || "unknown"),
    stateDetail: runtimeStatus?.detail || "",
    cooldownUntil: null,
    cooldownRemainingMs: 0,
    lastCheckedAt: runtimeStatus?.updatedAt || null,
    hostState: publicHostInfo.hostState,
    hostStateLabel: publicHostInfo.hostStateLabel,
    hostNote: publicHostInfo.hostNote,
    ...overrides
  });

  const cooldownState = getDebridLinkKeyCooldownState(apiKey.id);
  if (cooldownState) {
    const state = mapDebridLinkCooldownCategoryToRuntimeState(cooldownState.category);
    return buildInfo({
      state,
      stateLabel: toDebridLinkKeyStateLabel(state),
      stateDetail: cooldownState.message,
      cooldownUntil: cooldownState.until,
      cooldownRemainingMs: cooldownState.remainingMs,
      lastCheckedAt: runtimeStatus?.updatedAt || Date.now(),
      note: cooldownState.message
    });
  }

  for (const apiPath of ["/downloader/limits/all", "/downloader/limits"]) {
    try {
      const payload = await requestDebridLinkPayloadWithKey(apiKey, "GET", apiPath, undefined, signal);
      const hostEntry = findDebridLinkHostEntry(payload, hostLabel);
      if (!hostEntry) {
        if (apiPath.endsWith("/all")) {
          continue;
        }
        clearDebridLinkKeyCooldownState(apiKey.id);
        setDebridLinkKeyRuntimeStatus(apiKey.id, "ready", "API erreichbar");
        return buildInfo({
          state: "ready",
          stateLabel: toDebridLinkKeyStateLabel("ready"),
          stateDetail: "API erreichbar",
          lastCheckedAt: Date.now(),
          note: `${hostLabel} nicht in der Debrid-Link-Limits-Antwort vorhanden.`
        });
      }

      const daySize = asRecord(hostEntry.daySize);
      const dayCount = asRecord(hostEntry.dayCount);
      clearDebridLinkKeyCooldownState(apiKey.id);
      setDebridLinkKeyRuntimeStatus(apiKey.id, "ready", "API erreichbar");
      return buildInfo({
        host: pickString(hostEntry, ["name", "host"]) || hostLabel,
        trafficCurrentBytes: pickNumber(daySize, ["current"]),
        trafficMaxBytes: pickNumber(daySize, ["value", "max"]),
        linksCurrent: pickNumber(dayCount, ["current"]),
        linksMax: pickNumber(dayCount, ["value", "max"]),
        state: "ready",
        stateLabel: toDebridLinkKeyStateLabel("ready"),
        stateDetail: "API erreichbar",
        lastCheckedAt: Date.now(),
        note: ""
      });
    } catch (error) {
      if (error instanceof DebridLinkApiError && error.status === 404 && apiPath.endsWith("/all")) {
        continue;
      }

      const checkedAt = Date.now();
      if (error instanceof DebridLinkApiError) {
        const code = String(error.code || "").trim() || `HTTP ${error.status}`;
        const description = error.message || code;

        if (DEBRID_LINK_INVALID_TOKEN_ERRORS.has(code)) {
          const detail = `API-Key ungueltig oder deaktiviert (${code}: ${description})`;
          setDebridLinkKeyCooldownState(apiKey.id, DEBRID_LINK_INVALID_KEY_COOLDOWN_MS, detail, "invalid");
          const nextCooldown = getDebridLinkKeyCooldownState(apiKey.id, checkedAt);
          return buildInfo({
            state: "invalid",
            stateLabel: toDebridLinkKeyStateLabel("invalid"),
            stateDetail: detail,
            cooldownUntil: nextCooldown?.until || null,
            cooldownRemainingMs: nextCooldown?.remainingMs || 0,
            lastCheckedAt: checkedAt,
            note: detail
          });
        }

        if (DEBRID_LINK_RATE_LIMIT_ERRORS.has(code) || error.status === 429) {
          const detail = `API-Rate-Limit erreicht (${code}: ${description})`;
          setDebridLinkKeyCooldownState(apiKey.id, error.retryAfterMs || DEBRID_LINK_RATE_LIMIT_COOLDOWN_MS, detail, "rate_limit");
          const nextCooldown = getDebridLinkKeyCooldownState(apiKey.id, checkedAt);
          return buildInfo({
            state: "rate_limit",
            stateLabel: toDebridLinkKeyStateLabel("rate_limit"),
            stateDetail: detail,
            cooldownUntil: nextCooldown?.until || null,
            cooldownRemainingMs: nextCooldown?.remainingMs || 0,
            lastCheckedAt: checkedAt,
            note: detail
          });
        }

        if (DEBRID_LINK_QUOTA_ERRORS.has(code)) {
          const detail = `Quota erreicht (${code}: ${description})`;
          setDebridLinkKeyCooldownState(apiKey.id, parseDebridLinkNextResetMs(error.payload) || DEBRID_LINK_KEY_COOLDOWN_MS, detail, "quota");
          const nextCooldown = getDebridLinkKeyCooldownState(apiKey.id, checkedAt);
          return buildInfo({
            state: "quota",
            stateLabel: toDebridLinkKeyStateLabel("quota"),
            stateDetail: detail,
            cooldownUntil: nextCooldown?.until || null,
            cooldownRemainingMs: nextCooldown?.remainingMs || 0,
            lastCheckedAt: checkedAt,
            note: detail
          });
        }

        const detail = `${code}: ${description}`;
        setDebridLinkKeyRuntimeStatus(apiKey.id, "error", detail);
        return buildInfo({
          state: "error",
          stateLabel: toDebridLinkKeyStateLabel("error"),
          stateDetail: detail,
          lastCheckedAt: checkedAt,
          note: detail
        });
      }

      const detail = compactErrorText(error).replace(/^Error:\s*/i, "") || `Debrid-Link Limits fuer ${apiKey.label} fehlgeschlagen`;
      setDebridLinkKeyRuntimeStatus(apiKey.id, "error", detail);
      return buildInfo({
        state: "error",
        stateLabel: toDebridLinkKeyStateLabel("error"),
        stateDetail: detail,
        lastCheckedAt: checkedAt,
        note: detail
      });
    }
  }

  return buildInfo({
    state: "unknown",
    stateLabel: toDebridLinkKeyStateLabel("unknown"),
    stateDetail: `Keine Limits fuer ${apiKey.label} gefunden`,
    lastCheckedAt: Date.now(),
    note: `Keine Limits fuer ${apiKey.label} gefunden`
  });
}

function uniqueProviderOrder(order: readonly DebridProvider[]): DebridProvider[] {
  const seen = new Set<DebridProvider>();
  const result: DebridProvider[] = [];
  for (const provider of order) {
    if (seen.has(provider)) {
      continue;
    }
    seen.add(provider);
    result.push(provider);
  }
  return result;
}

function toProviderOrder(primary: DebridProvider, secondary: DebridFallbackProvider, tertiary: DebridFallbackProvider): DebridProvider[] {
  const order: DebridProvider[] = [primary];
  if (secondary !== "none") {
    order.push(secondary);
  }
  if (tertiary !== "none") {
    order.push(tertiary);
  }
  return uniqueProviderOrder(order);
}

function isRapidgatorLink(link: string): boolean {
  try {
    const hostname = new URL(link).hostname.toLowerCase();
    return hostname === "rapidgator.net"
      || hostname.endsWith(".rapidgator.net")
      || hostname === "rg.to"
      || hostname.endsWith(".rg.to")
      || hostname === "rapidgator.asia"
      || hostname.endsWith(".rapidgator.asia");
  } catch {
    return false;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeFileName(value: string): boolean {
  return /\.(?:part\d+\.rar|r\d{2}|rar|zip|7z|tar|gz|bz2|xz|iso|mkv|mp4|avi|mov|wmv|m4v|m2ts|ts|webm|mp3|flac|aac|srt|ass|sub)$/i.test(value);
}

export function normalizeResolvedFilename(value: string): string {
  const candidate = decodeHtmlEntities(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/^download\s+file\s+/i, "")
    .replace(/\s*[-|]\s*rapidgator.*$/i, "")
    .trim();
  if (!candidate || candidate.length > 260 || !looksLikeFileName(candidate) || looksLikeOpaqueFilename(candidate)) {
    return "";
  }
  return candidate;
}

export function filenameFromRapidgatorUrlPath(link: string): string {
  try {
    const parsed = new URL(link);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    for (let index = pathParts.length - 1; index >= 0; index -= 1) {
      const raw = safeDecode(pathParts[index]).replace(/\.html?$/i, "").trim();
      const normalized = normalizeResolvedFilename(raw);
      if (normalized) {
        return normalized;
      }
    }
    return "";
  } catch {
    return "";
  }
}

export function extractRapidgatorFilenameFromHtml(html: string): string {
  const patterns = [
    /<meta[^>]+(?:property=["']og:title["'][^>]+content=["']([^"']+)["']|content=["']([^"']+)["'][^>]+property=["']og:title["'])/i,
    /<meta[^>]+(?:name=["']title["'][^>]+content=["']([^"']+)["']|content=["']([^"']+)["'][^>]+name=["']title["'])/i,
    /<title>([^<]{1,260})<\/title>/i,
    /(?:Dateiname|File\s*name)\s*[:\-]\s*<[^>]*>\s*([^<]{1,260})\s*</i,
    /(?:Dateiname|File\s*name)\s*[:\-]\s*([^<\r\n]{1,260})/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    // Some patterns have multiple capture groups for attribute-order independence;
    // pick the first non-empty group.
    const raw = match?.[1] || match?.[2] || "";
    const normalized = normalizeResolvedFilename(raw);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const size = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  let firstError: unknown = null;
  const next = (): T | undefined => {
    if (firstError || index >= items.length) {
      return undefined;
    }
    const item = items[index];
    index += 1;
    return item;
  };
  const runners = Array.from({ length: size }, async () => {
    let current = next();
    while (current !== undefined) {
      try {
        await worker(current);
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
      }
      current = next();
    }
  });
  await Promise.all(runners);
  if (firstError) {
    throw firstError;
  }
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (!signal) {
    return AbortSignal.timeout(timeoutMs);
  }
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function readResponseTextLimited(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let readBytes = 0;

  try {
    while (readBytes < maxBytes) {
      if (signal?.aborted) {
        throw new Error("aborted:debrid");
      }

      const { done, value } = await reader.read();
      if (done || !value || value.byteLength === 0) {
        break;
      }

      const remaining = maxBytes - readBytes;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(Buffer.from(slice));
      readBytes += slice.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function resolveRapidgatorFilename(link: string, signal?: AbortSignal): Promise<string> {
  if (!isRapidgatorLink(link)) {
    return "";
  }
  const fromUrl = filenameFromRapidgatorUrlPath(link);
  if (fromUrl) {
    return fromUrl;
  }

  if (signal?.aborted) {
    throw new Error("aborted:debrid");
  }

  for (let attempt = 1; attempt <= REQUEST_RETRIES + 2; attempt += 1) {
    try {
      const response = await fetch(link, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,de;q=0.8"
        },
        signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* drain socket */ }
        if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES + 2) {
          await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
          continue;
        }
        return "";
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const contentLength = Number(response.headers.get("content-length") || NaN);
      if (contentType
        && !contentType.includes("text/html")
        && !contentType.includes("application/xhtml")
        && !contentType.includes("text/plain")
        && !contentType.includes("text/xml")
        && !contentType.includes("application/xml")) {
        try { await response.body?.cancel(); } catch { /* drain socket */ }
        return "";
      }
      if (!contentType && Number.isFinite(contentLength) && contentLength > RAPIDGATOR_SCAN_MAX_BYTES) {
        try { await response.body?.cancel(); } catch { /* drain socket */ }
        return "";
      }

      const html = await readResponseTextLimited(response, RAPIDGATOR_SCAN_MAX_BYTES, signal);
      const fromHtml = extractRapidgatorFilenameFromHtml(html);
      if (fromHtml) {
        return fromHtml;
      }
      return "";
    } catch (error) {
      const errorText = compactErrorText(error);
      if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
        throw error;
      }
      if (attempt >= REQUEST_RETRIES + 2 || !isRetryableErrorText(errorText)) {
        return "";
      }
    }

    if (attempt < REQUEST_RETRIES + 2) {
      await sleepWithSignal(retryDelay(attempt), signal);
    }
  }

  return "";
}

export interface RapidgatorCheckResult {
  online: boolean;
  fileName: string;
  fileSize: string | null;
}

const RG_FILE_ID_RE = /\/file\/([a-z0-9]{32}|\d+)/i;
const RG_FILE_NOT_FOUND_RE = />\s*404\s*File not found/i;
const RG_FILESIZE_RE = /File\s*size:\s*<strong>([^<>"]+)<\/strong>/i;

export async function checkRapidgatorOnline(
  link: string,
  signal?: AbortSignal
): Promise<RapidgatorCheckResult | null> {
  if (!isRapidgatorLink(link)) {
    return null;
  }

  const fileIdMatch = link.match(RG_FILE_ID_RE);
  if (!fileIdMatch) {
    return null;
  }
  const fileId = fileIdMatch[1];
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,de;q=0.8"
  };

  // Fast path: HEAD request (no body download, much faster)
  for (let attempt = 1; attempt <= REQUEST_RETRIES + 1; attempt += 1) {
    try {
      if (signal?.aborted) throw new Error("aborted:debrid");

      const response = await fetch(link, {
        method: "HEAD",
        redirect: "follow",
        headers,
        signal: withTimeoutSignal(signal, 15000)
      });

      if (response.status === 404) {
        return { online: false, fileName: "", fileSize: null };
      }

      if (response.ok) {
        const finalUrl = response.url || link;
        if (!finalUrl.includes(fileId)) {
          return { online: false, fileName: "", fileSize: null };
        }
        // HEAD 200 + URL still contains file ID → online
        const fileName = filenameFromRapidgatorUrlPath(link);
        return { online: true, fileName, fileSize: null };
      }

      // Non-OK, non-404: retry or give up
      if (shouldRetryStatus(response.status) && attempt <= REQUEST_RETRIES) {
        await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
        continue;
      }

      // HEAD inconclusive — fall through to GET
      break;
    } catch (error) {
      const errorText = compactErrorText(error);
      if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) throw error;
      if (attempt > REQUEST_RETRIES || !isRetryableErrorText(errorText)) {
        break; // fall through to GET
      }
      await sleepWithSignal(retryDelay(attempt), signal);
    }
  }

  // Slow path: GET request (downloads HTML, more thorough)
  for (let attempt = 1; attempt <= REQUEST_RETRIES + 1; attempt += 1) {
    try {
      if (signal?.aborted) throw new Error("aborted:debrid");

      const response = await fetch(link, {
        method: "GET",
        redirect: "follow",
        headers,
        signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
      });

      if (response.status === 404) {
        try { await response.body?.cancel(); } catch { /* drain socket */ }
        return { online: false, fileName: "", fileSize: null };
      }

      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* drain socket */ }
        if (shouldRetryStatus(response.status) && attempt <= REQUEST_RETRIES) {
          await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
          continue;
        }
        return null;
      }

      const finalUrl = response.url || link;
      if (!finalUrl.includes(fileId)) {
        try { await response.body?.cancel(); } catch { /* drain socket */ }
        return { online: false, fileName: "", fileSize: null };
      }

      const html = await readResponseTextLimited(response, RAPIDGATOR_SCAN_MAX_BYTES, signal);

      if (RG_FILE_NOT_FOUND_RE.test(html)) {
        return { online: false, fileName: "", fileSize: null };
      }

      const fileName = extractRapidgatorFilenameFromHtml(html) || filenameFromRapidgatorUrlPath(link);
      const sizeMatch = html.match(RG_FILESIZE_RE);
      const fileSize = sizeMatch ? sizeMatch[1].trim() : null;

      return { online: true, fileName, fileSize };
    } catch (error) {
      const errorText = compactErrorText(error);
      if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) throw error;
      if (attempt > REQUEST_RETRIES || !isRetryableErrorText(errorText)) {
        return null;
      }
    }

    if (attempt <= REQUEST_RETRIES) {
      await sleepWithSignal(retryDelay(attempt), signal);
    }
  }

  return null;
}

function buildBestDebridRequests(link: string, token: string): BestDebridRequest[] {
  const linkParam = encodeURIComponent(link);
  const safeToken = String(token || "").trim();
  const useAuthHeader = Boolean(safeToken);
  return [
    {
      url: `${BEST_DEBRID_API_BASE}/generateLink?link=${linkParam}`,
      useAuthHeader
    }
  ];
}

class MegaDebridClient {
  private megaWebUnrestrict?: MegaWebUnrestrictor;

  private login: string;

  private password: string;

  private mode: "api" | "web";

  private allowApiFallback: boolean;

  /** Per-account API token cache: login (lowercase) → { token, timestamp } */
  private static cachedApiTokens = new Map<string, { token: string; at: number }>();

  /** Per-account pending connect deduplication: login (lowercase) → promise */
  private static pendingConnects = new Map<string, Promise<string | null>>();

  public constructor(login: string, password: string, mode: "api" | "web", allowApiFallback: boolean, megaWebUnrestrict?: MegaWebUnrestrictor) {
    this.login = login;
    this.password = password;
    this.mode = mode;
    this.allowApiFallback = allowApiFallback;
    this.megaWebUnrestrict = megaWebUnrestrict;
  }

  private get cacheKey(): string {
    return this.login.trim().toLowerCase();
  }

  private async connectApi(signal?: AbortSignal): Promise<string | null> {
    const key = this.cacheKey;
    // Return cached token if fresh (max 20 min)
    const cached = MegaDebridClient.cachedApiTokens.get(key);
    if (cached && cached.token && Date.now() - cached.at < 20 * 60 * 1000) {
      return cached.token;
    }

    // Deduplicate parallel connectUser calls — only one in-flight request per account
    const pending = MegaDebridClient.pendingConnects.get(key);
    if (pending) {
      return pending;
    }

    const promise = this.doConnectApi(signal).finally(() => {
      MegaDebridClient.pendingConnects.delete(key);
    });
    MegaDebridClient.pendingConnects.set(key, promise);
    return promise;
  }

  private clearTokenCache(): void {
    MegaDebridClient.cachedApiTokens.delete(this.cacheKey);
  }

  private async doConnectApi(signal?: AbortSignal): Promise<string | null> {
    const url = `${MEGA_DEBRID_API_BASE}?action=connectUser&login=${encodeURIComponent(this.login)}&password=${encodeURIComponent(this.password)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": DEBRID_USER_AGENT },
      signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.clearTokenCache();
      }
      return null;
    }
    const payload = parseJsonSafe(text);
    if (!payload || payload.response_code !== "ok") {
      if (payload && String(payload.response_code || "").toLowerCase().includes("token")) {
        this.clearTokenCache();
      }
      return null;
    }
    const token = String(payload.token || "").trim();
    if (!token) {
      return null;
    }
    MegaDebridClient.cachedApiTokens.set(this.cacheKey, { token, at: Date.now() });
    return token;
  }

  private async unrestrictViaApi(link: string, signal?: AbortSignal): Promise<UnrestrictedLink | null> {
    const token = await this.connectApi(signal);
    if (!token) {
      return null;
    }

    const url = `${MEGA_DEBRID_API_BASE}?action=getLink&token=${encodeURIComponent(token)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DEBRID_USER_AGENT
      },
      body: new URLSearchParams({ link }),
      signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
      // Token might be invalid, clear cache
      if (response.status === 401 || response.status === 403) {
        this.clearTokenCache();
      }
      return null;
    }
    const payload = parseJsonSafe(text);
    if (!payload || payload.response_code !== "ok") {
      // Token expired — clear cache for next attempt
      if (payload && String(payload.response_code || "").includes("token")) {
        this.clearTokenCache();
      }
      const errorText = String(payload?.response_text || "").trim();
      if (errorText) {
        throw new Error(`Mega-Debrid API: ${errorText}`);
      }
      return null;
    }

    const directUrl = String(payload.debridLink || "").trim();
    if (!directUrl) {
      return null;
    }
    const fileName = String(payload.filename || "").trim() || filenameFromUrl(directUrl) || filenameFromUrl(link);
    return {
      directUrl,
      fileName,
      fileSize: null,
      retriesUsed: 0,
      sourceLabel: "API"
    };
  }

  private async unrestrictViaWeb(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (!this.megaWebUnrestrict) {
      throw new Error("Mega-Web-Fallback nicht verfügbar");
    }
    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      if (signal?.aborted) {
        throw new Error("aborted:debrid");
      }
      const web = await this.megaWebUnrestrict(link, signal).catch((error) => {
        lastError = compactErrorText(error);
        return null;
      });
      if (signal?.aborted) {
        throw new Error("aborted:debrid");
      }
      if (web?.directUrl) {
        web.retriesUsed = attempt - 1;
        web.sourceLabel = "Web";
        return web;
      }
      if (web && !web.directUrl) {
        throw new Error("Mega-Web Antwort ohne Download-Link");
      }
      if (!lastError) {
        lastError = "Mega-Web Antwort leer";
      }
      // Don't retry permanent hoster errors (dead link, file removed, etc.)
      if (/permanent ungültig|hosternotavailable|file.?not.?found|file.?unavailable|link.?is.?dead/i.test(lastError)) {
        break;
      }
      if (attempt < REQUEST_RETRIES) {
        await sleepWithSignal(retryDelay(attempt), signal);
      }
    }
    throw new Error(String(lastError || "Mega-Web Unrestrict fehlgeschlagen").replace(/^Error:\s*/i, ""));
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (this.mode === "api" && this.login.trim() && this.password.trim()) {
      try {
        const apiResult = await this.unrestrictViaApi(link, signal);
        if (apiResult) {
          logger.info(`Mega-Debrid (API) unrestrict OK: ${apiResult.fileName}`);
          return apiResult;
        }
        throw new Error("Mega-Debrid API: Login oder Unrestrict fehlgeschlagen");
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        if (!this.allowApiFallback) {
          throw error;
        }
        logger.warn(`Mega-Debrid API fehlgeschlagen, versuche Web-Fallback: ${errorText}`);
      }
      return this.unrestrictViaWeb(link, signal);
    }

    return this.unrestrictViaWeb(link, signal);
  }

  /**
   * Multi-account rotation for Mega-Debrid, following the same pattern as Debrid-Link multi-key rotation.
   * Iterates through all configured accounts, skipping disabled/daily-limited/cooldown accounts.
   * On success: clears cooldown, returns result with sourceAccountId/sourceAccountLabel.
   * On failure: classifies error, sets cooldown, tries next account.
   */
  public static async unrestrictWithAccounts(
    settings: AppSettings,
    mode: "api" | "web",
    allowApiFallback: boolean,
    link: string,
    megaWebUnrestrict: MegaWebUnrestrictor | undefined,
    signal?: AbortSignal
  ): Promise<UnrestrictedLink> {
    const accounts = getMegaDebridAccountList(settings);
    if (accounts.length === 0) {
      throw new Error("Mega-Debrid: Kein Account konfiguriert");
    }

    if (getAvailableMegaDebridAccounts(settings).length === 0) {
      throw new Error("Mega-Debrid: Kein aktiver Account verfuegbar (deaktiviert oder am Tageslimit)");
    }

    const failures: string[] = [];
    let usableAccountSeen = false;
    const cooldownFailures: string[] = [];
    let earliestCooldownUntil = 0;
    const hasMultiple = accounts.length > 1;

    // Always start from first account — use first available, skip disabled/limited/cooldown.
    for (let idx = 0; idx < accounts.length; idx += 1) {
      const account = accounts[idx];
      const accountLabel = hasMultiple ? ` (${account.label})` : "";

      if (isMegaDebridAccountDisabled(settings, account.id)) {
        logger.info(`Mega-Debrid${accountLabel}: uebersprungen (manuell deaktiviert), pruefe naechsten Account`);
        continue;
      }
      if (isMegaDebridAccountDailyLimitReached(settings, account.id)) {
        logger.info(`Mega-Debrid${accountLabel}: uebersprungen (lokales Tageslimit erreicht), pruefe naechsten Account`);
        continue;
      }
      // Cooldown key includes mode so API failures don't block Web attempts
      const cooldownKey = `${account.id}:${mode}`;
      const accountCooldownState = getMegaDebridAccountCooldownState(cooldownKey);
      if (accountCooldownState) {
        logger.info(`Mega-Debrid${accountLabel}: uebersprungen (Cooldown bis ${new Date(accountCooldownState.until).toLocaleTimeString()}), pruefe naechsten Account`);
        cooldownFailures.push(`Mega-Debrid${accountLabel}: ${accountCooldownState.message}`);
        if (!earliestCooldownUntil || accountCooldownState.until < earliestCooldownUntil) {
          earliestCooldownUntil = accountCooldownState.until;
        }
        continue;
      }

      usableAccountSeen = true;
      try {
        const client = new MegaDebridClient(account.login, account.password, mode, allowApiFallback, megaWebUnrestrict);
        const result = await client.unrestrictLink(link, signal);
        clearMegaDebridAccountCooldownState(cooldownKey);
        logger.info(`Mega-Debrid${accountLabel}: Unrestrict OK -> ${result.fileName || "?"}`);
        return {
          ...result,
          sourceLabel: account.label,
          sourceAccountId: account.id,
          sourceAccountLabel: account.label
        };
      } catch (error) {
        const failure = MegaDebridClient.classifyAccountFailure(error);
        failures.push(`Mega-Debrid${accountLabel}: ${failure.message}`);
        if (failure.cooldownMs > 0) {
          setMegaDebridAccountCooldownState(cooldownKey, failure.cooldownMs, failure.message, failure.category);
        } else {
          clearMegaDebridAccountCooldownState(cooldownKey);
        }
        if (failure.fatal) {
          throw new Error(`Mega-Debrid${accountLabel}: ${failure.message}`);
        }
        const cooldownInfo = failure.cooldownMs > 0
          ? `, Cooldown ${Math.ceil(failure.cooldownMs / 1000)}s`
          : "";
        logger.warn(`Mega-Debrid${accountLabel}: ${failure.message}${cooldownInfo}, pruefe naechsten Account`);
      }
    }

    if (!usableAccountSeen) {
      if (cooldownFailures.length > 0 && earliestCooldownUntil > Date.now()) {
        const retryMs = Math.max(1000, earliestCooldownUntil - Date.now() + 1000);
        throw new Error(`mega_debrid_cooldown:${retryMs}:${cooldownFailures.join(" | ")}`);
      }
      throw new Error("Mega-Debrid: Kein aktiver Account verfuegbar");
    }
    throw new Error(failures.join(" | ") || "Mega-Debrid: Kein aktiver Account verfuegbar");
  }

  /**
   * Classify error from a single Mega-Debrid account attempt.
   * Returns whether the error is fatal (stop all accounts) and how long to cool down.
   */
  private static classifyAccountFailure(
    error: unknown
  ): { fatal: boolean; cooldownMs: number; message: string; category: MegaDebridCooldownCategory } {
    const errorText = compactErrorText(error).replace(/^Error:\s*/i, "");

    // Abort — don't retry other accounts
    if (/aborted/i.test(errorText) && !/timeout/i.test(errorText)) {
      return { fatal: true, cooldownMs: 0, message: errorText, category: "temporary" };
    }

    // Auth/login failures — long cooldown, try next account
    if (/login|password|auth|credentials|unauthorized|forbidden/i.test(errorText) || /connectUser/i.test(errorText)) {
      return {
        fatal: false,
        cooldownMs: MEGA_DEBRID_INVALID_ACCOUNT_COOLDOWN_MS,
        message: `ungueltiger Account (${errorText})`,
        category: "invalid"
      };
    }

    // Permanent hoster errors — fatal, don't try other accounts
    if (/permanent ungültig|hosternotavailable|file.?not.?found|file.?unavailable|link.?is.?dead/i.test(errorText)) {
      return { fatal: true, cooldownMs: 0, message: errorText, category: "skip" };
    }

    // Quota/limit errors — cooldown, try next account
    if (/quota|limit|exceeded|bandwidth/i.test(errorText)) {
      return {
        fatal: false,
        cooldownMs: MEGA_DEBRID_ACCOUNT_COOLDOWN_MS,
        message: `Quota/Limit erreicht (${errorText})`,
        category: "quota"
      };
    }

    // Rate limit
    if (/rate.?limit|too.?many|429/i.test(errorText)) {
      return {
        fatal: false,
        cooldownMs: MEGA_DEBRID_ACCOUNT_COOLDOWN_MS,
        message: `Rate-Limit (${errorText})`,
        category: "rate_limit"
      };
    }

    // Temporary/transport errors — short cooldown, try next account
    if (isRetryableErrorText(errorText) || /timeout|network|fetch|socket/i.test(errorText)) {
      return {
        fatal: false,
        cooldownMs: MEGA_DEBRID_ACCOUNT_COOLDOWN_MS,
        message: errorText || "temporaerer Fehler",
        category: "temporary"
      };
    }

    // Unknown errors — short cooldown, try next account (non-fatal)
    return {
      fatal: false,
      cooldownMs: MEGA_DEBRID_ACCOUNT_COOLDOWN_MS,
      message: errorText || "unbekannter Fehler",
      category: "temporary"
    };
  }
}

class BestDebridClient {
  private token: string;

  public constructor(token: string) {
    this.token = token;
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    const requests = buildBestDebridRequests(link, this.token);
    let lastError = "";

    for (const request of requests) {
      try {
        return await this.tryRequest(request, link, signal);
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        lastError = errorText;
      }
    }

    throw new Error(lastError || "BestDebrid Unrestrict fehlgeschlagen");
  }

  private async tryRequest(request: BestDebridRequest, originalLink: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          "User-Agent": DEBRID_USER_AGENT
        };
        if (request.useAuthHeader) {
          headers.Authorization = `Bearer ${this.token}`;
        }

        const response = await fetch(request.url, {
          method: "GET",
          headers,
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });
        const text = await response.text();
        const parsed = parseJson(text);
        const payload = Array.isArray(parsed) ? asRecord(parsed[0]) : asRecord(parsed);

        if (!response.ok) {
          const reason = parseError(response.status, text, payload);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
            continue;
          }
          throw new Error(reason);
        }

        const directUrl = pickString(payload, ["download", "debridLink", "link"]);
        if (directUrl) {
          let parsedDirect: URL;
          try {
            parsedDirect = new URL(directUrl);
          } catch {
            throw new Error("BestDebrid Antwort enthält keine gültige Download-URL");
          }
          if (parsedDirect.protocol !== "https:" && parsedDirect.protocol !== "http:") {
            throw new Error(`BestDebrid Antwort enthält ungültiges Download-URL-Protokoll (${parsedDirect.protocol})`);
          }
          const fileName = pickString(payload, ["filename", "fileName"]) || filenameFromUrl(originalLink);
          const fileSize = pickNumber(payload, ["filesize", "size", "bytes"]);
          return {
            fileName,
            directUrl,
            fileSize,
            retriesUsed: attempt - 1
          };
        }

        const message = pickString(payload, ["response_text", "message", "error"]);
        if (message) {
          throw new Error(message);
        }

        throw new Error("BestDebrid Antwort ohne Download-Link");
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          break;
        }
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleepWithSignal(retryDelay(attempt), signal);
      }
    }
    throw new Error(String(lastError || "BestDebrid Request fehlgeschlagen").replace(/^Error:\s*/i, ""));
  }
}

class AllDebridClient {
  private token: string;

  public constructor(token: string) {
    this.token = token;
  }

  public async getLinkInfos(links: string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const canonicalToInput = new Map<string, string>();
    const uniqueLinks: string[] = [];

    for (const link of links) {
      const trimmed = link.trim();
      if (!trimmed) {
        continue;
      }
      const canonical = canonicalLink(trimmed);
      if (canonicalToInput.has(canonical)) {
        continue;
      }
      canonicalToInput.set(canonical, trimmed);
      uniqueLinks.push(trimmed);
    }

    for (let index = 0; index < uniqueLinks.length; index += 32) {
      if (signal?.aborted) {
        throw new Error("aborted:debrid");
      }
      const chunk = uniqueLinks.slice(index, index + 32);
      const body = new URLSearchParams();
      for (const link of chunk) {
        body.append("link[]", link);
      }

      let payload: Record<string, unknown> | null = null;
      let chunkResolved = false;
      for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
        let response: Response;
        let text = "";
        try {
          response = await fetch(`${ALL_DEBRID_API_BASE}/link/infos`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": DEBRID_USER_AGENT
            },
            body,
            signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
          });

          text = await response.text();
          payload = asRecord(parseJson(text));
          if (!response.ok) {
            const reason = parseError(response.status, text, payload);
            if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
              await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
              continue;
            }
            throw new Error(reason);
          }

          const contentType = String(response.headers.get("content-type") || "").toLowerCase();
          const looksHtml = contentType.includes("text/html") || /^\s*<(!doctype\s+html|html\b)/i.test(text);
          if (looksHtml) {
            throw new Error("AllDebrid lieferte HTML statt JSON");
          }
          if (!payload) {
            throw new Error("AllDebrid Antwort ist kein JSON-Objekt");
          }

          const status = pickString(payload, ["status"]);
          if (status && status.toLowerCase() === "error") {
            throw new Error(parseAllDebridError(payload));
          }

          chunkResolved = true;
          break;
        } catch (error) {
          const errorText = compactErrorText(error);
          if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
            throw error;
          }
          if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(errorText)) {
            throw error;
          }
          await sleepWithSignal(retryDelay(attempt), signal);
        }
      }

      if (!chunkResolved || !payload) {
        throw new Error("AllDebrid Link-Infos konnten nicht geladen werden");
      }

      const data = asRecord(payload?.data);
      const infos = Array.isArray(data?.infos) ? data.infos : [];
      const hasAnyLinkedInfo = infos.some((entry) => {
        const info = asRecord(entry);
        return Boolean(pickString(info, ["link"]));
      });
      const allowPositionalFallback = infos.length === chunk.length && !hasAnyLinkedInfo;
      for (let i = 0; i < infos.length; i += 1) {
        const info = asRecord(infos[i]);
        if (!info) {
          continue;
        }
        const fileName = pickString(info, ["filename", "fileName"]);
        if (!fileName) {
          continue;
        }

        const responseLink = pickString(info, ["link"]);
        const byResponse = canonicalToInput.get(canonicalLink(responseLink));
        const byIndex = chunk.length === 1
          ? chunk[0]
          : allowPositionalFallback
            ? chunk[i]
            : "";
        const original = byResponse || byIndex;
        if (!original) {
          continue;
        }
        result.set(original, fileName);
      }
    }

    return result;
  }

  public async getHostInfo(host: string, signal?: AbortSignal): Promise<AllDebridHostInfo> {
    const wanted = normalizeAllDebridHostKey(host);
    let lastError = "";

    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${ALL_DEBRID_API_BASE_V41}/user/hosts`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "User-Agent": DEBRID_USER_AGENT
          },
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });
        const text = await response.text();
        const payload = asRecord(parseJson(text));

        if (!response.ok) {
          const reason = parseError(response.status, text, payload);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
            continue;
          }
          throw new Error(reason);
        }

        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        const looksHtml = contentType.includes("text/html") || /^\s*<(!doctype\s+html|html\b)/i.test(text);
        if (looksHtml) {
          throw new Error("AllDebrid lieferte HTML statt JSON");
        }
        if (!payload) {
          throw new Error("AllDebrid Antwort ist kein JSON-Objekt");
        }

        const status = pickString(payload, ["status"]);
        if (status && status.toLowerCase() === "error") {
          throw new Error(parseAllDebridError(payload));
        }

        const data = asRecord(payload.data);
        const hosts = asRecord(data?.hosts);
        if (!hosts) {
          throw new Error("AllDebrid Antwort ohne Host-Liste");
        }

        let hostEntry = asRecord(hosts[host]) || asRecord(hosts[wanted]);
        if (!hostEntry) {
          for (const entry of Object.values(hosts)) {
            const candidate = asRecord(entry);
            const candidateName = normalizeAllDebridHostKey(pickString(candidate, ["name"]));
            if (candidateName === wanted) {
              hostEntry = candidate;
              break;
            }
          }
        }

        if (!hostEntry) {
          throw new Error(`AllDebrid Host ${host} nicht gefunden`);
        }

        const state = toAllDebridHostState(hostEntry.status);
        const quota = pickNumber(hostEntry, ["quota"]);
        const quotaMax = pickNumber(hostEntry, ["quotaMax"]);
        const limitSimuDl = pickNumber(hostEntry, ["limitSimuDl"]);
        const quotaType = pickString(hostEntry, ["quotaType"]);
        const note = quota === null && quotaMax === null && limitSimuDl === null
          ? "AllDebrid liefert für diesen Host aktuell keine Quota- oder Slot-Daten."
          : "";

        return {
          host: pickString(hostEntry, ["name"]) || host,
          source: "api",
          state,
          statusLabel: toAllDebridHostStatusLabel(state),
          fetchedAt: Date.now(),
          lastCheckedAt: null,
          quota,
          quotaMax,
          quotaType,
          limitSimuDl,
          note
        };
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          break;
        }
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleepWithSignal(retryDelay(attempt), signal);
      }
    }

    throw new Error(String(lastError || "AllDebrid Host-Info fehlgeschlagen").replace(/^Error:\s*/i, ""));
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${ALL_DEBRID_API_BASE}/link/unlock`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": DEBRID_USER_AGENT
          },
          body: new URLSearchParams({ link }),
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });
        const text = await response.text();
        const payload = asRecord(parseJson(text));

        if (!response.ok) {
          const reason = parseError(response.status, text, payload);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
            continue;
          }
          throw new Error(reason);
        }

        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        const looksHtml = contentType.includes("text/html") || /^\s*<(!doctype\s+html|html\b)/i.test(text);
        if (looksHtml) {
          throw new Error("AllDebrid lieferte HTML statt JSON");
        }
        if (!payload) {
          throw new Error("AllDebrid Antwort ist kein JSON-Objekt");
        }

        const status = pickString(payload, ["status"]);
        if (status && status.toLowerCase() === "error") {
          throw new Error(parseAllDebridError(payload));
        }

        const data = asRecord(payload?.data);
        const directUrl = pickString(data, ["link"]);
        if (!directUrl) {
          throw new Error("AllDebrid Antwort ohne Download-Link");
        }
        let parsedDirect: URL;
        try {
          parsedDirect = new URL(directUrl);
        } catch {
          throw new Error("AllDebrid Antwort enthält keine gültige Download-URL");
        }
        if (parsedDirect.protocol !== "https:" && parsedDirect.protocol !== "http:") {
          throw new Error(`AllDebrid Antwort enthält ungültiges Download-URL-Protokoll (${parsedDirect.protocol})`);
        }

        return {
          fileName: pickString(data, ["filename"]) || filenameFromUrl(link),
          directUrl,
          fileSize: pickNumber(data, ["filesize"]),
          retriesUsed: attempt - 1
        };
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          break;
        }
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleepWithSignal(retryDelay(attempt), signal);
      }
    }

    throw new Error(String(lastError || "AllDebrid Unrestrict fehlgeschlagen").replace(/^Error:\s*/i, ""));
  }
}

export async function fetchAllDebridHostInfo(token: string, host = "rapidgator", signal?: AbortSignal): Promise<AllDebridHostInfo> {
  return new AllDebridClient(token).getHostInfo(host, signal);
}

export async function fetchDebridLinkHostLimits(apiKeysRaw: string, host = "rapidgator", signal?: AbortSignal): Promise<DebridLinkHostLimitInfo[]> {
  const apiKeys = parseDebridLinkApiKeys(apiKeysRaw);
  if (apiKeys.length === 0) {
    throw new Error("Debrid-Link ist nicht konfiguriert");
  }

  const publicHostInfo = await fetchDebridLinkPublicHostInfo(host, signal);
  const results: DebridLinkHostLimitInfo[] = [];
  for (const apiKey of apiKeys) {
    results.push(await fetchDebridLinkHostLimitForKeyDetailed(apiKey, host, publicHostInfo, signal));
  }
  return results;
}

// ── Debrid-Link Client ──

class DebridLinkClient {
  private apiKeys: ReturnType<typeof parseDebridLinkApiKeys>;

  public constructor(apiKeysRaw: string) {
    this.apiKeys = parseDebridLinkApiKeys(apiKeysRaw);
  }

  public async unrestrictLink(link: string, settings: AppSettings, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (this.apiKeys.length === 0) {
      throw new Error("Debrid-Link: Kein API-Key konfiguriert");
    }

    if (getAvailableDebridLinkApiKeys(settings).length === 0) {
      throw new Error("Debrid-Link: Kein aktiver API-Key verfuegbar (deaktiviert oder am Tageslimit)");
    }

    const failures: string[] = [];
    let usableKeySeen = false;
    const cooldownFailures: string[] = [];
    let earliestCooldownUntil = 0;
    const attemptedKeyFailures: Array<{ message: string; cooldownMs: number; category?: DebridLinkCooldownCategory }> = [];
    let consecutiveTransportFailures = 0;

    // Always start from first key — use first available, skip disabled/limited/cooldown.
    // This ensures all parallel items use the same key until it's actually exhausted.
    for (let keyIdx = 0; keyIdx < this.apiKeys.length; keyIdx += 1) {
      const apiKey = this.apiKeys[keyIdx];
      const keyLabel = this.apiKeys.length > 1 ? ` (${apiKey.label})` : "";
      if (isDebridLinkApiKeyDisabled(settings, apiKey.id)) {
        logger.info(`Debrid-Link${keyLabel}: uebersprungen (manuell deaktiviert), pruefe naechsten Key`);
        continue;
      }
      if (isDebridLinkApiKeyDailyLimitReached(settings, apiKey.id)) {
        logger.info(`Debrid-Link${keyLabel}: uebersprungen (lokales Tageslimit erreicht), pruefe naechsten Key`);
        continue;
      }
      const keyCooldownState = getDebridLinkKeyCooldownState(apiKey.id);
      if (keyCooldownState) {
        logger.info(`Debrid-Link${keyLabel}: uebersprungen (Cooldown bis ${new Date(keyCooldownState.until).toLocaleTimeString()}), pruefe naechsten Key`);
        cooldownFailures.push(`Debrid-Link${keyLabel}: ${keyCooldownState.message}`);
        if (!earliestCooldownUntil || keyCooldownState.until < earliestCooldownUntil) {
          earliestCooldownUntil = keyCooldownState.until;
        }
        continue;
      }

      usableKeySeen = true;
      try {
        const result = await this.unrestrictWithKey(apiKey, link, signal);
        clearDebridLinkKeyCooldownState(apiKey.id);
        setDebridLinkKeyRuntimeStatus(apiKey.id, "ready", "Unrestrict erfolgreich");
        logger.info(`Debrid-Link${keyLabel}: Unrestrict OK -> ${result.fileName || "?"}`);
        return {
          ...result,
          sourceLabel: apiKey.label,
          sourceAccountId: apiKey.id,
          sourceAccountLabel: apiKey.label
        };
      } catch (error) {
        const failure = await this.classifyKeyFailure(error, apiKey, link, signal);
        attemptedKeyFailures.push({
          message: `Debrid-Link${keyLabel}: ${failure.message}`,
          cooldownMs: failure.cooldownMs,
          category: failure.category
        });
        failures.push(`Debrid-Link${keyLabel}: ${failure.message}`);
        if (failure.cooldownMs > 0) {
          setDebridLinkKeyCooldownState(apiKey.id, failure.cooldownMs, failure.message, failure.category || "temporary");
        } else {
          clearDebridLinkKeyCooldownState(apiKey.id);
          setDebridLinkKeyRuntimeStatus(apiKey.id, failure.category === "invalid" ? "invalid" : "error", failure.message);
        }
        if (failure.fatal) {
          throw new Error(`Debrid-Link${keyLabel}: ${failure.message}`);
        }
        if (failure.providerWide) {
          // Host-level issue (e.g. notDebrid) — rotating to other keys is pointless.
          // Break immediately and apply a longer cooldown (5 min) to avoid burning all keys.
          const providerWideCooldownMs = 5 * 60 * 1000;
          logger.warn(`Debrid-Link${keyLabel}: ${failure.message} (provider-wide, ueberspringe verbleibende Keys, Cooldown ${providerWideCooldownMs / 1000}s)`);
          throw new Error(`debrid_link_cooldown:${providerWideCooldownMs}:Debrid-Link${keyLabel}: ${failure.message}`);
        }
        // Track consecutive transport failures (timeout/network) to detect cascades.
        const isTransport = isRetryableErrorText(failure.message) && !(error instanceof DebridLinkApiError);
        consecutiveTransportFailures = isTransport ? consecutiveTransportFailures + 1 : 0;
        if (consecutiveTransportFailures >= 2) {
          // 2+ keys timed out in a row — likely a server/network issue, not key-specific.
          const cascadeCooldownMs = 3 * 60 * 1000;
          logger.warn(`Debrid-Link: ${consecutiveTransportFailures} Transport-Fehler in Folge, ueberspringe verbleibende Keys, Cooldown ${cascadeCooldownMs / 1000}s`);
          throw new Error(`debrid_link_cooldown:${cascadeCooldownMs}:Debrid-Link: Transport-Kaskade (${consecutiveTransportFailures}x)`);
        }
        const cooldownInfo = failure.cooldownMs > 0
          ? `, Cooldown ${Math.ceil(failure.cooldownMs / 1000)}s`
          : "";
        logger.warn(`Debrid-Link${keyLabel}: ${failure.message}${cooldownInfo}, pruefe naechsten Key`);
      }
    }

    if (!usableKeySeen) {
      if (cooldownFailures.length > 0 && earliestCooldownUntil > Date.now()) {
        const retryMs = Math.max(1000, earliestCooldownUntil - Date.now() + 1000);
        throw new Error(`debrid_link_cooldown:${retryMs}:${cooldownFailures.join(" | ")}`);
      }
      throw new Error("debrid_link_no_active_key:Debrid-Link: Kein aktiver API-Key verfuegbar");
    }

    if (attemptedKeyFailures.length > 0 && attemptedKeyFailures.every((entry) => entry.category === "invalid")) {
      throw new Error(`debrid_link_invalid_all:${attemptedKeyFailures.map((entry) => entry.message).join(" | ")}`);
    }

    const cooldownOnlyFailures = attemptedKeyFailures.filter((entry) => entry.cooldownMs > 0);
    if (attemptedKeyFailures.length > 0 && cooldownOnlyFailures.length === attemptedKeyFailures.length) {
      const retryMs = Math.max(1000, Math.min(...cooldownOnlyFailures.map((entry) => Math.max(1000, entry.cooldownMs))) + 1000);
      throw new Error(`debrid_link_cooldown:${retryMs}:${cooldownOnlyFailures.map((entry) => entry.message).join(" | ")}`);
    }
    throw new Error(failures.join(" | ") || "Debrid-Link: Kein aktiver API-Key verfuegbar");
  }

  private async unrestrictWithKey(
    apiKey: ReturnType<typeof parseDebridLinkApiKeys>[number],
    link: string,
    signal?: AbortSignal
  ): Promise<UnrestrictedLink> {
    const payload = await this.requestPayload(apiKey, "POST", "/downloader/add", { url: link }, signal);
    const entry = await this.resolveDownloaderEntry(apiKey, payload.value, link, signal);
    const directUrl = pickString(entry, ["downloadUrl"]);
    const expired = Boolean(entry.expired === true);
    if (!directUrl || expired) {
      throw new Error("Debrid-Link: Keine gueltige Download-URL in Antwort");
    }
    return {
      fileName: pickString(entry, ["name"]) || filenameFromUrl(directUrl) || filenameFromUrl(link),
      directUrl,
      fileSize: pickNumber(entry, ["size"]),
      retriesUsed: 0
    };
  }

  private async requestPayload(
    apiKey: ReturnType<typeof parseDebridLinkApiKeys>[number],
    method: "GET" | "POST" | "DELETE",
    apiPath: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    maxAttempts = REQUEST_RETRIES
  ): Promise<Record<string, unknown>> {
    return requestDebridLinkPayloadWithKey(apiKey, method, apiPath, body, signal, maxAttempts);
  }

  private shouldRetryApiError(error: DebridLinkApiError, attempt: number, maxAttempts: number): boolean {
    if (attempt >= maxAttempts) {
      return false;
    }
    if (error.status === 429 || error.status >= 500) {
      return true;
    }
    return DEBRID_LINK_RETRYABLE_ERRORS.has(error.code);
  }

  private retryDelayForApiError(error: DebridLinkApiError, attempt: number): number {
    if (error.retryAfterMs > 0) {
      return error.retryAfterMs;
    }
    return retryDelay(attempt);
  }

  private async resolveDownloaderEntry(
    apiKey: ReturnType<typeof parseDebridLinkApiKeys>[number],
    rawValue: unknown,
    originalLink: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const entries = parseDebridLinkLinkEntries(rawValue);
    if (entries.length === 0) {
      throw new Error("Debrid-Link: Keine Daten in Antwort");
    }

    const matchingEntries = entries.filter((entry) => {
      const url = pickString(entry, ["url"]);
      return url ? canonicalLink(url) === canonicalLink(originalLink) : false;
    });
    const chosen = matchingEntries.length === 1
      ? matchingEntries[0]
      : entries.length === 1
        ? entries[0]
        : null;
    if (!chosen) {
      throw new Error(`Debrid-Link: Link lieferte ${entries.length} Dateien statt einer Einzeldatei`);
    }

    const needsRefresh = !pickString(chosen, ["downloadUrl"]) || chosen.expired === true;
    if (!needsRefresh) {
      return chosen;
    }

    const id = pickString(chosen, ["id"]);
    if (!id) {
      return chosen;
    }

    // Poll up to 5 times with 2s delay — Debrid-Link sometimes needs a few
    // seconds to generate the download URL after /downloader/add.
    const maxPolls = 5;
    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      if (poll > 0) {
        await sleepWithSignal(2000, signal);
      }
      const refreshed = await this.fetchDownloaderEntry(apiKey, id, signal);
      if (refreshed) {
        const url = pickString(refreshed, ["downloadUrl"]);
        const expired = refreshed.expired === true;
        if (url && !expired) {
          return refreshed;
        }
      }
    }
    // Return last fetched entry (caller will detect missing URL and throw)
    return (await this.fetchDownloaderEntry(apiKey, id, signal)) || chosen;
  }

  private async fetchDownloaderEntry(
    apiKey: ReturnType<typeof parseDebridLinkApiKeys>[number],
    id: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    const query = new URLSearchParams({ ids: id });
    const payload = await this.requestPayload(apiKey, "GET", `/downloader/list?${query.toString()}`, undefined, signal);
    const entries = parseDebridLinkLinkEntries(payload.value);
    if (entries.length === 0) {
      return null;
    }
    return entries.find((entry) => pickString(entry, ["id"]) === id) || entries[0] || null;
  }

  private async fetchQuotaCooldownMs(
    apiKey: ReturnType<typeof parseDebridLinkApiKeys>[number],
    signal?: AbortSignal
  ): Promise<number> {
    try {
      const payload = await this.requestPayload(apiKey, "GET", "/downloader/limits", undefined, signal, 1);
      return parseDebridLinkNextResetMs(payload) || DEBRID_LINK_KEY_COOLDOWN_MS;
    } catch {
      return DEBRID_LINK_KEY_COOLDOWN_MS;
    }
  }

  private async classifyKeyFailure(
    error: unknown,
    apiKey: ReturnType<typeof parseDebridLinkApiKeys>[number],
    link: string,
    signal?: AbortSignal
  ): Promise<{ fatal: boolean; cooldownMs: number; message: string; category?: DebridLinkCooldownCategory; providerWide?: boolean }> {
    const errorText = compactErrorText(error).replace(/^Error:\s*/i, "");
    if (error instanceof DebridLinkApiError) {
      const code = String(error.code || "").trim() || `HTTP ${error.status}`;
      const description = error.message || code;

      if (DEBRID_LINK_INVALID_TOKEN_ERRORS.has(code)) {
        return {
          fatal: false,
          cooldownMs: DEBRID_LINK_INVALID_KEY_COOLDOWN_MS,
          message: `ungueltiger oder deaktivierter API-Key (${code}: ${description})`,
          category: "invalid"
        };
      }
      if (DEBRID_LINK_RATE_LIMIT_ERRORS.has(code) || error.status === 429) {
        return {
          fatal: false,
          cooldownMs: error.retryAfterMs || DEBRID_LINK_RATE_LIMIT_COOLDOWN_MS,
          message: `API-Rate-Limit erreicht (${code}: ${description})`,
          category: "rate_limit"
        };
      }
      if (DEBRID_LINK_QUOTA_ERRORS.has(code)) {
        const cooldownMs = await this.fetchQuotaCooldownMs(apiKey, signal);
        const hoster = extractHosterFromUrl(link) || "host";
        return {
          fatal: false,
          cooldownMs,
          message: `Quota erreicht fuer ${hoster} (${code}: ${description})`,
          category: "quota"
        };
      }
      if (DEBRID_LINK_PROVIDER_WIDE_ERRORS.has(code)) {
        // notDebrid = host-level issue — affects ALL keys equally, do NOT rotate.
        return {
          fatal: false,
          cooldownMs: DEBRID_LINK_KEY_COOLDOWN_MS,
          message: `Link kann aktuell nicht generiert werden (${code}: ${description})`,
          category: "temporary",
          providerWide: true
        };
      }
      if (DEBRID_LINK_SKIP_KEY_ERRORS.has(code)) {
        return {
          fatal: false,
          cooldownMs: 0,
          message: `Key kann Link aktuell nicht verarbeiten (${code}: ${description})`,
          category: "skip"
        };
      }
      if (DEBRID_LINK_FATAL_LINK_ERRORS.has(code)) {
        return {
          fatal: true,
          cooldownMs: 0,
          message: description,
          category: "temporary"
        };
      }
      if (DEBRID_LINK_RETRYABLE_ERRORS.has(code) || error.status >= 500) {
        return {
          fatal: false,
          cooldownMs: DEBRID_LINK_KEY_COOLDOWN_MS,
          message: `temporärer API-Fehler (${code}: ${description})`
        };
      }
      return {
        fatal: true,
        cooldownMs: 0,
        message: description
      };
    }

    // Treat missing/expired download URLs as temporary — the server may need
    // more time or another key might succeed immediately.
    if (/keine gueltige download-url/i.test(errorText)) {
      return {
        fatal: false,
        cooldownMs: DEBRID_LINK_KEY_COOLDOWN_MS,
        message: errorText || "Download-URL nicht verfuegbar",
        category: "temporary"
      };
    }

    if (isRetryableErrorText(errorText) || /debrid-link.*(json|html)/i.test(errorText)) {
      return {
        fatal: false,
        cooldownMs: DEBRID_LINK_KEY_COOLDOWN_MS,
        message: errorText || "temporärer Transportfehler"
      };
    }

    return {
      fatal: true,
      cooldownMs: 0,
      message: errorText || "Unbekannter Debrid-Link-Fehler"
    };
  }
}

// ── LinkSnappy Client ──

class LinkSnappyClient {
  private username: string;
  private password: string;
  private sessionCookies: string | null = null;

  public constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  private async authenticate(signal?: AbortSignal): Promise<void> {
    const params = new URLSearchParams({ username: this.username, password: this.password });
    const res = await fetch(`${LINKSNAPPY_API_BASE}/AUTHENTICATE?${params.toString()}`, {
      signal: withTimeoutSignal(signal, API_TIMEOUT_MS),
      redirect: "manual"
    });

    const cookies: string[] = [];
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookie) {
      const nameValue = sc.split(";")[0];
      if (nameValue) cookies.push(nameValue);
    }

    const json = await res.json() as Record<string, unknown>;
    if (json.status !== "OK") {
      throw new Error(`LinkSnappy: Login fehlgeschlagen – ${String(json.error || "Unbekannter Fehler")}`);
    }

    if (cookies.length > 0) {
      this.sessionCookies = cookies.join("; ");
    } else {
      this.sessionCookies = `username=${encodeURIComponent(this.username)}; Auth=manual`;
    }

    logger.info("LinkSnappy: Authentifizierung erfolgreich");
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (!this.username || !this.password) {
      throw new Error("LinkSnappy: Kein Login konfiguriert");
    }

    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      if (signal?.aborted) throw new Error("aborted:debrid");
      try {
        if (!this.sessionCookies) {
          await this.authenticate(signal);
        }

        const genLinks = `{"link":"${encodeURIComponent(link)}","type":"","linkpass":""}`;
        const url = `${LINKSNAPPY_API_BASE}/linkgen?genLinks=${genLinks}`;

        const res = await fetch(url, {
          headers: { Cookie: this.sessionCookies! },
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });

        const json = await res.json() as Record<string, unknown>;

        if (json.status === "ERROR" && json.error) {
          const errorMsg = String(json.error);
          if (/not logged in|session expired|unauthorized/i.test(errorMsg)) {
            this.sessionCookies = null;
            if (attempt < REQUEST_RETRIES) {
              continue;
            }
            throw new Error(`LinkSnappy: ${errorMsg}`);
          }
          throw new Error(`LinkSnappy: ${errorMsg}`);
        }

        const links = json.links as Array<Record<string, unknown>> | undefined;
        if (!links || links.length === 0) {
          throw new Error("LinkSnappy: Keine Antwort-Daten");
        }

        const entry = links[0];
        if (entry.status === "ERROR" || (entry.error && entry.status !== "OK")) {
          const errText = String(entry.error);
          if (/quota|limit/i.test(errText)) {
            throw new Error(`LinkSnappy: Quota erreicht – ${errText}`);
          }
          throw new Error(`LinkSnappy: ${errText}`);
        }

        let directUrl = String(entry.generated || "");
        if (!directUrl) {
          throw new Error("LinkSnappy: Keine Download-URL in Antwort");
        }
        // LinkSnappy liefert http:// URLs – auf https:// upgraden (deren Server unterstützt beides)
        if (directUrl.startsWith("http://")) {
          directUrl = directUrl.replace("http://", "https://");
        }

        const fileName = String(entry.filename || "") || filenameFromUrl(directUrl) || filenameFromUrl(link);
        const rawSize = entry.filesize;
        let fileSize: number | null = null;
        if (typeof rawSize === "number" && rawSize > 0) {
          fileSize = rawSize;
        } else if (typeof rawSize === "string") {
          const parsed = parseFileSizeString(rawSize);
          if (parsed > 0) fileSize = parsed;
        }

        logger.info(`LinkSnappy: Unrestrict OK → ${fileName || "?"}`);

        return {
          fileName,
          directUrl,
          fileSize,
          retriesUsed: attempt - 1,
          sourceLabel: "API"
        };
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          throw error;
        }
        if (/fehlgeschlagen/i.test(lastError) && /Login/i.test(lastError)) {
          throw error;
        }
        if (attempt < REQUEST_RETRIES) {
          await sleepWithSignal(retryDelay(attempt), signal);
        }
      }
    }

    throw new Error(String(lastError || "LinkSnappy Unrestrict fehlgeschlagen").replace(/^Error:\s*/i, ""));
  }
}

function parseFileSizeString(s: string): number {
  const match = s.trim().match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "").toUpperCase();
  const multipliers: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.floor(num * (multipliers[unit] || 1));
}

// ── 1Fichier Client ──

class OneFichierClient {
  private apiKey: string;

  public constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (!ONEFICHIER_URL_RE.test(link)) {
      throw new Error("Kein 1Fichier-Link");
    }

    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      if (signal?.aborted) throw new Error("aborted:debrid");
      try {
        const res = await fetch(`${ONEFICHIER_API_BASE}/download/get_token.cgi`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({ url: link, pretty: 1, cdn: 0 }),
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });

        const json = await res.json() as Record<string, unknown>;

        if (json.status === "KO" || json.error) {
          const msg = String(json.message || json.error || "Unbekannter 1Fichier-Fehler");
          throw new Error(msg);
        }

        const directUrl = String(json.url || "");
        if (!directUrl) {
          throw new Error("1Fichier: Keine Download-URL in Antwort");
        }

        return {
          fileName: filenameFromUrl(directUrl) || filenameFromUrl(link),
          directUrl,
          fileSize: null,
          retriesUsed: attempt - 1
        };
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          throw error;
        }
        if (attempt < REQUEST_RETRIES) {
          await sleepWithSignal(retryDelay(attempt), signal);
        }
      }
    }
    throw new Error(`1Fichier-Unrestrict fehlgeschlagen: ${lastError}`);
  }
}

const DDOWNLOAD_URL_RE = /^https?:\/\/(?:www\.)?(?:ddownload\.com|ddl\.to)\/([a-z0-9]+)/i;
const DDOWNLOAD_WEB_BASE = "https://ddownload.com";
const DDOWNLOAD_WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

class DdownloadClient {
  private login: string;
  private password: string;
  private cookies: string = "";

  public constructor(login: string, password: string) {
    this.login = login;
    this.password = password;
  }

  private async webLogin(signal?: AbortSignal): Promise<void> {
    // Step 1: GET login page to extract form token
    const loginPageRes = await fetch(`${DDOWNLOAD_WEB_BASE}/login.html`, {
      headers: { "User-Agent": DDOWNLOAD_WEB_UA },
      redirect: "manual",
      signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
    });
    const loginPageHtml = await loginPageRes.text();
    const tokenMatch = loginPageHtml.match(/name="token" value="([^"]+)"/);
    const pageCookies = (loginPageRes.headers.getSetCookie?.() || []).map((c: string) => c.split(";")[0]).join("; ");

    // Step 2: POST login
    const body = new URLSearchParams({
      op: "login",
      token: tokenMatch?.[1] || "",
      rand: "",
      redirect: "",
      login: this.login,
      password: this.password
    });
    const loginRes = await fetch(`${DDOWNLOAD_WEB_BASE}/`, {
      method: "POST",
      headers: {
        "User-Agent": DDOWNLOAD_WEB_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(pageCookies ? { Cookie: pageCookies } : {})
      },
      body: body.toString(),
      redirect: "manual",
      signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
    });

    // Drain body
    try { await loginRes.text(); } catch { /* ignore */ }

    const setCookies = loginRes.headers.getSetCookie?.() || [];
    const xfss = setCookies.find((c: string) => c.startsWith("xfss="));
    const loginCookie = setCookies.find((c: string) => c.startsWith("login="));
    if (!xfss) {
      throw new Error("DDownload Login fehlgeschlagen (kein Session-Cookie)");
    }
    this.cookies = [loginCookie, xfss].filter((c): c is string => Boolean(c)).map((c) => c.split(";")[0]).join("; ");
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    const match = link.match(DDOWNLOAD_URL_RE);
    if (!match) {
      throw new Error("Kein DDownload-Link");
    }
    const fileCode = match[1];
    let lastError = "";

    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        if (signal?.aborted) throw new Error("aborted:debrid");

        // Login if no session yet
        if (!this.cookies) {
          await this.webLogin(signal);
        }

        // Step 1: GET file page to extract form fields
        const filePageRes = await fetch(`${DDOWNLOAD_WEB_BASE}/${fileCode}`, {
          headers: {
            "User-Agent": DDOWNLOAD_WEB_UA,
            Cookie: this.cookies
          },
          redirect: "manual",
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });

        // Premium with direct downloads enabled → redirect immediately
        if (filePageRes.status >= 300 && filePageRes.status < 400) {
          const directUrl = filePageRes.headers.get("location") || "";
          try { await filePageRes.text(); } catch { /* drain */ }
          if (directUrl) {
            return {
              fileName: filenameFromUrl(directUrl) || filenameFromUrl(link),
              directUrl,
              fileSize: null,
              retriesUsed: attempt - 1,
              skipTlsVerify: true
            };
          }
        }

        const html = await filePageRes.text();

        // Check for file not found
        if (/File Not Found|file was removed|file was banned/i.test(html)) {
          throw new Error("DDownload: Datei nicht gefunden");
        }

        // Extract form fields
        const idVal = html.match(/name="id" value="([^"]+)"/)?.[1] || fileCode;
        const randVal = html.match(/name="rand" value="([^"]+)"/)?.[1] || "";
        const fileNameMatch = html.match(/class="file-info-name"[^>]*>([^<]+)</);
        const fileName = fileNameMatch?.[1]?.trim() || filenameFromUrl(link);

        // Step 2: POST download2 for premium download
        const dlBody = new URLSearchParams({
          op: "download2",
          id: idVal,
          rand: randVal,
          referer: "",
          method_premium: "1",
          adblock_detected: "0"
        });

        const dlRes = await fetch(`${DDOWNLOAD_WEB_BASE}/${fileCode}`, {
          method: "POST",
          headers: {
            "User-Agent": DDOWNLOAD_WEB_UA,
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: this.cookies,
            Referer: `${DDOWNLOAD_WEB_BASE}/${fileCode}`
          },
          body: dlBody.toString(),
          redirect: "manual",
          signal: withTimeoutSignal(signal, API_TIMEOUT_MS)
        });

        if (dlRes.status >= 300 && dlRes.status < 400) {
          const directUrl = dlRes.headers.get("location") || "";
          try { await dlRes.text(); } catch { /* drain */ }
          if (directUrl) {
            return {
              fileName: fileName || filenameFromUrl(directUrl),
              directUrl,
              fileSize: null,
              retriesUsed: attempt - 1,
              skipTlsVerify: true
            };
          }
        }

        const dlHtml = await dlRes.text();
        // Try to find direct URL in response HTML
        const directMatch = dlHtml.match(/https?:\/\/[a-z0-9]+\.(?:dstorage\.org|ddownload\.com|ddl\.to|ucdn\.to)[^\s"'<>]+/i);
        if (directMatch) {
          return {
            fileName,
            directUrl: directMatch[0],
            fileSize: null,
            retriesUsed: attempt - 1,
            skipTlsVerify: true
          };
        }

        // Check for error messages
        const errMatch = dlHtml.match(/class="err"[^>]*>([^<]+)</i);
        if (errMatch) {
          throw new Error(`DDownload: ${errMatch[1].trim()}`);
        }

        throw new Error("DDownload: Kein Download-Link erhalten");
      } catch (error) {
        lastError = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(lastError) && !/timeout/i.test(lastError))) {
          break;
        }
        // Re-login on auth errors
        if (/login|session|cookie/i.test(lastError)) {
          this.cookies = "";
        }
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleepWithSignal(retryDelay(attempt), signal);
      }
    }

    throw new Error(String(lastError || "DDownload Unrestrict fehlgeschlagen").replace(/^Error:\s*/i, ""));
  }
}

export class DebridService {
  private settings: AppSettings;

  private options: DebridServiceOptions;

  private cachedDdownloadClient: DdownloadClient | null = null;
  private cachedDdownloadKey = "";
  private cachedDebridLinkClient: DebridLinkClient | null = null;
  private cachedDebridLinkKey = "";
  private cachedLinkSnappyClient: LinkSnappyClient | null = null;
  private cachedLinkSnappyKey = "";

  public constructor(settings: AppSettings, options: DebridServiceOptions = {}) {
    this.settings = cloneSettings(settings);
    this.options = options;
  }

  public setSettings(next: AppSettings): void {
    this.settings = cloneSettings(next);
  }

  private getDebridLinkClient(apiKeysRaw: string): DebridLinkClient {
    if (this.cachedDebridLinkClient && this.cachedDebridLinkKey === apiKeysRaw) {
      return this.cachedDebridLinkClient;
    }
    this.cachedDebridLinkClient = new DebridLinkClient(apiKeysRaw);
    this.cachedDebridLinkKey = apiKeysRaw;
    return this.cachedDebridLinkClient;
  }

  private getLinkSnappyClient(login: string, password: string): LinkSnappyClient {
    const key = `${login}\0${password}`;
    if (this.cachedLinkSnappyClient && this.cachedLinkSnappyKey === key) {
      return this.cachedLinkSnappyClient;
    }
    this.cachedLinkSnappyClient = new LinkSnappyClient(login, password);
    this.cachedLinkSnappyKey = key;
    return this.cachedLinkSnappyClient;
  }

  private getDdownloadClient(login: string, password: string): DdownloadClient {
    const key = `${login}\0${password}`;
    if (this.cachedDdownloadClient && this.cachedDdownloadKey === key) {
      return this.cachedDdownloadClient;
    }
    this.cachedDdownloadClient = new DdownloadClient(login, password);
    this.cachedDdownloadKey = key;
    return this.cachedDdownloadClient;
  }

  public async resolveFilenames(
    links: string[],
    onResolved?: (link: string, fileName: string) => void,
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    const settings = cloneSettings(this.settings);
    const allDebridClient = new AllDebridClient(settings.allDebridToken);
    const unresolved = links.filter((link) => looksLikeOpaqueFilename(filenameFromUrl(link)));
    if (unresolved.length === 0) {
      return new Map<string, string>();
    }

    const clean = new Map<string, string>();
    const reportResolved = (link: string, fileName: string): void => {
      const normalized = fileName.trim();
      if (!normalized || looksLikeOpaqueFilename(normalized) || normalized.toLowerCase() === "download.bin") {
        return;
      }
      if (clean.get(link) === normalized) {
        return;
      }
      clean.set(link, normalized);
      onResolved?.(link, normalized);
    };

    const token = settings.allDebridToken.trim();
    if (token) {
      try {
        const infos = await allDebridClient.getLinkInfos(unresolved, signal);
        for (const [link, fileName] of infos.entries()) {
          reportResolved(link, fileName);
        }
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        // ignore and continue with host page fallback
      }
    }

    const remaining = unresolved.filter((link) => !clean.has(link) && isRapidgatorLink(link));
    await runWithConcurrency(remaining, 6, async (link) => {
      const fromPage = await resolveRapidgatorFilename(link, signal);
      reportResolved(link, fromPage);
    });

    return clean;
  }

  private shouldUseRealDebridWeb(settings: AppSettings): boolean {
    return Boolean(settings.realDebridUseWebLogin && this.options.realDebridWebUnrestrict);
  }

  private shouldUseAllDebridWeb(settings: AppSettings): boolean {
    return Boolean(settings.allDebridUseWebLogin && this.options.allDebridWebUnrestrict);
  }

  private shouldUseBestDebridWeb(settings: AppSettings): boolean {
    return Boolean(settings.bestDebridUseWebLogin && this.options.bestDebridWebUnrestrict);
  }

  private isProviderDailyLimited(settings: AppSettings, provider: DebridProvider): boolean {
    const effectiveProvider = resolveMegaDebridProvider(settings, provider);
    if (effectiveProvider === "debridlink") {
      const configuredKeys = parseDebridLinkApiKeys(settings.debridLinkApiKeys);
      if (configuredKeys.length > 0 && getAvailableDebridLinkApiKeys(settings).length === 0) {
        return true;
      }
    }
    if (effectiveProvider === "megadebrid-api" || effectiveProvider === "megadebrid-web") {
      const configuredAccounts = getMegaDebridAccountList(settings);
      if (configuredAccounts.length > 0 && getAvailableMegaDebridAccounts(settings).length === 0) {
        return true;
      }
    }
    return isProviderDailyLimitReached(settings, effectiveProvider);
  }

  private isProviderSelectableFor(settings: AppSettings, provider: DebridProvider): boolean {
    return this.isProviderConfiguredFor(settings, provider) && !this.isProviderDailyLimited(settings, provider);
  }

  private formatProviderLimitMessage(settings: AppSettings, provider: DebridProvider): string {
    const effectiveProvider = resolveMegaDebridProvider(settings, provider);
    if (effectiveProvider === "debridlink" && parseDebridLinkApiKeys(settings.debridLinkApiKeys).length > 0 && getAvailableDebridLinkApiKeys(settings).length === 0) {
      return "Debrid-Link nicht verfuegbar (alle aktiven API-Keys deaktiviert oder ausgeschopft)";
    }
    if ((effectiveProvider === "megadebrid-api" || effectiveProvider === "megadebrid-web") && getMegaDebridAccountList(settings).length > 0 && getAvailableMegaDebridAccounts(settings).length === 0) {
      return "Mega-Debrid nicht verfuegbar (alle aktiven Accounts deaktiviert oder ausgeschopft)";
    }
    return `${PROVIDER_LABELS[effectiveProvider]} Tageslimit erreicht`;
  }

  public async unrestrictLink(link: string, signal?: AbortSignal, settingsSnapshot?: AppSettings): Promise<ProviderUnrestrictedLink> {
    const settings = settingsSnapshot ? cloneSettings(settingsSnapshot) : cloneSettings(this.settings);

    // Hoster-Zuordnung: prüfe ob für diesen Hoster ein bestimmter Provider konfiguriert ist
    const routing = settings.hosterRouting || {};
    const hosterKey = extractHosterFromUrl(link);
    if (hosterKey && routing[hosterKey]) {
      const routedProvider = routing[hosterKey];
      if (this.isProviderSelectableFor(settings, routedProvider)) {
        logger.info(`Hoster-Zuordnung: ${hosterKey} → ${PROVIDER_LABELS[routedProvider]}`);
        try {
          const result = await this.unrestrictViaProvider(settings, routedProvider, link, signal);
          let fileName = result.fileName;
          if (isRapidgatorLink(link) && looksLikeOpaqueFilename(fileName || filenameFromUrl(link))) {
            const fromPage = await resolveRapidgatorFilename(link, signal);
            if (fromPage) fileName = fromPage;
          }
          return {
            ...result,
            fileName,
            provider: routedProvider,
            providerLabel: PROVIDER_LABELS[routedProvider] + (result.sourceLabel ? ` (${result.sourceLabel})` : "")
          };
        } catch (error) {
          const errorText = compactErrorText(error);
          if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
            throw error;
          }
          if (!settings.autoProviderFallback) {
            throw new Error(`Hoster-Zuordnung fehlgeschlagen (${hosterKey} → ${PROVIDER_LABELS[routedProvider]}): ${errorText}`);
          }
          logger.warn(`Hoster-Zuordnung ${hosterKey} → ${PROVIDER_LABELS[routedProvider]} fehlgeschlagen, Fallback auf Provider-Kette: ${errorText}`);
          // Fall through to normal provider chain
        }
      } else if (this.isProviderConfiguredFor(settings, routedProvider) && this.isProviderDailyLimited(settings, routedProvider)) {
        logger.info(`Hoster-Zuordnung ${hosterKey} → ${PROVIDER_LABELS[routedProvider]} übersprungen (${this.formatProviderLimitMessage(settings, routedProvider)})`);
      } else {
        logger.warn(`Hoster-Zuordnung ${hosterKey} → ${PROVIDER_LABELS[routedProvider]} übersprungen (Provider nicht konfiguriert/deaktiviert)`);
      }
    }

    // 1Fichier is a direct file hoster. If the link is a 1fichier.com URL
    // and the API key is configured, use 1Fichier directly before debrid providers.
    if (ONEFICHIER_URL_RE.test(link) && this.isProviderSelectableFor(settings, "onefichier")) {
      try {
        const result = await this.unrestrictViaProvider(settings, "onefichier", link, signal);
        return {
          ...result,
          provider: "onefichier",
          providerLabel: PROVIDER_LABELS["onefichier"] + (result.sourceLabel ? ` (${result.sourceLabel})` : "")
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        // Fall through to normal provider chain
      }
    }

    // DDownload is a direct file hoster, not a debrid service.
    // If the link is a ddownload.com/ddl.to URL and the account is configured,
    // use DDownload directly before trying any debrid providers.
    if (DDOWNLOAD_URL_RE.test(link) && this.isProviderSelectableFor(settings, "ddownload")) {
      try {
        const result = await this.unrestrictViaProvider(settings, "ddownload", link, signal);
        return {
          ...result,
          provider: "ddownload",
          providerLabel: PROVIDER_LABELS["ddownload"] + (result.sourceLabel ? ` (${result.sourceLabel})` : "")
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        // Fall through to normal provider chain (debrid services may also support ddownload links)
      }
    }

    // Dynamische Reihenfolge: providerOrder hat Vorrang, Fallback auf altes primary/secondary/tertiary
    const order: DebridProvider[] = (settings.providerOrder && settings.providerOrder.length > 0)
      ? uniqueProviderOrder(settings.providerOrder)
      : toProviderOrder(settings.providerPrimary, settings.providerSecondary, settings.providerTertiary);

    const primary = order[0];
    if (!settings.autoProviderFallback) {
      if (!this.isProviderConfiguredFor(settings, primary)) {
        throw new Error(`${PROVIDER_LABELS[primary]} nicht konfiguriert`);
      }
      const selectedProvider = this.isProviderDailyLimited(settings, primary)
        ? order.find((provider) => provider !== primary && this.isProviderSelectableFor(settings, provider))
        : primary;
      if (!selectedProvider) {
        throw new Error(this.formatProviderLimitMessage(settings, primary));
      }
      try {
        const result = await this.unrestrictViaProvider(settings, selectedProvider, link, signal);
        let fileName = result.fileName;
        if (isRapidgatorLink(link) && looksLikeOpaqueFilename(fileName || filenameFromUrl(link))) {
          const fromPage = await resolveRapidgatorFilename(link, signal);
          if (fromPage) {
            fileName = fromPage;
          }
        }
        return {
          ...result,
          fileName,
          provider: selectedProvider,
          providerLabel: PROVIDER_LABELS[selectedProvider] + (result.sourceLabel ? ` (${result.sourceLabel})` : "")
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        throw new Error(`Unrestrict fehlgeschlagen: ${PROVIDER_LABELS[selectedProvider]}: ${errorText}`);
      }
    }

    let configuredFound = false;
    let limitReachedFound = false;
    const attempts: string[] = [];

    for (const provider of order) {
      if (!this.isProviderConfiguredFor(settings, provider)) {
        continue;
      }
      configuredFound = true;
      if (this.isProviderDailyLimited(settings, provider)) {
        limitReachedFound = true;
        logger.info(`Provider-Kette: ${PROVIDER_LABELS[provider]} uebersprungen (${this.formatProviderLimitMessage(settings, provider)})`);
        attempts.push(this.formatProviderLimitMessage(settings, provider));
        continue;
      }

      try {
        logger.info(`Provider-Kette: versuche ${PROVIDER_LABELS[provider]}`);
        const result = await this.unrestrictViaProvider(settings, provider, link, signal);
        let fileName = result.fileName;
        if (isRapidgatorLink(link) && looksLikeOpaqueFilename(fileName || filenameFromUrl(link))) {
          const fromPage = await resolveRapidgatorFilename(link, signal);
          if (fromPage) {
            fileName = fromPage;
          }
        }
        return {
          ...result,
          fileName,
          provider,
          providerLabel: PROVIDER_LABELS[provider] + (result.sourceLabel ? ` (${result.sourceLabel})` : "")
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        const nextProvider = order.slice(order.indexOf(provider) + 1).find((candidate) => this.isProviderSelectableFor(settings, candidate));
        if (nextProvider) {
          logger.warn(`Provider-Kette: ${PROVIDER_LABELS[provider]} fehlgeschlagen (${errorText}), Fallback auf ${PROVIDER_LABELS[nextProvider]}`);
        } else {
          logger.warn(`Provider-Kette: ${PROVIDER_LABELS[provider]} fehlgeschlagen (${errorText}), kein weiterer Provider verfuegbar`);
        }
        attempts.push(`${PROVIDER_LABELS[provider]}: ${compactErrorText(error)}`);
      }
    }

    if (!configuredFound) {
      throw new Error("Kein Debrid-Provider konfiguriert");
    }
    if (limitReachedFound && attempts.every((entry) => /Tageslimit erreicht$/i.test(entry))) {
      throw new Error("Alle konfigurierten Provider haben ihr Tageslimit erreicht");
    }

    throw new Error(`Unrestrict fehlgeschlagen: ${attempts.join(" | ")}`);
  }

  private isProviderConfiguredFor(settings: AppSettings, provider: DebridProvider): boolean {
    const effectiveProvider = resolveMegaDebridProvider(settings, provider);
    if ((settings.disabledProviders || []).includes(provider) || (settings.disabledProviders || []).includes(effectiveProvider)) return false;
    if (effectiveProvider === "realdebrid") {
      return Boolean(this.shouldUseRealDebridWeb(settings) || settings.token.trim());
    }
    if (effectiveProvider === "megadebrid-api") {
      return Boolean(hasMegaDebridCredentials(settings) && isMegaDebridModeEnabled(settings, "api"));
    }
    if (effectiveProvider === "megadebrid-web") {
      return Boolean(hasMegaDebridCredentials(settings) && isMegaDebridModeEnabled(settings, "web") && this.options.megaWebUnrestrict);
    }
    if (effectiveProvider === "alldebrid") {
      return Boolean(this.shouldUseAllDebridWeb(settings) || settings.allDebridToken.trim());
    }
    if (effectiveProvider === "ddownload") {
      return Boolean(settings.ddownloadLogin.trim() && settings.ddownloadPassword.trim());
    }
    if (effectiveProvider === "onefichier") {
      return Boolean(settings.oneFichierApiKey.trim());
    }
    if (effectiveProvider === "debridlink") {
      return Boolean(settings.debridLinkApiKeys.trim());
    }
    if (effectiveProvider === "linksnappy") {
      return Boolean(settings.linkSnappyLogin.trim() && settings.linkSnappyPassword.trim());
    }
    return Boolean(this.shouldUseBestDebridWeb(settings) || settings.bestToken.trim());
  }

  private async unrestrictViaProvider(settings: AppSettings, provider: DebridProvider, link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    const effectiveProvider = resolveMegaDebridProvider(settings, provider);
    if (effectiveProvider === "realdebrid") {
      if (this.shouldUseRealDebridWeb(settings) && this.options.realDebridWebUnrestrict) {
        const result = await this.options.realDebridWebUnrestrict(link, signal);
        if (!result) {
          throw new Error("Real-Debrid-Web-Fallback nicht verfügbar");
        }
        result.sourceLabel = "Web";
        return result;
      }
      const result = await new RealDebridClient(settings.token).unrestrictLink(link, signal);
      result.sourceLabel = "API";
      return result;
    }
    if (effectiveProvider === "megadebrid-api") {
      return MegaDebridClient.unrestrictWithAccounts(settings, "api", provider === "megadebrid" && settings.megaDebridPreferApi, link, this.options.megaWebUnrestrict, signal);
    }
    if (effectiveProvider === "megadebrid-web") {
      return MegaDebridClient.unrestrictWithAccounts(settings, "web", false, link, this.options.megaWebUnrestrict, signal);
    }
    if (effectiveProvider === "alldebrid") {
      if (this.shouldUseAllDebridWeb(settings) && this.options.allDebridWebUnrestrict) {
        const result = await this.options.allDebridWebUnrestrict(link, signal);
        if (!result) {
          throw new Error("AllDebrid-Web-Fallback nicht verfügbar");
        }
        result.sourceLabel = "Web";
        return result;
      }
      const adResult = await new AllDebridClient(settings.allDebridToken).unrestrictLink(link, signal);
      adResult.sourceLabel = "API";
      return adResult;
    }
    if (effectiveProvider === "ddownload") {
      return this.getDdownloadClient(settings.ddownloadLogin, settings.ddownloadPassword).unrestrictLink(link, signal);
    }
    if (effectiveProvider === "onefichier") {
      return new OneFichierClient(settings.oneFichierApiKey).unrestrictLink(link, signal);
    }
    if (effectiveProvider === "debridlink") {
      const dlResult = await this.getDebridLinkClient(settings.debridLinkApiKeys).unrestrictLink(link, settings, signal);
      dlResult.sourceLabel = dlResult.sourceLabel || "API";
      return dlResult;
    }
    if (effectiveProvider === "linksnappy") {
      return this.getLinkSnappyClient(settings.linkSnappyLogin, settings.linkSnappyPassword).unrestrictLink(link, signal);
    }
    if (this.shouldUseBestDebridWeb(settings) && this.options.bestDebridWebUnrestrict) {
      const bdResult = await this.options.bestDebridWebUnrestrict(link, signal);
      if (!bdResult) {
        throw new Error("BestDebrid-Web-Fallback nicht verfügbar");
      }
      bdResult.sourceLabel = "Web";
      return bdResult;
    }
    const bdResult = await new BestDebridClient(settings.bestToken).unrestrictLink(link, signal);
    bdResult.sourceLabel = "API";
    return bdResult;
  }
}
