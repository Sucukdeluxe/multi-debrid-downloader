import fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface WindowsHostEvent {
  timeCreated: string;
  id: number;
  providerName: string;
  levelDisplayName: string;
  message: string;
  bugcheckCode?: string;
  bugcheckCodeHex?: string;
  reportId?: string;
}

export interface WindowsHostDumpFile {
  name: string;
  fullName: string;
  length: number;
  lastWriteTime: string;
}

export interface WindowsCrashControlInfo {
  crashDumpEnabled: number | null;
  minidumpDir: string;
  dumpFile: string;
  overwrite: number | null;
  logEvent: number | null;
  autoReboot: number | null;
}

export interface WindowsHostDiagnostics {
  collectedAt: string;
  supported: boolean;
  platform: string;
  crashControl: WindowsCrashControlInfo | null;
  recentKernelPower: WindowsHostEvent[];
  recentWerKernel: WindowsHostEvent[];
  recentKernelDump: WindowsHostEvent[];
  recentAppCrashes: WindowsHostEvent[];
  recentMinidumps: WindowsHostDumpFile[];
  assessmentHints: string[];
  errors: string[];
}

const CACHE_TTL_MS = 15_000;

let cachedAt = 0;
let cachedValue: WindowsHostDiagnostics | null = null;

function createEmptyDiagnostics(): WindowsHostDiagnostics {
  return {
    collectedAt: new Date().toISOString(),
    supported: process.platform === "win32",
    platform: process.platform,
    crashControl: null,
    recentKernelPower: [],
    recentWerKernel: [],
    recentKernelDump: [],
    recentAppCrashes: [],
    recentMinidumps: [],
    assessmentHints: [],
    errors: []
  };
}

function runPowerShellJson(script: string): unknown {
  const result = spawnSync(
    process.env.ComSpec && process.env.ComSpec.toLowerCase().includes("pwsh") ? process.env.ComSpec : "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  if (result.status !== 0) {
    const errorText = String(result.stderr || result.stdout || "").trim() || `PowerShell exited with code ${result.status}`;
    throw new Error(errorText);
  }

  const text = String(result.stdout || "").trim();
  if (!text) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEvent(value: unknown): WindowsHostEvent | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    timeCreated: asString(record.TimeCreated),
    id: asNumber(record.Id) || 0,
    providerName: asString(record.ProviderName),
    levelDisplayName: asString(record.LevelDisplayName),
    message: asString(record.Message),
    bugcheckCode: asString(record.BugcheckCode),
    bugcheckCodeHex: asString(record.BugcheckCodeHex),
    reportId: asString(record.ReportId)
  };
}

function normalizeDumpFile(value: unknown): WindowsHostDumpFile | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    name: asString(record.Name),
    fullName: asString(record.FullName),
    length: asNumber(record.Length) || 0,
    lastWriteTime: asString(record.LastWriteTime)
  };
}

function normalizeCrashControl(value: unknown): WindowsCrashControlInfo | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    crashDumpEnabled: asNumber(record.CrashDumpEnabled),
    minidumpDir: asString(record.MinidumpDir),
    dumpFile: asString(record.DumpFile),
    overwrite: asNumber(record.Overwrite),
    logEvent: asNumber(record.LogEvent),
    autoReboot: asNumber(record.AutoReboot)
  };
}

