import { AppSettings, DebridFallbackProvider, DebridProvider } from "../shared/types";
import { REQUEST_RETRIES } from "./constants";
import { logger } from "./logger";
import { RealDebridClient, UnrestrictedLink } from "./realdebrid";
import { compactErrorText, filenameFromUrl, looksLikeOpaqueFilename, sleep } from "./utils";

const API_TIMEOUT_MS = 30000;
const DEBRID_USER_AGENT = "RD-Node-Downloader/1.4.28";

const BEST_DEBRID_API_BASE = "https://bestdebrid.com/api/v1";
const ALL_DEBRID_API_BASE = "https://api.alldebrid.com/v4";

const PROVIDER_LABELS: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid",
  megadebrid: "Mega-Debrid",
  bestdebrid: "BestDebrid",
  alldebrid: "AllDebrid"
};

interface ProviderUnrestrictedLink extends UnrestrictedLink {
  provider: DebridProvider;
  providerLabel: string;
}

export type MegaWebUnrestrictor = (link: string) => Promise<UnrestrictedLink | null>;

interface DebridServiceOptions {
  megaWebUnrestrict?: MegaWebUnrestrictor;
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
      || hostname.endsWith(".rg.to");
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
  if (!candidate || !looksLikeFileName(candidate) || looksLikeOpaqueFilename(candidate)) {
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
    /<title>([^<]+)<\/title>/i,
    /(?:Dateiname|File\s*name)\s*[:\-]\s*<[^>]*>\s*([^<]+)\s*</i,
    /(?:Dateiname|File\s*name)\s*[:\-]\s*([^<\r\n]+)/i,
    /download\s+file\s+([^<\r\n]+)/i
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
    if (index >= items.length) {
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
        if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES + 2) {
          await sleepWithSignal(retryDelay(attempt), signal);
          continue;
        }
        return "";
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType
        && !contentType.includes("text/html")
        && !contentType.includes("application/xhtml")
        && !contentType.includes("text/plain")
        && !contentType.includes("text/xml")
        && !contentType.includes("application/xml")) {
        return "";
      }

      const html = await response.text();
      const fromHtml = extractRapidgatorFilenameFromHtml(html);
      if (fromHtml) {
        return fromHtml;
      }
      return "";
    } catch (error) {
      const errorText = compactErrorText(error);
      if (/aborted/i.test(errorText)) {
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

  public async unrestrictLink(link: string): Promise<UnrestrictedLink> {
    if (!this.megaWebUnrestrict) {
      throw new Error("Mega-Web-Fallback nicht verfügbar");
    }
    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      const web = await this.megaWebUnrestrict(link).catch((error) => {
        lastError = compactErrorText(error);
        return null;
      });
      if (web?.directUrl) {
        web.retriesUsed = attempt - 1;
        return web;
      }
      if (web && !web.directUrl) {
        throw new Error("Mega-Web Antwort ohne Download-Link");
      }
      if (!lastError) {
        lastError = web ? "Mega-Web Antwort ohne Download-Link" : "Mega-Web Antwort leer";
      }
      if (attempt < REQUEST_RETRIES) {
        await sleep(retryDelay(attempt));
      }
    }
    throw new Error(lastError || "Mega-Web Unrestrict fehlgeschlagen");
  }
}

class BestDebridClient {
  private token: string;

  public constructor(token: string) {
    this.token = token;
  }

  public async unrestrictLink(link: string): Promise<UnrestrictedLink> {
    const requests = buildBestDebridRequests(link, this.token);
    let lastError = "";

    for (const request of requests) {
      try {
        return await this.tryRequest(request, link);
      } catch (error) {
        lastError = compactErrorText(error);
      }
    }

    throw new Error(lastError || "BestDebrid Unrestrict fehlgeschlagen");
  }

  private async tryRequest(request: BestDebridRequest, originalLink: string): Promise<UnrestrictedLink> {
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
          signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        const text = await response.text();
        const parsed = parseJson(text);
        const payload = Array.isArray(parsed) ? asRecord(parsed[0]) : asRecord(parsed);

        if (!response.ok) {
          const reason = parseError(response.status, text, payload);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleep(retryDelay(attempt));
            continue;
          }
          throw new Error(reason);
        }

