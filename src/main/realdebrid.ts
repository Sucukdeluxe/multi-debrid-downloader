import { API_BASE_URL, REQUEST_RETRIES } from "./constants";
import { compactErrorText, sleep } from "./utils";

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

  public async unrestrictLink(link: string): Promise<UnrestrictedLink> {
    let lastError = "";
    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      try {
        const body = new URLSearchParams({ link });
        const response = await fetch(`${API_BASE_URL}/unrestrict/link`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "RD-Node-Downloader/1.1.12"
          },
          body,
          signal: AbortSignal.timeout(30000)
        });

        const text = await response.text();
        const contentType = String(response.headers.get("content-type") || "");
        if (!response.ok) {
          const parsed = parseErrorBody(response.status, text, contentType);
          if (shouldRetryStatus(response.status) && attempt < REQUEST_RETRIES) {
            await sleep(retryDelay(attempt));
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
        if (attempt >= REQUEST_RETRIES) {
          break;
        }
        await sleep(retryDelay(attempt));
      }
    }

    throw new Error(lastError || "Unrestrict fehlgeschlagen");
  }
}
