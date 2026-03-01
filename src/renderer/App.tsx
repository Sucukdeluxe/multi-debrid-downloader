import { DragEvent, KeyboardEvent, ReactElement, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppTheme,
  BandwidthScheduleEntry,
  DebridFallbackProvider,
  DebridProvider,
  DownloadItem,
  DownloadStats,
  DuplicatePolicy,
  PackageEntry,
  StartConflictEntry,
  UiSnapshot,
  UpdateCheckResult,
  UpdateInstallProgress
} from "../shared/types";

type Tab = "collector" | "downloads" | "statistics" | "settings";

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

const emptyStats = (): DownloadStats => ({
  totalDownloaded: 0,
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
    maxParallel: 4, retryLimit: 0, speedLimitEnabled: false, speedLimitKbps: 0, speedLimitMode: "global",
    updateRepo: "", autoUpdateCheck: true, clipboardWatch: false, minimizeToTray: false,
    theme: "dark", bandwidthSchedules: []
  },
  session: {
    version: 2, packageOrder: [], packages: {}, items: {}, runStartedAt: 0,
    totalDownloadedBytes: 0, summaryText: "", reconnectUntil: 0, reconnectReason: "",
    paused: false, running: false, updatedAt: Date.now()
  },
  summary: null, stats: emptyStats(), speedText: "Geschwindigkeit: 0 B/s", etaText: "ETA: --",
  canStart: true, canStop: false, canPause: false, clipboardActive: false, reconnectSeconds: 0
});

const cleanupLabels: Record<string, string> = {
  never: "Nie", immediate: "Sofort", on_start: "Beim App-Start", package_done: "Sobald Paket fertig ist"
};

const AUTO_RENDER_PACKAGE_LIMIT = 260;

const providerLabels: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid", megadebrid: "Mega-Debrid", bestdebrid: "BestDebrid", alldebrid: "AllDebrid"
};

function formatSpeedMbps(speedBps: number): string {
  const mbps = Math.max(0, speedBps) / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface BandwidthChartProps {
  items: Record<string, DownloadItem>;
  running: boolean;
  paused: boolean;
}

const BandwidthChart = memo(function BandwidthChart({ items, running, paused }: BandwidthChartProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const speedHistoryRef = useRef<{ time: number; speed: number }[]>([]);
  const lastUpdateRef = useRef<number>(0);
  const [, forceUpdate] = useState(0);
  const animationFrameRef = useRef<number>(0);

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 20, bottom: 30, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.clearRect(0, 0, width, height);

    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    const gridColor = isDark ? "rgba(35, 57, 84, 0.5)" : "rgba(199, 213, 234, 0.5)";
    const textColor = isDark ? "#90a4bf" : "#4e6482";
    const accentColor = isDark ? "#38bdf8" : "#1168d9";
    const fillColor = isDark ? "rgba(56, 189, 248, 0.15)" : "rgba(17, 104, 217, 0.15)";

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (chartHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

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
      ctx.fillText(running ? (paused ? "Pausiert" : "Sammle Daten...") : "Download starten fur Statistiken", width / 2, height / 2);
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
      const now = Date.now();
      if (now - lastUpdateRef.current >= 250) {
        forceUpdate((n) => n + 1);
      }
    }, 250);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const totalSpeed = Object.values(items)
      .filter((item) => item.status === "downloading")
      .reduce((sum, item) => sum + (item.speedBps || 0), 0);

    const history = speedHistoryRef.current;
    history.push({ time: now, speed: paused ? 0 : totalSpeed });

    const cutoff = now - 60000;
    while (history.length > 0 && history[0].time < cutoff) {
      history.shift();
    }

    lastUpdateRef.current = now;
  }, [items, paused]);

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
  }, [drawChart]);

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

export function reorderPackageOrderByDrop(order: string[], draggedPackageId: string, targetPackageId: string): string[] {
  const fromIndex = order.indexOf(draggedPackageId);
  const toIndex = order.indexOf(targetPackageId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return order;
  }
  const next = [...order];
  const [dragged] = next.splice(fromIndex, 1);
  const insertIndex = Math.max(0, Math.min(next.length, toIndex));
  next.splice(insertIndex, 0, dragged);
  return next;
}

