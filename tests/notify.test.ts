import { describe, expect, it, vi } from "vitest";
import { buildNotifyRequest, isNotifyUrlValid, normalizeDiscordMention, sendNotification, truncateContent } from "../src/main/notify";

const noSleep = async (): Promise<void> => {};
const WEBHOOK = "https://discord.com/api/webhooks/123/abc";

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
    expect(isNotifyUrlValid(WEBHOOK)).toBe(true);
    expect(isNotifyUrlValid("http://192.168.1.10:8080/hook")).toBe(true);
    expect(isNotifyUrlValid(`  ${WEBHOOK}  `)).toBe(true);
  });
  it("rejects empty and non-http values", () => {
    expect(isNotifyUrlValid("")).toBe(false);
    expect(isNotifyUrlValid("discord.com/api/webhooks/123/abc")).toBe(false);
    expect(isNotifyUrlValid("ftp://x")).toBe(false);
    expect(isNotifyUrlValid("https:// mit leerzeichen")).toBe(false);
    expect(isNotifyUrlValid("***")).toBe(false);
  });
});

describe("truncateContent", () => {
  it("leaves short content untouched", () => {
    expect(truncateContent("hallo")).toBe("hallo");
  });
  it("caps at the limit", () => {
    expect(truncateContent("x".repeat(3000)).length).toBe(2000);
  });
  it("never splits a surrogate pair at the boundary", () => {
    const emoji = "🏁";
    const content = "x".repeat(1999) + emoji;
    const cut = truncateContent(content);
    expect(cut.length).toBe(1999);
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false);
  });
});

describe("buildNotifyRequest", () => {
  it("builds a Discord-compatible JSON webhook POST (bold title + message as content)", () => {
    const req = buildNotifyRequest(` ${WEBHOOK} `, { title: "✅ Paket fertig", message: "Show.S01\n5 Datei(en)" });
    expect(req.url).toBe(WEBHOOK);
    expect(req.init.method).toBe("POST");
    expect(req.init.headers).toMatchObject({ "Content-Type": "application/json" });
    const body = JSON.parse(String(req.init.body));
    expect(body.content).toBe("**✅ Paket fertig**\nShow.S01\n5 Datei(en)");
    expect(body.username).toBe("Real-Debrid Downloader");
  });
  it("prepends the mention so Discord pings (bare ID gets wrapped)", () => {
    const req = buildNotifyRequest(WEBHOOK, { title: "T", message: "M", mention: "123456789012345678" });
    const body = JSON.parse(String(req.init.body));
    expect(body.content).toBe("<@123456789012345678> **T**\nM");
  });
  it("sends no mention prefix when the field is empty", () => {
    const req = buildNotifyRequest(WEBHOOK, { title: "T", message: "M", mention: "" });
    const body = JSON.parse(String(req.init.body));
    expect(body.content).toBe("**T**\nM");
  });
});

describe("sendNotification", () => {
  it("returns true on HTTP ok (Discord answers 204 No Content)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(sendNotification(WEBHOOK, { title: "T", message: "M" }, fetchFn, noSleep)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("retries a 429 using Discord's retry_after and then succeeds", async () => {
    const waits: number[] = [];
    const sleepSpy = async (ms: number): Promise<void> => { waits.push(ms); };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 1.2 }), { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(sendNotification(WEBHOOK, { title: "T", message: "M" }, fetchFn, sleepSpy)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waits).toContain(1200); // seconds -> ms
  });
  it("retries transient 5xx and network errors, then gives up", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
    await expect(sendNotification(WEBHOOK, { title: "T", message: "M" }, fetchFn, noSleep)).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries

    const fetchErr = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(sendNotification(WEBHOOK, { title: "T", message: "M" }, fetchErr, noSleep)).resolves.toBe(false);
    expect(fetchErr).toHaveBeenCalledTimes(3);
  });
  it("does not retry a permanent 4xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(sendNotification(WEBHOOK, { title: "T", message: "M" }, fetchFn, noSleep)).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent sends in order (burst protection)", async () => {
    const order: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      order.push(JSON.parse(String(init.body)).content);
      return new Response(null, { status: 204 });
    });
    const sends = [
      sendNotification(WEBHOOK, { title: "1", message: "" }, fetchFn, noSleep),
      sendNotification(WEBHOOK, { title: "2", message: "" }, fetchFn, noSleep),
      sendNotification(WEBHOOK, { title: "3", message: "" }, fetchFn, noSleep)
    ];
    await expect(Promise.all(sends)).resolves.toEqual([true, true, true]);
    expect(order).toEqual(["**1**\n", "**2**\n", "**3**\n"]);
  });
  it("does not call fetch for an invalid URL", async () => {
    const fetchFn = vi.fn();
    await expect(sendNotification("", { title: "T", message: "M" }, fetchFn, noSleep)).resolves.toBe(false);
    await expect(sendNotification("kein-url", { title: "T", message: "M" }, fetchFn, noSleep)).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