function pushHints(diagnostics: WindowsHostDiagnostics): void {
  if (diagnostics.recentKernelPower.some((entry) => String(entry.bugcheckCode || "").trim() === "0")) {
    diagnostics.assessmentHints.push("Kernel-Power 41 mit BugcheckCode 0 deutet eher auf Freeze, Watchdog oder harten Reset als auf einen sauber erfassten klassischen BSOD hin.");
  }
  if (diagnostics.recentWerKernel.some((entry) => /watchdog/i.test(entry.message))) {
    diagnostics.assessmentHints.push("WER-Kernel meldet WATCHDOG-Live-Dumps. Das spricht eher fuer Kernel-, Treiber- oder Hardware-Stalls als fuer einen normalen User-Mode-App-Crash.");
  }
  if (diagnostics.recentAppCrashes.length === 0) {
    diagnostics.assessmentHints.push("Keine passenden Application-Error- oder Windows-Error-Reporting-Eintraege fuer den Downloader/Electron in den letzten Tagen gefunden.");
  }
  if (diagnostics.recentMinidumps.length === 0) {
    diagnostics.assessmentHints.push("Keine aktuellen Minidumps gefunden. Falls der Server erneut abstuerzt, sollte geprueft werden, ob Windows den Dump wirklich schreiben darf.");
  }
}

function loadFromPowerShell(): WindowsHostDiagnostics {
  const script = String.raw`
$ErrorActionPreference = "SilentlyContinue"

function Convert-EventRecord($eventRecord) {
  $map = @{}
  try {
    [xml]$xml = $eventRecord.ToXml()
    foreach ($node in $xml.Event.EventData.Data) {
      if ($node.Name) {
        $map[$node.Name] = [string]$node.'#text'
      }
    }
  } catch {
  }

  $reportId = ""
  if ([string]$eventRecord.Message -match "ReportId\s+([^,\r\n]+)") {
    $reportId = $Matches[1]
  }

  [PSCustomObject]@{
    TimeCreated = if ($eventRecord.TimeCreated) { $eventRecord.TimeCreated.ToUniversalTime().ToString("o") } else { "" }
    Id = [int]$eventRecord.Id
    ProviderName = [string]$eventRecord.ProviderName
    LevelDisplayName = [string]$eventRecord.LevelDisplayName
    Message = [string]$eventRecord.Message
    BugcheckCode = if ($map.ContainsKey("BugcheckCode")) { [string]$map["BugcheckCode"] } else { "" }
    BugcheckCodeHex = if ($map.ContainsKey("BugcheckCode") -and [int64]$map["BugcheckCode"] -gt 0) { ("0x{0:X}" -f [int64]$map["BugcheckCode"]) } else { "" }
    ReportId = $reportId
  }
}

$startTime = (Get-Date).AddDays(-7)
$crashControl = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl"

$kernelPower = @(
  Get-WinEvent -FilterHashtable @{ LogName = "System"; Id = 41; StartTime = $startTime } -MaxEvents 5 |
    ForEach-Object { Convert-EventRecord $_ }
)

$werKernel = @(
  Get-WinEvent -FilterHashtable @{ LogName = "Microsoft-Windows-WerKernel/Operational"; StartTime = $startTime } -MaxEvents 30 |
    Where-Object { $_.Message -match "WATCHDOG|dump|bugcheck|blue|memory" } |
    Select-Object -First 10 |
    ForEach-Object { Convert-EventRecord $_ }
)

$kernelDump = @(
  Get-WinEvent -FilterHashtable @{ LogName = "Microsoft-Windows-Kernel-Dump/Operational"; StartTime = $startTime } -MaxEvents 20 |
    Select-Object -First 10 |
    ForEach-Object { Convert-EventRecord $_ }
)

$appCrashes = @(
  Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $startTime } -MaxEvents 100 |
    Where-Object {
      ($_.ProviderName -eq "Application Error" -or $_.ProviderName -eq "Windows Error Reporting") -and
      ($_.Message -match "Real-Debrid-Downloader|electron|node\.exe|main\.js")
    } |
    Select-Object -First 10 |
    ForEach-Object { Convert-EventRecord $_ }
)

$dumpFiles = @()
foreach ($dir in @("C:\Windows\Minidump", "C:\Windows\Minidumps")) {
  if (Test-Path $dir) {
    $dumpFiles += Get-ChildItem -Path $dir -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 10 |
      ForEach-Object {
        [PSCustomObject]@{
          Name = $_.Name
          FullName = $_.FullName
          Length = [int64]$_.Length
          LastWriteTime = $_.LastWriteTimeUtc.ToString("o")
        }
      }
  }
}

[PSCustomObject]@{
  CrashControl = [PSCustomObject]@{
    CrashDumpEnabled = if ($null -ne $crashControl.CrashDumpEnabled) { [int]$crashControl.CrashDumpEnabled } else { $null }
    MinidumpDir = [string]$crashControl.MinidumpDir
    DumpFile = [string]$crashControl.DumpFile
    Overwrite = if ($null -ne $crashControl.Overwrite) { [int]$crashControl.Overwrite } else { $null }
    LogEvent = if ($null -ne $crashControl.LogEvent) { [int]$crashControl.LogEvent } else { $null }
    AutoReboot = if ($null -ne $crashControl.AutoReboot) { [int]$crashControl.AutoReboot } else { $null }
  }
  RecentKernelPower = @($kernelPower)
  RecentWerKernel = @($werKernel)
  RecentKernelDump = @($kernelDump)
  RecentAppCrashes = @($appCrashes)
  RecentMinidumps = @($dumpFiles)
} | ConvertTo-Json -Depth 6 -Compress
`;

  const raw = runPowerShellJson(script);
  const parsed = asRecord(raw);
  const diagnostics = createEmptyDiagnostics();
  diagnostics.crashControl = normalizeCrashControl(parsed?.CrashControl ?? null);
  diagnostics.recentKernelPower = Array.isArray(parsed?.RecentKernelPower) ? parsed!.RecentKernelPower.map(normalizeEvent).filter(Boolean) as WindowsHostEvent[] : [];
  diagnostics.recentWerKernel = Array.isArray(parsed?.RecentWerKernel) ? parsed!.RecentWerKernel.map(normalizeEvent).filter(Boolean) as WindowsHostEvent[] : [];
  diagnostics.recentKernelDump = Array.isArray(parsed?.RecentKernelDump) ? parsed!.RecentKernelDump.map(normalizeEvent).filter(Boolean) as WindowsHostEvent[] : [];
  diagnostics.recentAppCrashes = Array.isArray(parsed?.RecentAppCrashes) ? parsed!.RecentAppCrashes.map(normalizeEvent).filter(Boolean) as WindowsHostEvent[] : [];
  diagnostics.recentMinidumps = Array.isArray(parsed?.RecentMinidumps) ? parsed!.RecentMinidumps.map(normalizeDumpFile).filter(Boolean) as WindowsHostDumpFile[] : [];
  diagnostics.collectedAt = new Date().toISOString();
  pushHints(diagnostics);
  return diagnostics;
}

