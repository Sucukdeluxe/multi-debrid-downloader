import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadManager, extractArchiveNameFromExtractorLogMessage, getAuthoritativeRealDebridTotal, resolveArchiveItemsFromList } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { parseDebridLinkApiKeys } from "../src/shared/debrid-link-keys";
import { getProviderUsageDayKey } from "../src/shared/provider-daily-limits";
import { getItemLogPath, initItemLogs, shutdownItemLogs } from "../src/main/item-log";
import { createStoragePaths, emptySession } from "../src/main/storage";
import { primeDebridLinkRuntimeCooldownForTests, resetDebridLinkRuntimeStateForTests } from "../src/main/debrid";
import { getRenameLogPath, initRenameLog, shutdownRenameLog } from "../src/main/rename-log";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

describe("extractArchiveNameFromExtractorLogMessage", () => {
  it("detects archive names from extractor log variants", () => {
    expect(extractArchiveNameFromExtractorLogMessage("Extract-Backend Start: archive=scn-dhanbs7-S02E008.rar, mode=legacy")).toBe("scn-dhanbs7-S02E008.rar");
    expect(extractArchiveNameFromExtractorLogMessage("Entpacke Archiv: scn-dhanbs7-S02E008.rar -> C:\\target")).toBe("scn-dhanbs7-S02E008.rar");
    expect(extractArchiveNameFromExtractorLogMessage("Entpack-Fehler scn-dhanbs7-S02E008.rar [missing_parts]: Error: boom")).toBe("scn-dhanbs7-S02E008.rar");
  });

  it("returns null when no archive name is present", () => {
    expect(extractArchiveNameFromExtractorLogMessage("Post-Processing Entpacken Ende")).toBeNull();
  });
});

