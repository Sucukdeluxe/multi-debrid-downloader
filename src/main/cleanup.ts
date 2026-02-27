import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_TEMP_EXTENSIONS, LINK_ARTIFACT_EXTENSIONS, RAR_SPLIT_RE, SAMPLE_DIR_NAMES, SAMPLE_TOKEN_RE, SAMPLE_VIDEO_EXTENSIONS } from "./constants";

export function isArchiveOrTempFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const ext = path.extname(lower);
  if (ARCHIVE_TEMP_EXTENSIONS.has(ext)) {
    return true;
  }
  if (lower.includes(".part") && lower.endsWith(".rar")) {
    return true;
  }
  return RAR_SPLIT_RE.test(lower);
}

export function cleanupCancelledPackageArtifacts(packageDir: string): number {
  if (!fs.existsSync(packageDir)) {
    return 0;
  }
  let removed = 0;
  const stack = [packageDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isArchiveOrTempFile(full)) {
        try {
          fs.rmSync(full, { force: true });
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  }
  return removed;
}

export function removeDownloadLinkArtifacts(extractDir: string): number {
  if (!fs.existsSync(extractDir)) {
    return 0;
  }
  let removed = 0;
  const stack = [extractDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const name = entry.name.toLowerCase();
      let shouldDelete = LINK_ARTIFACT_EXTENSIONS.has(ext);
      if (!shouldDelete && [".txt", ".html", ".htm", ".nfo"].includes(ext)) {
        if (/[._\- ](links?|downloads?|urls?|dlc)([._\- ]|$)/i.test(name)) {
          try {
            const text = fs.readFileSync(full, "utf8");
            shouldDelete = /https?:\/\//i.test(text);
          } catch {
            shouldDelete = false;
          }
        }
      }

      if (shouldDelete) {
        try {
          fs.rmSync(full, { force: true });
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  }
  return removed;
}

export function removeSampleArtifacts(extractDir: string): { files: number; dirs: number } {
  if (!fs.existsSync(extractDir)) {
    return { files: 0, dirs: 0 };
  }

  let removedFiles = 0;
  let removedDirs = 0;
  const allDirs: string[] = [];
  const stack = [extractDir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    allDirs.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const parent = path.basename(path.dirname(full)).toLowerCase();
      const stem = path.parse(entry.name).name.toLowerCase();
      const ext = path.extname(entry.name).toLowerCase();
      const inSampleDir = SAMPLE_DIR_NAMES.has(parent);
      const isSampleVideo = SAMPLE_VIDEO_EXTENSIONS.has(ext) && SAMPLE_TOKEN_RE.test(stem);

      if (inSampleDir || isSampleVideo) {
        try {
          fs.rmSync(full, { force: true });
          removedFiles += 1;
        } catch {
          // ignore
        }
      }
    }
  }

  allDirs.sort((a, b) => b.length - a.length);
  for (const dir of allDirs) {
    if (dir === extractDir) {
      continue;
    }
    const base = path.basename(dir).toLowerCase();
    if (!SAMPLE_DIR_NAMES.has(base)) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removedDirs += 1;
    } catch {
      // ignore
    }
  }

  return { files: removedFiles, dirs: removedDirs };
}
