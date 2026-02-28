import { describe, expect, it } from "vitest";
import { reorderPackageOrderByDrop } from "../src/renderer/App";

describe("reorderPackageOrderByDrop", () => {
  it("moves adjacent package down by one on drop", () => {
    const next = reorderPackageOrderByDrop(["a", "b", "c"], "b", "c");
    expect(next).toEqual(["a", "c", "b"]);
  });

  it("moves package after lower drop target", () => {
    const next = reorderPackageOrderByDrop(["a", "b", "c", "d"], "a", "c");
    expect(next).toEqual(["b", "c", "a", "d"]);
  });

  it("returns original order when ids are invalid", () => {
    const order = ["a", "b", "c"];
    expect(reorderPackageOrderByDrop(order, "x", "b")).toEqual(order);
    expect(reorderPackageOrderByDrop(order, "a", "x")).toEqual(order);
    expect(reorderPackageOrderByDrop(order, "a", "a")).toEqual(order);
  });
});
