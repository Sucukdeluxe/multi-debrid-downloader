import { describe, expect, it } from "vitest";
import { classifyDiskError } from "../src/main/fs-error";
import { isDebugFlagEnabled } from "../src/main/logger";

describe("classifyDiskError", () => {
  it("maps ENOSPC from an error code to a disk-full reason", () => {
    const err = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });
    expect(classifyDiskError(err)).toMatch(/Festplatte voll/);
  });

  it("maps EACCES from a code to a permission reason", () => {
    const err = Object.assign(new Error("nope"), { code: "EACCES" });
    expect(classifyDiskError(err)).toMatch(/Zugriff verweigert/);
  });

  it("lower-case codes are normalized", () => {
    const err = Object.assign(new Error("x"), { code: "enospc" });
    expect(classifyDiskError(err)).toMatch(/ENOSPC/);
  });

  it("falls back to scanning the message text when no code is present", () => {
    expect(classifyDiskError(new Error("operation failed: ENOSPC on volume"))).toMatch(/Festplatte voll/);
  });

  it("handles a plain string error", () => {
    expect(classifyDiskError("EROFS: read-only file system")).toMatch(/schreibgeschützt/);
  });

  it("returns null for an unrelated error", () => {
    expect(classifyDiskError(new Error("write_drain_timeout"))).toBeNull();
    expect(classifyDiskError(new Error("premature close"))).toBeNull();
    expect(classifyDiskError(null)).toBeNull();
    expect(classifyDiskError(undefined)).toBeNull();
  });
});

describe("isDebugFlagEnabled", () => {
  it("is true for affirmative values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(isDebugFlagEnabled(v)).toBe(true);
    }
  });

  it("is false for empty/negative/garbage values", () => {
    for (const v of [undefined, "", "0", "false", "off", "no", "maybe"]) {
      expect(isDebugFlagEnabled(v)).toBe(false);
    }
  });
});
