import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_TEMP_EXTENSIONS, LINK_ARTIFACT_EXTENSIONS, MAX_LINK_ARTIFACT_BYTES, RAR_SPLIT_RE, SAMPLE_DIR_NAMES, SAMPLE_TOKEN_RE, SAMPLE_VIDEO_EXTENSIONS } from "./constants";

async function yieldToLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function isArchiveOrTempFile(filePath: string): boolean {
  const lowerName = path.basename(filePath).toLowerCase();
  const ext = path.extname(lowerName);
  if (ARCHIVE_TEMP_EXTENSIONS.has(ext)) {
    return true;
  }
  if (lowerName.includes(".part") && lowerName.endsWith(".rar")) {
    return true;
  }
  return RAR_SPLIT_RE.test(lowerName);
}

export function cleanupCancelledPackageArtifacts(packageDir: string): number {
  if (!fs.existsSync(packageDir)) {
    return 0;
  }
  let removed = 0;
  const stack = [packageDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
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

export async function cleanupCancelledPackageArtifactsAsync(packageDir: string): Promise<number> {
  try {
    await fs.promises.access(packageDir, fs.constants.F_OK);
  } catch {
    return 0;
  }

  let removed = 0;
  let touched = 0;
  const stack = [packageDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
      } else if (entry.isFile() && isArchiveOrTempFile(full)) {
        try {
          await fs.promises.rm(full, { force: true });
          removed += 1;
        } catch {
          // ignore
        }
      }

      touched += 1;
      if (touched % 80 === 0) {
        await yieldToLoop();
      }
    }
  }
  return removed;
}

export async function removeDownloadLinkArtifacts(extractDir: string): Promise<number> {
  try {
    await fs.promises.access(extractDir);
  } catch {
    return 0;
  }
  let removed = 0;
  const stack = [extractDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
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
            const stat = await fs.promises.stat(full);
            if (stat.size <= MAX_LINK_ARTIFACT_BYTES) {
              const text = await fs.promises.readFile(full, "utf8");
              shouldDelete = /https?:\/\//i.test(text);
            }
          } catch {
            shouldDelete = false;
          }
        }
      }

      if (shouldDelete) {
        try {
          await fs.promises.rm(full, { force: true });
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  }
  return removed;
}

export async function removeSampleArtifacts(extractDir: string): Promise<{ files: number; dirs: number }> {
  try {
    await fs.promises.access(extractDir);
  } catch {
    return { files: 0, dirs: 0 };
  }

  let removedFiles = 0;
  let removedDirs = 0;
  const sampleDirs: string[] = [];
  const stack = [extractDir];

  const countFilesRecursive = async (rootDir: string): Promise<number> => {
    let count = 0;
    const dirs = [rootDir];
    while (dirs.length > 0) {
      const current = dirs.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          try {
            const stat = await fs.promises.lstat(full);
            if (stat.isSymbolicLink()) {
              continue;
            }
          } catch {
            continue;
          }
          dirs.push(full);
        } else if (entry.isFile()) {
          count += 1;
        }
      }
    }
    return count;
  };

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const base = entry.name.toLowerCase();
        if (SAMPLE_DIR_NAMES.has(base)) {
          sampleDirs.push(full);
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const stem = path.parse(entry.name).name.toLowerCase();
      const ext = path.extname(entry.name).toLowerCase();
      const isSampleVideo = SAMPLE_VIDEO_EXTENSIONS.has(ext) && SAMPLE_TOKEN_RE.test(stem);

      if (isSampleVideo) {
        try {
          await fs.promises.rm(full, { force: true });
          removedFiles += 1;
        } catch {
          // ignore
        }
      }
    }
  }

  sampleDirs.sort((a, b) => b.length - a.length);
  for (const dir of sampleDirs) {
    try {
      const stat = await fs.promises.lstat(dir);
      if (stat.isSymbolicLink()) {
        await fs.promises.rm(dir, { force: true });
        removedDirs += 1;
        continue;
      }
      const filesInDir = await countFilesRecursive(dir);
      await fs.promises.rm(dir, { recursive: true, force: true });
      removedFiles += filesInDir;
      removedDirs += 1;
    } catch {
      // ignore
    }
  }

  return { files: removedFiles, dirs: removedDirs };
}
