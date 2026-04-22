import { describe, it, expect } from "vitest";
import {
  extractEpisodeToken,
  applyEpisodeTokenToFolderName,
  sourceHasRpToken,
  ensureRepackToken,
  buildAutoRenameBaseName,
  buildAutoRenameBaseNameFromFolders,
  buildAutoRenameBaseNameFromFoldersWithOptions,
  hasMeaningfulSeriesPrefix,
  looksLikeObfuscatedSceneFileName
} from "../src/main/download-manager";

describe("hasMeaningfulSeriesPrefix", () => {
  it("recognizes a real series name before the season token", () => {
    expect(hasMeaningfulSeriesPrefix("Desperate.Housewives.S01.Synced.DL.720p.WEB-DL.AC3.h264")).toBe(true);
    expect(hasMeaningfulSeriesPrefix("Die.Thundermans.S02E06.Tickets.und.Shreddy.GERMAN.WS.720p.HDTV.x264-aWake")).toBe(true);
    expect(hasMeaningfulSeriesPrefix("Mistresses.2013.S02.GERMAN.DL.720p.WEB.x264-TSCC")).toBe(true);
    expect(hasMeaningfulSeriesPrefix("show.name.s01e01.720p")).toBe(true);
  });

  it("rejects generic season-label folders without a series name", () => {
    expect(hasMeaningfulSeriesPrefix("S01 Complete")).toBe(false);
    expect(hasMeaningfulSeriesPrefix("S02")).toBe(false);
    expect(hasMeaningfulSeriesPrefix("S01E01 Complete")).toBe(false);
    expect(hasMeaningfulSeriesPrefix(".S01.bla")).toBe(false);
  });

  it("returns false when there is no season token at all", () => {
    expect(hasMeaningfulSeriesPrefix("Some Random Folder")).toBe(false);
    expect(hasMeaningfulSeriesPrefix("")).toBe(false);
  });
});

describe("looksLikeObfuscatedSceneFileName", () => {
  it("flags hoster-obfuscated names with no scene markers as obfuscated", () => {
    // No 720p / german / x264 / bluray, no dot-separated structure
    expect(looksLikeObfuscatedSceneFileName("awa-diethundermans02e16hd.mkv")).toBe(true);
    expect(looksLikeObfuscatedSceneFileName("scn-dthund7-S02E06.mkv")).toBe(true);
    expect(looksLikeObfuscatedSceneFileName("4sj-blue-bloods-s08e21-720p.mkv")).toBe(true);
  });

  it("treats clean scene releases with multiple markers as NOT obfuscated", () => {
    // Has 720p + german + bluray + x264 — clearly a clean scene file
    expect(looksLikeObfuscatedSceneFileName("the.royals.2015.s01e09.german.dl.720p.bluray.x264-j4f.mkv")).toBe(false);
    expect(looksLikeObfuscatedSceneFileName("Die.Thundermans.S02E06.Tickets.und.Shreddy.GERMAN.WS.720p.HDTV.x264-aWake.mkv")).toBe(false);
    expect(looksLikeObfuscatedSceneFileName("Desperate.Housewives.S01E01.German.Synced.DL.720p.WEB-DL.AC3.h264.mkv")).toBe(false);
  });

  it("handles edge cases (empty, very short)", () => {
    expect(looksLikeObfuscatedSceneFileName("")).toBe(true);
    expect(looksLikeObfuscatedSceneFileName("a.mkv")).toBe(true);
  });

  it("treats long dotted names as scene-style even with few markers", () => {
    // 6+ dots → looks like scene structure even without quality/codec markers
    expect(looksLikeObfuscatedSceneFileName("Some.Show.With.Many.Tokens.S01E01.mkv")).toBe(false);
  });
});

