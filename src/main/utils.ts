import path from "node:path";
import { ParsedPackageInput } from "../shared/types";

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const WINDOWS_RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);

export function compactErrorText(message: unknown, maxLen = 220): string {
  const raw = String(message ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) {
    return "Unbekannter Fehler";
  }
  const safeMaxLen = Number.isFinite(maxLen) ? Math.max(4, Math.floor(maxLen)) : 220;
  if (raw.length <= safeMaxLen) {
    return raw;
  }
  return `${raw.slice(0, safeMaxLen - 3)}...`;
}

export function sanitizeFilename(name: string): string {
  const cleaned = String(name || "")
    .replace(/\0/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let normalized = cleaned
    .replace(/^[.\s]+/g, "")
    .replace(/[.\s]+$/g, "")
    .trim();

  if (!normalized || normalized === "." || normalized === ".." || /^\.+$/.test(normalized)) {
    return "Paket";
  }

  const parsed = path.parse(normalized);
  const reservedBase = (parsed.name.split(".")[0] || parsed.name).toLowerCase();
  if (WINDOWS_RESERVED_BASENAMES.has(reservedBase)) {
    normalized = `${parsed.name.replace(/^([^.]*)/, "$1_")}${parsed.ext}`;
  }

  return normalized || "Paket";
}

export function isHttpLink(value: string): boolean {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

export function extractHttpLinksFromText(text: string): string[] {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const seen = new Set<string>();
  const links: string[] = [];

  for (const match of matches) {
    let candidate = String(match || "").trim();
    let openParen = 0;
    let closeParen = 0;
    let openBracket = 0;
    let closeBracket = 0;
    for (const char of candidate) {
      if (char === "(") {
        openParen += 1;
      } else if (char === ")") {
        closeParen += 1;
      } else if (char === "[") {
        openBracket += 1;
      } else if (char === "]") {
        closeBracket += 1;
      }
    }
    while (candidate.length > 0) {
      const lastChar = candidate[candidate.length - 1];
      if (![")", "]", ",", ".", "!", "?", ";", ":"].includes(lastChar)) {
        break;
      }
      if (lastChar === ")") {
        if (closeParen <= openParen) {
          break;
        }
      }
      if (lastChar === "]") {
        if (closeBracket <= openBracket) {
          break;
        }
      }
      if (lastChar === ")") {
        closeParen = Math.max(0, closeParen - 1);
      } else if (lastChar === "]") {
        closeBracket = Math.max(0, closeBracket - 1);
      }
      candidate = candidate.slice(0, -1);
    }
    if (!candidate || !isHttpLink(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    links.push(candidate);
  }

  return links;
}

export function humanSize(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

export function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "download.bin";
    }
    const queryName = parsed.searchParams.get("filename")
      || parsed.searchParams.get("file")
      || parsed.searchParams.get("name")
      || parsed.searchParams.get("download")
      || parsed.searchParams.get("title")
      || "";
    const rawName = queryName || path.basename(parsed.pathname || "");
    const decoded = safeDecodeURIComponent(rawName || "").trim();
    const normalized = decoded
      .replace(/\.(rar|zip|7z|tar|gz|bz2|xz|iso|part\d+\.rar|r\d{2,3})\.html$/i, ".$1")
      .replace(/\.(mp4|mkv|avi|mp3|flac|srt)\.html$/i, ".$1");
    return sanitizeFilename(normalized || "download.bin");
  } catch {
    return "download.bin";
  }
}

export function looksLikeOpaqueFilename(name: string): boolean {
  const cleaned = sanitizeFilename(name || "").toLowerCase();
  if (!cleaned || cleaned === "download.bin") {
    return true;
  }
  const parsed = path.parse(cleaned);
  return /^[a-f0-9]{24,}$/i.test(parsed.name || cleaned);
}

export function inferPackageNameFromLinks(links: string[]): string {
  if (links.length === 0) {
    return "Paket";
  }
  const names = links.map((link) => filenameFromUrl(link).toLowerCase());
  const first = names[0];
  const match = first.match(/^([a-z0-9._\- ]{3,80}?)(?:\.|-|_)(?:part\d+|r\d{2}|s\d{2}e\d{2})/i);
  if (match) {
    return sanitizeFilename(match[1]);
  }
  return sanitizeFilename(path.parse(first).name || "Paket");
}

export function uniquePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function parsePackagesFromLinksText(rawText: string, defaultPackageName: string): ParsedPackageInput[] {
  const lines = String(rawText || "").split(/\r?\n/);
  const packages: ParsedPackageInput[] = [];
  let currentName = String(defaultPackageName || "").trim();
  let currentLinks: string[] = [];
  let currentFileNames: string[] = [];
  let pendingFileName = "";

  const flush = (): void => {
    const links = uniquePreserveOrder(currentLinks.filter((line) => isHttpLink(line)));
    if (links.length > 0) {
      const normalizedCurrentName = String(currentName || "").trim();
      const fileNames = links.map((link) => {
        const firstIndex = currentLinks.findIndex((currentLink) => currentLink === link);
        return firstIndex >= 0 ? currentFileNames[firstIndex] || "" : "";
      });
      const nextPackage: ParsedPackageInput = {
        name: normalizedCurrentName
          ? sanitizeFilename(normalizedCurrentName)
          : inferPackageNameFromLinks(links),
        links
      };
      if (fileNames.some((fileName) => fileName.trim().length > 0)) {
        nextPackage.fileNames = fileNames;
      }
      packages.push(nextPackage);
    }
    currentLinks = [];
    currentFileNames = [];
    pendingFileName = "";
  };

  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    const marker = text.match(/^#\s*package\s*:\s*(.+)$/i);
    if (marker) {
      flush();
      currentName = String(marker[1] || "").trim();
      pendingFileName = "";
      continue;
    }
    const fileMarker = text.match(/^#\s*file\s*:\s*(.+)$/i);
    if (fileMarker) {
      pendingFileName = sanitizeFilename(String(fileMarker[1] || "").trim());
      continue;
    }
    if (!isHttpLink(text)) {
      continue;
    }
    currentLinks.push(text);
    currentFileNames.push(pendingFileName);
    pendingFileName = "";
  }

  flush();
  if (packages.length === 0) {
    return [];
  }
  return packages;
}

export function ensureDirPath(baseDir: string, packageName: string): string {
  if (!path.isAbsolute(baseDir)) {
    throw new Error("baseDir muss ein absoluter Pfad sein");
  }
  return path.join(baseDir, sanitizeFilename(packageName));
}

export function nowMs(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--";
  }
  const s = Math.floor(seconds);
  const sec = s % 60;
  const minTotal = Math.floor(s / 60);
  const min = minTotal % 60;
  const hr = Math.floor(minTotal / 60);
  if (hr > 0) {
    return `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
