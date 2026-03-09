import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/windows-host-diagnostics", () => ({
  getWindowsHostDiagnostics: () => ({
    collectedAt: "2026-03-09T00:00:03.000Z",
    supported: true,
    platform: "win32",
    crashControl: {
      crashDumpEnabled: 3,
      minidumpDir: "C:\\Windows\\Minidumps",
      dumpFile: "C:\\Windows\\MEMORY.DMP",
      overwrite: 1,
      logEvent: 1,
      autoReboot: 1
    },
    recentKernelPower: [
      {
        timeCreated: "2026-03-09T00:00:04.000Z",
        id: 41,
        providerName: "Microsoft-Windows-Kernel-Power",
        levelDisplayName: "Critical",
        message: "unexpected restart",
        bugcheckCode: "0",
        bugcheckCodeHex: "",
        reportId: ""
      }
    ],
    recentWerKernel: [],
    recentKernelDump: [],
    recentAppCrashes: [],
    recentMinidumps: [],
    assessmentHints: ["watchdog hint"],
    errors: []
  })
}));

import { defaultSettings } from "../src/main/constants";
import { startDebugServer, stopDebugServer } from "../src/main/debug-server";
import { ensureItemLog, initItemLogs, shutdownItemLogs } from "../src/main/item-log";
import { configureLogger, getLogFilePath } from "../src/main/logger";
import { ensurePackageLog, initPackageLogs, shutdownPackageLogs } from "../src/main/package-log";
import { getSessionLogPath, initSessionLog, shutdownSessionLog } from "../src/main/session-log";
import type { DownloadManager } from "../src/main/download-manager";
import type { UiSnapshot } from "../src/shared/types";

const tempDirs: string[] = [];

async function getFreePort(): Promise<number> {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("port probe failed");
  }
  probe.close();
  await once(probe, "close");
  return address.port;
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`debug server not ready: ${url}`);
}

function buildSnapshot(baseDir: string): UiSnapshot {
  const settings = {
    ...defaultSettings(),
    outputDir: path.join(baseDir, "downloads"),
    extractDir: path.join(baseDir, "extract")
  };

  return {
    settings,
    session: {
      version: 1,
      packageOrder: ["pkg-1"],
      packages: {
        "pkg-1": {
          id: "pkg-1",
          name: "server-package",
          outputDir: path.join(baseDir, "downloads", "server-package"),
          extractDir: path.join(baseDir, "extract", "server-package"),
          status: "downloading",
          itemIds: ["item-1", "item-2"],
          cancelled: false,
          enabled: true,
          priority: "normal",
          postProcessLabel: "",
          createdAt: Date.now() - 30_000,
          updatedAt: Date.now()
        }
      },
      items: {
        "item-1": {
          id: "item-1",
          packageId: "pkg-1",
          url: "https://hoster.example/file-1",
          provider: "realdebrid",
          providerLabel: "Real-Debrid",
          status: "downloading",
          retries: 1,
          speedBps: 8 * 1024 * 1024,
          downloadedBytes: 64 * 1024 * 1024,
          totalBytes: 256 * 1024 * 1024,
          progressPercent: 25,
          fileName: "episode.part1.rar",
          targetPath: path.join(baseDir, "downloads", "server-package", "episode.part1.rar"),
          resumable: true,
          attempts: 1,
          lastError: "",
          fullStatus: "Download läuft (Real-Debrid)",
          createdAt: Date.now() - 30_000,
          updatedAt: Date.now()
        },
        "item-2": {
          id: "item-2",
          packageId: "pkg-1",
          url: "https://hoster.example/file-2",
          provider: "realdebrid",
          providerLabel: "Real-Debrid",
          status: "failed",
          retries: 3,
          speedBps: 0,
          downloadedBytes: 0,
          totalBytes: null,
          progressPercent: 0,
          fileName: "episode.part2.rar",
          targetPath: path.join(baseDir, "downloads", "server-package", "episode.part2.rar"),
          resumable: false,
          attempts: 3,
          lastError: "hoster unavailable",
          fullStatus: "Fehler: hoster unavailable",
          createdAt: Date.now() - 30_000,
          updatedAt: Date.now()
        }
      },
      runStartedAt: Date.now() - 30_000,
      totalDownloadedBytes: 64 * 1024 * 1024,
      summaryText: "",
      reconnectUntil: 0,
      reconnectReason: "",
      paused: false,
      running: true,
      updatedAt: Date.now()
    },
    summary: null,
    stats: {
      totalDownloaded: 64 * 1024 * 1024,
      totalDownloadedAllTime: 128 * 1024 * 1024,
      totalFilesSession: 0,
      totalFilesAllTime: 0,
      totalPackages: 1,
      sessionStartedAt: Date.now() - 30_000
    },
    speedText: "8.0 MB/s",
    etaText: "ETA: 00:25",
    canStart: false,
    canStop: true,
    canPause: true,
    clipboardActive: false,
    reconnectSeconds: 0,
    packageSpeedBps: {
      "pkg-1": 8 * 1024 * 1024
    }
  };
}

