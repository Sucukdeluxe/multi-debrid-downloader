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
      manager.start();
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
          autoExtract: false
        },
        emptySession(),
        createStoragePaths(path.join(root, "state"))
      );

      manager.addPackages([{ name: "content-name", links: ["https://rapidgator.net/file/6f09df2984fe01378537c7cd8d7fa7ce"] }]);
      manager.start();
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
      manager.start();
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
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Entpackt");
  });
});
