import fs from "node:fs";
import path from "node:path";

const PREFIX = "rddiag:v1:";

function base64urlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface ConnectionCodeInput {
  host: string;
  port: number;
  token: string;
  name?: string;
  scheme?: "http" | "https";
  fingerprint?: string;
}

export function encodeConnectionCode(input: ConnectionCodeInput): string {
  const host = String(input.host || "").trim();
  if (!host) throw new Error("Host fehlt fuer Verbindungscode");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port ungueltig fuer Verbindungscode");
  if (!input.token) throw new Error("Token fehlt fuer Verbindungscode");
  const payload: Record<string, unknown> = { v: 1, h: host, p: port, t: input.token };
  if (input.name) payload.n = String(input.name);
  if (input.fingerprint) payload.fp = String(input.fingerprint);
  if (input.scheme && input.scheme !== "http") payload.s = String(input.scheme);
  return PREFIX + base64urlEncode(JSON.stringify(payload));
}

export interface RemoteMeta {
  publicHost: string;
  name: string;
}

function remoteMetaPath(baseDir: string): string {
  return path.join(baseDir, "debug_remote.json");
}

export function loadRemoteMeta(baseDir: string): RemoteMeta {
  try {
    const parsed = JSON.parse(fs.readFileSync(remoteMetaPath(baseDir), "utf8"));
    return {
      publicHost: String(parsed.publicHost || ""),
      name: String(parsed.name || "")
    };
  } catch {
    return { publicHost: "", name: "" };
  }
}

export function saveRemoteMeta(baseDir: string, meta: RemoteMeta): void {
  fs.writeFileSync(remoteMetaPath(baseDir), JSON.stringify({ publicHost: meta.publicHost, name: meta.name }, null, 2), "utf8");
}
