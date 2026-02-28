import { describe, it, expect } from "vitest";
import {
  extractEpisodeToken,
  applyEpisodeTokenToFolderName,
  sourceHasRpToken,
  ensureRepackToken,
  buildAutoRenameBaseName
} from "../src/main/download-manager";

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

  it("returns null for non-4sf/4sj folder", () => {
    const result = buildAutoRenameBaseName("Show.S01.720p-GROUP", "show.s01e05.720p.mkv");
    expect(result).toBeNull();
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
