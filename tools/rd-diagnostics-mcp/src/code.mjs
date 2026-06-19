const PREFIX = "rddiag:v1:";

function base64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

export function encodeConnectionCode({ host, port, token, name, fingerprint, scheme }) {
  if (!host || typeof host !== "string") throw new Error("host fehlt");
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("port ungueltig");
  if (!token || typeof token !== "string") throw new Error("token fehlt");
  const payload = { v: 1, h: host, p, t: token };
  if (name) payload.n = String(name);
  if (fingerprint) payload.fp = String(fingerprint);
  if (scheme && scheme !== "http") payload.s = String(scheme);
  return PREFIX + base64urlEncode(JSON.stringify(payload));
}

export function decodeConnectionCode(code) {
  const raw = String(code || "").trim();
  if (!raw.startsWith(PREFIX)) {
    throw new Error(`Verbindungscode muss mit "${PREFIX}" beginnen`);
  }
  let json;
  try {
    json = JSON.parse(base64urlDecode(raw.slice(PREFIX.length)));
  } catch {
    throw new Error("Verbindungscode ist beschaedigt (kein gueltiges base64url/JSON)");
  }
  if (!json || typeof json !== "object") throw new Error("Verbindungscode-Inhalt ungueltig");
  const host = String(json.h || "").trim();
  const port = Number(json.p);
  const token = String(json.t || "");
  if (!host) throw new Error("Verbindungscode ohne Host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Verbindungscode mit ungueltigem Port");
  if (!token) throw new Error("Verbindungscode ohne Token");
  const scheme = json.s === "https" ? "https" : "http";
  return {
    host,
    port,
    token,
    scheme,
    name: json.n ? String(json.n) : "",
    fingerprint: json.fp ? String(json.fp) : ""
  };
}