async function createFixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-debug-"));
  tempDirs.push(baseDir);
  const token = "debug-secret";
  const port = await getFreePort();
  const snapshot = buildSnapshot(baseDir);

  fs.writeFileSync(path.join(baseDir, "debug_token.txt"), token, "utf8");
  fs.writeFileSync(path.join(baseDir, "debug_port.txt"), String(port), "utf8");
  fs.writeFileSync(path.join(baseDir, "debug_host.txt"), "0.0.0.0", "utf8");

  configureLogger(baseDir);
  fs.writeFileSync(getLogFilePath(), "2026-03-09T00:00:00.000Z [INFO] MAIN-LINE\n", "utf8");

  initSessionLog(baseDir);
  const sessionLogPath = getSessionLogPath();
  if (!sessionLogPath) {
    throw new Error("session log path missing");
  }
  fs.appendFileSync(sessionLogPath, "2026-03-09T00:00:01.000Z [INFO] SESSION-LINE\n", "utf8");

  initPackageLogs(baseDir);
  initItemLogs(baseDir);
  const packageLogPath = ensurePackageLog({
    packageId: "pkg-1",
    name: "server-package",
    outputDir: snapshot.session.packages["pkg-1"]!.outputDir,
    extractDir: snapshot.session.packages["pkg-1"]!.extractDir
  });
  if (!packageLogPath) {
    throw new Error("package log path missing");
  }
  fs.appendFileSync(packageLogPath, "2026-03-09T00:00:02.000Z [INFO] PACKAGE-LINE\n", "utf8");
  const itemLogPath = ensureItemLog({
    itemId: "item-2",
    packageId: "pkg-1",
    packageName: "server-package",
    fileName: "episode.part2.rar",
    targetPath: snapshot.session.items["item-2"]!.targetPath
  });
  if (!itemLogPath) {
    throw new Error("item log path missing");
  }
  fs.appendFileSync(itemLogPath, "2026-03-09T00:00:03.000Z [ERROR] ITEM-LINE\n", "utf8");

  const manager = {
    getSnapshot: () => snapshot,
    getPackageLogPath: (packageId: string) => packageId === "pkg-1" ? packageLogPath : null,
    getItemLogPath: (itemId: string) => itemId === "item-2" ? itemLogPath : null
  } as unknown as DownloadManager;

  startDebugServer(manager, baseDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/health?token=${token}`);

  return {
    baseUrl,
    token
  };
}

afterEach(() => {
  stopDebugServer();
  shutdownSessionLog();
  shutdownPackageLogs();
  shutdownItemLogs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("debug-server", () => {
  it("serves diagnostics with main, session, and package log tails", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}/diagnostics?token=${fixture.token}&package=server-package&lines=20`);
    expect(response.ok).toBe(true);
    const payload = await response.json() as Record<string, any>;

    expect(payload.meta?.appVersion).toBeTruthy();
    expect(payload.meta?.debugServer?.host).toBe("0.0.0.0");
    expect(payload.status?.running).toBe(true);
    expect(payload.host?.platform).toBe("win32");
    expect(payload.host?.recentKernelPower?.[0]?.id).toBe(41);
    expect(payload.selectedPackage?.name).toBe("server-package");
    expect((payload.logs?.main?.lines || []).join("\n")).toContain("MAIN-LINE");
    expect((payload.logs?.session?.lines || []).join("\n")).toContain("SESSION-LINE");
    expect((payload.logs?.package?.lines || []).join("\n")).toContain("PACKAGE-LINE");
  });

  it("serves package details and package log by package query", async () => {
    const fixture = await createFixture();

    const packagesResponse = await fetch(`${fixture.baseUrl}/packages?token=${fixture.token}&package=server&includeItems=1`);
    expect(packagesResponse.ok).toBe(true);
    const packagesPayload = await packagesResponse.json() as Record<string, any>;
    expect(packagesPayload.count).toBe(1);
    expect(packagesPayload.packages?.[0]?.items?.length).toBe(2);

    const logResponse = await fetch(`${fixture.baseUrl}/logs/package?token=${fixture.token}&package=server-package&lines=20`);
    expect(logResponse.ok).toBe(true);
    const logPayload = await logResponse.json() as Record<string, any>;
    expect(logPayload.package?.name).toBe("server-package");
    expect((logPayload.lines || []).join("\n")).toContain("PACKAGE-LINE");
  });

  it("serves item log by item query", async () => {
    const fixture = await createFixture();

    const response = await fetch(`${fixture.baseUrl}/logs/item?token=${fixture.token}&item=episode.part2.rar&lines=20`);
    expect(response.ok).toBe(true);
    const payload = await response.json() as Record<string, any>;
    expect(payload.item?.id).toBe("item-2");
    expect(payload.item?.fileName).toBe("episode.part2.rar");
    expect((payload.lines || []).join("\n")).toContain("ITEM-LINE");
  });

  it("serves host diagnostics separately", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}/host/diagnostics?token=${fixture.token}`);
    expect(response.ok).toBe(true);
    const payload = await response.json() as Record<string, any>;
    expect(payload.platform).toBe("win32");
    expect(payload.crashControl?.crashDumpEnabled).toBe(3);
    expect(payload.assessmentHints?.[0]).toContain("watchdog");
  });

  it("rejects unauthenticated requests", async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.baseUrl}/status`);
    expect(response.status).toBe(401);
  });
});
