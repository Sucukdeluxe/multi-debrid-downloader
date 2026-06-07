export interface ErrorRingEntry {
  ts: string;
  level: string;
  message: string;
}

export interface ErrorRing {
  push: (entry: ErrorRingEntry) => void;
  snapshot: () => ErrorRingEntry[];
  clear: () => void;
  size: () => number;
}

export function createErrorRing(capacity: number): ErrorRing {
  const limit = Math.max(1, Math.floor(capacity));
  const buffer: ErrorRingEntry[] = [];
  return {
    push(entry: ErrorRingEntry): void {
      buffer.push(entry);
      while (buffer.length > limit) {
        buffer.shift();
      }
    },
    snapshot(): ErrorRingEntry[] {
      return buffer.slice();
    },
    clear(): void {
      buffer.length = 0;
    },
    size(): number {
      return buffer.length;
    }
  };
}

const RECENT_ERROR_CAPACITY = 200;
const recentErrors = createErrorRing(RECENT_ERROR_CAPACITY);

export function recordRecentError(level: string, message: string, ts: string): void {
  recentErrors.push({ level, message, ts });
}

export function getRecentErrors(): ErrorRingEntry[] {
  return recentErrors.snapshot();
}
