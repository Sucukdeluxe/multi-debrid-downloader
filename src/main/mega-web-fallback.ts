import { BrowserWindow } from "electron";
import { UnrestrictedLink } from "./realdebrid";
import { compactErrorText, filenameFromUrl, sleep } from "./utils";

type MegaCredentials = {
  login: string;
  password: string;
};

type MegaWebResult = {
  directUrl: string;
  fileName: string;
};

export class MegaWebFallback {
  private browser: BrowserWindow | null = null;

  private queue: Promise<unknown> = Promise.resolve();

  private getCredentials: () => MegaCredentials;

  public constructor(getCredentials: () => MegaCredentials) {
    this.getCredentials = getCredentials;
  }

  public async unrestrict(link: string): Promise<UnrestrictedLink | null> {
    return this.runExclusive(async () => {
      const creds = this.getCredentials();
      if (!creds.login.trim() || !creds.password.trim()) {
        return null;
      }

      const browser = await this.ensureBrowser();
      const authOk = await this.login(browser, creds.login, creds.password);
      if (!authOk) {
        throw new Error("Mega-Web-Login fehlgeschlagen");
      }

      const data = await this.generateLink(browser, link);
      if (!data?.directUrl) {
        throw new Error("Mega-Web konnte keinen Downloadlink erzeugen");
      }

      return {
        directUrl: data.directUrl,
        fileName: data.fileName || filenameFromUrl(link),
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

  private async ensureBrowser(): Promise<BrowserWindow> {
    if (this.browser && !this.browser.isDestroyed()) {
      return this.browser;
    }
    this.browser = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:mega-web"
      }
    });
    return this.browser;
  }

  private async login(browser: BrowserWindow, login: string, password: string): Promise<boolean> {
    await browser.loadURL("https://www.mega-debrid.eu/index.php?page=login&lang=en");
    await sleep(600);
    const result = await browser.webContents.executeJavaScript(`(async () => {
      const hasLogout = Boolean(document.querySelector('a[href*="logout"], a[href*="debrideur"], a[href*="debrid"]'));
      if (hasLogout) return { ok: true };
      const form = document.querySelector('#formulaire_login') || document.querySelector('form[action*="form=login"]') || document.querySelector('form');
      if (!form) return { ok: false, reason: 'Login-Form nicht gefunden' };
      const loginInput = form.querySelector('input[name="login"], #user_login');
      const passInput = form.querySelector('input[name="password"], #user_password');
      if (!loginInput || !passInput) return { ok: false, reason: 'Login-Felder fehlen' };
      loginInput.value = ${JSON.stringify(login)};
      passInput.value = ${JSON.stringify(password)};
      const submit = form.querySelector('button[type="submit"], input[type="submit"], #user_submit');
      if (submit) { submit.click(); } else { form.submit(); }
      return { ok: true };
    })();`, true);
    if (!result?.ok) {
      return false;
    }

    for (let i = 0; i < 30; i += 1) {
      await sleep(350);
      const url = browser.webContents.getURL();
      if (url.includes("page=debrideur") || url.includes("page=debrid")) {
        return true;
      }
      const logged = await browser.webContents.executeJavaScript(
        "Boolean(document.querySelector('a[href*=\"debrideur\"], a[href*=\"debrid\"], a[href*=\"logout\"]'))",
        true
      ).catch(() => false);
      if (logged) {
        return true;
      }
    }
    return false;
  }

  private async generateLink(browser: BrowserWindow, link: string): Promise<MegaWebResult | null> {
    await browser.loadURL("https://www.mega-debrid.eu/index.php?page=debrideur&lang=de");
    await sleep(800);

    const start = await browser.webContents.executeJavaScript(`(async () => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return { ok: false, reason: 'Textarea fehlt' };
      textarea.value = ${JSON.stringify(link)};
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const controls = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
      const trigger = controls.find((el) => {
        const text = (el.textContent || el.value || '').toLowerCase();
        return text.includes('erzeugen') || text.includes('generate') || text.includes('générer') || text.includes('downloadlink');
      });
      if (!trigger) return { ok: false, reason: 'Generate-Button fehlt' };
      trigger.click();
      return { ok: true };
    })();`, true);

    if (!start?.ok) {
      throw new Error(start?.reason || "Mega-Web konnte Request nicht starten");
    }

    const linkHash = link.toLowerCase();
    for (let i = 0; i < 80; i += 1) {
      await sleep(500);
      const result = await browser.webContents.executeJavaScript(`(() => {
        const cards = Array.from(document.querySelectorAll('.acp-box.card, .acp-box, .card'));
        for (const card of cards) {
          const title = (card.querySelector('.title')?.textContent || '').trim();
          const href = card.querySelector('a[href*="unrestrict.link/download/file/"]')?.getAttribute('href') || '';
          const fileName = (card.querySelector('.filename')?.textContent || '').trim();
          if (!href) continue;
          const lowTitle = title.toLowerCase();
          if (lowTitle.includes(${JSON.stringify(linkHash)}) || lowTitle.includes(${JSON.stringify(link.toLowerCase())}) || !title) {
            return { directUrl: href, fileName };
          }
        }
        return null;
      })();`, true).catch(() => null);
      if (result?.directUrl) {
        return result;
      }
    }
    return null;
  }

  public dispose(): void {
    if (this.browser && !this.browser.isDestroyed()) {
      this.browser.destroy();
    }
    this.browser = null;
  }
}

export function compactMegaWebError(error: unknown): string {
  return compactErrorText(error);
}
