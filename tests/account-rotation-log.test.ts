import { describe, it, expect } from "vitest";
import { logAccountRotation, runWithRotationItemSink, getRecentRotationEvents } from "../src/main/account-rotation-log";
import type { RotationEvent } from "../src/shared/types";

describe("rotation item-sink (AsyncLocalStorage)", () => {
  it("routes the FULL rotation trail (incl. TEST) to the active item sink", async () => {
    const captured: RotationEvent[] = [];
    await runWithRotationItemSink((ev) => captured.push(ev), async () => {
      logAccountRotation("INFO", "Mega-Debrid Web", "Account 1/3 (ab**xy)", "TEST", { link: "x" });
      logAccountRotation("WARN", "Mega-Debrid Web", "Account 1/3 (ab**xy)", "FAILED", { reason: "Timeout", cooldownSec: 30, next: "Account 2/3 (cd**zw)" });
      logAccountRotation("INFO", "Mega-Debrid Web", "Account 2/3 (cd**zw)", "TEST", { link: "x" });
      logAccountRotation("INFO", "Mega-Debrid Web", "Account 2/3 (cd**zw)", "OK", { fileName: "f.mkv" });
      // simulate an await boundary — ALS must survive it
      await Promise.resolve();
    });

    const events = captured.map((e) => e.event);
    expect(events).toEqual(["TEST", "FAILED", "TEST", "OK"]);
    const failed = captured.find((e) => e.event === "FAILED");
    expect(failed?.reason).toBe("Timeout");
    expect(failed?.next).toBe("Account 2/3 (cd**zw)");
  });

  it("does not leak events to the sink outside the run() scope", () => {
    const captured: RotationEvent[] = [];
    // No active sink here
    logAccountRotation("INFO", "Debrid-Link", "Key 1/2 (k1)", "OK");
    expect(captured).toHaveLength(0);
  });

  it("isolates two parallel item sinks (no cross-attribution)", async () => {
    const a: RotationEvent[] = [];
    const b: RotationEvent[] = [];
    await Promise.all([
      runWithRotationItemSink((ev) => a.push(ev), async () => {
        logAccountRotation("INFO", "Mega-Debrid Web", "Account 1 (a)", "TEST");
        await new Promise((r) => setTimeout(r, 10));
        logAccountRotation("INFO", "Mega-Debrid Web", "Account 1 (a)", "OK");
      }),
      runWithRotationItemSink((ev) => b.push(ev), async () => {
        logAccountRotation("INFO", "Debrid-Link", "Key 1 (b)", "TEST");
        await new Promise((r) => setTimeout(r, 5));
        logAccountRotation("WARN", "Debrid-Link", "Key 1 (b)", "FAILED", { reason: "badToken" });
      })
    ]);
    // Each sink only saw its own provider's events
    expect(a.every((e) => e.provider === "Mega-Debrid Web")).toBe(true);
    expect(b.every((e) => e.provider === "Debrid-Link")).toBe(true);
    expect(a.map((e) => e.event)).toEqual(["TEST", "OK"]);
    expect(b.map((e) => e.event)).toEqual(["TEST", "FAILED"]);
  });

  it("still feeds the global UI ring (outcomes only, TEST filtered)", () => {
    logAccountRotation("INFO", "Mega-Debrid API", "Account 9 (zz)", "TEST");
    logAccountRotation("INFO", "Mega-Debrid API", "Account 9 (zz)", "OK", { fileName: "ring.mkv" });
    const ring = getRecentRotationEvents(10);
    // OK is in the ring; the TEST marker is filtered out of the panel
    expect(ring.some((e) => e.event === "OK" && e.accountLabel === "Account 9 (zz)")).toBe(true);
    expect(ring.some((e) => e.event === "TEST" && e.accountLabel === "Account 9 (zz)")).toBe(false);
  });
});
