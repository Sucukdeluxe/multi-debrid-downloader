import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ParsedHashEntry } from "../shared/types";
import { MAX_MANIFEST_FILE_BYTES } from "./constants";

const manifestCache = new Map<string, { at: number; entries: Map<string, ParsedHashEntry> }>();
const MANIFEST_CACHE_TTL_MS = 15000;

function normalizeManifestKey(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}

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
  const cacheKey = path.resolve(packageDir);
  const cached = manifestCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= MANIFEST_CACHE_TTL_MS) {
    return new Map(cached.entries);
  }

  const map = new Map<string, ParsedHashEntry>();
  const patterns: Array<[string, "crc32" | "md5" | "sha1"]> = [
    [".sfv", "crc32"],
    [".md5", "md5"],
    [".sha1", "sha1"]
  ];

  if (!fs.existsSync(packageDir)) {
    return map;
  }

  const manifestFiles = fs.readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) {
        return false;
      }
      const ext = path.extname(entry.name).toLowerCase();
      return patterns.some(([pattern]) => pattern === ext);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  for (const entry of manifestFiles) {
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
      const key = normalizeManifestKey(parsed.fileName);
      if (map.has(key)) {
        continue;
      }
      map.set(key, normalized);
    }
  }
  manifestCache.set(cacheKey, { at: Date.now(), entries: new Map(map) });
  return map;
}

const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}

function crc32Buffer(data: Buffer, seed = 0): number {
  let crc = seed ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
  }
  return crc ^ -1;
}

async function hashFile(filePath: string, algorithm: "crc32" | "md5" | "sha1"): Promise<string> {
  if (algorithm === "crc32") {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let crc = 0;
    for await (const chunk of stream) {
      crc = crc32Buffer(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), crc);
      await new Promise(r => setImmediate(r));
    }
    return (crc >>> 0).toString(16).padStart(8, "0").toLowerCase();
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
  const keyByBaseName = normalizeManifestKey(path.basename(filePath));
  const keyByRelativePath = normalizeManifestKey(path.relative(packageDir, filePath));
  const entry = manifest.get(keyByRelativePath) || manifest.get(keyByBaseName);
  if (!entry) {
    return { ok: true, message: "Kein Hash für Datei" };
  }

  const actual = await hashFile(filePath, entry.algorithm);
  if (actual === entry.digest.toLowerCase()) {
    return { ok: true, message: `${entry.algorithm.toUpperCase()} ok` };
  }
  return { ok: false, message: `${entry.algorithm.toUpperCase()} mismatch` };
}
