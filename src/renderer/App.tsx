import { DragEvent, KeyboardEvent, ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, AppTheme, BandwidthScheduleEntry, DebridFallbackProvider, DebridProvider, DownloadItem, DownloadStats, PackageEntry, UiSnapshot, UpdateCheckResult } from "../shared/types";

type Tab = "collector" | "downloads" | "settings";

interface CollectorTab {
  id: string;
  name: string;
  text: string;
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
    rememberToken: true, providerPrimary: "realdebrid", providerSecondary: "megadebrid",
    providerTertiary: "bestdebrid", autoProviderFallback: true, outputDir: "", packageName: "",
    autoExtract: true, extractDir: "", createExtractSubfolder: true, hybridExtract: true,
    cleanupMode: "none", extractConflictMode: "overwrite", removeLinkFilesAfterExtract: false,
    removeSamplesAfterExtract: false, enableIntegrityCheck: true, autoResumeOnStart: true,
    autoReconnect: false, reconnectWaitSeconds: 45, completedCleanupPolicy: "never",
    maxParallel: 4, speedLimitEnabled: false, speedLimitKbps: 0, speedLimitMode: "global",
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

const providerLabels: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid", megadebrid: "Mega-Debrid", bestdebrid: "BestDebrid", alldebrid: "AllDebrid"
};

const fallbackProviderOptions: Array<{ value: DebridFallbackProvider; label: string }> = [
  { value: "none", label: "Kein Fallback" },
  { value: "realdebrid", label: providerLabels.realdebrid },
  { value: "megadebrid", label: providerLabels.megadebrid },
  { value: "bestdebrid", label: providerLabels.bestdebrid },
  { value: "alldebrid", label: providerLabels.alldebrid }
];