describe("resolveArchiveItemsFromList", () => {
  it("includes duplicate-suffixed archive copies in multipart matches", () => {
    const items = [
      { id: "dup-1", fileName: "show.s01e26.part1.rar" },
      { id: "dup-2", fileName: "show.s01e26.part1.rar", targetPath: "C:\\Downloads\\show.s01e26.part1 (1).rar" },
      { id: "dup-3", fileName: "show.s01e26.part2.rar" }
    ] as any[];

    const resolved = resolveArchiveItemsFromList("show.s01e26.part1.rar", items);

    expect(resolved.map((item) => item.id)).toEqual(["dup-1", "dup-2", "dup-3"]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

async function removeDirWithRetries(dir: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 80));
    }
  }
  if (lastError) {
    throw lastError;
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetDebridLinkRuntimeStateForTests();
  shutdownItemLogs();
  shutdownRenameLog();
  for (const dir of tempDirs.splice(0)) {
    await removeDirWithRetries(dir);
  }
});

describe("download manager", () => {
  it("records history duration from the first actual package start", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-history-"));
    tempDirs.push(root);
    const historyEntries: Array<{ durationSeconds: number; downloadedBytes: number }> = [];
    const manager = new DownloadManager(
      defaultSettings(),
      emptySession(),
      createStoragePaths(path.join(root, "state")),
      {
        onHistoryEntry: (entry) => {
          historyEntries.push({
            durationSeconds: entry.durationSeconds,
            downloadedBytes: entry.downloadedBytes
          });
        }
      }
    );

    const packageId = "history-pkg";
    const itemId = "history-item";
    const pkg = {
      id: packageId,
      name: "History Test",
      outputDir: path.join(root, "downloads", "History Test"),
      extractDir: path.join(root, "extract", "History Test"),
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      priority: "normal",
      createdAt: 1_000,
      updatedAt: 61_000,
      downloadStartedAt: 15_000,
      downloadCompletedAt: 60_000
    };
    const item = {
      id: itemId,
      packageId,
      url: "https://example.com/history.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 90 * 1024 * 1024,
      totalBytes: 90 * 1024 * 1024,
      progressPercent: 100,
      fileName: "history.rar",
      targetPath: path.join(pkg.outputDir, "history.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig",
      createdAt: 15_000,
      updatedAt: 60_000
    };

    (manager as any).recordPackageHistory(packageId, pkg, [item]);

    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0]?.durationSeconds).toBe(45);
    expect(historyEntries[0]?.downloadedBytes).toBe(90 * 1024 * 1024);
  });

  it("keeps the quick post-process requeue once the final package items are finished", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-postprocess-final-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "postprocess-final-pkg";
    const firstItemId = "postprocess-final-item-1";
    const secondItemId = "postprocess-final-item-2";
    const createdAt = Date.now() - 20_000;
    const packageOutputDir = path.join(root, "downloads", "PostProcess Final Round");
    const packageExtractDir = path.join(root, "extract", "PostProcess Final Round");
    fs.mkdirSync(packageOutputDir, { recursive: true });
    fs.mkdirSync(packageExtractDir, { recursive: true });
    fs.writeFileSync(path.join(packageOutputDir, "final-1.rar"), Buffer.alloc(100, 1));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "PostProcess Final Round",
      outputDir: packageOutputDir,
      extractDir: packageExtractDir,
      status: "downloading",
      itemIds: [firstItemId, secondItemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[firstItemId] = {
      id: firstItemId,
      packageId,
      url: "https://example.com/final-1.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 100,
      totalBytes: 100,
      progressPercent: 100,
      fileName: "final-1.rar",
      targetPath: path.join(packageOutputDir, "final-1.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt - Done (<1s)",
      createdAt,
      updatedAt: createdAt
    };
    session.items[secondItemId] = {
      id: secondItemId,
      packageId,
      url: "https://example.com/final-2.rar",
      provider: "realdebrid",
      status: "downloading",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 90,
      totalBytes: 100,
      progressPercent: 90,
      fileName: "final-2.rar",
      targetPath: path.join(packageOutputDir, "final-2.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Download läuft",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        hybridExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    expect((manager as any).shouldCollapseQuickPostProcessRequeue(packageId)).toBe(true);

    const item = (manager as any).session.items[secondItemId];
    item.status = "completed";
    item.downloadedBytes = item.totalBytes;
    item.progressPercent = 100;
    item.fullStatus = "Entpacken - Ausstehend";
    item.updatedAt = Date.now();

    expect((manager as any).session.items[firstItemId].status).toBe("completed");
    expect((manager as any).session.items[secondItemId].status).toBe("completed");
    expect((manager as any).session.packages[packageId].itemIds).toEqual([firstItemId, secondItemId]);

    expect((manager as any).shouldCollapseQuickPostProcessRequeue(packageId)).toBe(false);
  });

  it("extractNow only re-arms completed items that are not already extracted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-extract-now-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "extract-now-pkg";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "Extract Now Test");
    const extractDir = path.join(root, "extract", "Extract Now Test");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const specs = [
      { id: "extract-now-item-1", fileName: "show.e01.rar", fullStatus: "Entpackt - Done (<1s)" },
      { id: "extract-now-item-2", fileName: "show.e02.rar", fullStatus: "Entpackt - Done (1.2s)" },
      { id: "extract-now-item-3", fileName: "show.e03.rar", fullStatus: "Entpacken - Ausstehend" }
    ] as const;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "Extract Now Test",
      outputDir,
      extractDir,
      status: "completed",
      itemIds: specs.map((spec) => spec.id),
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };

    for (const spec of specs) {
      const targetPath = path.join(outputDir, spec.fileName);
      fs.writeFileSync(targetPath, Buffer.alloc(128, 1));
      session.items[spec.id] = {
        id: spec.id,
        packageId,
        url: `https://example.com/${spec.fileName}`,
        provider: "realdebrid",
        status: "completed",
        retries: 0,
        speedBps: 0,
        downloadedBytes: 128,
        totalBytes: 128,
        progressPercent: 100,
        fileName: spec.fileName,
        targetPath,
        resumable: true,
        attempts: 1,
        lastError: "",
        fullStatus: spec.fullStatus,
        createdAt,
        updatedAt: createdAt
      };
    }

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        hybridExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    manager.extractNow(packageId);

    expect((manager as any).session.items["extract-now-item-1"].fullStatus).toBe("Entpackt - Done (<1s)");
    expect((manager as any).session.items["extract-now-item-2"].fullStatus).toBe("Entpackt - Done (1.2s)");
    expect((manager as any).session.items["extract-now-item-3"].fullStatus).toBe("Entpacken - Ausstehend");
    expect((manager as any).session.packages[packageId].status).toBe("queued");
  });

  it("merges duplicate-suffixed completed startup items back into the canonical queued item", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-startup-dup-merge-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "startup-dup-pkg";
    const originalItemId = "startup-dup-original";
    const duplicateItemId = "startup-dup-copy";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "Startup Duplicate Merge");
    const extractDir = path.join(root, "extract", "Startup Duplicate Merge");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const canonicalPath = path.join(outputDir, "episode.part1.rar");
    const duplicatePath = path.join(outputDir, "episode.part1 (1).rar");
    fs.writeFileSync(duplicatePath, Buffer.alloc(128, 7));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "Startup Duplicate Merge",
      outputDir,
      extractDir,
      status: "failed",
      itemIds: [originalItemId, duplicateItemId],
      cancelled: false,
      enabled: true,
      priority: "normal",
      createdAt,
      updatedAt: createdAt
    };
    session.items[originalItemId] = {
      id: originalItemId,
      packageId,
      url: "https://example.com/episode.part1.rar",
      provider: "realdebrid",
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: 128,
      progressPercent: 0,
      fileName: "episode.part1.rar",
      targetPath: canonicalPath,
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt,
      updatedAt: createdAt
    };
    session.items[duplicateItemId] = {
      id: duplicateItemId,
      packageId,
      url: "https://example.com/episode.part1.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 128,
      totalBytes: 128,
      progressPercent: 100,
      fileName: "episode.part1.rar",
      targetPath: duplicatePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (128 B)",
      createdAt,
      updatedAt: createdAt + 5_000
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const current = (manager as any).session;
    expect(current.packages[packageId].itemIds).toEqual([originalItemId]);
    expect(current.items[duplicateItemId]).toBeUndefined();
    expect(current.items[originalItemId].status).toBe("completed");
    expect(current.items[originalItemId].fullStatus).toBe("Fertig (128 B)");
    expect(current.items[originalItemId].targetPath).toBe(canonicalPath);
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(fs.existsSync(duplicatePath)).toBe(false);
  });

  it("keeps a stronger extracted canonical startup state when removing stale duplicate copies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-startup-dup-keep-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "startup-dup-keep-pkg";
    const originalItemId = "startup-dup-keep-original";
    const duplicateItemId = "startup-dup-keep-copy";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "Startup Duplicate Keep");
    const extractDir = path.join(root, "extract", "Startup Duplicate Keep");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const canonicalPath = path.join(outputDir, "episode.part1.rar");
    const duplicatePath = path.join(outputDir, "episode.part1 (1).rar");
    fs.writeFileSync(duplicatePath, Buffer.alloc(256, 9));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "Startup Duplicate Keep",
      outputDir,
      extractDir,
      status: "completed",
      itemIds: [originalItemId, duplicateItemId],
      cancelled: false,
      enabled: true,
      priority: "normal",
      createdAt,
      updatedAt: createdAt
    };
    session.items[originalItemId] = {
      id: originalItemId,
      packageId,
      url: "https://example.com/episode.part1.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 256,
      totalBytes: 256,
      progressPercent: 100,
      fileName: "episode.part1.rar",
      targetPath: canonicalPath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt - Done (1.0s)",
      createdAt,
      updatedAt: createdAt + 10_000
    };
    session.items[duplicateItemId] = {
      id: duplicateItemId,
      packageId,
      url: "https://example.com/episode.part1.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 256,
      totalBytes: 256,
      progressPercent: 100,
      fileName: "episode.part1.rar",
      targetPath: duplicatePath,
      resumable: true,
      attempts: 1,
      lastError: "Checksum error",
      fullStatus: "Entpack-Fehler: Checksum error",
      createdAt,
      updatedAt: createdAt + 5_000
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const current = (manager as any).session;
    expect(current.packages[packageId].itemIds).toEqual([originalItemId]);
    expect(current.items[duplicateItemId]).toBeUndefined();
    expect(current.items[originalItemId].status).toBe("completed");
    expect(current.items[originalItemId].fullStatus).toBe("Entpackt - Done (1.0s)");
    expect(current.items[originalItemId].targetPath).toBe(canonicalPath);
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(fs.existsSync(duplicatePath)).toBe(false);
  });

  function createCompletedArchiveSession(root: string, packageName: string, extractedFileName: string): {
    session: ReturnType<typeof emptySession>;
    packageId: string;
    itemId: string;
    outputDir: string;
    extractDir: string;
    originalExtractedPath: string;
  } {
    const outputDir = path.join(root, "downloads", packageName);
    const extractDir = path.join(root, "extract", packageName);
    fs.mkdirSync(outputDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile(extractedFileName, Buffer.from("video"));
    const archivePath = path.join(outputDir, "episode.zip");
    zip.writeZip(archivePath);
    const archiveSize = fs.statSync(archivePath).size;

    const session = emptySession();
    const packageId = `${packageName}-pkg`;
    const itemId = `${packageName}-item`;
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: packageName,
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: `https://dummy/${packageName}`,
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: archiveSize,
      totalBytes: archiveSize,
      progressPercent: 100,
      fileName: "episode.zip",
      targetPath: archivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (100 MB)",
      createdAt,
      updatedAt: createdAt
    };

    return {
      session,
      packageId,
      itemId,
      outputDir,
      extractDir,
      originalExtractedPath: path.join(extractDir, extractedFileName)
    };
  }

  function createCompletedArchiveSessionFromArchive(
    root: string,
    packageName: string,
    archiveEntries: Array<{ name: string; data: Buffer | string }>
  ): {
    session: ReturnType<typeof emptySession>;
    packageId: string;
    itemId: string;
    outputDir: string;
    extractDir: string;
    archivePath: string;
  } {
    const outputDir = path.join(root, "downloads", packageName);
    const extractDir = path.join(root, "extract", packageName);
    fs.mkdirSync(outputDir, { recursive: true });

    const zip = new AdmZip();
    for (const entry of archiveEntries) {
      zip.addFile(entry.name, typeof entry.data === "string" ? Buffer.from(entry.data) : entry.data);
    }
    const archivePath = path.join(outputDir, "episode.zip");
    zip.writeZip(archivePath);
    const archiveSize = fs.statSync(archivePath).size;

    const session = emptySession();
    const packageId = `${packageName}-pkg`;
    const itemId = `${packageName}-item`;
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: packageName,
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: `https://dummy/${packageName}`,
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: archiveSize,
      totalBytes: archiveSize,
      progressPercent: 100,
      fileName: "episode.zip",
      targetPath: archivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (100 MB)",
      createdAt,
      updatedAt: createdAt
    };

    return {
      session,
      packageId,
      itemId,
      outputDir,
      extractDir,
      archivePath
    };
  }

  it("retries interrupted streams and resumes download", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(512 * 1024, 11);
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/direct") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      directCalls += 1;
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;

      if (directCalls === 1 && start === 0) {
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.write(binary.subarray(0, Math.floor(binary.length / 2)));
        res.socket?.destroy();
        return;
      }

      const chunk = binary.subarray(start);
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/direct`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "episode.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "retry", links: ["https://dummy/retry"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(item?.retries).toBeGreaterThan(0);
      expect(directCalls).toBeGreaterThan(1);
      expect(fs.existsSync(item.targetPath)).toBe(true);
      expect(fs.statSync(item.targetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("requests a fresh direct link after repeated same-link download failures", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 17);
    let badCalls = 0;
    let goodCalls = 0;
    let unrestrictCalls = 0;

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (route === "/bad") {
        badCalls += 1;
        const range = String(req.headers.range || "");
        const match = range.match(/bytes=(\d+)-/i);
        const start = match ? Number(match[1]) : 0;
        const end = Math.min(binary.length, start + 64 * 1024);
        const chunk = binary.subarray(start, end);
        if (start > 0) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
        } else {
          res.statusCode = 200;
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(chunk.length));
        res.write(chunk);
        res.socket?.destroy();
        return;
      }

      if (route === "/good") {
        goodCalls += 1;
        const range = String(req.headers.range || "");
        const match = range.match(/bytes=(\d+)-/i);
        const start = match ? Number(match[1]) : 0;
        const chunk = binary.subarray(start);
        if (start > 0) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
        } else {
          res.statusCode = 200;
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(chunk.length));
        res.end(chunk);
        return;
      }

      res.statusCode = 404;
      res.end("not-found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const badUrl = `http://127.0.0.1:${address.port}/bad`;
    const goodUrl = `http://127.0.0.1:${address.port}/good`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            download: unrestrictCalls === 1 ? badUrl : goodUrl,
            filename: "refresh-link.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          retryLimit: 0
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "fresh-link", links: ["https://dummy/fresh-link"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 12000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(item?.downloadedBytes).toBe(binary.length);
      expect(unrestrictCalls).toBeGreaterThanOrEqual(2);
      expect(badCalls).toBe(3);
      expect(goodCalls).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(item.targetPath)).toBe(true);
      expect(fs.statSync(item.targetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("preserves partial files and requests a fresh direct link when resume gets HTTP 200", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 21);
    const pkgDir = path.join(root, "downloads", "resume-ignored");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "resume-ignored.mkv");
    const partialSize = 96 * 1024;
    fs.writeFileSync(existingTargetPath, binary.subarray(0, partialSize));

    let unrestrictCalls = 0;
    let ignoredRangeCalls = 0;
    let resumeCalls = 0;
    const resumeStarts: number[] = [];

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;

      if (route === "/ignored-range") {
        ignoredRangeCalls += 1;
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.end(binary);
        return;
      }

      if (route === "/resume-ok") {
        resumeCalls += 1;
        resumeStarts.push(start);
        const chunk = binary.subarray(start);
        if (start > 0) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
        } else {
          res.statusCode = 200;
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(chunk.length));
        res.end(chunk);
        return;
      }

      res.statusCode = 404;
      res.end("not-found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const ignoredRangeUrl = `http://127.0.0.1:${address.port}/ignored-range`;
    const resumeUrl = `http://127.0.0.1:${address.port}/resume-ok`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            download: unrestrictCalls === 1 ? ignoredRangeUrl : resumeUrl,
            filename: "resume-ignored.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "resume-ignored-pkg";
      const itemId = "resume-ignored-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "resume-ignored",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "resume-ignored"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/resume-ignored",
        provider: null,
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: partialSize,
        totalBytes: binary.length,
        progressPercent: Math.floor((partialSize / binary.length) * 100),
        fileName: "resume-ignored.mkv",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 1,
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("completed");
      expect(item?.downloadedBytes).toBe(binary.length);
      expect(unrestrictCalls).toBeGreaterThanOrEqual(2);
      expect(ignoredRangeCalls).toBeGreaterThanOrEqual(1);
      expect(resumeCalls).toBeGreaterThanOrEqual(1);
      expect(resumeStarts).toContain(partialSize);
      expect(fs.statSync(existingTargetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("treats tiny Real-Debrid resume size mismatches as completed instead of looping", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const actual = Buffer.alloc(192 * 1024, 17);
    const advertisedSize = actual.length + 5000;
    const pkgDir = path.join(root, "downloads", "rd-mismatch");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "rd-mismatch.part01.rar");
    fs.writeFileSync(existingTargetPath, actual);

    let unrestrictCalls = 0;
    let resumeCalls = 0;
    const resumeStarts: number[] = [];

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/rd-mismatch") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      resumeCalls += 1;
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;
      resumeStarts.push(start);

      if (start >= actual.length) {
        res.statusCode = 206;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Range", `bytes 0-${actual.length - 1}/${actual.length}`);
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }

      const chunk = actual.subarray(start);
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${actual.length - 1}/${actual.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/rd-mismatch`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "rd-mismatch.part01.rar",
            filesize: advertisedSize
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "rd-mismatch-pkg";
      const itemId = "rd-mismatch-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "rd-mismatch",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "rd-mismatch"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/rd-mismatch",
        provider: "realdebrid",
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: actual.length,
        totalBytes: advertisedSize,
        progressPercent: Math.floor((actual.length / advertisedSize) * 100),
        fileName: "rd-mismatch.part01.rar",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 1,
          autoExtract: false,
          autoReconnect: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 12000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("completed");
      expect(item?.downloadedBytes).toBe(actual.length);
      expect(item?.totalBytes).toBe(actual.length);
      expect(unrestrictCalls).toBe(1);
      expect(resumeCalls).toBeGreaterThanOrEqual(1);
      expect(resumeStarts).toContain(actual.length);
      expect(fs.statSync(existingTargetPath).size).toBe(actual.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("accepts the smaller Real-Debrid full response after a resume hard reset", () => {
    const actualSize = 224 * 1024;
    const advertisedSize = actualSize + 5000;
    const partialSize = actualSize - 48 * 1024;

    expect(
      getAuthoritativeRealDebridTotal(
        "realdebrid",
        advertisedSize,
        partialSize,
        200,
        actualSize,
        null,
        true
      )
    ).toEqual({
      totalBytes: actualSize,
      source: "content-length",
      mismatchBytes: 5000
    });

    expect(
      getAuthoritativeRealDebridTotal(
        "realdebrid",
        advertisedSize,
        partialSize,
        200,
        actualSize,
        null,
        false
      )
    ).toBeNull();
  });

  it("does not renew direct links when the file is already complete on disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 31);
    let unrestrictCalls = 0;
    let downloadCalls = 0;

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            download: "https://dummy/direct-complete",
            filename: "direct-complete.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        retryLimit: 1,
        autoExtract: false,
        autoReconnect: false
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    (manager as any).downloadToFile = async (_active: unknown, _directUrl: string, targetPath: string) => {
      downloadCalls += 1;
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, binary);
      throw new Error(`direct_link_retry_exhausted:range_ignored_on_resume:${binary.length}/${binary.length}`);
    };

    manager.addPackages([{ name: "direct-complete", links: ["https://dummy/direct-complete"] }]);
    await manager.start();
    await waitFor(() => !manager.getSnapshot().session.running, 12000);

    const item = Object.values(manager.getSnapshot().session.items)[0];
    expect(item?.status).toBe("completed");
    expect(item?.progressPercent).toBe(100);
    expect(item?.downloadedBytes).toBe(binary.length);
    expect(unrestrictCalls).toBe(1);
    expect(downloadCalls).toBe(1);
    expect(fs.existsSync(item.targetPath)).toBe(true);
    expect(fs.statSync(item.targetPath).size).toBe(binary.length);
  });

  it("completes queued full files during start preflight without unrestricting again", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(192 * 1024, 17);
    const pkgDir = path.join(root, "downloads", "queued-complete");
    fs.mkdirSync(pkgDir, { recursive: true });
    const targetPath = path.join(pkgDir, "queued-complete.rar");
    fs.writeFileSync(targetPath, binary);
    let unrestrictCalls = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        throw new Error(`unexpected unrestrict ${url}`);
      }
      return originalFetch(input, init);
    };

    const session = emptySession();
    const packageId = "queued-complete-pkg";
    const itemId = "queued-complete-item";
    const createdAt = Date.now() - 10_000;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "queued-complete",
      outputDir: pkgDir,
      extractDir: path.join(root, "extract", "queued-complete"),
      status: "queued",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/queued-complete",
      provider: "megadebrid-web",
      status: "queued",
      retries: 2,
      speedBps: 0,
      downloadedBytes: binary.length,
      totalBytes: binary.length,
      progressPercent: 100,
      fileName: "queued-complete.rar",
      targetPath,
      resumable: true,
      attempts: 0,
      lastError: "direct_link_retry_exhausted:HTTP 416",
      fullStatus: "Resume-Link erneuern, Retry 1/3",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        retryLimit: 2,
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await manager.start();
    await waitFor(() => !manager.getSnapshot().session.running, 12000);

    const item = manager.getSnapshot().session.items[itemId];
    expect(item?.status).toBe("completed");
    expect(item?.progressPercent).toBe(100);
    expect(item?.downloadedBytes).toBe(binary.length);
    expect(item?.fullStatus).toContain("Fertig");
    expect(unrestrictCalls).toBe(0);
  });

  it("retries direct-link exhaustion caused by HTTP 416 in-session and then completes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(160 * 1024, 41);
    let unrestrictCalls = 0;
    let downloadCalls = 0;

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            download: `https://dummy/direct-416-${unrestrictCalls}`,
            filename: "direct-416-retry.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        retryLimit: 2,
        autoExtract: false
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    (manager as any).downloadToFile = async (_active: unknown, _directUrl: string, targetPath: string) => {
      downloadCalls += 1;
      if (downloadCalls === 1) {
        throw new Error("direct_link_retry_exhausted:HTTP 416");
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, binary);
      const item = Object.values((manager as any).session.items)[0] as { downloadedBytes: number; totalBytes: number; progressPercent: number } | undefined;
      if (item) {
        item.downloadedBytes = binary.length;
        item.totalBytes = binary.length;
        item.progressPercent = 100;
      }
      return { resumable: true };
    };

    manager.addPackages([{ name: "direct-416-retry", links: ["https://dummy/direct-416-retry"] }]);
    await manager.start();
    await waitFor(() => !manager.getSnapshot().session.running, 12000);

    const item = Object.values(manager.getSnapshot().session.items)[0];
    expect(item?.status).toBe("completed");
    expect(item?.progressPercent).toBe(100);
    expect(item?.downloadedBytes).toBe(binary.length);
    expect(unrestrictCalls).toBe(2);
    expect(downloadCalls).toBe(2);
    expect(fs.existsSync(item.targetPath)).toBe(true);
    expect(fs.statSync(item.targetPath).size).toBe(binary.length);
  });

  it("retries HTTP 416 in-session when using Debrid-Link API and then completes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(160 * 1024, 57);
    let unrestrictCalls = 0;
    let downloadCalls = 0;

    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("debrid-link.com/api/v2/downloader/add")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            value: {
              downloadUrl: `https://dummy/debridlink-direct-${unrestrictCalls}`,
              name: "debridlink-416-retry.mkv",
              size: binary.length
            }
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        debridLinkApiKeys: "dl-test-key",
        providerOrder: ["debridlink"],
        providerPrimary: "debridlink",
        providerSecondary: "none",
        providerTertiary: "none",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        retryLimit: 2,
        autoExtract: false
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    (manager as any).downloadToFile = async (_active: unknown, _directUrl: string, targetPath: string) => {
      downloadCalls += 1;
      if (downloadCalls === 1) {
        throw new Error("direct_link_retry_exhausted:HTTP 416");
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, binary);
      const item = Object.values((manager as any).session.items)[0] as { downloadedBytes: number; totalBytes: number; progressPercent: number } | undefined;
      if (item) {
        item.downloadedBytes = binary.length;
        item.totalBytes = binary.length;
        item.progressPercent = 100;
      }
      return { resumable: true };
    };

    manager.addPackages([{ name: "debridlink-416-retry", links: ["https://dummy/debridlink-416-retry"] }]);
    await manager.start();
    await waitFor(() => !manager.getSnapshot().session.running, 12000);

    const item = Object.values(manager.getSnapshot().session.items)[0];
    expect(item?.status).toBe("completed");
    expect(item?.provider).toBe("debridlink");
    expect(item?.progressPercent).toBe(100);
    expect(item?.downloadedBytes).toBe(binary.length);
    expect(unrestrictCalls).toBe(2);
    expect(downloadCalls).toBe(2);
    expect(fs.existsSync(item.targetPath)).toBe(true);
    expect(fs.statSync(item.targetPath).size).toBe(binary.length);
  });

  it("queues Debrid-Link cooldown retries when wrapped unrestrict errors carry the cooldown marker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    let fetchCalls = 0;

    globalThis.fetch = async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response("not-found", { status: 404 });
    };

    const settings = {
      ...defaultSettings(),
      debridLinkApiKeys: "dl-key-one\ndl-key-two",
      providerOrder: ["debridlink"] as const,
      providerPrimary: "debridlink" as const,
      providerSecondary: "none" as const,
      providerTertiary: "none" as const,
      outputDir: path.join(root, "downloads"),
      extractDir: path.join(root, "extract"),
      retryLimit: 2,
      autoExtract: false
    };

    const keys = parseDebridLinkApiKeys(settings.debridLinkApiKeys);
    for (const key of keys) {
      primeDebridLinkRuntimeCooldownForTests(key.id, 60_000, `${key.label} im Cooldown`);
    }

    const manager = new DownloadManager(
      settings,
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    manager.addPackages([{ name: "debridlink-cooldown", links: ["https://rapidgator.net/file/example.part1.rar.html"] }]);
    await manager.start();
    await waitFor(() => {
      const item = Object.values(manager.getSnapshot().session.items)[0];
      return Boolean(item && item.status === "queued" && /debrid-link cooldown/i.test(item.fullStatus || ""));
    }, 12000);

    const item = Object.values(manager.getSnapshot().session.items)[0];
    expect(item?.status).toBe("queued");
    expect(item?.fullStatus).toContain("Debrid-Link Cooldown");
    expect(item?.lastError).toContain("im Cooldown");
    expect(item?.retries).toBe(1);
    expect(fetchCalls).toBe(0);

    await manager.stop();
  });

  it("restarts from zero after repeated resume underflow on fresh direct links", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 23);
    const pkgDir = path.join(root, "downloads", "resume-underflow");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "resume-underflow.mkv");
    const partialSize = 96 * 1024;
    fs.writeFileSync(existingTargetPath, binary.subarray(0, partialSize));

    let unrestrictCalls = 0;
    const starts: number[] = [];

    const server = http.createServer((req, res) => {
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;
      starts.push(start);

      if (start > 0) {
        const chunk = binary.subarray(start, Math.min(start + 8192, binary.length));
        res.statusCode = 206;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Range", `bytes ${start}-${start + chunk.length - 1}/${binary.length}`);
        res.setHeader("Content-Length", String(chunk.length));
        res.end(chunk);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/resume-underflow`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "resume-underflow.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "resume-underflow-pkg";
      const itemId = "resume-underflow-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "resume-underflow",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "resume-underflow"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/resume-underflow",
        provider: null,
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: partialSize,
        totalBytes: binary.length,
        progressPercent: Math.floor((partialSize / binary.length) * 100),
        fileName: "resume-underflow.mkv",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 4,
          autoExtract: false,
          autoReconnect: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      if (item?.status !== "completed") {
        throw new Error(JSON.stringify({
          status: item?.status,
          downloadedBytes: item?.downloadedBytes,
          totalBytes: item?.totalBytes,
          retries: item?.retries,
          lastError: item?.lastError,
          fullStatus: item?.fullStatus,
          starts,
          unrestrictCalls
        }));
      }
      expect(item?.status).toBe("completed");
      expect(item?.downloadedBytes).toBe(binary.length);
      expect(unrestrictCalls).toBeGreaterThanOrEqual(2);
      expect(starts).toContain(partialSize);
      expect(starts).toContain(0);
      expect(fs.readFileSync(existingTargetPath).equals(binary)).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("assigns unique target paths for same filenames in parallel", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(64 * 1024, 9);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/same") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.end(binary);
      }, 260);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/same`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "same-release.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 2
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "same-name", links: ["https://dummy/first", "https://dummy/second"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const items = Object.values(manager.getSnapshot().session.items);
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.status === "completed")).toBe(true);
      const targetPaths = items.map((item) => item.targetPath);
      expect(new Set(targetPaths).size).toBe(2);
      for (const targetPath of targetPaths) {
        expect(fs.existsSync(targetPath)).toBe(true);
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("does not mark truncated archive downloads as completed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const advertised = Buffer.alloc(96 * 1024, 5);
    const actual = advertised.subarray(0, advertised.length - 2048);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/short-archive") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(actual.length));
      res.end(actual);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/short-archive`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "broken.part01.rar",
            filesize: advertised.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          retryLimit: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "short-archive", links: ["https://dummy/short-archive"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("failed");
      expect(item?.fullStatus || item?.lastError || "").toMatch(/download_underflow|range_ignored_on_resume/);
      expect(item?.downloadedBytes).toBe(actual.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("continues downloading while package post-processing is pending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(80 * 1024, 7);

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (route !== "/first" && route !== "/second") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const firstUrl = `http://127.0.0.1:${address.port}/first`;
    const secondUrl = `http://127.0.0.1:${address.port}/second`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        const body = init?.body;
        const bodyText = body instanceof URLSearchParams ? body.toString() : String(body || "");
        const originalLink = new URLSearchParams(bodyText).get("link") || "";
        const directUrl = originalLink.includes("second") ? secondUrl : firstUrl;
        const filename = originalLink.includes("second") ? "second.bin" : "first.bin";
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename,
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    let releaseBlockedPostProcess: ((value?: void | PromiseLike<void>) => void) | undefined;
    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      const blocker = new Promise<void>((resolve) => {
        releaseBlockedPostProcess = resolve;
      });
      (manager as unknown as { packagePostProcessQueue: Promise<void> }).packagePostProcessQueue = blocker;

      manager.addPackages([
        { name: "first", links: ["https://dummy/first"] },
        { name: "second", links: ["https://dummy/second"] }
      ]);

      const initial = manager.getSnapshot();
      const firstPackage = initial.session.packageOrder[0];
      const secondPackage = initial.session.packageOrder[1];
      const firstItem = initial.session.packages[firstPackage]?.itemIds[0] || "";
      const secondItem = initial.session.packages[secondPackage]?.itemIds[0] || "";

      manager.start();

      await waitFor(() => manager.getSnapshot().session.items[firstItem]?.status === "completed", 12000);
      await waitFor(() => {
        const state = manager.getSnapshot().session.items[secondItem]?.status;
        return state === "validating" || state === "downloading" || state === "integrity_check" || state === "completed";
      }, 6000);

      if (releaseBlockedPostProcess) {
        releaseBlockedPostProcess();
      }
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const done = manager.getSnapshot();
      expect(done.session.items[firstItem]?.status).toBe("completed");
      expect(done.session.items[secondItem]?.status).toBe("completed");
    } finally {
      if (releaseBlockedPostProcess) {
        releaseBlockedPostProcess();
      }
      server.close();
      await once(server, "close");
    }
  });

  it("recovers from stalled download streams without manual pause/resume", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(300 * 1024, 17);
    const previousStallTimeout = process.env.RD_STALL_TIMEOUT_MS;
    process.env.RD_STALL_TIMEOUT_MS = "2500";
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/stall") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      directCalls += 1;
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;

      if (directCalls === 1 && start === 0) {
        const firstChunk = Math.floor(binary.length / 3);
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.write(binary.subarray(0, firstChunk));
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.end(binary.subarray(firstChunk));
          }
        }, 5000);
        return;
      }

      const chunk = binary.subarray(start);
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/stall`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "stall.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "stall", links: ["https://dummy/stall"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(directCalls).toBeGreaterThan(1);
      expect(fs.existsSync(item.targetPath)).toBe(true);
      expect(fs.statSync(item.targetPath).size).toBe(binary.length);
    } finally {
      if (previousStallTimeout === undefined) {
        delete process.env.RD_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_STALL_TIMEOUT_MS = previousStallTimeout;
      }
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("recovers when direct download connection stalls before first byte", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(220 * 1024, 23);
    const previousStallTimeout = process.env.RD_STALL_TIMEOUT_MS;
    const previousConnectTimeout = process.env.RD_CONNECT_TIMEOUT_MS;
    process.env.RD_STALL_TIMEOUT_MS = "2500";
    process.env.RD_CONNECT_TIMEOUT_MS = "1800";
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/connect-stall") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      directCalls += 1;
      if (directCalls === 1) {
        setTimeout(() => {
          if (res.destroyed || res.writableEnded) {
            return;
          }
          res.statusCode = 200;
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", String(binary.length));
          res.end(binary);
        }, 5200);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/connect-stall`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "connect-stall.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "connect-stall", links: ["https://dummy/connect-stall"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(directCalls).toBeGreaterThan(1);
      expect(fs.existsSync(item.targetPath)).toBe(true);
      expect(fs.statSync(item.targetPath).size).toBe(binary.length);
    } finally {
      if (previousStallTimeout === undefined) {
        delete process.env.RD_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_STALL_TIMEOUT_MS = previousStallTimeout;
      }
      if (previousConnectTimeout === undefined) {
        delete process.env.RD_CONNECT_TIMEOUT_MS;
      } else {
        process.env.RD_CONNECT_TIMEOUT_MS = previousConnectTimeout;
      }
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("recovers when direct download stalls before first response bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(180 * 1024, 12);
    const previousStallTimeout = process.env.RD_STALL_TIMEOUT_MS;
    const previousConnectTimeout = process.env.RD_CONNECT_TIMEOUT_MS;
    process.env.RD_STALL_TIMEOUT_MS = "2500";
    process.env.RD_CONNECT_TIMEOUT_MS = "2000";
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/stall-connect") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      directCalls += 1;
      if (directCalls === 1) {
        setTimeout(() => {
          if (res.writableEnded || res.destroyed || res.headersSent) {
            return;
          }
          res.statusCode = 200;
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", String(binary.length));
          res.end(binary);
        }, 5000);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/stall-connect`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "stall-connect.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "stall-connect", links: ["https://dummy/stall-connect"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(directCalls).toBeGreaterThan(1);
    } finally {
      if (previousStallTimeout === undefined) {
        delete process.env.RD_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_STALL_TIMEOUT_MS = previousStallTimeout;
      }
      if (previousConnectTimeout === undefined) {
        delete process.env.RD_CONNECT_TIMEOUT_MS;
      } else {
        process.env.RD_CONNECT_TIMEOUT_MS = previousConnectTimeout;
      }
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("recovers via global watchdog when stream hangs without reader timeout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(240 * 1024, 31);
    const previousStallTimeout = process.env.RD_STALL_TIMEOUT_MS;
    const previousConnectTimeout = process.env.RD_CONNECT_TIMEOUT_MS;
    const previousGlobalWatchdog = process.env.RD_GLOBAL_STALL_TIMEOUT_MS;
    process.env.RD_STALL_TIMEOUT_MS = "120000";
    process.env.RD_CONNECT_TIMEOUT_MS = "120000";
    process.env.RD_GLOBAL_STALL_TIMEOUT_MS = "2500";
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/watchdog-stall") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      directCalls += 1;
      if (directCalls === 1) {
        const firstChunk = Math.floor(binary.length / 3);
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.write(binary.subarray(0, firstChunk));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/watchdog-stall`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "watchdog-stall.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "watchdog-stall", links: ["https://dummy/watchdog-stall"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(directCalls).toBeGreaterThan(1);
    } finally {
      if (previousStallTimeout === undefined) {
        delete process.env.RD_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_STALL_TIMEOUT_MS = previousStallTimeout;
      }
      if (previousConnectTimeout === undefined) {
        delete process.env.RD_CONNECT_TIMEOUT_MS;
      } else {
        process.env.RD_CONNECT_TIMEOUT_MS = previousConnectTimeout;
      }
      if (previousGlobalWatchdog === undefined) {
        delete process.env.RD_GLOBAL_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_GLOBAL_STALL_TIMEOUT_MS = previousGlobalWatchdog;
      }
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("recovers when write stream backpressure never drains", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(180 * 1024, 19);
    const previousStallTimeout = process.env.RD_STALL_TIMEOUT_MS;
    process.env.RD_STALL_TIMEOUT_MS = "2200";
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/drain-stall") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      directCalls += 1;
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/drain-stall`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "drain-stall.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    const originalCreateWriteStream = fs.createWriteStream;
    let writeStreamCalls = 0;
    const fsMutable = fs as unknown as { createWriteStream: typeof fs.createWriteStream };
    fsMutable.createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
      writeStreamCalls += 1;
      if (writeStreamCalls === 1) {
        class HangingWriteStream extends EventEmitter {
          public closed = false;

          public destroyed = false;

          public write(): boolean {
            return false;
          }

          public end(): void {
            this.closed = true;
            this.emit("close");
          }
        }
        return new HangingWriteStream() as unknown as ReturnType<typeof fs.createWriteStream>;
      }
      return originalCreateWriteStream(...args);
    }) as typeof fs.createWriteStream;

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "drain-stall", links: ["https://dummy/drain-stall"] }]);
      manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 40000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(item?.retries).toBeGreaterThan(0);
      expect(directCalls).toBeGreaterThan(1);
      expect(fs.existsSync(item.targetPath)).toBe(true);
      expect(fs.statSync(item.targetPath).size).toBe(binary.length);
    } finally {
      fsMutable.createWriteStream = originalCreateWriteStream;
      if (previousStallTimeout === undefined) {
        delete process.env.RD_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_STALL_TIMEOUT_MS = previousStallTimeout;
      }
      server.close();
      await once(server, "close");
    }
  }, 45000);

  it("uses content-disposition filename when provider filename is opaque", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(96 * 1024, 13);
    const expectedName = "Banshee.S04E01.German.DL.720p.part01.rar";

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/content-name") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.setHeader("Content-Disposition", `attachment; filename="${expectedName}"`);
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/content-name`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "6f09df2984fe01378537c7cd8d7fa7ce",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 1,
          autoExtract: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "content-name", links: ["https://rapidgator.net/file/6f09df2984fe01378537c7cd8d7fa7ce"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(item?.fileName).toBe(expectedName);
      expect(path.basename(item?.targetPath || "")).toBe(expectedName);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("reuses stored partial target path when queued item resumes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 7);
    const partialSize = 64 * 1024;
    const pkgDir = path.join(root, "downloads", "resume");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "resume.mkv");
    fs.writeFileSync(existingTargetPath, binary.subarray(0, partialSize));
    let sawResumeRange = false;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/resume") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;
      if (start === partialSize) {
        sawResumeRange = true;
      }
      const chunk = binary.subarray(start);

      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/resume`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "resume.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "resume-pkg";
      const itemId = "resume-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "resume",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "resume"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/resume",
        provider: null,
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: partialSize,
        totalBytes: binary.length,
        progressPercent: Math.floor((partialSize / binary.length) * 100),
        fileName: "resume.mkv",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 1,
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("completed");
      expect(item?.targetPath).toBe(existingTargetPath);
      expect(sawResumeRange).toBe(true);
      expect(fs.statSync(existingTargetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("treats HTTP 416 on full range as completed resume", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(128 * 1024, 2);
    const pkgDir = path.join(root, "downloads", "range-complete");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "complete.mkv");
    fs.writeFileSync(existingTargetPath, binary);
    let saw416 = false;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/complete") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;
      if (start >= binary.length) {
        saw416 = true;
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${binary.length}`);
        res.end("");
        return;
      }

      const chunk = binary.subarray(start);
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/complete`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "complete.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "complete-pkg";
      const itemId = "complete-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "range-complete",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "range-complete"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/complete",
        provider: null,
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: binary.length,
        totalBytes: binary.length,
        progressPercent: 100,
        fileName: "complete.mkv",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 1,
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(saw416).toBe(true);
      expect(item?.status).toBe("completed");
      expect(item?.targetPath).toBe(existingTargetPath);
      expect(item?.downloadedBytes).toBe(binary.length);
      expect(fs.statSync(existingTargetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("refreshes Debrid-Link API direct links immediately after HTTP 416 instead of retrying the same link", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 29);
    const pkgDir = path.join(root, "downloads", "debridlink-range-reset");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "debridlink-range-reset.mkv");
    const partialSize = 96 * 1024;
    fs.writeFileSync(existingTargetPath, binary.subarray(0, partialSize));

    let unrestrictCalls = 0;
    let badCalls = 0;
    let goodCalls = 0;

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;

      if (route === "/bad-416") {
        badCalls += 1;
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${partialSize - 1024}`);
        res.end("");
        return;
      }

      if (route === "/good") {
        goodCalls += 1;
        const chunk = binary.subarray(start);
        if (start > 0) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
        } else {
          res.statusCode = 200;
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(chunk.length));
        res.end(chunk);
        return;
      }

      res.statusCode = 404;
      res.end("not-found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const badUrl = `http://127.0.0.1:${address.port}/bad-416`;
    const goodUrl = `http://127.0.0.1:${address.port}/good`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("debrid-link.com/api/v2/downloader/add")) {
        unrestrictCalls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            value: {
              downloadUrl: unrestrictCalls === 1 ? badUrl : goodUrl,
              name: "debridlink-range-reset.mkv",
              size: binary.length
            }
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "debridlink-range-reset-pkg";
      const itemId = "debridlink-range-reset-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "debridlink-range-reset",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "debridlink-range-reset"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/debridlink-range-reset",
        provider: "debridlink",
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: partialSize,
        totalBytes: binary.length,
        progressPercent: Math.floor((partialSize / binary.length) * 100),
        fileName: "debridlink-range-reset.mkv",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          debridLinkApiKeys: "dl-test-key",
          providerOrder: ["debridlink"],
          providerPrimary: "debridlink",
          providerSecondary: "none",
          providerTertiary: "none",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 2,
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("completed");
      expect(item?.provider).toBe("debridlink");
      expect(item?.downloadedBytes).toBe(binary.length);
      expect(unrestrictCalls).toBe(2);
      expect(badCalls).toBe(1);
      expect(goodCalls).toBeGreaterThanOrEqual(1);
      expect(fs.statSync(existingTargetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("recovers from HTTP 416 by restarting download from zero", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(96 * 1024, 3);
    const pkgDir = path.join(root, "downloads", "range-reset");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "reset.mkv");
    const partialSize = 64 * 1024;
    fs.writeFileSync(existingTargetPath, binary.subarray(0, partialSize));

    let saw416 = false;
    let fullRestarted = false;
    let requestCount = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/range-reset") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      requestCount += 1;
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;

      if (requestCount === 1 && start === partialSize) {
        saw416 = true;
        res.statusCode = 416;
        res.setHeader("Content-Range", "bytes */32768");
        res.end("");
        return;
      }

      if (start === 0) {
        fullRestarted = true;
      }
      const chunk = binary.subarray(start);
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/range-reset`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "reset.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "range-reset-pkg";
      const itemId = "range-reset-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "range-reset",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "range-reset"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/range-reset",
        provider: null,
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: partialSize,
        totalBytes: binary.length,
        progressPercent: Math.floor((partialSize / binary.length) * 100),
        fileName: "reset.mkv",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          retryLimit: 1,
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("completed");
      expect(saw416).toBe(true);
      expect(fullRestarted).toBe(true);
      expect(fs.statSync(existingTargetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("counts retries and resets stale 100% progress on persistent HTTP 416", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const staleBinary = Buffer.alloc(64 * 1024, 9);
    const pkgDir = path.join(root, "downloads", "range-416-fail");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "broken.part3.rar");
    fs.writeFileSync(existingTargetPath, staleBinary);
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/range-416-fail") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      directCalls += 1;
      res.statusCode = 416;
      res.setHeader("Content-Range", "bytes */32768");
      res.end("");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/range-416-fail`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "broken.part3.rar",
            filesize: 32768
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const packageId = "range-416-fail-pkg";
      const itemId = "range-416-fail-item";
      const createdAt = Date.now() - 10_000;

      session.packageOrder = [packageId];
      session.packages[packageId] = {
        id: packageId,
        name: "range-416-fail",
        outputDir: pkgDir,
        extractDir: path.join(root, "extract", "range-416-fail"),
        status: "queued",
        itemIds: [itemId],
        cancelled: false,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      };
      session.items[itemId] = {
        id: itemId,
        packageId,
        url: "https://dummy/range-416-fail",
        provider: null,
        status: "queued",
        retries: 0,
        speedBps: 0,
        downloadedBytes: staleBinary.length,
        totalBytes: staleBinary.length,
        progressPercent: 100,
        fileName: "broken.part3.rar",
        targetPath: existingTargetPath,
        resumable: true,
        attempts: 0,
        lastError: "",
        fullStatus: "Wartet",
        createdAt,
        updatedAt: createdAt
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 45000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("failed");
      expect(item?.retries).toBeGreaterThan(0);
      expect(item?.progressPercent).toBe(0);
      expect(item?.downloadedBytes).toBe(0);
      expect(item?.lastError).toContain("416");
      expect(directCalls).toBeGreaterThanOrEqual(3);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 70000);

  it("retries non-retriable HTTP statuses and eventually succeeds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(96 * 1024, 5);
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/status-retry") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      directCalls += 1;
      if (directCalls <= 2) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/status-retry`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "status-retry.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "status-retry", links: ["https://dummy/status-retry"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(directCalls).toBeGreaterThanOrEqual(3);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("normalizes stale running state on startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    session.running = true;
    session.paused = true;
    session.reconnectUntil = Date.now() + 30_000;
    session.reconnectReason = "HTTP 429";
    const packageId = "stale-pkg";
    const itemId = "stale-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "stale",
      outputDir: path.join(root, "downloads", "stale"),
      extractDir: path.join(root, "extract", "stale"),
      status: "reconnect_wait",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/stale",
      provider: "realdebrid",
      status: "paused",
      retries: 0,
      speedBps: 100,
      downloadedBytes: 123,
      totalBytes: 456,
      progressPercent: 26,
      fileName: "stale.mkv",
      targetPath: path.join(root, "downloads", "stale", "stale.mkv"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Pausiert",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const snapshot = manager.getSnapshot();
    expect(snapshot.session.running).toBe(false);
    expect(snapshot.session.paused).toBe(false);
    expect(snapshot.session.reconnectUntil).toBe(0);
    expect(snapshot.session.reconnectReason).toBe("");
    expect(snapshot.session.items[itemId]?.status).toBe("queued");
    expect(snapshot.session.items[itemId]?.speedBps).toBe(0);
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
    expect(snapshot.canStart).toBe(true);
  });

  it("requeues failed HTTP 416 items automatically on startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "retry-416-pkg";
    const itemId = "retry-416-item";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "retry-416");
    const targetPath = path.join(outputDir, "broken.part03.rar");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(targetPath, Buffer.alloc(12 * 1024, 1));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "retry-416",
      outputDir,
      extractDir: path.join(root, "extract", "retry-416"),
      status: "failed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/retry-416",
      provider: "megadebrid",
      status: "failed",
      retries: 4,
      speedBps: 0,
      downloadedBytes: 12 * 1024,
      totalBytes: 8 * 1024,
      progressPercent: 100,
      fileName: "broken.part03.rar",
      targetPath,
      resumable: true,
      attempts: 3,
      lastError: "Error: HTTP 416",
      fullStatus: "Fehler: Error: HTTP 416",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => manager.getSnapshot().session.items[itemId]?.status === "queued", 12000);

    const snapshot = manager.getSnapshot();
    const item = snapshot.session.items[itemId];
    expect(item?.status).toBe("queued");
    expect(item?.attempts).toBe(0);
    expect(item?.downloadedBytes).toBe(0);
    expect(item?.progressPercent).toBe(0);
    expect(item?.fullStatus).toContain("Auto-Retry");
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("requeues completed zero-byte archive items automatically on startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "zero-byte-pkg";
    const itemId = "zero-byte-item";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "zero-byte");
    const targetPath = path.join(outputDir, "archive.part01.rar");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(targetPath, Buffer.alloc(0));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "zero-byte",
      outputDir,
      extractDir: path.join(root, "extract", "zero-byte"),
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/zero-byte",
      provider: "megadebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 100,
      fileName: "archive.part01.rar",
      targetPath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (0 B)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const snapshot = manager.getSnapshot();
    const item = snapshot.session.items[itemId];
    expect(item?.status).toBe("queued");
    expect(item?.downloadedBytes).toBe(0);
    expect(item?.progressPercent).toBe(0);
    expect(item?.fullStatus).toContain("0B-Datei");
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("requeues preallocated completed archive items automatically on startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "prealloc-pkg";
    const itemId = "prealloc-item";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "prealloc");
    const targetPath = path.join(outputDir, "archive.part01.rar");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(targetPath, Buffer.alloc(8192));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "prealloc",
      outputDir,
      extractDir: path.join(root, "extract", "prealloc"),
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/prealloc",
      provider: "megadebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 1024,
      totalBytes: 8192,
      progressPercent: 100,
      fileName: "archive.part01.rar",
      targetPath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (8 KB)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const snapshot = manager.getSnapshot();
    const item = snapshot.session.items[itemId];
    expect(item?.status).toBe("queued");
    expect(item?.fullStatus).toContain("pre-alloc");
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
  });

  it("requeues completed archive parts after auto-recovery extraction failures", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "crc-pkg";
    const createdAt = Date.now() - 10_000;
    const outputDir = path.join(root, "downloads", "crc");
    const extractDir = path.join(root, "extract", "crc");
    fs.mkdirSync(outputDir, { recursive: true });

    const archiveNames = ["show.s01e01.part1.rar", "show.s01e01.part2.rar"];
    const itemIds = archiveNames.map((_, index) => `crc-item-${index}`);

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "crc",
      outputDir,
      extractDir,
      status: "extracting",
      itemIds,
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };

    for (const [index, archiveName] of archiveNames.entries()) {
      const targetPath = path.join(outputDir, archiveName);
      fs.writeFileSync(targetPath, Buffer.from(`part-${index}`));
      session.items[itemIds[index]!] = {
        id: itemIds[index]!,
        packageId,
        url: `https://dummy/${archiveName}`,
        provider: "realdebrid",
        status: "completed",
        retries: 0,
        speedBps: 0,
        downloadedBytes: 4096,
        totalBytes: 4096,
        progressPercent: 100,
        fileName: archiveName,
        targetPath,
        resumable: true,
        attempts: 1,
        lastError: "",
        fullStatus: "Entpacken - Ausstehend",
        createdAt,
        updatedAt: createdAt
      };
    }

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const changed = (manager as any).autoRecoverArchiveCrcFailure(
      session.packages[packageId],
      itemIds.map((itemId) => session.items[itemId]!),
      {
        archiveName: "show.s01e01.part1.rar",
        errorText: "Checksum error in the encrypted file",
        category: "crc_error",
        suggestRedownload: true,
        jvmFailureReason: "Can not open the file as archive"
      },
      "hybrid"
    );

    expect(changed).toBe(2);
    for (const itemId of itemIds) {
      const item = session.items[itemId]!;
      expect(item.status).toBe("queued");
      expect(item.targetPath).toBe("");
      expect(item.downloadedBytes).toBe(0);
      expect(item.attempts).toBe(0);
      expect(item.fullStatus).toContain("Auto-Recovery");
    }
    expect(fs.existsSync(path.join(outputDir, archiveNames[0]!))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, archiveNames[1]!))).toBe(false);
    expect(session.packages[packageId]?.status).toBe("queued");
  });

  it("requeues archive parts on CRC error when file has invalid archive signature (corrupt content)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "crc-corrupt-sig-pkg";
    const createdAt = Date.now() - 10_000;
    const outputDir = path.join(root, "downloads", "crc-corrupt-sig");
    const extractDir = path.join(root, "extract", "crc-corrupt-sig");
    fs.mkdirSync(outputDir, { recursive: true });

    const archiveNames = ["show.s01e01.part1.rar", "show.s01e01.part2.rar"];
    const itemIds = archiveNames.map((_, index) => `crc-corrupt-sig-item-${index}`);
    const archiveSize = 64 * 1024;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "crc-corrupt-sig",
      outputDir,
      extractDir,
      status: "extracting",
      itemIds,
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };

    for (const [index, archiveName] of archiveNames.entries()) {
      const targetPath = path.join(outputDir, archiveName);
      // Write garbage content (no valid archive signature) — simulates corrupt download
      fs.writeFileSync(targetPath, Buffer.alloc(archiveSize, 0xAA));
      session.items[itemIds[index]!] = {
        id: itemIds[index]!,
        packageId,
        url: `https://dummy/${archiveName}`,
        provider: "realdebrid",
        status: "completed",
        retries: 0,
        speedBps: 0,
        downloadedBytes: archiveSize,
        totalBytes: archiveSize,
        progressPercent: 100,
        fileName: archiveName,
        targetPath,
        resumable: true,
        attempts: 1,
        lastError: "",
        fullStatus: "Entpacken - Ausstehend",
        createdAt,
        updatedAt: createdAt
      };
    }

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const changed = (manager as any).autoRecoverArchiveCrcFailure(
      session.packages[packageId],
      itemIds.map((itemId) => session.items[itemId]!),
      {
        archiveName: "show.s01e01.part1.rar",
        errorText: "Checksum error in the encrypted file",
        category: "crc_error",
        suggestRedownload: true,
        jvmFailureReason: "Can not open the file as archive"
      },
      "hybrid"
    );

    // Invalid archive signature = genuine corruption → force re-download
    expect(changed).toBe(2);
    for (const itemId of itemIds) {
      const item = session.items[itemId]!;
      expect(item.status).toBe("queued");
      expect(item.targetPath).toBe("");
      expect(item.downloadedBytes).toBe(0);
      expect(item.fullStatus).toContain("Auto-Recovery");
    }
    expect(fs.existsSync(path.join(outputDir, archiveNames[0]!))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, archiveNames[1]!))).toBe(false);
  });

  it("does not requeue archive parts on CRC error when file has valid RAR signature (wrong password)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "crc-valid-sig-pkg";
    const createdAt = Date.now() - 10_000;
    const outputDir = path.join(root, "downloads", "crc-valid-sig");
    const extractDir = path.join(root, "extract", "crc-valid-sig");
    fs.mkdirSync(outputDir, { recursive: true });

    const archiveNames = ["show.s01e01.part1.rar", "show.s01e01.part2.rar"];
    const itemIds = archiveNames.map((_, index) => `crc-valid-sig-item-${index}`);
    const archiveSize = 64 * 1024;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "crc-valid-sig",
      outputDir,
      extractDir,
      status: "extracting",
      itemIds,
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };

    for (const [index, archiveName] of archiveNames.entries()) {
      const targetPath = path.join(outputDir, archiveName);
      // Write file with valid RAR5 signature — simulates wrong password, not corruption
      const content = Buffer.alloc(archiveSize, 0);
      Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]).copy(content);
      fs.writeFileSync(targetPath, content);
      session.items[itemIds[index]!] = {
        id: itemIds[index]!,
        packageId,
        url: `https://dummy/${archiveName}`,
        provider: "realdebrid",
        status: "completed",
        retries: 0,
        speedBps: 0,
        downloadedBytes: archiveSize,
        totalBytes: archiveSize,
        progressPercent: 100,
        fileName: archiveName,
        targetPath,
        resumable: true,
        attempts: 1,
        lastError: "",
        fullStatus: "Entpacken - Ausstehend",
        createdAt,
        updatedAt: createdAt
      };
    }

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const changed = (manager as any).autoRecoverArchiveCrcFailure(
      session.packages[packageId],
      itemIds.map((itemId) => session.items[itemId]!),
      {
        archiveName: "show.s01e01.part1.rar",
        errorText: "Checksum error in the encrypted file",
        category: "crc_error",
        suggestRedownload: true,
        jvmFailureReason: "Can not open the file as archive"
      },
      "hybrid"
    );

    // Valid RAR signature = file is structurally intact → wrong password, don't re-download
    expect(changed).toBe(0);
    for (const itemId of itemIds) {
      const item = session.items[itemId]!;
      expect(item.status).toBe("completed");
      expect(item.targetPath).toContain(".rar");
      expect(item.downloadedBytes).toBe(archiveSize);
    }
  });

  it("does not treat rev files as ready archive parts during disk fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "disk-fallback-rev-pkg";
    const itemIds = ["disk-fallback-rev-1", "disk-fallback-rev-2"];
    const createdAt = Date.now() - 10_000;
    const outputDir = path.join(root, "downloads", "disk-fallback-rev");
    const extractDir = path.join(root, "extract", "disk-fallback-rev");
    const part1Path = path.join(outputDir, "show.s01e01.part1.rar");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(part1Path, Buffer.alloc(64 * 1024, 1));
    fs.writeFileSync(path.join(outputDir, "show.s01e01.rev"), Buffer.alloc(32 * 1024, 2));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "disk-fallback-rev",
      outputDir,
      extractDir,
      status: "downloading",
      itemIds,
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemIds[0]] = {
      id: itemIds[0],
      packageId,
      url: "https://dummy/show.s01e01.part1.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 64 * 1024,
      totalBytes: 64 * 1024,
      progressPercent: 100,
      fileName: "show.s01e01.part1.rar",
      targetPath: part1Path,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpacken - Ausstehend",
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemIds[1]] = {
      id: itemIds[1],
      packageId,
      url: "https://dummy/show.s01e01.part2.rar",
      provider: "realdebrid",
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: 64 * 1024,
      progressPercent: 0,
      fileName: "show.s01e01.part2.rar",
      targetPath: "",
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const ready = await (manager as any).findReadyArchiveSets(session.packages[packageId]);
    expect(Array.from(ready)).toHaveLength(0);
  });

  it("allows disk fallback when queued archive parts are fully present on disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "disk-fallback-ready-pkg";
    const itemIds = ["disk-fallback-ready-1", "disk-fallback-ready-2"];
    const createdAt = Date.now() - 10_000;
    const outputDir = path.join(root, "downloads", "disk-fallback-ready");
    const extractDir = path.join(root, "extract", "disk-fallback-ready");
    const part1Path = path.join(outputDir, "show.s01e01.part1.rar");
    const part2Path = path.join(outputDir, "show.s01e01.part2.rar");
    const archiveSize = 64 * 1024;
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(part1Path, Buffer.alloc(archiveSize, 1));
    fs.writeFileSync(part2Path, Buffer.alloc(archiveSize, 2));

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "disk-fallback-ready",
      outputDir,
      extractDir,
      status: "downloading",
      itemIds,
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemIds[0]] = {
      id: itemIds[0],
      packageId,
      url: "https://dummy/show.s01e01.part1.rar",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: archiveSize,
      totalBytes: archiveSize,
      progressPercent: 100,
      fileName: "show.s01e01.part1.rar",
      targetPath: part1Path,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpacken - Ausstehend",
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemIds[1]] = {
      id: itemIds[1],
      packageId,
      url: "https://dummy/show.s01e01.part2.rar",
      provider: "realdebrid",
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: archiveSize,
      totalBytes: archiveSize,
      progressPercent: 100,
      fileName: "show.s01e01.part2.rar",
      targetPath: "",
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const ready = await (manager as any).findReadyArchiveSets(session.packages[packageId]);
    expect(Array.from(ready)).toEqual([part1Path.toLowerCase()]);
  });

  it("skips unchanged hybrid archives after a previous extraction failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const {
      session,
      packageId,
      itemId,
      outputDir,
      extractDir
    } = createCompletedArchiveSession(root, "hybrid-failure-skip", "episode.mkv");
    const item = session.items[itemId]!;
    const archiveKey = item.targetPath.toLowerCase();
    item.fullStatus = "Entpacken - Error";
    session.packages[packageId]!.status = "queued";

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        hybridExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const pkg = (manager as any).session.packages[packageId];
    const items = [((manager as any).session.items[itemId])];
    const marker = (manager as any).buildHybridArchiveRetryMarker(pkg, items, archiveKey);
    (manager as any).hybridFailedArchives.set(packageId, new Map([
      [archiveKey, { marker, lastError: "Checksum error in the encrypted file", updatedAt: Date.now() }]
    ]));

    const extracted = await (manager as any).runHybridExtraction(packageId, pkg, items);

    expect(extracted).toBe(0);
    expect(fs.existsSync(path.join(extractDir, "episode.mkv"))).toBe(false);
    expect(((manager as any).session.items[itemId]).fullStatus).toBe("Entpacken - Error");
    expect(((manager as any).session.packages[packageId]).status).not.toBe("extracting");
    expect(fs.existsSync(path.join(outputDir, "episode.zip"))).toBe(true);
  });

  it("does not auto-reschedule extraction for completed items already marked as extract error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const {
      session,
      packageId,
      itemId
    } = createCompletedArchiveSession(root, "hybrid-error-hold", "episode.mkv");
    session.items[itemId]!.fullStatus = "Entpacken - Error";
    session.packages[packageId]!.status = "queued";

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        hybridExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    (manager as any).triggerPendingExtractions();

    expect((manager as any).packagePostProcessTasks.has(packageId)).toBe(false);
    expect((manager as any).session.items[itemId].fullStatus).toBe("Entpacken - Error");
  });

  it("does not auto-reschedule extraction for completed items already marked as entpack-fehler", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const {
      session,
      packageId,
      itemId
    } = createCompletedArchiveSession(root, "hybrid-entpack-fehler-hold", "episode.mkv");
    session.items[itemId]!.fullStatus = "Entpack-Fehler: Checksum error in encrypted file";
    session.packages[packageId]!.status = "queued";

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        hybridExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    (manager as any).triggerPendingExtractions();

    expect((manager as any).packagePostProcessTasks.has(packageId)).toBe(false);
    expect((manager as any).session.items[itemId].fullStatus).toBe("Entpack-Fehler: Checksum error in encrypted file");
  });

  it("applies final extract errors only to the affected full-extract archive items", () => {
    const createdAt = Date.now() - 10_000;
    const completedItems = [
      {
        id: "full-fail-item-1",
        status: "completed",
        fileName: "show.s01e01.part1.rar",
        downloadedBytes: 100 * 1024 * 1024,
        fullStatus: "Fertig (100 MB)",
        updatedAt: createdAt
      },
      {
        id: "full-fail-item-2",
        status: "completed",
        fileName: "show.s01e01.part2.rar",
        downloadedBytes: 100 * 1024 * 1024,
        fullStatus: "Fertig (100 MB)",
        updatedAt: createdAt
      },
      {
        id: "full-fail-item-3",
        status: "completed",
        fileName: "show.s01e02.part1.rar",
        downloadedBytes: 200 * 1024 * 1024,
        fullStatus: "Fertig (200 MB)",
        updatedAt: createdAt
      },
      {
        id: "full-fail-item-4",
        status: "completed",
        fileName: "show.s01e02.part2.rar",
        downloadedBytes: 200 * 1024 * 1024,
        fullStatus: "Fertig (200 MB)",
        updatedAt: createdAt
      }
    ] as any[];
    const previousStatuses = new Map<string, string>(completedItems.map((item: any) => [item.id, item.fullStatus]));

    for (const item of completedItems) {
      item.fullStatus = "Entpacken - Ausstehend";
    }
    completedItems[0].fullStatus = "Entpacken - Error";
    completedItems[1].fullStatus = "Entpacken - Error";
    const resolveArchiveItems = (archiveName: string) => {
      const base = archiveName.replace(/\.part0*1\.rar$/i, "");
      return completedItems.filter((item: any) => String(item.fileName || "").toLowerCase().startsWith(`${base}.part`));
    };

    (DownloadManager.prototype as any).applyPackageExtractFailureStatuses.call(
      {},
      completedItems,
      resolveArchiveItems,
      new Map([["show.s01e01.part1.rar", "Checksum error in the encrypted file"]]),
      "Checksum error in the encrypted file",
      previousStatuses,
      createdAt + 5_000
    );

    expect(completedItems[0].fullStatus).toBe("Entpack-Fehler: Checksum error in the encrypted file");
    expect(completedItems[1].fullStatus).toBe("Entpack-Fehler: Checksum error in the encrypted file");
    expect(completedItems[2].fullStatus).toBe("Fertig (200 MB)");
    expect(completedItems[3].fullStatus).toBe("Fertig (200 MB)");
  });

  it("clears stale pending extraction labels for untouched items when another archive fails", () => {
    const createdAt = Date.now() - 10_000;
    const completedItems = [
      {
        id: "stale-fail-item-1",
        status: "completed",
        fileName: "show.s01e01.part1.rar",
        downloadedBytes: 100 * 1024 * 1024,
        fullStatus: "Fertig (100 MB)",
        updatedAt: createdAt
      },
      {
        id: "stale-fail-item-2",
        status: "completed",
        fileName: "show.s01e01.part2.rar",
        downloadedBytes: 100 * 1024 * 1024,
        fullStatus: "Fertig (100 MB)",
        updatedAt: createdAt
      },
      {
        id: "stale-fail-item-3",
        status: "completed",
        fileName: "show.s01e05.part2.rar",
        downloadedBytes: 180 * 1024 * 1024,
        fullStatus: "Entpacken - Ausstehend",
        updatedAt: createdAt
      }
    ] as any[];
    const previousStatuses = new Map<string, string>(completedItems.map((item: any) => [item.id, item.fullStatus]));

    completedItems[0].fullStatus = "Entpacken - Error";
    completedItems[1].fullStatus = "Entpacken - Error";

    (DownloadManager.prototype as any).applyPackageExtractFailureStatuses.call(
      {},
      completedItems,
      (archiveName: string) => resolveArchiveItemsFromList(archiveName, completedItems),
      new Map([["show.s01e01.part1.rar", "Checksum error in the encrypted file"]]),
      "Checksum error in the encrypted file",
      previousStatuses,
      createdAt + 5_000
    );

    expect(completedItems[0].fullStatus).toBe("Entpack-Fehler: Checksum error in the encrypted file");
    expect(completedItems[1].fullStatus).toBe("Entpack-Fehler: Checksum error in the encrypted file");
    expect(completedItems[2].fullStatus).toBe("Fertig (180 MB)");
  });

  it("detects start conflicts when extract output already exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageId = "conflict-pkg";
    const itemId = "conflict-item";
    const now = Date.now() - 5000;
    const outputDir = path.join(root, "downloads", "conflict");
    const extractDir = path.join(root, "extract", "conflict");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, "existing.mkv"), "x", "utf8");

    const session = emptySession();
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "conflict",
      outputDir,
      extractDir,
      status: "queued",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/conflict",
      provider: null,
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: "conflict.part01.rar",
      targetPath: path.join(outputDir, "conflict.part01.rar"),
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt: now,
      updatedAt: now
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const conflicts = await manager.getStartConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.packageId).toBe(packageId);
  });

  it("resolves start conflict by skipping package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageId = "skip-pkg";
    const itemId = "skip-item";
    const now = Date.now() - 5000;
    const outputDir = path.join(root, "downloads", "skip");
    const extractDir = path.join(root, "extract", "skip");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, "existing.mkv"), "x", "utf8");

    const session = emptySession();
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "skip",
      outputDir,
      extractDir,
      status: "queued",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/skip",
      provider: null,
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: "skip.part01.rar",
      targetPath: path.join(outputDir, "skip.part01.rar"),
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt: now,
      updatedAt: now
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const result = await manager.resolveStartConflict(packageId, "skip");
    expect(result.skipped).toBe(true);
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]).toBeDefined();
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
    expect(snapshot.session.items[itemId]).toBeDefined();
    expect(snapshot.session.items[itemId]?.status).toBe("queued");
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Wartet");
  });

  it("keeps already completed items when skipping start conflict", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageId = "skip-partial-pkg";
    const completedItemId = "skip-partial-completed";
    const pendingItemId = "skip-partial-pending";
    const now = Date.now() - 5000;
    const outputDir = path.join(root, "downloads", "skip-partial");
    const extractDir = path.join(root, "extract", "skip-partial");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, "existing.mkv"), "x", "utf8");
    const completedTarget = path.join(outputDir, "skip-partial.part01.rar");
    fs.writeFileSync(completedTarget, "part", "utf8");

    const session = emptySession();
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "skip-partial",
      outputDir,
      extractDir,
      status: "queued",
      itemIds: [completedItemId, pendingItemId],
      cancelled: false,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    session.items[completedItemId] = {
      id: completedItemId,
      packageId,
      url: "https://dummy/skip-partial/completed",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: "skip-partial.part01.rar",
      targetPath: completedTarget,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt",
      createdAt: now,
      updatedAt: now
    };
    session.items[pendingItemId] = {
      id: pendingItemId,
      packageId,
      url: "https://dummy/skip-partial/pending",
      provider: null,
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: "skip-partial.part02.rar",
      targetPath: path.join(outputDir, "skip-partial.part02.rar"),
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt: now,
      updatedAt: now
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const result = await manager.resolveStartConflict(packageId, "skip");
    expect(result.skipped).toBe(true);
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]).toBeDefined();
    expect(snapshot.session.items[completedItemId]?.status).toBe("completed");
    expect(snapshot.session.items[completedItemId]?.fullStatus).toBe("Entpackt");
    expect(snapshot.session.items[pendingItemId]?.status).toBe("queued");
    expect(snapshot.session.items[pendingItemId]?.fullStatus).toBe("Wartet");
  });

  it("resolves start conflict by overwriting and resetting queued package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageId = "overwrite-pkg";
    const itemId = "overwrite-item";
    const now = Date.now() - 5000;
    const outputDir = path.join(root, "downloads", "overwrite");
    const extractDir = path.join(root, "extract", "overwrite");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "overwrite.part01.rar"), "part", "utf8");
    fs.writeFileSync(path.join(extractDir, "existing.mkv"), "x", "utf8");

    const session = emptySession();
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "overwrite",
      outputDir,
      extractDir,
      status: "queued",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/overwrite",
      provider: null,
      status: "queued",
      retries: 1,
      speedBps: 0,
      downloadedBytes: 42,
      totalBytes: 100,
      progressPercent: 42,
      fileName: "overwrite.part01.rar",
      targetPath: path.join(outputDir, "overwrite.part01.rar"),
      resumable: true,
      attempts: 3,
      lastError: "x",
      fullStatus: "Wartet",
      createdAt: now,
      updatedAt: now
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const result = await manager.resolveStartConflict(packageId, "overwrite");
    expect(result.overwritten).toBe(true);
    const snapshot = manager.getSnapshot();
    const item = snapshot.session.items[itemId];
    expect(item?.status).toBe("queued");
    expect(item?.downloadedBytes).toBe(0);
    expect(item?.progressPercent).toBe(0);
    expect(item?.attempts).toBe(0);
    expect(item?.lastError).toBe("");
    expect(item?.fullStatus).toBe("Wartet");
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(fs.existsSync(extractDir)).toBe(false);
  });

  it("requeues legacy 'Gestoppt' items on startup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "stopped-pkg";
    const itemId = "stopped-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "stopped",
      outputDir: path.join(root, "downloads", "stopped"),
      extractDir: path.join(root, "extract", "stopped"),
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/stopped",
      provider: "megadebrid",
      status: "cancelled",
      retries: 1,
      speedBps: 0,
      downloadedBytes: 512,
      totalBytes: 2048,
      progressPercent: 25,
      fileName: "resume.part01.rar",
      targetPath: path.join(root, "downloads", "stopped", "resume.part01.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Gestoppt",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const snapshot = manager.getSnapshot();
    expect(snapshot.session.items[itemId]?.status).toBe("queued");
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Wartet");
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
  });

  it("cleans leftover split archives on startup for already extracted packages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageDir = path.join(root, "downloads", "legacy");
    fs.mkdirSync(packageDir, { recursive: true });
    const part1 = path.join(packageDir, "legacy.release.part01.rar");
    const part2 = path.join(packageDir, "legacy.release.part02.rar");
    const part3 = path.join(packageDir, "legacy.release.part03.rar");
    const keep = path.join(packageDir, "keep.txt");
    fs.writeFileSync(part2, "part2", "utf8");
    fs.writeFileSync(part3, "part3", "utf8");
    fs.writeFileSync(keep, "keep", "utf8");

    const session = emptySession();
    const packageId = "legacy-pkg";
    const itemId = "legacy-item";
    const createdAt = Date.now() - 20_000;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "legacy",
      outputDir: packageDir,
      extractDir: path.join(root, "extract", "legacy"),
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/legacy",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: path.basename(part1),
      targetPath: part1,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt",
      createdAt,
      updatedAt: createdAt
    };

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => !fs.existsSync(part2) && !fs.existsSync(part3), 5000);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("cleans legacy leftovers when package is extracted but marker is old", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageDir = path.join(root, "downloads", "legacy-old");
    const extractDir = path.join(root, "extract", "legacy-old");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const part1 = path.join(packageDir, "legacy.old.part01.rar");
    const part2 = path.join(packageDir, "legacy.old.part02.rar");
    const part3 = path.join(packageDir, "legacy.old.part03.rar");
    const keep = path.join(packageDir, "keep.nfo");
    fs.writeFileSync(part1, "part1", "utf8");
    fs.writeFileSync(part2, "part2", "utf8");
    fs.writeFileSync(part3, "part3", "utf8");
    fs.writeFileSync(keep, "keep", "utf8");
    fs.writeFileSync(path.join(extractDir, "episode.mkv"), "video", "utf8");

    const session = emptySession();
    const packageId = "legacy-old-pkg";
    const itemId = "legacy-old-item";
    const createdAt = Date.now() - 20_000;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "legacy-old",
      outputDir: packageDir,
      extractDir,
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/legacy-old",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: path.basename(part1),
      targetPath: part1,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (123 MB)",
      createdAt,
      updatedAt: createdAt
    };

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => !fs.existsSync(part1) && !fs.existsSync(part2) && !fs.existsSync(part3), 5000);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "episode.mkv"))).toBe(true);
  });

  it("removes empty download package directory after startup cleanup backfill", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageDir = path.join(root, "downloads", "legacy-empty");
    fs.mkdirSync(packageDir, { recursive: true });
    const part1 = path.join(packageDir, "legacy.empty.part01.rar");
    const part2 = path.join(packageDir, "legacy.empty.part02.rar");
    fs.writeFileSync(part1, "part1", "utf8");
    fs.writeFileSync(part2, "part2", "utf8");

    const session = emptySession();
    const packageId = "legacy-empty-pkg";
    const itemId = "legacy-empty-item";
    const createdAt = Date.now() - 20_000;

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "legacy-empty",
      outputDir: packageDir,
      extractDir: path.join(root, "extract", "legacy-empty"),
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/legacy-empty",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: path.basename(part1),
      targetPath: part1,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt",
      createdAt,
      updatedAt: createdAt
    };

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => !fs.existsSync(packageDir), 5000);
  });

  it("does not over-clean packages that share one extract directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const sharedExtractDir = path.join(root, "extract", "shared");
    fs.mkdirSync(sharedExtractDir, { recursive: true });
    fs.writeFileSync(path.join(sharedExtractDir, "already-extracted.mkv"), "ok", "utf8");

    const pkg1Dir = path.join(root, "downloads", "pkg1");
    const pkg2Dir = path.join(root, "downloads", "pkg2");
    fs.mkdirSync(pkg1Dir, { recursive: true });
    fs.mkdirSync(pkg2Dir, { recursive: true });

    const pkg1Part1 = path.join(pkg1Dir, "show.one.part01.rar");
    const pkg1Part2 = path.join(pkg1Dir, "show.one.part02.rar");
    const pkg2Part1 = path.join(pkg2Dir, "show.two.part01.rar");
    const pkg2Part2 = path.join(pkg2Dir, "show.two.part02.rar");
    fs.writeFileSync(pkg1Part1, "a1", "utf8");
    fs.writeFileSync(pkg1Part2, "a2", "utf8");
    fs.writeFileSync(pkg2Part1, "b1", "utf8");
    fs.writeFileSync(pkg2Part2, "b2", "utf8");

    const session = emptySession();
    const createdAt = Date.now() - 30_000;

    session.packageOrder = ["pkg1", "pkg2"];
    session.packages.pkg1 = {
      id: "pkg1",
      name: "pkg1",
      outputDir: pkg1Dir,
      extractDir: sharedExtractDir,
      status: "completed",
      itemIds: ["pkg1-item"],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.packages.pkg2 = {
      id: "pkg2",
      name: "pkg2",
      outputDir: pkg2Dir,
      extractDir: sharedExtractDir,
      status: "completed",
      itemIds: ["pkg2-item"],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };

    session.items["pkg1-item"] = {
      id: "pkg1-item",
      packageId: "pkg1",
      url: "https://dummy/pkg1",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 1,
      totalBytes: 1,
      progressPercent: 100,
      fileName: path.basename(pkg1Part1),
      targetPath: pkg1Part1,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt",
      createdAt,
      updatedAt: createdAt
    };
    session.items["pkg2-item"] = {
      id: "pkg2-item",
      packageId: "pkg2",
      url: "https://dummy/pkg2",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 1,
      totalBytes: 1,
      progressPercent: 100,
      fileName: path.basename(pkg2Part1),
      targetPath: pkg2Part1,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (100 MB)",
      createdAt,
      updatedAt: createdAt
    };

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => !fs.existsSync(pkg1Part1) && !fs.existsSync(pkg1Part2), 5000);
    expect(fs.existsSync(pkg2Part1)).toBe(true);
    expect(fs.existsSync(pkg2Part2)).toBe(true);
  });

  it("resets run counters and reconnect state on start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    session.runStartedAt = Date.now() - 3600 * 1000;
    session.totalDownloadedBytes = 9_999_999;
    session.reconnectUntil = Date.now() + 120000;
    session.reconnectReason = "HTTP 503";

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await manager.start();
    await waitFor(() => !manager.getSnapshot().session.running, 5000);

    const snapshot = manager.getSnapshot();
    const summary = manager.getSummary();
    expect(snapshot.session.totalDownloadedBytes).toBe(0);
    expect(snapshot.session.reconnectUntil).toBe(0);
    expect(snapshot.session.reconnectReason).toBe("");
    expect(summary).toBeNull();
  });

  it("shows zero total when queue is empty despite stale persisted bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    session.totalDownloadedBytes = 19.99 * 1024 * 1024 * 1024;
    session.runStartedAt = Date.now() - 5 * 60 * 1000;

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const snapshot = manager.getSnapshot();
    expect(snapshot.stats.totalPackages).toBe(0);
    expect(snapshot.stats.totalFiles).toBe(0);
    expect(snapshot.stats.totalDownloaded).toBe(0);
    expect(snapshot.session.totalDownloadedBytes).toBe(0);
    expect(snapshot.session.runStartedAt).toBe(0);
  });

  it("clearAll resets total bytes and stats", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "pkg-clear";
    const itemId = "item-clear";
    const now = Date.now() - 1000;
    const outputDir = path.join(root, "downloads", "pkg-clear");
    const extractDir = path.join(root, "extract", "pkg-clear");
    const targetPath = path.join(outputDir, "episode.mkv");

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "pkg-clear",
      outputDir,
      extractDir,
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/item-clear",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 1024,
      totalBytes: 1024,
      progressPercent: 100,
      fileName: "episode.mkv",
      targetPath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (1 KB)",
      createdAt: now,
      updatedAt: now
    };
    session.totalDownloadedBytes = 1024;
    session.runStartedAt = now;

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    manager.clearAll();
    const snapshot = manager.getSnapshot();
    expect(snapshot.stats.totalPackages).toBe(0);
    expect(snapshot.stats.totalFiles).toBe(0);
    expect(snapshot.stats.totalDownloaded).toBe(0);
    expect(snapshot.session.totalDownloadedBytes).toBe(0);
    expect(snapshot.session.runStartedAt).toBe(0);
  });

  it("keeps cumulative session totals when completed items are removed from the queue", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "pkg-complete-remove";
    const itemId = "item-complete-remove";
    const now = Date.now() - 1000;
    const outputDir = path.join(root, "downloads", "pkg-complete-remove");
    const extractDir = path.join(root, "extract", "pkg-complete-remove");
    const targetPath = path.join(outputDir, "episode.mkv");

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "pkg-complete-remove",
      outputDir,
      extractDir,
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/item-complete-remove",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 3 * 1024,
      totalBytes: 3 * 1024,
      progressPercent: 100,
      fileName: "episode.mkv",
      targetPath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (3 KB)",
      createdAt: now,
      updatedAt: now
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const internal = manager as unknown as {
      session: { totalDownloadedBytes: number };
      sessionDownloadedBytes: number;
      sessionCompletedFiles: number;
      itemContributedBytes: Map<string, number>;
      removePackageFromSession: (packageId: string, itemIds: string[], reason?: "completed" | "deleted") => void;
    };

    internal.session.totalDownloadedBytes = 16 * 1024 * 1024 * 1024;
    internal.sessionDownloadedBytes = 16 * 1024 * 1024 * 1024;
    internal.sessionCompletedFiles = 1;
    internal.itemContributedBytes.set(itemId, 3 * 1024 * 1024 * 1024);

    internal.removePackageFromSession(packageId, [itemId], "completed");

    const snapshot = manager.getSnapshot();
    expect(snapshot.stats.totalPackages).toBe(0);
    expect(snapshot.stats.totalDownloaded).toBe(16 * 1024 * 1024 * 1024);
    expect(snapshot.stats.totalFilesSession).toBe(1);
    expect(snapshot.session.totalDownloadedBytes).toBe(16 * 1024 * 1024 * 1024);
  });

  it("does not start a run when queue is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    manager.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const snapshot = manager.getSnapshot();
    expect(snapshot.session.running).toBe(false);
    expect(manager.getSummary()).toBeNull();
  });

  it("calculates ETA from current run items only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(128 * 1024, 4);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/slow-eta") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      const half = Math.floor(binary.length / 2);
      res.write(binary.subarray(0, half));
      setTimeout(() => {
        res.end(binary.subarray(half));
      }, 700);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/slow-eta`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "new-episode.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const session = emptySession();
      const oldPkgId = "old-pkg";
      const oldItemId = "old-item";
      const oldNow = Date.now() - 5000;
      session.packageOrder = [oldPkgId];
      session.packages[oldPkgId] = {
        id: oldPkgId,
        name: "old",
        outputDir: path.join(root, "downloads", "old"),
        extractDir: path.join(root, "extract", "old"),
        status: "completed",
        itemIds: [oldItemId],
        cancelled: false,
        enabled: true,
        createdAt: oldNow,
        updatedAt: oldNow
      };
      session.items[oldItemId] = {
        id: oldItemId,
        packageId: oldPkgId,
        url: "https://dummy/old",
        provider: "realdebrid",
        status: "completed",
        retries: 0,
        speedBps: 0,
        downloadedBytes: 100,
        totalBytes: 100,
        progressPercent: 100,
        fileName: "old.bin",
        targetPath: path.join(root, "downloads", "old", "old.bin"),
        resumable: true,
        attempts: 1,
        lastError: "",
        fullStatus: "done",
        createdAt: oldNow,
        updatedAt: oldNow
      };

      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "new", links: ["https://dummy/new"] }]);
      await manager.start();
      await new Promise((resolve) => setTimeout(resolve, 120));

      const runningSnapshot = manager.getSnapshot();
      expect(runningSnapshot.session.running).toBe(true);
      expect(runningSnapshot.etaText).toBe("ETA: --");

      await waitFor(() => !manager.getSnapshot().session.running, 25000);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("performs one fresh retry after fetch failed during unrestrict", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(96 * 1024, 12);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/fresh-retry") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/fresh-retry`;
    let unrestrictCalls = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        unrestrictCalls += 1;
        if (unrestrictCalls <= 3) {
          throw new TypeError("fetch failed");
        }
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "fresh-retry.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "fresh-retry", links: ["https://dummy/fresh"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(unrestrictCalls).toBeGreaterThan(3);
      expect(item?.status).toBe("completed");
      expect(item?.lastError || "").toBe("");
      expect(fs.existsSync(item.targetPath)).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("retries suspicious mini files under 100 KB until the full file arrives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(2 * 1024 * 1024, 21);
    let directCalls = 0;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/mini-retry") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      directCalls += 1;
      if (directCalls === 1) {
        const tiny = Buffer.from("<html><body>temporary error</body></html>", "utf8");
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(tiny.length));
        res.end(tiny);
        return;
      }

      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/mini-retry`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "mini-retry.part01.rar",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "mini-retry", links: ["https://dummy/mini-retry"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(directCalls).toBeGreaterThan(1);
      expect(fs.existsSync(item.targetPath)).toBe(true);
      expect(fs.statSync(item.targetPath).size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("limits AllDebrid rapidgator starts to one active task by default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(2 * 1024 * 1024, 6);
    let unlockInFlight = 0;
    let maxUnlockInFlight = 0;

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (route !== "/rg-1" && route !== "/rg-2") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.end(binary);
      }, 1500);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const link1 = "https://rapidgator.net/file/12345678901234567890123456789012/file1.mkv.html";
    const link2 = "https://rapidgator.net/file/abcdefabcdefabcdefabcdefabcdef12/file2.mkv.html";
    const directUrl1 = `http://127.0.0.1:${address.port}/rg-1`;
    const directUrl2 = `http://127.0.0.1:${address.port}/rg-2`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(
        init?.method
          || (typeof input === "string" || input instanceof URL ? "" : input.method || "")
      ).toUpperCase();

      if (url.includes("/user/hosts")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: {
              hosts: {
                rapidgator: {
                  name: "Rapidgator",
                  status: true,
                  quota: 50,
                  quotaMax: 100,
                  quotaType: "traffic",
                  limitSimuDl: 1
                }
              }
            }
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (url.includes("/link/unlock")) {
        unlockInFlight += 1;
        maxUnlockInFlight = Math.max(maxUnlockInFlight, unlockInFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const body = init?.body;
          const bodyText = body instanceof URLSearchParams ? body.toString() : String(body || "");
          const originalLink = new URLSearchParams(bodyText).get("link") || "";
          const directUrl = originalLink === link2 ? directUrl2 : directUrl1;
          const fileName = originalLink === link2 ? "rg-2.mkv" : "rg-1.mkv";
          return new Response(
            JSON.stringify({
              status: "success",
              data: {
                link: directUrl,
                filename: fileName,
                filesize: binary.length
              }
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }
          );
        } finally {
          unlockInFlight = Math.max(0, unlockInFlight - 1);
        }
      }

      if (url.startsWith("https://rapidgator.net/")) {
        if (method === "HEAD") {
          return new Response(null, { status: 200 });
        }
        return new Response("<html><title>Rapidgator</title></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }

      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          allDebridToken: "ad-token",
          providerOrder: [],
          providerPrimary: "alldebrid",
          providerSecondary: "none",
          providerTertiary: "none",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          enableIntegrityCheck: false,
          maxParallel: 2
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "rg-all-debrid", links: [link1, link2] }]);
      await manager.start();
      await waitFor(() => {
        const items = Object.values(manager.getSnapshot().session.items);
        return items.some((item) => item.status === "downloading") && maxUnlockInFlight >= 1;
      }, 15000);
      await new Promise((resolve) => setTimeout(resolve, 3600));

      const items = Object.values(manager.getSnapshot().session.items);
      expect(items).toHaveLength(2);
      expect(items.filter((item) => item.status === "downloading" || item.status === "completed")).toHaveLength(1);
      expect(items.filter((item) => item.status === "queued" || item.status === "validating" || item.status === "reconnect_wait")).toHaveLength(1);
      expect(maxUnlockInFlight).toBe(1);
      manager.stop();
      await waitFor(() => !manager.getSnapshot().session.running, 15000);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("allows concurrent AllDebrid Web Rapidgator starts up to configured parallelism", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const chunk = Buffer.alloc(256 * 1024, 9);

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (route !== "/ad-web-1" && route !== "/ad-web-2" && route !== "/ad-web-3") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      let sent = 0;
      const totalChunks = 10;
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length * totalChunks));
      const timer = setInterval(() => {
        if (sent >= totalChunks) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
        sent += 1;
      }, 700);
      res.on("close", () => clearInterval(timer));
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const link1 = "https://rapidgator.net/file/web-1/sample.part1.rar.html";
    const link2 = "https://rapidgator.net/file/web-2/sample.part2.rar.html";
    const link3 = "https://rapidgator.net/file/web-3/sample.part3.rar.html";
    const directUrl1 = `http://127.0.0.1:${address.port}/ad-web-1`;
    const directUrl2 = `http://127.0.0.1:${address.port}/ad-web-2`;
    const directUrl3 = `http://127.0.0.1:${address.port}/ad-web-3`;

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          allDebridToken: "ad-token",
          allDebridUseWebLogin: true,
          providerOrder: [],
          providerPrimary: "alldebrid",
          providerSecondary: "none",
          providerTertiary: "none",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          enableIntegrityCheck: false,
          maxParallel: 3
        },
        emptySession(),
        createStoragePaths(path.join(root, "state")),
        {
          allDebridWebUnrestrict: async (link) => ({
            fileName: link === link2 ? "ad-web-2.bin" : link === link3 ? "ad-web-3.bin" : "ad-web-1.bin",
            directUrl: link === link2 ? directUrl2 : link === link3 ? directUrl3 : directUrl1,
            fileSize: chunk.length * 10,
            retriesUsed: 0
          })
        }
      );

      manager.addPackages([{ name: "ad-web-parallel", links: [link1, link2, link3] }]);
      await manager.start();

      await waitFor(() => {
        const items = Object.values(manager.getSnapshot().session.items);
        return items.filter((item) => item.status === "downloading").length >= 2;
      }, 10000);

      const items = Object.values(manager.getSnapshot().session.items);
      expect(items.filter((item) => item.status === "downloading").length).toBeGreaterThanOrEqual(2);

      manager.stop();
      await waitFor(() => !manager.getSnapshot().session.running, 15000);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 20000);

  it("limits Mega-Debrid Web validating starts to one item at a time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    let unrestrictCalls = 0;
    const pendingRejectors = new Set<(error: Error) => void>();

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        megaLogin: "mega-user",
        megaPassword: "mega-pass",
        megaDebridWebEnabled: true,
        megaDebridApiEnabled: false,
        megaDebridPreferApi: false,
        providerOrder: [],
        providerPrimary: "megadebrid",
        providerSecondary: "none",
        providerTertiary: "none",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false,
        autoReconnect: false,
        enableIntegrityCheck: false,
        maxParallel: 3
      },
      emptySession(),
      createStoragePaths(path.join(root, "state")),
      {
        megaWebUnrestrict: vi.fn(async (_link: string, signal?: AbortSignal) => {
          unrestrictCalls += 1;
          return await new Promise((resolve, reject) => {
            const rejector = (error: Error): void => {
              signal?.removeEventListener("abort", onAbort);
              pendingRejectors.delete(rejector);
              reject(error);
            };
            const onAbort = (): void => {
              rejector(new Error("aborted:test-mega-web"));
            };
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            pendingRejectors.add(rejector);
          });
        })
      }
    );

    manager.addPackages([{
      name: "mega-web-serialized",
      links: [
        "https://rapidgator.net/file/mega-web-1.part1.rar.html",
        "https://rapidgator.net/file/mega-web-2.part2.rar.html",
        "https://rapidgator.net/file/mega-web-3.part3.rar.html"
      ]
    }]);

    await manager.start();
    await waitFor(() => unrestrictCalls === 1, 10000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const items = Object.values(manager.getSnapshot().session.items);
    expect(items.filter((item) => item.status === "validating")).toHaveLength(1);
    expect(items.filter((item) => item.status === "queued")).toHaveLength(2);
    expect(unrestrictCalls).toBe(1);

    manager.stop();
    for (const reject of Array.from(pendingRejectors)) {
      reject(new Error("aborted:test-mega-web"));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("shows the same AllDebrid countdown for all immediately free slots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const chunk = Buffer.alloc(256 * 1024, 9);
    const totalLinks = 8;

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (!/^\/ad-web-\d+$/.test(route)) {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      let sent = 0;
      const totalChunks = 10;
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length * totalChunks));
      const timer = setInterval(() => {
        if (sent >= totalChunks) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
        sent += 1;
      }, 700);
      res.on("close", () => clearInterval(timer));
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const links = Array.from({ length: totalLinks }, (_, index) => `https://rapidgator.net/file/web-${index + 1}/sample.part${index + 1}.rar.html`);

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          allDebridToken: "ad-token",
          allDebridUseWebLogin: true,
          providerOrder: [],
          providerPrimary: "alldebrid",
          providerSecondary: "none",
          providerTertiary: "none",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          enableIntegrityCheck: false,
          maxParallel: 5
        },
        emptySession(),
        createStoragePaths(path.join(root, "state")),
        {
          allDebridWebUnrestrict: async (link) => {
            const match = link.match(/web-(\d+)/);
            const slot = Number(match?.[1] || 1);
            return {
              fileName: `ad-web-${slot}.bin`,
              directUrl: `http://127.0.0.1:${address.port}/ad-web-${slot}`,
              fileSize: chunk.length * 10,
              retriesUsed: 0
            };
          }
        }
      );

      manager.addPackages([{ name: "ad-web-visibility", links }]);
      await manager.start();

      await waitFor(() => {
        const items = Object.values(manager.getSnapshot().session.items);
        const countdownItems = items.filter((item) => /^AllDebrid Start in \d+s$/.test(item.fullStatus || ""));
        return countdownItems.length === 5;
      }, 10000);

      const items = Object.values(manager.getSnapshot().session.items);
      const activeCount = items.filter((item) => item.status === "downloading" || item.status === "validating").length;
      const countdownItems = items.filter((item) => /^AllDebrid Start in \d+s$/.test(item.fullStatus || ""));
      const uniqueCountdowns = new Set(countdownItems.map((item) => item.fullStatus || ""));

      expect(activeCount).toBe(0);
      expect(countdownItems.length).toBe(5);
      expect(uniqueCountdowns.size).toBe(1);

      manager.stop();
      await waitFor(() => !manager.getSnapshot().session.running, 15000);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 20000);

  it("starts immediately free AllDebrid slots after the same 3 second delay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(512 * 1024, 5);

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (route !== "/ad-1" && route !== "/ad-2" && route !== "/ad-3") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(binary.length));
        res.end(binary);
      }, 6500);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const link1 = "https://host-a.example/file1.bin";
    const link2 = "https://host-b.example/file2.bin";
    const link3 = "https://host-c.example/file3.bin";
    const directUrl1 = `http://127.0.0.1:${address.port}/ad-1`;
    const directUrl2 = `http://127.0.0.1:${address.port}/ad-2`;
    const directUrl3 = `http://127.0.0.1:${address.port}/ad-3`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/link/unlock")) {
        const body = init?.body;
        const bodyText = body instanceof URLSearchParams ? body.toString() : String(body || "");
        const originalLink = new URLSearchParams(bodyText).get("link") || "";
        const directUrl = originalLink === link2 ? directUrl2 : originalLink === link3 ? directUrl3 : directUrl1;
        const fileName = originalLink === link2 ? "ad-2.bin" : originalLink === link3 ? "ad-3.bin" : "ad-1.bin";
        return new Response(
          JSON.stringify({
            status: "success",
            data: {
              link: directUrl,
              filename: fileName,
              filesize: binary.length
            }
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          allDebridToken: "ad-token",
          providerOrder: [],
          providerPrimary: "alldebrid",
          providerSecondary: "none",
          providerTertiary: "none",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          enableIntegrityCheck: false,
          maxParallel: 3
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "ad-paced", links: [link1, link2, link3] }]);
      await manager.start();

      const managerInternals = manager as unknown as {
        retryAfterByItem: Map<string, number>;
      };
      await waitFor(() => managerInternals.retryAfterByItem.size >= 3, 5000);

      const now = Date.now();
      const readyTimes = [...managerInternals.retryAfterByItem.values()].sort((a, b) => a - b);
      expect(readyTimes.length).toBe(3);
      const firstDelay = readyTimes[0] - now;
      const lastDelay = readyTimes[readyTimes.length - 1] - now;
      expect(firstDelay).toBeGreaterThan(2000);
      expect(firstDelay).toBeLessThan(4500);
      expect(lastDelay - firstDelay).toBeLessThan(500);

      manager.stop();
      await waitFor(() => !manager.getSnapshot().session.running, 15000);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 20000);

  it("tops up newly freed AllDebrid slots with a fresh 3 second countdown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const shortBinary = Buffer.alloc(64 * 1024, 7);
    const longBinary = Buffer.alloc(512 * 1024, 8);

    const server = http.createServer((req, res) => {
      const route = req.url || "";
      if (route === "/ad-1") {
        setTimeout(() => {
          res.statusCode = 200;
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", String(shortBinary.length));
          res.end(shortBinary);
        }, 150);
        return;
      }
      if (route === "/ad-2" || route === "/ad-3" || route === "/ad-4") {
        setTimeout(() => {
          res.statusCode = 200;
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", String(longBinary.length));
          res.end(longBinary);
        }, 6000);
        return;
      }
      res.statusCode = 404;
      res.end("not-found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const links = [
      "https://rapidgator.net/file/ad-topup-1",
      "https://rapidgator.net/file/ad-topup-2",
      "https://rapidgator.net/file/ad-topup-3",
      "https://rapidgator.net/file/ad-topup-4"
    ];

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          allDebridToken: "ad-token",
          allDebridUseWebLogin: true,
          providerOrder: [],
          providerPrimary: "alldebrid",
          providerSecondary: "none",
          providerTertiary: "none",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          autoReconnect: false,
          enableIntegrityCheck: false,
          maxParallel: 3
        },
        emptySession(),
        createStoragePaths(path.join(root, "state")),
        {
          allDebridWebUnrestrict: async (link) => {
            const slot = links.indexOf(link) + 1;
            return {
              fileName: `ad-topup-${slot}.bin`,
              directUrl: `http://127.0.0.1:${address.port}/ad-${slot}`,
              fileSize: slot === 1 ? shortBinary.length : longBinary.length,
              retriesUsed: 0
            };
          }
        }
      );

      manager.addPackages([{ name: "ad-topup", links }]);
      await manager.start();

      await waitFor(() => {
        const items = Object.values(manager.getSnapshot().session.items);
        return items.filter((item) => item.status === "downloading").length === 3;
      }, 12000);

      await waitFor(() => {
        const items = Object.values(manager.getSnapshot().session.items);
        const completedCount = items.filter((item) => item.status === "completed").length;
        const countdownItems = items.filter((item) => /^AllDebrid Start in [123]s$/.test(item.fullStatus || ""));
        return completedCount >= 1 && countdownItems.length === 1;
      }, 12000);

      manager.stop();
      await waitFor(() => !manager.getSnapshot().session.running, 15000);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 25000);

  it("creates extract directory only at extraction and marks items as Entpackt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const zip = new AdmZip();
    zip.addFile("inside.txt", Buffer.from("ok"));
    const archive = zip.toBuffer();

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/archive") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(archive.length));
        res.end(archive);
      }, 450);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/archive`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "sample.zip",
            filesize: archive.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          createExtractSubfolder: true,
          autoExtract: true,
          enableIntegrityCheck: false,
          cleanupMode: "none"
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "zip-pack", links: ["https://dummy/archive"] }]);
      const pkgId = manager.getSnapshot().session.packageOrder[0];
      const extractDir = manager.getSnapshot().session.packages[pkgId]?.extractDir || "";
      expect(extractDir).toBeTruthy();
      expect(fs.existsSync(extractDir)).toBe(false);

      await manager.start();
      await new Promise((resolve) => setTimeout(resolve, 140));
      expect(fs.existsSync(extractDir)).toBe(false);

      await waitFor(() => fs.existsSync(path.join(extractDir, "inside.txt")), 30000);

      const snapshot = manager.getSnapshot();
      const item = Object.values(snapshot.session.items)[0];
      expect(item?.status).toBe("completed");
      expect(item?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
      expect(fs.existsSync(extractDir)).toBe(true);
      expect(fs.existsSync(path.join(extractDir, "inside.txt"))).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("keeps accurate summary when completed items are cleaned immediately", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(128 * 1024, 3);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/file") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/file`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "episode.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          completedCleanupPolicy: "immediate"
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "cleanup", links: ["https://dummy/cleanup"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const snapshot = manager.getSnapshot();
      const summary = manager.getSummary();
      expect(Object.keys(snapshot.session.items)).toHaveLength(0);
      expect(summary).not.toBeNull();
      expect(summary?.total).toBe(1);
      expect(summary?.success).toBe(1);
      expect(summary?.failed).toBe(0);
      expect(summary?.cancelled).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("removes finished package when package_done cleanup policy is enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const zip = new AdmZip();
    zip.addFile("episode.txt", Buffer.from("ok"));
    zip.addFile("padding.bin", crypto.randomBytes(8 * 1024));
    const archiveBinary = zip.toBuffer();

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/cleanup-package") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(archiveBinary.length));
      res.end(archiveBinary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/cleanup-package`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "cleanup-package.zip",
            filesize: archiveBinary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: true,
          enableIntegrityCheck: false,
          cleanupMode: "none",
          completedCleanupPolicy: "package_done"
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "cleanup-package", links: ["https://dummy/cleanup-package"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);
      await waitFor(() => manager.getSnapshot().session.packageOrder.length === 0, 12000);

      const snapshot = manager.getSnapshot();
      const summary = manager.getSummary();
      expect(snapshot.session.packageOrder).toHaveLength(0);
      expect(Object.keys(snapshot.session.items)).toHaveLength(0);
      expect(summary).not.toBeNull();
      expect(summary?.success).toBe(1);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("waits for deferred MKV collection before package_done cleanup removes the package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const zip = new AdmZip();
    zip.addFile("Season 1/Episode01.mkv", Buffer.from("video"));
    zip.addFile("Season 1/sample.txt", Buffer.from("sample"));
    zip.addFile("padding.bin", crypto.randomBytes(8 * 1024));
    const archiveBinary = zip.toBuffer();

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/cleanup-package-mkv") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(archiveBinary.length));
      res.end(archiveBinary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/cleanup-package-mkv`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "cleanup-package-mkv.zip",
            filesize: archiveBinary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const extractRoot = path.join(root, "extract");
      const mkvLibraryDir = path.join(root, "mkv-library");
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: extractRoot,
          autoExtract: true,
          autoRename4sf4sj: false,
          collectMkvToLibrary: true,
          mkvLibraryDir,
          enableIntegrityCheck: false,
          cleanupMode: "delete",
          completedCleanupPolicy: "package_done"
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "cleanup-package-mkv", links: ["https://dummy/cleanup-package-mkv"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);
      await waitFor(() => manager.getSnapshot().session.packageOrder.length === 0, 12000);

      const flattenedPath = path.join(mkvLibraryDir, "Episode01.mkv");
      const extractDir = path.join(extractRoot, "cleanup-package-mkv");
      expect(fs.existsSync(flattenedPath)).toBe(true);
      expect(fs.existsSync(extractDir)).toBe(false);
      expect(Object.keys(manager.getSnapshot().session.items)).toHaveLength(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("cleans link, sample and residual artifacts before package_done cleanup removes the package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const zip = new AdmZip();
    zip.addFile("Season 1/Episode01.mkv", Buffer.from("video"));
    zip.addFile("Season 1/episode.links.txt", Buffer.from("https://example.com/file"));
    zip.addFile("Season 1/cover.jpg", Buffer.from("cover"));
    zip.addFile("Season 1/sample/sample.mkv", Buffer.from("sample-video"));
    zip.addFile("Season 1/sample/readme.txt", Buffer.from("sample-text"));
    zip.addFile("padding.bin", crypto.randomBytes(8 * 1024));
    const archiveBinary = zip.toBuffer();

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/cleanup-package-full") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(archiveBinary.length));
      res.end(archiveBinary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/cleanup-package-full`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "cleanup-package-full.zip",
            filesize: archiveBinary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const extractRoot = path.join(root, "extract");
      const outputRoot = path.join(root, "downloads");
      const mkvLibraryDir = path.join(root, "mkv-library");
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: outputRoot,
          extractDir: extractRoot,
          autoExtract: true,
          autoRename4sf4sj: false,
          collectMkvToLibrary: true,
          mkvLibraryDir,
          removeLinkFilesAfterExtract: true,
          removeSamplesAfterExtract: true,
          enableIntegrityCheck: false,
          cleanupMode: "delete",
          completedCleanupPolicy: "package_done"
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "cleanup-package-full", links: ["https://dummy/cleanup-package-full"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);
      await waitFor(() => manager.getSnapshot().session.packageOrder.length === 0, 12000);

      const flattenedPath = path.join(mkvLibraryDir, "Episode01.mkv");
      expect(fs.existsSync(flattenedPath)).toBe(true);
      expect(fs.existsSync(path.join(extractRoot, "cleanup-package-full"))).toBe(false);
      expect(fs.existsSync(path.join(outputRoot, "cleanup-package-full"))).toBe(false);
      expect(Object.keys(manager.getSnapshot().session.items)).toHaveLength(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("counts queued package cancellations in run summary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 5);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/slow") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      const mid = Math.floor(binary.length / 2);
      res.write(binary.subarray(0, mid));
      setTimeout(() => {
        res.end(binary.subarray(mid));
      }, 600);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/slow`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "episode.mkv",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "cancel-run", links: ["https://dummy/one", "https://dummy/two"] }]);
      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const pkgId = manager.getSnapshot().session.packageOrder[0];
      manager.cancelPackage(pkgId);
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const summary = manager.getSummary();
      expect(summary).not.toBeNull();
      expect(summary?.total).toBe(2);
      expect(summary?.cancelled).toBe(2);
      expect(summary?.success).toBe(0);
      expect(summary?.failed).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("finishes run when remaining packages are disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(96 * 1024, 8);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/enabled") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.end(binary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/enabled`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "enabled.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([
        { name: "enabled", links: ["https://dummy/enabled"] },
        { name: "disabled", links: ["https://dummy/disabled"] }
      ]);
      const initial = manager.getSnapshot();
      const enabledPkgId = initial.session.packageOrder[0];
      const disabledPkgId = initial.session.packageOrder[1];
      const enabledItemId = initial.session.packages[enabledPkgId]?.itemIds[0] || "";
      const disabledItemId = initial.session.packages[disabledPkgId]?.itemIds[0] || "";

      manager.togglePackage(disabledPkgId);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const snapshot = manager.getSnapshot();
      expect(snapshot.session.packages[disabledPkgId]?.enabled).toBe(false);
      expect(snapshot.session.items[enabledItemId]?.status).toBe("completed");
      expect(snapshot.session.items[disabledItemId]?.status).toBe("queued");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("stops active package and keeps items queued", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(320 * 1024, 15);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/toggle") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      const half = Math.floor(binary.length / 2);
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.write(binary.subarray(0, half));
      setTimeout(() => {
        res.end(binary.subarray(half));
      }, 1200);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/toggle`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "toggle.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "toggle", links: ["https://dummy/toggle"] }]);
      const initial = manager.getSnapshot();
      const pkgId = initial.session.packageOrder[0];
      const itemId = initial.session.packages[pkgId]?.itemIds[0] || "";

      manager.start();
      await waitFor(() => {
        const item = manager.getSnapshot().session.items[itemId];
        return item?.status === "downloading";
      }, 12000);

      manager.togglePackage(pkgId);
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const snapshot = manager.getSnapshot();
      const item = snapshot.session.items[itemId];
      expect(snapshot.session.packages[pkgId]?.enabled).toBe(false);
      expect(item?.status).toBe("queued");
      expect(item?.fullStatus).toBe("Paket gestoppt");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("shows stable ETA while paused", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(320 * 1024, 10);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/pause") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      const chunk = Math.floor(binary.length / 2);
      res.write(binary.subarray(0, chunk));
      setTimeout(() => {
        res.end(binary.subarray(chunk));
      }, 900);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/pause`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "pause.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "pause-case", links: ["https://dummy/pause"] }]);
      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      manager.togglePause();
      const pausedSnapshot = manager.getSnapshot();
      expect(pausedSnapshot.session.paused).toBe(true);
      expect(pausedSnapshot.etaText).toBe("ETA: --");

      manager.stop();
      await waitFor(() => !manager.getSnapshot().session.running, 15000);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("handles rapid pause/resume toggles without deadlock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(320 * 1024, 11);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/toggle-stress") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;
      const chunk = binary.subarray(start);

      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      } else {
        res.statusCode = 200;
      }

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(chunk.length));
      const split = Math.max(1, Math.floor(chunk.length / 4));
      res.write(chunk.subarray(0, split));
      setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.end(chunk.subarray(split));
        }
      }, 260);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/toggle-stress`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "stress.part01.rar",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "toggle-stress", links: ["https://dummy/toggle-stress"] }]);
      manager.start();

      await waitFor(() => Object.values(manager.getSnapshot().session.items)[0]?.status === "downloading", 12000);
      for (let i = 0; i < 6; i += 1) {
        manager.togglePause();
        await new Promise((resolve) => setTimeout(resolve, 90));
      }

      if (manager.getSnapshot().session.paused) {
        manager.togglePause();
      }

      await waitFor(() => !manager.getSnapshot().session.running, 25000);
      const item = Object.values(manager.getSnapshot().session.items)[0];
      expect(item?.status).toBe("completed");
      expect(fs.existsSync(item?.targetPath || "")).toBe(true);
      expect(fs.statSync(item?.targetPath || "").size).toBe(binary.length);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("keeps active downloads resumable on shutdown preparation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(480 * 1024, 5);

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/shutdown") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      res.write(binary.subarray(0, Math.floor(binary.length / 3)));
      setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.end(binary.subarray(Math.floor(binary.length / 3)));
        }
      }, 2200);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/shutdown`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "shutdown.part01.rar",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "shutdown-case", links: ["https://dummy/shutdown"] }]);
      const itemId = Object.values(manager.getSnapshot().session.items)[0]?.id || "";
      manager.start();
      await waitFor(() => manager.getSnapshot().session.items[itemId]?.status === "downloading", 12000);

      manager.prepareForShutdown();
      await waitFor(() => {
        const state = manager.getSnapshot();
        return !state.session.running && state.session.items[itemId]?.status === "queued";
      }, 8000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("queued");
      expect(item?.fullStatus).toBe("Wartet");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("marks extracting items as resumable extraction on shutdown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const session = emptySession();
    const packageId = "extract-stop-pkg";
    const itemId = "extract-stop-item";
    const createdAt = Date.now() - 20_000;
    const outputDir = path.join(root, "downloads", "extract-stop");
    const extractDir = path.join(root, "extract", "extract-stop");

    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "extract-stop",
      outputDir,
      extractDir,
      status: "extracting",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/extract-stop",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: "extract-stop.part01.rar",
      targetPath: path.join(outputDir, "extract-stop.part01.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpacken 40%",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    manager.prepareForShutdown();
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Entpacken abgebrochen (wird fortgesetzt)");
  });

  it("recovers pending extraction on startup for completed package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const outputDir = path.join(root, "downloads", "recovery");
    const extractDir = path.join(root, "extract", "recovery");
    fs.mkdirSync(outputDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile("episode.txt", Buffer.from("ok"));
    const archivePath = path.join(outputDir, "episode.zip");
    zip.writeZip(archivePath);

    const session = emptySession();
    const packageId = "recover-pkg";
    const itemId = "recover-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "recovery",
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/recover",
      provider: "megadebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: fs.statSync(archivePath).size,
      totalBytes: fs.statSync(archivePath).size,
      progressPercent: 100,
      fileName: "episode.zip",
      targetPath: archivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (100 MB)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        createExtractSubfolder: true,
        autoExtract: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => fs.existsSync(path.join(extractDir, "episode.txt")), 25000);
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]?.status).toBe("completed");
    expect(snapshot.session.items[itemId]?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
  });

  it("does not fail startup post-processing when source package dir is missing but extract output exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const outputDir = path.join(root, "downloads", "missing-source-ok");
    const extractDir = path.join(root, "extract", "missing-source-ok");
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, "episode.mkv"), "ok", "utf8");

    const session = emptySession();
    const packageId = "missing-source-ok-pkg";
    const itemId = "missing-source-ok-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "missing-source-ok",
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/missing-source-ok",
      provider: "megadebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: "missing-source-ok.part01.rar",
      targetPath: path.join(outputDir, "missing-source-ok.part01.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (123 B)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt"), 12000);
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]?.status).toBe("completed");
    expect(snapshot.session.items[itemId]?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
  });

  it("marks missing source package dir as extracted instead of failed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const outputDir = path.join(root, "downloads", "missing-source-empty");
    const extractDir = path.join(root, "extract", "missing-source-empty");

    const session = emptySession();
    const packageId = "missing-source-empty-pkg";
    const itemId = "missing-source-empty-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "missing-source-empty",
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/missing-source-empty",
      provider: "megadebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: "missing-source-empty.part01.rar",
      targetPath: path.join(outputDir, "missing-source-empty.part01.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (123 B)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt"), 12000);
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]?.status).toBe("completed");
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Entpackt (Quelle fehlt)");
  });

  it("resumes deferred startup cleanup for already extracted packages and removes them when package_done is active", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "startup-deferred-cleanup";
    const {
      session,
      packageId,
      itemId,
      outputDir,
      extractDir
    } = createCompletedArchiveSessionFromArchive(root, packageName, [
      { name: "Season 1/Episode01.mkv", data: Buffer.from("video") },
      { name: "Season 1/episode.links.txt", data: Buffer.from("https://example.com/file") },
      { name: "Season 1/sample/sample.mkv", data: Buffer.from("sample-video") },
      { name: "Season 1/sample/readme.txt", data: Buffer.from("sample-text") }
    ]);

    session.packages[packageId].status = "completed";
    session.items[itemId].fullStatus = "Entpackt - Done (<1s)";
    fs.mkdirSync(path.join(extractDir, "Season 1", "sample"), { recursive: true });
    fs.writeFileSync(path.join(extractDir, "Season 1", "Episode01.mkv"), "video", "utf8");
    fs.writeFileSync(path.join(extractDir, "Season 1", "episode.links.txt"), "https://example.com/file", "utf8");
    fs.writeFileSync(path.join(extractDir, "Season 1", "sample", "sample.mkv"), "sample-video", "utf8");
    fs.writeFileSync(path.join(extractDir, "Season 1", "sample", "readme.txt"), "sample-text", "utf8");

    const mkvLibraryDir = path.join(root, "mkv-library");
    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        removeLinkFilesAfterExtract: true,
        removeSamplesAfterExtract: true,
        enableIntegrityCheck: false,
        cleanupMode: "delete",
        completedCleanupPolicy: "package_done"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const flattenedPath = path.join(mkvLibraryDir, "Episode01.mkv");
    await waitFor(() => fs.existsSync(flattenedPath), 12000);
    await waitFor(() => manager.getSnapshot().session.packageOrder.length === 0, 12000);

    expect(fs.existsSync(flattenedPath)).toBe(true);
    expect(fs.existsSync(extractDir)).toBe(false);
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(manager.getSnapshot().session.items[itemId]).toBeUndefined();
  }, 20000);

  it("resumes deferred startup auto-rename for already extracted packages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Asbest.S02.GERMAN.720p.WEB.AVC-4SF";
    const sourceFileName = "4sf-asbest.web.7p-s02e01.mkv";
    const expectedFileName = "Asbest.S02E01.GERMAN.720p.WEB.AVC-4SF.mkv";
    const {
      session,
      packageId,
      itemId,
      extractDir,
      originalExtractedPath
    } = createCompletedArchiveSession(root, packageName, sourceFileName);

    session.packages[packageId].status = "completed";
    session.items[itemId].fullStatus = "Entpackt - Done (<1s)";
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(originalExtractedPath, "video", "utf8");

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const expectedPath = path.join(extractDir, expectedFileName);
    await waitFor(() => fs.existsSync(expectedPath), 12000);

    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
    expect(manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
  }, 20000);

  it("does not requeue already extracted items on startup when source archives were intentionally removed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "startup-extracted-without-source";
    const outputDir = path.join(root, "downloads", packageName);
    const extractDir = path.join(root, "extract", packageName);
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, "Episode01.mkv"), "video", "utf8");

    const session = emptySession();
    const packageId = `${packageName}-pkg`;
    const itemId = `${packageName}-item`;
    const createdAt = Date.now() - 20_000;
    const targetPath = path.join(outputDir, "episode.zip");
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: packageName,
      outputDir,
      extractDir,
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: `https://dummy/${packageName}`,
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 12_345,
      totalBytes: 12_345,
      progressPercent: 100,
      fileName: "episode.zip",
      targetPath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt - Done (<1s)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: false,
        enableIntegrityCheck: false,
        cleanupMode: "delete",
        completedCleanupPolicy: "never"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(manager.getSnapshot().session.items[itemId]?.status).toBe("completed");
    expect(manager.getSnapshot().session.items[itemId]?.fullStatus).toBe("Entpackt - Done (<1s)");
    expect(manager.getSnapshot().session.packages[packageId]?.status).toBe("completed");
  }, 20000);

  it("stops deferred post-extraction cleanup after package reset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const sharedDir = path.join(root, "shared");
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "episode.part01.rar"), "archive", "utf8");

    const session = emptySession();
    const packageId = "deferred-reset-pkg";
    const itemId = "deferred-reset-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "Deferred Reset",
      outputDir: sharedDir,
      extractDir: sharedDir,
      status: "completed",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/deferred-reset",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 123,
      totalBytes: 123,
      progressPercent: 100,
      fileName: "episode.part01.rar",
      targetPath: path.join(sharedDir, "episode.part01.rar"),
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig (123 B)",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    let renameStarted = false;
    let releaseRename = (): void => {};
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const internal = manager as any;
    internal.autoRenameExtractedVideoFiles = vi.fn(async () => {
      renameStarted = true;
      await renameGate;
      return 0;
    });
    const cleanupRemainingArchiveArtifacts = vi.fn(async () => 0);
    internal.cleanupRemainingArchiveArtifacts = cleanupRemainingArchiveArtifacts;

    const deferredPromise = internal.runDeferredPostExtraction(
      packageId,
      internal.session.packages[packageId],
      1,
      0,
      true,
      1
    );

    await waitFor(() => renameStarted, 4000);
    manager.resetPackage(packageId);
    releaseRename();
    await deferredPromise;

    expect(cleanupRemainingArchiveArtifacts).not.toHaveBeenCalled();
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]?.status).toBe("queued");
    expect(snapshot.session.items[itemId]?.status).toBe("queued");
  });

  it("does not let cancelled cleanup delete archives for a re-added package in the same folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Cancel Cleanup";
    const outputDir = path.join(root, "downloads", packageName);
    fs.mkdirSync(outputDir, { recursive: true });
    const archivePath = path.join(outputDir, "episode.part01.rar");
    fs.writeFileSync(archivePath, "archive", "utf8");

    const session = emptySession();
    const packageId = "cancel-cleanup-pkg";
    const itemId = "cancel-cleanup-item";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: packageName,
      outputDir,
      extractDir: path.join(root, "extract", packageName),
      status: "queued",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/episode.part01.rar",
      provider: null,
      status: "queued",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      fileName: "episode.part01.rar",
      targetPath: archivePath,
      resumable: true,
      attempts: 0,
      lastError: "",
      fullStatus: "Wartet",
      createdAt,
      updatedAt: createdAt
    };

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    manager.cancelPackage(packageId);
    manager.addPackages([{ name: packageName, links: ["https://dummy/episode.part01.rar"] }]);

    await waitFor(() => manager.getSnapshot().session.packageOrder.length === 1, 4000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fs.existsSync(archivePath)).toBe(true);
    const snapshot = manager.getSnapshot();
    const remainingPackage = snapshot.session.packages[snapshot.session.packageOrder[0]];
    expect(remainingPackage?.outputDir).toBe(outputDir);
  });

  it("does not delete startup archives when any completed item has an extract error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const outputDir = path.join(root, "downloads", "keep-failed-archive");
    const extractDir = path.join(root, "extract", "keep-failed-archive");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, "episode1.mkv"), "ok", "utf8");

    const okArchivePath = path.join(outputDir, "episode1.part01.rar");
    const failedArchivePath = path.join(outputDir, "episode2.part01.rar");
    fs.writeFileSync(okArchivePath, Buffer.from("ok-archive"));
    fs.writeFileSync(failedArchivePath, Buffer.from("failed-archive"));

    const session = emptySession();
    const packageId = "keep-failed-archive-pkg";
    const itemOkId = "keep-failed-archive-item-ok";
    const itemFailId = "keep-failed-archive-item-fail";
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: "keep-failed-archive",
      outputDir,
      extractDir,
      status: "completed",
      itemIds: [itemOkId, itemFailId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemOkId] = {
      id: itemOkId,
      packageId,
      url: "https://dummy/keep-failed-archive-1",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 10,
      totalBytes: 10,
      progressPercent: 100,
      fileName: "episode1.part01.rar",
      targetPath: okArchivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpackt - Done",
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemFailId] = {
      id: itemFailId,
      packageId,
      url: "https://dummy/keep-failed-archive-2",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: 14,
      totalBytes: 14,
      progressPercent: 100,
      fileName: "episode2.part01.rar",
      targetPath: failedArchivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Entpack-Fehler: Unexpected end of archive",
      createdAt,
      updatedAt: createdAt
    };

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        enableIntegrityCheck: false,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(fs.existsSync(okArchivePath)).toBe(true);
    expect(fs.existsSync(failedArchivePath)).toBe(true);
  });

  it("does not delete stale target file when stopping during unrestrict phase", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: false,
        maxParallel: 1
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    manager.addPackages([{ name: "stop-unrestrict", links: ["https://dummy/slow-unrestrict"] }]);
    const initialSnapshot = manager.getSnapshot();
    const pkgId = initialSnapshot.session.packageOrder[0];
    const itemId = initialSnapshot.session.packages[pkgId]?.itemIds[0] || "";
    if (!itemId) {
      throw new Error("item missing");
    }

    const item = manager.getSnapshot().session.items[itemId];
    const staleTargetPath = path.join(path.dirname(item.targetPath), "existing-before-start.mkv");
    fs.mkdirSync(path.dirname(staleTargetPath), { recursive: true });
    fs.writeFileSync(staleTargetPath, "keep", "utf8");

    const mutableSession = manager.getSnapshot().session;
    if (mutableSession.items[itemId]) {
      mutableSession.items[itemId].targetPath = staleTargetPath;
      mutableSession.items[itemId].fileName = path.basename(staleTargetPath);
      mutableSession.items[itemId].downloadedBytes = 0;
      mutableSession.items[itemId].progressPercent = 0;
    }

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        await new Promise((resolve) => setTimeout(resolve, 260));
        return new Response(
          JSON.stringify({
            download: "https://cdn.example/unused.bin",
            filename: "new-file.mkv",
            filesize: 1024
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    manager.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    manager.stop();
    await waitFor(() => manager.getSnapshot().session.items[itemId]?.status === "cancelled", 12000);
    expect(fs.existsSync(staleTargetPath)).toBe(true);
  });

  it("counts re-enabled package items in run summary totals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const payload = Buffer.alloc(96 * 1024, 5);
    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/slow") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(payload.length));
        res.end(payload);
      }, 180);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/slow`;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "episode.mkv",
            filesize: payload.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract"),
          autoExtract: false,
          maxParallel: 1
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([
        { name: "pkg-a", links: ["https://dummy/a"] },
        { name: "pkg-b", links: ["https://dummy/b"] }
      ]);

      const packageIds = manager.getSnapshot().session.packageOrder;
      const packageToToggle = packageIds[0];
      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      manager.togglePackage(packageToToggle);
      manager.togglePackage(packageToToggle);

      await waitFor(() => !manager.getSnapshot().session.running, 25000);
      const summary = manager.getSnapshot().summary;
      expect(summary?.total).toBe(2);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("auto-renames extracted 4SF scene files to folder format", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Asbest.S02.GERMAN.720p.WEB.AVC-4SF";
    const sourceFileName = "4sf-asbest.web.7p-s02e01.mkv";
    const expectedFileName = "Asbest.S02E01.GERMAN.720p.WEB.AVC-4SF.mkv";
    const { session, packageId, itemId, extractDir, originalExtractedPath } = createCompletedArchiveSession(root, packageName, sourceFileName);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const expectedPath = path.join(extractDir, expectedFileName);
    await waitFor(() => fs.existsSync(expectedPath), 12000);
    const snapshot = manager.getSnapshot();
    expect(snapshot.session.packages[packageId]?.status).toBe("completed");
    expect(snapshot.session.items[itemId]?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
  });

  it("tracks app runtime for session and all-time statistics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const stateDir = path.join(root, "state");
    const storagePaths = createStoragePaths(stateDir);
    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        totalRuntimeAllTimeMs: 2 * 60 * 60 * 1000
      },
      emptySession(),
      storagePaths
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const stats = manager.getStats();
    expect(stats.sessionRuntimeMs).toBeGreaterThanOrEqual(100);
    expect(stats.totalRuntimeMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 + 100);
    expect(stats.runtimeMeasuredAt).toBeGreaterThan(0);

    manager.persistRuntimeStats(true);
    const savedSettings = JSON.parse(fs.readFileSync(storagePaths.configFile, "utf8")) as { totalRuntimeAllTimeMs?: number };
    expect(savedSettings.totalRuntimeAllTimeMs || 0).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 + 100);
  }, 10000);

  it("resets session runtime without affecting all-time runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        totalRuntimeAllTimeMs: 90 * 60 * 1000
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const beforeReset = manager.getStats();
    expect(beforeReset.sessionRuntimeMs).toBeGreaterThanOrEqual(100);

    manager.resetSessionStats();

    const afterReset = manager.getStats();
    expect(afterReset.sessionRuntimeMs).toBeLessThan(beforeReset.sessionRuntimeMs);
    expect(afterReset.sessionRuntimeMs).toBeLessThan(100);
    expect(afterReset.totalRuntimeMs).toBeGreaterThanOrEqual(90 * 60 * 1000);
  }, 10000);

  it("writes auto-rename details into rename and item logs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Asbest.S02.GERMAN.720p.WEB.AVC-4SF";
    const sourceFileName = "4sf-asbest.web.7p-s02e01.mkv";
    const expectedFileName = "Asbest.S02E01.GERMAN.720p.WEB.AVC-4SF.mkv";
    const { session, itemId, extractDir } = createCompletedArchiveSession(root, packageName, sourceFileName);
    const stateDir = path.join(root, "state");
    initItemLogs(stateDir);
    initRenameLog(stateDir);

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(stateDir)
    );

    const expectedPath = path.join(extractDir, expectedFileName);
    await waitFor(() => fs.existsSync(expectedPath), 12000);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const renameLogPath = getRenameLogPath();
    expect(renameLogPath).not.toBeNull();
    const renameContent = fs.readFileSync(renameLogPath!, "utf8");
    expect(renameContent).toContain("Auto-Rename durchgeführt");
    expect(renameContent).toContain(`targetPath=${expectedPath}`);

    const itemLogPath = getItemLogPath(itemId);
    expect(itemLogPath).not.toBeNull();
    const itemContent = fs.readFileSync(itemLogPath!, "utf8");
    expect(itemContent).toContain("Auto-Rename durchgeführt");
    expect(itemContent).toContain("stage=auto-rename");
  }, 20000);

  it("adds REPACK marker from rp token and supports 4SJ folders", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Asbest.S02.GERMAN.720p.WEB.AVC-4SJ";
    const sourceFileName = "4sf-asbest.rp.web.7p-s02e01.mkv";
    const expectedFileName = "Asbest.S02E01.GERMAN.REPACK.720p.WEB.AVC-4SJ.mkv";
    const { session, itemId, extractDir, originalExtractedPath } = createCompletedArchiveSession(root, packageName, sourceFileName);

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const expectedPath = path.join(extractDir, expectedFileName);
    await waitFor(() => fs.existsSync(expectedPath), 12000);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
  });

  it("skips auto-rename when no SxxExx token exists in source filename", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Asbest.S02.GERMAN.720p.WEB.AVC-4SF";
    const sourceFileName = "4sf-asbest.rp.web.7p-episode.mkv";
    const unexpectedName = "Asbest.S02.GERMAN.REPACK.720p.WEB.AVC-4SF.mkv";
    const { session, itemId, extractDir, originalExtractedPath } = createCompletedArchiveSession(root, packageName, sourceFileName);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: true,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt"), 12000);
    expect(fs.existsSync(originalExtractedPath)).toBe(true);
    expect(fs.existsSync(path.join(extractDir, unexpectedName))).toBe(false);
  });

  it("does not rename extracted scene files when auto-rename is disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Asbest.S02.GERMAN.720p.WEB.AVC-4SF";
    const sourceFileName = "4sf-asbest.web.7p-s02e01.mkv";
    const unexpectedName = "Asbest.S02E01.GERMAN.720p.WEB.AVC-4SF.mkv";
    const { session, itemId, extractDir, originalExtractedPath } = createCompletedArchiveSession(root, packageName, sourceFileName);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt"), 12000);
    expect(fs.existsSync(originalExtractedPath)).toBe(true);
    expect(fs.existsSync(path.join(extractDir, unexpectedName))).toBe(false);
  });

  it("moves extracted MKV files into a flat library folder per completed package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Flat-Pack";
    const sourceFileName = "Season 1/Episode01.mkv";
    const { session, packageId, itemId, originalExtractedPath } = createCompletedArchiveSession(root, packageName, sourceFileName);
    const mkvLibraryDir = path.join(root, "mkv-library");

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const flattenedPath = path.join(mkvLibraryDir, "Episode01.mkv");
    await waitFor(() => fs.existsSync(flattenedPath), 12000);

    expect(manager.getSnapshot().session.packages[packageId]?.status).toBe("completed");
    expect(manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
    expect(fs.existsSync(flattenedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
  }, 20000);

  it("moves extracted AVI files into a flat library folder per completed package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Flat-Pack-AVI";
    const sourceFileName = "Season 1/Episode01.avi";
    const { session, packageId, itemId, originalExtractedPath } = createCompletedArchiveSession(root, packageName, sourceFileName);
    const mkvLibraryDir = path.join(root, "mkv-library");

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const flattenedPath = path.join(mkvLibraryDir, "Episode01.avi");
    await waitFor(() => fs.existsSync(flattenedPath), 12000);

    expect(manager.getSnapshot().session.packages[packageId]?.status).toBe("completed");
    expect(manager.getSnapshot().session.items[itemId]?.fullStatus.startsWith("Entpackt - Done")).toBe(true);
    expect(fs.existsSync(flattenedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
  }, 20000);

  it("keeps existing MKV names and appends a suffix while flattening", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Flat-Collision";
    const sourceFileName = "Season 1/Episode01.mkv";
    const { session } = createCompletedArchiveSession(root, packageName, sourceFileName);
    const mkvLibraryDir = path.join(root, "mkv-library");
    fs.mkdirSync(mkvLibraryDir, { recursive: true });
    const existingPath = path.join(mkvLibraryDir, "Episode01.mkv");
    fs.writeFileSync(existingPath, "already-here", "utf8");

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const suffixedPath = path.join(mkvLibraryDir, "Episode01 (2).mkv");
    await waitFor(() => fs.existsSync(suffixedPath), 12000);

    expect(fs.existsSync(existingPath)).toBe(true);
    expect(fs.readFileSync(existingPath, "utf8")).toBe("already-here");
    expect(fs.existsSync(suffixedPath)).toBe(true);
  });

  it("removes empty package folders after MKV flattening even with desktop.ini or thumbs.db", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Gotham.S03.GERMAN.5.1.DL.AC3.720p.BDRiP.x264-TvR";
    const outputDir = path.join(root, "downloads", packageName);
    const extractDir = path.join(root, "extract", packageName);
    fs.mkdirSync(outputDir, { recursive: true });

    const nestedFolder = "Gotham.S03E11.Ein.Ungeheuer.namens.Eifersucht.GERMAN.5.1.DL.AC3.720p.BDRiP.x264-TvR";
    const sourceFileName = `${nestedFolder}/tvr-gotham-s03e11-720p.mkv`;
    const zip = new AdmZip();
    zip.addFile(sourceFileName, Buffer.from("video"));
    zip.addFile(`${nestedFolder}/tvr-gotham-s03-720p.nfo`, Buffer.from("info"));
    zip.addFile(`${nestedFolder}/Thumbs.db`, Buffer.from("thumbs"));
    zip.addFile("desktop.ini", Buffer.from("system"));
    const archivePath = path.join(outputDir, "episode.zip");
    zip.writeZip(archivePath);
    const archiveSize = fs.statSync(archivePath).size;

    const session = emptySession();
    const packageId = `${packageName}-pkg`;
    const itemId = `${packageName}-item`;
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: packageName,
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/gotham",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: archiveSize,
      totalBytes: archiveSize,
      progressPercent: 100,
      fileName: "episode.zip",
      targetPath: archivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig",
      createdAt,
      updatedAt: createdAt
    };

    const mkvLibraryDir = path.join(root, "mkv-library");
    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    const flattenedPath = path.join(mkvLibraryDir, "tvr-gotham-s03e11-720p.mkv");
    await waitFor(() => fs.existsSync(flattenedPath), 12000);

    expect(fs.existsSync(flattenedPath)).toBe(true);
    expect(fs.existsSync(extractDir)).toBe(false);
  }, 20000);

  it("cleans duplicate-skipped MKV source trees including leftover sample files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Flat-Duplicate-Cleanup";
    const outputDir = path.join(root, "downloads", packageName);
    const extractDir = path.join(root, "extract", packageName);
    fs.mkdirSync(outputDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile("Season 1/Episode01.mkv", Buffer.from("video"));
    zip.addFile("Season 1/sample.txt", Buffer.from("sample"));
    const archivePath = path.join(outputDir, "episode.zip");
    zip.writeZip(archivePath);
    const archiveSize = fs.statSync(archivePath).size;

    const session = emptySession();
    const packageId = `${packageName}-pkg`;
    const itemId = `${packageName}-item`;
    const createdAt = Date.now() - 20_000;
    session.packageOrder = [packageId];
    session.packages[packageId] = {
      id: packageId,
      name: packageName,
      outputDir,
      extractDir,
      status: "downloading",
      itemIds: [itemId],
      cancelled: false,
      enabled: true,
      createdAt,
      updatedAt: createdAt
    };
    session.items[itemId] = {
      id: itemId,
      packageId,
      url: "https://dummy/flat-duplicate-cleanup",
      provider: "realdebrid",
      status: "completed",
      retries: 0,
      speedBps: 0,
      downloadedBytes: archiveSize,
      totalBytes: archiveSize,
      progressPercent: 100,
      fileName: "episode.zip",
      targetPath: archivePath,
      resumable: true,
      attempts: 1,
      lastError: "",
      fullStatus: "Fertig",
      createdAt,
      updatedAt: createdAt
    };

    const mkvLibraryDir = path.join(root, "mkv-library");
    fs.mkdirSync(mkvLibraryDir, { recursive: true });
    fs.writeFileSync(path.join(mkvLibraryDir, "Episode01.mkv"), Buffer.from("video"));

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        enableIntegrityCheck: false,
        cleanupMode: "none"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => !fs.existsSync(extractDir), 12000);

    expect(fs.existsSync(path.join(mkvLibraryDir, "Episode01.mkv"))).toBe(true);
    expect(fs.existsSync(extractDir)).toBe(false);
  }, 20000);

  it("cleans duplicate-skipped MKV source trees with link and residual artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const packageName = "Flat-Duplicate-Cleanup-Extended";
    const {
      session,
      extractDir
    } = createCompletedArchiveSessionFromArchive(root, packageName, [
      { name: "Season 1/Episode01.mkv", data: Buffer.from("video") },
      { name: "Season 1/episode.links.txt", data: Buffer.from("https://example.com/file") },
      { name: "Season 1/info.nfo", data: Buffer.from("info") },
      { name: "Season 1/sample/sample.mkv", data: Buffer.from("sample-video") },
      { name: "Season 1/sample/readme.txt", data: Buffer.from("sample-text") }
    ]);

    const mkvLibraryDir = path.join(root, "mkv-library");
    fs.mkdirSync(mkvLibraryDir, { recursive: true });
    fs.writeFileSync(path.join(mkvLibraryDir, "Episode01.mkv"), Buffer.from("video"));

    new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        autoExtract: true,
        autoRename4sf4sj: false,
        collectMkvToLibrary: true,
        mkvLibraryDir,
        removeLinkFilesAfterExtract: true,
        removeSamplesAfterExtract: true,
        enableIntegrityCheck: false,
        cleanupMode: "delete"
      },
      session,
      createStoragePaths(path.join(root, "state"))
    );

    await waitFor(() => !fs.existsSync(extractDir), 12000);

    expect(fs.existsSync(path.join(mkvLibraryDir, "Episode01.mkv"))).toBe(true);
    expect(fs.existsSync(extractDir)).toBe(false);
  }, 20000);

  it("waits for deferred archive cleanup before package_done removal without MKV collection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const zip = new AdmZip();
    zip.addFile("Episode01.mkv", Buffer.from("video"));
    zip.addFile("padding.bin", crypto.randomBytes(8 * 1024));
    const archiveBinary = zip.toBuffer();

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/cleanup-archives-only") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(archiveBinary.length));
      res.end(archiveBinary);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/cleanup-archives-only`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "cleanup-archives-only.zip",
            filesize: archiveBinary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const outputRoot = path.join(root, "downloads");
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: outputRoot,
          extractDir: path.join(root, "extract"),
          autoExtract: true,
          autoRename4sf4sj: false,
          collectMkvToLibrary: false,
          enableIntegrityCheck: false,
          cleanupMode: "delete",
          completedCleanupPolicy: "package_done"
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "cleanup-archives-only", links: ["https://dummy/cleanup-archives-only"] }]);
      await manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);
      await waitFor(() => manager.getSnapshot().session.packageOrder.length === 0, 12000);

      expect(fs.existsSync(path.join(outputRoot, "cleanup-archives-only", "cleanup-archives-only.zip"))).toBe(false);
      expect(Object.keys(manager.getSnapshot().session.items)).toHaveLength(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 35000);

  it("throws a controlled error for invalid queue import JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    expect(() => manager.importQueue("{not-json")).toThrow(/Ungultige Queue-Datei/i);
  });

  it("imports structured text exports and preserves package names and file hints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    const result = manager.importQueue([
      "# rd-link-export: 1",
      "# package: Dave Staffel 1",
      "# file: Dave.S01E01.rar",
      "https://example.com/e01",
      "# file: Dave.S01E02.rar",
      "https://example.com/e02"
    ].join("\n"));

    expect(result).toEqual({ addedPackages: 1, addedLinks: 2 });

    const snapshot = manager.getSnapshot();
    const packageId = snapshot.session.packageOrder[0];
    const pkg = snapshot.session.packages[packageId];
    expect(pkg?.name).toBe("Dave Staffel 1");
    const importedItems = pkg?.itemIds.map((itemId) => snapshot.session.items[itemId]);
    expect(importedItems?.map((item) => item?.fileName)).toEqual(["Dave.S01E01.rar", "Dave.S01E02.rar"]);
  });

  it("applies global speed limit path when global mode is enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract"),
        speedLimitEnabled: true,
        speedLimitMode: "global",
        speedLimitKbps: 512
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    const internal = manager as unknown as {
      applySpeedLimit: (chunkBytes: number, localWindowBytes: number, localWindowStarted: number) => Promise<void>;
      globalSpeedLimitNextAt: number;
    };

    const start = Date.now();
    await internal.applySpeedLimit(1024, 0, start);
    expect(internal.globalSpeedLimitNextAt).toBeGreaterThan(start);
  });

  it("resets speed window head when start finds no runnable items", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    const internal = manager as unknown as {
      speedEvents: Array<{ at: number; bytes: number }>;
      speedEventsHead: number;
      speedBytesLastWindow: number;
    };
    internal.speedEvents = [{ at: Date.now() - 10_000, bytes: 999 }];
    internal.speedEventsHead = 5;
    internal.speedBytesLastWindow = 999;

    await manager.start();
    expect(internal.speedEventsHead).toBe(0);
    expect(internal.speedEvents.length).toBe(0);
    expect(internal.speedBytesLastWindow).toBe(0);
  });

  it("does not trigger global stall abort while write-buffer is disk-blocked", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const previousGlobalWatchdog = process.env.RD_GLOBAL_STALL_TIMEOUT_MS;
    process.env.RD_GLOBAL_STALL_TIMEOUT_MS = "2500";

    try {
      const manager = new DownloadManager(
        {
          ...defaultSettings(),
          token: "rd-token",
          outputDir: path.join(root, "downloads"),
          extractDir: path.join(root, "extract")
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "disk-block-guard", links: ["https://dummy/disk-block-guard"] }]);
      const snapshot = manager.getSnapshot();
      const packageId = snapshot.session.packageOrder[0] || "";
      const itemId = snapshot.session.packages[packageId]?.itemIds[0] || "";

      const internal = manager as unknown as any;
      internal.session.running = true;
      internal.session.paused = false;
      internal.session.reconnectUntil = 0;
      internal.session.totalDownloadedBytes = 0;
      internal.session.items[itemId].status = "downloading";
      internal.lastGlobalProgressBytes = 0;
      internal.lastGlobalProgressAt = Date.now() - 10000;

      const abortController = new AbortController();
      internal.activeTasks.set(itemId, {
        itemId,
        packageId,
        abortController,
        abortReason: "none",
        resumable: true,
        nonResumableCounted: false,
        blockedOnDiskWrite: true,
        blockedOnDiskSince: Date.now() - 5000
      });

      internal.runGlobalStallWatchdog(Date.now());

      expect(abortController.signal.aborted).toBe(false);
      expect(internal.lastGlobalProgressAt).toBeGreaterThan(Date.now() - 2000);
    } finally {
      if (previousGlobalWatchdog === undefined) {
        delete process.env.RD_GLOBAL_STALL_TIMEOUT_MS;
      } else {
        process.env.RD_GLOBAL_STALL_TIMEOUT_MS = previousGlobalWatchdog;
      }
    }
  });

  it("cleans run tracking when start conflict is skipped", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    manager.addPackages([{ name: "conflict-skip", links: ["https://dummy/skip"] }]);
    const snapshot = manager.getSnapshot();
    const packageId = snapshot.session.packageOrder[0];
    const itemId = snapshot.session.packages[packageId]?.itemIds[0] || "";

    const internal = manager as unknown as {
      runItemIds: Set<string>;
      runPackageIds: Set<string>;
      runOutcomes: Map<string, "completed" | "failed" | "cancelled">;
    };
    internal.runItemIds.add(itemId);
    internal.runPackageIds.add(packageId);
    internal.runOutcomes.set(itemId, "completed");

    const result = await manager.resolveStartConflict(packageId, "skip");
    expect(result.skipped).toBe(true);
    expect(internal.runItemIds.has(itemId)).toBe(false);
    expect(internal.runPackageIds.has(packageId)).toBe(false);
    expect(internal.runOutcomes.has(itemId)).toBe(false);
  });

  it("clears stale run outcomes on overwrite conflict resolution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    manager.addPackages([{ name: "conflict-overwrite", links: ["https://dummy/overwrite"] }]);
    const snapshot = manager.getSnapshot();
    const packageId = snapshot.session.packageOrder[0];
    const itemId = snapshot.session.packages[packageId]?.itemIds[0] || "";

    const internal = manager as unknown as {
      runOutcomes: Map<string, "completed" | "failed" | "cancelled">;
    };
    internal.runOutcomes.set(itemId, "failed");

    const result = await manager.resolveStartConflict(packageId, "overwrite");
    expect(result.overwritten).toBe(true);
    expect(internal.runOutcomes.has(itemId)).toBe(false);
    expect(manager.getSnapshot().session.items[itemId]?.status).toBe("queued");
  });

  it("clears speed display buffers when run finishes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        token: "rd-token",
        outputDir: path.join(root, "downloads"),
        extractDir: path.join(root, "extract")
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    const internal = manager as unknown as {
      runItemIds: Set<string>;
      runOutcomes: Map<string, "completed" | "failed" | "cancelled">;
      runCompletedPackages: Set<string>;
      session: { runStartedAt: number; totalDownloadedBytes: number; running: boolean; paused: boolean };
      speedEvents: Array<{ at: number; bytes: number }>;
      speedEventsHead: number;
      speedBytesLastWindow: number;
      finishRun: () => void;
    };

    internal.session.running = true;
    internal.session.paused = false;
    internal.session.runStartedAt = Date.now() - 2000;
    internal.session.totalDownloadedBytes = 4096;
    internal.runItemIds = new Set(["x"]);
    internal.runOutcomes = new Map([["x", "completed"]]);
    internal.runCompletedPackages = new Set();
    internal.speedEvents = [{ at: Date.now(), bytes: 4096 }];
    internal.speedEventsHead = 1;
    internal.speedBytesLastWindow = 4096;

    internal.finishRun();

    expect(internal.speedEvents.length).toBe(0);
    expect(internal.speedEventsHead).toBe(0);
    expect(internal.speedBytesLastWindow).toBe(0);
  });

  it("tracks daily usage on the actual provider key without touching other providers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        megaLogin: "mega-user",
        megaPassword: "mega-pass",
        megaDebridApiEnabled: true,
        providerDailyUsageDay: getProviderUsageDayKey(),
        providerDailyUsageBytes: { realdebrid: 512 },
        providerTotalUsageBytes: { realdebrid: 2048 }
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    const internal = manager as unknown as {
      recordProviderDownloadedBytes: (provider: "megadebrid", bytes: number) => void;
      settings: ReturnType<typeof defaultSettings>;
    };

    internal.recordProviderDownloadedBytes("megadebrid", 1024);

    expect(internal.settings.providerDailyUsageBytes.realdebrid).toBe(512);
    expect(internal.settings.providerDailyUsageBytes["megadebrid-api"]).toBe(1024);
    expect((internal.settings.providerDailyUsageBytes as Record<string, number>).megadebrid).toBeUndefined();
    expect(internal.settings.providerTotalUsageBytes.realdebrid).toBe(2048);
    expect(internal.settings.providerTotalUsageBytes["megadebrid-api"]).toBe(1024);
    expect((internal.settings.providerTotalUsageBytes as Record<string, number>).megadebrid).toBeUndefined();
  });

  it("tracks daily usage on the actual Debrid-Link key without touching other keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const [firstKey, secondKey] = parseDebridLinkApiKeys("dl-key-one\ndl-key-two");

    const manager = new DownloadManager(
      {
        ...defaultSettings(),
        debridLinkApiKeys: "dl-key-one\ndl-key-two",
        providerDailyUsageDay: getProviderUsageDayKey(),
        providerDailyUsageBytes: { debridlink: 256 },
        providerTotalUsageBytes: { debridlink: 4096 },
        debridLinkApiKeyDailyUsageBytes: { [secondKey.id]: 512 },
        debridLinkApiKeyTotalUsageBytes: { [secondKey.id]: 2048 }
      },
      emptySession(),
      createStoragePaths(path.join(root, "state"))
    );

    const internal = manager as unknown as {
      recordProviderDownloadedBytes: (provider: "debridlink", bytes: number, providerAccountId?: string) => void;
      settings: ReturnType<typeof defaultSettings>;
    };

    internal.recordProviderDownloadedBytes("debridlink", 1024, firstKey.id);

    expect(internal.settings.providerDailyUsageBytes.debridlink).toBe(1280);
    expect(internal.settings.providerTotalUsageBytes.debridlink).toBe(5120);
    expect(internal.settings.debridLinkApiKeyDailyUsageBytes[firstKey.id]).toBe(1024);
    expect(internal.settings.debridLinkApiKeyDailyUsageBytes[secondKey.id]).toBe(512);
    expect(internal.settings.debridLinkApiKeyTotalUsageBytes[firstKey.id]).toBe(1024);
    expect(internal.settings.debridLinkApiKeyTotalUsageBytes[secondKey.id]).toBe(2048);
  });

  it("does not hang when rapid stop, disable provider, start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 7);

    // Slow server: delivers data in chunks with delay
    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/slow-dl") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(binary.length));
      // Send first half, then delay
      res.write(binary.subarray(0, Math.floor(binary.length / 4)));
      const timer = setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.end(binary.subarray(Math.floor(binary.length / 4)));
        }
      }, 5000);
      res.on("close", () => clearTimeout(timer));
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const directUrl = `http://127.0.0.1:${address.port}/slow-dl`;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/unrestrict/link")) {
        return new Response(
          JSON.stringify({
            download: directUrl,
            filename: "test-file.bin",
            filesize: binary.length
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      return originalFetch(input, init);
    };

    const settings = {
      ...defaultSettings(),
      token: "rd-token",
      outputDir: path.join(root, "downloads"),
      extractDir: path.join(root, "extract"),
      autoExtract: false,
      maxParallel: 1,
      autoReconnect: false,
      retryLimit: 1
    };

    try {
      const manager = new DownloadManager(
        settings,
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "hang-test", links: ["https://dummy/hang-test"] }]);

      // Step 1: Start and wait for download to begin
      await manager.start();
      await waitFor(() => {
        const items = Object.values(manager.getSnapshot().session.items);
        return items.some((item) => item.status === "downloading");
      }, 12000);

      // Step 2: Stop — do NOT wait for running=false
      manager.stop();

      // Step 3: Immediately disable the active provider
      manager.setSettings({
        ...settings,
        disabledProviders: ["realdebrid"]
      });

      // Step 4: Start again immediately — must resolve (not hang)
      const startPromise = manager.start();
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8000));
      const result = await Promise.race([startPromise.then(() => "ok" as const), timeout]);
      expect(result).toBe("ok");
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 30000);
});
