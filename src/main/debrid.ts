import { AllDebridHostInfo, AppSettings, DebridFallbackProvider, DebridProvider } from "../shared/types";
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

const ONEFICHIER_API_BASE = "https://api.1fichier.com/v1";
const ONEFICHIER_URL_RE = /^https?:\/\/(?:www\.)?(?:1fichier\.com|alterupload\.com|cjoint\.net|desfichiers\.com|dfichiers\.com|megadl\.fr|mesfichiers\.org|piecejointe\.net|pjointe\.com|tenvoi\.com|dl4free\.com)\/\?([a-z0-9]{5,20})$/i;

const PROVIDER_LABELS: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid",
  megadebrid: "Mega-Debrid",
  bestdebrid: "BestDebrid",
  alldebrid: "AllDebrid",
  ddownload: "DDownload",
  onefichier: "1Fichier"
};

interface ProviderUnrestrictedLink extends UnrestrictedLink {
  provider: DebridProvider;
  providerLabel: string;
}

export type MegaWebUnrestrictor = (link: string, signal?: AbortSignal) => Promise<UnrestrictedLink | null>;
export type AllDebridWebUnrestrictor = (link: string, signal?: AbortSignal) => Promise<UnrestrictedLink | null>;

interface DebridServiceOptions {
  megaWebUnrestrict?: MegaWebUnrestrictor;
  allDebridWebUnrestrict?: AllDebridWebUnrestrictor;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    bandwidthSchedules: (settings.bandwidthSchedules || []).map((entry) => ({ ...entry }))
  };
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

  const asSeconds = Number(text);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(120000, Math.floor(asSeconds * 1000));
  }

  const asDate = Date.parse(text);
  if (Number.isFinite(asDate)) {
    return Math.min(120000, Math.max(0, asDate - Date.now()));
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

function uniqueProviderOrder(order: DebridProvider[]): DebridProvider[] {
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

  public constructor(megaWebUnrestrict?: MegaWebUnrestrictor) {
    this.megaWebUnrestrict = megaWebUnrestrict;
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
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
          body: JSON.stringify({ url: link, pretty: 1 }),
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
          await sleep(retryDelay(attempt), signal);
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
    this.cookies = [loginCookie, xfss].filter(Boolean).map((c: string) => c.split(";")[0]).join("; ");
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

  public constructor(settings: AppSettings, options: DebridServiceOptions = {}) {
    this.settings = cloneSettings(settings);
    this.options = options;
  }

  public setSettings(next: AppSettings): void {
    this.settings = cloneSettings(next);
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

  private shouldUseAllDebridWeb(settings: AppSettings): boolean {
    return Boolean(settings.allDebridUseWebLogin && this.options.allDebridWebUnrestrict);
  }

  public async unrestrictLink(link: string, signal?: AbortSignal, settingsSnapshot?: AppSettings): Promise<ProviderUnrestrictedLink> {
    const settings = settingsSnapshot ? cloneSettings(settingsSnapshot) : cloneSettings(this.settings);

    // 1Fichier is a direct file hoster. If the link is a 1fichier.com URL
    // and the API key is configured, use 1Fichier directly before debrid providers.
    if (ONEFICHIER_URL_RE.test(link) && this.isProviderConfiguredFor(settings, "onefichier")) {
      try {
        const result = await this.unrestrictViaProvider(settings, "onefichier", link, signal);
        return {
          ...result,
          provider: "onefichier",
          providerLabel: PROVIDER_LABELS["onefichier"]
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
    if (DDOWNLOAD_URL_RE.test(link) && this.isProviderConfiguredFor(settings, "ddownload")) {
      try {
        const result = await this.unrestrictViaProvider(settings, "ddownload", link, signal);
        return {
          ...result,
          provider: "ddownload",
          providerLabel: PROVIDER_LABELS["ddownload"]
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        // Fall through to normal provider chain (debrid services may also support ddownload links)
      }
    }

    const order = toProviderOrder(
      settings.providerPrimary,
      settings.providerSecondary,
      settings.providerTertiary
    );

    const primary = order[0];
    if (!settings.autoProviderFallback) {
      if (!this.isProviderConfiguredFor(settings, primary)) {
        throw new Error(`${PROVIDER_LABELS[primary]} nicht konfiguriert`);
      }
      try {
        const result = await this.unrestrictViaProvider(settings, primary, link, signal);
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
          provider: primary,
          providerLabel: PROVIDER_LABELS[primary]
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        throw new Error(`Unrestrict fehlgeschlagen: ${PROVIDER_LABELS[primary]}: ${errorText}`);
      }
    }

    let configuredFound = false;
    const attempts: string[] = [];

    for (const provider of order) {
      if (!this.isProviderConfiguredFor(settings, provider)) {
        continue;
      }
      configuredFound = true;

      try {
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
          providerLabel: PROVIDER_LABELS[provider]
        };
      } catch (error) {
        const errorText = compactErrorText(error);
        if (signal?.aborted || (/aborted/i.test(errorText) && !/timeout/i.test(errorText))) {
          throw error;
        }
        attempts.push(`${PROVIDER_LABELS[provider]}: ${compactErrorText(error)}`);
      }
    }

    if (!configuredFound) {
      throw new Error("Kein Debrid-Provider konfiguriert");
    }

    throw new Error(`Unrestrict fehlgeschlagen: ${attempts.join(" | ")}`);
  }

  private isProviderConfiguredFor(settings: AppSettings, provider: DebridProvider): boolean {
    if (provider === "realdebrid") {
      return Boolean(settings.token.trim());
    }
    if (provider === "megadebrid") {
      return Boolean(settings.megaLogin.trim() && settings.megaPassword.trim() && this.options.megaWebUnrestrict);
    }
    if (provider === "alldebrid") {
      return Boolean(this.shouldUseAllDebridWeb(settings) || settings.allDebridToken.trim());
    }
    if (provider === "ddownload") {
      return Boolean(settings.ddownloadLogin.trim() && settings.ddownloadPassword.trim());
    }
    if (provider === "onefichier") {
      return Boolean(settings.oneFichierApiKey.trim());
    }
    return Boolean(settings.bestToken.trim());
  }

  private async unrestrictViaProvider(settings: AppSettings, provider: DebridProvider, link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (provider === "realdebrid") {
      return new RealDebridClient(settings.token).unrestrictLink(link, signal);
    }
    if (provider === "megadebrid") {
      return new MegaDebridClient(this.options.megaWebUnrestrict).unrestrictLink(link, signal);
    }
    if (provider === "alldebrid") {
      if (this.shouldUseAllDebridWeb(settings) && this.options.allDebridWebUnrestrict) {
        const result = await this.options.allDebridWebUnrestrict(link, signal);
        if (!result) {
          throw new Error("AllDebrid-Web-Fallback nicht verfügbar");
        }
        return result;
      }
      return new AllDebridClient(settings.allDebridToken).unrestrictLink(link, signal);
    }
    if (provider === "ddownload") {
      return this.getDdownloadClient(settings.ddownloadLogin, settings.ddownloadPassword).unrestrictLink(link, signal);
    }
    if (provider === "onefichier") {
      return new OneFichierClient(settings.oneFichierApiKey).unrestrictLink(link, signal);
    }
    return new BestDebridClient(settings.bestToken).unrestrictLink(link, signal);
  }
}
