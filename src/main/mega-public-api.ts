// Mega.nz Public API: Filename + Size aus Public-Link ohne Mega-Debrid-Account.
//
// Erlaubt Pre-Resolve von Filenames sobald Links in die Queue kommen — ohne
// Mega-Debrid-Quota anzufassen. Funktioniert fuer jeden public mega.nz Link
// (mit Decryption-Key im URL-Fragment).
//
// Protokoll: https://g.api.mega.co.nz/cs
//   Request:  POST [{"a":"g","g":1,"p":"<file-id>"}]
//   Response: [{"s": <size>, "at": <base64url encrypted attributes>, ...}]
//   Attribute-Decryption: AES-128-CBC, key = file-key[0..16], IV = 16x \0
//   Plaintext startet mit "MEGA" gefolgt von JSON: {"n": "filename.mkv", ...}
//
// Datei-Key im URL-Fragment ist 32 Bytes (base64url-encoded). Bytes 0-15
// sind der AES-Schluessel, 16-23 der CTR-Nonce, 24-31 die Meta-MAC. Fuer
// Attribut-Decryption brauchen wir nur den AES-Teil.

import crypto from "node:crypto";

const MEGA_API_BASE = "https://g.api.mega.co.nz/cs";
const MEGA_API_TIMEOUT_MS = 12_000;

export interface MegaFileInfo {
  name: string;
  size: number;
}

const NEW_FORMAT_RE = /^https?:\/\/mega\.(?:nz|co\.nz)\/file\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)/i;
const LEGACY_FORMAT_RE = /^https?:\/\/mega\.(?:nz|co\.nz)\/#!([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/i;

export function isMegaFileUrl(url: string): boolean {
  const s = String(url || "").trim();
  return NEW_FORMAT_RE.test(s) || LEGACY_FORMAT_RE.test(s);
}

function base64UrlDecode(s: string): Buffer | null {
  let b64 = String(s || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

export interface ParsedMegaLink {
  id: string;
  rawKey: Buffer;
}

export function parseMegaUrl(url: string): ParsedMegaLink | null {
  const s = String(url || "").trim();
  const m = NEW_FORMAT_RE.exec(s) || LEGACY_FORMAT_RE.exec(s);
  if (!m) return null;
  const id = m[1];
  const rawKey = base64UrlDecode(m[2]);
  // Files: 32 Bytes (256 bit). Folders: 16 Bytes — wir behandeln nur Files.
  if (!rawKey || rawKey.length !== 32) return null;
  return { id, rawKey };
}

export function decryptMegaAttributes(encrypted: Buffer, aesKey: Buffer): Record<string, unknown> | null {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length % 16 !== 0) return null;
  if (!Buffer.isBuffer(aesKey) || aesKey.length !== 16) return null;
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return null;
  }
  const text = plain.toString("utf8").replace(/\0+$/, "").trim();
  if (!text.startsWith("MEGA{")) return null;
  try {
    return JSON.parse(text.slice(4));
  } catch {
    return null;
  }
}

function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("mega-api-timeout"), timeoutMs);
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
    }
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

export async function resolveMegaFilename(
  url: string,
  signal?: AbortSignal
): Promise<MegaFileInfo | null> {
  const parsed = parseMegaUrl(url);
  if (!parsed) return null;
  const aesKey = parsed.rawKey.subarray(0, 16);

  const apiUrl = `${MEGA_API_BASE}?id=${Math.floor(Math.random() * 1e9)}`;
  const body = JSON.stringify([{ a: "g", g: 1, p: parsed.id }]);

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: withTimeoutSignal(signal, MEGA_API_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  // Mega gibt entweder ein Array mit File-Infos oder eine numerische Error-ID
  // zurueck (z.B. -9 ENOENT, -11 EACCESS, -14 EKEY, -16 EBLOCKED, -25 EOVERQUOTA).
  if (typeof payload === "number") return null;
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const first = payload[0];
  if (typeof first === "number") return null;
  if (!first || typeof first !== "object") return null;

  const info = first as { s?: unknown; at?: unknown; e?: unknown };
  if (typeof info.e === "number" && info.e !== 0) return null;

  const size = typeof info.s === "number" && info.s > 0 ? info.s : 0;
  if (typeof info.at !== "string" || !info.at.trim()) return null;

  const encryptedAttrs = base64UrlDecode(info.at);
  if (!encryptedAttrs) return null;

  const attrs = decryptMegaAttributes(encryptedAttrs, aesKey);
  if (!attrs || typeof attrs.n !== "string" || !attrs.n.trim()) return null;

  return { name: attrs.n.trim(), size };
}
