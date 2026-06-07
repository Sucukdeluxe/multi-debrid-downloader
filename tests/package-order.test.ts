import { describe, expect, it } from "vitest";
import type { DownloadItem, PackageEntry } from "../src/shared/types";
import { sortPackagesForDisplay } from "../src/renderer/package-order";

function createPackage(id: string, itemIds: string[]): PackageEntry {
  const now = Date.now();
  return {
    id,
    name: id,
    outputDir: "",
    extractDir: "",
    status: "queued",
    itemIds,
    cancelled: false,
    enabled: true,
    priority: "normal",
    createdAt: now,
    updatedAt: now
  };
}

function createItem(id: string, packageId: string, status: DownloadItem["status"], downloadedBytes: number): DownloadItem {
  const now = Date.now();
  return {
    id,
    packageId,
    url: `https://hoster.example/${id}`,
    provider: null,
    status,
    retries: 0,
    speedBps: 0,
    downloadedBytes,
    totalBytes: downloadedBytes,
    progressPercent: downloadedBytes > 0 ? 50 : 0,
    fileName: `${id}.bin`,
    targetPath: "",
    resumable: true,
    attempts: 0,
    lastError: "",
    fullStatus: "",
    createdAt: now,
    updatedAt: now
  };
}

describe("sortPackagesForDisplay", () => {
  it("floats active packages to the top, keeping queue order within each group", () => {
    // pkg-a and pkg-b both have an active (downloading) item -> both float up in
    // their original queue order; pkg-c (queued only) sinks below.
    const packages = [
      createPackage("pkg-a", ["a1", "a2"]),
      createPackage("pkg-c", ["c1"]),
      createPackage("pkg-b", ["b1", "b2"])
    ];
    const items: Record<string, DownloadItem> = {
      a1: createItem("a1", "pkg-a", "downloading", 250),
      a2: createItem("a2", "pkg-a", "completed", 500),
      c1: createItem("c1", "pkg-c", "queued", 0),
      b1: createItem("b1", "pkg-b", "downloading", 800),
      b2: createItem("b2", "pkg-b", "completed", 900)
    };

    const sorted = sortPackagesForDisplay(packages, items, true, true);

    // active group [pkg-a, pkg-b] in queue order, then rest [pkg-c]
    expect(sorted.map((pkg) => pkg.id)).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
  });

  it("does NOT reshuffle active packages when only their progress changes (anti-flicker)", () => {
    const packages = [
      createPackage("pkg-a", ["a1"]),
      createPackage("pkg-b", ["b1"])
    ];
    // Both active. pkg-b initially has more bytes than pkg-a.
    const before: Record<string, DownloadItem> = {
      a1: createItem("a1", "pkg-a", "downloading", 100),
      b1: createItem("b1", "pkg-b", "downloading", 900)
    };
    const orderBefore = sortPackagesForDisplay(packages, before, true, true).map((p) => p.id);

    // A progress tick: pkg-a overtakes pkg-b in bytes. Order must NOT change —
    // both are still active, so they keep queue order. (Old code swapped them.)
    const after: Record<string, DownloadItem> = {
      a1: createItem("a1", "pkg-a", "downloading", 5000),
      b1: createItem("b1", "pkg-b", "downloading", 950)
    };
    const orderAfter = sortPackagesForDisplay(packages, after, true, true).map((p) => p.id);

    expect(orderBefore).toEqual(["pkg-a", "pkg-b"]);
    expect(orderAfter).toEqual(orderBefore);
  });

  it("keeps package order untouched when auto sort is disabled", () => {
    const packages = [
      createPackage("pkg-a", ["a1"]),
      createPackage("pkg-b", ["b1"]),
      createPackage("pkg-c", ["c1"])
    ];
    const items: Record<string, DownloadItem> = {
      a1: createItem("a1", "pkg-a", "queued", 0),
      b1: createItem("b1", "pkg-b", "downloading", 500),
      c1: createItem("c1", "pkg-c", "queued", 0)
    };

    const sorted = sortPackagesForDisplay(packages, items, true, false);

    expect(sorted.map((pkg) => pkg.id)).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
  });
});
