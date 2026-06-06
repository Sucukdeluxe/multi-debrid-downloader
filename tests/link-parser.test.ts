import { describe, expect, it } from "vitest";
import { mergePackageInputs, parseCollectorInput } from "../src/main/link-parser";

describe("link-parser", () => {
  describe("mergePackageInputs", () => {
    it("merges packages with the same name and preserves order", () => {
      const input = [
        { name: "Package A", links: ["http://link1", "http://link2"] },
        { name: "Package B", links: ["http://link3"] },
        { name: "Package A", links: ["http://link4", "http://link1"] },
        { name: "", links: ["http://link5"] }
      ];

      const result = mergePackageInputs(input);

      expect(result).toHaveLength(3);

      const pkgA = result.find(p => p.name === "Package A");
      expect(pkgA?.links).toEqual(["http://link1", "http://link2", "http://link4"]);

      const pkgB = result.find(p => p.name === "Package B");
      expect(pkgB?.links).toEqual(["http://link3"]);
    });

    it("sanitizes names during merge", () => {
      const input = [
        { name: "Valid_Name", links: ["http://link1"] },
        { name: "Valid?Name*", links: ["http://link2"] }
      ];

      const result = mergePackageInputs(input);

      expect(result.map(p => p.name).sort()).toEqual(["Valid Name", "Valid_Name"]);
    });

    it("preserves file name hints when merging packages", () => {
      const input = [
        { name: "Package A", links: ["http://link1", "http://link2"], fileNames: ["one.rar", "two.rar"] },
        { name: "Package A", links: ["http://link3", "http://link1"], fileNames: ["three.rar", "ignored.rar"] }
      ];

      const result = mergePackageInputs(input);
      expect(result).toHaveLength(1);
      expect(result[0]?.links).toEqual(["http://link1", "http://link2", "http://link3"]);
      expect(result[0]?.fileNames).toEqual(["one.rar", "two.rar", "three.rar"]);
    });
  });

  describe("parseCollectorInput", () => {
    it("returns empty array for empty or invalid input", () => {
      expect(parseCollectorInput("")).toEqual([]);
      expect(parseCollectorInput("just some text without links")).toEqual([]);
      expect(parseCollectorInput("ftp://notsupported")).toEqual([]);
    });

    it("parses and merges links from raw text", () => {
      const rawText = `
        Here are some links:
        http://example.com/part1.rar
        http://example.com/part2.rar

        # package: Custom_Name
        http://other.com/file1
        http://other.com/file2
      `;

      const result = parseCollectorInput(rawText, "DefaultFallback");

      expect(result).toHaveLength(2);

      const defaultPkg = result.find(p => p.name === "DefaultFallback");
      expect(defaultPkg?.links).toEqual([
        "http://example.com/part1.rar",
        "http://example.com/part2.rar"
      ]);

      const customPkg = result.find(p => p.name === "Custom_Name");
      expect(customPkg?.links).toEqual([
        "http://other.com/file1",
        "http://other.com/file2"
      ]);
    });
  });
});
