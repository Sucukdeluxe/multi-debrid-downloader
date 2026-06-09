import { logger } from "./logger";

export interface NotifyPayload {
  title: string;
  message: string;
  priority?: "default" | "high";
  tags?: string;
}

const NOTIFY_TIMEOUT_MS = 5000;

export function isNotifyUrlValid(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(String(url || "").trim());
}

export function buildNotifyRequest(url: string, payload: NotifyPayload): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    "Title": payload.title,
    "Content-Type": "text/plain; charset=utf-8"
  };
  if (payload.priority && payload.priority !== "default") {
    headers["Priority"] = payload.priority;
  }
  if (payload.tags) {
    headers["Tags"] = payload.tags;
  }
  return {
    url: String(url || "").trim(),
    init: { method: "POST", headers, body: payload.message }
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
