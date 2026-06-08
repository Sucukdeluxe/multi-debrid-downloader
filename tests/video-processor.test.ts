import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stripDualLangMarker,
  hasDualLangMarker,
  isRemuxableVideoFile,
  looksLikeGermanRelease,
  pickAudioTrack,
  parseFfprobeAudioStreams,
  buildFfprobeArgs,
  buildFfmpegRemuxArgs,
  computeRemuxTimeoutMs,
  processVideoFile,
  renameWithRetry,
  type VideoSpawnResult
} from "../src/main/video-processor";

describe("stripDualLangMarker", () => {
  it("strips a mid-name .DL. token", () => {
    expect(stripDualLangMarker("Show.S01E01.German.DL.720p.WEB.x264.mkv")).toBe("Show.S01E01.German.720p.WEB.x264.mkv");
  });
  it("strips a .DL. directly before the extension", () => {
    expect(stripDualLangMarker("Movie.DL.mkv")).toBe("Movie.mkv");
  });
  it("strips a trailing .DL token before extension", () => {
    expect(stripDualLangMarker("Movie.German.DL.mp4")).toBe("Movie.German.mp4");
  });
  it("is case-insensitive", () => {
    expect(stripDualLangMarker("Show.dl.1080p.mkv")).toBe("Show.1080p.mkv");
  });
  it("leaves files without the marker unchanged", () => {
    expect(stripDualLangMarker("Show.S01E01.German.1080p.mkv")).toBe("Show.S01E01.German.1080p.mkv");
  });
  it("does not strip unrelated tokens containing DL", () => {
    expect(stripDualLangMarker("Show.HANDLES.1080p.mkv")).toBe("Show.HANDLES.1080p.mkv");
  });
});

describe("hasDualLangMarker", () => {
  it("detects the marker", () => {
    expect(hasDualLangMarker("X.German.DL.720p.mkv")).toBe(true);
    expect(hasDualLangMarker("X.DL.mkv")).toBe(true);
  });
  it("returns false without the marker", () => {
    expect(hasDualLangMarker("X.German.720p.mkv")).toBe(false);
  });
});

describe("isRemuxableVideoFile", () => {
  it("accepts mkv/mp4 only", () => {
    expect(isRemuxableVideoFile("a.mkv")).toBe(true);
    expect(isRemuxableVideoFile("a.MP4")).toBe(true);
    expect(isRemuxableVideoFile("a.avi")).toBe(false);
    expect(isRemuxableVideoFile("a.srt")).toBe(false);
  });
});