export function getWindowsHostDiagnostics(forceRefresh = false): WindowsHostDiagnostics {
  if (!forceRefresh && cachedValue && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedValue;
  }

  const diagnostics = createEmptyDiagnostics();
  if (process.platform !== "win32") {
    diagnostics.assessmentHints.push("Windows-Host-Diagnose ist nur unter Windows verfuegbar.");
    cachedAt = Date.now();
    cachedValue = diagnostics;
    return diagnostics;
  }

  try {
    const loaded = loadFromPowerShell();
    cachedAt = Date.now();
    cachedValue = loaded;
    return loaded;
  } catch (error) {
    diagnostics.errors.push(String(error instanceof Error ? error.message : error));
    diagnostics.assessmentHints.push("Host-Diagnose konnte nicht vollstaendig geladen werden.");
    cachedAt = Date.now();
    cachedValue = diagnostics;
    return diagnostics;
  }
}

export function getCachedWindowsHostDiagnostics(): WindowsHostDiagnostics | null {
  return cachedValue;
}

export function resetWindowsHostDiagnosticsCache(): void {
  cachedAt = 0;
  cachedValue = null;
}

export function hasRecentWindowsMinidumps(): boolean {
  for (const dir of ["C:\\Windows\\Minidump", "C:\\Windows\\Minidumps"]) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile())) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}
