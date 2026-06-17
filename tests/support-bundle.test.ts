import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { buildSupportBundle } from "../src/main/support-bundle";
import type { DownloadManager } from "../src/main/download-manager";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
});

function fakeManager(): DownloadManager {
  const snapshot = {
    stats: {},
    session: { packages: {}, items: {}, packageOrder: [] },
    speedText: "",
    etaText: "",
    canStart: false,
    canStop: false,
    canPause: false
  };
  return {
    getSnapshot: () => snapshot,
    getPackageLogPath: () => null,
    getItemLogPath: () => null
  } as unknown as DownloadManager;
}

describe("buildSupportBundle (async, non-blocking)", () => {
  it("returns a Promise and produces a valid zip with overview + a real on-disk file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-bundle-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "debug_host.txt"), "host-info-test", "utf8");

    const promise = buildSupportBundle(fakeManager(), root, { hostDiagnosticsMode: "none" });
    expect(promise).toBeInstanceOf(Promise);

    const buffer = await promise;
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);

    const entries = new AdmZip(buffer).getEntries().map((e) => e.entryName);
    expect(entries).toContain("overview/meta.json");
    expect(entries).toContain("overview/settings.json");
    expect(entries).toContain("runtime/debug_host.txt");

    const hostEntry = new AdmZip(buffer).getEntry("runtime/debug_host.txt");
    expect(hostEntry?.getData().toString("utf8")).toBe("host-info-test");
  });

  it("does not block the event loop while building (a concurrent timer still fires)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-bundle-"));
    tempDirs.push(root);

    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    await buildSupportBundle(fakeManager(), root, { hostDiagnosticsMode: "none" });
    clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timerFired).toBe(true);
  });
});
