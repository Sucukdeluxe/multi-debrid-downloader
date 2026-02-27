import { DragEvent, ReactElement, useEffect, useMemo, useState } from "react";
import type { AppSettings, DebridProvider, DownloadItem, PackageEntry, UiSnapshot } from "../shared/types";

type Tab = "collector" | "downloads" | "settings";

const emptySnapshot = (): UiSnapshot => ({
  settings: {
    token: "",
    megaToken: "",
    bestToken: "",
    allDebridToken: "",
    rememberToken: true,
    providerPrimary: "realdebrid",
    providerSecondary: "megadebrid",
    providerTertiary: "bestdebrid",
    autoProviderFallback: true,
    outputDir: "",
    packageName: "",
    autoExtract: true,
    extractDir: "",
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
    updateRepo: "",
    autoUpdateCheck: true
  },
  session: {
    version: 2,
    packageOrder: [],
    packages: {},
    items: {},
    runStartedAt: 0,
    totalDownloadedBytes: 0,
    summaryText: "",
    reconnectUntil: 0,
    reconnectReason: "",
    paused: false,
    running: false,
    updatedAt: Date.now()
  },
  summary: null,
  speedText: "Geschwindigkeit: 0 B/s",
  etaText: "ETA: --",
  canStart: true,
  canStop: false,
  canPause: false
});

const cleanupLabels: Record<string, string> = {
  never: "Nie",
  immediate: "Sofort",
  on_start: "Beim App-Start",
  package_done: "Sobald Paket fertig ist"
};

