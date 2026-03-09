import { getDebridLinkApiKeyIds } from "../shared/debrid-link-keys";
import type { AppSettings, HistoryEntry, UiSnapshot } from "../shared/types";

function hasText(value: unknown): boolean {
  return String(value || "").trim().length > 0;
}

export function buildAccountSummary(settings: AppSettings): Record<string, unknown> {
  const debridLinkKeyIds = getDebridLinkApiKeyIds(settings.debridLinkApiKeys);
  const disabledDebridLinkIds = new Set(settings.debridLinkDisabledKeyIds || []);

  return {
    realDebrid: {
      configured: hasText(settings.token) || settings.realDebridUseWebLogin,
      tokenConfigured: hasText(settings.token),
      webLoginEnabled: settings.realDebridUseWebLogin,
      rememberToken: settings.rememberToken
    },
    megaDebrid: {
      configured: (hasText(settings.megaLogin) && hasText(settings.megaPassword))
        || settings.megaDebridApiEnabled
        || settings.megaDebridWebEnabled,
      loginConfigured: hasText(settings.megaLogin) && hasText(settings.megaPassword),
      apiEnabled: settings.megaDebridApiEnabled,
      webEnabled: settings.megaDebridWebEnabled,
      preferApi: settings.megaDebridPreferApi
    },
    bestDebrid: {
      configured: hasText(settings.bestToken) || settings.bestDebridUseWebLogin,
      tokenConfigured: hasText(settings.bestToken),
      webLoginEnabled: settings.bestDebridUseWebLogin
    },
    allDebrid: {
      configured: hasText(settings.allDebridToken) || settings.allDebridUseWebLogin,
      tokenConfigured: hasText(settings.allDebridToken),
      webLoginEnabled: settings.allDebridUseWebLogin
    },
    ddownload: {
      configured: hasText(settings.ddownloadLogin) && hasText(settings.ddownloadPassword)
    },
    oneFichier: {
      configured: hasText(settings.oneFichierApiKey)
    },
    debridLink: {
      configured: debridLinkKeyIds.length > 0,
      keyCount: debridLinkKeyIds.length,
      enabledKeyCount: debridLinkKeyIds.filter((id) => !disabledDebridLinkIds.has(id)).length,
      disabledKeyCount: debridLinkKeyIds.filter((id) => disabledDebridLinkIds.has(id)).length
    },
    linkSnappy: {
      configured: hasText(settings.linkSnappyLogin) && hasText(settings.linkSnappyPassword)
    },
    disabledProviders: [...(settings.disabledProviders || [])]
  };
}

export function diffAccountSummary(previous: AppSettings, next: AppSettings): Record<string, unknown> {
  const before = buildAccountSummary(previous);
  const after = buildAccountSummary(next);
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const beforeJson = JSON.stringify(before[key]);
    const afterJson = JSON.stringify(after[key]);
    if (beforeJson !== afterJson) {
      changes[key] = after[key];
    }
  }
  return changes;
}

export function buildRedactedSettingsPayload(settings: AppSettings): Record<string, unknown> {
  return {
    paths: {
      outputDir: settings.outputDir,
      extractDir: settings.extractDir,
      mkvLibraryDir: settings.mkvLibraryDir
    },
    providers: {
      providerOrder: settings.providerOrder,
      providerPrimary: settings.providerPrimary,
      providerSecondary: settings.providerSecondary,
      providerTertiary: settings.providerTertiary,
      autoProviderFallback: settings.autoProviderFallback,
      disabledProviders: settings.disabledProviders,
      hosterRouting: settings.hosterRouting
    },
    extraction: {
      autoExtract: settings.autoExtract,
      autoExtractWhenStopped: settings.autoExtractWhenStopped,
      hybridExtract: settings.hybridExtract,
      createExtractSubfolder: settings.createExtractSubfolder,
      cleanupMode: settings.cleanupMode,
      extractConflictMode: settings.extractConflictMode,
      removeLinkFilesAfterExtract: settings.removeLinkFilesAfterExtract,
      removeSamplesAfterExtract: settings.removeSamplesAfterExtract,
      enableIntegrityCheck: settings.enableIntegrityCheck,
      archivePasswordCount: String(settings.archivePasswordList || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .length,
      extractCpuPriority: settings.extractCpuPriority,
      maxParallelExtract: settings.maxParallelExtract
    },
    downloads: {
      maxParallel: settings.maxParallel,
      retryLimit: settings.retryLimit,
      autoResumeOnStart: settings.autoResumeOnStart,
      autoReconnect: settings.autoReconnect,
      reconnectWaitSeconds: settings.reconnectWaitSeconds,
      autoSkipExtracted: settings.autoSkipExtracted,
      completedCleanupPolicy: settings.completedCleanupPolicy
    },
    ui: {
      packageName: settings.packageName,
      theme: settings.theme,
      collapseNewPackages: settings.collapseNewPackages,
      hideExtractedItems: settings.hideExtractedItems,
      confirmDeleteSelection: settings.confirmDeleteSelection,
      clipboardWatch: settings.clipboardWatch,
      minimizeToTray: settings.minimizeToTray,
      columnOrder: settings.columnOrder
    },
    bandwidth: {
      speedLimitEnabled: settings.speedLimitEnabled,
      speedLimitKbps: settings.speedLimitKbps,
      speedLimitMode: settings.speedLimitMode,
      bandwidthSchedules: settings.bandwidthSchedules
    },
    updates: {
      updateRepo: settings.updateRepo,
      autoUpdateCheck: settings.autoUpdateCheck
    },
    statistics: {
      totalDownloadedAllTime: settings.totalDownloadedAllTime,
      totalCompletedFilesAllTime: settings.totalCompletedFilesAllTime,
      totalRuntimeAllTimeMs: settings.totalRuntimeAllTimeMs,
      providerDailyLimitBytes: settings.providerDailyLimitBytes,
      providerDailyUsageBytes: settings.providerDailyUsageBytes,
      providerTotalUsageBytes: settings.providerTotalUsageBytes,
      debridLinkApiKeyDailyLimitBytes: settings.debridLinkApiKeyDailyLimitBytes,
      debridLinkApiKeyDailyUsageBytes: settings.debridLinkApiKeyDailyUsageBytes,
      debridLinkApiKeyTotalUsageBytes: settings.debridLinkApiKeyTotalUsageBytes,
      providerDailyUsageDay: settings.providerDailyUsageDay
    },
    accounts: buildAccountSummary(settings)
  };
}

export function buildStatsPayload(snapshot: UiSnapshot): Record<string, unknown> {
  return {
    session: snapshot.stats,
    totals: {
      totalPackages: Object.keys(snapshot.session.packages).length,
      totalItems: Object.keys(snapshot.session.items).length,
      speedText: snapshot.speedText,
      etaText: snapshot.etaText,
      canStart: snapshot.canStart,
      canStop: snapshot.canStop,
      canPause: snapshot.canPause
    }
  };
}

export function summarizeHistoryEntry(entry: HistoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    provider: entry.provider,
    fileCount: entry.fileCount,
    totalBytes: entry.totalBytes,
    downloadedBytes: entry.downloadedBytes,
    durationSeconds: entry.durationSeconds,
    completedAt: entry.completedAt,
    outputDir: entry.outputDir,
    urlCount: Array.isArray(entry.urls) ? entry.urls.length : 0
  };
}
