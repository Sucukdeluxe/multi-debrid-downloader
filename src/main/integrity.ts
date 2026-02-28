import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ParsedHashEntry } from "../shared/types";
import { MAX_MANIFEST_FILE_BYTES } from "./constants";

export function parseHashLine(line: string): ParsedHashEntry | null {
  const text = String(line || "").trim();
  if (!text || text.startsWith(";")) {
    return null;
  }
  const md = text.match(/^([0-9a-fA-F]{32}|[0-9a-fA-F]{40})\s+\*?(.+)$/);
  if (md) {
    const digest = md[1].toLowerCase();
    return {
      fileName: md[2].trim(),
      algorithm: digest.length === 32 ? "md5" : "sha1",
      digest
    };
  }
  const sfv = text.match(/^(.+?)\s+([0-9A-Fa-f]{8})$/);
  if (sfv) {
    return {
      fileName: sfv[1].trim(),
      algorithm: "crc32",
      digest: sfv[2].toLowerCase()
    };
  }
  return null;
}

export function readHashManifest(packageDir: string): Map<string, ParsedHashEntry> {
  const map = new Map<string, ParsedHashEntry>();
  const patterns: Array<[string, "crc32" | "md5" | "sha1"]> = [
    [".sfv", "crc32"],
    [".md5", "md5"],
    [".sha1", "sha1"]
  ];

  if (!fs.existsSync(packageDir)) {
    return map;
  }

  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    const hit = patterns.find(([pattern]) => pattern === ext);
    if (!hit) {
      continue;
    }
    const filePath = path.join(packageDir, entry.name);
    let lines: string[];
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_MANIFEST_FILE_BYTES) {
        continue;
      }
      lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      const parsed = parseHashLine(line);
      if (!parsed) {
        continue;
      }
      const normalized: ParsedHashEntry = {
        ...parsed,
        algorithm: hit[1]
      };
      map.set(parsed.fileName.toLowerCase(), normalized);
    }
  }
  return map;
}

function crc32Buffer(data: Buffer, seed = 0): number {
  let crc = seed ^ -1;
  for (let i = 0; i < data.length; i += 1) {
    let c = (crc ^ data[i]) & 0xff;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc = (crc >>> 8) ^ c;
  }
  return crc ^ -1;
}

async function hashFile(filePath: string, algorithm: "crc32" | "md5" | "sha1"): Promise<string> {
  if (algorithm === "crc32") {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    return await new Promise<string>((resolve, reject) => {
      let crc = 0;
      stream.on("data", (chunk: string | Buffer) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        crc = crc32Buffer(buffer, crc);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(((crc >>> 0).toString(16)).padStart(8, "0").toLowerCase()));
    });
  }

  const hash = crypto.createHash(algorithm);
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

export async function validateFileAgainstManifest(filePath: string, packageDir: string): Promise<{ ok: boolean; message: string }> {
  const manifest = readHashManifest(packageDir);
  if (manifest.size === 0) {
    return { ok: true, message: "Kein Hash verfügbar" };
  }
  const key = path.basename(filePath).toLowerCase();
  const entry = manifest.get(key);
  if (!entry) {
    return { ok: true, message: "Kein Hash für Datei" };
  }

  const actual = await hashFile(filePath, entry.algorithm);
  if (actual === entry.digest.toLowerCase()) {
    return { ok: true, message: `${entry.algorithm.toUpperCase()} ok` };
  }
  return { ok: false, message: `${entry.algorithm.toUpperCase()} mismatch` };
}
