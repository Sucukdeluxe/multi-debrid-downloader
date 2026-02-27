import path from "node:path";
import os from "node:os";
import { AppSettings } from "../shared/types";

export const APP_NAME = "Debrid Download Manager";
export const APP_VERSION = "1.1.18";
export const API_BASE_URL = "https://api.real-debrid.com/rest/1.0";

export const DCRYPT_UPLOAD_URL = "https://dcrypt.it/decrypt/upload";
export const DLC_SERVICE_URL = "http://service.jdownloader.org/dlcrypt/service.php?srcType=dlc&destType=pylo&data={KEY}";
export const DLC_AES_KEY = Buffer.from("cb99b5cbc24db398", "utf8");
export const DLC_AES_IV = Buffer.from("9bc24cb995cb8db3", "utf8");

export const REQUEST_RETRIES = 3;
export const CHUNK_SIZE = 512 * 1024;

export const SAMPLE_DIR_NAMES = new Set(["sample", "samples"]);
export const SAMPLE_VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".m2ts", ".webm"]);
export const LINK_ARTIFACT_EXTENSIONS = new Set([".url", ".webloc", ".dlc", ".rsdf", ".ccf"]);
export const SAMPLE_TOKEN_RE = /(^|[._\-\s])sample([._\-\s]|$)/i;

export const ARCHIVE_TEMP_EXTENSIONS = new Set([".rar", ".zip", ".7z", ".tmp", ".part"]);
export const RAR_SPLIT_RE = /\.r\d{2}$/i;

export const DEFAULT_UPDATE_REPO = "Sucukdeluxe/real-debrid-downloader";

export function defaultSettings(): AppSettings {
  const baseDir = path.join(os.homedir(), "Downloads", "RealDebrid");
  return {
    token: "",
    megaToken: "",
    bestToken: "",
    allDebridToken: "",
    rememberToken: true,
    providerPrimary: "realdebrid",
    providerSecondary: "megadebrid",
    providerTertiary: "bestdebrid",
    autoProviderFallback: true,
    outputDir: baseDir,
    packageName: "",
    autoExtract: true,
    extractDir: path.join(baseDir, "_entpackt"),
    createExtractSubfolder: true,
    hybridExtract: true,
    cleanupMode: "none",
    extractConflictMode: "overwrite",
    removeLinkFilesAfterExtract: false,
    removeSamplesAfterExtract: false,
    enableIntegrityCheck: true,
    autoResumeOnStart: true,
    autoReconnect: false,
    reconnectWaitSeconds: 45,
    completedCleanupPolicy: "never",
    maxParallel: 4,
    speedLimitEnabled: false,
    speedLimitKbps: 0,
    speedLimitMode: "global",
    updateRepo: DEFAULT_UPDATE_REPO,
    autoUpdateCheck: true
  };
}
