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

export class MegaWebFallback {
  private queue: Promise<unknown> = Promise.resolve();

  private getCredentials: () => MegaCredentials;

  private cookie = "";

  private cookieSetAt = 0;

  public constructor(getCredentials: () => MegaCredentials) {
    this.getCredentials = getCredentials;
  }

  public async unrestrict(link: string): Promise<UnrestrictedLink | null> {
    return this.runExclusive(async () => {
      const creds = this.getCredentials();
      if (!creds.login.trim() || !creds.password.trim()) {
        return null;
      }

      if (!this.cookie || Date.now() - this.cookieSetAt > 20 * 60 * 1000) {
        await this.login(creds.login, creds.password);
      }

      const generated = await this.generate(link);
      if (!generated) {
        this.cookie = "";
        await this.login(creds.login, creds.password);
        const retry = await this.generate(link);
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
    });
  }

  private async runExclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async login(login: string, password: string): Promise<void> {
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
      signal: AbortSignal.timeout(30000)
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
      signal: AbortSignal.timeout(30000)
    });
    const verifyHtml = await verify.text();
    const hasDebridForm = /id=["']debridForm["']/i.test(verifyHtml) || /name=["']links["']/i.test(verifyHtml);
    if (!hasDebridForm) {
      throw new Error("Mega-Web Login ungültig oder Session blockiert");
    }

    this.cookie = cookie;
    this.cookieSetAt = Date.now();
  }

  private async generate(link: string): Promise<{ directUrl: string; fileName: string } | null> {
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
      signal: AbortSignal.timeout(30000)
    });

    const html = await page.text();
    const code = pickCode(parseCodes(html), link);
    if (!code) {
      return null;
    }

    for (let attempt = 1; attempt <= 60; attempt += 1) {
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
        signal: AbortSignal.timeout(15000)
      });

      const text = (await res.text()).trim();
      if (text === "reload") {
        await sleep(650);
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
          await sleep(1200);
          continue;
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
