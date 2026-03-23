import type { AppSettings, DebridProvider } from "./types";

export type ProviderByteMap = Partial<Record<DebridProvider, number>>;
export type DebridLinkKeyByteMap = Record<string, number>;

type ProviderDailySettings =
  Pick<AppSettings, "providerDailyLimitBytes" | "providerDailyUsageBytes" | "providerDailyUsageDay">
  & Partial<Pick<AppSettings, "debridLinkApiKeyDailyLimitBytes" | "debridLinkApiKeyDailyUsageBytes">>
  & Partial<Pick<AppSettings, "megaDebridDisabledAccountIds" | "megaDebridAccountDailyLimitBytes" | "megaDebridAccountDailyUsageBytes">>;

type ProviderUsageSettings =
  ProviderDailySettings
  & Partial<Pick<AppSettings, "providerTotalUsageBytes" | "debridLinkApiKeyTotalUsageBytes">>
  & Partial<Pick<AppSettings, "megaDebridAccountTotalUsageBytes">>;

function normalizePositiveBytes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

export function getProviderUsageDayKey(epochMs = Date.now()): string {
  const current = new Date(epochMs);
  const year = current.getFullYear();
  const month = String(current.getMonth() + 1).padStart(2, "0");
  const day = String(current.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getProviderDailyLimitBytes(settings: ProviderDailySettings, provider: DebridProvider): number {
  return normalizePositiveBytes(settings.providerDailyLimitBytes?.[provider]);
}

export function getProviderDailyUsageBytes(
  settings: ProviderDailySettings,
  provider: DebridProvider,
  epochMs = Date.now()
): number {
  if (settings.providerDailyUsageDay !== getProviderUsageDayKey(epochMs)) {
    return 0;
  }
  return normalizePositiveBytes(settings.providerDailyUsageBytes?.[provider]);
}

export function getProviderDailyRemainingBytes(
  settings: ProviderDailySettings,
  provider: DebridProvider,
  epochMs = Date.now()
): number | null {
  const limit = getProviderDailyLimitBytes(settings, provider);
  if (limit <= 0) {
    return null;
  }
  return Math.max(0, limit - getProviderDailyUsageBytes(settings, provider, epochMs));
}

export function isProviderDailyLimitReached(
  settings: ProviderDailySettings,
  provider: DebridProvider,
  epochMs = Date.now()
): boolean {
  const limit = getProviderDailyLimitBytes(settings, provider);
  return limit > 0 && getProviderDailyUsageBytes(settings, provider, epochMs) >= limit;
}

export function getProviderTotalUsageBytes(settings: ProviderUsageSettings, provider: DebridProvider): number {
  return normalizePositiveBytes(settings.providerTotalUsageBytes?.[provider]);
}

export function resetProviderDailyUsage(
  settings: ProviderDailySettings,
  provider?: DebridProvider,
  epochMs = Date.now()
): Pick<AppSettings, "providerDailyUsageDay" | "providerDailyUsageBytes"> {
  const dayKey = getProviderUsageDayKey(epochMs);
  if (!provider) {
    return {
      providerDailyUsageDay: dayKey,
      providerDailyUsageBytes: {}
    };
  }

  const nextUsageBytes = settings.providerDailyUsageDay === dayKey
    ? { ...(settings.providerDailyUsageBytes || {}) }
    : {};
  delete nextUsageBytes[provider];

  return {
    providerDailyUsageDay: dayKey,
    providerDailyUsageBytes: nextUsageBytes
  };
}

export function addProviderDailyUsageBytes(
  settings: ProviderDailySettings,
  provider: DebridProvider,
  byteDelta: number,
  epochMs = Date.now()
): Pick<AppSettings, "providerDailyUsageDay" | "providerDailyUsageBytes"> {
  const increment = normalizePositiveBytes(byteDelta);
  const dayKey = getProviderUsageDayKey(epochMs);
  const currentUsageBytes = settings.providerDailyUsageDay === dayKey
    ? { ...(settings.providerDailyUsageBytes || {}) }
    : {};
  if (increment <= 0) {
    return {
      providerDailyUsageDay: dayKey,
      providerDailyUsageBytes: currentUsageBytes
    };
  }

  const nextUsageBytes = currentUsageBytes;
  nextUsageBytes[provider] = normalizePositiveBytes(nextUsageBytes[provider]) + increment;

  return {
    providerDailyUsageDay: dayKey,
    providerDailyUsageBytes: nextUsageBytes
  };
}

export function addProviderTotalUsageBytes(
  settings: ProviderUsageSettings,
  provider: DebridProvider,
  byteDelta: number
): Pick<AppSettings, "providerTotalUsageBytes"> {
  const increment = normalizePositiveBytes(byteDelta);
  const currentUsageBytes = { ...(settings.providerTotalUsageBytes || {}) };
  if (increment <= 0) {
    return {
      providerTotalUsageBytes: currentUsageBytes
    };
  }

  currentUsageBytes[provider] = normalizePositiveBytes(currentUsageBytes[provider]) + increment;

  return {
    providerTotalUsageBytes: currentUsageBytes
  };
}

export function getDebridLinkApiKeyDailyLimitBytes(settings: ProviderDailySettings, keyId: string): number {
  return normalizePositiveBytes(settings.debridLinkApiKeyDailyLimitBytes?.[keyId]);
}

export function getDebridLinkApiKeyDailyUsageBytes(
  settings: ProviderDailySettings,
  keyId: string,
  epochMs = Date.now()
): number {
  if (settings.providerDailyUsageDay !== getProviderUsageDayKey(epochMs)) {
    return 0;
  }
  return normalizePositiveBytes(settings.debridLinkApiKeyDailyUsageBytes?.[keyId]);
}

export function getDebridLinkApiKeyDailyRemainingBytes(
  settings: ProviderDailySettings,
  keyId: string,
  epochMs = Date.now()
): number | null {
  const limit = getDebridLinkApiKeyDailyLimitBytes(settings, keyId);
  if (limit <= 0) {
    return null;
  }
  return Math.max(0, limit - getDebridLinkApiKeyDailyUsageBytes(settings, keyId, epochMs));
}

export function isDebridLinkApiKeyDailyLimitReached(
  settings: ProviderDailySettings,
  keyId: string,
  epochMs = Date.now()
): boolean {
  const limit = getDebridLinkApiKeyDailyLimitBytes(settings, keyId);
  return limit > 0 && getDebridLinkApiKeyDailyUsageBytes(settings, keyId, epochMs) >= limit;
}

export function getDebridLinkApiKeyTotalUsageBytes(settings: ProviderUsageSettings, keyId: string): number {
  return normalizePositiveBytes(settings.debridLinkApiKeyTotalUsageBytes?.[keyId]);
}

export function resetDebridLinkApiKeyDailyUsage(
  settings: ProviderDailySettings,
  keyId?: string,
  epochMs = Date.now()
): Pick<AppSettings, "providerDailyUsageDay" | "debridLinkApiKeyDailyUsageBytes"> {
  const dayKey = getProviderUsageDayKey(epochMs);
  if (!keyId) {
    return {
      providerDailyUsageDay: dayKey,
      debridLinkApiKeyDailyUsageBytes: {}
    };
  }

  const nextUsageBytes = settings.providerDailyUsageDay === dayKey
    ? { ...(settings.debridLinkApiKeyDailyUsageBytes || {}) }
    : {};
  delete nextUsageBytes[keyId];

  return {
    providerDailyUsageDay: dayKey,
    debridLinkApiKeyDailyUsageBytes: nextUsageBytes
  };
}

export function addDebridLinkApiKeyDailyUsageBytes(
  settings: ProviderDailySettings,
  keyId: string,
  byteDelta: number,
  epochMs = Date.now()
): Pick<AppSettings, "providerDailyUsageDay" | "debridLinkApiKeyDailyUsageBytes"> {
  const increment = normalizePositiveBytes(byteDelta);
  const dayKey = getProviderUsageDayKey(epochMs);
  const currentUsageBytes = settings.providerDailyUsageDay === dayKey
    ? { ...(settings.debridLinkApiKeyDailyUsageBytes || {}) }
    : {};
  if (increment <= 0) {
    return {
      providerDailyUsageDay: dayKey,
      debridLinkApiKeyDailyUsageBytes: currentUsageBytes
    };
  }

  currentUsageBytes[keyId] = normalizePositiveBytes(currentUsageBytes[keyId]) + increment;

  return {
    providerDailyUsageDay: dayKey,
    debridLinkApiKeyDailyUsageBytes: currentUsageBytes
  };
}

export function addDebridLinkApiKeyTotalUsageBytes(
  settings: ProviderUsageSettings,
  keyId: string,
  byteDelta: number
): Pick<AppSettings, "debridLinkApiKeyTotalUsageBytes"> {
  const increment = normalizePositiveBytes(byteDelta);
  const currentUsageBytes = { ...(settings.debridLinkApiKeyTotalUsageBytes || {}) };
  if (increment <= 0) {
    return {
      debridLinkApiKeyTotalUsageBytes: currentUsageBytes
    };
  }

  currentUsageBytes[keyId] = normalizePositiveBytes(currentUsageBytes[keyId]) + increment;

  return {
    debridLinkApiKeyTotalUsageBytes: currentUsageBytes
  };
}

// ── Mega-Debrid per-account limits ──

export function isMegaDebridAccountDisabled(settings: ProviderDailySettings, accountId: string): boolean {
  return Array.isArray(settings.megaDebridDisabledAccountIds) && settings.megaDebridDisabledAccountIds.includes(accountId);
}

export function getMegaDebridAccountDailyLimitBytes(settings: ProviderDailySettings, accountId: string): number {
  return normalizePositiveBytes(settings.megaDebridAccountDailyLimitBytes?.[accountId]);
}

export function getMegaDebridAccountDailyUsageBytes(
  settings: ProviderDailySettings,
  accountId: string,
  epochMs = Date.now()
): number {
  if (settings.providerDailyUsageDay !== getProviderUsageDayKey(epochMs)) {
    return 0;
  }
  return normalizePositiveBytes(settings.megaDebridAccountDailyUsageBytes?.[accountId]);
}

export function isMegaDebridAccountDailyLimitReached(
  settings: ProviderDailySettings,
  accountId: string,
  epochMs = Date.now()
): boolean {
  const limit = getMegaDebridAccountDailyLimitBytes(settings, accountId);
  return limit > 0 && getMegaDebridAccountDailyUsageBytes(settings, accountId, epochMs) >= limit;
}

export function getMegaDebridAccountTotalUsageBytes(settings: ProviderUsageSettings, accountId: string): number {
  return normalizePositiveBytes(settings.megaDebridAccountTotalUsageBytes?.[accountId]);
}

export function addMegaDebridAccountDailyUsageBytes(
  settings: ProviderDailySettings,
  accountId: string,
  byteDelta: number,
  epochMs = Date.now()
): Pick<AppSettings, "providerDailyUsageDay" | "megaDebridAccountDailyUsageBytes"> {
  const increment = normalizePositiveBytes(byteDelta);
  const dayKey = getProviderUsageDayKey(epochMs);
  const currentUsageBytes = settings.providerDailyUsageDay === dayKey
    ? { ...(settings.megaDebridAccountDailyUsageBytes || {}) }
    : {};
  if (increment <= 0) {
    return {
      providerDailyUsageDay: dayKey,
      megaDebridAccountDailyUsageBytes: currentUsageBytes
    };
  }

  currentUsageBytes[accountId] = normalizePositiveBytes(currentUsageBytes[accountId]) + increment;

  return {
    providerDailyUsageDay: dayKey,
    megaDebridAccountDailyUsageBytes: currentUsageBytes
  };
}

export function addMegaDebridAccountTotalUsageBytes(
  settings: ProviderUsageSettings,
  accountId: string,
  byteDelta: number
): Pick<AppSettings, "megaDebridAccountTotalUsageBytes"> {
  const increment = normalizePositiveBytes(byteDelta);
  const currentUsageBytes = { ...(settings.megaDebridAccountTotalUsageBytes || {}) };
  if (increment <= 0) {
    return {
      megaDebridAccountTotalUsageBytes: currentUsageBytes
    };
  }

  currentUsageBytes[accountId] = normalizePositiveBytes(currentUsageBytes[accountId]) + increment;

  return {
    megaDebridAccountTotalUsageBytes: currentUsageBytes
  };
}
