import { describe, expect, it } from "vitest";
import { reorderPackageOrderByDrop, sortPackageOrderByName } from "../src/renderer/package-order";

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

describe("sortPackageOrderByName", () => {
  it("sorts package IDs alphabetically ascending", () => {
    const sorted = sortPackageOrderByName(
      ["pkg3", "pkg1", "pkg2"],
      {
        pkg1: { id: "pkg1", name: "Alpha", outputDir: "", extractDir: "", status: "queued", itemIds: [], cancelled: false, enabled: true, priority: "normal", createdAt: 0, updatedAt: 0 },
        pkg2: { id: "pkg2", name: "beta", outputDir: "", extractDir: "", status: "queued", itemIds: [], cancelled: false, enabled: true, priority: "normal", createdAt: 0, updatedAt: 0 },
        pkg3: { id: "pkg3", name: "Gamma", outputDir: "", extractDir: "", status: "queued", itemIds: [], cancelled: false, enabled: true, priority: "normal", createdAt: 0, updatedAt: 0 }
      },
      false
    );
    expect(sorted).toEqual(["pkg1", "pkg2", "pkg3"]);
  });

  it("sorts package IDs alphabetically descending", () => {
    const sorted = sortPackageOrderByName(
      ["pkg1", "pkg2", "pkg3"],
      {
        pkg1: { id: "pkg1", name: "Alpha", outputDir: "", extractDir: "", status: "queued", itemIds: [], cancelled: false, enabled: true, priority: "normal", createdAt: 0, updatedAt: 0 },
        pkg2: { id: "pkg2", name: "beta", outputDir: "", extractDir: "", status: "queued", itemIds: [], cancelled: false, enabled: true, priority: "normal", createdAt: 0, updatedAt: 0 },
        pkg3: { id: "pkg3", name: "Gamma", outputDir: "", extractDir: "", status: "queued", itemIds: [], cancelled: false, enabled: true, priority: "normal", createdAt: 0, updatedAt: 0 }
      },
      true
    );
    expect(sorted).toEqual(["pkg3", "pkg2", "pkg1"]);
  });
});
