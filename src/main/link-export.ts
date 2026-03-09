import type { ParsedPackageInput, UiSnapshot } from "../shared/types";
import { sanitizeFilename } from "./utils";

export type LinkExportSelection = {
  packages: ParsedPackageInput[];
  packageCount: number;
  linkCount: number;
  defaultFileName: string;
};

function formatTimestampForFileName(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
}

function buildDefaultFileName(packages: ParsedPackageInput[]): string {
  if (packages.length === 1) {
    const only = packages[0];
    if (only.links.length === 1) {
      const itemName = sanitizeFilename(only.fileNames?.[0] || only.name || "link-export");
      return `${itemName}.txt`;
    }
    return `${sanitizeFilename(only.name || "paket-export")}.txt`;
  }
  return `rd-link-export-${formatTimestampForFileName(new Date())}.txt`;
}

export function buildLinkExportSelection(snapshot: UiSnapshot, packageIds: string[], itemIds: string[]): LinkExportSelection {
  const selectedPackageIds = new Set(packageIds);
  const selectedItemIds = new Set(itemIds);
  const packages: ParsedPackageInput[] = [];

  for (const packageId of snapshot.session.packageOrder) {
    const pkg = snapshot.session.packages[packageId];
    if (!pkg) {
      continue;
    }

    const useWholePackage = selectedPackageIds.has(packageId);
    const relevantItemIds = useWholePackage
      ? pkg.itemIds
      : pkg.itemIds.filter((itemId) => selectedItemIds.has(itemId));

    if (relevantItemIds.length === 0) {
      continue;
    }

    const links: string[] = [];
    const fileNames: string[] = [];
    for (const itemId of relevantItemIds) {
      const item = snapshot.session.items[itemId];
      if (!item || !String(item.url || "").trim()) {
        continue;
      }
      links.push(String(item.url).trim());
      const rawFileName = String(item.fileName || "").trim();
      fileNames.push(rawFileName ? sanitizeFilename(rawFileName) : "");
    }

    if (links.length === 0) {
      continue;
    }

    const exportEntry: ParsedPackageInput = {
      name: sanitizeFilename(pkg.name || "Paket"),
      links
    };
    if (fileNames.some((fileName) => fileName.length > 0)) {
      exportEntry.fileNames = fileNames;
    }
    packages.push(exportEntry);
  }

  const linkCount = packages.reduce((sum, pkg) => sum + pkg.links.length, 0);
  return {
    packages,
    packageCount: packages.length,
    linkCount,
    defaultFileName: buildDefaultFileName(packages)
  };
}

export function serializeLinkExportText(packages: ParsedPackageInput[]): string {
  const lines: string[] = [
    "# rd-link-export: 1",
    "# Re-import in Real-Debrid-Downloader keeps package names and optional file names.",
    ""
  ];

  for (const pkg of packages) {
    if (!pkg || !pkg.name || !Array.isArray(pkg.links) || pkg.links.length === 0) {
      continue;
    }
    lines.push(`# package: ${sanitizeFilename(pkg.name)}`);
    for (let index = 0; index < pkg.links.length; index += 1) {
      const link = String(pkg.links[index] || "").trim();
      if (!link) {
        continue;
      }
      const rawFileName = String(pkg.fileNames?.[index] || "").trim();
      const fileName = rawFileName ? sanitizeFilename(rawFileName) : "";
      if (fileName) {
        lines.push(`# file: ${fileName}`);
      }
      lines.push(link);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}
