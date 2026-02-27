import { AppSettings, DebridFallbackProvider, DebridProvider } from "../shared/types";
import { REQUEST_RETRIES } from "./constants";
import { RealDebridClient, UnrestrictedLink } from "./realdebrid";
import { compactErrorText, filenameFromUrl, looksLikeOpaqueFilename, sleep } from "./utils";

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
    const query = parsed.searchParams.toString();
    return `${parsed.hostname}${parsed.pathname}${query ? `?${query}` : ""}`.toLowerCase();
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
    if (Number.isFinite(value) && value > 0) {
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
    return new URL(link).hostname.toLowerCase().includes("rapidgator.net");
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

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const size = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function resolveRapidgatorFilename(link: string): Promise<string> {
  if (!isRapidgatorLink(link)) {
    return "";
  }
  try {
    const response = await fetch(link, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
      }
    });
    if (!response.ok) {
      return "";
    }
    const html = await response.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = decodeHtmlEntities((titleMatch?.[1] || "").trim());
    if (!title) {
      return "";
    }
    const preferred = title.match(/download\s+file\s+(.+)$/i)?.[1]?.trim() || title;
    if (!preferred) {
      return "";
    }
    const withoutSuffix = preferred.replace(/\s*-\s*rapidgator.*$/i, "").trim();
    return withoutSuffix;
  } catch {
    return "";
  }
}

function buildBestDebridRequests(link: string, token: string): BestDebridRequest[] {
  const linkParam = encodeURIComponent(link);
  const authParam = encodeURIComponent(token);
  return [
    {
      url: `${BEST_DEBRID_API_BASE}/generateLink?link=${linkParam}`,
      useAuthHeader: true
    },
    {
      url: `${BEST_DEBRID_API_BASE}/generateLink?auth=${authParam}&link=${linkParam}`,
      useAuthHeader: false
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
          "User-Agent": "RD-Node-Downloader/1.1.12"
        };
        if (request.useAuthHeader) {
          headers.Authorization = this.token;
        }

        const response = await fetch(request.url, {
          method: "GET",
          headers
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
        if (attempt >= REQUEST_RETRIES) {
          break;
        }
        await sleep(retryDelay(attempt));
      }
    }
    throw new Error(lastError || "BestDebrid Request fehlgeschlagen");
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

      const response = await fetch(`${ALL_DEBRID_API_BASE}/link/infos`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "RD-Node-Downloader/1.1.15"
        },
        body
      });

      const text = await response.text();
      const payload = asRecord(parseJson(text));
      if (!response.ok) {
        throw new Error(parseError(response.status, text, payload));
      }

      const status = pickString(payload, ["status"]);
      if (status && status.toLowerCase() === "error") {
        const errorObj = asRecord(payload?.error);
        throw new Error(pickString(errorObj, ["message", "code"]) || "AllDebrid API error");
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
        const byIndex = chunk[i] || "";
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
            "User-Agent": "RD-Node-Downloader/1.1.12"
          },
          body: new URLSearchParams({ link })
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

        const status = pickString(payload, ["status"]);
        if (status && status.toLowerCase() === "error") {
          const errorObj = asRecord(payload?.error);
          throw new Error(pickString(errorObj, ["message", "code"]) || "AllDebrid API error");
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
        if (attempt >= REQUEST_RETRIES) {
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

  private realDebridClient: RealDebridClient;

  private allDebridClient: AllDebridClient;

  private options: DebridServiceOptions;

  public constructor(settings: AppSettings, options: DebridServiceOptions = {}) {
    this.settings = settings;
    this.options = options;
    this.realDebridClient = new RealDebridClient(settings.token);
    this.allDebridClient = new AllDebridClient(settings.allDebridToken);
  }

  public setSettings(next: AppSettings): void {
    this.settings = next;
    this.realDebridClient = new RealDebridClient(next.token);
    this.allDebridClient = new AllDebridClient(next.allDebridToken);
  }

  public async resolveFilenames(links: string[]): Promise<Map<string, string>> {
    const unresolved = links.filter((link) => looksLikeOpaqueFilename(filenameFromUrl(link)));
    if (unresolved.length === 0) {
      return new Map<string, string>();
    }

    const clean = new Map<string, string>();
    const token = this.settings.allDebridToken.trim();
    if (token) {
      try {
        const infos = await this.allDebridClient.getLinkInfos(unresolved);
        for (const [link, fileName] of infos.entries()) {
          if (fileName.trim() && !looksLikeOpaqueFilename(fileName.trim())) {
            clean.set(link, fileName.trim());
          }
        }
      } catch {
        // ignore and continue with host page fallback
      }
    }

    const remaining = unresolved.filter((link) => !clean.has(link) && isRapidgatorLink(link));
    await runWithConcurrency(remaining, 6, async (link) => {
      const fromPage = await resolveRapidgatorFilename(link);
      if (fromPage && !looksLikeOpaqueFilename(fromPage)) {
        clean.set(link, fromPage);
      }
    });

    return clean;
  }

  public async unrestrictLink(link: string): Promise<ProviderUnrestrictedLink> {
    const order = toProviderOrder(
      this.settings.providerPrimary,
      this.settings.providerSecondary,
      this.settings.providerTertiary
    );

    let configuredFound = false;
    const attempts: string[] = [];

    for (const provider of order) {
      if (!this.isProviderConfigured(provider)) {
        continue;
      }
      configuredFound = true;
      if (!this.settings.autoProviderFallback && attempts.length > 0) {
        break;
      }

      try {
        const result = await this.unrestrictViaProvider(provider, link);
        return {
          ...result,
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

  private isProviderConfigured(provider: DebridProvider): boolean {
    if (provider === "realdebrid") {
      return Boolean(this.settings.token.trim());
    }
    if (provider === "megadebrid") {
      return Boolean(this.settings.megaLogin.trim() && this.settings.megaPassword.trim());
    }
    if (provider === "alldebrid") {
      return Boolean(this.settings.allDebridToken.trim());
    }
    return Boolean(this.settings.bestToken.trim());
  }

  private async unrestrictViaProvider(provider: DebridProvider, link: string): Promise<UnrestrictedLink> {
    if (provider === "realdebrid") {
      return this.realDebridClient.unrestrictLink(link);
    }
    if (provider === "megadebrid") {
      return new MegaDebridClient(this.options.megaWebUnrestrict).unrestrictLink(link);
    }
    if (provider === "alldebrid") {
      return this.allDebridClient.unrestrictLink(link);
    }
    return new BestDebridClient(this.settings.bestToken).unrestrictLink(link);
  }
}