const providerLabels: Record<DebridProvider, string> = {
  realdebrid: "Real-Debrid",
  megadebrid: "Mega-Debrid",
  bestdebrid: "BestDebrid",
  alldebrid: "AllDebrid"
};

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<UiSnapshot>(emptySnapshot);
  const [tab, setTab] = useState<Tab>("collector");
  const [linksRaw, setLinksRaw] = useState("");
  const [statusToast, setStatusToast] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(emptySnapshot().settings);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    void window.rd.getSnapshot().then((state) => {
      setSnapshot(state);
      setSettingsDraft(state.settings);
    });
    unsubscribe = window.rd.onStateUpdate((state) => {
      setSnapshot(state);
    });
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  const packages = useMemo(() => snapshot.session.packageOrder
    .map((id: string) => snapshot.session.packages[id])
    .filter(Boolean), [snapshot]);

  const onSaveSettings = async (): Promise<void> => {
    await window.rd.updateSettings(settingsDraft);
    setStatusToast("Settings gespeichert");
    setTimeout(() => setStatusToast(""), 1800);
  };

  const onAddLinks = async (): Promise<void> => {
    await window.rd.updateSettings(settingsDraft);
    const result = await window.rd.addLinks({ rawText: linksRaw, packageName: settingsDraft.packageName });
    if (result.addedLinks > 0) {
      setStatusToast(`${result.addedPackages} Paket(e), ${result.addedLinks} Link(s) hinzugefügt`);
      setLinksRaw("");
    } else {
      setStatusToast("Keine gültigen Links gefunden");
    }
    setTimeout(() => setStatusToast(""), 2200);
  };

  const onImportDlc = async (): Promise<void> => {
    const files = await window.rd.pickContainers();
    if (files.length === 0) {
      return;
    }
    const result = await window.rd.addContainers(files);
    setStatusToast(`DLC importiert: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
    setTimeout(() => setStatusToast(""), 2200);
  };

  const onDrop = async (event: DragEvent<HTMLTextAreaElement>): Promise<void> => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []) as File[];
    const dlc = files
      .filter((file) => file.name.toLowerCase().endsWith(".dlc"))
      .map((file) => (file as unknown as { path?: string }).path)
      .filter((value): value is string => !!value);
    if (dlc.length === 0) {
      return;
    }
    const result = await window.rd.addContainers(dlc);
    setStatusToast(`Drag-and-Drop: ${result.addedPackages} Paket(e), ${result.addedLinks} Link(s)`);
    setTimeout(() => setStatusToast(""), 2200);
  };

  const setBool = (key: keyof AppSettings, value: boolean): void => {
    setSettingsDraft((prev: AppSettings) => ({ ...prev, [key]: value }));
  };

  const setText = (key: keyof AppSettings, value: string): void => {
    setSettingsDraft((prev: AppSettings) => ({ ...prev, [key]: value }));
  };

  const setNum = (key: keyof AppSettings, value: number): void => {
    setSettingsDraft((prev: AppSettings) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="app-shell">
      <header className="top-header">
        <div className="title-block">
          <h1>Debrid Download Manager</h1>
          <span>Multi-Provider Workflow</span>
        </div>
        <div className="metrics">
          <div>{snapshot.speedText}</div>
          <div>{snapshot.etaText}</div>
        </div>
      </header>

      <section className="control-strip">
        <div className="buttons">
          <button className="btn accent" disabled={!snapshot.canStart} onClick={() => window.rd.start()}>Start</button>
          <button className="btn" disabled={!snapshot.canPause} onClick={() => window.rd.togglePause()}>
            {snapshot.session.paused ? "Resume" : "Pause"}
          </button>
          <button className="btn" disabled={!snapshot.canStop} onClick={() => window.rd.stop()}>Stop</button>
          <button className="btn" onClick={() => window.rd.clearAll()}>Alles leeren</button>
        </div>
        <div className="speed-config">
          <label>
            <input
              type="checkbox"
              checked={settingsDraft.speedLimitEnabled}
              onChange={(event) => setBool("speedLimitEnabled", event.target.checked)}
            />
            Speed-Limit
          </label>
          <input
            type="number"
            min={0}
            max={500000}
            value={settingsDraft.speedLimitKbps}
            onChange={(event) => setNum("speedLimitKbps", Number(event.target.value) || 0)}
          />
          <span>KB/s</span>
          <select value={settingsDraft.speedLimitMode} onChange={(event) => setText("speedLimitMode", event.target.value)}>
            <option value="global">global</option>
            <option value="per_download">per_download</option>
          </select>
          <button className="btn" onClick={onSaveSettings}>Live speichern</button>
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
            <article className="card">
              <h3>Debrid Provider</h3>
              <label>Real-Debrid API Token</label>
              <input
                type="password"
                value={settingsDraft.token}
                onChange={(event) => setText("token", event.target.value)}
              />
              <label>Mega-Debrid API Token</label>
              <input
                type="password"
                value={settingsDraft.megaToken}
                onChange={(event) => setText("megaToken", event.target.value)}
              />
              <label>BestDebrid API Token</label>
              <input
                type="password"
                value={settingsDraft.bestToken}
                onChange={(event) => setText("bestToken", event.target.value)}
              />
              <label>AllDebrid API Key</label>
              <input
                type="password"
                value={settingsDraft.allDebridToken}
                onChange={(event) => setText("allDebridToken", event.target.value)}
              />
              <label>Primärer Provider</label>
              <select value={settingsDraft.providerPrimary} onChange={(event) => setText("providerPrimary", event.target.value)}>
                {Object.entries(providerLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <label>Sekundärer Provider</label>
              <select value={settingsDraft.providerSecondary} onChange={(event) => setText("providerSecondary", event.target.value)}>
                {Object.entries(providerLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <label>Tertiärer Provider</label>
              <select value={settingsDraft.providerTertiary} onChange={(event) => setText("providerTertiary", event.target.value)}>
                {Object.entries(providerLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={settingsDraft.autoProviderFallback}
                  onChange={(event) => setBool("autoProviderFallback", event.target.checked)}
                />
                Bei Fehler/Fair-Use automatisch zum nächsten Provider wechseln
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settingsDraft.rememberToken}
                  onChange={(event) => setBool("rememberToken", event.target.checked)}
                />
                API Keys lokal speichern
              </label>
              <label>GitHub Repo</label>
              <input value={settingsDraft.updateRepo} onChange={(event) => setText("updateRepo", event.target.value)} />
              <label>
                <input
                  type="checkbox"
                  checked={settingsDraft.autoUpdateCheck}
                  onChange={(event) => setBool("autoUpdateCheck", event.target.checked)}
                />
                Beim Start auf Updates prüfen
              </label>
            </article>

            <article className="card">
              <h3>Paketierung & Zielpfade</h3>
              <label>Download-Ordner</label>
              <div className="input-row">
                <input value={settingsDraft.outputDir} onChange={(event) => setText("outputDir", event.target.value)} />
                <button
                  className="btn"
                  onClick={async () => {
                    const selected = await window.rd.pickFolder();
                    if (selected) {
                      setText("outputDir", selected);
                    }
                  }}
                >Wählen</button>
              </div>
              <label>Paketname (optional)</label>
              <input value={settingsDraft.packageName} onChange={(event) => setText("packageName", event.target.value)} />
              <label>Entpacken nach</label>
              <div className="input-row">
                <input value={settingsDraft.extractDir} onChange={(event) => setText("extractDir", event.target.value)} />
                <button
                  className="btn"
                  onClick={async () => {
                    const selected = await window.rd.pickFolder();
                    if (selected) {
                      setText("extractDir", selected);
                    }
                  }}
                >Wählen</button>
              </div>
              <label><input type="checkbox" checked={settingsDraft.autoExtract} onChange={(event) => setBool("autoExtract", event.target.checked)} /> Auto-Extract</label>
              <label><input type="checkbox" checked={settingsDraft.hybridExtract} onChange={(event) => setBool("hybridExtract", event.target.checked)} /> Hybrid-Extract</label>
            </article>

            <article className="card wide">
              <h3>Linksammler</h3>
              <div className="link-actions">
                <button className="btn" onClick={onImportDlc}>DLC import</button>
                <button className="btn accent" onClick={onAddLinks}>Zur Queue hinzufügen</button>
              </div>
              <textarea
                value={linksRaw}
                onChange={(event) => setLinksRaw(event.target.value)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDrop}
                placeholder="# package: Release-Name\nhttps://...\nhttps://..."
              />
              <p className="hint">.dlc einfach auf das Feld ziehen oder per Button importieren.</p>
            </article>
          </section>
        )}

        {tab === "downloads" && (
          <section className="downloads-view">
            {packages.length === 0 && <div className="empty">Noch keine Pakete in der Queue.</div>}
            {packages.map((pkg) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                items={pkg.itemIds.map((id) => snapshot.session.items[id]).filter(Boolean)}
                onCancel={() => window.rd.cancelPackage(pkg.id)}
              />
            ))}
          </section>
        )}

        {tab === "settings" && (
          <section className="grid-two settings-grid">
            <article className="card">
              <h3>Queue & Reconnect</h3>
              <label>Max. gleichzeitige Downloads</label>
              <input type="number" min={1} max={50} value={settingsDraft.maxParallel} onChange={(event) => setNum("maxParallel", Number(event.target.value) || 1)} />
              <label><input type="checkbox" checked={settingsDraft.autoReconnect} onChange={(event) => setBool("autoReconnect", event.target.checked)} /> Automatischer Reconnect</label>
              <label>Reconnect-Wartezeit (Sek.)</label>
              <input type="number" min={10} max={600} value={settingsDraft.reconnectWaitSeconds} onChange={(event) => setNum("reconnectWaitSeconds", Number(event.target.value) || 45)} />
              <label><input type="checkbox" checked={settingsDraft.autoResumeOnStart} onChange={(event) => setBool("autoResumeOnStart", event.target.checked)} /> Auto-Resume beim Start</label>
            </article>

            <article className="card">
              <h3>Integrität & Cleanup</h3>
              <label><input type="checkbox" checked={settingsDraft.enableIntegrityCheck} onChange={(event) => setBool("enableIntegrityCheck", event.target.checked)} /> SFV/CRC/MD5/SHA1 prüfen</label>
              <label><input type="checkbox" checked={settingsDraft.removeLinkFilesAfterExtract} onChange={(event) => setBool("removeLinkFilesAfterExtract", event.target.checked)} /> Link-Dateien nach Entpacken entfernen</label>
              <label><input type="checkbox" checked={settingsDraft.removeSamplesAfterExtract} onChange={(event) => setBool("removeSamplesAfterExtract", event.target.checked)} /> Samples nach Entpacken entfernen</label>
              <label>Fertiggestellte Downloads entfernen</label>
              <select value={settingsDraft.completedCleanupPolicy} onChange={(event) => setText("completedCleanupPolicy", event.target.value)}>
                {Object.entries(cleanupLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <label>Cleanup nach Entpacken</label>
              <select value={settingsDraft.cleanupMode} onChange={(event) => setText("cleanupMode", event.target.value)}>
                <option value="none">keine Archive löschen</option>
                <option value="trash">Archive in Papierkorb</option>
                <option value="delete">Archive löschen</option>
              </select>
              <label>Konfliktmodus beim Entpacken</label>
              <select value={settingsDraft.extractConflictMode} onChange={(event) => setText("extractConflictMode", event.target.value)}>
                <option value="overwrite">überschreiben</option>
                <option value="skip">überspringen</option>
                <option value="rename">umbenennen</option>
                <option value="ask">nachfragen</option>
              </select>
            </article>

            <div className="settings-actions">
              <button className="btn accent" onClick={onSaveSettings}>Settings speichern</button>
            </div>
          </section>
        )}
      </main>

      {statusToast && <div className="toast">{statusToast}</div>}
    </div>
  );
}

function PackageCard({ pkg, items, onCancel }: { pkg: PackageEntry; items: DownloadItem[]; onCancel: () => void }): ReactElement {
  const done = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const total = Math.max(1, items.length);
  const progress = Math.floor((done / total) * 100);

  return (
    <article className="package-card">
      <header>
        <div>
          <h4>{pkg.name}</h4>
          <span>{done}/{total} fertig · {failed} Fehler · {cancelled} abgebrochen</span>
        </div>
        <button className="btn danger" onClick={onCancel}>Paket abbrechen</button>
      </header>
      <div className="progress">
        <div style={{ width: `${progress}%` }} />
      </div>
      <table>
        <thead>
          <tr>
            <th>Datei</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Fortschritt</th>
            <th>Speed</th>
            <th>Retries</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.fileName}</td>
              <td>{item.provider ? providerLabels[item.provider] : "-"}</td>
              <td title={item.fullStatus}>{item.fullStatus}</td>
              <td>{item.progressPercent}%</td>
              <td>{item.speedBps > 0 ? `${Math.floor(item.speedBps / 1024)} KB/s` : "0 KB/s"}</td>
              <td>{item.retries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
