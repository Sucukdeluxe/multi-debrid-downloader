import { DragEvent, KeyboardEvent, ReactElement, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppTheme,
  BandwidthScheduleEntry,
  DebridFallbackProvider,
  DebridProvider,
  DownloadItem,
  DownloadStats,
  DuplicatePolicy,
  HistoryEntry,
  PackageEntry,
  StartConflictEntry,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress
} from "../shared/types";
import { reorderPackageOrderByDrop, sortPackageOrderByName } from "./package-order";

type Tab = "collector" | "downloads" | "history" | "statistics" | "settings";
type SettingsSubTab = "allgemein" | "accounts" | "entpacken" | "geschwindigkeit" | "bereinigung" | "updates";

interface CollectorTab {
  id: string;
  name: string;
  text: string;
}

interface StartConflictPromptState {
  entry: StartConflictEntry;
  applyToAll: boolean;
}

interface ConfirmPromptState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  packageId: string;
  itemId?: string;
}

interface LinkPopupState {
  title: string;
  links: { name: string; url: string }[];
  isPackage: boolean;
}

const emptyStats = (): DownloadStats => ({
  totalDownloaded: 0,
  totalDownloadedAllTime: 0,
  totalFiles: 0,
  totalPackages: 0,
  sessionStartedAt: 0
});

const emptySnapshot = (): UiSnapshot => ({
  settings: {
    token: "", megaLogin: "", megaPassword: "", bestToken: "", allDebridToken: "",
    archivePasswordList: "",
    rememberToken: true, providerPrimary: "realdebrid", providerSecondary: "megadebrid",
    providerTertiary: "bestdebrid", autoProviderFallback: true, outputDir: "", packageName: "",
    autoExtract: true, autoRename4sf4sj: false, extractDir: "", createExtractSubfolder: true, hybridExtract: true,
    collectMkvToLibrary: false, mkvLibraryDir: "",
    cleanupMode: "none", extractConflictMode: "overwrite", removeLinkFilesAfterExtract: false,
    removeSamplesAfterExtract: false, enableIntegrityCheck: true, autoResumeOnStart: true,
    autoReconnect: false, reconnectWaitSeconds: 45, completedCleanupPolicy: "never",
    maxParallel: 4, maxParallelExtract: 2, retryLimit: 0, speedLimitEnabled: false, speedLimitKbps: 0, speedLimitMode: "global",
    updateRepo: "", autoUpdateCheck: true, clipboardWatch: false, minimizeToTray: false,
    theme: "dark", collapseNewPackages: true, autoSkipExtracted: false, confirmDeleteSelection: true,
    bandwidthSchedules: [], totalDownloadedAllTime: 0,
    columnOrder: ["name", "size", "progress", "hoster", "account", "prio", "status", "speed"]
  },
  session: {
    version: 2, packageOrder: [], packages: {}, items: {}, runStartedAt: 0,
    totalDownloadedBytes: 0, summaryText: "", reconnectUntil: 0, reconnectReason: "",
    paused: false, running: false, updatedAt: Date.now()
  },
  summary: null, stats: emptyStats(), speedText: "Geschwindigkeit: 0 B/s", etaText: "ETA: --",
  canStart: true, canStop: false, canPause: false, clipboardActive: false, reconnectSeconds: 0, packageSpeedBps: {}
});

const cleanupLabels: Record<string, string> = {
  never: "Nie", immediate: "Sofort", on_start: "Beim App-Start", package_done: "Sobald Paket fertig ist"
};

const AUTO_RENDER_PACKAGE_LIMIT = 260;

const providerLabels: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid", megadebrid: "Mega-Debrid", bestdebrid: "BestDebrid", alldebrid: "AllDebrid"
};

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} - ${hh}:${min}`;
}

function extractHoster(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch { return ""; }
}

function formatHoster(item: DownloadItem): string {
  const hoster = extractHoster(item.url);
  const label = hoster || "-";
  if (item.provider) {
    return `${label} via. ${providerLabels[item.provider]}`;
  }
  return label;
}

const settingsSubTabs: { key: SettingsSubTab; label: string }[] = [
  { key: "allgemein", label: "Allgemein" },
  { key: "accounts", label: "Accounts" },
  { key: "entpacken", label: "Entpacken" },
  { key: "geschwindigkeit", label: "Geschwindigkeit" },
  { key: "bereinigung", label: "Bereinigung" },
  { key: "updates", label: "Updates" },
];

function formatSpeedMbps(speedBps: number): string {
  const mbps = Math.max(0, speedBps || 0) / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
  if (bytes < 1024 * 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`; }
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(3)} TB`;
}

interface BandwidthChartProps {
  items: Record<string, DownloadItem>;
  running: boolean;
  paused: boolean;
  speedHistoryRef: React.MutableRefObject<{ time: number; speed: number }[]>;
}

const BandwidthChart = memo(function BandwidthChart({ items, running, paused, speedHistoryRef }: BandwidthChartProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpdateRef = useRef<number>(0);

  const animationFrameRef = useRef<number>(0);

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    const gridColor = isDark ? "rgba(35, 57, 84, 0.5)" : "rgba(199, 213, 234, 0.5)";
    const textColor = isDark ? "#90a4bf" : "#4e6482";
    const accentColor = isDark ? "#38bdf8" : "#1168d9";
    const fillColor = isDark ? "rgba(56, 189, 248, 0.15)" : "rgba(17, 104, 217, 0.15)";

    const history = speedHistoryRef.current;
    const now = Date.now();
    const maxTime = now;
    const minTime = now - 60000;

    let maxSpeed = 0;
    for (const point of history) {
      if (point.speed > maxSpeed) maxSpeed = point.speed;
    }
    maxSpeed = Math.max(maxSpeed, 1024 * 1024);
    const niceMax = Math.pow(2, Math.ceil(Math.log2(maxSpeed)));

    // Measure widest label to set dynamic left padding
    ctx.font = "11px 'Manrope', sans-serif";
    let maxLabelWidth = 0;
    for (let i = 0; i <= 5; i += 1) {
      const speedVal = niceMax * (1 - i / 5);
      const w = ctx.measureText(formatSpeedMbps(speedVal)).width;
      if (w > maxLabelWidth) maxLabelWidth = w;
    }
    const padding = { top: 20, right: 20, bottom: 30, left: Math.ceil(maxLabelWidth) + 16 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (chartHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    ctx.fillStyle = textColor;
    ctx.font = "11px 'Manrope', sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (chartHeight / 5) * i;
      const speedVal = niceMax * (1 - i / 5);
      ctx.fillText(formatSpeedMbps(speedVal), padding.left - 8, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0s", padding.left, height - padding.bottom + 8);
    ctx.fillText("30s", padding.left + chartWidth / 2, height - padding.bottom + 8);
    ctx.fillText("60s", width - padding.right, height - padding.bottom + 8);

    if (history.length < 2) {
      ctx.fillStyle = textColor;
      ctx.font = "13px 'Manrope', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(running ? (paused ? "Pausiert" : "Sammle Daten...") : "Download starten für Statistiken", width / 2, height / 2);
      return;
    }

    const points: { x: number; y: number }[] = [];
    for (const point of history) {
      const x = padding.left + ((point.time - minTime) / 60000) * chartWidth;
      const y = padding.top + chartHeight - (point.speed / niceMax) * chartHeight;
      points.push({ x, y });
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
    ctx.lineTo(points[0].x, padding.top + chartHeight);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    const lastPoint = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = accentColor;
    ctx.fill();
  }, [running, paused]);

  useEffect(() => {
    const interval = setInterval(() => {
      drawChart();
    }, 250);
    return () => clearInterval(interval);
  }, [drawChart]);

  useEffect(() => {
    // Only record samples while the session is running and not paused
    if (!running || paused) return;

    const now = Date.now();
    const activeItems = Object.values(items).filter((item) => item.status === "downloading");
    if (activeItems.length === 0) return;

    const totalSpeed = activeItems.reduce((sum, item) => sum + (item.speedBps || 0), 0);

    const history = speedHistoryRef.current;
    history.push({ time: now, speed: totalSpeed });

    const cutoff = now - 60000;
    let trimIndex = 0;
    while (trimIndex < history.length && history[trimIndex].time < cutoff) {
      trimIndex += 1;
    }
    if (trimIndex > 0) {
      speedHistoryRef.current = history.slice(trimIndex);
    }

    lastUpdateRef.current = now;
  }, [items, paused, running]);

  useEffect(() => {
    const handleResize = () => {
      animationFrameRef.current = requestAnimationFrame(drawChart);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [drawChart]);

  useEffect(() => {
    drawChart();
  }, [drawChart, items, paused]);

  return (
    <div ref={containerRef} className="bandwidth-chart-container">
      <canvas ref={canvasRef} />
    </div>
  );
});

let nextCollectorId = 1;

function createScheduleId(): string {
  return `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}


function sortPackageOrderBySize(order: string[], packages: Record<string, PackageEntry>, items: Record<string, DownloadItem>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const sizeA = (packages[a]?.itemIds ?? []).reduce((sum, id) => sum + (items[id]?.totalBytes || items[id]?.downloadedBytes || 0), 0);
    const sizeB = (packages[b]?.itemIds ?? []).reduce((sum, id) => sum + (items[id]?.totalBytes || items[id]?.downloadedBytes || 0), 0);
    const cmp = sizeA - sizeB;
    return descending ? -cmp : cmp;
  });
  return sorted;
}

function sortPackageOrderByHoster(order: string[], packages: Record<string, PackageEntry>, items: Record<string, DownloadItem>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const hosterA = [...new Set((packages[a]?.itemIds ?? []).map((id) => items[id]?.provider).filter(Boolean))].join(",").toLowerCase();
    const hosterB = [...new Set((packages[b]?.itemIds ?? []).map((id) => items[id]?.provider).filter(Boolean))].join(",").toLowerCase();
    const cmp = hosterA.localeCompare(hosterB);
    return descending ? -cmp : cmp;
  });
  return sorted;
}

function sortPackageOrderByProgress(order: string[], packages: Record<string, PackageEntry>, items: Record<string, DownloadItem>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const progressA = computePackageProgress(packages[a], items);
    const progressB = computePackageProgress(packages[b], items);
    const cmp = progressA - progressB;
    return descending ? -cmp : cmp;
  });
  return sorted;
}

function computePackageProgress(pkg: PackageEntry | undefined, items: Record<string, DownloadItem>): number {
  if (!pkg) return 0;
  const ids = pkg.itemIds ?? [];
  if (ids.length === 0) return 0;
  let totalDown = 0;
  let totalSize = 0;
  for (const id of ids) {
    const item = items[id];
    if (!item) continue;
    totalDown += item.downloadedBytes || 0;
    totalSize += item.totalBytes || item.downloadedBytes || 0;
  }
  return totalSize > 0 ? totalDown / totalSize : 0;
}

type PkgSortColumn = "name" | "size" | "hoster" | "progress";

const DEFAULT_COLUMN_ORDER = ["name", "size", "progress", "hoster", "account", "prio", "status", "speed"];
const ALL_COLUMN_KEYS = ["name", "size", "progress", "hoster", "account", "prio", "status", "speed", "added"];
const COLUMN_DEFS: Record<string, { label: string; width: string; sortable?: PkgSortColumn }> = {
  name:     { label: "Name",            width: "1fr",   sortable: "name" },
  size:     { label: "Geladen / Größe", width: "160px", sortable: "size" },
  progress: { label: "Fortschritt",     width: "80px",  sortable: "progress" },
  hoster:   { label: "Hoster",          width: "110px", sortable: "hoster" },
  account:  { label: "Service",         width: "110px" },
  prio:     { label: "Priorität",       width: "70px" },
  status:   { label: "Status",          width: "160px" },
  speed:    { label: "Geschwindigkeit", width: "90px" },
  added:    { label: "Hinzugefügt am",  width: "155px" },
};

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function formatMbpsInputFromKbps(kbps: number): string {
  const mbps = Math.max(0, Number(kbps) || 0) / 1024;
  return String(Number(mbps.toFixed(2)));
}