function formatSpeedMbps(speedBps: number): string {
  const mbps = Math.max(0, speedBps) / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

let nextCollectorId = 1;

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<UiSnapshot>(emptySnapshot);
  const [tab, setTab] = useState<Tab>("collector");
  const [statusToast, setStatusToast] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(emptySnapshot().settings);
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
  const activeCollectorTabRef = useRef(activeCollectorTab);
  const draggedPackageIdRef = useRef<string | null>(null);

  const currentCollectorTab = collectorTabs.find((t) => t.id === activeCollectorTab) ?? collectorTabs[0];

  useEffect(() => {
    activeCollectorTabRef.current = activeCollectorTab;
  }, [activeCollectorTab]);

  const showToast = (message: string, timeoutMs = 2200): void => {
    setStatusToast(message);
    if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); }
    toastTimerRef.current = setTimeout(() => {
      setStatusToast("");
      toastTimerRef.current = null;
    }, timeoutMs);
  };

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let unsubClipboard: (() => void) | null = null;
    void window.rd.getSnapshot().then((state) => {
      setSnapshot(state);
      setSettingsDraft(state.settings);
      applyTheme(state.settings.theme);
      if (state.settings.autoUpdateCheck) {
        void window.rd.checkUpdates().then((result) => {
          void handleUpdateResult(result, "startup");
        }).catch(() => undefined);
      }
    }).catch((error) => {
      showToast(`Snapshot konnte nicht geladen werden: ${String(error)}`, 2800);
    });
    unsubscribe = window.rd.onStateUpdate((state) => {
      latestStateRef.current = state;
      if (stateFlushTimerRef.current) { return; }
      stateFlushTimerRef.current = setTimeout(() => {
        stateFlushTimerRef.current = null;
        if (latestStateRef.current) {
          setSnapshot(latestStateRef.current);
          latestStateRef.current = null;
        }
      }, 220);
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
    return () => {
      if (stateFlushTimerRef.current) { clearTimeout(stateFlushTimerRef.current); }
      if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); }
      if (unsubscribe) { unsubscribe(); }
      if (unsubClipboard) { unsubClipboard(); }
    };
  }, []);

  const packages = useMemo(() => snapshot.session.packageOrder
    .map((id: string) => snapshot.session.packages[id])
    .filter(Boolean), [snapshot]);

  const handleUpdateResult = async (result: UpdateCheckResult, source: "manual" | "startup"): Promise<void> => {
    if (result.error) {
      if (source === "manual") { showToast(`Update-Check fehlgeschlagen: ${result.error}`, 2800); }
      return;
    }
    if (!result.updateAvailable) {
      if (source === "manual") { showToast(`Kein Update verfügbar (v${result.currentVersion})`, 2000); }
      return;
    }
    const approved = window.confirm(`Update verfügbar: ${result.latestTag} (aktuell v${result.currentVersion})\n\nJetzt automatisch herunterladen und installieren?`);
    if (!approved) { showToast(`Update verfügbar: ${result.latestTag}`, 2600); return; }
    const install = await window.rd.installUpdate();
    if (install.started) { showToast("Updater gestartet - App wird geschlossen", 2600); return; }
    showToast(`Auto-Update fehlgeschlagen: ${install.message}`, 3200);
  };

  const onSaveSettings = async (): Promise<void> => {
    try {
      const result = await window.rd.updateSettings(settingsDraft);
      setSettingsDraft(result);
      applyTheme(result.theme);
      showToast("Settings gespeichert", 1800);
    } catch (error) { showToast(`Settings konnten nicht gespeichert werden: ${String(error)}`, 2800); }
  };

  const onCheckUpdates = async (): Promise<void> => {
    try {
      const result = await window.rd.checkUpdates();
      await handleUpdateResult(result, "manual");
    } catch (error) { showToast(`Update-Check fehlgeschlagen: ${String(error)}`, 2800); }
  };

  const onAddLinks = async (): Promise<void> => {
    try {
      await window.rd.updateSettings(settingsDraft);
      const result = await window.rd.addLinks({ rawText: currentCollectorTab.text, packageName: settingsDraft.packageName });
      if (result.addedLinks > 0) {
        showToast(`${result.addedPackages} Paket(e), ${result.addedLinks} Link(s) hinzugefügt`);
        setCollectorTabs((prev) => prev.map((t) => t.id === currentCollectorTab.id ? { ...t, text: "" } : t));
      } else { showToast("Keine gültigen Links gefunden"); }
    } catch (error) { showToast(`Fehler beim Hinzufügen: ${String(error)}`, 2600); }
  };

  const onImportDlc = async (): Promise<void> => {
    try {
      const files = await window.rd.pickContainers();
      if (files.length === 0) { return; }
      await window.rd.updateSettings(settingsDraft);
      const result = await window.rd.addContainers(files);
      showToast(`DLC importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
    } catch (error) { showToast(`Fehler beim DLC-Import: ${String(error)}`, 2600); }
  };

  const onDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files ?? []) as File[];
    const dlc = files.filter((f) => f.name.toLowerCase().endsWith(".dlc")).map((f) => (f as unknown as { path?: string }).path).filter((v): v is string => !!v);
    const droppedText = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list") || "";
    if (dlc.length > 0) {
      try {
        await window.rd.updateSettings(settingsDraft);
        const result = await window.rd.addContainers(dlc);
        showToast(`Drag-and-Drop: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
      } catch (error) { showToast(`Fehler bei Drag-and-Drop: ${String(error)}`, 2600); }
    } else if (droppedText.trim()) {
      setCollectorTabs((prev) => prev.map((t) => t.id === currentCollectorTab.id
        ? { ...t, text: t.text ? `${t.text}\n${droppedText}` : droppedText } : t));
      setTab("collector");
      showToast("Links per Drag-and-Drop eingefügt");
    }
  };

  const onExportQueue = async (): Promise<void> => {
    try {
      const json = await window.rd.exportQueue();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rd-queue-export.json";
      a.click();
      URL.revokeObjectURL(url);
      showToast("Queue exportiert");
    } catch (error) { showToast(`Export fehlgeschlagen: ${String(error)}`, 2600); }
  };

  const onImportQueue = async (): Promise<void> => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { return; }
        try {
          const text = await file.text();
          const result = await window.rd.importQueue(text);
          showToast(`Importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
        } catch (error) {
          showToast(`Import fehlgeschlagen: ${String(error)}`, 2600);
        }
      };
      input.click();
    } catch (error) { showToast(`Import fehlgeschlagen: ${String(error)}`, 2600); }
  };

  const setBool = (key: keyof AppSettings, value: boolean): void => { setSettingsDraft((prev) => ({ ...prev, [key]: value })); };
  const setText = (key: keyof AppSettings, value: string): void => { setSettingsDraft((prev) => ({ ...prev, [key]: value })); };
  const setNum = (key: keyof AppSettings, value: number): void => { setSettingsDraft((prev) => ({ ...prev, [key]: value })); };

  const performQuickAction = async (action: () => Promise<unknown>): Promise<void> => {
    try { await action(); } catch (error) { showToast(`Fehler: ${String(error)}`, 2600); }
  };

  const movePackage = useCallback((packageId: string, direction: "up" | "down") => {
    const order = [...snapshot.session.packageOrder];
    const idx = order.indexOf(packageId);
    if (idx < 0) { return; }
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= order.length) { return; }
    [order[idx], order[target]] = [order[target], order[idx]];
    void window.rd.reorderPackages(order);
  }, [snapshot.session.packageOrder]);

  const reorderPackagesByDrop = useCallback((draggedPackageId: string, targetPackageId: string) => {
    const order = [...snapshot.session.packageOrder];
    const fromIndex = order.indexOf(draggedPackageId);
    const toIndex = order.indexOf(targetPackageId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }
    const [dragged] = order.splice(fromIndex, 1);
    const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    order.splice(insertIndex, 0, dragged);
    void window.rd.reorderPackages(order);
  }, [snapshot.session.packageOrder]);

  const addCollectorTab = (): void => {
    const id = `tab-${nextCollectorId++}`;
    const name = `Tab ${collectorTabs.length + 1}`;
    setCollectorTabs((prev) => [...prev, { id, name, text: "" }]);
    setActiveCollectorTab(id);
  };

  const removeCollectorTab = (id: string): void => {
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
        const fallback = next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "";
        setActiveCollectorTab(fallback);
      }
      return next;
    });
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

  const schedules = settingsDraft.bandwidthSchedules ?? [];
  const addSchedule = (): void => {
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: [...(prev.bandwidthSchedules ?? []), { startHour: 0, endHour: 8, speedLimitKbps: 0, enabled: true }]
    }));
  };
  const removeSchedule = (idx: number): void => {
    setSettingsDraft((prev) => ({
      ...prev,
      bandwidthSchedules: (prev.bandwidthSchedules ?? []).filter((_, i) => i !== idx)
    }));
  };
  const updateSchedule = (idx: number, field: keyof BandwidthScheduleEntry, value: number | boolean): void => {
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
  }, [snapshot]);

  return (
    <div
      className={`app-shell${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="top-header">
        <div className="title-block">
          <h1>Debrid Download Manager</h1>
          <span>Multi-Provider Workflow</span>
        </div>
        <div className="metrics">
          <div>{snapshot.speedText}</div>
          <div>{snapshot.etaText}</div>
          {snapshot.reconnectSeconds > 0 && (
            <div className="reconnect-badge">Reconnect: {snapshot.reconnectSeconds}s</div>
          )}
        </div>
      </header>

      <section className="control-strip">
        <div className="buttons">
          <button className="btn accent" disabled={!snapshot.canStart} onClick={async () => {
            await performQuickAction(async () => { await window.rd.updateSettings(settingsDraft); await window.rd.start(); });
          }}>Start</button>
          <button className="btn" disabled={!snapshot.canPause} onClick={() => { void performQuickAction(() => window.rd.togglePause()); }}>
            {snapshot.session.paused ? "Resume" : "Pause"}
          </button>
          <button className="btn" disabled={!snapshot.canStop} onClick={() => { void performQuickAction(() => window.rd.stop()); }}>Stop</button>
          <button className="btn" onClick={() => { void performQuickAction(() => window.rd.clearAll()); }}>Alles leeren</button>
          <button className={`btn${snapshot.clipboardActive ? " btn-active" : ""}`} onClick={() => { void performQuickAction(() => window.rd.toggleClipboard()); }}>
            Clipboard {snapshot.clipboardActive ? "An" : "Aus"}
          </button>
        </div>
        <div className="speed-config">
          <label><input type="checkbox" checked={settingsDraft.speedLimitEnabled} onChange={(e) => setBool("speedLimitEnabled", e.target.checked)} /> Speed-Limit</label>
          <input type="number" min={0} max={500000} value={settingsDraft.speedLimitKbps} onChange={(e) => setNum("speedLimitKbps", Number(e.target.value) || 0)} />
          <span>KB/s</span>
          <select value={settingsDraft.speedLimitMode} onChange={(e) => setText("speedLimitMode", e.target.value)}>
            <option value="global">global</option>
            <option value="per_download">per_download</option>
          </select>
        </div>
      </section>

      <nav className="tabs">
        <button className={tab === "collector" ? "tab active" : "tab"} onClick={() => setTab("collector")}>Linksammler</button>
        <button className={tab === "downloads" ? "tab active" : "tab"} onClick={() => setTab("downloads")}>Downloads</button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>Settings</button>
      </nav>

      <main className="tab-content">
        {tab === "collector" && (
          <section className="grid-two">
            <article className="card wide">
              <div className="collector-header">
                <h3>Linksammler</h3>
                <div className="link-actions">
                  <button className="btn" onClick={onImportDlc}>DLC import</button>
                  <button className="btn" onClick={onExportQueue}>Queue Export</button>
                  <button className="btn" onClick={onImportQueue}>Queue Import</button>
                  <button className="btn accent" onClick={onAddLinks}>Zur Queue hinzufugen</button>
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
            <div className="stats-bar">
              <span>Pakete: {snapshot.stats.totalPackages}</span>
              <span>Dateien: {snapshot.stats.totalFiles} fertig</span>
              <span>Gesamt: {humanSize(snapshot.stats.totalDownloaded)}</span>
            </div>
            {packages.length === 0 && <div className="empty">Noch keine Pakete in der Queue.</div>}
            {packages.map((pkg, idx) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                items={pkg.itemIds.map((id) => snapshot.session.items[id]).filter(Boolean)}
                packageSpeed={packageSpeedMap.get(pkg.id) ?? 0}
                isFirst={idx === 0}
                isLast={idx === packages.length - 1}
                isEditing={editingPackageId === pkg.id}
                editingName={editingName}
                onStartEdit={() => { setEditingPackageId(pkg.id); setEditingName(pkg.name); }}
                onFinishEdit={(name) => { setEditingPackageId(null); if (name.trim()) { void window.rd.renamePackage(pkg.id, name); } }}
                onEditChange={setEditingName}
                onCancel={() => { void performQuickAction(() => window.rd.cancelPackage(pkg.id)); }}
                onMoveUp={() => movePackage(pkg.id, "up")}
                onMoveDown={() => movePackage(pkg.id, "down")}
                onToggle={() => { void window.rd.togglePackage(pkg.id); }}
                onRemoveItem={(itemId) => { void window.rd.removeItem(itemId); }}
                onDragStart={() => onPackageDragStart(pkg.id)}
                onDrop={() => onPackageDrop(pkg.id)}
                onDragEnd={onPackageDragEnd}
              />
            ))}
          </section>
        )}

        {tab === "settings" && (
          <section className="settings-shell">
            <article className="card settings-toolbar">
              <div className="settings-toolbar-copy">
                <h3>Einstellungen</h3>
                <span>Kompakt, schnell auffindbar und direkt speicherbar.</span>
              </div>
              <div className="settings-toolbar-actions">
                <button className="btn" onClick={onCheckUpdates}>Updates prufen</button>
                <button className={`btn${settingsDraft.theme === "light" ? " btn-active" : ""}`} onClick={() => {
                  const next = settingsDraft.theme === "dark" ? "light" : "dark";
                  setSettingsDraft((prev) => ({ ...prev, theme: next as AppTheme }));
                  applyTheme(next as AppTheme);
                }}>
                  {settingsDraft.theme === "dark" ? "Light Mode" : "Dark Mode"}
                </button>
                <button className="btn accent" onClick={onSaveSettings}>Settings speichern</button>
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
                <div className="field-grid three">
                  <div><label>Primar</label><select value={settingsDraft.providerPrimary} onChange={(e) => setText("providerPrimary", e.target.value)}>
                    {Object.entries(providerLabels).map(([key, label]) => (<option key={key} value={key}>{label}</option>))}
                  </select></div>
                  <div><label>Sekundar</label><select value={settingsDraft.providerSecondary} onChange={(e) => setText("providerSecondary", e.target.value)}>
                    {fallbackProviderOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                  </select></div>
                  <div><label>Tertiar</label><select value={settingsDraft.providerTertiary} onChange={(e) => setText("providerTertiary", e.target.value)}>
                    {fallbackProviderOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                  </select></div>
                </div>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoProviderFallback} onChange={(e) => setBool("autoProviderFallback", e.target.checked)} /> Bei Fehler/Fair-Use automatisch zum nachsten Provider wechseln</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.rememberToken} onChange={(e) => setBool("rememberToken", e.target.checked)} /> Zugangsdaten lokal speichern</label>
              </article>

              <article className="card settings-card">
                <h3>Pfade & Paketierung</h3>
                <label>Download-Ordner</label>
                <div className="input-row">
                  <input value={settingsDraft.outputDir} onChange={(e) => setText("outputDir", e.target.value)} />
                  <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("outputDir", s); } }); }}>Wahlen</button>
                </div>
                <label>Paketname (optional)</label>
                <input value={settingsDraft.packageName} onChange={(e) => setText("packageName", e.target.value)} />
                <label>Entpacken nach</label>
                <div className="input-row">
                  <input value={settingsDraft.extractDir} onChange={(e) => setText("extractDir", e.target.value)} />
                  <button className="btn" onClick={() => { void performQuickAction(async () => { const s = await window.rd.pickFolder(); if (s) { setText("extractDir", s); } }); }}>Wahlen</button>
                </div>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoExtract} onChange={(e) => setBool("autoExtract", e.target.checked)} /> Auto-Extract</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.hybridExtract} onChange={(e) => setBool("hybridExtract", e.target.checked)} /> Hybrid-Extract</label>
              </article>

              <article className="card settings-card">
                <h3>Queue, Limits & Reconnect</h3>
                <div className="field-grid two">
                  <div><label>Max. Downloads</label><input type="number" min={1} max={50} value={settingsDraft.maxParallel} onChange={(e) => setNum("maxParallel", Number(e.target.value) || 1)} /></div>
                  <div><label>Reconnect-Wartezeit (Sek.)</label><input type="number" min={10} max={600} value={settingsDraft.reconnectWaitSeconds} onChange={(e) => setNum("reconnectWaitSeconds", Number(e.target.value) || 45)} /></div>
                </div>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.speedLimitEnabled} onChange={(e) => setBool("speedLimitEnabled", e.target.checked)} /> Speed-Limit aktivieren</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoReconnect} onChange={(e) => setBool("autoReconnect", e.target.checked)} /> Automatischer Reconnect</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoResumeOnStart} onChange={(e) => setBool("autoResumeOnStart", e.target.checked)} /> Auto-Resume beim Start</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.clipboardWatch} onChange={(e) => setBool("clipboardWatch", e.target.checked)} /> Zwischenablage uberwachen</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.minimizeToTray} onChange={(e) => setBool("minimizeToTray", e.target.checked)} /> In System Tray minimieren</label>
                <h4>Bandbreitenplanung</h4>
                {schedules.map((s, i) => (
                  <div key={i} className="schedule-row">
                    <input type="number" min={0} max={23} value={s.startHour} onChange={(e) => updateSchedule(i, "startHour", Number(e.target.value))} title="Von (Stunde)" />
                    <span>-</span>
                    <input type="number" min={0} max={23} value={s.endHour} onChange={(e) => updateSchedule(i, "endHour", Number(e.target.value))} title="Bis (Stunde)" />
                    <span>Uhr</span>
                    <input type="number" min={0} value={s.speedLimitKbps} onChange={(e) => updateSchedule(i, "speedLimitKbps", Number(e.target.value) || 0)} title="KB/s (0=unbegrenzt)" />
                    <span>KB/s</span>
                    <input type="checkbox" checked={s.enabled} onChange={(e) => updateSchedule(i, "enabled", e.target.checked)} />
                    <button className="btn danger" onClick={() => removeSchedule(i)}>X</button>
                  </div>
                ))}
                <button className="btn" onClick={addSchedule}>Zeitregel hinzufugen</button>
              </article>

              <article className="card settings-card">
                <h3>Integritat, Cleanup & Updates</h3>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.enableIntegrityCheck} onChange={(e) => setBool("enableIntegrityCheck", e.target.checked)} /> SFV/CRC/MD5/SHA1 prufen</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.removeLinkFilesAfterExtract} onChange={(e) => setBool("removeLinkFilesAfterExtract", e.target.checked)} /> Link-Dateien nach Entpacken entfernen</label>
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.removeSamplesAfterExtract} onChange={(e) => setBool("removeSamplesAfterExtract", e.target.checked)} /> Samples nach Entpacken entfernen</label>
                <label>Fertiggestellte Downloads entfernen</label>
                <select value={settingsDraft.completedCleanupPolicy} onChange={(e) => setText("completedCleanupPolicy", e.target.value)}>
                  {Object.entries(cleanupLabels).map(([key, label]) => (<option key={key} value={key}>{label}</option>))}
                </select>
                <div className="field-grid two">
                  <div><label>Cleanup nach Entpacken</label><select value={settingsDraft.cleanupMode} onChange={(e) => setText("cleanupMode", e.target.value)}>
                    <option value="none">keine Archive loschen</option>
                    <option value="trash">Archive in Papierkorb</option>
                    <option value="delete">Archive loschen</option>
                  </select></div>
                  <div><label>Konfliktmodus</label><select value={settingsDraft.extractConflictMode} onChange={(e) => setText("extractConflictMode", e.target.value)}>
                    <option value="overwrite">uberschreiben</option>
                    <option value="skip">uberspringen</option>
                    <option value="rename">umbenennen</option>
                    <option value="ask">nachfragen</option>
                  </select></div>
                </div>
                <label>GitHub Repo</label>
                <input value={settingsDraft.updateRepo} onChange={(e) => setText("updateRepo", e.target.value)} />
                <label className="toggle-line"><input type="checkbox" checked={settingsDraft.autoUpdateCheck} onChange={(e) => setBool("autoUpdateCheck", e.target.checked)} /> Beim Start auf Updates prufen</label>
              </article>
            </section>
          </section>
        )}
      </main>

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
  onStartEdit: () => void;
  onFinishEdit: (name: string) => void;
  onEditChange: (name: string) => void;
  onCancel: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: () => void;
  onRemoveItem: (itemId: string) => void;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