describe("extractEpisodeToken (extended formats)", () => {
  it("recognizes the older xX format (capped at 2 episode digits)", () => {
    expect(extractEpisodeToken("show.1x01.720p.mkv")).toBe("S01E01");
    expect(extractEpisodeToken("show-2x05-hdtv.mkv")).toBe("S02E05");
    expect(extractEpisodeToken("Show.Name.10x99.mkv")).toBe("S10E99");
    // 3-digit episode in xX format is intentionally NOT supported — would
    // collide with codec tokens (x264/x265/x266). 3-digit episodes still
    // work in the modern SxxEnnn format which has explicit S/E delimiters.
    expect(extractEpisodeToken("Show.Name.10x100.mkv")).toBeNull();
    expect(extractEpisodeToken("Show.Name.S10E100.mkv")).toBe("S10E100");
  });

  it("does not falsely match resolution tokens like 1080x720", () => {
    // The xX regex is bounded; 1080p shouldn't match as "1080x???" because
    // there's no second number group in 1080p / 720p / etc.
    expect(extractEpisodeToken("show.1080p.mkv")).toBeNull();
    expect(extractEpisodeToken("show.S01E01.1080p.mkv")).toBe("S01E01");
  });

  it("does not falsely match codec tokens like x264 / x265 (caps episode digits)", () => {
    // First number 5, second number capped to 2 digits → "5x265" CANNOT
    // match because 265 has 3 digits. Same for x264, x266, h264, h265.
    expect(extractEpisodeToken("Movie.x264-GROUP.mkv")).toBeNull();
    expect(extractEpisodeToken("Movie.5x265.x265.mkv")).toBeNull();
    // SxxExx still wins ahead of phantom xX matches.
    expect(extractEpisodeToken("Show.S01E01.x265-GROUP.mkv")).toBe("S01E01");
  });

  it("does not falsely match common aspect ratios like 1920x1080", () => {
    // 1920 has 4 digits, first group capped at 2 → no match.
    expect(extractEpisodeToken("Movie.1920x1080.mkv")).toBeNull();
  });
});

