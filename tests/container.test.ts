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
    
    // Create a valid mockup DLC that would be skipped if an error was thrown
    const validFilePath = path.join(dir, "valid.dlc");
    // Just needs to be short enough to pass file limits but fail parsing, triggering dcrypt fallback
    fs.writeFileSync(validFilePath, Buffer.from("Valid but not real DLC content..."));

    const fetchSpy = vi.fn(async () => {
      // Mock dcrypt response for valid.dlc
      return new Response("http://example.com/file1.rar\nhttp://example.com/file2.rar", { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await importDlcContainers([oversizedFilePath, validFilePath]);
    
    // Expect the oversized to be silently skipped, and valid to be parsed into 2 packages (one per link name)
    expect(result).toHaveLength(2);
    expect(result[0].links).toEqual(["http://example.com/file1.rar"]);
    expect(result[1].links).toEqual(["http://example.com/file2.rar"]);
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
    
    // A file large enough to trigger local decryption attempt (needs > 89 bytes to pass the slice check)
    fs.writeFileSync(filePath, Buffer.alloc(100, 1).toString("base64"));

    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("rc")) {
        // Mock local RC service failure (returning 404 or empty string)
        return new Response("", { status: 404 });
      } else {
        // Mock dcrypt fallback success
        return new Response("http://fallback.com/1", { status: 200 });
      }
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await importDlcContainers([filePath]);
    expect(result).toHaveLength(1);
    expect(result[0].links).toEqual(["http://fallback.com/1"]);
    // Should have tried both!
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
