import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import {
  startDebugServer,
  stopDebugServer,
  restartDebugServer,
  writeDebugServerConfig,
  getDebugServerRuntimeStatus,
  evaluateClientAllowed,
  getPeerIp
} from "../src/main/debug-server";
import type { DownloadManager } from "../src/main/download-manager";

const tempDirs: string[] = [];
const TOKEN = "allowlist-secret";

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

async function startWithAllowlist(allowlist: string[], host = "0.0.0.0"): Promise<{ baseUrl: string }> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-allow-"));
  tempDirs.push(baseDir);
  const port = await getFreePort();
  fs.writeFileSync(path.join(baseDir, "debug_token.txt"), TOKEN, "utf8");
  fs.writeFileSync(path.join(baseDir, "debug_port.txt"), String(port), "utf8");
  fs.writeFileSync(path.join(baseDir, "debug_host.txt"), host, "utf8");
  fs.writeFileSync(path.join(baseDir, "debug_allowlist.txt"), allowlist.join("\n"), "utf8");
  const manager = {} as unknown as DownloadManager;
  startDebugServer(manager, baseDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/health?token=${TOKEN}`);
  return { baseUrl };
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

describe("debug-server allowlist matcher (pure)", () => {
  it("always allows loopback regardless of rules", () => {
    expect(evaluateClientAllowed("127.0.0.1", [])).toBe(true);
    expect(evaluateClientAllowed("::1", [])).toBe(true);
    expect(evaluateClientAllowed("::ffff:127.0.0.1", ["8.8.8.8"])).toBe(true);
  });

  it("matches an exact allowlisted IP and rejects others", () => {
    expect(evaluateClientAllowed("8.8.8.8", ["8.8.8.8"])).toBe(true);
    expect(evaluateClientAllowed("9.9.9.9", ["8.8.8.8"])).toBe(false);
  });

  it("matches inside a CIDR and rejects outside it", () => {
    expect(evaluateClientAllowed("10.0.0.42", ["10.0.0.0/24"])).toBe(true);
    expect(evaluateClientAllowed("10.0.1.42", ["10.0.0.0/24"])).toBe(false);
  });

  it("fail-closed: empty rules reject every non-loopback client", () => {
    expect(evaluateClientAllowed("203.0.113.7", [])).toBe(false);
    expect(evaluateClientAllowed("8.8.8.8", [])).toBe(false);
  });

  it("derives the client IP from the socket peer, never from X-Forwarded-For", () => {
    const forgedLoopback = {
      socket: { remoteAddress: "8.8.8.8" },
      headers: { "x-forwarded-for": "127.0.0.1" }
    } as unknown as http.IncomingMessage;
    expect(getPeerIp(forgedLoopback)).toBe("8.8.8.8");
    expect(evaluateClientAllowed(getPeerIp(forgedLoopback), [])).toBe(false);
    expect(evaluateClientAllowed(getPeerIp(forgedLoopback), ["9.9.9.9"])).toBe(false);
    expect(evaluateClientAllowed(getPeerIp(forgedLoopback), ["8.8.8.8"])).toBe(true);

    const ipv6Mapped = {
      socket: { remoteAddress: "::ffff:10.0.0.5" },
      headers: {}
    } as unknown as http.IncomingMessage;
    expect(getPeerIp(ipv6Mapped)).toBe("10.0.0.5");
  });
});

describe("debug-server allowlist enforcement (wired)", () => {
  it("allows a loopback connection and ignores a spoofed X-Forwarded-For", async () => {
    const { baseUrl } = await startWithAllowlist(["8.8.8.8"]);
    const plain = await fetch(`${baseUrl}/health?token=${TOKEN}`);
    expect(plain.status).toBe(200);
    const spoofed = await fetch(`${baseUrl}/health?token=${TOKEN}`, {
      headers: { "X-Forwarded-For": "203.0.113.9" }
    });
    expect(spoofed.status).toBe(200);
  });

  it("still enforces the token for loopback clients", async () => {
    const { baseUrl } = await startWithAllowlist(["8.8.8.8"]);
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  it("reloads the allowlist live via restartDebugServer", async () => {
    const { baseUrl } = await startWithAllowlist(["8.8.8.8"]);
    expect(getDebugServerRuntimeStatus().allowlistCount).toBe(1);
    writeDebugServerConfig({ allowlist: ["9.9.9.9", "10.0.0.0/24"] });
    const status = await restartDebugServer();
    expect(status.running).toBe(true);
    expect(status.allowlistCount).toBe(2);
    await waitForReady(`${baseUrl}/health?token=${TOKEN}`);
    expect((await fetch(`${baseUrl}/health?token=${TOKEN}`)).status).toBe(200);
  });
});
