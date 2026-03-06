import fs from "node:fs";
import { session } from "electron";
import { UnrestrictedLink } from "./realdebrid";
import { filenameFromUrl, sleep } from "./utils";
import { logger } from "./logger";

const BESTDEBRID_BASE_URL = "https://bestdebrid.com";
const BESTDEBRID_DOWNLOADER_URL = `${BESTDEBRID_BASE_URL}/en/downloader/`;
const BESTDEBRID_GENERATE_URL = `${BESTDEBRID_BASE_URL}/api/v1/generateLink`;
const BESTDEBRID_PERSISTENT_PARTITION = "persist:bestdebrid-web";
const BESTDEBRID_TRANSIENT_PARTITION = "bestdebrid-web";
const BESTDEBRID_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

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

interface NetscapeCookie {
  domain: string;
  httpOnly: boolean;
  path: string;
  secure: boolean;
  expirationDate: number;
  name: string;
  value: string;
}

function parseNetscapeCookieFile(text: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length < 7) {
      continue;
    }
    cookies.push({
      domain: parts[0],
      httpOnly: parts[1].toUpperCase() === "TRUE",
      path: parts[2],
      secure: parts[3].toUpperCase() === "TRUE",
      expirationDate: Number(parts[4]) || 0,
      name: parts[5],
      value: parts[6]
    });
  }
  return cookies;
}

export class BestDebridWebFallback {
  private queue: Promise<unknown> = Promise.resolve();

  private cookiesImported = false;

  private getRememberSession: () => boolean;

  public constructor(getRememberSession: () => boolean) {
    this.getRememberSession = getRememberSession;
  }

  public async unrestrict(link: string, signal?: AbortSignal): Promise<UnrestrictedLink | null> {
    const overallSignal = withTimeoutSignal(signal, 60_000);
    return this.runExclusive(async () => {
      throwIfAborted(overallSignal);
      if (!String(link || "").trim()) {
        return null;
      }

      if (!this.cookiesImported) {
        throw new Error("BestDebrid: Keine Cookies importiert. Bitte zuerst über Einstellungen eine Cookie-Datei importieren.");
      }

      const result = await this.generate(link, overallSignal);
      if (result.kind === "success") {
        return result.value;
      }
      throw new Error("BestDebrid: Nicht eingeloggt. Bitte neue Cookie-Datei importieren.");
    }, overallSignal);
  }

  public async importCookiesFromFile(filePath: string): Promise<number> {
    const text = fs.readFileSync(filePath, "utf-8");
    const cookies = parseNetscapeCookieFile(text);
    const bestDebridCookies = cookies.filter((c) =>
      c.domain.includes("bestdebrid.com")
    );

    if (bestDebridCookies.length === 0) {
      throw new Error("Keine BestDebrid-Cookies in der Datei gefunden");
    }

    const currentSession = session.fromPartition(this.getPartition());
    currentSession.setUserAgent(BESTDEBRID_USER_AGENT);

    for (const cookie of bestDebridCookies) {
      const url = `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
      await currentSession.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate > 0 ? cookie.expirationDate : undefined
      });
    }

    this.cookiesImported = true;
    logger.info(`BestDebrid: ${bestDebridCookies.length} Cookies importiert aus ${filePath}`);
    return bestDebridCookies.length;
  }

  public async clearSessions(): Promise<void> {
    this.cookiesImported = false;
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
    // nothing to clean up
  }

  private getPartition(): string {
    return this.getRememberSession() ? BESTDEBRID_PERSISTENT_PARTITION : BESTDEBRID_TRANSIENT_PARTITION;
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

  private async generate(link: string, signal?: AbortSignal): Promise<{ kind: "success"; value: UnrestrictedLink } | { kind: "login_required" }> {
    throwIfAborted(signal);
    const currentSession = session.fromPartition(this.getPartition());
    const response = await currentSession.fetch(BESTDEBRID_GENERATE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: BESTDEBRID_BASE_URL,
        Referer: BESTDEBRID_DOWNLOADER_URL,
        "User-Agent": BESTDEBRID_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: new URLSearchParams({ link, pass: "", boxlinklist: "" }).toString(),
      signal: withTimeoutSignal(signal, 30_000)
    });

    const text = await response.text();

    if (!response.ok || text.trim().startsWith("<!") || text.trim().startsWith("<html")) {
      return { kind: "login_required" };
    }

    const payload = parseJson(text.trim());
    if (!payload) {
      return { kind: "login_required" };
    }

    const error = Number(payload.error ?? -1);
    const message = String(payload.message || "").trim();

    if (error !== 0) {
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
      const match = fileSizeRaw.match(/([\d.]+)\s*(KB|KiB|MB|MiB|GB|GiB|TB|TiB|B)/i);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase().replace("IB", "B");
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
}