describe("pickAudioTrack", () => {
  const ger = { language: "ger", title: "" };
  const eng = { language: "eng", title: "" };
  const untagged = { language: "", title: "" };

  it("no audio -> skip", () => {
    expect(pickAudioTrack([], "tag").action).toBe("skip");
  });

  it("first mode keeps first of many", () => {
    const d = pickAudioTrack([eng, ger], "first");
    expect(d).toMatchObject({ action: "remux", audioRelIndex: 0 });
  });

  it("first mode with single audio -> single (no remux)", () => {
    expect(pickAudioTrack([eng], "first")).toMatchObject({ action: "single" });
  });

  it("tag mode picks the German track even if not first", () => {
    const d = pickAudioTrack([eng, ger], "tag");
    expect(d).toMatchObject({ action: "remux", audioRelIndex: 1, reason: "german-tag" });
  });

  it("tag mode picks German via title when language untagged", () => {
    const d = pickAudioTrack([{ language: "", title: "Englisch" }, { language: "", title: "Deutsch" }], "tag");
    expect(d).toMatchObject({ action: "remux", audioRelIndex: 1 });
  });

  it("tag mode does NOT treat an ambiguous 3-letter title code as German (no false-positive pick)", () => {
    // Two untagged tracks whose titles are only "Ger"/"Deu" must not be mistaken
    // for a German track; with no real German signal this falls back to first.
    const d = pickAudioTrack([{ language: "", title: "Ger" }, { language: "", title: "Deu" }], "tag");
    expect(d).toMatchObject({ action: "remux", audioRelIndex: 0, reason: "fallback-first-untagged" });
  });

  it("tag mode with single German -> single (no remux)", () => {
    expect(pickAudioTrack([ger], "tag")).toMatchObject({ action: "single" });
  });

  it("tag mode, fully untagged multi -> fallback to first", () => {
    const d = pickAudioTrack([untagged, untagged], "tag");
    expect(d).toMatchObject({ action: "remux", audioRelIndex: 0, reason: "fallback-first-untagged" });
  });

  it("tag mode, tagged but no German -> SKIP (never delete the only usable audio)", () => {
    expect(pickAudioTrack([eng, { language: "fre", title: "" }], "tag")).toMatchObject({ action: "skip", reason: "no-german-track" });
  });

  it("tag mode, no German tag but GERMAN release -> fall back to first track (mislabeled dub)", () => {
    expect(pickAudioTrack([eng, eng], "tag", true)).toMatchObject({ action: "remux", audioRelIndex: 0, reason: "fallback-first-german-release" });
  });

  it("tag mode, single mislabeled track on a German release -> keep it (no remux)", () => {
    expect(pickAudioTrack([eng], "tag", true)).toMatchObject({ action: "single", reason: "single-german-mislabeled" });
  });

  it("tag mode, no German tag and NOT flagged German -> still SKIP (safety preserved)", () => {
    expect(pickAudioTrack([eng, eng], "tag", false)).toMatchObject({ action: "skip", reason: "no-german-track" });
  });

  it("correctly tagged German still wins even on a German release (fallback not needed)", () => {
    expect(pickAudioTrack([eng, ger], "tag", true)).toMatchObject({ action: "remux", audioRelIndex: 1, reason: "german-tag" });
  });
});

describe("looksLikeGermanRelease", () => {
  it("detects German/Dubbed release names", () => {
    expect(looksLikeGermanRelease("Desperate.Housewives.S02E01.German.DD51.Dubbed.DL.720p.WEB-DL.x264.mkv")).toBe(true);
    expect(looksLikeGermanRelease("1899.S01E01.German.DL.720p.WEB-x264-WvF.mkv")).toBe(true);
    expect(looksLikeGermanRelease("Show.S01E01.Deutsch.1080p.mkv")).toBe(true);
  });
  it("does not flag a bare .DL. name without an explicit German token", () => {
    expect(looksLikeGermanRelease("Show.S01E01.DL.720p.x264.mkv")).toBe(false);
    expect(looksLikeGermanRelease("Show.S01E01.MULTi.1080p.mkv")).toBe(false);
  });
  it("does not flag a non-German dub as a German release (bare 'Dubbed' is ambiguous)", () => {
    expect(looksLikeGermanRelease("Movie.2020.ITALIAN.Dubbed.DL.1080p.mkv")).toBe(false);
    expect(looksLikeGermanRelease("Movie.2020.FRENCH.DUBBED.DL.720p.mkv")).toBe(false);
  });
});

describe("parseFfprobeAudioStreams", () => {
  it("parses language/title tags", () => {
    const json = JSON.stringify({ streams: [{ index: 1, tags: { language: "ger", title: "Deutsch" } }, { index: 2, tags: { language: "eng" } }] });
    expect(parseFfprobeAudioStreams(json)).toEqual([{ language: "ger", title: "Deutsch" }, { language: "eng", title: "" }]);
  });
  it("returns [] on invalid json", () => {
    expect(parseFfprobeAudioStreams("not json")).toEqual([]);
  });
  it("returns [] when streams missing", () => {
    expect(parseFfprobeAudioStreams("{}")).toEqual([]);
  });
});

describe("buildFfprobeArgs", () => {
  it("requests audio streams as json", () => {
    const args = buildFfprobeArgs("in.mkv");
    expect(args).toContain("-select_streams");
    expect(args).toContain("a");
    expect(args[args.length - 1]).toBe("in.mkv");
    expect(args).toContain("json");
  });
});