export function sortPackageOrderByName(order: string[], packages: Record<string, PackageEntry>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const nameA = (packages[a]?.name ?? "").toLowerCase();
    const nameB = (packages[b]?.name ?? "").toLowerCase();
    const cmp = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
    return descending ? -cmp : cmp;
  });
  return sorted;
}

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
  const [tab, setTab] = useState<Tab>("collector");
  const [statusToast, setStatusToast] = useState("");
  const [updateInstallProgress, setUpdateInstallProgress] = useState<UpdateInstallProgress | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(emptySnapshot().settings);
  const [speedLimitInput, setSpeedLimitInput] = useState(() => formatMbpsInputFromKbps(emptySnapshot().settings.speedLimitKbps));
  const [scheduleSpeedInputs, setScheduleSpeedInputs] = useState<Record<string, string>>({});
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  const settingsDraftRevisionRef = useRef(0);
  const latestStateRef = useRef<UiSnapshot | null>(null);
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
  const [downloadsSortDescending, setDownloadsSortDescending] = useState(false);
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);
  const actionUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const dragOverRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [startConflictPrompt, setStartConflictPrompt] = useState<StartConflictPromptState | null>(null);
  const startConflictResolverRef = useRef<((result: { policy: Extract<DuplicatePolicy, "skip" | "overwrite">; applyToAll: boolean } | null) => void) | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<ConfirmPromptState | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmQueueRef = useRef<Array<{ prompt: ConfirmPromptState; resolve: (confirmed: boolean) => void }>>([]);
  const importQueueFocusHandlerRef = useRef<(() => void) | null>(null);

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
        ? 850
        : itemCount >= 700
          ? 620
          : itemCount >= 250
            ? 420
            : 180;
      if (!state.session.running) {
        flushDelay = Math.min(flushDelay, 260);
      }
      if (activeTabRef.current !== "downloads") {
        flushDelay = Math.max(flushDelay, 320);
      }

      stateFlushTimerRef.current = setTimeout(() => {
        stateFlushTimerRef.current = null;
        if (latestStateRef.current) {
          const next = latestStateRef.current;
          setSnapshot(next);
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
  const visiblePackages = packages;

  useEffect(() => {
    if (!snapshot.session.running) {
      setShowAllPackages(false);
    }
  }, [snapshot.session.running]);

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

      if (conflicts.length > 0) {
        showToast(`Konflikte gelöst: ${overwritten} überschrieben, ${skipped} übersprungen`, 2800);
      }

      await window.rd.start();
    });
  };

  const onStartPauseClick = async (): Promise<void> => {
    if (snapshot.session.running) {
      await performQuickAction(() => window.rd.togglePause());
      return;
    }
    await onStartDownloads();
  };

  const onAddLinks = async (): Promise<void> => {
    await performQuickAction(async () => {
      const activeId = activeCollectorTabRef.current;
      const active = collectorTabsRef.current.find((t) => t.id === activeId) ?? collectorTabsRef.current[0];
      const rawText = active?.text ?? "";
      const persisted = await persistDraftSettings();
      const result = await window.rd.addLinks({ rawText, packageName: persisted.packageName });
      if (result.addedLinks > 0) {
        showToast(`${result.addedPackages} Paket(e), ${result.addedLinks} Link(s) hinzugefügt`);
        setCollectorTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, text: "" } : t));
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
      const result = await window.rd.addContainers(files);
      if (result.addedLinks > 0) {
        showToast(`DLC importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
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
    const files = Array.from(event.dataTransfer.files ?? []) as File[];
    const dlc = files.filter((f) => f.name.toLowerCase().endsWith(".dlc")).map((f) => (f as unknown as { path?: string }).path).filter((v): v is string => !!v);
    const droppedText = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list") || "";
    if (dlc.length > 0) {
      await performQuickAction(async () => {
        await persistDraftSettings();
        const result = await window.rd.addContainers(dlc);
        if (result.addedLinks > 0) {
          showToast(`Drag-and-Drop: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
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
      const json = await window.rd.exportQueue();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rd-queue-export.json";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast("Queue exportiert");
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

  const packageSpeedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of Object.values(snapshot.session.items)) {
      if (item.speedBps > 0) {
        map.set(item.packageId, (map.get(item.packageId) ?? 0) + item.speedBps);
      }
    }
    return map;
  }, [snapshot.session.items]);

  return (
    <div
      className={`app-shell${dragOver ? " drag-over" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (draggedPackageIdRef.current) { return; }
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
      <header className="top-header">
        <div className="header-spacer" />
        <div className="title-block">
          <h1>Multi Debrid Downloader{appVersion ? ` - v${appVersion}` : ""}</h1>
        </div>
        {snapshot.reconnectSeconds > 0 && (
          <div className="metrics">
            <div className="reconnect-badge">Reconnect: {snapshot.reconnectSeconds}s</div>
          </div>
        )}
      </header>

      <section className="control-strip">
        <div className="buttons buttons-left">
          <button
            className="btn accent"
            disabled={actionBusy || (!snapshot.canStart && !snapshot.canPause)}
            onClick={() => { void onStartPauseClick(); }}
          >
            {snapshot.session.running ? (snapshot.session.paused ? "Fortsetzen" : "Pause") : "Start"}
          </button>
          <button className="btn" disabled={!snapshot.canStop || actionBusy} onClick={() => { void performQuickAction(() => window.rd.stop()); }}>Stop</button>
        </div>
        <div className="buttons buttons-right">
          <button
            className="btn"
            disabled={actionBusy}
            onClick={() => {
              void performQuickAction(async () => {
                const confirmed = await askConfirmPrompt({
                  title: "Queue löschen",
                  message: "Wirklich alle Einträge aus der Queue löschen?",
                  confirmLabel: "Alles löschen",
                  danger: true
                });
                if (!confirmed) {
                  return;
                }
                await window.rd.clearAll();
              });
            }}
          >
            Alles leeren
          </button>
          <button className={`btn${snapshot.clipboardActive ? " btn-active" : ""}`} disabled={actionBusy} onClick={() => { void performQuickAction(() => window.rd.toggleClipboard()); }}>
            Clipboard: {snapshot.clipboardActive ? "An" : "Aus"}
          </button>
        </div>
      </section>

      <nav className="tabs">
        <button className={tab === "collector" ? "tab active" : "tab"} onClick={() => setTab("collector")}>Linksammler</button>
        <button className={tab === "downloads" ? "tab active" : "tab"} onClick={() => setTab("downloads")}>Downloads</button>
        <button className={tab === "statistics" ? "tab active" : "tab"} onClick={() => setTab("statistics")}>Statistiken</button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>Einstellungen</button>
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
              <div className="collector-metrics">{snapshot.speedText} | {snapshot.etaText}</div>
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
            <div className="downloads-toolbar">
              <div className="downloads-toolbar-actions">
                <button
                  className="btn"
                  disabled={packages.length === 0}
                  onClick={() => {
                    setCollapsedPackages((prev) => {
                      const next: Record<string, boolean> = { ...prev };
                      const targetState = !allPackagesCollapsed;
                      for (const pkg of packages) {
                        next[pkg.id] = targetState;
                      }
                      return next;
                    });
                  }}
                >
                  {allPackagesCollapsed ? "Alles ausklappen" : "Alles einklappen"}
                </button>
                <button
                  className={`btn${downloadsSortDescending ? " btn-active" : ""}`}
                  disabled={totalPackageCount < 2}
                  onClick={() => {
                    const nextDescending = !downloadsSortDescending;
                    setDownloadsSortDescending(nextDescending);
                    const baseOrder = packageOrderRef.current.length > 0 ? packageOrderRef.current : snapshot.session.packageOrder;
                    const sorted = sortPackageOrderByName(baseOrder, snapshot.session.packages, nextDescending);
                    pendingPackageOrderRef.current = [...sorted];
                    pendingPackageOrderAtRef.current = Date.now();
                    packageOrderRef.current = sorted;
                    void window.rd.reorderPackages(sorted).catch((error) => {
                      pendingPackageOrderRef.current = null;
                      pendingPackageOrderAtRef.current = 0;
                      packageOrderRef.current = serverPackageOrderRef.current;
                      showToast(`Sortierung fehlgeschlagen: ${String(error)}`, 2400);
                    });
                  }}
                >
                  {downloadsSortDescending ? "Z-A" : "A-Z"}
                </button>
              </div>
              <input
                className="search-input"
                type="search"
                value={downloadSearch}
                onChange={(event) => setDownloadSearch(event.target.value)}
                placeholder="Pakete durchsuchen..."
              />
            </div>
            <div className="stats-bar">
              <span>Pakete: {snapshot.stats.totalPackages}</span>
              <span>Dateien: {snapshot.stats.totalFiles} fertig</span>
              <span>Gesamt: {humanSize(snapshot.stats.totalDownloaded)}</span>
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
                onStartEdit={onPackageStartEdit}
                onFinishEdit={onPackageFinishEdit}
                onEditChange={setEditingName}
                onToggleCollapse={onPackageToggleCollapse}
                onCancel={onPackageCancel}
                onMoveUp={onPackageMoveUp}
                onMoveDown={onPackageMoveDown}
                onToggle={onPackageToggle}
                onRemoveItem={onPackageRemoveItem}
                onDragStart={onPackageDragStart}
                onDrop={onPackageDrop}
                onDragEnd={onPackageDragEnd}
              />
            ))}
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
                  <span className="stat-label">Gesamt heruntergeladen</span>
                  <span className="stat-value">{humanSize(snapshot.stats.totalDownloaded)}</span>
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
                  <span className="stat-value">{Object.values(snapshot.session.items).filter((item) => item.status === "downloading").length}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">In Warteschlange</span>
                  <span className="stat-value">{Object.values(snapshot.session.items).filter((item) => item.status === "queued" || item.status === "reconnect_wait").length}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fehlerhaft</span>
                  <span className="stat-value danger">{Object.values(snapshot.session.items).filter((item) => item.status === "failed").length}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">{snapshot.etaText.split(": ")[0]}</span>
                  <span className="stat-value">{snapshot.etaText.split(": ")[1] || "--"}</span>
                </div>
              </div>
            </article>

            <article className="card stats-chart-card">
              <h3>Bandbreitenverlauf</h3>
              <BandwidthChart items={snapshot.session.items} running={snapshot.session.running} paused={snapshot.session.paused} />
            </article>

            <article className="card stats-provider-card">
              <h3>Provider-Statistik</h3>
              <div className="provider-stats">
                {Object.entries(
                  Object.values(snapshot.session.items).reduce((acc, item) => {
                    const provider = item.provider || "unknown";
                    if (!acc[provider]) {
                      acc[provider] = { total: 0, completed: 0, failed: 0, bytes: 0 };
                    }
                    acc[provider].total += 1;
                    if (item.status === "completed") acc[provider].completed += 1;
                    if (item.status === "failed") acc[provider].failed += 1;
                    acc[provider].bytes += item.downloadedBytes;
                    return acc;
                  }, {} as Record<string, { total: number; completed: number; failed: number; bytes: number }>)
                ).map(([provider, stats]) => (
                  <div key={provider} className="provider-stat-item">
                    <span className="provider-name">{provider === "unknown" ? "Unbekannt" : providerLabels[provider as DebridProvider] || provider}</span>
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
                  <button className="btn" disabled={actionBusy} onClick={onCheckUpdates}>Updates prüfen</button>
                  <button className={`btn${settingsDraft.theme === "light" ? " btn-active" : ""}`} onClick={() => {
                    const next = settingsDraft.theme === "dark" ? "light" : "dark";
                    settingsDraftRevisionRef.current += 1;
                    settingsDirtyRef.current = true;
                    setSettingsDirty(true);
                    setSettingsDraft((prev) => ({ ...prev, theme: next as AppTheme }));
                    applyTheme(next as AppTheme);
                  }}>
                    {settingsDraft.theme === "dark" ? "Light Mode" : "Dark Mode"}
                  </button>
                  <button className="btn accent" disabled={actionBusy} onClick={onSaveSettings}>Einstellungen speichern</button>
                </div>
                {updateInstallProgress && (
                  <div className={`update-install-progress update-install-progress-${updateInstallProgress.stage}`}>
                    {formatUpdateInstallProgress(updateInstallProgress)}
                  </div>
                )}
              </div>
            </article>

            <section className="settings-grid">
              <article className="card settings-card">
                <h3>Provider & Zugang</h3>
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
              </article>

              <article className="card settings-card">
                <h3>Pfade & Paketierung</h3>
                <label>Download-Ordner</label>
                <div className="input-row">
                  <input value={settingsDraft.outputDir} onChange={(e) => setText("outputDir", e.target.value)} />
                  <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("outputDir", s); } }); }}>Wählen</button>
                </div>
                <label>Paketname (optional)</label>
                <input value={settingsDraft.packageName} onChange={(e) => setText("packageName", e.target.value)} />
                <label>Entpacken nach</label>
                <div className="input-row">
                  <input value={settingsDraft.extractDir} onChange={(e) => setText("extractDir", e.target.value)} />
                  <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("extractDir", s); } }); }}>Wählen</button>
                </div>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoExtract} onChange={(e) => setBool("autoExtract", e.target.checked)} /> Auto-Extract</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoRename4sf4sj} onChange={(e) => setBool("autoRename4sf4sj", e.target.checked)} /> Auto-Rename (4SF/4SJ)</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.createExtractSubfolder} onChange={(e) => setBool("createExtractSubfolder", e.target.checked)} /> Entpackte Dateien in Paket-Unterordner speichern</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.hybridExtract} onChange={(e) => setBool("hybridExtract", e.target.checked)} /> Hybrid-Extract</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.collectMkvToLibrary} onChange={(e) => setBool("collectMkvToLibrary", e.target.checked)} /> MKV nach Paketabschluss in Sammelordner verschieben (flach)</label>
                <label>MKV-Sammelordner</label>
                <div className="input-row">
                  <input value={settingsDraft.mkvLibraryDir} onChange={(e) => setText("mkvLibraryDir", e.target.value)} disabled={!settingsDraft.collectMkvToLibrary} />
                  <button
                    className="btn"
                    disabled={!settingsDraft.collectMkvToLibrary}
                    onClick={() => {
                      void performQuickAction(async () => {
                        const s = await window.rd.pickFolder();
                        if (s) { setText("mkvLibraryDir", s); }
                      });
                    }}
                  >
                    Wählen
                  </button>
                </div>
                <label>Passwortliste (eine Zeile pro Passwort)</label>
                <textarea
                  className="password-list"
                  value={settingsDraft.archivePasswordList}
                  onChange={(e) => setText("archivePasswordList", e.target.value)}
                  placeholder={"serienfans.org\nserienjunkies.org\nmein-passwort"}
                />
              </article>

              <article className="card settings-card">
                <h3>Queue, Limits & Reconnect</h3>
                <div className="field-grid two">
                  <div><label>Max. Downloads</label><input type="number" min={1} max={50} value={settingsDraft.maxParallel} onChange={(e) => setNum("maxParallel", Number(e.target.value) || 1)} /></div>
                  <div><label>Auto-Retry Limit (0 = inf)</label><input type="number" min={0} max={99} value={settingsDraft.retryLimit} onChange={(e) => setNum("retryLimit", Math.max(0, Math.min(99, Number(e.target.value) || 0)))} /></div>
                  <div><label>Reconnect-Wartezeit (Sek.)</label><input type="number" min={10} max={600} value={settingsDraft.reconnectWaitSeconds} onChange={(e) => setNum("reconnectWaitSeconds", Number(e.target.value) || 45)} /></div>
                </div>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.speedLimitEnabled} onChange={(e) => setBool("speedLimitEnabled", e.target.checked)} /> Speed-Limit aktivieren</label>
                <div className="field-grid two">
                  <div>
                    <label>Limit (MB/s)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={speedLimitInput}
                      onChange={(event) => setSpeedLimitInput(event.target.value)}
                      onBlur={(event) => {
                        const parsed = parseMbpsInput(event.target.value);
                        if (parsed === null) {
                          setSpeedLimitInput(formatMbpsInputFromKbps(settingsDraft.speedLimitKbps));
                          return;
                        }
                        setSpeedLimitMbps(parsed);
                        setSpeedLimitInput(formatMbpsInputFromKbps(Math.floor(parsed * 1024)));
                      }}
                      disabled={!settingsDraft.speedLimitEnabled}
                    />
                  </div>
                  <div>
                    <label>Limit-Modus</label>
                    <select
                      value={settingsDraft.speedLimitMode}
                      onChange={(e) => setText("speedLimitMode", e.target.value)}
                      disabled={!settingsDraft.speedLimitEnabled}
                    >
                      <option value="global">Global</option>
                      <option value="per_download">Pro Download</option>
                    </select>
                  </div>
                </div>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoReconnect} onChange={(e) => setBool("autoReconnect", e.target.checked)} /> Automatischer Reconnect</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoResumeOnStart} onChange={(e) => setBool("autoResumeOnStart", e.target.checked)} /> Auto-Resume beim Start</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.clipboardWatch} onChange={(e) => setBool("clipboardWatch", e.target.checked)} /> Zwischenablage überwachen</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.minimizeToTray} onChange={(e) => setBool("minimizeToTray", e.target.checked)} /> In System Tray minimieren</label>
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
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={speedInput}
                        onChange={(event) => {
                          const nextText = event.target.value;
                          setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: nextText }));
                        }}
                        onBlur={(event) => {
                          const parsed = parseMbpsInput(event.target.value);
                          if (parsed === null) {
                            setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: formatMbpsInputFromKbps(s.speedLimitKbps) }));
                            return;
                          }
                          const nextKbps = Math.floor(parsed * 1024);
                          setScheduleSpeedInputs((prev) => ({ ...prev, [scheduleKey]: formatMbpsInputFromKbps(nextKbps) }));
                          updateSchedule(i, "speedLimitKbps", nextKbps);
                        }}
                        title="MB/s (0=unbegrenzt)"
                      />
                      <span>MB/s</span>
                      <input type="checkbox" checked={s.enabled} onChange={(e) => updateSchedule(i, "enabled", e.target.checked)} />
                      <button className="btn danger" onClick={() => removeSchedule(i)}>X</button>
                    </div>
                  );
                })}
                <button className="btn" onClick={addSchedule}>Zeitregel hinzufügen</button>
              </article>

              <article className="card settings-card">
                <h3>Integrität, Cleanup & Updates</h3>
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
                <label>Codeberg Repo</label>
                <input value={settingsDraft.updateRepo} onChange={(e) => setText("updateRepo", e.target.value)} />
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoUpdateCheck} onChange={(e) => setBool("autoUpdateCheck", e.target.checked)} /> Beim Start auf Updates prüfen</label>
              </article>
            </section>
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

      {startConflictPrompt && (
        <div className="modal-backdrop" onClick={() => closeStartConflictPrompt(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Paket bereits entpackt</h3>
            <p>
              <strong>{startConflictPrompt.entry.packageName}</strong> ist im Ziel bereits vorhanden.
            </p>
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
                Überspringen
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

      {statusToast && <div className="toast">{statusToast}</div>}
      {dragOver && <div className="drop-overlay">Links oder .dlc Dateien hier ablegen</div>}
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
  onStartEdit: (packageId: string, packageName: string) => void;
  onFinishEdit: (packageId: string, currentName: string, nextName: string) => void;
  onEditChange: (name: string) => void;
  onToggleCollapse: (packageId: string) => void;
  onCancel: (packageId: string) => void;
  onMoveUp: (packageId: string) => void;
  onMoveDown: (packageId: string) => void;
  onToggle: (packageId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onDragStart: (packageId: string) => void;
  onDrop: (packageId: string) => void;
  onDragEnd: () => void;
}

const PackageCard = memo(function PackageCard({ pkg, items, packageSpeed, isFirst, isLast, isEditing, editingName, collapsed, onStartEdit, onFinishEdit, onEditChange, onToggleCollapse, onCancel, onMoveUp, onMoveDown, onToggle, onRemoveItem, onDragStart, onDrop, onDragEnd }: PackageCardProps): ReactElement {
  const done = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const total = Math.max(1, items.length);
  const progress = Math.floor((done / total) * 100);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { onFinishEdit(pkg.id, pkg.name, editingName); }
    if (e.key === "Escape") { onFinishEdit(pkg.id, pkg.name, pkg.name); }
  };

  return (
    <article
      className={`package-card${pkg.enabled ? "" : " disabled-pkg"}`}
      draggable
      onDragStart={(event) => { event.stopPropagation(); onDragStart(pkg.id); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDrop(pkg.id); }}
      onDragEnd={(event) => { event.stopPropagation(); onDragEnd(); }}
    >
      <header>
        <div className="pkg-info">
          <div className="pkg-name-row">
            <input type="checkbox" checked={pkg.enabled} onChange={() => onToggle(pkg.id)} title={pkg.enabled ? "Paket aktiv" : "Paket deaktiviert"} />
            {isEditing ? (
              <input className="rename-input" value={editingName} onChange={(e) => onEditChange(e.target.value)} onBlur={() => onFinishEdit(pkg.id, pkg.name, editingName)} onKeyDown={onKeyDown} autoFocus />
            ) : (
              <h4 onDoubleClick={() => onStartEdit(pkg.id, pkg.name)} title="Doppelklick zum Umbenennen">{pkg.name}</h4>
            )}
          </div>
          <span>{done}/{total} fertig {failed > 0 && `· ${failed} Fehler `}{cancelled > 0 && `· ${cancelled} abgebrochen `}
            {packageSpeed > 0 && <span className="pkg-speed">{formatSpeedMbps(packageSpeed)}</span>}
          </span>
        </div>
        <div className="pkg-actions">
          <button className="btn" onClick={() => onToggleCollapse(pkg.id)}>{collapsed ? "Ausklappen" : "Einklappen"}</button>
          <button className="btn" disabled={isFirst} onClick={() => onMoveUp(pkg.id)} title="Nach oben">&#9650;</button>
          <button className="btn" disabled={isLast} onClick={() => onMoveDown(pkg.id)} title="Nach unten">&#9660;</button>
          <button className={`btn${pkg.enabled ? "" : " btn-active"}`} onClick={() => onToggle(pkg.id)}>{pkg.enabled ? "Paket stoppen" : "Paket starten"}</button>
          <button className="btn danger" onClick={() => onCancel(pkg.id)}>Paket löschen</button>
        </div>
      </header>
      <div className="progress"><div style={{ width: `${progress}%` }} /></div>
      {!collapsed && <table>
        <thead><tr>
          <th className="col-file">Datei</th>
          <th className="col-provider">Provider</th>
          <th className="col-status">Status</th>
          <th className="col-progress">Fortschritt</th>
          <th className="col-speed">Speed</th>
          <th className="col-retries">Retries</th>
          <th className="col-actions">Aktion</th>
        </tr></thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="col-file" title={item.fileName}>{item.fileName}</td>
              <td className="col-provider">{item.provider ? providerLabels[item.provider] : "-"}</td>
              <td className="col-status" title={item.fullStatus}>{item.fullStatus}</td>
              <td className="col-progress num">{item.progressPercent}%</td>
              <td className="col-speed num">{item.status === "completed" ? "-" : formatSpeedMbps(item.speedBps)}</td>
              <td className="col-retries num">{item.retries}</td>
              <td className="col-actions"><button className="btn-icon danger" onClick={() => onRemoveItem(item.id)} title="Entfernen">X</button></td>
            </tr>
          ))}
        </tbody>
      </table>}
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
    || prev.collapsed !== next.collapsed) {
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
