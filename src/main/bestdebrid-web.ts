import { BrowserWindow, session } from "electron";
import { UnrestrictedLink } from "./realdebrid";
import { filenameFromUrl, sleep } from "./utils";

const BESTDEBRID_BASE_URL = "https://bestdebrid.com";
const BESTDEBRID_LOGIN_URL = `${BESTDEBRID_BASE_URL}/en/downloader/`;
const BESTDEBRID_GENERATE_URL = `${BESTDEBRID_BASE_URL}/api/v1/generateLink`;
const BESTDEBRID_PERSISTENT_PARTITION = "persist:bestdebrid-web";
const BESTDEBRID_TRANSIENT_PARTITION = "bestdebrid-web";
const BESTDEBRID_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

type GenerateOutcome =
  | { kind: "success"; value: UnrestrictedLink }
  | { kind: "login_required" };

function abortError(): Error {
  return new Error("aborted:bestdebrid-web");
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

export class BestDebridWebFallback {
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

  public async clearSessions(): Promise<void> {
    this.disposeLoginWindow();
    for (const partition of [BESTDEBRID_PERSISTENT_PARTITION, BESTDEBRID_TRANSIENT_PARTITION]) {
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
    return this.getRememberSession() ? BESTDEBRID_PERSISTENT_PARTITION : BESTDEBRID_TRANSIENT_PARTITION;
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
        throw new Error(`BestDebrid-Web Queue-Timeout (${Math.floor(waited / 1000)}s gewartet)`);
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

    // Set user agent on session level so Cloudflare Turnstile sees a real Chrome
    const currentSession = session.fromPartition(partition);
    currentSession.setUserAgent(BESTDEBRID_USER_AGENT);

    const window = new BrowserWindow({
      width: 1120,
      height: 900,
      minWidth: 980,
      minHeight: 760,
      autoHideMenuBar: true,
      title: "BestDebrid Web-Login",
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    window.webContents.setUserAgent(BESTDEBRID_USER_AGENT);
    window.setMenuBarVisibility(false);

    // Inject anti-fingerprint patches via CDP before any page JS runs
    // This hides Electron-specific properties that Cloudflare Turnstile detects
    try {
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: [
          "Object.defineProperty(navigator, 'webdriver', { get: () => false });",
          "Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });",
          "Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en-US', 'en'] });",
          "window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };"
        ].join("\n")
      });
      window.webContents.debugger.detach();
    } catch {
      // CDP not available — continue without patches
    }

    window.on("closed", () => {
      if (this.loginWindow === window) {
        this.loginWindow = null;
        this.loginWindowPartition = "";
      }
    });
    this.loginWindow = window;
    this.loginWindowPartition = partition;
    await window.loadURL(BESTDEBRID_LOGIN_URL);
    return window;
  }

  private async generate(link: string, signal?: AbortSignal): Promise<GenerateOutcome> {
    throwIfAborted(signal);
    const currentSession = session.fromPartition(this.getPartition());
    const response = await currentSession.fetch(BESTDEBRID_GENERATE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: BESTDEBRID_BASE_URL,
        Referer: BESTDEBRID_LOGIN_URL,
        "User-Agent": BESTDEBRID_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: new URLSearchParams({ link, pass: "", boxlinklist: "" }).toString(),
      signal: withTimeoutSignal(signal, 30_000)
    });

    const text = await response.text();

    // Not logged in — BestDebrid redirects or returns HTML login page
    if (!response.ok || text.trim().startsWith("<!") || text.trim().startsWith("<html")) {
      return { kind: "login_required" };
    }

    const payload = parseJson(text.trim());
    if (!payload) {
      return { kind: "login_required" };
    }

    const error = Number(payload.error ?? -1);
    const message = String(payload.message || "").trim();

    // error != 0 means failure
    if (error !== 0) {
      // Check if it's a login/auth issue
      if (/login|log in|sign in|not logged|session|auth/i.test(message)) {
        return { kind: "login_required" };
      }
      throw new Error(`BestDebrid Web: ${message || "Unbekannter Fehler"}`);
    }

    const directUrl = String(payload.link || "").trim();
    if (!directUrl) {
      throw new Error("BestDebrid Web: Antwort ohne Download-Link");
    }

    const fileName = String(payload.filename || "").trim() || filenameFromUrl(directUrl) || filenameFromUrl(link);
    const fileSizeRaw = String(payload.size || "").trim();
    let fileSize: number | null = null;
    if (fileSizeRaw) {
      // Size might be like "96.63 MB" — parse it
      const match = fileSizeRaw.match(/([\d.]+)\s*(KB|MB|GB|TB|B)/i);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
        fileSize = Math.floor(value * (multipliers[unit] || 1));
      }
    }

    return {
      kind: "success",
      value: {
        directUrl,
        fileName,
        fileSize,
        retriesUsed: 0
      }
    };
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
        throw new Error("BestDebrid Web-Login abgebrochen");
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

    throw new Error("BestDebrid Web-Login Timeout");
  }
}
