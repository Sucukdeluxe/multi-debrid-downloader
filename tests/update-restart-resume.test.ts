import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadManager } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession, loadSession } from "../src/main/storage";
import { shutdownItemLogs } from "../src/main/item-log";
import { shutdownPackageLogs } from "../src/main/package-log";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  shutdownItemLogs();
  shutdownPackageLogs();
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startTricklingServer(): Promise<{ directUrl: string; stop: () => Promise<void> }> {
  const openTimers = new Set<NodeJS.Timeout>();
  const openResponses = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if ((req.url || "") !== "/direct") {
      res.statusCode = 404;
      res.end("not-found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(64 * 1024 * 1024));
    openResponses.add(res);
    res.write(Buffer.alloc(64 * 1024, 7));
    const timer = setInterval(() => {
      try {
        res.write(Buffer.alloc(16 * 1024, 9));
      } catch {
      }
    }, 100);
    openTimers.add(timer);
    res.on("close", () => {
      clearInterval(timer);
      openTimers.delete(timer);
      openResponses.delete(res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  const directUrl = `http://127.0.0.1:${address.port}/direct`;
  const stop = async (): Promise<void> => {
    for (const timer of openTimers) {
      clearInterval(timer);
    }
    openTimers.clear();
    for (const res of openResponses) {
      try {
        res.destroy();
      } catch {
      }
    }
    openResponses.clear();
    server.close();
    await once(server, "close");
  };
  return { directUrl, stop };
}

function mockUnrestrict(directUrl: string): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/unrestrict/link")) {
      return new Response(
        JSON.stringify({ download: directUrl, filename: "episode.mkv", filesize: 64 * 1024 * 1024 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return originalFetch(input, init);
  };
}

async function driveActiveDownload(root: string): Promise<{ manager: DownloadManager; paths: ReturnType<typeof createStoragePaths>; serverStop: () => Promise<void> }> {
  const { directUrl, stop: serverStop } = await startTricklingServer();
  mockUnrestrict(directUrl);
  const paths = createStoragePaths(path.join(root, "state"));
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
    paths
  );
  manager.addPackages([{ name: "park", links: ["https://dummy/park"] }]);
  await manager.start();
  await waitFor(() => {
    const item = Object.values(manager.getSnapshot().session.items)[0];
    return item?.status === "downloading" && (manager as unknown as { activeTasks: Map<string, unknown> }).activeTasks.size > 0;
  });
  return { manager, paths, serverStop };
}

describe("update restart resume", () => {
  it("characterization: a plain stop() leaves an in-flight item cancelled across a restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-update-resume-"));
    tempDirs.push(root);
    const { manager, paths, serverStop } = await driveActiveDownload(root);
    try {
      manager.stop();
      manager.persistNowSync();
      await waitFor(() => (manager as unknown as { activeTasks: Map<string, unknown> }).activeTasks.size === 0);
      manager.prepareForShutdown();

      const reloaded = loadSession(paths);
      const item = Object.values(reloaded.items)[0];
      expect(item).toBeTruthy();
      expect(item.status).toBe("cancelled");
    } finally {
      await serverStop();
    }
  });

  it("parks an in-flight item as queued for an update restart so it auto-resumes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-update-resume-"));
    tempDirs.push(root);
    const { manager, paths, serverStop } = await driveActiveDownload(root);
    try {
      manager.stop({ parkForRestart: true });
      manager.persistNowSync();
      await waitFor(() => (manager as unknown as { activeTasks: Map<string, unknown> }).activeTasks.size === 0);
      manager.prepareForShutdown();

      const reloaded = loadSession(paths);
      const item = Object.values(reloaded.items)[0];
      expect(item).toBeTruthy();
      expect(Object.keys(reloaded.packages).length).toBe(1);
      expect(item.status).toBe("queued");
    } finally {
      await serverStop();
    }
  });
});
