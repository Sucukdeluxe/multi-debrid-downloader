import { describe, expect, it, vi } from "vitest";
import { buildNotifyRequest, isNotifyUrlValid, normalizeDiscordMention, sendNotification } from "../src/main/notify";

describe("normalizeDiscordMention", () => {
  it("wraps a bare user ID as a pinging mention", () => {
    expect(normalizeDiscordMention("123456789012345678")).toBe("<@123456789012345678>");
    expect(normalizeDiscordMention("  987654321  ")).toBe("<@987654321>");
  });
  it("passes @everyone/@here and formed mentions through", () => {
    expect(normalizeDiscordMention("@everyone")).toBe("@everyone");
    expect(normalizeDiscordMention("@here")).toBe("@here");
    expect(normalizeDiscordMention("<@123456789>")).toBe("<@123456789>");
    expect(normalizeDiscordMention("<@&111222333>")).toBe("<@&111222333>");
  });
  it("returns empty for empty input", () => {
    expect(normalizeDiscordMention("")).toBe("");
    expect(normalizeDiscordMention("   ")).toBe("");
  });
});

describe("isNotifyUrlValid", () => {
  it("accepts http/https URLs", () => {
    expect(isNotifyUrlValid("https://discord.com/api/webhooks/123/abc")).toBe(true);
    expect(isNotifyUrlValid("http://192.168.1.10:8080/hook")).toBe(true);
    expect(isNotifyUrlValid("  https://discord.com/api/webhooks/123/abc  ")).toBe(true);
  });
  it("rejects empty and non-http values", () => {
    expect(isNotifyUrlValid("")).toBe(false);
    expect(isNotifyUrlValid("discord.com/api/webhooks/123/abc")).toBe(false);
    expect(isNotifyUrlValid("ftp://x")).toBe(false);
    expect(isNotifyUrlValid("https:// mit leerzeichen")).toBe(false);
  });
});

describe("buildNotifyRequest", () => {
  it("builds a Discord-compatible JSON webhook POST (bold title + message as content)", () => {
    const req = buildNotifyRequest(" https://discord.com/api/webhooks/123/abc ", { title: "✅ Paket fertig", message: "Show.S01\n5 Datei(en)" });
    expect(req.url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(req.init.method).toBe("POST");
    expect(req.init.headers).toMatchObject({ "Content-Type": "application/json" });
    const body = JSON.parse(String(req.init.body));
    expect(body.content).toBe("**✅ Paket fertig**\nShow.S01\n5 Datei(en)");
    expect(body.username).toBe("Real-Debrid Downloader");
  });
  it("caps the content at Discord's 2000-char limit", () => {
    const req = buildNotifyRequest("https://discord.com/api/webhooks/123/abc", { title: "T", message: "x".repeat(3000) });
    const body = JSON.parse(String(req.init.body));
    expect(body.content.length).toBe(2000);
  });
  it("prepends the mention so Discord pings (bare ID gets wrapped)", () => {
    const req = buildNotifyRequest("https://discord.com/api/webhooks/123/abc", { title: "T", message: "M", mention: "123456789012345678" });
    const body = JSON.parse(String(req.init.body));
    expect(body.content).toBe("<@123456789012345678> **T**\nM");
  });
  it("sends no mention prefix when the field is empty", () => {
    const req = buildNotifyRequest("https://discord.com/api/webhooks/123/abc", { title: "T", message: "M", mention: "" });
    const body = JSON.parse(String(req.init.body));
    expect(body.content).toBe("**T**\nM");
  });
});

describe("sendNotification", () => {
  it("returns true on HTTP ok (Discord answers 204 No Content)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(sendNotification("https://discord.com/api/webhooks/123/abc", { title: "T", message: "M" }, fetchFn)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("returns false on HTTP error without throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    await expect(sendNotification("https://discord.com/api/webhooks/123/abc", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
  });
  it("returns false on network error without throwing", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(sendNotification("https://discord.com/api/webhooks/123/abc", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
  });
  it("does not call fetch for an invalid URL", async () => {
    const fetchFn = vi.fn();
    await expect(sendNotification("", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
    await expect(sendNotification("kein-url", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
