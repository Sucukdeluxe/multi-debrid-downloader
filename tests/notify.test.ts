import { describe, expect, it, vi } from "vitest";
import { buildNotifyRequest, isNotifyUrlValid, sendNotification } from "../src/main/notify";

describe("isNotifyUrlValid", () => {
  it("accepts http/https URLs", () => {
    expect(isNotifyUrlValid("https://ntfy.sh/mein-topic")).toBe(true);
    expect(isNotifyUrlValid("http://192.168.1.10:8080/hook")).toBe(true);
    expect(isNotifyUrlValid("  https://ntfy.sh/topic  ")).toBe(true);
  });
  it("rejects empty and non-http values", () => {
    expect(isNotifyUrlValid("")).toBe(false);
    expect(isNotifyUrlValid("ntfy.sh/topic")).toBe(false);
    expect(isNotifyUrlValid("ftp://x")).toBe(false);
    expect(isNotifyUrlValid("https:// mit leerzeichen")).toBe(false);
  });
});

describe("buildNotifyRequest", () => {
  it("builds an ntfy-style POST with title/priority/tags headers and message body", () => {
    const req = buildNotifyRequest(" https://ntfy.sh/topic ", { title: "Paket fertig", message: "Show.S01\n5 Datei(en)", priority: "high", tags: "x" });
    expect(req.url).toBe("https://ntfy.sh/topic");
    expect(req.init.method).toBe("POST");
    expect(req.init.body).toBe("Show.S01\n5 Datei(en)");
    expect(req.init.headers).toMatchObject({ Title: "Paket fertig", Priority: "high", Tags: "x" });
  });
  it("omits default priority and empty tags", () => {
    const req = buildNotifyRequest("https://ntfy.sh/topic", { title: "T", message: "M", priority: "default" });
    expect(req.init.headers).not.toHaveProperty("Priority");
    expect(req.init.headers).not.toHaveProperty("Tags");
  });
});

describe("sendNotification", () => {
  it("returns true on HTTP ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await expect(sendNotification("https://ntfy.sh/topic", { title: "T", message: "M" }, fetchFn)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("returns false on HTTP error without throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    await expect(sendNotification("https://ntfy.sh/topic", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
  });
  it("returns false on network error without throwing", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(sendNotification("https://ntfy.sh/topic", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
  });
  it("does not call fetch for an invalid URL", async () => {
    const fetchFn = vi.fn();
    await expect(sendNotification("", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
    await expect(sendNotification("kein-url", { title: "T", message: "M" }, fetchFn)).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
