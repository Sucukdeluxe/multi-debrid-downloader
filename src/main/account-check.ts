import type { AppSettings, DebridAccountStatus } from "../shared/types";
import { parseMegaDebridAccounts, type MegaDebridAccountEntry } from "../shared/mega-debrid-accounts";
import { parseDebridLinkApiKeys, type DebridLinkApiKeyEntry } from "../shared/debrid-link-keys";
import { logger } from "./logger";
import { compactErrorText } from "./utils";

/**
 * Account-Validity + Premium-Check fuer Multi-Account-Provider.
 *
 * Standalone (eigene fetch-Calls, kein Import aus debrid.ts) damit es ohne
 * Zirkular-Abhaengigkeit von der "Check all"-IPC und beim Programmstart genutzt
 * werden kann.
 *
 * Verifizierte API-Felder (Live-Probe):
 *  - Mega-Debrid connectUser -> { response_code:"ok", token, vip_end (Unix-ts), email }
 *  - Debrid-Link /account/infos -> { success, value: { accountType, premiumLeft (s), username } }
 */

const MEGA_DEBRID_API = "https://www.mega-debrid.eu/api.php";
const DEBRID_LINK_API = "https://debrid-link.com/api/v2";
const CHECK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CHECK_TIMEOUT_MS = 20000;

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatRemaining(premiumUntilMs: number | null, now: number): string {
  if (premiumUntilMs == null) {
    return "Premium-Status unbekannt";
  }
  if (premiumUntilMs <= 0) {
    return "Kein Premium";
  }
  const remainingMs = premiumUntilMs - now;
  if (remainingMs <= 0) {
    return "Premium abgelaufen";
  }
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  if (days >= 1) {
    return `Premium noch ${days} Tag${days === 1 ? "" : "e"}`;
  }
  const hours = Math.max(1, Math.floor(remainingMs / (60 * 60 * 1000)));
  return `Premium noch ${hours} Std`;
}

