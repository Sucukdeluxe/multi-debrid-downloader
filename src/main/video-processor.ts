import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Removes only-German audio handling for "Dual Language" (.DL.) scene releases.
// Mirrors the user's ffmpeg script but adds: language-tag detection (with safe
// fallbacks), disk-space pre-check, atomic temp->replace, mtime preservation,
// abort-into-child, and "never destroy the only usable audio" safety.
//
// The ffmpeg/ffprobe-specific logic lives here so it is mockable in isolation;
// the per-package iteration + filename/.DL. rename + logging stays in
// download-manager.ts (its existing domain).

export type GermanAudioMode = "tag" | "first";

export interface ProbedAudioStream {
  language: string;
  title: string;
}

export type AudioTrackDecision =
  | { action: "remux"; audioRelIndex: number; reason: string }
  | { action: "single"; audioRelIndex: 0; reason: string }
  | { action: "skip"; reason: string };

export type VideoProcessAction =
  | "remuxed"
  | "kept-single"
  | "skipped-no-german"
  | "skipped-no-audio"
  | "skipped-no-space"
  | "skipped-no-tool"
  | "error"
  | "aborted";

export interface VideoProcessResult {
  action: VideoProcessAction;
  reason: string;
  keptTrackIndex?: number;
  totalAudioTracks?: number;
  audioLanguages?: string[];
  error?: string;
}

export interface ProcessVideoOptions {
  mode: GermanAudioMode;
  cpuPriority?: string;
  signal?: AbortSignal;
}

// Injection seam so the irreversible file-mutating body (temp -> replace ->
// utimes -> rm-on-failure) can be exercised in tests with a fake ffmpeg/ffprobe
// runner, without spawning real processes. Production passes nothing.
export interface ProcessVideoDeps {
  resolveTooling?: () => Promise<{ ffmpeg: string; ffprobe: string } | null>;
  runProcess?: typeof runVideoProcess;
}

const VIDEO_REMUX_EXTENSIONS = new Set([".mkv", ".mp4"]);
const PROBE_TIMEOUT_MS = 60_000;
const STDOUT_CAP = 2 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers (no fs / no process) — unit-tested in isolation.
// ---------------------------------------------------------------------------

// "X.German.DL.720p.mkv" -> "X.German.720p.mkv"; "X.DL.mkv" -> "X.mkv".
export function stripDualLangMarker(fileName: string): string {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const stripped = base.replace(/\.DL\./gi, ".").replace(/\.DL$/i, "");
  return stripped + ext;
}

export function hasDualLangMarker(fileName: string): boolean {
  return stripDualLangMarker(fileName) !== fileName;
}

