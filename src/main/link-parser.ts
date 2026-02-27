import { ParsedPackageInput } from "../shared/types";
import { inferPackageNameFromLinks, parsePackagesFromLinksText, sanitizeFilename, uniquePreserveOrder } from "./utils";

export function mergePackageInputs(packages: ParsedPackageInput[]): ParsedPackageInput[] {
  const grouped = new Map<string, string[]>();
  for (const pkg of packages) {
    const name = sanitizeFilename(pkg.name || inferPackageNameFromLinks(pkg.links));
    const list = grouped.get(name) ?? [];
    list.push(...pkg.links);
    grouped.set(name, list);
  }
  return Array.from(grouped.entries()).map(([name, links]) => ({
    name,
    links: uniquePreserveOrder(links)
  }));
}

export function parseCollectorInput(rawText: string, packageName = ""): ParsedPackageInput[] {
  const parsed = parsePackagesFromLinksText(rawText, packageName);
  if (parsed.length === 0) {
    return [];
  }
  return mergePackageInputs(parsed);
}
