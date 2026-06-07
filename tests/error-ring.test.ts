import { describe, expect, it } from "vitest";
import { createErrorRing } from "../src/main/error-ring";

describe("createErrorRing", () => {
  it("keeps entries in insertion order", () => {
    const ring = createErrorRing(10);
    ring.push({ ts: "t1", level: "ERROR", message: "a" });
    ring.push({ ts: "t2", level: "WARN", message: "b" });
    expect(ring.snapshot().map((e) => e.message)).toEqual(["a", "b"]);
    expect(ring.size()).toBe(2);
  });

  it("caps at capacity by dropping the oldest", () => {
    const ring = createErrorRing(3);
    for (const m of ["a", "b", "c", "d", "e"]) {
      ring.push({ ts: m, level: "ERROR", message: m });
    }
    expect(ring.snapshot().map((e) => e.message)).toEqual(["c", "d", "e"]);
    expect(ring.size()).toBe(3);
  });

  it("snapshot returns a copy, not the live buffer", () => {
    const ring = createErrorRing(5);
    ring.push({ ts: "t", level: "WARN", message: "x" });
    const snap = ring.snapshot();
    snap.push({ ts: "t2", level: "ERROR", message: "injected" });
    expect(ring.snapshot().map((e) => e.message)).toEqual(["x"]);
  });

  it("clear empties the ring", () => {
    const ring = createErrorRing(5);
    ring.push({ ts: "t", level: "ERROR", message: "x" });
    ring.clear();
    expect(ring.snapshot()).toEqual([]);
    expect(ring.size()).toBe(0);
  });

  it("coerces a non-positive capacity to at least 1", () => {
    const ring = createErrorRing(0);
    ring.push({ ts: "t1", level: "ERROR", message: "a" });
    ring.push({ ts: "t2", level: "ERROR", message: "b" });
    expect(ring.snapshot().map((e) => e.message)).toEqual(["b"]);
  });
});
