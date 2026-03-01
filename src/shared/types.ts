export type DownloadStatus =
  | "queued"
  | "validating"
  | "downloading"
  | "paused"
  | "reconnect_wait"
  | "extracting"
  | "integrity_check"
  | "completed"
  | "failed"
  | "cancelled";

export type CleanupMode = "none" | "trash" | "delete";
export type ConflictMode = "overwrite" | "skip" | "rename" | "ask";
export type SpeedMode = "global" | "per_download";
export type FinishedCleanupPolicy = "never" | "immediate" | "on_start" | "package_done";
export type DebridProvider = "realdebrid" | "megadebrid" | "bestdebrid" | "alldebrid";
export type DebridFallbackProvider = DebridProvider | "none";
export type AppTheme = "dark" | "light";

export interface BandwidthScheduleEntry {
  id: string;
  startHour: number;
  endHour: number;
  speedLimitKbps: number;
  enabled: boolean;
}

export interface DownloadStats {
  totalDownloaded: number;
  totalFiles: number;
  totalPackages: number;
  sessionStartedAt: number;
}

export interface AppSettings {
  token: string;
  megaLogin: string;
  megaPassword: string;
  bestToken: string;
  allDebridToken: string;
  archivePasswordList: string;
  rememberToken: boolean;
  providerPrimary: DebridProvider;
  providerSecondary: DebridFallbackProvider;
  providerTertiary: DebridFallbackProvider;
  autoProviderFallback: boolean;
  outputDir: string;
  packageName: string;
  autoExtract: boolean;
  autoRename4sf4sj: boolean;
  extractDir: string;
  collectMkvToLibrary: boolean;
  mkvLibraryDir: string;
  createExtractSubfolder: boolean;
  hybridExtract: boolean;
  cleanupMode: CleanupMode;
  extractConflictMode: ConflictMode;
  removeLinkFilesAfterExtract: boolean;
  removeSamplesAfterExtract: boolean;
  enableIntegrityCheck: boolean;
  autoResumeOnStart: boolean;
  autoReconnect: boolean;
  reconnectWaitSeconds: number;
  completedCleanupPolicy: FinishedCleanupPolicy;
  maxParallel: number;
  speedLimitEnabled: boolean;
  speedLimitKbps: number;
  speedLimitMode: SpeedMode;
  updateRepo: string;
  autoUpdateCheck: boolean;
  clipboardWatch: boolean;
  minimizeToTray: boolean;
  theme: AppTheme;
  bandwidthSchedules: BandwidthScheduleEntry[];
}

export interface DownloadItem {
  id: string;
  packageId: string;
  url: string;
  provider: DebridProvider | null;
  status: DownloadStatus;
  retries: number;
  speedBps: number;
  downloadedBytes: number;
  totalBytes: number | null;
  progressPercent: number;
  fileName: string;
  targetPath: string;
  resumable: boolean;
  attempts: number;
  lastError: string;
  fullStatus: string;
  createdAt: number;
  updatedAt: number;
}

export interface PackageEntry {
  id: string;
  name: string;
  outputDir: string;
  extractDir: string;
  status: DownloadStatus;
  itemIds: string[];
  cancelled: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SessionState {
  version: number;
  packageOrder: string[];
  packages: Record<string, PackageEntry>;
  items: Record<string, DownloadItem>;
  runStartedAt: number;
  totalDownloadedBytes: number;
  summaryText: string;
  reconnectUntil: number;
  reconnectReason: string;
  paused: boolean;
  running: boolean;
  updatedAt: number;
}

export interface DownloadSummary {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  extracted: number;
  durationSeconds: number;
  averageSpeedBps: number;
}

export interface ParsedPackageInput {
  name: string;
  links: string[];
  fileNames?: string[];
}

export interface ContainerImportResult {
  packages: ParsedPackageInput[];
  source: "dlc";
}

export interface UiSnapshot {
  settings: AppSettings;
  session: SessionState;
  summary: DownloadSummary | null;
  stats: DownloadStats;
  speedText: string;
  etaText: string;
  canStart: boolean;
  canStop: boolean;
  canPause: boolean;
  clipboardActive: boolean;
  reconnectSeconds: number;
}

export interface AddLinksPayload {
  rawText: string;
  packageName?: string;
  duplicatePolicy?: DuplicatePolicy;
}

export interface AddContainerPayload {
  filePaths: string[];
}

export type DuplicatePolicy = "keep" | "skip" | "overwrite";

export interface QueueAddResult {
  addedPackages: number;
  addedLinks: number;
  skippedExistingPackages: string[];
  overwrittenPackages: string[];
}

export interface ContainerConflictResult {
  conflicts: string[];
  packageCount: number;
  linkCount: number;
}

export interface StartConflictEntry {
  packageId: string;
  packageName: string;
  extractDir: string;
}

export interface StartConflictResolutionResult {
  skipped: boolean;
  overwritten: boolean;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  releaseUrl: string;
  setupAssetUrl?: string;
  setupAssetName?: string;
  setupAssetDigest?: string;
  error?: string;
}

export interface UpdateInstallResult {
  started: boolean;
  message: string;
}

export interface UpdateInstallProgress {
  stage: "starting" | "downloading" | "verifying" | "launching" | "done" | "error";
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
}

export interface ParsedHashEntry {
  fileName: string;
  algorithm: "crc32" | "md5" | "sha1";
  digest: string;
}
