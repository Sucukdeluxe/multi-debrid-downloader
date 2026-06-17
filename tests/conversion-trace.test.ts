import { describe, expect, it } from "vitest";
import {
  formatConversionBlock,
  hasActiveConversionTrace,
  runWithConversionTrace,
  traceConversionPhase,
  type ConversionTrace
} from "../src/main/conversion-trace";

describe("formatConversionBlock", () => {
  it("renders a header with verdict + total and one indented line per phase", () => {
    const trace: ConversionTrace = {
      startedAt: 1000,
      itemId: "id1",
      itemName: "tvs-foo.part5.rar",
      link: "https://rapidgator.net/file/abc/tvs-foo.part5.rar.html",
      providerOrder: "megadebrid-api,megadebrid-web",
      notes: { slots: "conv2/dl6/max8" },
      phases: [
        { atMs: 0, phase: "chain-try", provider: "megadebrid-api" },
        { atMs: 5, phase: "token", provider: "megadebrid-api", account: "2/2(e3)", tokenState: "fresh", workMs: 812, outcome: "ok" },
        { atMs: 820, phase: "api-getlink", provider: "megadebrid-api", account: "2/2(e3)", workMs: 634, outcome: "ok" }
      ]
    };
    const block = formatConversionBlock(trace, "OK", "", 1450);

    const lines = block.split("\n");
    expect(lines[0]).toContain("[CONV]");
    expect(lines[0]).toContain("item=tvs-foo.part5.rar");
    expect(lines[0]).toContain("result=OK");
    expect(lines[0]).toContain("total=1450ms");
    expect(lines[0]).toContain("slots=conv2/dl6/max8");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("+5ms token");
    expect(lines[2]).toContain("token=fresh");
    expect(lines[2]).toContain("workMs=812");
  });

  it("includes the failure detail in the header verdict", () => {
    const trace: ConversionTrace = {
      startedAt: 0, itemId: "i", itemName: "x", link: "l", providerOrder: "megadebrid-web", notes: {},
      phases: [{ atMs: 60000, phase: "caller-timeout", provider: "megadebrid-web", outcome: "timeout", detail: "Unrestrict Timeout nach 60s" }]
    };
    const block = formatConversionBlock(trace, "FAIL", "Unrestrict Timeout nach 60s", 60003);
    expect(block.split("\n")[0]).toContain("result=FAIL (Unrestrict Timeout nach 60s)");
    expect(block).toContain("caller-timeout");
  });
});

describe("conversion trace context", () => {
  it("traceConversionPhase is a no-op outside an active trace and does not throw", () => {
    expect(hasActiveConversionTrace()).toBe(false);
    expect(() => traceConversionPhase({ phase: "orphan" })).not.toThrow();
  });

  it("activates an ambient trace across awaits inside runWithConversionTrace", async () => {
    expect(hasActiveConversionTrace()).toBe(false);
    const seen = await runWithConversionTrace(
      { itemId: "i", itemName: "n", link: "l", providerOrder: "megadebrid-api" },
      async () => {
        const before = hasActiveConversionTrace();
        traceConversionPhase({ phase: "chain-try", provider: "megadebrid-api" });
        await Promise.resolve();
        const afterAwait = hasActiveConversionTrace();
        return before && afterAwait;
      }
    );
    expect(seen).toBe(true);
    expect(hasActiveConversionTrace()).toBe(false);
  });
});
