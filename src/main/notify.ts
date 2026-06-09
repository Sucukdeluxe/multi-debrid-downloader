import { logger } from "./logger";

export interface NotifyPayload {
  title: string;
  message: string;
}

const NOTIFY_TIMEOUT_MS = 5000;
const WEBHOOK_USERNAME = "Real-Debrid Downloader";

export function isNotifyUrlValid(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(String(url || "").trim());
}

export function buildNotifyRequest(url: string, payload: NotifyPayload): { url: string; init: RequestInit } {
  const content = `**${payload.title}**\n${payload.message}`.slice(0, 2000);
  return {
    url: String(url || "").trim(),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: WEBHOOK_USERNAME, content })
    }
  };
}

export async function sendNotification(url: string, payload: NotifyPayload, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!isNotifyUrlValid(url)) {
    return false;
  }
  try {
    const request = buildNotifyRequest(url, payload);
    const response = await fetchFn(request.url, { ...request.init, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn(`Benachrichtigung fehlgeschlagen (HTTP ${response.status}): ${payload.title}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.warn(`Benachrichtigung fehlgeschlagen: ${String(error)}`);
    return false;
  }
}