function parseMbpsInput(value: string): number | null {
  const normalized = String(value || "").trim().replace(/,/g, ".");
  if (!normalized) {
    return 0;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function formatUpdateInstallProgress(progress: UpdateInstallProgress): string {
  if (progress.stage === "downloading") {
    if (progress.totalBytes && progress.totalBytes > 0 && progress.percent !== null) {
      return `Update-Download: ${progress.percent}% (${humanSize(progress.downloadedBytes)} / ${humanSize(progress.totalBytes)})`;
    }
    return `Update-Download: ${humanSize(progress.downloadedBytes)}`;
  }
  if (progress.stage === "starting") {
    return "Update wird vorbereitet...";
  }
  if (progress.stage === "verifying") {
    return "Download fertig | Prüfe Integrität...";
  }
  if (progress.stage === "launching") {
    return "Starte Installer...";
  }
  if (progress.stage === "done") {
    return "Installer gestartet";
  }
  return `Update-Fehler: ${progress.message}`;
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<UiSnapshot>(emptySnapshot);
  const [appVersion, setAppVersion] = useState("");
  const [tab, setTab] = useState<Tab>("downloads");
  const [statusToast, setStatusToast] = useState("");
  const [updateInstallProgress, setUpdateInstallProgress] = useState<UpdateInstallProgress | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(emptySnapshot().settings);
  const [speedLimitInput, setSpeedLimitInput] = useState(() => formatMbpsInputFromKbps(emptySnapshot().settings.speedLimitKbps));
  const [scheduleSpeedInputs, setScheduleSpeedInputs] = useState<Record<string, string>>({});
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  const settingsDraftRevisionRef = useRef(0);
  const latestStateRef = useRef<UiSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const stateFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [collectorTabs, setCollectorTabs] = useState<CollectorTab[]>([
    { id: `tab-${nextCollectorId++}`, name: "Tab 1", text: "" }
  ]);
  const [activeCollectorTab, setActiveCollectorTab] = useState(collectorTabs[0].id);
  const collectorTabsRef = useRef<CollectorTab[]>(collectorTabs);
  const activeCollectorTabRef = useRef(activeCollectorTab);
  const activeTabRef = useRef<Tab>(tab);
  const packageOrderRef = useRef<string[]>([]);
  const serverPackageOrderRef = useRef<string[]>([]);
  const pendingPackageOrderRef = useRef<string[] | null>(null);
  const pendingPackageOrderAtRef = useRef(0);
  const draggedPackageIdRef = useRef<string | null>(null);
  const [collapsedPackages, setCollapsedPackages] = useState<Record<string, boolean>>({});
  const [downloadSearch, setDownloadSearch] = useState("");
  const [downloadsSortColumn, setDownloadsSortColumn] = useState<PkgSortColumn>("name");
  const [downloadsSortDescending, setDownloadsSortDescending] = useState(false);
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);
  const actionUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const dragOverRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>("allgemein");
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [startConflictPrompt, setStartConflictPrompt] = useState<StartConflictPromptState | null>(null);
  const startConflictResolverRef = useRef<((result: { policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null) => void) | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<ConfirmPromptState | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmQueueRef = useRef<Array<{ prompt: ConfirmPromptState; resolve: (confirmed: boolean) => void }>>([]);
  const importQueueFocusHandlerRef = useRef<(() => void) | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [linkPopup, setLinkPopup] = useState<LinkPopupState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: Set<string>; dontAsk: boolean } | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => DEFAULT_COLUMN_ORDER);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dropTargetCol, setDropTargetCol] = useState<string | null>(null);
  const [colHeaderCtx, setColHeaderCtx] = useState<{ x: number; y: number } | null>(null);
  const colHeaderCtxRef = useRef<HTMLDivElement>(null);
  const colHeaderBarRef = useRef<HTMLDivElement>(null);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const historyEntriesRef = useRef<HistoryEntry[]>([]);
  const [historyCollapsed, setHistoryCollapsed] = useState<Record<string, boolean>>({});
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const [historyCtxMenu, setHistoryCtxMenu] = useState<{ x: number; y: number; entryId: string } | null>(null);
  const historyCtxMenuRef = useRef<HTMLDivElement>(null);

  // Load history when tab changes to history
  useEffect(() => {
    if (tab !== "history") return;
    const loadHistory = async (): Promise<void> => {
      try {
        const entries = await window.rd.getHistory();
        console.log("History loaded:", entries);
        if (mountedRef.current && entries) {
          setHistoryEntries(entries);
        }
      } catch (err) {
        console.error("Failed to load history:", err);
      }
    };
    void loadHistory();
  }, [tab]);

  useEffect(() => { historyEntriesRef.current = historyEntries; }, [historyEntries]);

  // Sync column order from settings (value-based comparison to avoid reference issues)
  const columnOrderJson = JSON.stringify(snapshot.settings.columnOrder);
  useEffect(() => {
    const order = snapshot.settings.columnOrder;
    if (order && order.length > 0) {
      setColumnOrder(order);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnOrderJson]);

  const currentCollectorTab = collectorTabs.find((t) => t.id === activeCollectorTab) ?? collectorTabs[0];

  useEffect(() => {
    activeCollectorTabRef.current = activeCollectorTab;
  }, [activeCollectorTab]);

  useEffect(() => {
    collectorTabsRef.current = collectorTabs;
  }, [collectorTabs]);

  useEffect(() => {
    activeTabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    const incoming = snapshot.session.packageOrder;
    serverPackageOrderRef.current = incoming;

    const pending = pendingPackageOrderRef.current;
    if (!pending) {
      packageOrderRef.current = incoming;
      return;
    }

    if (sameStringArray(pending, incoming)) {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = incoming;
      return;
    }

    const maxOptimisticHoldMs = 1500;
    if (Date.now() - pendingPackageOrderAtRef.current >= maxOptimisticHoldMs) {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = incoming;
      return;
    }

    packageOrderRef.current = pending;
  }, [snapshot.session.packageOrder]);

  useEffect(() => {
    setSpeedLimitInput(formatMbpsInputFromKbps(settingsDraft.speedLimitKbps));
  }, [settingsDraft.speedLimitKbps]);

  const showToast = useCallback((message: string, timeoutMs = 2200): void => {
    setStatusToast(message);
    if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); }
    toastTimerRef.current = setTimeout(() => {
      setStatusToast("");
      toastTimerRef.current = null;
    }, timeoutMs);
  }, []);

  const clearImportQueueFocusListener = useCallback((): void => {
    const handler = importQueueFocusHandlerRef.current;
    if (!handler) {
      return;
    }
    window.removeEventListener("focus", handler);
    importQueueFocusHandlerRef.current = null;
  }, []);

  useEffect(() => {
    document.title = `Multi Debrid Downloader${appVersion ? ` - v${appVersion}` : ""}`;
  }, [appVersion]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let unsubClipboard: (() => void) | null = null;
    let unsubUpdateInstallProgress: (() => void) | null = null;
    void window.rd.getVersion().then((v) => { if (mountedRef.current) { setAppVersion(v); } }).catch(() => undefined);
    void window.rd.getSnapshot().then((state) => {
      if (!mountedRef.current) {
        return;
      }
      setSnapshot(state);
      if (state.settings.columnOrder?.length > 0) {
        setColumnOrder(state.settings.columnOrder);
      }
      setSettingsDraft(state.settings);
      settingsDirtyRef.current = false;
      setSettingsDirty(false);
      applyTheme(state.settings.theme);
      if (state.settings.autoUpdateCheck) {
        void window.rd.checkUpdates().then((result) => {
          if (!mountedRef.current) {
            return;
          }
          void handleUpdateResult(result, "startup");
        }).catch(() => undefined);
      }
    }).catch((error) => {
      showToast(`Snapshot konnte nicht geladen werden: ${String(error)}`, 2800);
    });
    unsubscribe = window.rd.onStateUpdate((state) => {
      latestStateRef.current = state;
      if (stateFlushTimerRef.current) { return; }

      const itemCount = Object.keys(state.session.items).length;
      let flushDelay = itemCount >= 1500
        ? 900
        : itemCount >= 700
          ? 650
          : itemCount >= 250
            ? 400
            : 150;
      if (!state.session.running) {
        flushDelay = Math.min(flushDelay, 200);
      }
      if (activeTabRef.current !== "downloads") {
        flushDelay = Math.max(flushDelay, 800);
      }

      stateFlushTimerRef.current = setTimeout(() => {
        stateFlushTimerRef.current = null;
        if (latestStateRef.current) {
          const next = latestStateRef.current;
          setSnapshot(next);
          if (next.settings.columnOrder?.length > 0) {
            setColumnOrder(next.settings.columnOrder);
          }
          if (!settingsDirtyRef.current) {
            setSettingsDraft(next.settings);
          }
          latestStateRef.current = null;
        }
      }, flushDelay);
    });
    unsubClipboard = window.rd.onClipboardDetected((links) => {
      showToast(`Zwischenablage: ${links.length} Link(s) erkannt`, 3000);
      setCollectorTabs((prev) => {
        const active = prev.find((t) => t.id === activeCollectorTabRef.current) ?? prev[0];
        if (!active) { return prev; }
        const newText = active.text ? `${active.text}\n${links.join("\n")}` : links.join("\n");
        return prev.map((t) => t.id === active.id ? { ...t, text: newText } : t);
      });
    });
    unsubUpdateInstallProgress = window.rd.onUpdateInstallProgress((progress) => {
      if (!mountedRef.current) {
        return;
      }
      setUpdateInstallProgress(progress);
    });
    return () => {
      mountedRef.current = false;
      if (stateFlushTimerRef.current) { clearTimeout(stateFlushTimerRef.current); }
      if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); }
      if (actionUnlockTimerRef.current) { clearTimeout(actionUnlockTimerRef.current); }
      clearImportQueueFocusListener();
      if (startConflictResolverRef.current) {
        const resolver = startConflictResolverRef.current;
        startConflictResolverRef.current = null;
        resolver(null);
      }
      if (confirmResolverRef.current) {
        const resolver = confirmResolverRef.current;
        confirmResolverRef.current = null;
        resolver(false);
      }
      while (confirmQueueRef.current.length > 0) {
        const request = confirmQueueRef.current.shift();
        request?.resolve(false);
      }
      if (unsubscribe) { unsubscribe(); }
      if (unsubClipboard) { unsubClipboard(); }
      if (unsubUpdateInstallProgress) { unsubUpdateInstallProgress(); }
    };
  }, [clearImportQueueFocusListener]);

  const downloadsTabActive = tab === "downloads";
  const deferredDownloadSearch = useDeferredValue(downloadSearch);
  const downloadSearchQuery = deferredDownloadSearch.trim().toLowerCase();
  const downloadSearchActive = downloadSearchQuery.length > 0;
  const gridTemplate = useMemo(() => columnOrder.map((col) => COLUMN_DEFS[col]?.width ?? "100px").join(" "), [columnOrder]);
  const totalPackageCount = snapshot.session.packageOrder.length;
  const shouldLimitPackageRendering = downloadsTabActive
    && snapshot.session.running
    && !downloadSearchActive
    && totalPackageCount > AUTO_RENDER_PACKAGE_LIMIT
    && !showAllPackages;

  const packageIdsForView = useMemo(() => {
    if (!downloadsTabActive) {
      return [] as string[];
    }
    if (downloadSearchActive) {
      return snapshot.session.packageOrder;
    }
    if (shouldLimitPackageRendering) {
      return snapshot.session.packageOrder.slice(0, AUTO_RENDER_PACKAGE_LIMIT);
    }
    return snapshot.session.packageOrder;
  }, [downloadsTabActive, downloadSearchActive, shouldLimitPackageRendering, snapshot.session.packageOrder]);

  const packageOrderKey = useMemo(() => {
    if (!downloadsTabActive) {
      return "";
    }
    return packageIdsForView.join("|");
  }, [downloadsTabActive, packageIdsForView]);

  const packages = useMemo(() => {
    if (!downloadsTabActive) {
      return [] as PackageEntry[];
    }

    if (downloadSearchActive) {
      return snapshot.session.packageOrder
        .map((id: string) => snapshot.session.packages[id])
        .filter((pkg): pkg is PackageEntry => Boolean(pkg) && pkg.name.toLowerCase().includes(downloadSearchQuery));
    }

    return packageIdsForView
      .map((id) => snapshot.session.packages[id])
      .filter((pkg): pkg is PackageEntry => Boolean(pkg));
  }, [downloadsTabActive, downloadSearchActive, downloadSearchQuery, packageIdsForView, snapshot.session.packageOrder, snapshot.session.packages]);

  const packagePosition = useMemo(() => {
    if (!downloadsTabActive) {
      return new Map<string, number>();
    }
    const map = new Map<string, number>();
    snapshot.session.packageOrder.forEach((id, index) => {
      map.set(id, index);
    });
    return map;
  }, [downloadsTabActive, snapshot.session.packageOrder]);

  const itemsByPackage = useMemo(() => {
    if (!downloadsTabActive) {
      return new Map<string, DownloadItem[]>();
    }
    const map = new Map<string, DownloadItem[]>();
    for (const pkg of packages) {
      const items = pkg.itemIds
        .map((id) => snapshot.session.items[id])
        .filter(Boolean) as DownloadItem[];
      map.set(pkg.id, items);
    }
    return map;
  }, [downloadsTabActive, packageOrderKey, packages, snapshot.session.items]);

  useEffect(() => {
    if (!downloadsTabActive) {
      return;
    }
    setCollapsedPackages((prev) => {
      let changed = false;
      const next: Record<string, boolean> = { ...prev };
      const defaultCollapsed = totalPackageCount >= 24;
      for (const packageId of snapshot.session.packageOrder) {
        if (!(packageId in prev)) {
          next[packageId] = defaultCollapsed;
          changed = true;
        }
      }
      for (const packageId of Object.keys(next)) {
        if (!snapshot.session.packages[packageId]) {
          delete next[packageId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [downloadsTabActive, packageOrderKey, snapshot.session.packageOrder, snapshot.session.packages, totalPackageCount]);

  const hiddenPackageCount = shouldLimitPackageRendering
    ? Math.max(0, totalPackageCount - packages.length)
    : 0;
  const visiblePackages = useMemo(() => {
    if (!snapshot.session.running || packages.length <= 1) {
      return packages;
    }
    const activeStatuses = new Set(["downloading", "validating", "integrity_check", "extracting"]);
    const active: PackageEntry[] = [];
    const rest: PackageEntry[] = [];
    for (const pkg of packages) {
      const hasActive = pkg.itemIds.some((id) => {
        const item = snapshot.session.items[id];
        return item && activeStatuses.has(item.status);
      });
      if (hasActive) {
        active.push(pkg);
      } else {
        rest.push(pkg);
      }
    }
    if (active.length === 0 || active.length === packages.length) {
      return packages;
    }
    // Sort active packages: highest completion percentage first
    active.sort((a, b) => {
      const aItems = a.itemIds.map((id) => snapshot.session.items[id]).filter(Boolean);
      const bItems = b.itemIds.map((id) => snapshot.session.items[id]).filter(Boolean);
      const aPct = aItems.length > 0 ? aItems.filter((i) => i.status === "completed").length / aItems.length : 0;
      const bPct = bItems.length > 0 ? bItems.filter((i) => i.status === "completed").length / bItems.length : 0;
      if (aPct !== bPct) {
        return bPct - aPct;
      }
      const aBytes = aItems.reduce((s, i) => s + (i.downloadedBytes || 0), 0);
      const bBytes = bItems.reduce((s, i) => s + (i.downloadedBytes || 0), 0);
      return bBytes - aBytes;
    });
    return [...active, ...rest];
  }, [packages, snapshot.session.running, snapshot.session.items]);

  useEffect(() => {
    if (!snapshot.session.running) {
      setShowAllPackages(false);
    }
  }, [snapshot.session.running]);

  // Auto-expand packages that are currently extracting
  useEffect(() => {
    const extractingPkgIds: string[] = [];
    for (const pkg of packages) {
      if (collapsedPackages[pkg.id]) {
        const items = (pkg.itemIds ?? []).map((id) => snapshot.session.items[id]).filter(Boolean);
        const isExtracting = items.some((item) => item.fullStatus?.startsWith("Entpacken -") && !item.fullStatus?.includes("Done"));
        if (isExtracting) extractingPkgIds.push(pkg.id);
      }
    }
    if (extractingPkgIds.length > 0) {
      setCollapsedPackages((prev) => {
        const next = { ...prev };
        for (const id of extractingPkgIds) next[id] = false;
        return next;
      });
    }
  }, [packages, snapshot.session.items]);

  const allPackagesCollapsed = useMemo(() => (
    packages.length > 0 && packages.every((pkg) => collapsedPackages[pkg.id])
  ), [packages, collapsedPackages]);

  const configuredProviders = useMemo(() => {
    const list: DebridProvider[] = [];
    if (settingsDraft.token.trim()) {
      list.push("realdebrid");
    }
    if (settingsDraft.megaLogin.trim() && settingsDraft.megaPassword.trim()) {
      list.push("megadebrid");
    }
    if (settingsDraft.bestToken.trim()) {
      list.push("bestdebrid");
    }
    if (settingsDraft.allDebridToken.trim()) {
      list.push("alldebrid");
    }
    return list;
  }, [settingsDraft.token, settingsDraft.megaLogin, settingsDraft.megaPassword, settingsDraft.bestToken, settingsDraft.allDebridToken]);

  const primaryProviderValue: DebridProvider = useMemo(() => {
    if (configuredProviders.includes(settingsDraft.providerPrimary)) {
      return settingsDraft.providerPrimary;
    }
    return configuredProviders[0] ?? "realdebrid";
  }, [configuredProviders, settingsDraft.providerPrimary]);

  const secondaryProviderChoices = useMemo(() => (
    configuredProviders.filter((provider) => provider !== primaryProviderValue)
  ), [configuredProviders, primaryProviderValue]);

  const secondaryProviderValue: DebridFallbackProvider = useMemo(() => {
    if (secondaryProviderChoices.includes(settingsDraft.providerSecondary as DebridProvider)) {
      return settingsDraft.providerSecondary;
    }
    return "none";
  }, [secondaryProviderChoices, settingsDraft.providerSecondary]);

  const tertiaryProviderChoices = useMemo(() => {
    const blocked = new Set<string>([primaryProviderValue]);
    if (secondaryProviderValue !== "none") {
      blocked.add(secondaryProviderValue);
    }
    return configuredProviders.filter((provider) => !blocked.has(provider));
  }, [configuredProviders, primaryProviderValue, secondaryProviderValue]);

  const tertiaryProviderValue: DebridFallbackProvider = useMemo(() => {
    if (tertiaryProviderChoices.includes(settingsDraft.providerTertiary as DebridProvider)) {
      return settingsDraft.providerTertiary;
    }
    return "none";
  }, [tertiaryProviderChoices, settingsDraft.providerTertiary]);

  const normalizedSettingsDraft: AppSettings = useMemo(() => ({
    ...settingsDraft,
    providerPrimary: primaryProviderValue,
    providerSecondary: configuredProviders.length >= 2 ? secondaryProviderValue : "none",
    providerTertiary: configuredProviders.length >= 3 ? tertiaryProviderValue : "none"
  }), [
    settingsDraft,
    primaryProviderValue,
    configuredProviders.length,
    secondaryProviderValue,
    tertiaryProviderValue
  ]);

  const handleUpdateResult = async (result: UpdateCheckResult, source: "manual" | "startup"): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }
    if (result.error) {
      if (source === "manual") { showToast(`Update-Check fehlgeschlagen: ${result.error}`, 2800); }
      return;
    }
    if (!result.updateAvailable) {
      setUpdateInstallProgress(null);
      if (source === "manual") { showToast(`Kein Update verfügbar (v${result.currentVersion})`, 2000); }
      return;
    }
    const approved = await askConfirmPrompt({
      title: "Update verfügbar",
      message: `${result.latestTag} (aktuell v${result.currentVersion})\n\nJetzt automatisch herunterladen und installieren?`,
      confirmLabel: "Jetzt installieren"
    });
    if (!mountedRef.current) {
      return;
    }
    if (!approved) { showToast(`Update verfügbar: ${result.latestTag}`, 2600); return; }
    setUpdateInstallProgress({
      stage: "starting",
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Update wird vorbereitet"
    });
    const install = await window.rd.installUpdate();
    if (!mountedRef.current) {
      return;
    }
    if (install.started) { showToast("Updater gestartet - App wird geschlossen", 2600); return; }
    setUpdateInstallProgress({
      stage: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: install.message
    });
    showToast(`Auto-Update fehlgeschlagen: ${install.message}`, 3200);
  };

  const onSaveSettings = async (): Promise<void> => {
    await performQuickAction(async () => {
      const result = await persistDraftSettings();
      applyTheme(result.theme);
      showToast("Einstellungen gespeichert", 1800);
    }, (error) => {
      showToast(`Einstellungen konnten nicht gespeichert werden: ${String(error)}`, 2800);
    });
  };

  const onCheckUpdates = async (): Promise<void> => {
    await performQuickAction(async () => {
      setUpdateInstallProgress(null);
      const result = await window.rd.checkUpdates();
      await handleUpdateResult(result, "manual");
    }, (error) => {
      showToast(`Update-Check fehlgeschlagen: ${String(error)}`, 2800);
    });
  };

  const persistDraftSettings = async (): Promise<AppSettings> => {
    const revisionAtStart = settingsDraftRevisionRef.current;
    const result = await window.rd.updateSettings(normalizedSettingsDraft);
    if (settingsDraftRevisionRef.current === revisionAtStart) {
      setSettingsDraft(result);
      settingsDirtyRef.current = false;
      setSettingsDirty(false);
    }
    return result;
  };

  const closeStartConflictPrompt = (result: { policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null): void => {
    const resolver = startConflictResolverRef.current;
    startConflictResolverRef.current = null;
    setStartConflictPrompt(null);
    if (resolver) {
      resolver(result);
    }
  };

  const askStartConflictDecision = (entry: StartConflictEntry): Promise<{ policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null> => {
    return new Promise((resolve) => {
      startConflictResolverRef.current = resolve;
      setStartConflictPrompt({
        entry,
        applyToAll: false
      });
    });
  };

  const pumpConfirmQueue = useCallback((): void => {
    if (confirmResolverRef.current) {
      return;
    }
    const next = confirmQueueRef.current.shift();
    if (!next) {
      return;
    }
    confirmResolverRef.current = next.resolve;
    setConfirmPrompt(next.prompt);
  }, []);

  const closeConfirmPrompt = useCallback((confirmed: boolean): void => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmPrompt(null);
    if (resolver) {
      resolver(confirmed);
    }
    pumpConfirmQueue();
  }, [pumpConfirmQueue]);

  const askConfirmPrompt = useCallback((prompt: ConfirmPromptState): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmQueueRef.current.push({ prompt, resolve });
      pumpConfirmQueue();
    });
  }, [pumpConfirmQueue]);

  const onStartDownloads = async (): Promise<void> => {
    await performQuickAction(async () => {
      if (configuredProviders.length === 0) {
        setTab("settings");
        showToast("Bitte zuerst mindestens einen Hoster-Account eintragen", 3000);
        return;
      }

      await persistDraftSettings();
      const conflicts = await window.rd.getStartConflicts();
      let skipped = 0;
      let overwritten = 0;
      let rememberedPolicy: Extract<DuplicatePolicy, "skip" | "overwrite"> | null = null;

      if (settingsDraft.autoSkipExtracted && conflicts.length > 0) {
        rememberedPolicy = "skip";
      }

      for (const conflict of conflicts) {
        let decisionPolicy = rememberedPolicy;
        if (!decisionPolicy) {
          const decision = await askStartConflictDecision(conflict);
          if (!decision) {
            showToast("Start abgebrochen", 1800);
            return;
          }
          decisionPolicy = decision.policy;
          if (decision.applyToAll) {
            rememberedPolicy = decision.policy;
          }
        }

        const result = await window.rd.resolveStartConflict(conflict.packageId, decisionPolicy);
        if (result.skipped) {
          skipped += 1;
        }
        if (result.overwritten) {
          overwritten += 1;
        }
      }

      if (conflicts.length > 0 && !settingsDraft.autoSkipExtracted) {
        showToast(`Konflikte gelöst: ${overwritten} überschrieben, ${skipped} übersprungen`, 2800);
      }

      await window.rd.start();
    });
  };

  const collapseNewPackages = async (existingIds: Set<string>): Promise<void> => {
    const fresh = await window.rd.getSnapshot();
    const newIds = Object.keys(fresh.session.packages).filter((id) => !existingIds.has(id));
    if (newIds.length > 0) {
      setCollapsedPackages((prev) => {
        const next = { ...prev };
        for (const id of newIds) { next[id] = true; }
        return next;
      });
    }
  };

  const onAddLinks = async (): Promise<void> => {
    await performQuickAction(async () => {
      const activeId = activeCollectorTabRef.current;
      const active = collectorTabsRef.current.find((t) => t.id === activeId) ?? collectorTabsRef.current[0];
      const rawText = active?.text ?? "";
      const persisted = await persistDraftSettings();
      const existingIds = new Set(Object.keys(snapshot.session.packages));
      const result = await window.rd.addLinks({ rawText, packageName: persisted.packageName });
      if (result.addedLinks > 0) {
        showToast(`${result.addedPackages} Paket(e), ${result.addedLinks} Link(s) hinzugefügt`);
        setCollectorTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, text: "" } : t));
        if (snapshot.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
      } else {
        showToast("Keine gültigen Links gefunden");
      }
    }, (error) => {
      showToast(`Fehler beim Hinzufügen: ${String(error)}`, 2600);
    });
  };

  const onImportDlc = async (): Promise<void> => {
    await performQuickAction(async () => {
      const files = await window.rd.pickContainers();
      if (files.length === 0) { return; }
      await persistDraftSettings();
      const existingIds = new Set(Object.keys(snapshot.session.packages));
      const result = await window.rd.addContainers(files);
      if (result.addedLinks > 0) {
        showToast(`DLC importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
        if (snapshot.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
      } else {
        showToast("Keine gültigen Links in den DLC-Dateien gefunden", 3000);
      }
    }, (error) => {
      showToast(`Fehler beim DLC-Import: ${String(error)}`, 2600);
    });
  };

  const onDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault();
    dragDepthRef.current = 0;
    dragOverRef.current = false;
    setDragOver(false);
    const hasFiles = event.dataTransfer.types.includes("Files");
    const hasUri = event.dataTransfer.types.includes("text/uri-list");
    if (!hasFiles && !hasUri) { return; }
    const files = Array.from(event.dataTransfer.files ?? []) as File[];
    const dlc = files.filter((f) => f.name.toLowerCase().endsWith(".dlc")).map((f) => (f as unknown as { path?: string }).path).filter((v): v is string => !!v);
    const droppedText = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list") || "";
    if (dlc.length > 0) {
      await performQuickAction(async () => {
        await persistDraftSettings();
        const existingIds = new Set(Object.keys(snapshot.session.packages));
        const result = await window.rd.addContainers(dlc);
        if (result.addedLinks > 0) {
          showToast(`Drag-and-Drop: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
          if (snapshot.settings.collapseNewPackages) { await collapseNewPackages(existingIds); }
        } else {
          showToast("Keine gültigen Links in den DLC-Dateien gefunden", 3000);
        }
      }, (error) => {
        showToast(`Fehler bei Drag-and-Drop: ${String(error)}`, 2600);
      });
    } else if (droppedText.trim()) {
      const activeCollectorId = activeCollectorTabRef.current;
      setCollectorTabs((prev) => prev.map((t) => t.id === activeCollectorId
        ? { ...t, text: t.text ? `${t.text}\n${droppedText}` : droppedText } : t));
      setTab("collector");
      showToast("Links per Drag-and-Drop eingefügt");
    }
  };

  const onExportQueue = async (): Promise<void> => {
    await performQuickAction(async () => {
      const result = await window.rd.exportQueue();
      if (result.saved) {
        showToast("Queue exportiert");
      }
    }, (error) => {
      showToast(`Export fehlgeschlagen: ${String(error)}`, 2600);
    });
  };

  const onImportQueue = async (): Promise<void> => {
    if (actionBusyRef.current) {
      return;
    }

    actionBusyRef.current = true;
    setActionBusy(true);

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";

    const releasePickerBusy = (): void => {
      actionBusyRef.current = false;
      setActionBusy(false);
    };

    const onWindowFocus = (): void => {
      clearImportQueueFocusListener();
      if (!input.files || input.files.length === 0) {
        releasePickerBusy();
      }
    };

    input.onchange = async () => {
      clearImportQueueFocusListener();
      const file = input.files?.[0];
      if (!file) {
        releasePickerBusy();
        return;
      }
      releasePickerBusy();
      await performQuickAction(async () => {
        const text = await file.text();
        const result = await window.rd.importQueue(text);
        showToast(`Importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
      }, (error) => {
        showToast(`Import fehlgeschlagen: ${String(error)}`, 2600);
      });
    };

    clearImportQueueFocusListener();
    importQueueFocusHandlerRef.current = onWindowFocus;
    window.addEventListener("focus", onWindowFocus, { once: true });
    input.click();
  };

  const setBool = (key: keyof AppSettings, value: boolean): void => {
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };
  const setText = (key: keyof AppSettings, value: string): void => {
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };
  const setNum = (key: keyof AppSettings, value: number): void => {
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };
  const setSpeedLimitMbps = (value: number): void => {
    const mbps = Number.isFinite(value) ? Math.max(0, value) : 0;
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: Math.floor(mbps * 1024) }));
  };

  const performQuickAction = async (
    action: () => Promise<unknown>,
    onError?: (error: unknown) => void
  ): Promise<void> => {
    if (actionBusyRef.current) {
      return;
    }
    actionBusyRef.current = true;
    setActionBusy(true);
    try {
      await action();
    } catch (error) {
      if (onError) {
        onError(error);
      } else {
        showToast(`Fehler: ${String(error)}`, 2600);
      }
    } finally {
      if (actionUnlockTimerRef.current) {
        clearTimeout(actionUnlockTimerRef.current);
      }
      actionUnlockTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) {
          actionUnlockTimerRef.current = null;
          return;
        }
        actionBusyRef.current = false;
        setActionBusy(false);
        actionUnlockTimerRef.current = null;
      }, 80);
    }
  };

  const movePackage = useCallback((packageId: string, direction: "up" | "down") => {
    const currentOrder = packageOrderRef.current;
    const order = [...currentOrder];
    const idx = order.indexOf(packageId);
    if (idx < 0) { return; }
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= order.length) { return; }
    [order[idx], order[target]] = [order[target], order[idx]];
    setDownloadsSortDescending(false);
    pendingPackageOrderRef.current = [...order];
    pendingPackageOrderAtRef.current = Date.now();
    packageOrderRef.current = [...order];
    void window.rd.reorderPackages(order).catch((error) => {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = serverPackageOrderRef.current;
      showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const reorderPackagesByDrop = useCallback((draggedPackageId: string, targetPackageId: string) => {
    const currentOrder = packageOrderRef.current;
    const nextOrder = reorderPackageOrderByDrop(currentOrder, draggedPackageId, targetPackageId);
    const unchanged = nextOrder.length === currentOrder.length
      && nextOrder.every((id, index) => id === currentOrder[index]);
    if (unchanged) {
      return;
    }
    setDownloadsSortDescending(false);
    pendingPackageOrderRef.current = [...nextOrder];
    pendingPackageOrderAtRef.current = Date.now();
    packageOrderRef.current = [...nextOrder];
    void window.rd.reorderPackages(nextOrder).catch((error) => {
      pendingPackageOrderRef.current = null;
      pendingPackageOrderAtRef.current = 0;
      packageOrderRef.current = serverPackageOrderRef.current;
      showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const addCollectorTab = (): void => {
    const id = `tab-${nextCollectorId++}`;
    setCollectorTabs((prev) => {
      const name = `Tab ${prev.length + 1}`;
      return [...prev, { id, name, text: "" }];
    });
    setActiveCollectorTab(id);
  };

  const removeCollectorTab = (id: string): void => {
    let fallbackId = "";
    setCollectorTabs((prev) => {
      if (prev.length <= 1) {
        return prev;
      }
      const index = prev.findIndex((tabEntry) => tabEntry.id === id);
      if (index < 0) {
        return prev;
      }
      const next = prev.filter((tabEntry) => tabEntry.id !== id);
      if (activeCollectorTabRef.current === id) {
        fallbackId = next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "";
      }
      return next;
    });
    if (fallbackId) {
      setActiveCollectorTab(fallbackId);
    }
  };

  const onPackageDragStart = useCallback((packageId: string) => {
    draggedPackageIdRef.current = packageId;
  }, []);

  const onPackageDrop = useCallback((targetPackageId: string) => {
    const draggedPackageId = draggedPackageIdRef.current;
    draggedPackageIdRef.current = null;
    if (!draggedPackageId || draggedPackageId === targetPackageId) {
      return;
    }
    reorderPackagesByDrop(draggedPackageId, targetPackageId);
  }, [reorderPackagesByDrop]);

  const onPackageDragEnd = useCallback(() => {
    draggedPackageIdRef.current = null;
  }, []);

  const onPackageStartEdit = useCallback((packageId: string, packageName: string): void => {
    setEditingPackageId(packageId);
    setEditingName(packageName);
  }, []);

  const onPackageFinishEdit = useCallback((packageId: string, currentName: string, nextName: string): void => {
    setEditingPackageId(null);
    const normalized = nextName.trim();
    if (normalized && normalized !== currentName.trim()) {
      void window.rd.renamePackage(packageId, normalized).catch((error) => {
        showToast(`Umbenennen fehlgeschlagen: ${String(error)}`, 2400);
      });
    }
  }, [showToast]);

  const onPackageToggleCollapse = useCallback((packageId: string): void => {
    setCollapsedPackages((prev) => ({ ...prev, [packageId]: !(prev[packageId] ?? false) }));
  }, []);

  const onPackageCancel = useCallback((packageId: string): void => {
    setSnapshot((prev) => {
      if (!prev) { return prev; }
      const nextPackages = { ...prev.session.packages };
      const nextItems = { ...prev.session.items };
      const pkg = nextPackages[packageId];
      if (pkg) {
        for (const itemId of pkg.itemIds) {
          delete nextItems[itemId];
        }
        delete nextPackages[packageId];
      }
      return {
        ...prev,
        session: {
          ...prev.session,
          packages: nextPackages,
          items: nextItems,
          packageOrder: prev.session.packageOrder.filter((id) => id !== packageId)
        }
      };
    });
    void window.rd.cancelPackage(packageId).catch((error) => {
      showToast(`Paket-Löschung fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const onPackageMoveUp = useCallback((packageId: string): void => {
    movePackage(packageId, "up");
  }, [movePackage]);

  const onPackageMoveDown = useCallback((packageId: string): void => {
    movePackage(packageId, "down");
  }, [movePackage]);

  const onPackageToggle = useCallback((packageId: string): void => {
    void window.rd.togglePackage(packageId).catch((error) => {
      showToast(`Paket-Umschalten fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const onPackageRemoveItem = useCallback((itemId: string): void => {
    setSnapshot((prev) => {
      if (!prev) { return prev; }
      const item = prev.session.items[itemId];
      if (!item) { return prev; }
      const nextItems = { ...prev.session.items };
      delete nextItems[itemId];
      const nextPackages = { ...prev.session.packages };
      const pkg = nextPackages[item.packageId];
      if (pkg) {
        const nextItemIds = pkg.itemIds.filter((id) => id !== itemId);
        if (nextItemIds.length === 0) {
          delete nextPackages[item.packageId];
          return {
            ...prev,
            session: {
              ...prev.session,
              packages: nextPackages,
              items: nextItems,
              packageOrder: prev.session.packageOrder.filter((id) => id !== item.packageId)
            }
          };
        }
        nextPackages[item.packageId] = { ...pkg, itemIds: nextItemIds };
      }
      return { ...prev, session: { ...prev.session, packages: nextPackages, items: nextItems } };
    });
    void window.rd.removeItem(itemId).catch((error) => {
      showToast(`Entfernen fehlgeschlagen: ${String(error)}`, 2400);
    });
  }, [showToast]);

  const onPackageContextMenu = useCallback((packageId: string, itemId: string | undefined, x: number, y: number): void => {
    const clickedId = itemId ?? packageId;
    setSelectedIds((prev) => {
      if (prev.has(clickedId)) return prev;
      return new Set([clickedId]);
    });
    setContextMenu({ x, y, packageId, itemId });
  }, []);

  const speedHistoryRef = useRef<{ time: number; speed: number }[]>([]);
  const dragSelectRef = useRef(false);
  const dragAnchorRef = useRef<string | null>(null);
  const dragDidMoveRef = useRef(false);

  const onSelectId = useCallback((id: string, ctrlKey: boolean): void => {
    if (dragDidMoveRef.current) return; // drag handled it, skip click
    setSelectedIds((prev) => {
      if (ctrlKey) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      if (prev.size === 1 && prev.has(id)) return new Set();
      return new Set([id]);
    });
  }, []);

  const onSelectMouseDown = useCallback((id: string, e: React.MouseEvent): void => {
    if (!e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    dragSelectRef.current = true;
    dragAnchorRef.current = id;
    dragDidMoveRef.current = false;
    const onUp = (): void => {
      dragSelectRef.current = false;
      dragAnchorRef.current = null;
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mouseup", onUp);
  }, []);

  const onSelectMouseEnter = useCallback((id: string): void => {
    if (!dragSelectRef.current) return;
    if (!dragDidMoveRef.current) {
      dragDidMoveRef.current = true;
      // Add anchor item now that we know it's a drag
      const anchor = dragAnchorRef.current;
      if (anchor) {
        setSelectedIds((prev) => { if (prev.has(anchor)) return prev; const next = new Set(prev); next.add(anchor); return next; });
      }
    }
    setSelectedIds((prev) => { if (prev.has(id)) return prev; const next = new Set(prev); next.add(id); return next; });
  }, []);

  const showLinksPopup = useCallback((packageId: string, itemId?: string): void => {
    const sel = selectedIds;
    // Multi-select: collect links from all selected packages/items
    if (sel.size > 1) {
      const allLinks: { name: string; url: string }[] = [];
      for (const id of sel) {
        const pkg = snapshot.session.packages[id];
        if (pkg) {
          for (const iid of pkg.itemIds) {
            const item = snapshot.session.items[iid];
            if (item) allLinks.push({ name: item.fileName, url: item.url });
          }
        } else {
          const item = snapshot.session.items[id];
          if (item) allLinks.push({ name: item.fileName, url: item.url });
        }
      }
      setLinkPopup({ title: `${sel.size} ausgewählt`, links: allLinks, isPackage: allLinks.length > 1 });
      setContextMenu(null);
      return;
    }
    const pkg = snapshot.session.packages[packageId];
    if (!pkg) { return; }
    if (itemId) {
      const item = snapshot.session.items[itemId];
      if (item) {
        setLinkPopup({ title: item.fileName, links: [{ name: item.fileName, url: item.url }], isPackage: false });
      }
    } else {
      const links = pkg.itemIds
        .map((id) => snapshot.session.items[id])
        .filter(Boolean)
        .map((item) => ({ name: item.fileName, url: item.url }));
      setLinkPopup({ title: pkg.name, links, isPackage: true });
    }
    setContextMenu(null);
  }, [snapshot.session.packages, snapshot.session.items, selectedIds]);

  const schedules = settingsDraft.bandwidthSchedules ?? [];

  useEffect(() => {
    setScheduleSpeedInputs((prev) => {
      const syncFromSettings = !settingsDirtyRef.current;
      let changed = false;
      const next: Record<string, string> = {};
      for (let index = 0; index < schedules.length; index += 1) {
        const schedule = schedules[index];
        const key = schedule.id || `schedule-${index}`;
        const normalized = formatMbpsInputFromKbps(schedule.speedLimitKbps);
        if (syncFromSettings || !Object.prototype.hasOwnProperty.call(prev, key)) {
          next[key] = normalized;
          if (prev[key] !== normalized) {
            changed = true;
          }
        } else {
          next[key] = prev[key];
        }
      }
      const prevKeys = Object.keys(prev);
      if (prevKeys.length !== Object.keys(next).length) {
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [schedules, settingsDirty]);

  const addSchedule = (): void => {
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: [...(prev.bandwidthSchedules ?? []), { id: createScheduleId(), startHour: 0, endHour: 8, speedLimitKbps: 0, enabled: true }]
    }));
  };
  const removeSchedule = (idx: number): void => {
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: (prev.bandwidthSchedules ?? []).filter((_, i) => i !== idx)
    }));
  };
  const updateSchedule = (idx: number, field: keyof BandwidthScheduleEntry, value: number | boolean): void => {
    settingsDraftRevisionRef.current += 1;
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: (prev.bandwidthSchedules ?? []).map((s, i) => i === idx ? { ...s, [field]: value } : s)
    }));
  };

  const applyTheme = (theme: AppTheme): void => {
    document.documentElement.setAttribute("data-theme", theme);
  };

  const closeMenus = (): void => {
    setOpenMenu(null);
    setOpenSubmenu(null);
  };

  useEffect(() => {
    if (!contextMenu) { return; }
    const close = (): void => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !ctxMenuRef.current) return;
    const el = ctxMenuRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, contextMenu.y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(0, contextMenu.x - rect.width)}px`;
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!colHeaderCtx) return;
    const close = (e: MouseEvent): void => {
      // Don't close if click is inside the menu or on the header bar (re-position instead)
      if (colHeaderCtxRef.current && colHeaderCtxRef.current.contains(e.target as Node)) return;
      if (colHeaderBarRef.current && colHeaderBarRef.current.contains(e.target as Node)) return;
      setColHeaderCtx(null);
    };
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("mousedown", close);
    };
  }, [colHeaderCtx]);

  useLayoutEffect(() => {
    if (!colHeaderCtx || !colHeaderCtxRef.current) return;
    const el = colHeaderCtxRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, colHeaderCtx.y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(0, colHeaderCtx.x - rect.width)}px`;
    }
  }, [colHeaderCtx]);

  useEffect(() => {
    if (!historyCtxMenu) return;
    const close = (): void => setHistoryCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [historyCtxMenu]);

  useLayoutEffect(() => {
    if (!historyCtxMenu || !historyCtxMenuRef.current) return;
    const el = historyCtxMenuRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(0, historyCtxMenu.y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(0, historyCtxMenu.x - rect.width)}px`;
    }
  }, [historyCtxMenu]);

  const executeDeleteSelection = useCallback((ids: Set<string>): void => {
    const current = snapshotRef.current;
    for (const id of ids) {
      if (current.session.items[id]) void window.rd.removeItem(id);
      else if (current.session.packages[id]) void window.rd.cancelPackage(id);
    }
    setSelectedIds(new Set());
  }, []);

  const requestDeleteSelection = useCallback((): void => {
    if (selectedIds.size === 0) return;
    if (!settingsDraft.confirmDeleteSelection) {
      executeDeleteSelection(selectedIds);
      return;
    }
    setDeleteConfirm({ ids: new Set(selectedIds), dontAsk: false });
  }, [selectedIds, settingsDraft.confirmDeleteSelection, executeDeleteSelection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSelectedIds(new Set());
      if (e.key === "Delete" && selectedIds.size > 0) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        requestDeleteSelection();
      }
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest(".package-card") || target.closest(".ctx-menu")) return;
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [selectedIds, requestDeleteSelection]);

  const onExportBackup = async (): Promise<void> => {
    closeMenus();
    try {
      const result = await window.rd.exportBackup();
      if (result.saved) {
        showToast("Sicherung exportiert");
      }
    } catch (error) {
      showToast(`Sicherung fehlgeschlagen: ${String(error)}`, 2600);
    }
  };

  const onImportBackup = async (): Promise<void> => {
    closeMenus();
    try {
      const result = await window.rd.importBackup();
      if (result.restored) {
        showToast(result.message, 4000);
      } else if (result.message !== "Abgebrochen") {
        showToast(`Sicherung laden fehlgeschlagen: ${result.message}`, 3000);
      }
    } catch (error) {
      showToast(`Sicherung laden fehlgeschlagen: ${String(error)}`, 2600);
    }
  };

  const onMenuRestart = (): void => {
    closeMenus();
    void window.rd.restart();
  };

  const onMenuQuit = (): void => {
    closeMenus();
    void window.rd.quit();
  };

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.shiftKey && e.key.toLowerCase() === "r") {
          e.preventDefault();
          void window.rd.restart();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "q") {
          e.preventDefault();
          void window.rd.quit();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "l") {
          e.preventDefault();
          setTab("collector");
          setOpenMenu(null);
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          setTab("settings");
          setOpenMenu(null);
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "o") {
          e.preventDefault();
          setOpenMenu(null);
          void onImportDlc();
          return;
        }
        if (!e.shiftKey && e.key.toLowerCase() === "a") {
          if (tabRef.current === "downloads") {
            e.preventDefault();
            setSelectedIds(new Set(Object.keys(snapshotRef.current.session.packages)));
          } else if (tabRef.current === "history") {
            e.preventDefault();
            setSelectedHistoryIds(new Set(historyEntriesRef.current.map(e => e.id)));
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!openMenu) { return; }
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (!target.closest(".menu-bar")) {
        setOpenMenu(null);
        setOpenSubmenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenu]);

  const packageSpeedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const [pid, bps] of Object.entries(snapshot.packageSpeedBps)) {
      if (bps > 0) map.set(pid, bps);
    }
    return map;
  }, [snapshot.packageSpeedBps]);

  const itemStatusCounts = useMemo(() => {
    const counts = { downloading: 0, queued: 0, failed: 0 };
    for (const item of Object.values(snapshot.session.items)) {
      if (item.status === "downloading") {
        counts.downloading += 1;
      } else if (item.status === "queued" || item.status === "reconnect_wait") {
        counts.queued += 1;
      } else if (item.status === "failed") {
        counts.failed += 1;
      }
    }
    return counts;
  }, [snapshot.session.items]);

  const providerStats = useMemo(() => {
    const stats: Record<string, { total: number; completed: number; failed: number; bytes: number }> = {};
    for (const item of Object.values(snapshot.session.items)) {
      const hoster = extractHoster(item.url) || "unknown";
      if (!stats[hoster]) {
        stats[hoster] = { total: 0, completed: 0, failed: 0, bytes: 0 };
      }
      stats[hoster].total += 1;
      if (item.status === "completed") stats[hoster].completed += 1;
      if (item.status === "failed") stats[hoster].failed += 1;
      stats[hoster].bytes += item.downloadedBytes;
    }
    return Object.entries(stats);
  }, [snapshot.session.items]);

  return (
    <div
      className={`app-shell${dragOver ? " drag-over" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (draggedPackageIdRef.current) { return; }
        const hasFiles = event.dataTransfer.types.includes("Files");
        const hasUri = event.dataTransfer.types.includes("text/uri-list");
        if (!hasFiles && !hasUri) { return; }
        dragDepthRef.current += 1;
        if (!dragOverRef.current) {
          dragOverRef.current = true;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={() => {
        if (draggedPackageIdRef.current) { return; }
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0 && dragOverRef.current) {
          dragOverRef.current = false;
          setDragOver(false);
        }
      }}
      onDrop={onDrop}
    >
      <nav className="menu-bar">
        <div className="menu-bar-item">
          <button
            className={`menu-bar-trigger${openMenu === "datei" ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === "datei" ? null : "datei")}
            onMouseEnter={() => { if (openMenu && openMenu !== "datei") { setOpenMenu("datei"); setOpenSubmenu(null); } }}
          >
            Datei
          </button>
          {openMenu === "datei" && (
            <div className="menu-dropdown">
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); setTab("collector"); }}>
                <span>Text mit Links analysieren</span>
                <span className="shortcut">Strg+L</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void onImportDlc(); }}>
                <span>Linkcontainer laden</span>
                <span className="shortcut">Strg+O</span>
              </button>
              <div className="menu-separator" />
              <div
                className="menu-submenu"
                onMouseEnter={() => setOpenSubmenu("sicherung")}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                <button className="menu-submenu-trigger">Sicherung</button>
                {openSubmenu === "sicherung" && (
                  <div className="menu-submenu-dropdown">
                    <button className="menu-dropdown-item" onClick={() => { void onExportBackup(); }}>Erstellen</button>
                    <button className="menu-dropdown-item" onClick={() => { void onImportBackup(); }}>Laden</button>
                  </div>
                )}
              </div>
              <div className="menu-separator" />
              <button className="menu-dropdown-item" onClick={onMenuRestart}>
                <span>Neustart</span>
                <span className="shortcut">Strg+Umschalt+R</span>
              </button>
              <button className="menu-dropdown-item" onClick={onMenuQuit}>
                <span>Beenden</span>
                <span className="shortcut">Strg+Q</span>
              </button>
            </div>
          )}
        </div>
        <div className="menu-bar-item">
          <button
            className={`menu-bar-trigger${openMenu === "einstellungen" ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === "einstellungen" ? null : "einstellungen")}
            onMouseEnter={() => { if (openMenu && openMenu !== "einstellungen") { setOpenMenu("einstellungen"); setOpenSubmenu(null); } }}
          >
            Einstellungen
          </button>
          {openMenu === "einstellungen" && (
            <div className="menu-dropdown">
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); setTab("settings"); }}>
                <span>Einstellungen</span>
                <span className="shortcut">Strg+P</span>
              </button>
              <div className="menu-separator" />
              <div className="menu-settings-grid" onClick={(e) => e.stopPropagation()}>
                <span>Max. gleichzeitige Downloads</span>
                <span />
                <div className="menu-spinner">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={settingsDraft.maxParallel}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(50, Number(e.target.value) || 1));
                      setSettingsDraft((prev) => ({ ...prev, maxParallel: val }));
                      void window.rd.updateSettings({ maxParallel: val });
                    }}
                  />
                  <div className="menu-spinner-arrows">
                    <button onClick={() => {
                      const val = Math.min(50, settingsDraft.maxParallel + 1);
                      setSettingsDraft((prev) => ({ ...prev, maxParallel: val }));
                      void window.rd.updateSettings({ maxParallel: val });
                    }}>&#9650;</button>
                    <button onClick={() => {
                      const val = Math.max(1, settingsDraft.maxParallel - 1);
                      setSettingsDraft((prev) => ({ ...prev, maxParallel: val }));
                      void window.rd.updateSettings({ maxParallel: val });
                    }}>&#9660;</button>
                  </div>
                </div>
                <span />

                <span>Geschwindigkeitslimit</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.speedLimitEnabled}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setSettingsDraft((prev) => ({ ...prev, speedLimitEnabled: next }));
                    void window.rd.updateSettings({ speedLimitEnabled: next });
                  }}
                />
                <div className={`menu-spinner${!settingsDraft.speedLimitEnabled ? " disabled" : ""}`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={formatMbpsInputFromKbps(settingsDraft.speedLimitKbps)}
                    onChange={(e) => {
                      const parsed = parseMbpsInput(e.target.value);
                      if (parsed !== null) {
                        const kbps = Math.floor(parsed * 1024);
                        setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: kbps }));
                        void window.rd.updateSettings({ speedLimitKbps: kbps });
                      }
                    }}
                  />
                  <div className="menu-spinner-arrows">
                    <button onClick={() => {
                      const cur = (settingsDraft.speedLimitKbps || 0) / 1024;
                      const next = Math.floor((cur + 1) * 1024);
                      setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: next }));
                      void window.rd.updateSettings({ speedLimitKbps: next });
                    }}>&#9650;</button>
                    <button onClick={() => {
                      const cur = (settingsDraft.speedLimitKbps || 0) / 1024;
                      const next = Math.max(0, Math.floor((cur - 1) * 1024));
                      setSettingsDraft((prev) => ({ ...prev, speedLimitKbps: next }));
                      void window.rd.updateSettings({ speedLimitKbps: next });
                    }}>&#9660;</button>
                  </div>
                </div>
                <span className="menu-speed-unit">MB/s</span>
              </div>
            </div>
          )}
        </div>
        <div className="menu-bar-item">
          <button
            className={`menu-bar-trigger${openMenu === "hilfe" ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === "hilfe" ? null : "hilfe")}
            onMouseEnter={() => { if (openMenu && openMenu !== "hilfe") { setOpenMenu("hilfe"); setOpenSubmenu(null); } }}
          >
            Hilfe
          </button>
          {openMenu === "hilfe" && (
            <div className="menu-dropdown">
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openLog(); }}>
                <span>Log öffnen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void window.rd.openSessionLog(); }}>
                <span>Session-Log öffnen</span>
              </button>
              <button className="menu-dropdown-item" onClick={() => { closeMenus(); void onCheckUpdates(); }}>
                <span>Suche Aktualisierungen</span>
              </button>
            </div>
          )}
        </div>
      </nav>

      <section className="control-strip">
        <div className="buttons buttons-left">
          <button
            className="ctrl-icon-btn ctrl-play"
            title={snapshot.session.paused ? "Fortsetzen" : "Start"}
            disabled={actionBusy || (!snapshot.canStart && !snapshot.session.paused)}
            onClick={() => {
              if (snapshot.session.paused) {
                setSnapshot((prev) => ({ ...prev, session: { ...prev.session, paused: false } }));
                void window.rd.togglePause();
              } else {
                void onStartDownloads();
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><polygon points="6,3 20,12 6,21" fill="currentColor" /></svg>
          </button>
          <button
            className={`ctrl-icon-btn ctrl-pause${snapshot.session.paused ? " paused" : ""}`}
            title="Pause"
            disabled={!snapshot.canPause || snapshot.session.paused}
            onClick={() => {
              setSnapshot((prev) => ({ ...prev, session: { ...prev.session, paused: true } }));
              void window.rd.togglePause();
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><rect x="5" y="3" width="4.5" height="18" rx="1" fill="currentColor" /><rect x="14.5" y="3" width="4.5" height="18" rx="1" fill="currentColor" /></svg>
          </button>
          <button
            className="ctrl-icon-btn ctrl-stop"
            title="Stop"
            disabled={actionBusy || !snapshot.canStop}
            onClick={() => { void performQuickAction(() => window.rd.stop()); }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" /></svg>
          </button>
        </div>
        {snapshot.reconnectSeconds > 0 && (
          <div className="reconnect-badge" style={{ marginLeft: "auto" }}>Reconnect: {snapshot.reconnectSeconds}s</div>
        )}
      </section>

      <nav className="tabs">
        <button className={tab === "downloads" ? "tab active" : "tab"} onClick={() => setTab("downloads")}>Downloads</button>
        <button className={tab === "collector" ? "tab active" : "tab"} onClick={() => setTab("collector")}>Linksammler</button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>Einstellungen</button>
        <button className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>Verlauf</button>
        <button className={tab === "statistics" ? "tab active" : "tab"} onClick={() => setTab("statistics")}>Statistiken</button>
        <div className="tab-actions">
          {tab === "downloads" && (
            <input
              className="search-input tab-search"
              type="search"
              value={downloadSearch}
              onChange={(event) => setDownloadSearch(event.target.value)}
              placeholder="Pakete durchsuchen..."
            />
          )}
        </div>
      </nav>

      <main className="tab-content">
        {tab === "collector" && (
          <section className="grid-two">
            <article className="card wide">
              <div className="collector-header">
                <h3>Linksammler</h3>
                <div className="link-actions">
                  <button className="btn" disabled={actionBusy} onClick={onImportDlc}>DLC import</button>
                  <button className="btn" disabled={actionBusy} onClick={onExportQueue}>Queue Export</button>
                  <button className="btn" disabled={actionBusy} onClick={onImportQueue}>Queue Import</button>
                  <button className="btn accent" disabled={actionBusy} onClick={onAddLinks}>Zur Queue hinzufügen</button>
                </div>
              </div>
              <div className="collector-tabs">
                {collectorTabs.map((ct) => (
                  <div key={ct.id} className={`collector-tab${ct.id === activeCollectorTab ? " active" : ""}`}>
                    <button onClick={() => setActiveCollectorTab(ct.id)}>{ct.name}</button>
                    {collectorTabs.length > 1 && <button className="close-tab" onClick={() => removeCollectorTab(ct.id)}>x</button>}
                  </div>
                ))}
                <button className="btn add-tab" onClick={addCollectorTab}>+</button>
              </div>
              <textarea
                value={currentCollectorTab.text}
                onChange={(e) => setCollectorTabs((prev) => prev.map((t) => t.id === currentCollectorTab.id ? { ...t, text: e.target.value } : t))}
                onDragOver={(e) => e.preventDefault()}
                placeholder={"# package: Release-Name\nhttps://...\nhttps://...\n\nLinks oder .dlc Dateien hier ablegen"}
              />
            </article>
          </section>
        )}

        {tab === "downloads" && (
          <section className="downloads-view">
            {snapshot.reconnectSeconds > 0 && (
              <div className="reconnect-banner">
                Reconnect aktiv: {snapshot.reconnectSeconds}s verbleibend
                {snapshot.session.reconnectReason && <span> ({snapshot.session.reconnectReason})</span>}
              </div>
            )}
            {/* Action buttons moved to footer */}
            <div ref={colHeaderBarRef} className="pkg-column-header" style={{ gridTemplateColumns: gridTemplate }} onContextMenu={(e) => { e.preventDefault(); setColHeaderCtx({ x: e.clientX, y: e.clientY }); }}>
              {columnOrder.map((col) => {
                const def = COLUMN_DEFS[col];
                if (!def) return null;
                const sortCol = def.sortable;
                const isActive = sortCol ? downloadsSortColumn === sortCol : false;
                return (
                  <span
                    key={col}
                    className={`pkg-col pkg-col-${col}${sortCol ? " sortable" : ""}${isActive ? " sort-active" : ""}${dragColId === col ? " pkg-col-dragging" : ""}${dropTargetCol === col ? " pkg-col-drop-target" : ""}`}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragColId(col); }}
                    onDragOver={(e) => { if (dragColId && dragColId !== col) { e.preventDefault(); setDropTargetCol(col); } }}
                    onDragLeave={() => { if (dropTargetCol === col) setDropTargetCol(null); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropTargetCol(null);
                      if (!dragColId || dragColId === col) return;
                      const newOrder = [...columnOrder];
                      const fromIdx = newOrder.indexOf(dragColId);
                      const toIdx = newOrder.indexOf(col);
                      if (fromIdx < 0 || toIdx < 0) return;
                      newOrder.splice(fromIdx, 1);
                      newOrder.splice(toIdx, 0, dragColId);
                      setColumnOrder(newOrder);
                      setDragColId(null);
                      void window.rd.updateSettings({ columnOrder: newOrder });
                    }}
                    onDragEnd={() => { setDragColId(null); setDropTargetCol(null); }}
                    onClick={sortCol ? () => {
                      const nextDesc = isActive ? !downloadsSortDescending : false;
                      setDownloadsSortColumn(sortCol);
                      setDownloadsSortDescending(nextDesc);
                      const baseOrder = packageOrderRef.current.length > 0 ? packageOrderRef.current : snapshot.session.packageOrder;
                      let sorted: string[];
                      if (sortCol === "progress") {
                        sorted = sortPackageOrderByProgress(baseOrder, snapshot.session.packages, snapshot.session.items, nextDesc);
                      } else if (sortCol === "size") {
                        sorted = sortPackageOrderBySize(baseOrder, snapshot.session.packages, snapshot.session.items, nextDesc);
                      } else if (sortCol === "hoster") {
                        sorted = sortPackageOrderByHoster(baseOrder, snapshot.session.packages, snapshot.session.items, nextDesc);
                      } else {
                        sorted = sortPackageOrderByName(baseOrder, snapshot.session.packages, nextDesc);
                      }
                      pendingPackageOrderRef.current = [...sorted];
                      pendingPackageOrderAtRef.current = Date.now();
                      packageOrderRef.current = sorted;
                      void window.rd.reorderPackages(sorted).catch((error) => {
                        pendingPackageOrderRef.current = null;
                        pendingPackageOrderAtRef.current = 0;
                        packageOrderRef.current = serverPackageOrderRef.current;
                        showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
                      });
                    } : undefined}
                  >
                    {def.label} {isActive ? (downloadsSortDescending ? "\u25BC" : "\u25B2") : ""}
                  </span>
                );
              })}
            </div>
            {totalPackageCount === 0 && <div className="empty">Noch keine Pakete in der Queue.</div>}
            {totalPackageCount > 0 && packages.length === 0 && <div className="empty">Keine Pakete passend zur Suche.</div>}
            {hiddenPackageCount > 0 && (
              <div className="reconnect-banner">
                Performance-Modus aktiv: {hiddenPackageCount} Paket(e) sind temporar ausgeblendet.
                <button className="btn" onClick={() => setShowAllPackages(true)}>Alle trotzdem anzeigen</button>
              </div>
            )}
            {visiblePackages.map((pkg) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                items={itemsByPackage.get(pkg.id) ?? []}
                packageSpeed={packageSpeedMap.get(pkg.id) ?? 0}
                isFirst={(packagePosition.get(pkg.id) ?? -1) === 0}
                isLast={(packagePosition.get(pkg.id) ?? -1) === snapshot.session.packageOrder.length - 1}
                isEditing={editingPackageId === pkg.id}
                editingName={editingName}
                collapsed={collapsedPackages[pkg.id] ?? false}
                selectedIds={selectedIds}
                columnOrder={columnOrder}
                gridTemplate={gridTemplate}
                onSelect={onSelectId}
                onSelectMouseDown={onSelectMouseDown}
                onSelectMouseEnter={onSelectMouseEnter}
                onStartEdit={onPackageStartEdit}
                onFinishEdit={onPackageFinishEdit}
                onEditChange={setEditingName}
                onToggleCollapse={onPackageToggleCollapse}
                onCancel={onPackageCancel}
                onMoveUp={onPackageMoveUp}
                onMoveDown={onPackageMoveDown}
                onToggle={onPackageToggle}
                onRemoveItem={onPackageRemoveItem}
                onContextMenu={onPackageContextMenu}
                onDragStart={onPackageDragStart}
                onDrop={onPackageDrop}
                onDragEnd={onPackageDragEnd}
              />
            ))}
          </section>
        )}

        {tab === "history" && (
          <section className="history-view">
            <div className="history-toolbar">
              <span className="history-count">
                {selectedHistoryIds.size > 0
                  ? `${selectedHistoryIds.size} von ${historyEntries.length} ausgewählt`
                  : `${historyEntries.length} Paket${historyEntries.length !== 1 ? "e" : ""} im Verlauf`}
              </span>
              {selectedHistoryIds.size > 0 && (
                <button className="btn btn-danger" onClick={() => {
                  const ids = [...selectedHistoryIds];
                  void Promise.all(ids.map(id => window.rd.removeHistoryEntry(id))).then(() => {
                    setHistoryEntries((prev) => prev.filter((e) => !selectedHistoryIds.has(e.id)));
                    setSelectedHistoryIds(new Set());
                  });
                }}>Ausgewählte entfernen ({selectedHistoryIds.size})</button>
              )}
              {historyEntries.length > 0 && (
                <button className="btn btn-danger" onClick={() => { void window.rd.clearHistory().then(() => { setHistoryEntries([]); setSelectedHistoryIds(new Set()); }); }}>Verlauf leeren</button>
              )}
            </div>
            {historyEntries.length === 0 && <div className="empty">Noch keine abgeschlossenen Pakete im Verlauf.</div>}
            {historyEntries.map((entry) => {
              const collapsed = historyCollapsed[entry.id] ?? true;
              const isSelected = selectedHistoryIds.has(entry.id);
              return (
                <article
                  key={entry.id}
                  className={`package-card history-card${isSelected ? " pkg-selected" : ""}`}
                  onClick={(e) => {
                    if (e.ctrlKey) {
                      e.preventDefault();
                      setSelectedHistoryIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                        return next;
                      });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedHistoryIds((prev) => prev.has(entry.id) ? prev : new Set([entry.id]));
                    setHistoryCtxMenu({ x: e.clientX, y: e.clientY, entryId: entry.id });
                  }}
                >
                  <header onClick={(e) => { if (e.ctrlKey) return; setHistoryCollapsed((prev) => ({ ...prev, [entry.id]: !collapsed })); }} style={{ cursor: "pointer" }}>
                    <div className="pkg-columns" style={{ gridTemplateColumns: gridTemplate }}>
                      {columnOrder.map((col) => {
                        switch (col) {
                          case "name": return (
                            <div key={col} className="pkg-col pkg-col-name">
                              <button className="pkg-toggle" title={collapsed ? "Ausklappen" : "Einklappen"}>{collapsed ? "+" : "\u2212"}</button>
                              <h4>{entry.name}</h4>
                            </div>
                          );
                          case "size": return (
                            <span key={col} className="pkg-col pkg-col-size">{(() => {
                              const pct = entry.totalBytes > 0 ? Math.min(100, Math.round((entry.downloadedBytes / entry.totalBytes) * 100)) : 0;
                              const label = `${humanSize(entry.downloadedBytes)} / ${humanSize(entry.totalBytes)}`;
                              return entry.totalBytes > 0 ? (
                                <span className="progress-size">
                                  <span className="progress-size-bar" style={{ width: `${pct}%` }} />
                                  <span className="progress-size-text">{label}</span>
                                  <span className="progress-size-text-filled" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{label}</span>
                                </span>
                              ) : "";
                            })()}</span>
                          );
                          case "progress": return <span key={col} className="pkg-col pkg-col-progress">{entry.status === "completed" ? "100%" : ""}</span>;
                          case "hoster": return <span key={col} className="pkg-col pkg-col-hoster"></span>;
                          case "account": return <span key={col} className="pkg-col pkg-col-account">{entry.provider ? providerLabels[entry.provider] : ""}</span>;
                          case "prio": return <span key={col} className="pkg-col pkg-col-prio"></span>;
                          case "status": return <span key={col} className="pkg-col pkg-col-status">{entry.status === "completed" ? "Abgeschlossen" : "Gelöscht"}</span>;
                          case "speed": return <span key={col} className="pkg-col pkg-col-speed"></span>;
                          case "added": return <span key={col} className="pkg-col pkg-col-added">{formatDateTime(entry.completedAt)}</span>;
                          default: return null;
                        }
                      })}
                    </div>
                  </header>
                  <div className="progress"><div className="progress-dl" style={{ width: entry.status === "completed" ? "100%" : "0%" }} /></div>
                  {!collapsed && (
                    <div className="history-details">
                      <div className="history-detail-grid">
                        <span className="history-label">Abgeschlossen am</span>
                        <span>{new Date(entry.completedAt).toLocaleString("de-DE")}</span>
                        <span className="history-label">Dateien</span>
                        <span>{entry.fileCount} Datei{entry.fileCount !== 1 ? "en" : ""}</span>
                        <span className="history-label">Gesamtgröße</span>
                        <span>{humanSize(entry.totalBytes)}</span>
                        <span className="history-label">Heruntergeladen</span>
                        <span>{humanSize(entry.downloadedBytes)}</span>
                        <span className="history-label">Dauer</span>
                        <span>{entry.durationSeconds >= 3600 ? `${Math.floor(entry.durationSeconds / 3600)}h ${Math.floor((entry.durationSeconds % 3600) / 60)}min` : entry.durationSeconds >= 60 ? `${Math.floor(entry.durationSeconds / 60)}min ${entry.durationSeconds % 60}s` : `${entry.durationSeconds}s`}</span>
                        <span className="history-label">Durchschnitt</span>
                        <span>{entry.durationSeconds > 0 ? formatSpeedMbps(Math.round(entry.downloadedBytes / entry.durationSeconds)) : ""}</span>
                        <span className="history-label">Provider</span>
                        <span>{entry.provider ? providerLabels[entry.provider] : ""}</span>
                        <span className="history-label">Zielordner</span>
                        <span className="history-path" title={entry.outputDir}>{entry.outputDir || ""}</span>
                        <span className="history-label">Status</span>
                        <span>{entry.status === "completed" ? "Abgeschlossen" : "Gelöscht"}</span>
                      </div>
                      <div className="history-actions">
                        <button className="btn" onClick={() => { void window.rd.removeHistoryEntry(entry.id).then(() => { setHistoryEntries((prev) => prev.filter((e) => e.id !== entry.id)); setSelectedHistoryIds((prev) => { const n = new Set(prev); n.delete(entry.id); return n; }); }); }}>Eintrag entfernen</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}

        {tab === "statistics" && (
          <section className="statistics-view">
            <article className="card stats-overview">
              <h3>Session-Ubersicht</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Aktuelle Geschwindigkeit</span>
                  <span className="stat-value">{snapshot.speedText.replace("Geschwindigkeit: ", "")}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Heruntergeladen (Session)</span>
                  <span className="stat-value">{humanSize(snapshot.stats.totalDownloaded)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Heruntergeladen (Gesamt)</span>
                  <span className="stat-value">{humanSize(snapshot.stats.totalDownloadedAllTime)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fertige Dateien</span>
                  <span className="stat-value">{snapshot.stats.totalFiles}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Pakete</span>
                  <span className="stat-value">{snapshot.stats.totalPackages}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Aktive Downloads</span>
                  <span className="stat-value">{itemStatusCounts.downloading}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">In Warteschlange</span>
                  <span className="stat-value">{itemStatusCounts.queued}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fehlerhaft</span>
                  <span className="stat-value danger">{itemStatusCounts.failed}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{snapshot.etaText.split(": ")[0]}</span>
                  <span className="stat-value">{snapshot.etaText.split(": ")[1] || "--"}</span>
                </div>
              </div>
            </article>

            <article className="card stats-chart-card">
              <h3>Bandbreitenverlauf</h3>
              <BandwidthChart items={snapshot.session.items} running={snapshot.session.running} paused={snapshot.session.paused} speedHistoryRef={speedHistoryRef} />
            </article>

            <article className="card stats-provider-card">
              <h3>Hoster-Statistik</h3>
              <div className="provider-stats">
                {providerStats.map(([provider, stats]) => (
                  <div key={provider} className="provider-stat-item">
                    <span className="provider-name">{provider === "unknown" ? "Unbekannt" : provider}</span>
                    <div className="provider-bars">
                      <div className="provider-bar">
                        <div className="bar-fill completed" style={{ width: `${stats.total > 0 ? (stats.completed / stats.total) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <span className="provider-detail">
                      {stats.completed}/{stats.total} fertig | {humanSize(stats.bytes)}
                      {stats.failed > 0 && <span className="danger"> | {stats.failed} Fehler</span>}
                    </span>
                  </div>
                ))}
                {Object.keys(snapshot.session.items).length === 0 && (
                  <div className="empty-provider">Noch keine Downloads vorhanden.</div>
                )}
              </div>
            </article>
          </section>
        )}

        {tab === "settings" && (
          <section className="settings-shell">
            <article className="card settings-toolbar">
              <div className="settings-toolbar-copy">
                <h3>Einstellungen</h3>
                <span>Kompakt, schnell auffindbar und direkt speicherbar.</span>
              </div>
              <div className="settings-toolbar-actions-wrap">
                <div className="settings-toolbar-actions">
                  <button className="btn accent" disabled={actionBusy} onClick={onSaveSettings}>Einstellungen speichern</button>
                </div>
              </div>
            </article>

            <div className="settings-body">
              <nav className="settings-sidebar">
                {settingsSubTabs.map((st) => (
                  <button key={st.key} className={`settings-sidebar-tab${settingsSubTab === st.key ? " active" : ""}`} onClick={() => setSettingsSubTab(st.key)}>{st.label}</button>
                ))}
              </nav>
              <div className="settings-content" key={settingsSubTab}>
                {settingsSubTab === "allgemein" && (
                  <div className="settings-section card">
                    <h3>Allgemein</h3>
                    <label>Download-Ordner</label>
                    <div className="input-row">
                      <input value={settingsDraft.outputDir} onChange={(e) => setText("outputDir", e.target.value)} />
                      <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("outputDir", s); } }); }}>Wählen</button>
                    </div>
                    <label>Paketname (optional)</label>
                    <input value={settingsDraft.packageName} onChange={(e) => setText("packageName", e.target.value)} />
                    <div className="field-grid two">
                      <div><label>Max. Downloads</label><input type="number" min={1} max={50} value={settingsDraft.maxParallel} onChange={(e) => setNum("maxParallel", Number(e.target.value) || 1)} /></div>
                      <div><label>Auto-Retry Limit (0 = inf)</label><input type="number" min={0} max={99} value={settingsDraft.retryLimit} onChange={(e) => setNum("retryLimit", Math.max(0, Math.min(99, Number(e.target.value) || 0)))} /></div>
                    </div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoResumeOnStart} onChange={(e) => setBool("autoResumeOnStart", e.target.checked)} /> Auto-Resume beim Start</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.collapseNewPackages} onChange={(e) => setBool("collapseNewPackages", e.target.checked)} /> Neue Pakete eingeklappt</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.clipboardWatch} onChange={(e) => setBool("clipboardWatch", e.target.checked)} /> Zwischenablage überwachen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.minimizeToTray} onChange={(e) => setBool("minimizeToTray", e.target.checked)} /> In System Tray minimieren</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.confirmDeleteSelection} onChange={(e) => setBool("confirmDeleteSelection", e.target.checked)} /> Vor dem Löschen bestätigen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.theme === "light"} onChange={(e) => {
                      const next = e.target.checked ? "light" : "dark";
                      settingsDraftRevisionRef.current += 1;
                      settingsDirtyRef.current = true;
                      setSettingsDirty(true);
                      setSettingsDraft((prev) => ({ ...prev, theme: next as AppTheme }));
                      applyTheme(next as AppTheme);
                    }} /> Light Mode</label>
                  </div>
                )}
                {settingsSubTab === "accounts" && (
                  <div className="settings-section card">
                    <h3>Accounts</h3>
                    <label>Real-Debrid API Token</label>
                    <input type="password" value={settingsDraft.token} onChange={(e) => setText("token", e.target.value)} />
                    <label>Mega-Debrid Login</label>
                    <input value={settingsDraft.megaLogin} onChange={(e) => setText("megaLogin", e.target.value)} />
                    <label>Mega-Debrid Passwort</label>
                    <input type="password" value={settingsDraft.megaPassword} onChange={(e) => setText("megaPassword", e.target.value)} />
                    <label>BestDebrid API Token</label>
                    <input type="password" value={settingsDraft.bestToken} onChange={(e) => setText("bestToken", e.target.value)} />
                    <label>AllDebrid API Key</label>
                    <input type="password" value={settingsDraft.allDebridToken} onChange={(e) => setText("allDebridToken", e.target.value)} />
                    {configuredProviders.length === 0 && (
                      <div className="hint">Füge mindestens einen Account hinzu, dann erscheint die Hoster-Auswahl.</div>
                    )}
                    {configuredProviders.length >= 1 && (
                      <div><label>Hauptaccount</label><select value={primaryProviderValue} onChange={(e) => setText("providerPrimary", e.target.value)}>
                        {configuredProviders.map((provider) => (<option key={provider} value={provider}>{providerLabels[provider]}</option>))}
                      </select></div>
                    )}
                    {configuredProviders.length >= 2 && (
                      <div><label>1. Hoster-Alternative</label><select value={secondaryProviderValue} onChange={(e) => setText("providerSecondary", e.target.value)}>
                        <option value="none">Keine Alternative</option>
                        {secondaryProviderChoices.map((provider) => (<option key={provider} value={provider}>{providerLabels[provider]}</option>))}
                      </select></div>
                    )}
                    {configuredProviders.length >= 3 && (
                      <div><label>2. Hoster-Alternative</label><select value={tertiaryProviderValue} onChange={(e) => setText("providerTertiary", e.target.value)}>
                        <option value="none">Keine Alternative</option>
                        {tertiaryProviderChoices.map((provider) => (<option key={provider} value={provider}>{providerLabels[provider]}</option>))}
                      </select></div>
                    )}
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoProviderFallback} onChange={(e) => setBool("autoProviderFallback", e.target.checked)} /> Bei Fehler/Fair-Use automatisch zum nächsten Provider wechseln</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.rememberToken} onChange={(e) => setBool("rememberToken", e.target.checked)} /> Zugangsdaten lokal speichern</label>
                  </div>
                )}
                {settingsSubTab === "entpacken" && (
                  <div className="settings-section card">
                    <h3>Entpacken</h3>
                    <label>Entpacken nach</label>
                    <div className="input-row">
                      <input value={settingsDraft.extractDir} onChange={(e) => setText("extractDir", e.target.value)} />
                      <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("extractDir", s); } }); }}>Wählen</button>
                    </div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoExtract} onChange={(e) => setBool("autoExtract", e.target.checked)} /> Auto-Extract</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoSkipExtracted} onChange={(e) => setBool("autoSkipExtracted", e.target.checked)} /> Bereits Entpacktes beim Start überspringen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoRename4sf4sj} onChange={(e) => setBool("autoRename4sf4sj", e.target.checked)} /> Auto-Rename (Beta)</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.createExtractSubfolder} onChange={(e) => setBool("createExtractSubfolder", e.target.checked)} /> Entpackte Dateien in Paket-Unterordner speichern</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.hybridExtract} onChange={(e) => setBool("hybridExtract", e.target.checked)} /> Hybrid-Extract</label>
                    <div><label>Parallele Entpackungen</label><input type="number" min={1} max={8} value={settingsDraft.maxParallelExtract} onChange={(e) => setNum("maxParallelExtract", Math.max(1, Math.min(8, Number(e.target.value) || 2)))} /></div>
                    <div><label>Extraktions-Priorität</label><select value={settingsDraft.extractCpuPriority} onChange={(e) => setText("extractCpuPriority", e.target.value)}>
                      <option value="high">Hoch (80% CPU)</option>
                      <option value="middle">Mittel (50% CPU)</option>
                      <option value="low">Niedrig (25% CPU)</option>
                    </select></div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.collectMkvToLibrary} onChange={(e) => setBool("collectMkvToLibrary", e.target.checked)} /> MKV nach Paketabschluss in Sammelordner verschieben (flach)</label>
                    <label>MKV-Sammelordner</label>
                    <div className="input-row">
                      <input value={settingsDraft.mkvLibraryDir} onChange={(e) => setText("mkvLibraryDir", e.target.value)} disabled={!settingsDraft.collectMkvToLibrary} />
                      <button className="btn" disabled={!settingsDraft.collectMkvToLibrary} onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("mkvLibraryDir", s); } }); }}>Wählen</button>
                    </div>
                    <label>Passwortliste (eine Zeile pro Passwort)</label>
                    <textarea className="password-list" value={settingsDraft.archivePasswordList} onChange={(e) => setText("archivePasswordList", e.target.value)} placeholder={"serienfans.org\nserienjunkies.org\nmein-passwort"} />
                  </div>
                )}
                {settingsSubTab === "geschwindigkeit" && (
                  <div className="settings-section card">
                    <h3>Geschwindigkeit</h3>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.speedLimitEnabled} onChange={(e) => setBool("speedLimitEnabled", e.target.checked)} /> Speed-Limit aktivieren</label>
                    <div className="field-grid two">
                      <div>
                        <label>Limit (MB/s)</label>
                        <input type="number" min={0} step={0.1} value={speedLimitInput} onChange={(event) => setSpeedLimitInput(event.target.value)} onBlur={(event) => { const parsed = parseMbpsInput(event.target.value); if (parsed === null) { setSpeedLimitInput(formatMbpsInputFromKbps(settingsDraft.speedLimitKbps)); return; } setSpeedLimitMbps(parsed); setSpeedLimitInput(formatMbpsInputFromKbps(Math.floor(parsed * 1024))); }} disabled={!settingsDraft.speedLimitEnabled} />
                      </div>
                      <div>
                        <label>Limit-Modus</label>
                        <select value={settingsDraft.speedLimitMode} onChange={(e) => setText("speedLimitMode", e.target.value)} disabled={!settingsDraft.speedLimitEnabled}>
                          <option value="global">Global</option>
                          <option value="per_download">Pro Download</option>
                        </select>
                      </div>
                    </div>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoReconnect} onChange={(e) => setBool("autoReconnect", e.target.checked)} /> Automatischer Reconnect</label>
                    <div><label>Reconnect-Wartezeit (Sek.)</label><input type="number" min={10} max={600} value={settingsDraft.reconnectWaitSeconds} onChange={(e) => setNum("reconnectWaitSeconds", Number(e.target.value) || 45)} /></div>
                    <h4>Bandbreitenplanung</h4>
                    {schedules.map((s, i) => {
                      const scheduleKey = s.id || `schedule-${i}`;
                      const speedInput = scheduleSpeedInputs[scheduleKey] ?? formatMbpsInputFromKbps(s.speedLimitKbps);
                      return (
                        <div key={scheduleKey} className="schedule-row">
                          <input type="number" min={0} max={23} value={s.startHour} onChange={(e) => updateSchedule(i, "startHour", Number(e.target.value))} title="Von (Stunde)" />
                          <span>-</span>
                          <input type="number" min={0} max={23} value={s.endHour} onChange={(e) => updateSchedule(i, "endHour", Number(e.target.value))} title="Bis (Stunde)" />
                          <span>Uhr</span>
                          <input type="number" min={0} step={0.1} value={speedInput} onChange={(event) => { setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: event.target.value })); }} onBlur={(event) => { const parsed = parseMbpsInput(event.target.value); if (parsed === null) { setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: formatMbpsInputFromKbps(s.speedLimitKbps) })); return; } const nextKbps = Math.floor(parsed * 1024); setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: formatMbpsInputFromKbps(nextKbps) })); updateSchedule(i, "speedLimitKbps", nextKbps); }} title="MB/s (0=unbegrenzt)" />
                          <span>MB/s</span>
                          <input type="checkbox" checked={s.enabled} onChange={(e) => updateSchedule(i, "enabled", e.target.checked)} />
                          <button className="btn danger" onClick={() => removeSchedule(i)}>X</button>
                        </div>
                      );
                    })}
                    <button className="btn" onClick={addSchedule}>Zeitregel hinzufügen</button>
                  </div>
                )}
                {settingsSubTab === "bereinigung" && (
                  <div className="settings-section card">
                    <h3>Bereinigung</h3>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.enableIntegrityCheck} onChange={(e) => setBool("enableIntegrityCheck", e.target.checked)} /> SFV/CRC/MD5/SHA1 prüfen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.removeLinkFilesAfterExtract} onChange={(e) => setBool("removeLinkFilesAfterExtract", e.target.checked)} /> Link-Dateien nach Entpacken entfernen</label>
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.removeSamplesAfterExtract} onChange={(e) => setBool("removeSamplesAfterExtract", e.target.checked)} /> Samples nach Entpacken entfernen</label>
                    <label>Fertiggestellte Downloads entfernen</label>
                    <select value={settingsDraft.completedCleanupPolicy} onChange={(e) => setText("completedCleanupPolicy", e.target.value)}>
                      {Object.entries(cleanupLabels).map(([key, label]) => (<option key={key} value={key}>{label}</option>))}
                    </select>
                    <div className="field-grid two">
                      <div><label>Cleanup nach Entpacken</label><select value={settingsDraft.cleanupMode} onChange={(e) => setText("cleanupMode", e.target.value)}>
                        <option value="none">keine Archive löschen</option>
                        <option value="trash">Archive in Papierkorb</option>
                        <option value="delete">Archive löschen</option>
                      </select></div>
                      <div><label>Konfliktmodus</label><select value={settingsDraft.extractConflictMode} onChange={(e) => setText("extractConflictMode", e.target.value)}>
                        <option value="overwrite">überschreiben</option>
                        <option value="skip">überspringen</option>
                        <option value="rename">umbenennen</option>
                        <option value="ask">nachfragen</option>
                      </select></div>
                    </div>
                  </div>
                )}
                {settingsSubTab === "updates" && (
                  <div className="settings-section card">
                    <h3>Updates</h3>
                    <label>Codeberg Repo</label>
                    <input value={settingsDraft.updateRepo} onChange={(e) => setText("updateRepo", e.target.value)} />
                    <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoUpdateCheck} onChange={(e) => setBool("autoUpdateCheck", e.target.checked)} /> Beim Start auf Updates prüfen</label>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {confirmPrompt && (
        <div className="modal-backdrop" onClick={() => closeConfirmPrompt(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>{confirmPrompt.title}</h3>
            <p style={{ whiteSpace: "pre-line" }}>{confirmPrompt.message}</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => closeConfirmPrompt(false)}>Abbrechen</button>
              <button
                className={confirmPrompt.danger ? "btn danger" : "btn"}
                onClick={() => closeConfirmPrompt(true)}
              >
                {confirmPrompt.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (() => {
        const itemCount = [...deleteConfirm.ids].filter((id) => snapshot.session.items[id]).length;
        const pkgCount = [...deleteConfirm.ids].filter((id) => snapshot.session.packages[id]).length;
        const totalRemaining = Object.keys(snapshot.session.items).length + Object.keys(snapshot.session.packages).length - itemCount - pkgCount;
        const parts: string[] = [];
        if (pkgCount > 0) parts.push(`${pkgCount} Paket(e)`);
        if (itemCount > 0) parts.push(`${itemCount} Link(s)`);
        return (
          <div className="modal-backdrop" onClick={() => setDeleteConfirm(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <h3>Bist Du Dir sicher?</h3>
              <p>Möchtest Du wirklich diese Aufräumaktion(en) durchführen?<br />Ausgewählte Links löschen</p>
              <p><strong>Zu erledigende Aufgaben:</strong><br />{parts.join(" + ")} löschen – {totalRemaining} Link(s) verbleiben!</p>
              <label className="toggle-line">
                <input type="checkbox" checked={deleteConfirm.dontAsk} onChange={(e) => setDeleteConfirm((prev) => prev ? { ...prev, dontAsk: e.target.checked } : prev)} />
                Nicht mehr anzeigen
              </label>
              <div className="modal-actions">
                <button className="btn" onClick={() => setDeleteConfirm(null)}>Abbrechen</button>
                <button className="btn danger" onClick={() => {
                  if (deleteConfirm.dontAsk) {
                    setBool("confirmDeleteSelection", false);
                  }
                  executeDeleteSelection(deleteConfirm.ids);
                  setDeleteConfirm(null);
                }}>Fortfahren</button>
              </div>
            </div>
          </div>
        );
      })()}

      {startConflictPrompt && (
        <div className="modal-backdrop" onClick={() => closeStartConflictPrompt(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Paket bereits entpackt</h3>
            <p>
              <strong>{startConflictPrompt.entry.packageName}</strong> ist im Ziel bereits vorhanden.
            </p>
            <p>Bei "Überspringen" wird nur das erneute Entpacken übersprungen - offene Downloads bleiben in der Queue.</p>
            <p className="modal-path" title={startConflictPrompt.entry.extractDir}>{startConflictPrompt.entry.extractDir}</p>
            <label className="toggle-line">
              <input
                type="checkbox"
                checked={startConflictPrompt.applyToAll}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setStartConflictPrompt((prev) => prev ? { ...prev, applyToAll: checked } : prev);
                }}
              />
              Für alle weiteren Pakete dieselbe Auswahl verwenden
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => closeStartConflictPrompt(null)}>Abbrechen</button>
              <button
                className="btn"
                onClick={() => closeStartConflictPrompt({ policy: "skip", applyToAll: startConflictPrompt.applyToAll })}
              >
                Entpacktes überspringen
              </button>
              <button
                className="btn danger"
                onClick={() => closeStartConflictPrompt({ policy: "overwrite", applyToAll: startConflictPrompt.applyToAll })}
              >
                Überschreiben
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="status-bar">
        <span>Pakete: {snapshot.stats.totalPackages}</span>
        <span>Links: {Object.keys(snapshot.session.items).length}</span>
        <span>Session: {humanSize(snapshot.stats.totalDownloaded)}</span>
        <span>Gesamt: {humanSize(snapshot.stats.totalDownloadedAllTime)}</span>
        <span>Hoster: {configuredProviders.length}</span>
        <span>{snapshot.speedText}</span>
        <span>{snapshot.etaText}</span>
        <span className="footer-spacer" />
        {totalPackageCount > 0 && (
          <button className="btn footer-btn" title={allPackagesCollapsed ? "Alle Pakete in der Liste ausklappen und Details anzeigen" : "Alle Pakete in der Liste einklappen und nur die Kopfzeilen anzeigen"} onClick={() => {
            setCollapsedPackages((prev) => {
              const next: Record<string, boolean> = { ...prev };
              const targetState = !allPackagesCollapsed;
              for (const pkg of packages) { next[pkg.id] = targetState; }
              return next;
            });
          }}>{allPackagesCollapsed ? "Ausklappen" : "Einklappen"}</button>
        )}
        {totalPackageCount > 0 && (
          <button className="btn footer-btn" title="Alle Pakete und Links aus der Download-Queue entfernen" disabled={actionBusy} onClick={() => {
            void performQuickAction(async () => {
              const confirmed = await askConfirmPrompt({ title: "Queue löschen", message: "Wirklich alle Einträge aus der Queue löschen?", confirmLabel: "Alles löschen", danger: true });
              if (!confirmed) return;
              await window.rd.clearAll();
            });
          }}>Leeren</button>
        )}
        {snapshot.clipboardActive && (
          <button className="btn footer-btn btn-active" title="Zwischenablage-Überwachung ist aktiv — kopierte Links werden automatisch erkannt und zur Queue hinzugefügt. Zum Deaktivieren: Einstellungen → Zwischenablage überwachen" disabled={actionBusy} onClick={() => { void performQuickAction(() => window.rd.toggleClipboard()); }}>
            Clipboard: An
          </button>
        )}
      </footer>

      {updateInstallProgress && (
        <div className={`update-popup update-popup-${updateInstallProgress.stage}`}>
          <div className="update-popup-header">
            <span className="update-popup-title">Update</span>
            {(updateInstallProgress.stage === "done" || updateInstallProgress.stage === "error") && (
              <button className="update-popup-close" onClick={() => setUpdateInstallProgress(null)} title="Schließen">&times;</button>
            )}
          </div>
          <div className="update-popup-message">{formatUpdateInstallProgress(updateInstallProgress)}</div>
          {updateInstallProgress.stage === "downloading" && updateInstallProgress.percent !== null && (
            <div className="update-popup-bar-track">
              <div className="update-popup-bar-fill" style={{ width: `${updateInstallProgress.percent}%` }} />
            </div>
          )}
        </div>
      )}
      {statusToast && <div className="toast">{statusToast}</div>}
      {dragOver && <div className="drop-overlay">Links oder .dlc Dateien hier ablegen</div>}
      {contextMenu && (() => {
        const multi = selectedIds.size > 1;
        const hasPackages = [...selectedIds].some((id) => snapshot.session.packages[id]);
        const startableStatuses = new Set(["queued", "cancelled", "reconnect_wait"]);
        const hasStartableItems = [...selectedIds].some((id) => { const it = snapshot.session.items[id]; return it && startableStatuses.has(it.status); });
        const hasItems = [...selectedIds].some((id) => snapshot.session.items[id]);
        return (
        <div ref={ctxMenuRef} className="ctx-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          {(hasPackages || hasStartableItems) && (
            <button className="ctx-menu-item" onClick={() => {
              const pkgIds = [...selectedIds].filter((id) => snapshot.session.packages[id]);
              const itemIds = [...selectedIds].filter((id) => snapshot.session.items[id]);
              if (pkgIds.length > 0) void window.rd.startPackages(pkgIds);
              if (itemIds.length > 0) void window.rd.startItems(itemIds);
              setContextMenu(null);
            }}>Ausgewählte Downloads starten{multi ? ` (${selectedIds.size})` : ""}</button>
          )}
          <button className="ctx-menu-item" onClick={() => { void window.rd.start(); setContextMenu(null); }}>Alle Downloads starten</button>
          <div className="ctx-menu-sep" />
          <button className="ctx-menu-item" onClick={() => showLinksPopup(contextMenu.packageId, contextMenu.itemId)}>Linkadressen anzeigen</button>
          <div className="ctx-menu-sep" />
          {hasPackages && !contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              for (const id of selectedIds) { if (snapshot.session.packages[id]) void window.rd.togglePackage(id); }
              setContextMenu(null);
            }}>
              {multi ? `Alle ${selectedIds.size} umschalten` : (snapshot.session.packages[contextMenu.packageId]?.enabled ? "Deaktivieren" : "Aktivieren")}
            </button>
          )}
          {!multi && contextMenu.itemId && (
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              setContextMenu(null);
              const ids = new Set([contextMenu.itemId!]);
              if (settingsDraft.confirmDeleteSelection) { setDeleteConfirm({ ids, dontAsk: false }); }
              else { executeDeleteSelection(ids); }
            }}>Entfernen</button>
          )}
          {multi && hasItems && (
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              setContextMenu(null);
              const ids = new Set([...selectedIds].filter((id) => snapshot.session.items[id]));
              if (settingsDraft.confirmDeleteSelection) { setDeleteConfirm({ ids, dontAsk: false }); }
              else { executeDeleteSelection(ids); }
            }}>Ausgewählte entfernen ({[...selectedIds].filter((id) => snapshot.session.items[id]).length})</button>
          )}
          {hasPackages && !contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              const pkgIds = [...selectedIds].filter((id) => snapshot.session.packages[id]);
              for (const id of pkgIds) void window.rd.resetPackage(id);
              setContextMenu(null);
            }}>Zurücksetzen{multi ? ` (${[...selectedIds].filter((id) => snapshot.session.packages[id]).length})` : ""}</button>
          )}
          {contextMenu.itemId && (
            <button className="ctx-menu-item" onClick={() => {
              const itemIds = multi
                ? [...selectedIds].filter((id) => snapshot.session.items[id])
                : [contextMenu.itemId!];
              void window.rd.resetItems(itemIds);
              setContextMenu(null);
            }}>Zurücksetzen{multi ? ` (${[...selectedIds].filter((id) => snapshot.session.items[id]).length})` : ""}</button>
          )}
          {hasPackages && !multi && (() => {
            const pkg = snapshot.session.packages[contextMenu.packageId];
            const items = pkg?.itemIds.map((id) => snapshot.session.items[id]).filter(Boolean) || [];
            const someCompleted = items.some((item) => item && item.status === "completed");
            return (<>
              {someCompleted && (
                <button className="ctx-menu-item" onClick={() => { void window.rd.extractNow(contextMenu.packageId); setContextMenu(null); }}>Jetzt entpacken</button>
              )}
            </>);
          })()}
          {hasPackages && !contextMenu.itemId && (<>
            <div className="ctx-menu-sep" />
            <div className="ctx-menu-sub">
              <button className="ctx-menu-item">Priorität ▸</button>
              <div className="ctx-menu-sub-items">
                {(["high", "normal", "low"] as const).map((p) => {
                  const label = p === "high" ? "Hoch" : p === "low" ? "Niedrig" : "Standard";
                  const pkgIds = [...selectedIds].filter((id) => snapshot.session.packages[id]);
                  const allMatch = pkgIds.every((id) => (snapshot.session.packages[id]?.priority || "normal") === p);
                  return <button key={p} className={`ctx-menu-item${allMatch ? " ctx-menu-active" : ""}`} onClick={() => { for (const id of pkgIds) void window.rd.setPackagePriority(id, p); setContextMenu(null); }}>{allMatch ? `✓ ${label}` : label}</button>;
                })}
              </div>
            </div>
          </>)}
          {hasItems && (() => {
            const itemIds = [...selectedIds].filter((id) => snapshot.session.items[id]);
            const skippable = itemIds.filter((id) => { const it = snapshot.session.items[id]; return it && (it.status === "queued" || it.status === "reconnect_wait"); });
            if (skippable.length === 0) return null;
            return <button className="ctx-menu-item" onClick={() => { void window.rd.skipItems(skippable); setContextMenu(null); }}>Überspringen{skippable.length > 1 ? ` (${skippable.length})` : ""}</button>;
          })()}
          {hasPackages && (
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              setContextMenu(null);
              const ids = new Set([...selectedIds].filter((id) => snapshot.session.packages[id]));
              if (settingsDraft.confirmDeleteSelection) { setDeleteConfirm({ ids, dontAsk: false }); }
              else { executeDeleteSelection(ids); }
            }}>{multi ? `Ausgewählte löschen (${[...selectedIds].filter((id) => snapshot.session.packages[id]).length})` : "Löschen"}</button>
          )}
        </div>
        );
      })()}
      {colHeaderCtx && (
        <div ref={colHeaderCtxRef} className="ctx-menu" style={{ left: colHeaderCtx.x, top: colHeaderCtx.y }} onClick={(e) => e.stopPropagation()}>
          {ALL_COLUMN_KEYS.map((col) => {
            const def = COLUMN_DEFS[col];
            if (!def) return null;
            const isVisible = columnOrder.includes(col);
            const isRequired = col === "name";
            return (
              <button
                key={col}
                className={`ctx-menu-item${isRequired ? " ctx-menu-disabled" : ""}${isVisible ? " ctx-menu-active" : ""}`}
                disabled={isRequired}
                onClick={() => {
                  if (isRequired) return;
                  let newOrder: string[];
                  if (isVisible) {
                    newOrder = columnOrder.filter((c) => c !== col);
                  } else {
                    // Insert at original default position relative to existing columns
                    newOrder = [...columnOrder];
                    const defaultIdx = ALL_COLUMN_KEYS.indexOf(col);
                    let insertAt = newOrder.length;
                    for (let i = 0; i < newOrder.length; i++) {
                      if (ALL_COLUMN_KEYS.indexOf(newOrder[i]) > defaultIdx) {
                        insertAt = i;
                        break;
                      }
                    }
                    newOrder.splice(insertAt, 0, col);
                  }
                  setColumnOrder(newOrder);
                  void window.rd.updateSettings({ columnOrder: newOrder });
                }}
              >
                {isVisible ? "\u2713 " : "\u2003 "}{def.label}
              </button>
            );
          })}
        </div>
      )}
      {historyCtxMenu && (() => {
        const multi = selectedHistoryIds.size > 1;
        const contextEntry = historyEntries.find(e => e.id === historyCtxMenu.entryId);
        const hasUrls = (contextEntry?.urls?.length ?? 0) > 0;
        const removeSelected = (): void => {
          const ids = [...selectedHistoryIds];
          void Promise.all(ids.map(id => window.rd.removeHistoryEntry(id))).then(() => {
            setHistoryEntries((prev) => prev.filter((e) => !selectedHistoryIds.has(e.id)));
            setSelectedHistoryIds(new Set());
          });
          setHistoryCtxMenu(null);
        };
        return (
          <div ref={historyCtxMenuRef} className="ctx-menu" style={{ left: historyCtxMenu.x, top: historyCtxMenu.y }} onClick={(e) => e.stopPropagation()}>
            <button className="ctx-menu-item ctx-danger" onClick={removeSelected}>
              {multi ? `Ausgewählte entfernen (${selectedHistoryIds.size})` : "Eintrag entfernen"}
            </button>
            {hasUrls && !multi && (
              <>
                <div className="ctx-menu-sep" />
                <button className="ctx-menu-item" onClick={() => {
                  const urls = contextEntry!.urls!;
                  setLinkPopup({ title: contextEntry!.name, links: urls, isPackage: urls.length > 1 });
                  setHistoryCtxMenu(null);
                }}>Linkadressen anzeigen</button>
              </>
            )}
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item ctx-danger" onClick={() => {
              void window.rd.clearHistory().then(() => { setHistoryEntries([]); setSelectedHistoryIds(new Set()); });
              setHistoryCtxMenu(null);
            }}>Verlauf leeren</button>
          </div>
        );
      })()}
      {linkPopup && (
        <div className="modal-backdrop" onClick={() => setLinkPopup(null)}>
          <div className="modal-card link-popup" onClick={(e) => e.stopPropagation()}>
            <h3>Linkadressen anzeigen</h3>
            <p>{linkPopup.title}</p>
            <div className="link-popup-list">
              {linkPopup.links.map((link, i) => (
                <div key={i} className="link-popup-row">
                  <span className="link-popup-name link-popup-click" title={`${link.name}\nKlicken zum Kopieren`} onClick={() => { void navigator.clipboard.writeText(link.name); showToast("Name kopiert"); }}>{link.name}</span>
                  <span className="link-popup-url link-popup-click" title={`${link.url}\nKlicken zum Kopieren`} onClick={() => { void navigator.clipboard.writeText(link.url); showToast("Link kopiert"); }}>{link.url}</span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              {linkPopup.isPackage && (
                <button className="btn" onClick={() => {
                  const text = linkPopup.links.map((l) => l.name).join("\n");
                  void navigator.clipboard.writeText(text);
                  showToast("Alle Namen kopiert");
                }}>Alle Namen kopieren</button>
              )}
              {linkPopup.isPackage && (
                <button className="btn" onClick={() => {
                  const text = linkPopup.links.map((l) => l.url).join("\n");
                  void navigator.clipboard.writeText(text);
                  showToast("Alle Links kopiert");
                }}>Alle Links kopieren</button>
              )}
              <button className="btn" onClick={() => setLinkPopup(null)}>Schließen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface PackageCardProps {
  pkg: PackageEntry;
  items: DownloadItem[];
  packageSpeed: number;
  isFirst: boolean;
  isLast: boolean;
  isEditing: boolean;
  editingName: string;
  collapsed: boolean;
  selectedIds: Set<string>;
  columnOrder: string[];
  gridTemplate: string;
  onSelect: (id: string, ctrlKey: boolean) => void;
  onSelectMouseDown: (id: string, e: React.MouseEvent) => void;
  onSelectMouseEnter: (id: string) => void;
  onStartEdit: (packageId: string, packageName: string) => void;
  onFinishEdit: (packageId: string, currentName: string, nextName: string) => void;
  onEditChange: (name: string) => void;
  onToggleCollapse: (packageId: string) => void;
  onCancel: (packageId: string) => void;
  onMoveUp: (packageId: string) => void;
  onMoveDown: (packageId: string) => void;
  onToggle: (packageId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onContextMenu: (packageId: string, itemId: string | undefined, x: number, y: number) => void;
  onDragStart: (packageId: string) => void;
  onDrop: (packageId: string) => void;
  onDragEnd: () => void;
}

const PackageCard = memo(function PackageCard({ pkg, items, packageSpeed, isFirst, isLast, isEditing, editingName, collapsed, selectedIds, columnOrder, gridTemplate, onSelect, onSelectMouseDown, onSelectMouseEnter, onStartEdit, onFinishEdit, onEditChange, onToggleCollapse, onCancel, onMoveUp, onMoveDown, onToggle, onRemoveItem, onContextMenu, onDragStart, onDrop, onDragEnd }: PackageCardProps): ReactElement {
  const done = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const extracted = items.filter((item) => item.fullStatus?.startsWith("Entpackt")).length;
  const extracting = items.some((item) => item.fullStatus?.startsWith("Entpack"));
  const total = Math.max(1, items.length);
  // Use 50/50 split when extraction is active OR package is in extracting state
  // (prevents bar jumping from 100% to 50% when extraction starts)
  const allDownloaded = done + failed + cancelled >= total;
  const allExtracted = extracted >= total;
  const useExtractSplit = extracting || pkg.status === "extracting" || (allDownloaded && !allExtracted && done > 0 && extracted > 0 && failed === 0 && cancelled === 0);
  // Include fractional progress from active downloads so the bar moves continuously
  const activeProgress = items.reduce((sum, item) => {
    if (item.status === "downloading" || (item.status === "queued" && (item.progressPercent || 0) > 0)) {
      return sum + (item.progressPercent || 0) / 100;
    }
    return sum;
  }, 0);
  const dlProgress = Math.floor(((done + activeProgress) / total) * (useExtractSplit ? 50 : 100));
  // Include fractional progress from items currently being extracted
  const extractingProgress = items.reduce((sum, item) => {
    const fs = item.fullStatus || "";
    if (fs.startsWith("Entpackt")) return sum;
    const m = fs.match(/^Entpacken\s+(\d+)%/);
    if (m) return sum + Number(m[1]) / 100;
    return sum;
  }, 0);
  const exProgress = Math.floor(((extracted + extractingProgress) / total) * 50);
  const combinedProgress = useExtractSplit ? dlProgress + exProgress : dlProgress;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { onFinishEdit(pkg.id, pkg.name, editingName); }
    if (e.key === "Escape") { onFinishEdit(pkg.id, pkg.name, pkg.name); }
  };

  return (
    <article
      className={`package-card${pkg.enabled ? "" : " disabled-pkg"}${selectedIds.has(pkg.id) ? " pkg-selected" : ""}`}
      draggable
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(pkg.id, undefined, e.clientX, e.clientY); }}
      onClick={(e) => { if (e.ctrlKey) onSelect(pkg.id, true); }}
      onMouseDown={(e) => onSelectMouseDown(pkg.id, e)}
      onMouseEnter={() => onSelectMouseEnter(pkg.id)}
      onDragStart={(event) => { event.stopPropagation(); onDragStart(pkg.id); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDrop(pkg.id); }}
      onDragEnd={(event) => { event.stopPropagation(); onDragEnd(); }}
    >
      <header onClick={(e) => {
        if (e.ctrlKey) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
        onToggleCollapse(pkg.id);
      }} style={{ cursor: "pointer" }}>
        <div className="pkg-columns" style={{ gridTemplateColumns: gridTemplate }}>
          {columnOrder.map((col) => {
            switch (col) {
              case "name": return (
                <div key={col} className="pkg-col pkg-col-name">
                  <button className="pkg-toggle" onClick={() => onToggleCollapse(pkg.id)} title={collapsed ? "Ausklappen" : "Einklappen"}>{collapsed ? "+" : "\u2212"}</button>
                  <input type="checkbox" checked={pkg.enabled} onChange={() => onToggle(pkg.id)} title={pkg.enabled ? "Paket aktiv" : "Paket deaktiviert"} />
                  {isEditing ? (
                    <input className="rename-input" value={editingName} onChange={(e) => onEditChange(e.target.value)} onBlur={() => onFinishEdit(pkg.id, pkg.name, editingName)} onKeyDown={onKeyDown} autoFocus />
                  ) : (
                    <h4 onClick={(e) => { e.stopPropagation(); onStartEdit(pkg.id, pkg.name); }} title="Klicken zum Umbenennen">{pkg.name}</h4>
                  )}
                </div>
              );
              case "size": return (
                <span key={col} className="pkg-col pkg-col-size">{(() => {
                  const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || item.downloadedBytes || 0), 0);
                  const dlBytes = items.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
                  const pct = totalBytes > 0 ? Math.min(100, Math.round((dlBytes / totalBytes) * 100)) : 0;
                  const label = `${humanSize(dlBytes)} / ${humanSize(totalBytes)}`;
                  return totalBytes > 0 ? (
                    <span className="progress-size">
                      <span className="progress-size-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-size-text">{label}</span>
                      <span className="progress-size-text-filled" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{label}</span>
                    </span>
                  ) : "";
                })()}</span>
              );
              case "progress": return (
                <span key={col} className="pkg-col pkg-col-progress">
                  <span className="progress-inline">
                    <span className="progress-inline-bar" style={{ width: `${combinedProgress}%` }} />
                    <span className="progress-inline-text">{combinedProgress}%</span>
                    <span className="progress-inline-text-filled" style={{ clipPath: `inset(0 ${100 - combinedProgress}% 0 0)` }}>{combinedProgress}%</span>
                  </span>
                </span>
              );
              case "hoster": return (
                <span key={col} className="pkg-col pkg-col-hoster" title={(() => {
                  const hosters = [...new Set(items.map((item) => extractHoster(item.url)).filter(Boolean))];
                  return hosters.join(", ");
                })()}>{(() => {
                  const hosters = [...new Set(items.map((item) => extractHoster(item.url)).filter(Boolean))];
                  return hosters.length > 0 ? hosters.join(", ") : "";
                })()}</span>
              );
              case "account": return (
                <span key={col} className="pkg-col pkg-col-account" title={(() => {
                  const providers = [...new Set(items.map((item) => item.provider).filter(Boolean))];
                  return providers.map((p) => providerLabels[p!] || p).join(", ");
                })()}>{(() => {
                  const providers = [...new Set(items.map((item) => item.provider).filter(Boolean))];
                  return providers.length > 0 ? providers.map((p) => providerLabels[p!] || p).join(", ") : "";
                })()}</span>
              );
              case "prio": return (
                <span key={col} className={`pkg-col pkg-col-prio${pkg.priority === "high" ? " prio-high" : pkg.priority === "low" ? " prio-low" : ""}`}>{pkg.priority === "high" ? "Hoch" : pkg.priority === "low" ? "Niedrig" : ""}</span>
              );
              case "status": return (
                <span key={col} className="pkg-col pkg-col-status">[{done}/{total}{done === total && total > 0 ? " - Done" : ""}{failed > 0 ? ` · ${failed} Fehler` : ""}{cancelled > 0 ? ` · ${cancelled} abgebr.` : ""}]</span>
              );
              case "speed": return (
                <span key={col} className="pkg-col pkg-col-speed">{packageSpeed > 0 ? formatSpeedMbps(packageSpeed) : ""}</span>
              );
              case "added": return (
                <span key={col} className="pkg-col pkg-col-added">{formatDateTime(pkg.createdAt)}</span>
              );
              default: return null;
            }
          })}
        </div>
      </header>
      <div className="progress">
        <div className="progress-dl" style={{ width: `${dlProgress}%` }} />
        {extracting && <div className="progress-ex" style={{ width: `${exProgress}%` }} />}
      </div>
      {!collapsed && items.map((item) => (
        <div key={item.id} className={`item-row${selectedIds.has(item.id) ? " item-selected" : ""}`} style={{ gridTemplateColumns: gridTemplate }} onClick={(e) => { e.stopPropagation(); onSelect(item.id, e.ctrlKey); }} onMouseDown={(e) => { e.stopPropagation(); onSelectMouseDown(item.id, e); }} onMouseEnter={() => onSelectMouseEnter(item.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(pkg.id, item.id, e.clientX, e.clientY); }}>
          {columnOrder.map((col) => {
            switch (col) {
              case "name": return (
                <span key={col} className="pkg-col pkg-col-name item-indent" title={item.fileName}>
                  {item.onlineStatus && <span className={`link-status-dot ${item.onlineStatus}`} title={item.onlineStatus === "online" ? "Online" : item.onlineStatus === "offline" ? "Offline" : "Wird geprüft..."} />}
                  {item.fileName}
                </span>
              );
              case "size": return (
                <span key={col} className="pkg-col pkg-col-size">{(() => {
                  const total = item.totalBytes || item.downloadedBytes || 0;
                  const dl = item.downloadedBytes || 0;
                  const pct = total > 0 ? Math.min(100, Math.round((dl / total) * 100)) : 0;
                  const label = `${humanSize(dl)} / ${humanSize(total)}`;
                  return total > 0 ? (
                    <span className="progress-size progress-size-small">
                      <span className="progress-size-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-size-text">{label}</span>
                      <span className="progress-size-text-filled" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{label}</span>
                    </span>
                  ) : "";
                })()}</span>
              );
              case "progress": return (
                <span key={col} className="pkg-col pkg-col-progress">
                  {item.totalBytes > 0 ? (
                    <span className="progress-inline progress-inline-small">
                      <span className="progress-inline-bar" style={{ width: `${item.progressPercent}%` }} />
                      <span className="progress-inline-text">{item.progressPercent}%</span>
                      <span className="progress-inline-text-filled" style={{ clipPath: `inset(0 ${100 - (item.progressPercent || 0)}% 0 0)` }}>{item.progressPercent}%</span>
                    </span>
                  ) : ""}
                </span>
              );
              case "hoster": return <span key={col} className="pkg-col pkg-col-hoster" title={extractHoster(item.url)}>{extractHoster(item.url) || ""}</span>;
              case "account": return <span key={col} className="pkg-col pkg-col-account">{item.provider ? providerLabels[item.provider] : ""}</span>;
              case "prio": return <span key={col} className="pkg-col pkg-col-prio"></span>;
              case "status": return (
                <span key={col} className="pkg-col pkg-col-status" title={item.retries > 0 ? `${item.fullStatus} · R${item.retries}` : item.fullStatus}>
                  {item.fullStatus}
                </span>
              );
              case "speed": return <span key={col} className="pkg-col pkg-col-speed">{item.speedBps > 0 ? formatSpeedMbps(item.speedBps) : ""}</span>;
              case "added": return <span key={col} className="pkg-col pkg-col-added">{formatDateTime(item.createdAt)}</span>;
              default: return null;
            }
          })}
        </div>
      ))}
    </article>
  );
}, (prev, next) => {
  if (prev.pkg.id !== next.pkg.id) {
    return false;
  }
  if (prev.pkg.updatedAt !== next.pkg.updatedAt
    || prev.pkg.status !== next.pkg.status
    || prev.pkg.enabled !== next.pkg.enabled
    || prev.pkg.name !== next.pkg.name) {
    return false;
  }
  if (prev.packageSpeed !== next.packageSpeed
    || prev.isFirst !== next.isFirst
    || prev.isLast !== next.isLast
    || prev.isEditing !== next.isEditing
    || prev.collapsed !== next.collapsed
    || prev.selectedIds !== next.selectedIds
    || prev.columnOrder !== next.columnOrder
    || prev.gridTemplate !== next.gridTemplate) {
    return false;
  }
  if ((prev.isEditing || next.isEditing) && prev.editingName !== next.editingName) {
    return false;
  }
  if (prev.pkg.itemIds.length !== next.pkg.itemIds.length) {
    return false;
  }
  for (let index = 0; index < prev.pkg.itemIds.length; index += 1) {
    if (prev.pkg.itemIds[index] !== next.pkg.itemIds[index]) {
      return false;
    }
  }
  if (prev.items.length !== next.items.length) {
    return false;
  }
  for (let index = 0; index < prev.items.length; index += 1) {
    const a = prev.items[index];
    const b = next.items[index];
    if (!a || !b) {
      return false;
    }
    if (a.id !== b.id
      || a.updatedAt !== b.updatedAt
      || a.status !== b.status
      || a.fileName !== b.fileName
      || a.progressPercent !== b.progressPercent
      || a.speedBps !== b.speedBps
      || a.retries !== b.retries
      || a.provider !== b.provider
      || a.fullStatus !== b.fullStatus) {
      return false;
    }
  }
  return true;
});
