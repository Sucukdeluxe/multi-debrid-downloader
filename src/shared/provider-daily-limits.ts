import type { AppSettings, DebridProvider } from "./types";

export type ProviderByteMap = Partial<Record<DebridProvider, number>>;
export type DebridLinkKeyByteMap = Record<string, number>;

type ProviderDailySettings =
  Pick<AppSettings, "providerDailyLimitBytes" | "providerDailyUsageBytes" | "providerDailyUsageDay">
  & Partial<Pick<AppSettings, "debridLinkApiKeyDailyLimitBytes" | "debridLinkApiKeyDailyUsageBytes">>;

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
