import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DCRYPT_UPLOAD_URL, DLC_AES_IV, DLC_AES_KEY, DLC_SERVICE_URL } from "./constants";
import { compactErrorText, inferPackageNameFromLinks, isHttpLink, sanitizeFilename, uniquePreserveOrder } from "./utils";
import { ParsedPackageInput } from "../shared/types";

const MAX_DLC_FILE_BYTES = 8 * 1024 * 1024;

function decodeDcryptPayload(responseText: string): unknown {
  let text = String(responseText || "").trim();
  const m = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  if (m) {
    text = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
  }
  if (!text) {
    return "";
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractUrlsRecursive(data: unknown): string[] {
  if (typeof data === "string") {
    const found = data.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    return uniquePreserveOrder(found.filter((url) => isHttpLink(url)));
  }
  if (Array.isArray(data)) {
    return uniquePreserveOrder(data.flatMap((item) => extractUrlsRecursive(item)));
  }
  if (data && typeof data === "object") {
    return uniquePreserveOrder(Object.values(data as Record<string, unknown>).flatMap((value) => extractUrlsRecursive(value)));
  }
  return [];
}

function groupLinksByName(links: string[]): ParsedPackageInput[] {
  const unique = uniquePreserveOrder(links.filter((link) => isHttpLink(link)));
  const grouped = new Map<string, string[]>();
  for (const link of unique) {
    const name = sanitizeFilename(inferPackageNameFromLinks([link]) || "Paket");
    const current = grouped.get(name) ?? [];
    current.push(link);
    grouped.set(name, current);
  }
  return Array.from(grouped.entries()).map(([name, packageLinks]) => ({ name, links: packageLinks }));
}

function extractPackagesFromPayload(payload: unknown): ParsedPackageInput[] {
  const urls = extractUrlsRecursive(payload);
  if (urls.length === 0) {
    return [];
  }
  return groupLinksByName(urls);
}

function decryptRcPayload(base64Rc: string): Buffer {
  const rcBytes = Buffer.from(base64Rc, "base64");
  const decipher = crypto.createDecipheriv("aes-128-cbc", DLC_AES_KEY, DLC_AES_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(rcBytes), decipher.final()]);
}

function readDlcFileWithLimit(filePath: string): Buffer {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0 || stat.size > MAX_DLC_FILE_BYTES) {
    throw new Error(`DLC-Datei ungültig oder zu groß (${Math.floor(stat.size)} B)`);
  }
  return fs.readFileSync(filePath);
}

function parsePackagesFromDlcXml(xml: string): ParsedPackageInput[] {
  const packages: ParsedPackageInput[] = [];
  const packageRegex = /<package\s+[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/gi;

  for (let m = packageRegex.exec(xml); m; m = packageRegex.exec(xml)) {
    const encodedName = m[1] || "";
    const packageBody = m[2] || "";
    let packageName = "";
    if (encodedName) {
      try {
        packageName = Buffer.from(encodedName, "base64").toString("utf8");
      } catch {
        packageName = encodedName;
      }
    }

    const links: string[] = [];
    const urlRegex = /<url>(.*?)<\/url>/gi;
    for (let um = urlRegex.exec(packageBody); um; um = urlRegex.exec(packageBody)) {
      try {
        const url = Buffer.from((um[1] || "").trim(), "base64").toString("utf8").trim();
        if (isHttpLink(url)) {
          links.push(url);
        }
      } catch {
        // skip broken entries
      }
    }

    const uniqueLinks = uniquePreserveOrder(links);
    if (uniqueLinks.length > 0) {
      packages.push({
        name: sanitizeFilename(packageName || inferPackageNameFromLinks(uniqueLinks) || `Paket-${packages.length + 1}`),
        links: uniqueLinks
      });
    }
  }

  return packages;
}

async function decryptDlcLocal(filePath: string): Promise<ParsedPackageInput[]> {
  const content = readDlcFileWithLimit(filePath).toString("ascii").trim();
  if (content.length < 89) {
    return [];
  }

  const dlcKey = content.slice(-88);
  const dlcData = content.slice(0, -88);

  const rcUrl = DLC_SERVICE_URL.replace("{KEY}", encodeURIComponent(dlcKey));
  const rcResponse = await fetch(rcUrl, { method: "GET" });
  if (!rcResponse.ok) {
    return [];
  }
  const rcText = await rcResponse.text();
  const rcMatch = rcText.match(/<rc>(.*?)<\/rc>/i);
  if (!rcMatch) {
    return [];
  }

  const realKey = decryptRcPayload(rcMatch[1]).subarray(0, 16);
  const encrypted = Buffer.from(dlcData, "base64");
  const decipher = crypto.createDecipheriv("aes-128-cbc", realKey, realKey);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  if (decrypted.length === 0) {
    throw new Error("DLC-Entschlüsselung lieferte keine Daten");
  }
  const pad = decrypted[decrypted.length - 1];
  if (pad <= 0 || pad > 16 || pad > decrypted.length) {
    throw new Error("Ungültiges DLC-Padding");
  }
  for (let index = 1; index <= pad; index += 1) {
    if (decrypted[decrypted.length - index] !== pad) {
      throw new Error("Ungültiges DLC-Padding");
    }
  }
  decrypted = decrypted.subarray(0, decrypted.length - pad);

  const xmlData = Buffer.from(decrypted.toString("utf8"), "base64").toString("utf8");
  return parsePackagesFromDlcXml(xmlData);
}

async function decryptDlcViaDcrypt(filePath: string): Promise<ParsedPackageInput[]> {
  const fileName = path.basename(filePath);
  const blob = new Blob([new Uint8Array(readDlcFileWithLimit(filePath))]);
  const form = new FormData();
  form.set("dlcfile", blob, fileName);

  const response = await fetch(DCRYPT_UPLOAD_URL, {
    method: "POST",
    body: form
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(compactErrorText(text));
  }
  const payload = decodeDcryptPayload(text);
  let packages = extractPackagesFromPayload(payload);
  if (packages.length === 1) {
    const regrouped = groupLinksByName(packages[0].links);
    if (regrouped.length > 1) {
      packages = regrouped;
    }
  }
  if (packages.length === 0) {
    packages = groupLinksByName(extractUrlsRecursive(text));
  }
  return packages;
}

export async function importDlcContainers(filePaths: string[]): Promise<ParsedPackageInput[]> {
  const out: ParsedPackageInput[] = [];
  for (const filePath of filePaths) {
    if (path.extname(filePath).toLowerCase() !== ".dlc") {
      continue;
    }
    let packages: ParsedPackageInput[] = [];
    try {
      packages = await decryptDlcLocal(filePath);
    } catch {
      packages = [];
    }
    if (packages.length === 0) {
      packages = await decryptDlcViaDcrypt(filePath);
    }
    out.push(...packages);
  }
  return out;
}