describe("buildFfmpegRemuxArgs", () => {
  it("maps video + chosen audio, stream-copy, keeps metadata (language tag), no subs by default", () => {
    const args = buildFfmpegRemuxArgs({ input: "in.mkv", output: "out.mkv", audioRelIndex: 1 });
    expect(args).toEqual([
      "-i", "in.mkv", "-map", "0:v:0", "-map", "0:a:1",
      "-c", "copy", "-disposition:a:0", "default", "-y", "out.mkv"
    ]);
    expect(args).not.toContain("-map_metadata"); // language tag of kept track must survive
  });
  it("adds optional German subtitle maps when keepSubs", () => {
    const args = buildFfmpegRemuxArgs({ input: "in.mkv", output: "out.mkv", audioRelIndex: 0, keepSubs: true });
    expect(args.join(" ")).toContain("0:s:m:language:ger?");
  });
});

describe("computeRemuxTimeoutMs", () => {
  it("has a floor", () => {
    expect(computeRemuxTimeoutMs(0)).toBe(120_000);
  });
  it("scales with size and caps at 60 min", () => {
    expect(computeRemuxTimeoutMs(50 * 1024 * 1024 * 1024)).toBe(60 * 60 * 1000);
  });
});

// Exercises the REAL file-mutating body (temp -> replace -> utimes -> rm) with a
// fake ffmpeg/ffprobe runner. This is the irreversible-overwrite path that the
// download-manager integration test (which mocks processVideoFile wholesale)
// cannot cover.
describe("processVideoFile (real fs body, fake runner)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeFile(content: string, name = "Show.S01E01.German.DL.720p.mkv"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-vp-"));
    tempDirs.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  function fakeRunner(opts: { probeJson: string; ffmpegOk?: boolean }): typeof import("../src/main/video-processor").runVideoProcess {
    return async (_command: string, args: string[]): Promise<VideoSpawnResult> => {
      const base = { aborted: false, timedOut: false, missing: false } as const;
      if (args.includes("-show_entries")) {
        return { ...base, ok: true, exitCode: 0, stdout: opts.probeJson, stderr: "" };
      }
      const output = args[args.length - 1];
      if (opts.ffmpegOk !== false) {
        fs.writeFileSync(output, "REMUXED-GERMAN-ONLY");
        return { ...base, ok: true, exitCode: 0, stdout: "", stderr: "" };
      }
      return { ...base, ok: false, exitCode: 1, stdout: "", stderr: "ffmpeg boom" };
    };
  }

  // Any sidecar the replace machinery may leave behind (unique "~rd…" temp names).
  function leftoverTemps(file: string): string[] {
    return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith("~rd"));
  }

  const tooling = async (): Promise<{ ffmpeg: string; ffprobe: string }> => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
  const twoTracksGerSecond = JSON.stringify({ streams: [{ tags: { language: "eng" } }, { tags: { language: "ger" } }] });

  it("replaces the original in place and preserves mtime on success", async () => {
    const file = makeFile("ORIGINAL");
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(file, oldTime, oldTime);
    const beforeMtime = fs.statSync(file).mtimeMs;

    const result = await processVideoFile(file, { mode: "tag" }, {
      resolveTooling: tooling,
      runProcess: fakeRunner({ probeJson: twoTracksGerSecond })
    });

    expect(result.action).toBe("remuxed");
    expect(result.keptTrackIndex).toBe(1); // German was second
    expect(fs.readFileSync(file, "utf8")).toBe("REMUXED-GERMAN-ONLY"); // original overwritten
    expect(Math.abs(fs.statSync(file).mtimeMs - beforeMtime)).toBeLessThan(1500); // mtime preserved
    expect(leftoverTemps(file)).toEqual([]); // unique temp cleaned up
  });

  it("leaves the original intact and removes temp when ffmpeg fails", async () => {
    const file = makeFile("ORIGINAL");
    const result = await processVideoFile(file, { mode: "tag" }, {
      resolveTooling: tooling,
      runProcess: fakeRunner({ probeJson: twoTracksGerSecond, ffmpegOk: false })
    });

    expect(result.action).toBe("error");
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL"); // never lost
    expect(leftoverTemps(file)).toEqual([]);
  });

  it("keeps the original intact and cleans the temp when the atomic replace rename fails (no zero-copy window)", async () => {
    // Simulate a Windows file lock that defeats the replace even after retries.
    // The original must survive: the old rm-then-rename fallback could leave the
    // file with NEITHER the original nor the remux on disk.
    const file = makeFile("ORIGINAL");
    const result = await processVideoFile(file, { mode: "tag" }, {
      resolveTooling: tooling,
      runProcess: fakeRunner({ probeJson: twoTracksGerSecond }),
      rename: async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); }
    });

    expect(result.action).toBe("error");
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL"); // original never destroyed
    expect(leftoverTemps(file)).toEqual([]); // remux temp removed
  });

  it("does not touch a single-audio file (no remux)", async () => {
    const file = makeFile("ORIGINAL");
    const result = await processVideoFile(file, { mode: "tag" }, {
      resolveTooling: tooling,
      runProcess: fakeRunner({ probeJson: JSON.stringify({ streams: [{ tags: { language: "ger" } }] }) })
    });
    expect(result.action).toBe("kept-single");
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL");
  });

  it("remuxes a German-named release with MISLABELED audio tags (fallback to first track)", async () => {
    // Name says German, but both audio tracks are tagged eng/fre (the dub is
    // mislabeled). The fallback keeps the first track instead of skipping.
    const file = makeFile("ORIGINAL"); // name contains "German"
    const result = await processVideoFile(file, { mode: "tag" }, {
      resolveTooling: tooling,
      runProcess: fakeRunner({ probeJson: JSON.stringify({ streams: [{ tags: { language: "eng" } }, { tags: { language: "fre" } }] }) })
    });
    expect(result.action).toBe("remuxed");
    expect(result.keptTrackIndex).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("REMUXED-GERMAN-ONLY");
  });

  it("leaves a NON-German-named file untouched when tagged but no German track (safety preserved)", async () => {
    const file = makeFile("ORIGINAL", "Show.S01E01.MULTi.DL.720p.mkv");
    const result = await processVideoFile(file, { mode: "tag" }, {
      resolveTooling: tooling,
      runProcess: fakeRunner({ probeJson: JSON.stringify({ streams: [{ tags: { language: "eng" } }, { tags: { language: "fre" } }] }) })
    });
    expect(result.action).toBe("skipped-no-german");
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL");
  });

  it("returns skipped-no-tool when ffmpeg/ffprobe are absent", async () => {
    const file = makeFile("ORIGINAL");
    const result = await processVideoFile(file, { mode: "tag" }, { resolveTooling: async () => null });
    expect(result.action).toBe("skipped-no-tool");
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL");
  });
});

describe("renameWithRetry", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const busy = (): NodeJS.ErrnoException => Object.assign(new Error("locked"), { code: "EBUSY" });

  it("retries a transient EBUSY and then succeeds", async () => {
    let calls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) { throw busy(); }
    });
    await expect(renameWithRetry("a", "b")).resolves.toBeUndefined();
    expect(calls).toBe(3); // failed twice, succeeded on the third attempt
  });

  it("gives up after exhausting retries on a persistent lock", async () => {
    let calls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async () => { calls += 1; throw busy(); });
    await expect(renameWithRetry("a", "b")).rejects.toThrow("locked");
    expect(calls).toBe(4); // initial attempt + 3 backoff retries
  });

  it("does not retry a non-retryable error (e.g. EXDEV) — fails fast", async () => {
    let calls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async () => {
      calls += 1;
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    });
    await expect(renameWithRetry("a", "b")).rejects.toThrow("cross-device");
    expect(calls).toBe(1);
  });
});