function PackageCard({ pkg, items, packageSpeed, isFirst, isLast, isEditing, editingName, onStartEdit, onFinishEdit, onEditChange, onCancel, onMoveUp, onMoveDown, onToggle, onRemoveItem, onDragStart, onDrop, onDragEnd }: PackageCardProps): ReactElement {
  const done = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const total = Math.max(1, items.length);
  const progress = Math.floor((done / total) * 100);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { onFinishEdit(editingName); }
    if (e.key === "Escape") { onFinishEdit(pkg.name); }
  };

  return (
    <article
      className={`package-card${pkg.enabled ? "" : " disabled-pkg"}`}
      draggable
      onDragStart={(event) => { event.stopPropagation(); onDragStart(); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDrop(); }}
      onDragEnd={(event) => { event.stopPropagation(); onDragEnd(); }}
    >
      <header>
        <div className="pkg-info">
          <div className="pkg-name-row">
            <input type="checkbox" checked={pkg.enabled} onChange={onToggle} title={pkg.enabled ? "Paket aktiv" : "Paket deaktiviert"} />
            {isEditing ? (
              <input className="rename-input" value={editingName} onChange={(e) => onEditChange(e.target.value)} onBlur={() => onFinishEdit(editingName)} onKeyDown={onKeyDown} autoFocus />
            ) : (
              <h4 onDoubleClick={onStartEdit} title="Doppelklick zum Umbenennen">{pkg.name}</h4>
            )}
          </div>
          <span>{done}/{total} fertig {failed > 0 && `· ${failed} Fehler `}{cancelled > 0 && `· ${cancelled} abgebrochen `}
            {packageSpeed > 0 && <span className="pkg-speed">{formatSpeedMbps(packageSpeed)}</span>}
          </span>
        </div>
        <div className="pkg-actions">
          <button className="btn" disabled={isFirst} onClick={onMoveUp} title="Nach oben">&#9650;</button>
          <button className="btn" disabled={isLast} onClick={onMoveDown} title="Nach unten">&#9660;</button>
          <button className={`btn${pkg.enabled ? "" : " btn-active"}`} onClick={onToggle}>{pkg.enabled ? "Paket stoppen" : "Paket starten"}</button>
          <button className="btn danger" onClick={onCancel}>Paket abbrechen</button>
        </div>
      </header>
      <div className="progress"><div style={{ width: `${progress}%` }} /></div>
      <table>
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
              <td className="col-speed num">{formatSpeedMbps(item.speedBps)}</td>
              <td className="col-retries num">{item.retries}</td>
              <td className="col-actions"><button className="btn-icon danger" onClick={() => onRemoveItem(item.id)} title="Entfernen">X</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
