import { API_BASE_URL, APP_VERSION, REQUEST_RETRIES } from "./constants";
import { compactErrorText, sleep } from "./utils";

const DEBRID_USER_AGENT = `RD-Node-Downloader/${APP_VERSION}`;

export interface UnrestrictedLink {
  fileName: string;
  directUrl: string;
  fileSize: number | null;
  retriesUsed: number;
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
    || lower.includes("etimedout");
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (!signal) {
    return AbortSignal.timeout(timeoutMs);
  }
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
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
      reject(new Error("aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function looksLikeHtmlResponse(contentType: string, body: string): boolean {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml+xml")) {
    return true;
  }
  return /^\s*<(!doctype\s+html|html\b)/i.test(String(body || ""));
}

function parseErrorBody(status: number, body: string, contentType: string): string {
  if (looksLikeHtmlResponse(contentType, body)) {
    return `Real-Debrid lieferte HTML statt JSON (HTTP ${status})`;
  }
  const clean = compactErrorText(body);
  return clean || `HTTP ${status}`;
}

export class RealDebridClient {
  private token: string;

  public constructor(token: string) {
    this.token = token;
  }

  public async unrestrictLink(link: string, signal?: AbortSignal): Promise<UnrestrictedLink> {
    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        const body = new URLSearchParams({ link });
        const response = await fetch(`${API_BASE_URL}/unrestrict/link`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": DEBRID_USER_AGENT
          },
          body,
          signal: withTimeoutSignal(signal, 30000)
        });

        const text = await response.text();
        const contentType = String(response.headers.get("content-type") || "");
        if (!response.ok) {
          const parsed = parseErrorBody(response.status, text, contentType);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleepWithSignal(retryDelayForResponse(response, attempt), signal);
            continue;
          }
          throw new Error(parsed);
        }

        if (looksLikeHtmlResponse(contentType, text)) {
          throw new Error("Real-Debrid lieferte HTML statt JSON");
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error("Ungültige JSON-Antwort von Real-Debrid");
        }
        const directUrl = String(payload.download || payload.link || "").trim();
        if (!directUrl) {
          throw new Error("Unrestrict ohne Download-URL");
        }

        const fileName = String(payload.filename || "download.bin").trim() || "download.bin";
        const fileSizeRaw = Number(payload.filesize ?? NaN);
        return {
          fileName,
          directUrl,
          fileSize: Number.isFinite(fileSizeRaw) && fileSizeRaw > 0 ? Math.floor(fileSizeRaw) : null,
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

    throw new Error(lastError || "Unrestrict fehlgeschlagen");
  }
}
