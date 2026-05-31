import { describe, expect, it } from "vitest";
import { logTimestamp } from "../src/main/log-timestamp";

describe("logTimestamp", () => {
  it("formats local time with an explicit UTC offset (ISO 8601), not a UTC 'Z' string", () => {
    const instant = new Date("2026-05-31T17:29:43.605Z");
    const formatted = logTimestamp(instant);

    // Shape: YYYY-MM-DDTHH:MM:SS.mmm±HH:MM
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    // The whole point: NOT the old UTC "...Z" format that showed 17:29 instead of 19:29.
    expect(formatted.endsWith("Z")).toBe(false);
  });

  it("is parseable back to the exact same instant (offset keeps it unambiguous)", () => {
    const instant = new Date("2026-05-31T17:29:43.605Z");
    // Date.parse must still recover the identical instant (trace-log autoDisableAt etc.).
    expect(new Date(logTimestamp(instant)).getTime()).toBe(instant.getTime());
  });

  it("shows the LOCAL wall-clock hour (machine-timezone-independent assertion)", () => {
    const instant = new Date("2026-05-31T17:29:43.605Z");
    const formatted = logTimestamp(instant);
    // Hour segment must equal the local getHours() of the same instant — i.e. the
    // user's wall clock, whatever the server timezone is.
    expect(formatted.slice(11, 13)).toBe(String(instant.getHours()).padStart(2, "0"));
  });
});
