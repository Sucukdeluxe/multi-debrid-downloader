import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { logTimestamp } from "./log-timestamp";

export interface ConversionPhase {
  atMs: number;
  phase: string;
  provider?: string;
  account?: string;
  tokenState?: string;
  queueWaitMs?: number;
  workMs?: number;
  outcome?: string;
  detail?: string;
}

export interface ConversionTrace {
  startedAt: number;
  itemId: string;
  itemName: string;
  link: string;
  providerOrder: string;
  notes: Record<string, string | number>;
  phases: ConversionPhase[];
}

const conversionContext = new AsyncLocalStorage<ConversionTrace>();

function shortLink(link: string): string {
  const raw = String(link || "").trim();
  return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
}

export function traceConversionPhase(phase: Omit<ConversionPhase, "atMs">): void {
  const trace = conversionContext.getStore();
  if (!trace) {
    return;
  }
  trace.phases.push({ ...phase, atMs: Date.now() - trace.startedAt });
}

export function traceConversionNote(key: string, value: string | number): void {
  const trace = conversionContext.getStore();
  if (!trace) {
    return;
  }
  trace.notes[key] = value;
}

export function hasActiveConversionTrace(): boolean {
  return conversionContext.getStore() !== undefined;
}

export function formatConversionBlock(
  trace: ConversionTrace,
  outcome: string,
  detail: string,
  totalMs: number
): string {
  const noteParts = Object.entries(trace.notes)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const header = `${logTimestamp()} [CONV] item=${trace.itemName || trace.itemId} | order=${trace.providerOrder || "?"}`
    + ` | result=${outcome}${detail ? ` (${detail})` : ""} | total=${totalMs}ms${noteParts ? ` | ${noteParts}` : ""}`
    + ` | link=${shortLink(trace.link)}`;
  const lines = trace.phases.map((p) => {
    const parts: string[] = [];
    if (p.provider) parts.push(`provider=${p.provider}`);
    if (p.account) parts.push(`account=${p.account}`);
    if (p.tokenState) parts.push(`token=${p.tokenState}`);
    if (typeof p.queueWaitMs === "number") parts.push(`queueWaitMs=${p.queueWaitMs}`);
    if (typeof p.workMs === "number") parts.push(`workMs=${p.workMs}`);
    if (p.outcome) parts.push(`outcome=${p.outcome}`);
    if (p.detail) parts.push(`detail=${String(p.detail).replace(/\r?\n/g, "\\n")}`);
    return `    +${p.atMs}ms ${p.phase}${parts.length ? ` | ${parts.join(" | ")}` : ""}`;
  });
  return [header, ...lines].join("\n");
}

const CONVERSION_LOG_MAX_FILE_BYTES = Number(process.env.RD_CONVERSION_LOG_MAX_BYTES || 5 * 1024 * 1024);
const CONVERSION_LOG_RETENTION_DAYS = Number(process.env.RD_CONVERSION_LOG_RETENTION_DAYS || 14);

let conversionLogPath: string | null = null;

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < CONVERSION_LOG_MAX_FILE_BYTES) {
      return;
    }
    const backup = `${filePath}.old`;
    try {
      fs.rmSync(backup, { force: true });
    } catch {
    }
    fs.renameSync(filePath, backup);
  } catch {
  }
}

function cleanupOldBackup(filePath: string): void {
  const backup = `${filePath}.old`;
  try {
    const stat = fs.statSync(backup);
    const cutoff = Date.now() - CONVERSION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(backup, { force: true });
    }
  } catch {
  }
}

export function initConversionLog(baseDir: string): void {
  conversionLogPath = path.join(baseDir, "conversion.log");
  try {
    fs.mkdirSync(path.dirname(conversionLogPath), { recursive: true });
    cleanupOldBackup(conversionLogPath);
    if (!fs.existsSync(conversionLogPath)) {
      fs.writeFileSync(conversionLogPath, "", "utf8");
    }
    rotateIfNeeded(conversionLogPath);
    if (!fs.existsSync(conversionLogPath)) {
      fs.writeFileSync(conversionLogPath, "", "utf8");
    }
    fs.appendFileSync(conversionLogPath, `=== Conversion Log Start: ${logTimestamp()} ===\n`, "utf8");
  } catch {
    conversionLogPath = null;
  }
}

export function getConversionLogPath(): string | null {
  if (!conversionLogPath) {
    return null;
  }
  return fs.existsSync(conversionLogPath) ? conversionLogPath : null;
}

export function shutdownConversionLog(): void {
  if (!conversionLogPath) {
    return;
  }
  try {
    fs.appendFileSync(conversionLogPath, `=== Conversion Log Ende: ${logTimestamp()} ===\n`, "utf8");
  } catch {
  }
  conversionLogPath = null;
}

function writeConversionBlock(block: string): void {
  if (!conversionLogPath) {
    return;
  }
  try {
    rotateIfNeeded(conversionLogPath);
    if (!fs.existsSync(conversionLogPath)) {
      fs.writeFileSync(conversionLogPath, "", "utf8");
    }
    fs.appendFileSync(conversionLogPath, `${block}\n`, "utf8");
  } catch {
  }
}

export async function runWithConversionTrace<T>(
  meta: { itemId: string; itemName: string; link: string; providerOrder: string },
  fn: () => Promise<T>
): Promise<T> {
  const trace: ConversionTrace = {
    startedAt: Date.now(),
    itemId: meta.itemId,
    itemName: meta.itemName,
    link: meta.link,
    providerOrder: meta.providerOrder,
    notes: {},
    phases: []
  };
  let outcome = "OK";
  let detail = "";
  try {
    const result = await conversionContext.run(trace, fn);
    return result;
  } catch (error) {
    outcome = "FAIL";
    detail = String((error as { message?: string })?.message || error || "").replace(/^Error:\s*/i, "").slice(0, 160);
    throw error;
  } finally {
    const totalMs = Date.now() - trace.startedAt;
    writeConversionBlock(formatConversionBlock(trace, outcome, detail, totalMs));
  }
}
