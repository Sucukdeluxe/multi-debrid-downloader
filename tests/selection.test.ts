import { describe, expect, it } from "vitest";
import { pruneSelection } from "../src/renderer/selection";
import type { SessionState } from "../src/shared/types";

function session(packageIds: string[], itemIds: string[]): Pick<SessionState, "packages" | "items"> {
  const packages: Record<string, never> = {};
  const items: Record<string, never> = {};
  for (const id of packageIds) packages[id] = {} as never;
  for (const id of itemIds) items[id] = {} as never;
  return { packages, items };
}

describe("pruneSelection", () => {
  it("drops ids whose package/item no longer exists", () => {
    const sel = new Set(["p1", "i1", "ghost-p", "ghost-i"]);
    const next = pruneSelection(sel, session(["p1"], ["i1"]));
    expect([...next].sort()).toEqual(["i1", "p1"]);
  });

  it("returns the SAME set instance when nothing changed (no needless re-render)", () => {
    const sel = new Set(["p1", "i1"]);
    const next = pruneSelection(sel, session(["p1"], ["i1"]));
    expect(next).toBe(sel);
  });

  it("returns the same instance for an empty selection", () => {
    const sel = new Set<string>();
    expect(pruneSelection(sel, session(["p1"], ["i1"]))).toBe(sel);
  });

  it("prunes everything when the whole session was swapped out", () => {
    const sel = new Set(["p1", "i1"]);
    const next = pruneSelection(sel, session([], []));
    expect(next.size).toBe(0);
    expect(next).not.toBe(sel);
  });

  it("keeps a mixed package+item selection when both survive", () => {
    const sel = new Set(["p1", "p2", "i1"]);
    const next = pruneSelection(sel, session(["p1", "p2"], ["i1", "i2"]));
    expect([...next].sort()).toEqual(["i1", "p1", "p2"]);
    expect(next).toBe(sel); // unchanged → same instance
  });
});
