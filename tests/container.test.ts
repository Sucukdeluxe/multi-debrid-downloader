import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importDlcContainers } from "../src/main/container";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("container", () => {
  it("skips oversized DLC files without throwing and blocking other files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const oversizedFilePath = path.join(dir, "oversized.dlc");
    fs.writeFileSync(oversizedFilePath, Buffer.alloc((8 * 1024 * 1024) + 1, 1));

    const validFilePath = path.join(dir, "valid.dlc");
    fs.writeFileSync(validFilePath, Buffer.from("Valid but not real DLC content..."));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("http://example.com/file1.rar\nhttp://example.com/file2.rar", { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await importDlcContainers([oversizedFilePath, validFilePath]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid");
    expect(result[0].links).toEqual(["http://example.com/file1.rar", "http://example.com/file2.rar"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips non-dlc files completely", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-non-"));
    tempDirs.push(dir);
    const txtPath = path.join(dir, "links.txt");
    fs.writeFileSync(txtPath, "http://link.com/1");

    const result = await importDlcContainers([txtPath]);
    expect(result).toEqual([]);
  });

  it("falls back to dcrypt if local decryption returns empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "fallback.dlc");

    fs.writeFileSync(filePath, Buffer.alloc(100, 1).toString("base64"));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("service.jdownloader.org")) {
        return new Response("", { status: 404 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("http://fallback.com/1", { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await importDlcContainers([filePath]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("fallback");
    expect(result[0].links).toEqual(["http://fallback.com/1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to dcrypt when local decryption throws invalid padding", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "invalid-local.dlc");
    fs.writeFileSync(filePath, "X".repeat(120));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("service.jdownloader.org")) {
        return new Response(`<rc>${Buffer.alloc(16).toString("base64")}</rc>`, { status: 200 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("http://example.com/fallback1", { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await importDlcContainers([filePath]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("invalid-local");
    expect(result[0].links).toEqual(["http://example.com/fallback1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to paste endpoint when upload returns 413", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "big-dlc.dlc");
    fs.writeFileSync(filePath, Buffer.alloc(100, 1).toString("base64"));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("service.jdownloader.org")) {
        return new Response("", { status: 404 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("Request Entity Too Large", { status: 413 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/paste")) {
        return new Response("http://paste-fallback.com/file1.rar\nhttp://paste-fallback.com/file2.rar", { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await importDlcContainers([filePath]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("big-dlc");
    expect(result[0].links).toEqual(["http://paste-fallback.com/file1.rar", "http://paste-fallback.com/file2.rar"]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("throws when both dcrypt endpoints return 413", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "huge.dlc");
    fs.writeFileSync(filePath, Buffer.alloc(100, 1).toString("base64"));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("service.jdownloader.org")) {
        return new Response("", { status: 404 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("Request Entity Too Large", { status: 413 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/paste")) {
        return new Response("Request Entity Too Large", { status: 413 });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(importDlcContainers([filePath])).rejects.toThrow(/zu groß für dcrypt/i);
  });

  it("throws when upload returns 413 and paste returns 500", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "doomed.dlc");
    fs.writeFileSync(filePath, Buffer.from("not a valid dlc payload at all"));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("service.jdownloader.org")) {
        return new Response("", { status: 404 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("Request Entity Too Large", { status: 413 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/paste")) {
        return new Response("paste failure", { status: 500 });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(importDlcContainers([filePath])).rejects.toThrow(/DLC konnte nicht importiert werden/i);
  });

  it("throws clear error when all dlc imports fail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "broken.dlc");
    fs.writeFileSync(filePath, Buffer.from("not a valid dlc payload at all"));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("service.jdownloader.org")) {
        return new Response("", { status: 404 });
      }
      if (urlStr.includes("dcrypt.it/decrypt/upload")) {
        return new Response("upstream failure", { status: 500 });
      }
      return new Response("", { status: 500 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(importDlcContainers([filePath])).rejects.toThrow(/DLC konnte nicht importiert werden/i);
  });
});
