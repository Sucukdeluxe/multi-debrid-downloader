import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { DownloadManager } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession } from "../src/main/storage";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Self-check fehlgeschlagen: ${message}`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout während Self-check");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runDownloadCase(baseDir: string, baseUrl: string, url: string, options?: Partial<ReturnType<typeof defaultSettings>>): Promise<DownloadManager> {
  const settings = {
    ...defaultSettings(),
    token: "demo-token",
    outputDir: path.join(baseDir, "downloads"),
    extractDir: path.join(baseDir, "extract"),
    autoExtract: false,
    autoReconnect: true,
    reconnectWaitSeconds: 1,
    ...options
  };

  const manager = new DownloadManager(settings, emptySession(), createStoragePaths(path.join(baseDir, "state")));
  manager.addPackages([
    {
      name: "test-package",
      links: [url]
    }
  ]);
  manager.start();
  await waitFor(() => !manager.getSnapshot().session.running, 30000);
  return manager;
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rd-node-self-"));
  const binary = Buffer.alloc(512 * 1024, 7);
  let flakyFailures = 1;

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/file.bin") || url.startsWith("/slow.bin") || url.startsWith("/rarcancel.bin") || url.startsWith("/flaky.bin")) {
      if (url.startsWith("/flaky.bin") && flakyFailures > 0) {
        flakyFailures -= 1;
        res.statusCode = 503;
        res.end("retry");
        return;
      }

      const range = req.headers.range;
      let start = 0;
      if (range) {
        const match = String(range).match(/bytes=(\d+)-/i);
        if (match) {
          start = Number(match[1]);
        }
      }
      const chunk = binary.subarray(start);
      if (start > 0) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${binary.length - 1}/${binary.length}`);
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", chunk.length);
      res.statusCode = res.statusCode || 200;

      if (url.startsWith("/slow.bin") || url.startsWith("/rarcancel.bin")) {
        const mid = Math.floor(chunk.length / 2);
        res.write(chunk.subarray(0, mid));
        setTimeout(() => {
          res.end(chunk.subarray(mid));
        }, 400);
        return;
      }
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
    throw new Error("Server konnte nicht gestartet werden");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/unrestrict/link")) {
      const body = init?.body;
      const params = body instanceof URLSearchParams ? body : new URLSearchParams(String(body || ""));
      const link = params.get("link") || "";
      const filename = link.includes("rarcancel") ? "release.part1.rar" : "file.bin";
      const direct = link.includes("slow")
        ? `${baseUrl}/slow.bin`
        : link.includes("rarcancel")
          ? `${baseUrl}/rarcancel.bin`
          : link.includes("flaky")
            ? `${baseUrl}/flaky.bin`
            : `${baseUrl}/file.bin`;
      return new Response(
        JSON.stringify({
          download: direct,
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

  try {
    const manager1 = await runDownloadCase(tempRoot, baseUrl, "https://dummy/file");
    const snapshot1 = manager1.getSnapshot();
    const item1 = Object.values(snapshot1.session.items)[0];
    assert(item1?.status === "completed", "normaler Download wurde nicht abgeschlossen");
    assert(fs.existsSync(item1.targetPath), "Datei fehlt nach Download");

    const manager2 = new DownloadManager(
      {
        ...defaultSettings(),
        token: "demo-token",
        outputDir: path.join(tempRoot, "downloads-pause"),
        extractDir: path.join(tempRoot, "extract-pause"),
        autoExtract: false,
        autoReconnect: false
      },
      emptySession(),
      createStoragePaths(path.join(tempRoot, "state-pause"))
    );
    manager2.addPackages([{ name: "pause", links: ["https://dummy/slow"] }]);
    manager2.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const paused = manager2.togglePause();
    assert(paused, "Pause konnte nicht aktiviert werden");
    await new Promise((resolve) => setTimeout(resolve, 150));
    manager2.togglePause();
    await waitFor(() => !manager2.getSnapshot().session.running, 30000);
    const item2 = Object.values(manager2.getSnapshot().session.items)[0];
    assert(item2?.status === "completed", "Pause/Resume Download nicht abgeschlossen");

    const manager3 = await runDownloadCase(tempRoot, baseUrl, "https://dummy/flaky", { autoReconnect: true, reconnectWaitSeconds: 1 });
    const item3 = Object.values(manager3.getSnapshot().session.items)[0];
    assert(item3?.status === "completed", "Reconnect-Fall nicht abgeschlossen");

    const manager4 = new DownloadManager(
      {
        ...defaultSettings(),
        token: "demo-token",
        outputDir: path.join(tempRoot, "downloads-cancel"),
        extractDir: path.join(tempRoot, "extract-cancel"),
        autoExtract: false
      },
      emptySession(),
      createStoragePaths(path.join(tempRoot, "state-cancel"))
    );
    manager4.addPackages([{ name: "cancel", links: ["https://dummy/rarcancel"] }]);
    manager4.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pkgId = manager4.getSnapshot().session.packageOrder[0];
    manager4.cancelPackage(pkgId);
    await waitFor(() => !manager4.getSnapshot().session.running || Object.values(manager4.getSnapshot().session.items).every((item) => item.status !== "downloading"), 15000);
    const cancelSnapshot = manager4.getSnapshot();
    const remainingItems = Object.values(cancelSnapshot.session.items);
    if (remainingItems.length === 0) {
      assert(cancelSnapshot.session.packageOrder.length === 0, "Abgebrochenes Paket wurde nicht entfernt");
    } else {
      const cancelItem = remainingItems[0];
      assert(cancelItem?.status === "cancelled" || cancelItem?.status === "queued", "Paketabbruch nicht wirksam");
    }
    const packageDir = path.join(path.join(tempRoot, "downloads-cancel"), "cancel");
    assert(!fs.existsSync(path.join(packageDir, "release.part1.rar")), "RAR-Artefakt wurde nicht gelöscht");

    console.log("Node self-check erfolgreich");
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main();
