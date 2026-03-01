import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter, once } from "node:events";
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
      manager.start();
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
      manager.start();
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
      manager.start();
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
          retryLimit: 1,
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
          retryLimit: 1,
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

      manager.start();
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

      manager.start();
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
      manager.start();
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

  it("requeues failed HTTP 416 items automatically on startup", () => {
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

  it("detects start conflicts when extract output already exists", () => {
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

    const conflicts = manager.getStartConflicts();
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
    expect(manager.getSnapshot().session.packages[packageId]).toBeUndefined();
    expect(manager.getSnapshot().session.items[itemId]).toBeUndefined();
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

    manager.start();
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

  it("removes finished package when package_done cleanup policy is enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dm-"));
    tempDirs.push(root);

    const zip = new AdmZip();
    zip.addFile("episode.txt", Buffer.from("ok"));
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
      manager.start();
      await waitFor(() => !manager.getSnapshot().session.running, 30000);

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
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Entpackt");
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
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Entpackt");
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
    expect(snapshot.session.items[itemId]?.fullStatus).toBe("Entpackt");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
  });

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
    expect(manager.getSnapshot().session.items[itemId]?.fullStatus).toBe("Entpackt");
    expect(fs.existsSync(flattenedPath)).toBe(true);
    expect(fs.existsSync(originalExtractedPath)).toBe(false);
  });

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
  });

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

  it("resets speed window head when start finds no runnable items", () => {
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

    manager.start();
    expect(internal.speedEventsHead).toBe(0);
    expect(internal.speedEvents.length).toBe(0);
    expect(internal.speedBytesLastWindow).toBe(0);
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
});
