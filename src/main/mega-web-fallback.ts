import { UnrestrictedLink } from "./realdebrid";
import { compactErrorText, filenameFromUrl, sleep } from "./utils";

type MegaCredentials = {
  login: string;
  password: string;
};

type CodeEntry = {
  code: string;
  linkHint: string;
};

const LOGIN_URL = "https://www.mega-debrid.eu/index.php?form=login";
const DEBRID_URL = "https://www.mega-debrid.eu/index.php?form=debrid";
const DEBRID_AJAX_URL = "https://www.mega-debrid.eu/index.php?ajax=debrid&json";
const DEBRID_REFERER = "https://www.mega-debrid.eu/index.php?page=debrideur&lang=de";

/**
 * Mega-Debrid-Antwort "Kein Server für diesen Hoster verfügbar". Kommt zurück, wenn
 * das Tageslimit DIESES Accounts für den Hoster erschöpft ist (oder der Hoster kurz
 * nicht bedient wird). KEIN Session-/Leer-Fall — der Account soll schnell scheitern,
 * damit die Multi-Account-Rotation sofort zum nächsten (nicht limitierten) Account
 * wechselt, statt re-Login + Retry-Sturm das geteilte Unrestrict-Budget zu fressen.
 */
export const MEGA_DEBRID_NO_SERVER_RE = /kein server f(?:ü|u)r diesen hoster|no server (?:is )?available for this host|aucun serveur disponible/i;

function normalizeLink(link: string): string {
  return link.trim().toLowerCase();
}

