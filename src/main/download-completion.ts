import { ALLOCATION_UNIT_SIZE } from "./constants";

export type DownloadCompletionSource =
  | "content-range"
  | "content-length"
  | "provider-metadata"
  | "stream-end";

export type DownloadCompletionPlan = {
  expectedTotal: number | null;
  source: DownloadCompletionSource;
  canFinishEarly: boolean;
};

export function planDownloadCompletion(args: {
  existingBytes: number;
  responseStatus: number;
  contentLength: number;
  totalFromRange: number | null;
  knownTotal: number | null;
  correctedTotal: number | null;
}): DownloadCompletionPlan {
  const existingBytes = Math.max(0, Math.floor(Number(args.existingBytes) || 0));
  const responseStatus = Math.floor(Number(args.responseStatus) || 0);
  const contentLength = Math.max(0, Math.floor(Number(args.contentLength) || 0));
  const totalFromRange = Number.isFinite(args.totalFromRange || NaN)
    ? Math.max(0, Math.floor(args.totalFromRange || 0))
    : 0;
  const correctedTotal = Number.isFinite(args.correctedTotal || NaN)
    ? Math.max(0, Math.floor(args.correctedTotal || 0))
    : 0;
  const knownTotal = Number.isFinite(args.knownTotal || NaN)
    ? Math.max(0, Math.floor(args.knownTotal || 0))
    : 0;

  if (correctedTotal > 0) {
    return {
      expectedTotal: correctedTotal,
      source: totalFromRange > 0 ? "content-range" : "content-length",
      canFinishEarly: true
    };
  }

  if (totalFromRange > 0) {
    return {
      expectedTotal: totalFromRange,
      source: "content-range",
      canFinishEarly: true
    };
  }

  if (contentLength > 0) {
    return {
      expectedTotal: responseStatus === 206 ? existingBytes + contentLength : contentLength,
      source: "content-length",
      canFinishEarly: true
    };
  }

  if (knownTotal > 0) {
    return {
      expectedTotal: knownTotal,
      source: "provider-metadata",
      canFinishEarly: false
    };
  }

  return {
    expectedTotal: null,
    source: "stream-end",
    canFinishEarly: false
  };
}

export function validateDownloadedFileCompletion(args: {
  actualBytes: number;
  plan: DownloadCompletionPlan;
}): {
  ok: boolean;
  totalBytes: number;
  acceptedMetadataMismatch: boolean;
  error?: string;
} {
  const actualBytes = Math.max(0, Math.floor(Number(args.actualBytes) || 0));
  const expectedTotal = Number.isFinite(args.plan.expectedTotal || NaN)
    ? Math.max(0, Math.floor(args.plan.expectedTotal || 0))
    : 0;

  if (
    expectedTotal > 0 &&
    (args.plan.source === "content-range" || args.plan.source === "content-length") &&
    actualBytes + ALLOCATION_UNIT_SIZE < expectedTotal
  ) {
    return {
      ok: false,
      totalBytes: expectedTotal,
      acceptedMetadataMismatch: false,
      error: `download_underflow:${actualBytes}/${expectedTotal}`
    };
  }

  if (actualBytes <= 0 && expectedTotal > 0) {
    return {
      ok: false,
      totalBytes: expectedTotal,
      acceptedMetadataMismatch: false,
      error: `download_underflow:${actualBytes}/${expectedTotal}`
    };
  }

  if (args.plan.source === "provider-metadata") {
    return {
      ok: true,
      totalBytes: actualBytes,
      acceptedMetadataMismatch: expectedTotal > 0 && Math.abs(actualBytes - expectedTotal) > ALLOCATION_UNIT_SIZE
    };
  }

  if (args.plan.source === "stream-end") {
    return {
      ok: true,
      totalBytes: actualBytes,
      acceptedMetadataMismatch: false
    };
  }

  return {
    ok: true,
    totalBytes: Math.max(actualBytes, expectedTotal),
    acceptedMetadataMismatch: false
  };
}