        const directUrl = pickString(payload, ["download", "debridLink", "link"]);
        if (directUrl) {
          try {
            const parsedDirect = new URL(directUrl);
            if (parsedDirect.protocol !== "https:" && parsedDirect.protocol !== "http:") {
              throw new Error("invalid_protocol");
            }
          } catch {
            throw new Error("BestDebrid Antwort enthält ungültige Download-URL");
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
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleep(retryDelay(attempt));
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

  public async getLinkInfos(links: string[]): Promise<Map<string, string>> {
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
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
          });

          text = await response.text();
          payload = asRecord(parseJson(text));
          if (!response.ok) {
            const reason = parseError(response.status, text, payload);
            if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
              await sleep(retryDelay(attempt));
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
          if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(errorText)) {
            throw error;
          }
          await sleep(retryDelay(attempt));
        }
      }

      if (!chunkResolved || !payload) {
        throw new Error("AllDebrid Link-Infos konnten nicht geladen werden");
      }

      const data = asRecord(payload?.data);
      const infos = Array.isArray(data?.infos) ? data.infos : [];
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

  public async unrestrictLink(link: string): Promise<UnrestrictedLink> {
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
          signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        const text = await response.text();
        const payload = asRecord(parseJson(text));

        if (!response.ok) {
          const reason = parseError(response.status, text, payload);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleep(retryDelay(attempt));
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

        return {
          fileName: pickString(data, ["filename"]) || filenameFromUrl(link),
          directUrl,
          fileSize: pickNumber(data, ["filesize"]),
          retriesUsed: attempt - 1
        };
      } catch (error) {
        lastError = compactErrorText(error);
        if (attempt >= REQUEST_RETRIES || !isRetryableErrorText(lastError)) {
          break;
        }
        await sleep(retryDelay(attempt));
      }
    }

    throw new Error(lastError || "AllDebrid Unrestrict fehlgeschlagen");
  }
}

export class DebridService {
  private settings: AppSettings;

  private options: DebridServiceOptions;

  public constructor(settings: AppSettings, options: DebridServiceOptions = {}) {
    this.settings = settings;
    this.options = options;
  }

  public setSettings(next: AppSettings): void {
    this.settings = next;
  }

  public async resolveFilenames(
    links: string[],
    onResolved?: (link: string, fileName: string) => void,
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    const settings = { ...this.settings };
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
        const infos = await allDebridClient.getLinkInfos(unresolved);
        for (const [link, fileName] of infos.entries()) {
          reportResolved(link, fileName);
        }
      } catch {
        // ignore and continue with host page fallback
      }
    }

    const remaining = unresolved.filter((link) => !clean.has(link) && isRapidgatorLink(link));
    await runWithConcurrency(remaining, 6, async (link) => {
      const fromPage = await resolveRapidgatorFilename(link, signal);
      reportResolved(link, fromPage);
    });

    const stillUnresolved = unresolved.filter((link) => !clean.has(link) && !isRapidgatorLink(link));
    await runWithConcurrency(stillUnresolved, 4, async (link) => {
      try {
        const unrestricted = await this.unrestrictLink(link, signal, settings);
        reportResolved(link, unrestricted.fileName || "");
      } catch {
        // ignore final fallback errors
      }
    });

    return clean;
  }

  public async unrestrictLink(link: string, signal?: AbortSignal, settingsSnapshot?: AppSettings): Promise<ProviderUnrestrictedLink> {
    const settings = settingsSnapshot ? { ...settingsSnapshot } : { ...this.settings };
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
        throw new Error(`Unrestrict fehlgeschlagen: ${PROVIDER_LABELS[primary]}: ${compactErrorText(error)}`);
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
      return Boolean(settings.allDebridToken.trim());
    }
    return Boolean(settings.bestToken.trim());
  }

  private async unrestrictViaProvider(settings: AppSettings, provider: DebridProvider, link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    if (provider === "realdebrid") {
      return new RealDebridClient(settings.token).unrestrictLink(link, signal);
    }
    if (provider === "megadebrid") {
      return new MegaDebridClient(this.options.megaWebUnrestrict).unrestrictLink(link);
    }
    if (provider === "alldebrid") {
      return new AllDebridClient(settings.allDebridToken).unrestrictLink(link);
    }
    return new BestDebridClient(settings.bestToken).unrestrictLink(link);
  }
}
