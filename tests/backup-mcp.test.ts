import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { buildBackupPayload, resolveMcpRemoteRestore, BackupMcpRemote } from "../src/main/backup-payload";
import { defaultSettings } from "../src/main/constants";
import { normalizeSettings } from "../src/main/storage";
import {
  startDebugServer,
  stopDebugServer,
  restartDebugServer,
  writeDebugServerConfig,
  getDebugAllowlist,
  getDebugServerRuntimeStatus
} from "../src/main/debug-server";
import type { DownloadManager } from "../src/main/download-manager";
import type { AppSettings, SessionState } from "../src/shared/types";

const tempDirs: string[] = [];

function input(settingsOverride: Partial<AppSettings>, mcpRemote?: BackupMcpRemote) {
  return {
    settings: { ...defaultSettings(), ...settingsOverride } as AppSettings,
    appVersion: "1.7.224",
    exportedAt: "2026-06-19T00:00:00.000Z",
    session: {} as unknown as SessionState,
    history: [],
    mcpRemote
  };
}

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
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`debug server not ready: ${url}`);
}

afterEach(() => {
  stopDebugServer();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
});

describe("backup mcpRemote export gating", () => {
  it("includes mcpRemote when backupIncludeMcp is on", () => {
    const section: BackupMcpRemote = { allowlist: ["10.0.0.5", "192.168.1.0/24"], port: 9999, hostMode: "network" };
    const payload = buildBackupPayload(input({ backupIncludeMcp: true }, section));
    expect(payload.mcpRemote).toEqual(section);
  });

  it("omits mcpRemote when the toggle is off even if a section is provided", () => {
    const payload = buildBackupPayload(input({ backupIncludeMcp: false }, { allowlist: ["10.0.0.5"], port: 9868, hostMode: "network" }));
    expect(payload.mcpRemote).toBeUndefined();
  });

  it("omits mcpRemote when toggle on but no section gathered", () => {
    const payload = buildBackupPayload(input({ backupIncludeMcp: true }, undefined));
    expect(payload.mcpRemote).toBeUndefined();
  });

  it("the mcpRemote section carries ONLY allowlist/port/hostMode (no token, publicHost, name)", () => {
    const payload = buildBackupPayload(input({ backupIncludeMcp: true }, { allowlist: ["10.0.0.5"], port: 9868, hostMode: "network" }));
    expect(payload.mcpRemote && Object.keys(payload.mcpRemote).sort()).toEqual(["allowlist", "hostMode", "port"]);
    const sectionJson = JSON.stringify(payload.mcpRemote);
    expect(sectionJson.toLowerCase()).not.toContain("token");
    expect(sectionJson).not.toContain("publicHost");
    expect(sectionJson.toLowerCase()).not.toContain("\"name\"");
  });
});

describe("backupIncludeMcp settings persistence", () => {
  it("normalizeSettings preserves backupIncludeMcp (the toggle survives save/load)", () => {
    expect(normalizeSettings({ backupIncludeMcp: true } as unknown as AppSettings).backupIncludeMcp).toBe(true);
    expect(normalizeSettings({ backupIncludeMcp: false } as unknown as AppSettings).backupIncludeMcp).toBe(false);
    expect(normalizeSettings({} as unknown as AppSettings).backupIncludeMcp).toBe(false);
  });
});

describe("resolveMcpRemoteRestore", () => {
  it("maps network + non-empty allowlist to 0.0.0.0", () => {
    expect(resolveMcpRemoteRestore({ allowlist: ["10.0.0.5"], port: 9868, hostMode: "network" }))
      .toEqual({ host: "0.0.0.0", port: 9868, allowlist: ["10.0.0.5"] });
  });

  it("SAFETY: network with EMPTY allowlist binds local, never 0.0.0.0", () => {
    expect(resolveMcpRemoteRestore({ allowlist: [], port: 9868, hostMode: "network" })?.host).toBe("127.0.0.1");
  });

  it("maps local to 127.0.0.1", () => {
    expect(resolveMcpRemoteRestore({ allowlist: ["10.0.0.5"], port: 9868, hostMode: "local" })?.host).toBe("127.0.0.1");
  });

  it("rejects an out-of-range or non-integer port", () => {
    expect(resolveMcpRemoteRestore({ allowlist: ["10.0.0.5"], port: 80, hostMode: "network" })?.port).toBeUndefined();
    expect(resolveMcpRemoteRestore({ allowlist: ["10.0.0.5"], port: 70000, hostMode: "network" })?.port).toBeUndefined();
    expect(resolveMcpRemoteRestore({ allowlist: ["10.0.0.5"], port: 9868.5, hostMode: "network" })?.port).toBeUndefined();
  });

  it("filters non-string and blank allowlist entries and trims", () => {
    const r = resolveMcpRemoteRestore({ allowlist: ["10.0.0.5", "", "  ", 5, null, " 8.8.8.8 "], port: 9868, hostMode: "network" });
    expect(r?.allowlist).toEqual(["10.0.0.5", "8.8.8.8"]);
  });

  it("returns null for missing or empty/invalid sections", () => {
    expect(resolveMcpRemoteRestore(undefined)).toBeNull();
    expect(resolveMcpRemoteRestore(null)).toBeNull();
    expect(resolveMcpRemoteRestore("x")).toBeNull();
    expect(resolveMcpRemoteRestore({})).toBeNull();
  });
});

