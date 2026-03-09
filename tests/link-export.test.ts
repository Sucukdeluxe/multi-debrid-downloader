import { describe, expect, it } from "vitest";
import { buildLinkExportSelection, serializeLinkExportText } from "../src/main/link-export";
import { parseCollectorInput } from "../src/main/link-parser";
import type { UiSnapshot } from "../src/shared/types";

function buildSnapshot(): UiSnapshot {
  return {
    settings: {} as UiSnapshot["settings"],
    session: {
      version: 1,
      packageOrder: ["pkg-1", "pkg-2"],
      packages: {
        "pkg-1": {
          id: "pkg-1",
          name: "Dave Staffel 1",
          outputDir: "C:\\Downloads\\Dave Staffel 1",
          extractDir: "C:\\Extract\\Dave Staffel 1",
          status: "queued",
          itemIds: ["item-1", "item-2"],
          cancelled: false,
          enabled: true,
          priority: "normal",
          createdAt: 1,
          updatedAt: 1
        },
        "pkg-2": {
          id: "pkg-2",
          name: "Andere Staffel",
          outputDir: "C:\\Downloads\\Andere Staffel",
          extractDir: "C:\\Extract\\Andere Staffel",
          status: "queued",
          itemIds: ["item-3"],
          cancelled: false,
          enabled: true,
          priority: "normal",
          createdAt: 1,
          updatedAt: 1
        }
      },
      items: {
        "item-1": {
          id: "item-1",
          packageId: "pkg-1",
          url: "https://example.com/e01",
          provider: null,
          status: "queued",
          retries: 0,
          speedBps: 0,
          downloadedBytes: 0,
          totalBytes: null,
          progressPercent: 0,
          fileName: "Dave.S01E01.rar",
          targetPath: "",
          resumable: true,
          attempts: 0,
          lastError: "",
          fullStatus: "Wartet",
          createdAt: 1,
          updatedAt: 1
        },
        "item-2": {
          id: "item-2",
          packageId: "pkg-1",
          url: "https://example.com/e02",
          provider: null,
          status: "queued",
          retries: 0,
          speedBps: 0,
          downloadedBytes: 0,
          totalBytes: null,
          progressPercent: 0,
          fileName: "Dave.S01E02.rar",
          targetPath: "",
          resumable: true,
          attempts: 0,
          lastError: "",
          fullStatus: "Wartet",
          createdAt: 1,
          updatedAt: 1
        },
        "item-3": {
          id: "item-3",
          packageId: "pkg-2",
          url: "https://example.com/other",
          provider: null,
          status: "queued",
          retries: 0,
          speedBps: 0,
          downloadedBytes: 0,
          totalBytes: null,
          progressPercent: 0,
          fileName: "Andere.S01E01.rar",
          targetPath: "",
          resumable: true,
          attempts: 0,
          lastError: "",
          fullStatus: "Wartet",
          createdAt: 1,
          updatedAt: 1
        }
      },
      runStartedAt: 0,
      totalDownloadedBytes: 0,
      summaryText: "",
      reconnectUntil: 0,
      reconnectReason: "",
      paused: false,
      running: false,
      updatedAt: 1
    },
    summary: null,
    stats: {
      totalDownloaded: 0,
      totalDownloadedAllTime: 0,
      totalFilesSession: 0,
      totalFilesAllTime: 0,
      totalPackages: 2,
      sessionStartedAt: 0
    },
    speedText: "",
    etaText: "",
    canStart: true,
    canStop: false,
    canPause: false,
    clipboardActive: false,
    reconnectSeconds: 0,
    packageSpeedBps: {}
  };
}

describe("link-export", () => {
  it("keeps original package names when exporting selected items", () => {
    const selection = buildLinkExportSelection(buildSnapshot(), [], ["item-1", "item-3"]);
    expect(selection.packageCount).toBe(2);
    expect(selection.linkCount).toBe(2);
    expect(selection.packages.map((pkg) => pkg.name)).toEqual(["Dave Staffel 1", "Andere Staffel"]);
  });

  it("roundtrips exported text back into parsed package inputs", () => {
    const selection = buildLinkExportSelection(buildSnapshot(), [], ["item-1", "item-2"]);
    const text = serializeLinkExportText(selection.packages);
    const reparsed = parseCollectorInput(text, "");

    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.name).toBe("Dave Staffel 1");
    expect(reparsed[0]?.links).toEqual(["https://example.com/e01", "https://example.com/e02"]);
    expect(reparsed[0]?.fileNames).toEqual(["Dave.S01E01.rar", "Dave.S01E02.rar"]);
  });
});
