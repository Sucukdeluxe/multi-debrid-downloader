import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock only processVideoFile (the ffmpeg boundary); keep the real pure helpers
// (stripDualLangMarker / hasDualLangMarker / isRemuxableVideoFile) so the
// download-manager's selection + .DL.-rename wiring is exercised for real.
vi.mock("../src/main/video-processor", async (importActual) => {
  const actual = await importActual<typeof import("../src/main/video-processor")>();
  return { ...actual, processVideoFile: vi.fn() };
});

import { DownloadManager } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession } from "../src/main/storage";
import { shutdownItemLogs } from "../src/main/item-log";
import { shutdownPackageLogs } from "../src/main/package-log";
import { shutdownRenameLog } from "../src/main/rename-log";
import { processVideoFile, type VideoProcessResult } from "../src/main/video-processor";

const mockedProcess = processVideoFile as unknown as ReturnType<typeof vi.fn>;
const tempDirs: string[] = [];

afterEach(() => {
  mockedProcess.mockReset();
  shutdownItemLogs();
  shutdownPackageLogs();
  shutdownRenameLog();
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function setup(keepGermanAudioOnly: boolean): { extractDir: string; manager: DownloadManager; pkg: any } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-ga-"));
  tempDirs.push(root);
  const extractDir = path.join(root, "extract");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const manager = new DownloadManager(
    {
      ...defaultSettings(),
      token: "rd-token",
      keepGermanAudioOnly,
      germanAudioMode: "tag",
      autoRename4sf4sj: false,
      outputDir: path.join(root, "out"),
      extractDir,
      mkvLibraryDir: path.join(stateDir, "_mkv")
    },
    emptySession(),
    createStoragePaths(stateDir)
  );
  const pkg: any = {
    id: "ga-pkg-1",
    name: "Test.Show.S01.GERMAN.DL.720p",
    outputDir: path.join(root, "out", "Test.Show"),
    extractDir,
    status: "completed",
    itemIds: [],
    cancelled: false,
    enabled: true,
    priority: "normal",
    createdAt: 0,
    updatedAt: 0
  };
  return { extractDir, manager, pkg };
}

const DL_MKV = "Show.S01E01.German.DL.720p.x264.mkv";
const PLAIN_MKV = "Show.S01E02.German.1080p.x264.mkv";
const SAMPLE_DL = "Show.sample.DL.mkv";
const DL_AVI = "Show.S01E03.German.DL.avi";

function stage(extractDir: string): void {
  for (const f of [DL_MKV, PLAIN_MKV, SAMPLE_DL, DL_AVI]) {
    fs.writeFileSync(path.join(extractDir, f), "x");
  }
}

describe("keepGermanAudioOnly integration", () => {
  it("processes only .DL. mkv/mp4 and strips .DL. after a successful remux", async () => {
    const { extractDir, manager, pkg } = setup(true);
    stage(extractDir);
    mockedProcess.mockResolvedValue({ action: "remuxed", reason: "german-tag", totalAudioTracks: 2, keptTrackIndex: 0 } as VideoProcessResult);

    const n = await (manager as any).keepGermanAudioOnlyImpl(extractDir, pkg);

    expect(mockedProcess).toHaveBeenCalledTimes(1);
    expect(mockedProcess.mock.calls[0][0]).toBe(path.join(extractDir, DL_MKV));
    expect(n).toBe(1);

    const files = fs.readdirSync(extractDir);
    expect(files).toContain("Show.S01E01.German.720p.x264.mkv"); // .DL. stripped
    expect(files).not.toContain(DL_MKV);
    expect(files).toContain(PLAIN_MKV); // non-.DL. untouched
    expect(files).toContain(SAMPLE_DL); // sample skipped
    expect(files).toContain(DL_AVI); // avi not remuxable, skipped
  });

  it("does nothing when the setting is off", async () => {
    const { extractDir, manager, pkg } = setup(false);
    stage(extractDir);
    const n = await (manager as any).keepGermanAudioOnlyImpl(extractDir, pkg);
    expect(n).toBe(0);
    expect(mockedProcess).not.toHaveBeenCalled();
    expect(fs.readdirSync(extractDir)).toContain(DL_MKV); // untouched
  });

  it("leaves the file fully untouched (name included) when no German track is found", async () => {
    const { extractDir, manager, pkg } = setup(true);
    stage(extractDir);
    mockedProcess.mockResolvedValue({ action: "skipped-no-german", reason: "no-german-track", totalAudioTracks: 2 } as VideoProcessResult);

    await (manager as any).keepGermanAudioOnlyImpl(extractDir, pkg);

    expect(mockedProcess).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(extractDir)).toContain(DL_MKV); // NOT renamed -> stays visible as unprocessed
  });

  it("still strips .DL. for a single-audio file (no remux needed)", async () => {
    const { extractDir, manager, pkg } = setup(true);
    stage(extractDir);
    mockedProcess.mockResolvedValue({ action: "kept-single", reason: "single-german", totalAudioTracks: 1, keptTrackIndex: 0 } as VideoProcessResult);

    const n = await (manager as any).keepGermanAudioOnlyImpl(extractDir, pkg);

    expect(n).toBe(0); // not counted as a remux
    expect(fs.readdirSync(extractDir)).toContain("Show.S01E01.German.720p.x264.mkv");
  });

  it("stops the run and leaves files untouched when ffmpeg is missing", async () => {
    const { extractDir, manager, pkg } = setup(true);
    stage(extractDir);
    mockedProcess.mockResolvedValue({ action: "skipped-no-tool", reason: "ffmpeg/ffprobe nicht gefunden" } as VideoProcessResult);

    const n = await (manager as any).keepGermanAudioOnlyImpl(extractDir, pkg);

    expect(n).toBe(0);
    expect(fs.readdirSync(extractDir)).toContain(DL_MKV); // untouched
  });
});
