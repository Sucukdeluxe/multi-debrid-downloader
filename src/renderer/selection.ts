import type { SessionState } from "../shared/types";

/**
 * Drop selected ids whose package OR item no longer exists in the session.
 * The selection set mixes package and item ids; when entries vanish (delta
 * removal, backup-driven session swap, completed-cleanup) a stale id would
 * otherwise inflate the selection count and the "(N)" action labels and keep
 * "multi" styling alive for ghosts.
 *
 * Returns the SAME set instance when nothing changed, so callers can use it
 * directly as a React state updater without forcing a re-render.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  session: Pick<SessionState, "packages" | "items">
): Set<string> {
  if (selected.size === 0) {
    return selected as Set<string>;
  }
  const next = new Set<string>();
  for (const id of selected) {
    if (session.packages[id] || session.items[id]) {
      next.add(id);
    }
  }
  return next.size === selected.size ? (selected as Set<string>) : next;
}
