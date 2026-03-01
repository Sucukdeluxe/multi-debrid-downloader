import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DCRYPT_PASTE_URL, DCRYPT_UPLOAD_URL, DLC_AES_IV, DLC_AES_KEY, DLC_SERVICE_URL } from "./constants";
import { compactErrorText, inferPackageNameFromLinks, isHttpLink, sanitizeFilename, uniquePreserveOrder } from "./utils";
import { ParsedPackageInput } from "../shared/types";

const MAX_DLC_FILE_BYTES = 8 * 1024 * 1024;

function isContainerSizeValidationError(error: unknown): boolean {
  const text = compactErrorText(error);
  return /zu groß/i.test(text) || /DLC-Datei ungültig oder zu groß/i.test(text);
}

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
    const fileNames: string[] = [];
    const fileRegex = /<file>([\s\S]*?)<\/file>/gi;
    for (let fm = fileRegex.exec(packageBody); fm; fm = fileRegex.exec(packageBody)) {
      const fileBody = fm[1] || "";
      const urlMatch = fileBody.match(/<url>(.*?)<\/url>/i);
      if (!urlMatch) {
        continue;
      }
      try {
        const url = Buffer.from((urlMatch[1] || "").trim(), "base64").toString("utf8").trim();
        if (!isHttpLink(url)) {
          continue;
        }
        let fileName = "";
        const fnMatch = fileBody.match(/<filename>(.*?)<\/filename>/i);
        if (fnMatch?.[1]) {
          try {
            fileName = Buffer.from(fnMatch[1].trim(), "base64").toString("utf8").trim();
          } catch {
            // ignore
          }
        }
        links.push(url);
        fileNames.push(sanitizeFilename(fileName));
      } catch {
        // skip broken entries
      }
    }

    if (links.length === 0) {
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
    }

    const uniqueLinks = uniquePreserveOrder(links);
    const hasFileNames = fileNames.some((fn) => fn.length > 0);
    if (uniqueLinks.length > 0) {
      const pkg: ParsedPackageInput = {
        name: sanitizeFilename(packageName || inferPackageNameFromLinks(uniqueLinks) || `Paket-${packages.length + 1}`),
        links: uniqueLinks
      };
      if (hasFileNames) {
        pkg.fileNames = fileNames;
      }
      packages.push(pkg);
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
    return [];
  }
  const pad = decrypted[decrypted.length - 1];
  if (pad > 0 && pad <= 16 && pad <= decrypted.length) {
    let validPad = true;
    for (let index = 1; index <= pad; index += 1) {
      if (decrypted[decrypted.length - index] !== pad) {
        validPad = false;
        break;
      }
    }
    if (validPad) {
      decrypted = decrypted.subarray(0, decrypted.length - pad);
    }
  }

  const xmlData = Buffer.from(decrypted.toString("utf8"), "base64").toString("utf8");
  return parsePackagesFromDlcXml(xmlData);
}

function extractLinksFromResponse(text: string): string[] {
  const payload = decodeDcryptPayload(text);
  let links = extractUrlsRecursive(payload);
  if (links.length === 0) {
    links = extractUrlsRecursive(text);
  }
  return uniquePreserveOrder(links.filter((l) => isHttpLink(l)));
}

async function tryDcryptUpload(fileContent: Buffer, fileName: string): Promise<string[] | null> {
  const blob = new Blob([new Uint8Array(fileContent)]);
  const form = new FormData();
  form.set("dlcfile", blob, fileName);

  const response = await fetch(DCRYPT_UPLOAD_URL, {
    method: "POST",
    body: form
  });
  if (response.status === 413) {
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(compactErrorText(text));
  }
  return extractLinksFromResponse(text);
}

async function tryDcryptPaste(fileContent: Buffer): Promise<string[] | null> {
  const form = new FormData();
  form.set("content", fileContent.toString("ascii"));

  const response = await fetch(DCRYPT_PASTE_URL, {
    method: "POST",
    body: form
  });
  if (response.status === 413) {
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(compactErrorText(text));
  }
  return extractLinksFromResponse(text);
}

async function decryptDlcViaDcrypt(filePath: string): Promise<ParsedPackageInput[]> {
  const fileContent = readDlcFileWithLimit(filePath);
  const fileName = path.basename(filePath);
  const packageName = sanitizeFilename(path.basename(filePath, ".dlc")) || "Paket";

  let links = await tryDcryptUpload(fileContent, fileName);
  if (links === null) {
    links = await tryDcryptPaste(fileContent);
  }
  if (links === null) {
    throw new Error("DLC-Datei zu groß für dcrypt.it");
  }
  if (links.length === 0) {
    return [];
  }
  return [{ name: packageName, links }];
}

export async function importDlcContainers(filePaths: string[]): Promise<ParsedPackageInput[]> {
  const out: ParsedPackageInput[] = [];
  const failures: string[] = [];
  let sawDlc = false;
  for (const filePath of filePaths) {
    if (path.extname(filePath).toLowerCase() !== ".dlc") {
      continue;
    }
    sawDlc = true;
    let packages: ParsedPackageInput[] = [];
    let fileFailed = false;
    let fileFailureReasons: string[] = [];
    try {
      packages = await decryptDlcLocal(filePath);
    } catch (error) {
      if (isContainerSizeValidationError(error)) {
        failures.push(`${path.basename(filePath)}: ${compactErrorText(error)}`);
        continue;
      }
      fileFailed = true;
      fileFailureReasons.push(`lokal: ${compactErrorText(error)}`);
      packages = [];
    }
    if (packages.length === 0) {
      try {
        packages = await decryptDlcViaDcrypt(filePath);
      } catch (error) {
        if (isContainerSizeValidationError(error)) {
          failures.push(`${path.basename(filePath)}: ${compactErrorText(error)}`);
          continue;
        }
        fileFailed = true;
        fileFailureReasons.push(`dcrypt: ${compactErrorText(error)}`);
        packages = [];
      }
    }
    if (packages.length === 0 && fileFailed) {
      failures.push(`${path.basename(filePath)}: ${fileFailureReasons.join("; ")}`);
    }
    out.push(...packages);
  }

  if (out.length === 0 && sawDlc && failures.length > 0) {
    const details = failures.slice(0, 2).join(" | ");
    const suffix = failures.length > 2 ? ` (+${failures.length - 2} weitere)` : "";
    throw new Error(`DLC konnte nicht importiert werden: ${details}${suffix}`);
  }

  return out;
}
