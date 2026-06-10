import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DownloadManager } from "../src/main/download-manager";
import { defaultSettings } from "../src/main/constants";
import { createStoragePaths, emptySession } from "../src/main/storage";
import { shutdownItemLogs } from "../src/main/item-log";
import { shutdownPackageLogs } from "../src/main/package-log";
import { shutdownRenameLog } from "../src/main/rename-log";

const tempDirs: string[] = [];

afterEach(() => {
  shutdownItemLogs();
  shutdownPackageLogs();
  shutdownRenameLog();
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const DL_MKV = "Show.S01E01.German.DL.720p.x264.mkv";
const PLAIN_MKV = "Show.S01E02.German.720p.x264.mkv";
const DL_AVI = "Show.S01E03.German.DL.avi";

function setup(keepGermanAudioOnly: boolean): { extractDir: string; libraryDir: string; manager: DownloadManager; pkg: any } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-race-"));
  tempDirs.push(root);
  const extractDir = path.join(root, "extract");
  const stateDir = path.join(root, "state");
  const libraryDir = path.join(root, "library");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const manager = new DownloadManager(
    {
      ...defaultSettings(),
      token: "rd-token",
      autoExtract: true,
      collectMkvToLibrary: true,
      keepGermanAudioOnly,
      germanAudioMode: "tag",
      autoRename4sf4sj: false,
      outputDir: path.join(root, "out"),
      extractDir,
      mkvLibraryDir: libraryDir
    },
    emptySession(),
    createStoragePaths(stateDir)
  );
  const pkg: any = {
    id: "race-pkg-1",
    name: "Show.S01.GERMAN.DL.720p",
    outputDir: path.join(root, "out", "Show.S01"),
    extractDir,
    status: "completed",
    itemIds: [],
    cancelled: false,
    enabled: true,
    priority: "normal",
    createdAt: 0,
    updatedAt: 0
  };
  for (const f of [DL_MKV, PLAIN_MKV, DL_AVI]) {
    fs.writeFileSync(path.join(extractDir, f), "x");
  }
  return { extractDir, libraryDir, manager, pkg };
}

function libraryNames(libraryDir: string): string[] {
  try { return fs.readdirSync(libraryDir); } catch { return []; }
}

describe("Hybrid-Sammel Race-Schutz (.DL. noch nicht tonspur-bereinigt)", () => {
  it("haelt eine remuxbare .DL.-Datei im Hybrid-Lauf zurueck (keepGermanAudioOnly an)", async () => {
    const { extractDir, libraryDir, manager, pkg } = setup(true);

    await (manager as any).collectMkvFilesToLibrary(pkg.id, pkg, undefined, true);

    // Race-Opfer bleibt in extractDir, damit eine spaetere Runde / der Deferred-Pass es bereinigt
    expect(fs.existsSync(path.join(extractDir, DL_MKV))).toBe(true);
    expect(libraryNames(libraryDir)).not.toContain(DL_MKV);

    // Praezision: bereits bereinigte mkv (kein .DL.) wird gesammelt
    expect(fs.existsSync(path.join(extractDir, PLAIN_MKV))).toBe(false);
    // Praezision: .DL.avi ist nicht remuxbar -> wird NICHT zurueckgehalten, sondern gesammelt
    expect(fs.existsSync(path.join(extractDir, DL_AVI))).toBe(false);
  });

  it("sammelt die remuxbare .DL.-Datei im Deferred-Lauf (deferFreshFiles=false)", async () => {
    const { extractDir, libraryDir, manager, pkg } = setup(true);

    await (manager as any).collectMkvFilesToLibrary(pkg.id, pkg, undefined, false);

    expect(fs.existsSync(path.join(extractDir, DL_MKV))).toBe(false);
    expect(libraryNames(libraryDir)).toContain(DL_MKV);
  });

  it("haelt nichts zurueck wenn keepGermanAudioOnly aus ist (.DL. ist dann normaler Output)", async () => {
    const { extractDir, manager, pkg } = setup(false);

    await (manager as any).collectMkvFilesToLibrary(pkg.id, pkg, undefined, true);

    expect(fs.existsSync(path.join(extractDir, DL_MKV))).toBe(false);
  });
});
