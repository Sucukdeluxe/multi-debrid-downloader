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
  it("rejects oversized DLC files before network access", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-dlc-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "oversized.dlc");
    fs.writeFileSync(filePath, Buffer.alloc((8 * 1024 * 1024) + 1, 1));

    const fetchSpy = vi.fn(async () => new Response("should-not-run", { status: 500 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(importDlcContainers([filePath])).rejects.toThrow(/zu groß/i);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
