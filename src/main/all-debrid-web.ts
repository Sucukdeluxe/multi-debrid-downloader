import { BrowserWindow, session } from "electron";
import { AllDebridHostInfo } from "../shared/types";
import { UnrestrictedLink } from "./realdebrid";
import { filenameFromUrl, sleep } from "./utils";

const ALLDEBRID_BASE_URL = "https://alldebrid.com";
const ALLDEBRID_LOGIN_URL = `${ALLDEBRID_BASE_URL}/register/?from=de`;
const ALLDEBRID_SERVICE_URL = `${ALLDEBRID_BASE_URL}/service.php`;
const ALLDEBRID_SERVICE_REFERER = `${ALLDEBRID_BASE_URL}/service/?from=de`;
const ALLDEBRID_DELAYED_URL = `${ALLDEBRID_BASE_URL}/internalapi/v4/link/delayed`;
const ALLDEBRID_STATUS_URL = `${ALLDEBRID_BASE_URL}/status/`;
const ALLDEBRID_PERSISTENT_PARTITION = "persist:alldebrid-web";
const ALLDEBRID_TRANSIENT_PARTITION = "alldebrid-web";
const ALLDEBRID_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

type DelayedStatusPayload = {
  status: number;
  link: string;
  timeLeft: number;
};

type GenerateOutcome =
  | { kind: "success"; value: UnrestrictedLink }
  | { kind: "login_required" };