function parseSetCookieFromHeaders(headers: Headers): string {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const values = getSetCookie.call(headers)
      .map((entry) => entry.split(";")[0].trim())
      .filter(Boolean);
    if (values.length > 0) {
      return values.join("; ");
    }
  }

  const raw = headers.get("set-cookie") || "";
  if (!raw) {
    return "";
  }
  return raw
    .split(/,(?=[^;=]+?=)/g)
    .map((chunk) => chunk.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

const PERMANENT_HOSTER_ERRORS = [
  "hosternotavailable",
  "filenotfound",
  "file_unavailable",
  "file not found",
  "link is dead",
  "file has been removed",
  "file has been deleted",
  "file was deleted",
  "file was removed",
  "not available",
  "file is no longer available"
];

function parsePageErrors(html: string): string[] {
  const errors: string[] = [];
  const errorRegex = /class=["'][^"']*\berror\b[^"']*["'][^>]*>([^<]+)</gi;
  let m: RegExpExecArray | null;
  while ((m = errorRegex.exec(html)) !== null) {
    const text = m[1].replace(/^Fehler:\s*/i, "").trim();
    if (text) {
      errors.push(text);
    }
  }
  return errors;
}

function isPermanentHosterError(errors: string[]): string | null {
  for (const err of errors) {
    const lower = err.toLowerCase();
    for (const pattern of PERMANENT_HOSTER_ERRORS) {
      if (lower.includes(pattern)) {
        return err;
      }
    }
  }
  return null;
}

function parseCodes(html: string): CodeEntry[] {
  const entries: CodeEntry[] = [];
  const cardRegex = /<div[^>]*class=['"][^'"]*acp-box[^'"]*['"][^>]*>[\s\S]*?<\/div>/gi;
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const block = cardMatch[0];
    const linkTitle = (block.match(/<h3>\s*Link:\s*([^<]+)<\/h3>/i)?.[1] || "").trim();
    const code = block.match(/processDebrid\(\d+,'([^']+)',0\)/i)?.[1] || "";
    if (!code) {
      continue;
    }
    entries.push({ code, linkHint: normalizeLink(linkTitle) });
  }

  if (entries.length === 0) {
    const fallbackRegex = /processDebrid\(\d+,'([^']+)',0\)/gi;
    let m: RegExpExecArray | null;
    while ((m = fallbackRegex.exec(html)) !== null) {
      entries.push({ code: m[1], linkHint: "" });
    }
  }

  return entries;
}

function pickCode(entries: CodeEntry[], link: string): string {
  if (entries.length === 0) {
    return "";
  }
  const target = normalizeLink(link);
  const match = entries.find((entry) => entry.linkHint && entry.linkHint.includes(target));
  return (match?.code || entries[0].code || "").trim();
}

function parseDebridJson(text: string): { link: string; text: string } | null {
  try {
    const parsed = JSON.parse(text) as { link?: string; text?: string };
    return {
      link: String(parsed.link || ""),
      text: String(parsed.text || "")
    };
  } catch {
    return null;
  }
}

function abortError(): Error {
  return new Error("aborted:mega-web");
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

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw abortError();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then((value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

export class MegaWebFallback {
  private queue: Promise<unknown> = Promise.resolve();

  private getCredentials: () => MegaCredentials;

  private cookie = "";

  private cookieSetAt = 0;

  public constructor(getCredentials: () => MegaCredentials) {
    this.getCredentials = getCredentials;
  }

  public async unrestrict(link: string, signal?: AbortSignal): Promise<UnrestrictedLink | null> {
    const overallSignal = withTimeoutSignal(signal, 180000);
    return this.runExclusive(async () => {
      throwIfAborted(overallSignal);
      const creds = this.getCredentials();
      if (!creds.login.trim() || !creds.password.trim()) {
        return null;
      }

      if (!this.cookie || Date.now() - this.cookieSetAt > 20 * 60 * 1000) {
        await this.login(creds.login, creds.password, overallSignal);
      }

      const generated = await this.generate(link, overallSignal);
      if (!generated) {
        this.cookie = "";
        await this.login(creds.login, creds.password, overallSignal);
        const retry = await this.generate(link, overallSignal);
        if (!retry) {
          return null;
        }
        return {
          directUrl: retry.directUrl,
          fileName: retry.fileName || filenameFromUrl(link),
          fileSize: null,
          retriesUsed: 0
        };
      }

      return {
        directUrl: generated.directUrl,
        fileName: generated.fileName || filenameFromUrl(link),
        fileSize: null,
        retriesUsed: 0
      };
    }, overallSignal);
  }

  public invalidateSession(): void {
    this.cookie = "";
    this.cookieSetAt = 0;
  }

  private async runExclusive<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queuedAt = Date.now();
    const QUEUE_WAIT_TIMEOUT_MS = 90000;
    const guardedJob = async (): Promise<T> => {
      throwIfAborted(signal);
      const waited = Date.now() - queuedAt;
      if (waited > QUEUE_WAIT_TIMEOUT_MS) {
        throw new Error(`Mega-Web Queue-Timeout (${Math.floor(waited / 1000)}s gewartet)`);
      }
      return job();
    };
    const run = this.queue.then(guardedJob, guardedJob);
    this.queue = run.then(() => undefined, () => undefined);
    return raceWithAbort(run, signal);
  }

  private async login(login: string, password: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const response = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0"
      },
      body: new URLSearchParams({
        login,
        password,
        remember: "on"
      }),
      redirect: "manual",
      signal: withTimeoutSignal(signal, 30000)
    });

    const cookie = parseSetCookieFromHeaders(response.headers);
    if (!cookie) {
      throw new Error("Mega-Web Login liefert kein Session-Cookie");
    }

    const verify = await fetch(DEBRID_REFERER, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Cookie: cookie,
        Referer: DEBRID_REFERER
      },
      signal: withTimeoutSignal(signal, 30000)
    });
    const verifyHtml = await verify.text();
    const hasDebridForm = /id=["']debridForm["']/i.test(verifyHtml) || /name=["']links["']/i.test(verifyHtml);
    if (!hasDebridForm) {
      throw new Error("Mega-Web Login ungültig oder Session blockiert");
    }

    this.cookie = cookie;
    this.cookieSetAt = Date.now();
  }

  private async generate(link: string, signal?: AbortSignal): Promise<{ directUrl: string; fileName: string } | null> {
    throwIfAborted(signal);
    const page = await fetch(DEBRID_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
        Cookie: this.cookie,
        Referer: DEBRID_REFERER
      },
      body: new URLSearchParams({
        links: link,
        password: "",
        showLinks: "1"
      }),
      signal: withTimeoutSignal(signal, 30000)
    });

    const html = await page.text();

    // Check for permanent hoster errors before looking for debrid codes
    const pageErrors = parsePageErrors(html);
    const permanentError = isPermanentHosterError(pageErrors);
    if (permanentError) {
      throw new Error(`Mega-Web: Link permanent ungültig (${permanentError})`);
    }

    const code = pickCode(parseCodes(html), link);
    if (!code) {
      return null;
    }

    for (let attempt = 1; attempt <= 60; attempt += 1) {
      throwIfAborted(signal);
      const res = await fetch(DEBRID_AJAX_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0",
          Cookie: this.cookie,
          Referer: DEBRID_REFERER
        },
        body: new URLSearchParams({
          code,
          autodl: "0"
        }),
        signal: withTimeoutSignal(signal, 15000)
      });

      const text = (await res.text()).trim();
      if (text === "reload") {
        await sleepWithSignal(650, signal);
        continue;
      }
      if (text === "false") {
        return null;
      }

      const parsed = parseDebridJson(text);
      if (!parsed) {
        return null;
      }

      if (!parsed.link) {
        if (/hoster does not respond correctly|could not be done for this moment/i.test(parsed.text || "")) {
          await sleepWithSignal(1200, signal);
          continue;
        }
        const serverMsg = (parsed.text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        // "Kein Server für diesen Hoster verfügbar" = Account-Tageslimit erschöpft.
        // Surface die Meldung statt null zurückzugeben — sonst re-loggt unrestrict()
        // ein + pollt erneut (Retry-Sturm), was bei einem limitierten Account zwecklos
        // ist und das geteilte Rotations-Budget verbrennt. So scheitert der Account
        // schnell und die Rotation nutzt den nächsten Account.
        if (serverMsg && MEGA_DEBRID_NO_SERVER_RE.test(serverMsg)) {
          throw new Error(`Mega-Web: ${serverMsg}`);
        }
        return null;
      }

      const fromText = parsed.text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const nameMatch = fromText.match(/([\w .\-\[\]\(\)]+\.(?:rar|r\d{2}|zip|7z|mkv|mp4|avi|mp3|flac))/i);
      const fileName = (nameMatch?.[1] || filenameFromUrl(link)).trim();
      return {
        directUrl: parsed.link,
        fileName
      };
    }

    return null;
  }

  public dispose(): void {
    this.cookie = "";
  }
}

export function compactMegaWebError(error: unknown): string {
  return compactErrorText(error);
}
