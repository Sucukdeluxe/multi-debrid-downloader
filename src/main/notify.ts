import { logger } from "./logger";

export interface NotifyPayload {
  title: string;
  message: string;
  mention?: string;
}

const NOTIFY_TIMEOUT_MS = 5000;
const WEBHOOK_USERNAME = "Real-Debrid Downloader";
const MIN_SEND_GAP_MS = 450;
const RETRY_DELAYS_MS = [1000, 2500];
const RATE_LIMIT_MAX_WAIT_MS = 15_000;
const CONTENT_MAX_CHARS = 2000;

export function isNotifyUrlValid(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(String(url || "").trim());
}

// Accepts a bare Discord user ID (wrapped as <@id> so it actually pings),
// @everyone/@here, or an already-formed <@...>/<@&...> mention as-is.
export function normalizeDiscordMention(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }
  if (/^\d{5,}$/.test(text)) {
    return `<@${text}>`;
  }
  return text;
}

// Discord counts the limit itself; slicing UTF-16 units can split a surrogate
// pair at the boundary, which Discord rejects as invalid content.
export function truncateContent(content: string, maxChars = CONTENT_MAX_CHARS): string {
  if (content.length <= maxChars) {
    return content;
  }
  let cut = content.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

export function buildNotifyRequest(url: string, payload: NotifyPayload): { url: string; init: RequestInit } {
  const mention = normalizeDiscordMention(payload.mention || "");
  const content = truncateContent(`${mention ? `${mention} ` : ""}**${payload.title}**\n${payload.message}`);
  return {
    url: String(url || "").trim(),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: WEBHOOK_USERNAME, content })
    }
  };
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseRetryAfterMs(response: Response, bodyText: string): number {
  const headerSeconds = Number(response.headers.get("X-RateLimit-Reset-After") || response.headers.get("Retry-After") || "");
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.ceil(headerSeconds * 1000);
  }
  try {
    const parsed = JSON.parse(bodyText) as { retry_after?: number };
    if (typeof parsed.retry_after === "number" && parsed.retry_after > 0) {
      return Math.ceil(parsed.retry_after * 1000);
    }
  } catch {
  }
  return 1500;
}

async function sendOnce(url: string, payload: NotifyPayload, fetchFn: typeof fetch): Promise<{ ok: boolean; retryable: boolean; waitMs: number; detail: string }> {
  try {
    const request = buildNotifyRequest(url, payload);
    const response = await fetchFn(request.url, { ...request.init, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    const bodyText = await consumeBody(response);
    if (response.ok) {
      return { ok: true, retryable: false, waitMs: 0, detail: "" };
    }
    if (response.status === 429) {
      const waitMs = Math.min(RATE_LIMIT_MAX_WAIT_MS, parseRetryAfterMs(response, bodyText));
      return { ok: false, retryable: true, waitMs, detail: `HTTP 429 (Rate-Limit, warte ${waitMs}ms)` };
    }
    if (response.status >= 500) {
      return { ok: false, retryable: true, waitMs: 0, detail: `HTTP ${response.status}` };
    }
    return { ok: false, retryable: false, waitMs: 0, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, retryable: true, waitMs: 0, detail: String(error) };
  }
}

// All sends share one chain: serialized with a minimum gap so burst completions
// (many packages finishing together) stay under Discord's 5-per-2s webhook
// bucket instead of getting dropped as 429s.
let sendChain: Promise<void> = Promise.resolve();
let lastSendCompletedAt = 0;

export async function sendNotification(
  url: string,
  payload: NotifyPayload,
  fetchFn: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = delayMs
): Promise<boolean> {
  if (!isNotifyUrlValid(url)) {
    if (String(url || "").trim()) {
      logger.warn(`Benachrichtigung nicht gesendet: ungueltige Webhook-URL (muss mit http(s):// beginnen): ${payload.title}`);
    }
    return false;
  }
  const result = sendChain.then(async () => {
    const sinceLast = Date.now() - lastSendCompletedAt;
    if (sinceLast < MIN_SEND_GAP_MS) {
      await sleepFn(MIN_SEND_GAP_MS - sinceLast);
    }
    let lastDetail = "";
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await sendOnce(url, payload, fetchFn);
      if (outcome.ok) {
        return true;
      }
      lastDetail = outcome.detail;
      if (!outcome.retryable || attempt >= RETRY_DELAYS_MS.length) {
        break;
      }
      await sleepFn(outcome.waitMs > 0 ? outcome.waitMs : RETRY_DELAYS_MS[attempt]);
    }
    logger.warn(`Benachrichtigung fehlgeschlagen (${lastDetail}): ${payload.title}`);
    return false;
  });
  sendChain = result.then(() => {
    lastSendCompletedAt = Date.now();
  }, () => {
    lastSendCompletedAt = Date.now();
  });
  return result;
}
