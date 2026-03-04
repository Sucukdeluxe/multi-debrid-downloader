import type { PackageEntry } from "../shared/types";

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
