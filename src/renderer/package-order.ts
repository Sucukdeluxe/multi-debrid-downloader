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

  const active: PackageEntry[] = [];
  const rest: PackageEntry[] = [];

  // Float packages that have an active item to the top, but keep BOTH groups in
  // their original (queue) order. Earlier this sorted the active group by live
  // completedRatio/downloadedBytes — which change on every progress tick (every
  // 150-700ms), so active packages visibly reshuffled the whole time. A package
  // entering/leaving the active bucket is a real, discrete event (start/finish);
  // ranking *within* the bucket by live bytes was pure jitter nobody needs.
  for (const pkg of packages) {
    const hasActive = pkg.itemIds.some((id) => {
      const item = itemsById[id];
      return item != null && ACTIVE_PACKAGE_STATUSES.has(item.status);
    });
    (hasActive ? active : rest).push(pkg);
  }

  if (active.length === 0 || active.length === packages.length) {
    return packages;
  }

  return [...active, ...rest];
}