describe("backup mcpRemote live restore round-trip", () => {
  it("export -> resolve -> apply is reflected in the running debug-server (proves restart fired)", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-bkmcp-"));
    tempDirs.push(baseDir);
    const startPort = await getFreePort();
    const restorePort = await getFreePort();
    fs.writeFileSync(path.join(baseDir, "debug_token.txt"), "rt-secret", "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_port.txt"), String(startPort), "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_host.txt"), "127.0.0.1", "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_allowlist.txt"), "", "utf8");
    startDebugServer({} as unknown as DownloadManager, baseDir);
    await waitForReady(`http://127.0.0.1:${startPort}/health?token=rt-secret`);
    expect(getDebugAllowlist()).toEqual([]);

    const payload = buildBackupPayload(input(
      { backupIncludeMcp: true },
      { allowlist: ["203.0.113.4", "10.0.0.0/24"], port: restorePort, hostMode: "network" }
    ));

    const restore = resolveMcpRemoteRestore(payload.mcpRemote);
    expect(restore).not.toBeNull();
    writeDebugServerConfig({ host: restore!.host, port: restore!.port, allowlist: restore!.allowlist });
    const status = await restartDebugServer();

    expect(getDebugAllowlist()).toEqual(["203.0.113.4", "10.0.0.0/24"]);
    expect(status.port).toBe(restorePort);
    expect(status.host).toBe("0.0.0.0");
    expect(status.allowlistCount).toBe(2);

    expect(fs.readFileSync(path.join(baseDir, "debug_token.txt"), "utf8").trim()).toBe("rt-secret");
    expect(fs.existsSync(path.join(baseDir, "debug_remote.json"))).toBe(false);

    await waitForReady(`http://127.0.0.1:${restorePort}/health?token=rt-secret`);
  });

  it("full-backup path writes the debug_* files to disk without a restart (boot picks them up)", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-bkmcp2-"));
    tempDirs.push(baseDir);
    const startPort = await getFreePort();
    fs.writeFileSync(path.join(baseDir, "debug_token.txt"), "rt2", "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_port.txt"), String(startPort), "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_host.txt"), "127.0.0.1", "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_allowlist.txt"), "", "utf8");
    startDebugServer({} as unknown as DownloadManager, baseDir);
    await waitForReady(`http://127.0.0.1:${startPort}/health?token=rt2`);

    const restore = resolveMcpRemoteRestore({ allowlist: ["198.51.100.9"], port: 9100, hostMode: "network" });
    writeDebugServerConfig({ host: restore!.host, port: restore!.port, allowlist: restore!.allowlist });

    expect(fs.readFileSync(path.join(baseDir, "debug_host.txt"), "utf8").trim()).toBe("0.0.0.0");
    expect(fs.readFileSync(path.join(baseDir, "debug_port.txt"), "utf8").trim()).toBe("9100");
    expect(fs.readFileSync(path.join(baseDir, "debug_allowlist.txt"), "utf8")).toContain("198.51.100.9");
    expect(getDebugServerRuntimeStatus().port).toBe(startPort);
  });
});

describe("debug-server live diagnostics endpoints", () => {
  it("serves /providers (live cooldown/runtime snapshot) and /logs/conversion over authenticated HTTP", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-prov-"));
    tempDirs.push(baseDir);
    const port = await getFreePort();
    fs.writeFileSync(path.join(baseDir, "debug_token.txt"), "prov-secret", "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_port.txt"), String(port), "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_host.txt"), "127.0.0.1", "utf8");
    fs.writeFileSync(path.join(baseDir, "debug_allowlist.txt"), "", "utf8");
    startDebugServer({} as unknown as DownloadManager, baseDir);
    await waitForReady(`http://127.0.0.1:${port}/health?token=prov-secret`);

    const provRes = await fetch(`http://127.0.0.1:${port}/providers?token=prov-secret`);
    expect(provRes.status).toBe(200);
    const prov = await provRes.json();
    expect(typeof prov.capturedAtMs).toBe("number");
    expect(prov.megaDebrid).toBeTruthy();
    expect(Array.isArray(prov.megaDebrid.accounts)).toBe(true);
    expect(typeof prov.megaDebrid.rotationCursor).toBe("number");
    expect(prov.debridLink).toBeTruthy();
    expect(Array.isArray(prov.debridLink.keys)).toBe(true);

    const unauth = await fetch(`http://127.0.0.1:${port}/providers`);
    expect(unauth.status).toBe(401);

    const convRes = await fetch(`http://127.0.0.1:${port}/logs/conversion?token=prov-secret`);
    expect(convRes.status).toBe(200);
    const conv = await convRes.json();
    expect(Array.isArray(conv.lines)).toBe(true);
    expect(conv).toHaveProperty("available");
  });
});