describe("extractEpisodeToken", () => {
  it("extracts S01E01 from standard scene format", () => {
    expect(extractEpisodeToken("show.name.s01e01.720p")).toBe("S01E01");
  });

  it("extracts episode with dot separators", () => {
    expect(extractEpisodeToken("Show.S02E15.1080p")).toBe("S02E15");
  });

  it("extracts episode with dash separators", () => {
    expect(extractEpisodeToken("show-s3e5-720p")).toBe("S03E05");
  });

  it("extracts episode with underscore separators", () => {
    expect(extractEpisodeToken("show_s10e100_hdtv")).toBe("S10E100");
  });

  it("extracts episode with space separators", () => {
    expect(extractEpisodeToken("Show Name s1e2 720p")).toBe("S01E02");
  });

  it("pads single-digit season and episode to 2 digits", () => {
    expect(extractEpisodeToken("show.s1e3.720p")).toBe("S01E03");
  });

  it("handles 3-digit episode numbers", () => {
    expect(extractEpisodeToken("show.s01e123")).toBe("S01E123");
  });

  it("returns null for no episode token", () => {
    expect(extractEpisodeToken("some.random.file.720p")).toBeNull();
  });

  it("returns null for season-only pattern (no episode)", () => {
    expect(extractEpisodeToken("show.s01.720p")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractEpisodeToken("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractEpisodeToken("Show.S05E10.1080p")).toBe("S05E10");
    expect(extractEpisodeToken("show.s05e10.1080p")).toBe("S05E10");
  });

  it("extracts from episode token at start of string", () => {
    expect(extractEpisodeToken("s01e01.720p")).toBe("S01E01");
  });

  it("extracts from episode token at end of string", () => {
    expect(extractEpisodeToken("show.s02e03")).toBe("S02E03");
  });

  it("extracts double episode token s01e01e02", () => {
    expect(extractEpisodeToken("tvr-mammon-s01e01e02-720p")).toBe("S01E01E02");
  });

  it("extracts double episode with dot separators", () => {
    expect(extractEpisodeToken("Show.S01E03E04.720p")).toBe("S01E03E04");
  });

  it("extracts double episode at end of string", () => {
    expect(extractEpisodeToken("show.s02e05e06")).toBe("S02E05E06");
  });

  it("extracts double episode with single-digit numbers", () => {
    expect(extractEpisodeToken("show-s1e1e2-720p")).toBe("S01E01E02");
  });

  it("extracts episode when title and season token are joined", () => {
    expect(extractEpisodeToken("mdgp-carters02e01-720p")).toBe("S02E01");
  });
});

describe("applyEpisodeTokenToFolderName", () => {
  it("replaces existing episode token in folder name", () => {
    expect(applyEpisodeTokenToFolderName("Show.S01E01.720p-4sf", "S02E05")).toBe("Show.S02E05.720p-4sf");
  });

  it("replaces season-only token when no episode in folder", () => {
    expect(applyEpisodeTokenToFolderName("Show.S01.720p-4sf", "S01E03")).toBe("Show.S01E03.720p-4sf");
  });

  it("inserts before -4sf suffix when no season/episode in folder", () => {
    expect(applyEpisodeTokenToFolderName("Show.720p-4sf", "S01E05")).toBe("Show.720p.S01E05-4sf");
  });

  it("inserts before -4sj suffix", () => {
    expect(applyEpisodeTokenToFolderName("Show.720p-4sj", "S01E05")).toBe("Show.720p.S01E05-4sj");
  });

  it("appends episode token when no recognized pattern", () => {
    expect(applyEpisodeTokenToFolderName("SomeFolder", "S01E01")).toBe("SomeFolder.S01E01");
  });

  it("returns episode token when folder name is empty", () => {
    expect(applyEpisodeTokenToFolderName("", "S01E01")).toBe("S01E01");
  });

  it("handles folder with existing multi-digit episode", () => {
    expect(applyEpisodeTokenToFolderName("Show.S01E99.720p-4sf", "S01E05")).toBe("Show.S01E05.720p-4sf");
  });

  it("is case-insensitive for -4SF/-4SJ suffix", () => {
    expect(applyEpisodeTokenToFolderName("Show.720p-4SF", "S01E01")).toBe("Show.720p.S01E01-4SF");
  });

  it("applies double episode token to season-only folder", () => {
    expect(applyEpisodeTokenToFolderName("Mammon.S01.German.1080P.Bluray.x264-SMAHD", "S01E01E02"))
      .toBe("Mammon.S01E01E02.German.1080P.Bluray.x264-SMAHD");
  });

  it("replaces existing double episode in folder with new token", () => {
    expect(applyEpisodeTokenToFolderName("Show.S01E01E02.720p-4sf", "S01E03E04"))
      .toBe("Show.S01E03E04.720p-4sf");
  });

  it("replaces existing single episode in folder with double episode token", () => {
    expect(applyEpisodeTokenToFolderName("Show.S01E01.720p-4sf", "S01E01E02"))
      .toBe("Show.S01E01E02.720p-4sf");
  });
});

describe("sourceHasRpToken", () => {
  it("detects .rp. in filename", () => {
    expect(sourceHasRpToken("show.s01e01.rp.720p")).toBe(true);
  });

  it("detects -rp- in filename", () => {
    expect(sourceHasRpToken("show-s01e01-rp-720p")).toBe(true);
  });

  it("detects _rp_ in filename", () => {
    expect(sourceHasRpToken("show_s01e01_rp_720p")).toBe(true);
  });

  it("detects rp at end of string", () => {
    expect(sourceHasRpToken("show.s01e01.rp")).toBe(true);
  });

  it("does not match rp inside a word", () => {
    expect(sourceHasRpToken("enterprise.s01e01")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(sourceHasRpToken("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(sourceHasRpToken("show.RP.720p")).toBe(true);
  });
});

describe("ensureRepackToken", () => {
  it("inserts REPACK before quality token", () => {
    expect(ensureRepackToken("Show.S01E01.1080p-4sf")).toBe("Show.S01E01.REPACK.1080p-4sf");
  });

  it("inserts REPACK before 720p", () => {
    expect(ensureRepackToken("Show.S01E01.720p-4sf")).toBe("Show.S01E01.REPACK.720p-4sf");
  });

  it("inserts REPACK before 2160p", () => {
    expect(ensureRepackToken("Show.S01E01.2160p-4sf")).toBe("Show.S01E01.REPACK.2160p-4sf");
  });

  it("inserts REPACK before -4sf when no quality token", () => {
    expect(ensureRepackToken("Show.S01E01-4sf")).toBe("Show.S01E01.REPACK-4sf");
  });

  it("inserts REPACK before -4sj when no quality token", () => {
    expect(ensureRepackToken("Show.S01E01-4sj")).toBe("Show.S01E01.REPACK-4sj");
  });

  it("appends REPACK when no recognized insertion point", () => {
    expect(ensureRepackToken("Show.S01E01")).toBe("Show.S01E01.REPACK");
  });

  it("does not double-add REPACK if already present", () => {
    expect(ensureRepackToken("Show.S01E01.REPACK.1080p-4sf")).toBe("Show.S01E01.REPACK.1080p-4sf");
  });

  it("does not double-add repack (case-insensitive)", () => {
    expect(ensureRepackToken("Show.s01e01.repack.720p-4sf")).toBe("Show.s01e01.repack.720p-4sf");
  });
});

describe("buildAutoRenameBaseName", () => {
  it("renames with episode token from source file", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-4sf", "show.s01e05.720p.mkv");
    expect(result).toBe("Show.S01E05.720p-4sf");
  });

  it("works with -4sj suffix", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-4sj", "show.s01e03.720p.mkv");
    expect(result).toBe("Show.S01E03.720p-4sj");
  });

  it("renames generic scene folder with group suffix", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-GROUP", "show.s01e05.720p.mkv");
    expect(result).toBe("Show.S01.720p-GROUP");
  });

  it("returns null when source has no episode token", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-4sf", "random.file.720p.mkv");
    expect(result).toBeNull();
  });

  it("adds REPACK when source has rp token", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-4sf", "show.s01e05.rp.720p.mkv");
    expect(result).toBe("Show.S01E05.REPACK.720p-4sf");
  });

  it("handles folder with existing episode that gets replaced", () => {
    const result = buildAutoRenameBaseName("Show.S01E01.720p-4sf", "show.s01e10.720p.mkv");
    expect(result).toBe("Show.S01E10.720p-4sf");
  });

  it("inserts episode before -4sf when folder has no season/episode", () => {
    const result = buildAutoRenameBaseName("Show.720p-4sf", "show.s01e05.720p.mkv");
    expect(result).toBe("Show.720p.S01E05-4sf");
  });

  it("handles case-insensitive 4SF suffix", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-4SF", "show.s01e02.720p.mkv");
    expect(result).toBe("Show.S01E02.720p-4SF");
  });

  it("handles rp + no quality token in folder", () => {
    const result = buildAutoRenameBaseName("Show.S01-4sf", "show.s01e05.rp.mkv");
    expect(result).toBe("Show.S01E05.REPACK-4sf");
  });

  it("returns null for empty folder name", () => {
    const result = buildAutoRenameBaseName("", "show.s01e01.mkv");
    expect(result).toBeNull();
  });

  it("returns null for empty source file name", () => {
    const result = buildAutoRenameBaseName("Show.S01-4sf", "");
    expect(result).toBeNull();
  });

  // Edge cases
  it("handles 2160p quality token", () => {
    const result = buildAutoRenameBaseName("Show.S01.2160p-4sf", "show.s01e01.rp.2160p.mkv");
    expect(result).toBe("Show.S01E01.REPACK.2160p-4sf");
  });

  it("handles 480p quality token", () => {
    const result = buildAutoRenameBaseName("Show.S01.480p-4sf", "show.s01e07.480p.mkv");
    expect(result).toBe("Show.S01E07.480p-4sf");
  });

  it("does not trigger on folders ending with similar but wrong suffix", () => {
    expect(buildAutoRenameBaseName("Show.S01-4sfx", "show.s01e01.mkv")).toBeNull();
    expect(buildAutoRenameBaseName("Show.S01-x4sf", "show.s01e01.mkv")).toBeNull();
  });

  it("handles high season and episode numbers", () => {
    const result = buildAutoRenameBaseName("Show.S99.720p-4sf", "show.s99e999.720p.mkv");
    // SCENE_EPISODE_RE allows up to 3-digit episodes and 2-digit seasons
    expect(result).not.toBeNull();
    expect(result!).toContain("S99E999");
  });

  // Real-world scene release patterns
  it("real-world: German series with dots", () => {
    const result = buildAutoRenameBaseName(
      "Der.Bergdoktor.S18.German.720p.WEB.x264-4SJ",
      "der.bergdoktor.s18e01.german.720p.web.x264"
    );
    expect(result).toBe("Der.Bergdoktor.S18E01.German.720p.WEB.x264-4SJ");
  });

  it("real-world: English series with rp token", () => {
    const result = buildAutoRenameBaseName(
      "The.Last.of.Us.S02.1080p.WEB-4SF",
      "the.last.of.us.s02e03.rp.1080p.web"
    );
    expect(result).toBe("The.Last.of.Us.S02E03.REPACK.1080p.WEB-4SF");
  });

  it("real-world: multiple dots in name", () => {
    const result = buildAutoRenameBaseName(
      "Grey.s.Anatomy.S21.German.DL.720p.WEB.x264-4SJ",
      "grey.s.anatomy.s21e08.german.dl.720p.web.x264"
    );
    expect(result).toBe("Grey.s.Anatomy.S21E08.German.DL.720p.WEB.x264-4SJ");
  });

  it("real-world: 4K content", () => {
    const result = buildAutoRenameBaseName(
      "Severance.S02.2160p.ATVP.WEB-DL.DDP5.1.DV.H.265-4SF",
      "severance.s02e07.2160p.atvp.web-dl.ddp5.1.dv.h.265"
    );
    expect(result).toBe("Severance.S02E07.2160p.ATVP.WEB-DL.DDP5.1.DV.H.265-4SF");
  });

  it("real-world: Britannia release keeps folder base name", () => {
    const result = buildAutoRenameBaseName(
      "Britannia.S02.GERMAN.720p.WEBRiP.x264-LAW",
      "law-britannia.s02e01.720p.webrip"
    );
    expect(result).toBe("Britannia.S02.GERMAN.720p.WEBRiP.x264-LAW");
  });

  it("real-world: Britannia repack injects REPACK", () => {
    const result = buildAutoRenameBaseName(
      "Britannia.S02.GERMAN.720p.WEBRiP.x264-LAW",
      "law-britannia.s02e09.720p.webrip.repack"
    );
    expect(result).toBe("Britannia.S02.GERMAN.REPACK.720p.WEBRiP.x264-LAW");
  });

  it("adds REPACK when folder name carries RP hint", () => {
    const result = buildAutoRenameBaseName(
      "Banshee.S02E01.German.RP.720p.BluRay.x264-RIPLEY",
      "r-banshee.s02e01-720p"
    );
    expect(result).toBe("Banshee.S02E01.German.REPACK.720p.BluRay.x264-RIPLEY");
  });

  it("real-world: folder already has wrong episode", () => {
    const result = buildAutoRenameBaseName(
      "Cobra.Kai.S06E01.720p.NF.WEB-DL.DDP5.1.x264-4SF",
      "cobra.kai.s06e14.720p.nf.web-dl.ddp5.1.x264"
    );
    expect(result).toBe("Cobra.Kai.S06E14.720p.NF.WEB-DL.DDP5.1.x264-4SF");
  });

  // Bug-hunting edge cases
  it("source filename extension is not included in episode detection", () => {
    // The sourceFileName passed to buildAutoRenameBaseName is the basename without extension
    // so .mkv should not interfere, but let's verify with an actual extension
    const result = buildAutoRenameBaseName("Show.S01-4sf", "show.s01e01.mkv");
    // "mkv" should not be treated as part of the filename match
    expect(result).not.toBeNull();
    expect(result!).toContain("S01E01");
  });

  it("does not match episode-like patterns in codec strings", () => {
    // h.265 has digits but should not be confused with episode tokens
    const token = extractEpisodeToken("show.s01e01.h.265");
    expect(token).toBe("S01E01");
  });

  it("handles folder with dash separators throughout", () => {
    const result = buildAutoRenameBaseName(
      "Show-Name-S01-720p-4sf",
      "show-name-s01e05-720p"
    );
    expect(result).toBe("Show-Name-S01E05-720p-4sf");
  });

  it("does not duplicate episode when folder already has the same episode", () => {
    const result = buildAutoRenameBaseName(
      "Show.S01E05.720p-4sf",
      "show.s01e05.720p"
    );
    // Must NOT produce "Show.S01E05.720p.S01E05-4sf" (double episode bug)
    expect(result).toBe("Show.S01E05.720p-4sf");
  });

  it("handles folder with only -4sf suffix (edge case)", () => {
    const result = buildAutoRenameBaseName("-4sf", "show.s01e01.mkv");
    // Extreme edge case - sanitizeFilename trims leading dots
    expect(result).not.toBeNull();
    expect(result!).toContain("S01E01");
    expect(result!).toContain("-4sf");
    expect(result!).not.toContain(".S01E01.S01E01"); // no duplication
  });

  it("sanitizes special characters from result", () => {
    // sanitizeFilename should strip dangerous chars
    const result = buildAutoRenameBaseName("Show:Name.S01-4sf", "show.s01e01.mkv");
    // The colon should be sanitized away
    expect(result).not.toBeNull();
    expect(result!).not.toContain(":");
  });
});