function abortError(): Error {
  return new Error("aborted:alldebrid-web");
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([signal, timeoutSignal]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw abortError();
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
      reject(abortError());
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

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function normalizeHostName(value: string): string {
  return String(value || "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function toHostStateFromIcon(url: string): AllDebridHostInfo["state"] {
  const normalized = String(url || "").toLowerCase();
  if (normalized.includes("up.gif")) {
    return "up";
  }
  if (normalized.includes("down.gif")) {
    return "down";
  }
  if (normalized.includes("not.tracked")) {
    return "not_tracked";
  }
  return "unknown";
}

function toHostStatusLabel(state: AllDebridHostInfo["state"]): string {
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

function extractHostInfoFromStatusPage(html: string, host: string): AllDebridHostInfo | null {
  const wanted = normalizeHostName(host);
  const rowRegex = /<tr class=['"]g1['"]>\s*<td[^>]*>[\s\S]*?<i[^>]*alt=['"]([^'"]+)['"][^>]*>[\s\S]*?<\/td>\s*<td[^>]*class=['"]comparatif_content['"][^>]*>[\s\S]*?<img[^>]*src=['"]([^'"]+)['"][^>]*>[\s\S]*?\((?:<span[^>]*data-fdate=['"](\d+)['"][^>]*><\/span>|([^<)]*))\)/gi;

  for (let match = rowRegex.exec(html); match; match = rowRegex.exec(html)) {
    const hostAlt = normalizeHostName(match[1] || "");
    if (hostAlt !== wanted) {
      continue;
    }

    const state = toHostStateFromIcon(match[2] || "");
    const lastCheckedSeconds = Number(match[3] ?? NaN);
    return {
      host,
      source: "web",
      state,
      statusLabel: toHostStatusLabel(state),
      fetchedAt: Date.now(),
      lastCheckedAt: Number.isFinite(lastCheckedSeconds) ? lastCheckedSeconds * 1000 : null,
      quota: null,
      quotaMax: null,
      quotaType: "",
      limitSimuDl: null,
      note: "Quota und Simultan-Slots sind per Web-Login nicht öffentlich verfügbar."
    };
  }

  return null;
}

export class AllDebridWebFallback {
  private queue: Promise<unknown> = Promise.resolve();

  private loginWindow: BrowserWindow | null = null;

  private loginWindowPartition = "";

  private getRememberSession: () => boolean;

  public constructor(getRememberSession: () => boolean) {
    this.getRememberSession = getRememberSession;
  }

  public async unrestrict(link: string, signal?: AbortSignal): Promise<UnrestrictedLink | null> {
    const overallSignal = withTimeoutSignal(signal, 10 * 60 * 1000);
    return this.runExclusive(async () => {
      throwIfAborted(overallSignal);
      if (!String(link || "").trim()) {
        return null;
      }

      const initial = await this.generate(link, overallSignal);
      if (initial.kind === "success") {
        return initial.value;
      }
      return this.waitForLoginAndGenerate(link, overallSignal);
    }, overallSignal);
  }

  public async openLoginWindow(): Promise<void> {
    const window = await this.ensureLoginWindow();
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  public async getHostInfo(host: string): Promise<AllDebridHostInfo> {
    const currentSession = session.fromPartition(this.getPartition());
    const response = await currentSession.fetch(ALLDEBRID_STATUS_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: ALLDEBRID_SERVICE_REFERER,
        "User-Agent": ALLDEBRID_USER_AGENT
      },
      signal: withTimeoutSignal(undefined, 30_000)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AllDebrid Web Status HTTP ${response.status}`);
    }
    if (!/id=['"]statusContainer['"]/i.test(text)) {
      throw new Error("AllDebrid Web-Status nicht verfügbar. Bitte zuerst im AllDebrid-Fenster einloggen.");
    }
    const info = extractHostInfoFromStatusPage(text, host);
    if (!info) {
      throw new Error(`AllDebrid Web-Status für ${host} nicht gefunden`);
    }
    return info;
  }

  public async clearSessions(): Promise<void> {
    this.disposeLoginWindow();
    for (const partition of [ALLDEBRID_PERSISTENT_PARTITION, ALLDEBRID_TRANSIENT_PARTITION]) {
      const currentSession = session.fromPartition(partition);
      try {
        await currentSession.clearStorageData({
          storages: ["cookies", "indexdb", "localstorage", "serviceworkers", "cachestorage"]
        });
      } catch {
        // ignore
      }
      try {
        await currentSession.clearCache();
      } catch {
        // ignore
      }
    }
  }

  public dispose(): void {
    this.disposeLoginWindow();
  }

  private getPartition(): string {
    return this.getRememberSession() ? ALLDEBRID_PERSISTENT_PARTITION : ALLDEBRID_TRANSIENT_PARTITION;
  }

  private disposeLoginWindow(): void {
    const current = this.loginWindow;
    this.loginWindow = null;
    this.loginWindowPartition = "";
    if (current && !current.isDestroyed()) {
      current.close();
    }
  }

  private async runExclusive<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queuedAt = Date.now();
    const queueWaitTimeoutMs = 90_000;
    const guardedJob = async (): Promise<T> => {
      throwIfAborted(signal);
      const waited = Date.now() - queuedAt;
      if (waited > queueWaitTimeoutMs) {
        throw new Error(`AllDebrid-Web Queue-Timeout (${Math.floor(waited / 1000)}s gewartet)`);
      }
      return job();
    };
    const run = this.queue.then(guardedJob, guardedJob);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureLoginWindow(): Promise<BrowserWindow> {
    const partition = this.getPartition();
    const existing = this.loginWindow;
    if (existing && !existing.isDestroyed() && this.loginWindowPartition === partition) {
      return existing;
    }

    if (existing && !existing.isDestroyed()) {
      existing.close();
    }

    const window = new BrowserWindow({
      width: 1120,
      height: 900,
      minWidth: 980,
      minHeight: 760,
      autoHideMenuBar: true,
      title: "AllDebrid Web-Login",
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    window.setMenuBarVisibility(false);
    window.on("closed", () => {
      if (this.loginWindow === window) {
        this.loginWindow = null;
        this.loginWindowPartition = "";
      }
    });
    this.loginWindow = window;
    this.loginWindowPartition = partition;
    await window.loadURL(ALLDEBRID_LOGIN_URL);
    return window;
  }

  private async postForm(
    url: string,
    body: URLSearchParams,
    referer: string,
    signal?: AbortSignal
  ): Promise<{ response: Response; text: string }> {
    const currentSession = session.fromPartition(this.getPartition());
    const response = await currentSession.fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: ALLDEBRID_BASE_URL,
        Referer: referer,
        "User-Agent": ALLDEBRID_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: body.toString(),
      signal: withTimeoutSignal(signal, 30_000)
    });
    const text = await response.text();
    return { response, text };
  }

  private async generate(link: string, signal?: AbortSignal): Promise<GenerateOutcome> {
    throwIfAborted(signal);
    const body = new URLSearchParams({
      link,
      nb: "0",
      json: "true",
      pw: ""
    });
    const { response, text } = await this.postForm(ALLDEBRID_SERVICE_URL, body, ALLDEBRID_SERVICE_REFERER, signal);
    if (!response.ok) {
      throw new Error(`AllDebrid Web HTTP ${response.status}`);
    }

    const trimmed = text.trim();
    if (trimmed === "login") {
      return { kind: "login_required" };
    }

    const payload = parseJson(trimmed);
    if (!payload) {
      throw new Error("AllDebrid Web lieferte keine JSON-Antwort");
    }

    const errorText = pickString(payload, ["error"]);
    if (errorText) {
      if (errorText.toLowerCase() === "premium") {
        throw new Error("AllDebrid Web: Premium erforderlich");
      }
      throw new Error(`AllDebrid Web: ${errorText}`);
    }

    const directUrl = pickString(payload, ["link"]);
    const fileName = pickString(payload, ["filename"]);
    const fileSize = pickNumber(payload, ["filesize"]);
    if (directUrl) {
      return {
        kind: "success",
        value: {
          directUrl,
          fileName: fileName || filenameFromUrl(directUrl) || filenameFromUrl(link),
          fileSize,
          retriesUsed: 0
        }
      };
    }

    const delayedId = payload.delayed;
    if (delayedId !== undefined && delayedId !== null && delayedId !== false && String(delayedId).trim()) {
      const delayed = await this.waitForDelayedLink(String(delayedId).trim(), signal);
      return {
        kind: "success",
        value: {
          directUrl: delayed.link,
          fileName: fileName || filenameFromUrl(delayed.link) || filenameFromUrl(link),
          fileSize: fileSize,
          retriesUsed: 0
        }
      };
    }

    if (Array.isArray(payload.streams) && payload.streams.length > 0) {
      throw new Error("AllDebrid Web: Streaming-Auswahl wird derzeit nicht unterstützt");
    }

    throw new Error("AllDebrid Web: Antwort ohne Download-Link");
  }

  private async waitForDelayedLink(delayedId: string, signal?: AbortSignal): Promise<DelayedStatusPayload> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      throwIfAborted(signal);
      const body = new URLSearchParams({ id: delayedId });
      const { response, text } = await this.postForm(ALLDEBRID_DELAYED_URL, body, ALLDEBRID_SERVICE_REFERER, signal);
      if (!response.ok) {
        throw new Error(`AllDebrid Web delayed HTTP ${response.status}`);
      }
      const payload = parseJson(text.trim());
      const data = asRecord(payload?.data);
      if (pickString(payload, ["status"]).toLowerCase() !== "success" || !data) {
        throw new Error("AllDebrid Web: Delayed-Status ungültig");
      }

      const status = Number(data.status ?? NaN);
      if (!Number.isFinite(status)) {
        throw new Error("AllDebrid Web: Delayed-Status ohne Status");
      }

      if (status >= 2) {
        const link = pickString(data, ["link"]);
        if (!link) {
          throw new Error("AllDebrid Web: Delayed-Link fehlt");
        }
        return {
          status,
          link,
          timeLeft: Math.max(0, Number(data.time_left ?? 0) || 0)
        };
      }

      const timeLeft = Math.max(0, Number(data.time_left ?? 0) || 0);
      const delayMs = timeLeft > 0 ? Math.min(5_000, Math.max(1_500, timeLeft * 250)) : 2_000;
      await sleepWithSignal(delayMs, signal);
    }

    throw new Error("AllDebrid Web: Delayed-Link Timeout");
  }

  private async waitForLoginAndGenerate(link: string, signal?: AbortSignal): Promise<UnrestrictedLink | null> {
    const window = await this.ensureLoginWindow();
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();

    const startedAt = Date.now();
    while (Date.now() - startedAt < 10 * 60 * 1000) {
      throwIfAborted(signal);
      if (window.isDestroyed()) {
        throw new Error("AllDebrid Web-Login abgebrochen");
      }

      const outcome = await this.generate(link, signal);
      if (outcome.kind === "success") {
        if (!window.isDestroyed()) {
          window.close();
        }
        return outcome.value;
      }

      await sleepWithSignal(1_500, signal);
    }

    throw new Error("AllDebrid Web-Login Timeout");
  }
}