export function isRemuxableVideoFile(fileName: string): boolean {
  return VIDEO_REMUX_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

// True when the release name explicitly marks it as a German release. Used in
// tag mode to fall back to the first audio track (German-first scene convention)
// when the audio language tags are wrong (a German dub mislabeled "eng"), instead
// of skipping. Deliberately requires an explicit german/deutsch/dubbed token —
// the ".DL." marker alone (present on every processed file) is not enough.
export function looksLikeGermanRelease(fileName: string): boolean {
  return /(^|[._\s-])(german|deutsch|dubbed)([._\s-]|$)/i.test(fileName);
}

function isGermanStream(stream: ProbedAudioStream): boolean {
  const lang = (stream.language || "").toLowerCase().trim();
  if (["ger", "deu", "de", "german", "deutsch"].includes(lang)) {
    return true;
  }
  const title = (stream.title || "").toLowerCase();
  return /\b(german|deutsch|ger|deu)\b/.test(title);
}

// Decide which audio track to keep. Safety invariant: only ever choose to remux
// (which destroys the original) when we are confident; otherwise skip untouched.
export function pickAudioTrack(streams: ProbedAudioStream[], mode: GermanAudioMode, germanRelease = false): AudioTrackDecision {
  const total = streams.length;
  if (total === 0) {
    return { action: "skip", reason: "no-audio" };
  }
  if (mode === "first") {
    return total === 1
      ? { action: "single", audioRelIndex: 0, reason: "single-audio" }
      : { action: "remux", audioRelIndex: 0, reason: "first-audio" };
  }
  // tag mode
  const germanPos = streams.findIndex(isGermanStream);
  if (germanPos >= 0) {
    return total === 1
      ? { action: "single", audioRelIndex: 0, reason: "single-german" }
      : { action: "remux", audioRelIndex: germanPos, reason: "german-tag" };
  }
  const anyTagged = streams.some((s) => (s.language || "").trim().length > 0);
  if (!anyTagged) {
    // No language metadata at all -> fall back to the script's behavior.
    return total === 1
      ? { action: "single", audioRelIndex: 0, reason: "single-untagged" }
      : { action: "remux", audioRelIndex: 0, reason: "fallback-first-untagged" };
  }
  if (germanRelease) {
    // Tagged, no German track found, but the release name explicitly says German
    // -> the dub is mislabeled (German audio tagged "eng"). Trust the German-first
    // scene convention rather than skipping.
    return total === 1
      ? { action: "single", audioRelIndex: 0, reason: "single-german-mislabeled" }
      : { action: "remux", audioRelIndex: 0, reason: "fallback-first-german-release" };
  }
  // Tagged, no German track, and nothing says German -> never guess-delete.
  return { action: "skip", reason: "no-german-track" };
}

export function parseFfprobeAudioStreams(jsonText: string): ProbedAudioStream[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const streams = (parsed as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) {
    return [];
  }
  return streams.map((raw) => {
    const tags = (raw && typeof raw === "object" ? (raw as { tags?: unknown }).tags : undefined) as
      | { language?: unknown; title?: unknown }
      | undefined;
    return {
      language: typeof tags?.language === "string" ? tags.language : "",
      title: typeof tags?.title === "string" ? tags.title : ""
    };
  });
}

export function buildFfprobeArgs(input: string): string[] {
  return [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index:stream_tags=language,title",
    "-of", "json",
    input
  ];
}

export function buildFfmpegRemuxArgs(opts: { input: string; output: string; audioRelIndex: number; keepSubs?: boolean }): string[] {
  const args = ["-i", opts.input, "-map", "0:v:0", "-map", `0:a:${opts.audioRelIndex}`];
  if (opts.keepSubs) {
    // Optional (not enabled by current settings): keep German subtitle tracks only.
    args.push("-map", "0:s:m:language:ger?", "-map", "0:s:m:language:deu?");
  }
  // Stream-copy and keep metadata (so the kept track's language tag survives;
  // unlike the original script's -map_metadata -1 which dropped it).
  args.push("-c", "copy", "-disposition:a:0", "default", "-y", opts.output);
  return args;
}

// Stream-copy remux is disk-bound; generous budget scaled by size, clamped.
export function computeRemuxTimeoutMs(bytes: number): number {
  const perBytes = Math.ceil((Number(bytes) || 0) / (10 * 1024 * 1024)) * 1000;
  return Math.max(120_000, Math.min(60 * 60 * 1000, 120_000 + perBytes));
}

// ---------------------------------------------------------------------------
// Tooling discovery (system PATH + RD_FFMPEG_BIN/RD_FFPROBE_BIN env override).
// Lazy probe + cache, mirroring the extractor's 7z/Java resolution convention.
// ---------------------------------------------------------------------------

interface VideoTooling {
  ffmpeg: string;
  ffprobe: string;
}

let cachedTooling: VideoTooling | null | undefined;
let cachedToolingNullSince = 0;
const TOOLING_NULL_TTL_MS = 5 * 60 * 1000;

function ffmpegCandidate(): string {
  return String(process.env.RD_FFMPEG_BIN || "").trim() || "ffmpeg";
}

function ffprobeCandidate(): string {
  return String(process.env.RD_FFPROBE_BIN || "").trim() || "ffprobe";
}

async function probeVersion(command: string): Promise<boolean> {
  const result = await runVideoProcess(command, ["-version"], { timeoutMs: 10_000 });
  return result.ok && !result.missing;
}

export async function resolveVideoTooling(): Promise<VideoTooling | null> {
  if (cachedTooling) {
    return cachedTooling;
  }
  if (cachedTooling === null && Date.now() - cachedToolingNullSince < TOOLING_NULL_TTL_MS) {
    return null;
  }
  const ffmpeg = ffmpegCandidate();
  const ffprobe = ffprobeCandidate();
  const [ffmpegOk, ffprobeOk] = await Promise.all([probeVersion(ffmpeg), probeVersion(ffprobe)]);
  if (ffmpegOk && ffprobeOk) {
    cachedTooling = { ffmpeg, ffprobe };
    return cachedTooling;
  }
  cachedTooling = null;
  cachedToolingNullSince = Date.now();
  return null;
}

export function resetVideoToolingCache(): void {
  cachedTooling = undefined;
  cachedToolingNullSince = 0;
}

// ---------------------------------------------------------------------------
// Process spawning (ffmpeg/ffprobe). ffmpeg/ffprobe exit conventions: 0 = ok,
// anything else = real failure (NOT 7-Zip's "exit 1 = warning" semantics).
// ---------------------------------------------------------------------------

export interface VideoSpawnResult {
  ok: boolean;
  aborted: boolean;
  timedOut: boolean;
  missing: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function appendCapped(buffer: string, text: string, cap: number): string {
  const next = buffer + text;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function applyChildPriority(pid: number | undefined, cpuPriority?: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const numeric = Number(pid || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return;
  }
  try {
    const level = cpuPriority === "high" ? os.constants.priority.PRIORITY_NORMAL : os.constants.priority.PRIORITY_BELOW_NORMAL;
    os.setPriority(numeric, level);
  } catch {
  }
}

function killChildTree(child: { pid?: number; kill: () => void }): void {
  const pid = Number(child.pid || 0);
  if (process.platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { try { child.kill(); } catch {} });
      return;
    } catch {
    }
  }
  try {
    child.kill();
  } catch {
  }
}

export function runVideoProcess(
  command: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; cpuPriority?: string } = {}
): Promise<VideoSpawnResult> {
  const { signal, timeoutMs, cpuPriority } = opts;
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, aborted: true, timedOut: false, missing: false, exitCode: null, stdout: "", stderr: "" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const child = spawn(command, args, { windowsHide: true });
    applyChildPriority(child.pid, cpuPriority);

    const onAbort = (): void => {
      aborted = true;
      killChildTree(child);
    };

    const finish = (result: VideoSpawnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
        finish({ ok: false, aborted: false, timedOut: true, missing: false, exitCode: null, stdout, stderr });
      }, timeoutMs);
    }
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk) => { stdout = appendCapped(stdout, String(chunk || ""), STDOUT_CAP); });
    child.stderr?.on("data", (chunk) => { stderr = appendCapped(stderr, String(chunk || ""), STDERR_CAP); });

    child.on("error", (error) => {
      const text = String(error || "");
      finish({ ok: false, aborted: false, timedOut: false, missing: text.toLowerCase().includes("enoent"), exitCode: null, stdout, stderr: stderr || text });
    });

    child.on("close", (code) => {
      if (aborted) {
        finish({ ok: false, aborted: true, timedOut: false, missing: false, exitCode: code, stdout, stderr });
        return;
      }
      if (timedOut) {
        finish({ ok: false, aborted: false, timedOut: true, missing: false, exitCode: code, stdout, stderr });
        return;
      }
      finish({ ok: code === 0, aborted: false, timedOut: false, missing: false, exitCode: code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Per-file orchestration: probe -> decide -> (disk check) -> remux -> atomic
// replace -> preserve mtime. Operates IN PLACE (same filename); the .DL. rename
// + companion handling + logging is done by the caller (download-manager).
// ---------------------------------------------------------------------------

async function getFreeSpaceBytes(dir: string): Promise<number | null> {
  try {
    const stat = await fs.promises.statfs(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

export async function processVideoFile(filePath: string, opts: ProcessVideoOptions, deps: ProcessVideoDeps = {}): Promise<VideoProcessResult> {
  const resolveTool = deps.resolveTooling || resolveVideoTooling;
  const run = deps.runProcess || runVideoProcess;
  if (opts.signal?.aborted) {
    return { action: "aborted", reason: "aborted" };
  }
  const tooling = await resolveTool();
  if (!tooling) {
    return { action: "skipped-no-tool", reason: "ffmpeg/ffprobe nicht gefunden (PATH oder RD_FFMPEG_BIN)" };
  }

  const probe = await run(tooling.ffprobe, buildFfprobeArgs(filePath), { signal: opts.signal, timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.aborted) {
    return { action: "aborted", reason: "aborted" };
  }
  if (!probe.ok) {
    return { action: "error", reason: "ffprobe fehlgeschlagen", error: probe.stderr || `exit ${String(probe.exitCode)}` };
  }

  const streams = parseFfprobeAudioStreams(probe.stdout);
  const audioLanguages = streams.map((s) => (s.language || "").trim() || "und");
  const decision = pickAudioTrack(streams, opts.mode, looksLikeGermanRelease(path.basename(filePath)));
  if (decision.action === "skip") {
    return {
      action: decision.reason === "no-german-track" ? "skipped-no-german" : "skipped-no-audio",
      reason: decision.reason,
      totalAudioTracks: streams.length,
      audioLanguages
    };
  }
  if (decision.action === "single") {
    return { action: "kept-single", reason: decision.reason, totalAudioTracks: streams.length, audioLanguages, keptTrackIndex: 0 };
  }

  // remux path
  let originalStat: fs.Stats;
  try {
    originalStat = await fs.promises.stat(filePath);
  } catch (error) {
    return { action: "error", reason: "stat fehlgeschlagen", error: String(error), audioLanguages };
  }
  const free = await getFreeSpaceBytes(path.dirname(filePath));
  if (free !== null && free < Math.ceil(originalStat.size * 1.05)) {
    return { action: "skipped-no-space", reason: "zu wenig freier Speicher fuer Remux", totalAudioTracks: streams.length, audioLanguages };
  }

  const ext = path.extname(filePath);
  // Short, same-directory temp name (never longer than the original file name) so
  // a long scene filename + temp suffix cannot push the temp path past Windows
  // MAX_PATH and make ffmpeg fail (which would leave the file unprocessed).
  const tempPath = path.join(path.dirname(filePath), `~rdtmp${ext}`);
  await fs.promises.rm(tempPath, { force: true }).catch(() => {});

  const remux = await run(
    tooling.ffmpeg,
    buildFfmpegRemuxArgs({ input: filePath, output: tempPath, audioRelIndex: decision.audioRelIndex, keepSubs: false }),
    { signal: opts.signal, timeoutMs: computeRemuxTimeoutMs(originalStat.size), cpuPriority: opts.cpuPriority }
  );
  if (remux.aborted) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { action: "aborted", reason: "aborted" };
  }
  if (!remux.ok) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { action: "error", reason: "ffmpeg remux fehlgeschlagen", error: remux.stderr || `exit ${String(remux.exitCode)}`, totalAudioTracks: streams.length, audioLanguages, keptTrackIndex: decision.audioRelIndex };
  }

  const tempStat = await fs.promises.stat(tempPath).catch(() => null);
  if (!tempStat || tempStat.size <= 0) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { action: "error", reason: "Remux ergab leere Datei", totalAudioTracks: streams.length, audioLanguages };
  }

  try {
    // libuv rename replaces an existing destination on Windows; fall back if not.
    await fs.promises.rename(tempPath, filePath).catch(async () => {
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rename(tempPath, filePath);
    });
    // Preserve original mtime so freshness gates (hybrid collect) don't skip it.
    await fs.promises.utimes(filePath, originalStat.atime, originalStat.mtime).catch(() => {});
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    return { action: "error", reason: "Ersetzen der Datei fehlgeschlagen", error: String(error), totalAudioTracks: streams.length, audioLanguages };
  }

  return { action: "remuxed", reason: decision.reason, keptTrackIndex: decision.audioRelIndex, totalAudioTracks: streams.length, audioLanguages };
}
