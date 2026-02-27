import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadManager } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession } from "../src/main/storage";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("download manager", () => {
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
      manager.start();
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
      manager.start();
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

  it("reuses stored partial target path when queued item resumes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);
    const binary = Buffer.alloc(256 * 1024, 7);
    const partialSize = 64 * 1024;
    const pkgDir = path.join(root, "downloads", "resume");
    fs.mkdirSync(pkgDir, { recursive: true });
    const existingTargetPath = path.join(pkgDir, "resume.mkv");
    fs.writeFileSync(existingTargetPath, binary.subarray(0, partialSize));
    let seenRangeStart = -1;

    const server = http.createServer((req, res) => {
      if ((req.url || "") !== "/resume") {
        res.statusCode = 404;
        res.end("not-found");
        return;
      }

      const range = String(req.headers.range || "");
      const match = range.match(/bytes=(\d+)-/i);
      const start = match ? Number(match[1]) : 0;
      seenRangeStart = start;
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
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 25000);

      const item = manager.getSnapshot().session.items[itemId];
      expect(item?.status).toBe("completed");
      expect(item?.targetPath).toBe(existingTargetPath);
      expect(seenRangeStart).toBe(partialSize);
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
          autoExtract: false
        },
        session,
        createStoragePaths(path.join(root, "state"))
      );

      manager.start();
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

    manager.start();
    await waitFor(() => !manager.getSnapshot().session.running, 5000);

    const snapshot = manager.getSnapshot();
    const summary = manager.getSummary();
    expect(snapshot.session.totalDownloadedBytes).toBe(0);
    expect(snapshot.session.reconnectUntil).toBe(0);
    expect(snapshot.session.reconnectReason).toBe("");
    expect(summary).toBeNull();
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
      manager.start();
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
      manager.start();
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

      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 140));
      expect(fs.existsSync(extractDir)).toBe(false);

      await waitFor(() => !manager.getSnapshot().session.running, 30000);

      const snapshot = manager.getSnapshot();
      const item = Object.values(snapshot.session.items)[0];
      expect(item?.status).toBe("completed");
      expect(item?.fullStatus).toBe("Entpackt");
      expect(fs.existsSync(extractDir)).toBe(true);
      expect(fs.existsSync(path.join(extractDir, "inside.txt"))).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

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
      manager.start();
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
});