/** Check a single Mega-Debrid account via connectUser. */
export async function checkMegaDebridAccount(
  account: MegaDebridAccountEntry,
  signal?: AbortSignal,
  now = Date.now()
): Promise<DebridAccountStatus> {
  const base: DebridAccountStatus = {
    accountId: account.id,
    provider: "megadebrid",
    label: account.label,
    maskedLogin: account.maskedLogin,
    valid: false,
    isPremium: false,
    premiumUntilMs: null,
    message: "",
    checkedAt: now
  };
  try {
    const url = `${MEGA_DEBRID_API}?action=connectUser&login=${encodeURIComponent(account.login)}&password=${encodeURIComponent(account.password)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": CHECK_USER_AGENT },
      signal: timeoutSignal(signal, CHECK_TIMEOUT_MS)
    });
    const text = await response.text();
    const payload = parseJsonSafe(text);
    if (!response.ok || !payload) {
      return { ...base, message: `Login fehlgeschlagen (HTTP ${response.status})` };
    }
    if (payload.response_code !== "ok") {
      const reason = String(payload.response_text || payload.response_code || "Login abgelehnt");
      return { ...base, message: `Ungueltiger Login: ${reason}` };
    }
    // vip_end is a Unix timestamp (seconds). 0 / missing => no premium.
    const vipEndRaw = Number(payload.vip_end || 0);
    const premiumUntilMs = Number.isFinite(vipEndRaw) && vipEndRaw > 0 ? vipEndRaw * 1000 : 0;
    const isPremium = premiumUntilMs > now;
    const email = String(payload.email || "").trim() || undefined;
    return {
      ...base,
      valid: true,
      isPremium,
      premiumUntilMs,
      email,
      message: formatRemaining(premiumUntilMs, now)
    };
  } catch (error) {
    const errText = compactErrorText(error);
    const aborted = signal?.aborted || /aborted/i.test(errText);
    return {
      ...base,
      message: aborted ? "Pruefung abgebrochen" : `Pruefung fehlgeschlagen: ${errText}`
    };
  }
}

/** Check a single Debrid-Link API key via /account/infos. */
export async function checkDebridLinkKey(
  key: DebridLinkApiKeyEntry,
  signal?: AbortSignal,
  now = Date.now()
): Promise<DebridAccountStatus> {
  const base: DebridAccountStatus = {
    accountId: key.id,
    provider: "debridlink",
    label: key.label,
    maskedLogin: key.masked,
    valid: false,
    isPremium: false,
    premiumUntilMs: null,
    message: "",
    checkedAt: now
  };
  try {
    const response = await fetch(`${DEBRID_LINK_API}/account/infos`, {
      headers: {
        Authorization: `Bearer ${key.token}`,
        "User-Agent": CHECK_USER_AGENT
      },
      signal: timeoutSignal(signal, CHECK_TIMEOUT_MS)
    });
    const text = await response.text();
    const payload = parseJsonSafe(text);
    if (!response.ok || !payload) {
      // 401 = bad/expired token
      if (response.status === 401 || response.status === 403) {
        return { ...base, message: "Ungueltiger API-Key (nicht autorisiert)" };
      }
      return { ...base, message: `Pruefung fehlgeschlagen (HTTP ${response.status})` };
    }
    if (payload.success === false) {
      const reason = String(payload.error || "Key abgelehnt");
      return { ...base, message: `Ungueltiger API-Key: ${reason}` };
    }
    const value = (payload.value && typeof payload.value === "object" ? payload.value : payload) as Record<string, unknown>;
    // premiumLeft = seconds of premium remaining. accountType>0 also indicates premium.
    const premiumLeftSec = Number(value.premiumLeft || 0);
    const accountType = Number(value.accountType || 0);
    const premiumUntilMs = Number.isFinite(premiumLeftSec) && premiumLeftSec > 0 ? now + premiumLeftSec * 1000 : 0;
    const isPremium = premiumUntilMs > now || accountType > 0;
    const username = String(value.username || "").trim() || undefined;
    return {
      ...base,
      valid: true,
      isPremium,
      premiumUntilMs: premiumUntilMs > 0 ? premiumUntilMs : (accountType > 0 ? null : 0),
      email: username,
      message: premiumUntilMs > 0
        ? formatRemaining(premiumUntilMs, now)
        : (accountType > 0 ? "Premium aktiv" : "Kein Premium (Free)")
    };
  } catch (error) {
    const errText = compactErrorText(error);
    const aborted = signal?.aborted || /aborted/i.test(errText);
    return {
      ...base,
      message: aborted ? "Pruefung abgebrochen" : `Pruefung fehlgeschlagen: ${errText}`
    };
  }
}

/** Check ALL configured multi-account credentials (Mega-Debrid accounts +
 *  Debrid-Link keys) concurrently. Returns one status per account id. */
export async function checkAllDebridAccounts(
  settings: AppSettings,
  signal?: AbortSignal
): Promise<DebridAccountStatus[]> {
  const now = Date.now();
  const megaAccounts = parseMegaDebridAccounts(settings.megaCredentials || "", settings.megaPassword || "");
  const debridLinkKeys = parseDebridLinkApiKeys(settings.debridLinkApiKeys || "");

  // Each task is a thunk so we can throttle concurrency. Firing all accounts at
  // once (e.g. 9+ Debrid-Link keys) can trip provider rate-limits and produce
  // false "invalid" badges, so cap at CHECK_CONCURRENCY parallel checks.
  const taskFns: Array<() => Promise<DebridAccountStatus>> = [
    ...megaAccounts.map((account) => () => checkMegaDebridAccount(account, signal, now)),
    ...debridLinkKeys.map((key) => () => checkDebridLinkKey(key, signal, now))
  ];

  const results = await runWithConcurrency(taskFns, CHECK_CONCURRENCY);
  logger.info(
    `Account-Check abgeschlossen: ${results.length} Accounts geprueft ` +
    `(${results.filter((r) => r.valid).length} gueltig, ${results.filter((r) => r.isPremium).length} premium)`
  );
  return results;
}

const CHECK_CONCURRENCY = 4;

/** Run thunks with a bounded number in flight, preserving result order. */
async function runWithConcurrency<T>(taskFns: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(taskFns.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < taskFns.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await taskFns[current]();
    }
  };
  const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
