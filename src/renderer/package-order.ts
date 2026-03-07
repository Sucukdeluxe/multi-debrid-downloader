import type { DownloadItem, DownloadStatus, PackageEntry } from "../shared/types";

const ACTIVE_PACKAGE_STATUSES = new Set<DownloadStatus>(["downloading", "validating", "integrity_check", "extracting"]);

export function reorderPackageOrderByDrop(order: string[], draggedPackageId: string, targetPackageId: string): string[] {
  const fromIndex = order.indexOf(draggedPackageId);
  const toIndex = order.indexOf(targetPackageId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return order;
  }
  const next = [...order];
  const [dragged] = next.splice(fromIndex, 1);
  const insertIndex = Math.max(0, Math.min(next.length, toIndex));
  next.splice(insertIndex, 0, dragged);
  return next;
}

export function sortPackageOrderByName(order: string[], packages: Record<string, PackageEntry>, descending: boolean): string[] {
  const sorted = [...order];
  sorted.sort((a, b) => {
    const nameA = (packages[a]?.name ?? "").toLowerCase();
    const nameB = (packages[b]?.name ?? "").toLowerCase();
    const cmp = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
    return descending ? -cmp : cmp;
  });
  return sorted;
}

export function sortPackagesForDisplay(
  packages: PackageEntry[],
  itemsById: Record<string, DownloadItem>,
  running: boolean,
  autoSortPackagesByProgress: boolean
): PackageEntry[] {
  if (!running || !autoSortPackagesByProgress || packages.length <= 1) {
    return packages;
  }

  const active: Array<{ pkg: PackageEntry; index: number; completedRatio: number; downloadedBytes: number }> = [];
  const rest: PackageEntry[] = [];

  packages.forEach((pkg, index) => {
    const items = pkg.itemIds
      .map((id) => itemsById[id])
      .filter((item): item is DownloadItem => Boolean(item));
    const hasActive = items.some((item) => ACTIVE_PACKAGE_STATUSES.has(item.status));
    if (!hasActive) {
      rest.push(pkg);
      return;
    }
    const completedRatio = items.length > 0
      ? items.filter((item) => item.status === "completed").length / items.length
      : 0;
    const downloadedBytes = items.reduce((sum, item) => sum + (item.downloadedBytes || 0), 0);
    active.push({ pkg, index, completedRatio, downloadedBytes });
  });

  if (active.length === 0 || active.length === packages.length) {
    return packages;
  }

  active.sort((a, b) => {
    if (a.completedRatio !== b.completedRatio) {
      return b.completedRatio - a.completedRatio;
    }
    if (a.downloadedBytes !== b.downloadedBytes) {
      return b.downloadedBytes - a.downloadedBytes;
    }
    return a.index - b.index;
  });

  return [...active.map((entry) => entry.pkg), ...rest];
}
