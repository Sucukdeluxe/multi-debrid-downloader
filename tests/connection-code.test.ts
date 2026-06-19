import { describe, it, expect } from "vitest";
import { encodeConnectionCode } from "../src/main/connection-code";
import { decodeConnectionCode } from "../tools/rd-diagnostics-mcp/src/code.mjs";

describe("connection-code", () => {
  it("round-trips through the bridge decoder", () => {
    const code = encodeConnectionCode({ host: "203.0.113.5", port: 9868, token: "deadbeef", name: "server-1" });
    expect(code.startsWith("rddiag:v1:")).toBe(true);
    const decoded = decodeConnectionCode(code);
    expect(decoded.host).toBe("203.0.113.5");
    expect(decoded.port).toBe(9868);
    expect(decoded.token).toBe("deadbeef");
    expect(decoded.name).toBe("server-1");
    expect(decoded.scheme).toBe("http");
  });

  it("carries https scheme and fingerprint when set", () => {
    const code = encodeConnectionCode({
      host: "diag.example.com",
      port: 8443,
      token: "abc",
      scheme: "https",
      fingerprint: "AA:BB:CC"
    });
    const decoded = decodeConnectionCode(code);
    expect(decoded.scheme).toBe("https");
    expect(decoded.fingerprint).toBe("AA:BB:CC");
  });

  it("omits scheme key for plain http (default)", () => {
    const code = encodeConnectionCode({ host: "10.0.0.2", port: 9868, token: "t" });
    const json = JSON.parse(Buffer.from(code.slice("rddiag:v1:".length).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    expect(json.s).toBeUndefined();
    expect(json).toMatchObject({ v: 1, h: "10.0.0.2", p: 9868, t: "t" });
  });

  it("rejects invalid input", () => {
    expect(() => encodeConnectionCode({ host: "", port: 9868, token: "t" })).toThrow();
    expect(() => encodeConnectionCode({ host: "h", port: 0, token: "t" })).toThrow();
    expect(() => encodeConnectionCode({ host: "h", port: 9868, token: "" })).toThrow();
  });
});
