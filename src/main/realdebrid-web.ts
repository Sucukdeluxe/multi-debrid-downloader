import { BrowserWindow, session } from "electron";
import { UnrestrictedLink } from "./realdebrid";
import { filenameFromUrl, sleep } from "./utils";
import { API_BASE_URL, REQUEST_RETRIES } from "./constants";

const RD_BASE_URL = "https://real-debrid.com";
const RD_LOGIN_URL = RD_BASE_URL;
const RD_APITOKEN_URL = `${RD_BASE_URL}/apitoken`;
const RD_UNRESTRICT_API = `${API_BASE_URL}/unrestrict/link`;
const RD_PERSISTENT_PARTITION = "persist:realdebrid-web";
const RD_TRANSIENT_PARTITION = "realdebrid-web";
const RD_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

type GenerateOutcome =
  | { kind: "success"; value: UnrestrictedLink }
  | { kind: "login_required" };

function abortError(): Error {
  return new Error("aborted:realdebrid-web");
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

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function looksLikeHtmlResponse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML");
}

export class RealDebridWebFallback {
  private queue: Promise<unknown> = Promise.resolve();

  private loginWindow: BrowserWindow | null = null;

  private loginWindowPartition = "";

  private cachedToken = "";

  private cachedTokenAt = 0;

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

  public async clearSessions(): Promise<void> {
    this.disposeLoginWindow();
    this.cachedToken = "";
    this.cachedTokenAt = 0;
    for (const partition of [RD_PERSISTENT_PARTITION, RD_TRANSIENT_PARTITION]) {
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
    return this.getRememberSession() ? RD_PERSISTENT_PARTITION : RD_TRANSIENT_PARTITION;
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
        throw new Error(`Real-Debrid-Web Queue-Timeout (${Math.floor(waited / 1000)}s gewartet)`);
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
      title: "Real-Debrid Web-Login",
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    window.setMenuBarVisibility(false);
    window.webContents.setUserAgent(RD_USER_AGENT);
    window.on("closed", () => {
      if (this.loginWindow === window) {
        this.loginWindow = null;
        this.loginWindowPartition = "";
      }
    });
    this.loginWindow = window;
    this.loginWindowPartition = partition;
    await window.loadURL(RD_LOGIN_URL);
    return window;
  }

  private async extractApiToken(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);

    // Return cached token if fresh (max 30 min)
    if (this.cachedToken && Date.now() - this.cachedTokenAt < 30 * 60 * 1000) {
      return this.cachedToken;
    }

    const currentSession = session.fromPartition(this.getPartition());
    const response = await currentSession.fetch(RD_APITOKEN_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: RD_BASE_URL + "/",
        "User-Agent": RD_USER_AGENT
      },
      signal: withTimeoutSignal(signal, 30_000)
    });
    const html = await response.text();

    if (!response.ok || response.status === 403) {
      return null;
    }

    // Real-Debrid sets the token via inline JS:
    //   document.querySelectorAll('input[name=private_token]')[0].value = 'TOKEN_HERE';
    const tokenMatch = html.match(/private_token['"]\]\[0\]\.value\s*=\s*'([^']+)'/);
    if (tokenMatch && tokenMatch[1]) {
      this.cachedToken = tokenMatch[1];
      this.cachedTokenAt = Date.now();
      return this.cachedToken;
    }

    // Fallback: look for the token in an input value attribute
    const inputMatch = html.match(/name=['"]private_token['"][^>]*value=['"]([^'"]+)['"]/);
    if (inputMatch && inputMatch[1]) {
      this.cachedToken = inputMatch[1];
      this.cachedTokenAt = Date.now();
      return this.cachedToken;
    }

    return null;
  }

  private async generate(link: string, signal?: AbortSignal): Promise<GenerateOutcome> {
    throwIfAborted(signal);

    const token = await this.extractApiToken(signal);
    if (!token) {
      return { kind: "login_required" };
    }

    for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      try {
        const body = new URLSearchParams({ link });
        const response = await fetch(RD_UNRESTRICT_API, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": RD_USER_AGENT
          },
          body,
          signal: withTimeoutSignal(signal, 30_000)
        });

        const text = await response.text();

        if (response.status === 401 || response.status === 403) {
          // Token expired or revoked — invalidate cache
          this.cachedToken = "";
          this.cachedTokenAt = 0;
          return { kind: "login_required" };
        }

        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < REQUEST_RETRIES) {
            await sleepWithSignal(Math.min(5000, 400 * 2 ** attempt), signal);
            continue;
          }
          throw new Error(`Real-Debrid Web HTTP ${response.status}: ${text.slice(0, 200)}`);
        }

        if (looksLikeHtmlResponse(text)) {
          throw new Error("Real-Debrid Web lieferte HTML statt JSON");
        }

        const payload = parseJson(text.trim());
        if (!payload) {
          throw new Error("Ungültige JSON-Antwort von Real-Debrid Web");
        }

        const directUrl = String(payload.download || payload.link || "").trim();
        if (!directUrl) {
          throw new Error("Real-Debrid Web: Antwort ohne Download-URL");
        }

        const fileName = String(payload.filename || "").trim() || filenameFromUrl(directUrl) || filenameFromUrl(link);
        const fileSizeRaw = Number(payload.filesize ?? NaN);
        return {
          kind: "success",
          value: {
            directUrl,
            fileName,
            fileSize: Number.isFinite(fileSizeRaw) && fileSizeRaw > 0 ? Math.floor(fileSizeRaw) : null,
            retriesUsed: attempt - 1
          }
        };
      } catch (error) {
        if (signal?.aborted) {
          throw abortError();
        }
        if (attempt >= REQUEST_RETRIES) {
          throw error;
        }
        await sleepWithSignal(Math.min(5000, 400 * 2 ** attempt), signal);
      }
    }

    throw new Error("Real-Debrid Web: Unrestrict fehlgeschlagen");
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
        throw new Error("Real-Debrid Web-Login abgebrochen");
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

    throw new Error("Real-Debrid Web-Login Timeout");
  }
}