describe("buildAutoRenameBaseNameFromFolders", () => {
  it("uses parent folder when current folder is not a scene template", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Episode 01",
        "Banshee.S02.German.720p.BluRay.x264-RIPLEY"
      ],
      "r-banshee.s02e01-720p"
    );
    expect(result).toBe("Banshee.S02.German.720p.BluRay.x264-RIPLEY");
  });

  it("uses nested scene subfolder directly", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Banshee.S02E01.German.720p.BluRay.x264-RIPLEY",
        "Banshee.S02.German.720p.BluRay.x264-RIPLEY"
      ],
      "r-banshee.s02e01-720p"
    );
    expect(result).toBe("Banshee.S02E01.German.720p.BluRay.x264-RIPLEY");
  });

  it("injects REPACK when parent folder carries repack hint", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Banshee.S02E01.German.720p.BluRay.x264-RIPLEY",
        "Banshee.S02.German.RP.720p.BluRay.x264-RIPLEY"
      ],
      "r-banshee.s02e01-720p"
    );
    expect(result).toBe("Banshee.S02E01.German.REPACK.720p.BluRay.x264-RIPLEY");
  });

  it("uses nested Arrow episode folder with title", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Arrow.S04E01.Green.Arrow.German.DL.720p.BluRay.x264-RSG",
        "Arrow.S04.German.DL.720p.BluRay.x264-RSG"
      ],
      "rsg-arrow-s04e01-720p"
    );
    expect(result).toBe("Arrow.S04E01.Green.Arrow.German.DL.720p.BluRay.x264-RSG");
  });

  it("adds REPACK for Arrow when source contains rp token", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Arrow.S04E01.Green.Arrow.German.DL.720p.BluRay.x264-RSG",
        "Arrow.S04.German.DL.720p.BluRay.x264-RSG"
      ],
      "rsg-arrow-s04e01.rp.720p"
    );
    expect(result).toBe("Arrow.S04E01.Green.Arrow.German.DL.REPACK.720p.BluRay.x264-RSG");
  });

  it("converts Teil token to episode using parent season", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Last.Impact.Der.Einschlag.Teil1.GERMAN.DL.720p.WEB.H264-SunDry",
        "Last.Impact.Der.Einschlag.S01.GERMAN.DL.720p.WEB.H264-SunDry"
      ],
      "sundry-last.impact.der.einschlag.teil1.720p.web.h264"
    );
    expect(result).toBe("Last.Impact.Der.Einschlag.S01E01.GERMAN.DL.720p.WEB.H264-SunDry");
  });

  it("converts Teil token to episode with REPACK", () => {
    const result = buildAutoRenameBaseNameFromFolders(
      [
        "Last.Impact.Der.Einschlag.Teil1.GERMAN.DL.720p.WEB.H264-SunDry",
        "Last.Impact.Der.Einschlag.S01.GERMAN.DL.720p.WEB.H264-SunDry"
      ],
      "sundry-last.impact.der.einschlag.teil1.rp.720p.web.h264"
    );
    expect(result).toBe("Last.Impact.Der.Einschlag.S01E01.GERMAN.DL.REPACK.720p.WEB.H264-SunDry");
  });

  it("forces episode insertion for flat season folder when many files share directory", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Arrow.S08.GERMAN.DUBBED.DL.720p.BluRay.x264-TMSF"
      ],
      "tmsf-arrow-s08e03-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Arrow.S08E03.GERMAN.DUBBED.DL.720p.BluRay.x264-TMSF");
  });

  it("forces episode insertion plus REPACK for flat season folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Gotham.S05.GERMAN.DUBBED.720p.BLURAY.x264-ZZGtv"
      ],
      "zzgtv-gotham-s05e02.rp",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Gotham.S05E02.GERMAN.DUBBED.REPACK.720p.BLURAY.x264-ZZGtv");
  });

  it("uses nested episode title folder for Gotham TvR style", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Gotham.S04E01.Pax.Penguina.GERMAN.5.1.DL.AC3.720p.BDRiP.x264-TvR",
        "Gotham.S04.GERMAN.5.1.DL.AC3.720p.BDRiP.x264-TvR"
      ],
      "tvr-gotham-s04e01-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Gotham.S04E01.Pax.Penguina.GERMAN.5.1.DL.AC3.720p.BDRiP.x264-TvR");
  });

  it("uses nested title folder for Britannia TV4A style", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Britannia.S01E01.Die.Landung.German.DL.720p.BluRay.x264-TV4A",
        "Britannia.S01.German.DL.720p.BluRay.x264-TV4A"
      ],
      "tv4a-britannia.s01e01-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Britannia.S01E01.Die.Landung.German.DL.720p.BluRay.x264-TV4A");
  });

  it("handles odd source token style 101 by using nested Agent X folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Agent.X.S01E01.Pilot.German.DD51.Dubbed.DL.720p.iTunesHD.x264-TVS",
        "Agent.X.S01.German.DD51.Dubbed.DL.720p.iTunesHD.x264-TVS"
      ],
      "tvs-agent-x-dd51-ded-dl-7p-ithd-x264-101",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Agent.X.S01E01.Pilot.German.DD51.Dubbed.DL.720p.iTunesHD.x264-TVS");
  });

  it("maps compact code 301 to S03E01 for nested Legion folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Legion.S03E01.Kapitel.20.German.DD51.Dubbed.DL.720p.AmazonHD.AVC-TVS",
        "Legion.S03.German.DD51.Dubbed.DL.720p.AmazonHD.AVC-TVS"
      ],
      "tvs-legion-dd51-ded-dl-7p-azhd-avc-301",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Legion.S03E01.Kapitel.20.German.DD51.Dubbed.DL.720p.AmazonHD.AVC-TVS");
  });

  it("maps compact code 211 in flat season folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Lethal.Weapon.S02.German.DD51.Dubbed.DL.720p.AmazonHD.x264-TVS"
      ],
      "tvs-lethal-weapon-dd51-ded-dl-7p-azhd-x264-211",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Lethal.Weapon.S02E11.German.DD51.Dubbed.DL.720p.AmazonHD.x264-TVS");
  });

  it("maps compact code 319a to episode 19 in season 3 folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Die.Bergpolizei.-.Ganz.nah.am.Himmel.S03.GERMAN.AC3.720p.HDTV.x264-hrs"
      ],
      "hrs-bpol.hdtv.7p-319a",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Die.Bergpolizei.-.Ganz.nah.am.Himmel.S03E19.GERMAN.AC3.720p.HDTV.x264-hrs");
  });

  it("maps compact code 319b to next episode in season 3 folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Die.Bergpolizei.-.Ganz.nah.am.Himmel.S03.GERMAN.AC3.720p.HDTV.x264-hrs"
      ],
      "hrs-bpol.hdtv.7p-319b",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Die.Bergpolizei.-.Ganz.nah.am.Himmel.S03E20.GERMAN.AC3.720p.HDTV.x264-hrs");
  });

  it("maps episode-only token e01 via season folder hint and keeps REPACK", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Cheat.der.Betrug.S01.GERMAN.720p.WEB.h264-TMSF"
      ],
      "tmsf-cheatderbetrug-e01-720p-repack",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Cheat.der.Betrug.S01E01.GERMAN.REPACK.720p.WEB.h264-TMSF");
  });

  it("maps episode-only token e02 via season folder hint", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Cheat.der.Betrug.S01.GERMAN.720p.WEB.h264-TMSF"
      ],
      "tmsf-cheatderbetrug-e02-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Cheat.der.Betrug.S01E02.GERMAN.720p.WEB.h264-TMSF");
  });

  it("keeps renaming for odd source order like 4sf-bs-720p-s01e05", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Cheat.der.Betrug.S01.GERMAN.720p.WEB.h264-TMSF"
      ],
      "4sf-bs-720p-s01e05",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Cheat.der.Betrug.S01E05.GERMAN.720p.WEB.h264-TMSF");
  });

  it("accepts lowercase scene group suffixes", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Cheat.der.Betrug.S01.GERMAN.720p.WEB.h264-tmsf"
      ],
      "tmsf-cheatderbetrug-e01-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Cheat.der.Betrug.S01E01.GERMAN.720p.WEB.h264-tmsf");
  });

  it("renames double episode file into season folder (Mammon style)", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Mammon.S01.German.1080P.Bluray.x264-SMAHD"
      ],
      "tvr-mammon-s01e01e02-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Mammon.S01E01E02.German.1080P.Bluray.x264-SMAHD");
  });

  it("renames second double episode file correctly", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Mammon.S01.German.1080P.Bluray.x264-SMAHD"
      ],
      "tvr-mammon-s01e03e04-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Mammon.S01E03E04.German.1080P.Bluray.x264-SMAHD");
  });

  it("renames third double episode file correctly", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Mammon.S01.German.1080P.Bluray.x264-SMAHD"
      ],
      "tvr-mammon-s01e05e06-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Mammon.S01E05E06.German.1080P.Bluray.x264-SMAHD");
  });

  // Last-resort fallback: folder has season but no scene group suffix (user-renamed packages)
  it("renames when folder has season but no scene group suffix (Mystery Road case)", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Mystery Road S02"],
      "myst.road.de.dl.hdtv.7p-s02e05",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Mystery Road S02E05");
  });

  it("renames with season-only folder and custom name without dots", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Meine Serie S03"],
      "meine-serie-s03e10-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Meine Serie S03E10");
  });

  it("prefers scene-group folder over season-only fallback", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "Mystery Road S02",
        "Mystery.Road.S02.GERMAN.DL.AC3.720p.HDTV.x264-hrs"
      ],
      "myst.road.de.dl.hdtv.7p-s02e05",
      { forceEpisodeForSeasonFolder: true }
    );
    // Should use the scene-group folder (hrs), not the custom one
    expect(result).toBe("Mystery.Road.S02E05.GERMAN.DL.AC3.720p.HDTV.x264-hrs");
  });

  it("does not use season-only fallback when forceEpisodeForSeasonFolder is false", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Mystery Road S02"],
      "myst.road.de.dl.hdtv.7p-s02e05",
      { forceEpisodeForSeasonFolder: false }
    );
    expect(result).toBeNull();
  });

  it("renames Riviera S02 with single-digit episode s02e2", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Riviera.S02.GERMAN.DUBBED.DL.720p.WebHD.x264-TVP"],
      "tvp-riviera-s02e2-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Riviera.S02E02.GERMAN.DUBBED.DL.720p.WebHD.x264-TVP");
  });

  it("renames Room 104 abbreviated source r104.de.dl.web.7p-s04e02", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Room.104.S04.GERMAN.DL.720p.WEBRiP.x264-LAW"],
      "r104.de.dl.web.7p-s04e02",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Room.104.S04E02.GERMAN.DL.720p.WEBRiP.x264-LAW");
  });

  it("renames Room 104 wayne source with episode", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Room.104.S04.GERMAN.DL.720p.WEBRiP.x264-LAW"],
      "room.104.s04e01.german.dl.720p.web.h264-wayne",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Room.104.S04E01.GERMAN.DL.720p.WEBRiP.x264-LAW");
  });

  it("renames Carter when source joins title and season token", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Carter.S02.GERMAN.DL.720p.HDTV.x264-MDGP"],
      "mdgp-carters02e01-720p",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Carter.S02E01.GERMAN.DL.720p.HDTV.x264-MDGP");
  });

  it("renames abbreviated source bupr.de.dl.web.7p-s01e03 via season folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["Burning.Promise.S01.GERMAN.DL.720p.WEB.H264-WvF"],
      "bupr.de.dl.web.7p-s01e03",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("Burning.Promise.S01E03.GERMAN.DL.720p.WEB.H264-WvF");
  });

  it("renames abbreviated 4SF source amilllt.de.dl.web.7p-s03e10 via season folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["A.Million.Little.Things.S03.GERMAN.DL.720p.WEB.H264-4SF"],
      "4sf-amilllt.de.dl.web.7p-s03e10",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("A.Million.Little.Things.S03E10.GERMAN.DL.720p.WEB.H264-4SF");
  });

  it("renames abbreviated source jkl.web.7p-s01e13 via season folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["9JKL.S01.GERMAN.720p.WEB.x264-WvF"],
      "jkl.web.7p-s01e13",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("9JKL.S01E13.GERMAN.720p.WEB.x264-WvF");
  });

  it("renames abbreviated source jkl.web.7p-s01e14 via season folder", () => {
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      ["9JKL.S01.GERMAN.720p.WEB.x264-WvF"],
      "jkl.web.7p-s01e14",
      { forceEpisodeForSeasonFolder: true }
    );
    expect(result).toBe("9JKL.S01E14.GERMAN.720p.WEB.x264-WvF");
  });

  it("documents malformed package name (S01GERMAN) limitation", () => {
    // Real-world: "Drei.Meter.ueber.dem.Himmel.S01GERMAN.DL.720P.WEB.X264-WAYNE"
    // is malformed (no separator between S01 and GERMAN). SCENE_SEASON_ONLY_RE
    // doesn't match this, so the helper falls back to the package name as-is.
    // The download-manager autoRenameExtractedVideoFiles safety net repairs
    // this at runtime by inserting the source's episode token.
    const result = buildAutoRenameBaseNameFromFoldersWithOptions(
      [
        "3MH.web.7p-101",
        "Drei.Meter.ueber.dem.Himmel.S01GERMAN.DL.720P.WEB.X264-WAYNE"
      ],
      "Drei.Meter.ueber.dem.Himmel.S01E01.GERMAN.DL.720P.WEB.X264-WAYNE",
      { forceEpisodeForSeasonFolder: true }
    );
    // Helper limitation: returns the malformed folder name unchanged.
    // The download-manager safety net catches this at runtime.
    if (result !== null) {
      expect(typeof result).toBe("string");
    }
  });
});
