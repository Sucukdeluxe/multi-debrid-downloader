# Disk Space Pre-Check + Nested Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add JDownloader-style disk space checking before extraction and single-level nested archive extraction.

**Architecture:** Two independent features in `extractor.ts`. Disk space check uses `fs.statfs()` to verify free space before starting. Nested extraction calls `findArchiveCandidates()` on the output directory after the main pass completes, then extracts any found archives once.

**Tech Stack:** Node.js `fs.statfs`, existing UnRAR/WinRAR extraction pipeline, vitest for tests.

---

### Task 1: Disk Space Check — Utility Function

**Files:**
- Modify: `src/main/extractor.ts` (after line 96, before `zipEntryMemoryLimitBytes`)

**Step 1: Add the `checkDiskSpaceForExtraction` function**

Add after the constants block (line 96) in `extractor.ts`:

```typescript
const DISK_SPACE_SAFETY_FACTOR = 1.1;

async function estimateArchivesTotalBytes(candidates: string[]): Promise<number> {
  let total = 0;
  for (const archivePath of candidates) {
    const parts = collectArchiveCleanupTargets(archivePath);
    for (const part of parts) {
      try {
        total += (await fs.promises.stat(part)).size;
      } catch { /* missing part, ignore */ }
    }
  }
  return total;
}

function humanSizeGB(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

async function checkDiskSpaceForExtraction(targetDir: string, candidates: string[]): Promise<void> {
  if (candidates.length === 0) return;
  const archiveBytes = await estimateArchivesTotalBytes(candidates);
  if (archiveBytes <= 0) return;
  const requiredBytes = Math.ceil(archiveBytes * DISK_SPACE_SAFETY_FACTOR);

  let freeBytes: number;
  try {
    const stats = await fs.promises.statfs(targetDir);
    freeBytes = stats.bfree * stats.bsize;
  } catch {
    // statfs not supported or target doesn't exist yet — skip check
    return;
  }

  if (freeBytes < requiredBytes) {
    const msg = `Nicht genug Speicherplatz: ${humanSizeGB(requiredBytes)} benötigt, ${humanSizeGB(freeBytes)} frei`;
    logger.error(`Disk-Space-Check: ${msg} (target=${targetDir})`);
    throw new Error(msg);
  }
  logger.info(`Disk-Space-Check OK: ${humanSizeGB(freeBytes)} frei, ${humanSizeGB(requiredBytes)} benötigt (target=${targetDir})`);
}
```

**Step 2: Wire into `extractPackageArchives`**

In `extractPackageArchives()`, after the candidates are filtered (line ~1230, after the log line), add:

```typescript
  // Disk space pre-check
  try {
    await fs.promises.mkdir(options.targetDir, { recursive: true });
  } catch { /* ignore */ }
  await checkDiskSpaceForExtraction(options.targetDir, candidates);
```

This goes right after line 1230 (`logger.info(...)`) and before line 1231 (`if (candidates.length === 0)`).

**Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

**Step 4: Commit**

```
feat: add disk space pre-check before extraction
```

---

### Task 2: Disk Space Check — Tests

**Files:**
- Modify: `tests/extractor.test.ts`

**Step 1: Add disk space test**

Add a new `describe("disk space check")` block in the extractor test file. Since `checkDiskSpaceForExtraction` is a private function, test it indirectly via `extractPackageArchives` — create a temp dir with a tiny zip, mock `fs.promises.statfs` to return very low free space, and verify extraction fails with the right message.

```typescript
describe("disk space check", () => {
  it("aborts extraction when disk space is insufficient", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-diskspace-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    // Create a small zip
    const zip = new AdmZip();
    zip.addFile("test.txt", Buffer.alloc(1024, 0x41));
    zip.writeZip(path.join(packageDir, "test.zip"));

    // Mock statfs to report almost no free space
    const originalStatfs = fs.promises.statfs;
    (fs.promises as any).statfs = async () => ({ bfree: 1, bsize: 1 });

    try {
      await expect(
        extractPackageArchives({
          packageDir,
          targetDir,
          cleanupMode: "none" as any,
          conflictMode: "overwrite" as any,
          removeLinks: false,
          removeSamples: false,
        })
      ).rejects.toThrow(/Nicht genug Speicherplatz/);
    } finally {
      (fs.promises as any).statfs = originalStatfs;
    }
  });

  it("proceeds when disk space is sufficient", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-diskspace-ok-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile("test.txt", Buffer.alloc(1024, 0x41));
    zip.writeZip(path.join(packageDir, "test.zip"));

    // Don't mock statfs — real disk should have enough space
    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none" as any,
      conflictMode: "overwrite" as any,
      removeLinks: false,
      removeSamples: false,
    });
    expect(result.extracted).toBe(1);
    expect(result.failed).toBe(0);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/extractor.test.ts`
Expected: All tests pass including new disk space tests.

**Step 3: Commit**

```
test: add disk space pre-check tests
```

---

### Task 3: Nested Extraction — Implementation

**Files:**
- Modify: `src/main/extractor.ts` (in `extractPackageArchives`, after line ~1404 main loop ends)

**Step 1: Add the nested extraction blacklist constant**

Add near the top of the file (after ARCHIVE_SORT_COLLATOR, line 96):

```typescript
const NESTED_EXTRACT_BLACKLIST_RE = /\.(iso|img|bin|dmg)$/i;
```

**Step 2: Add nested extraction pass in `extractPackageArchives`**

After the main extraction for-loop ends (line ~1404, after the last `clearInterval(pulseTimer)`) and before the `if (extracted > 0)` block (line 1406), add:

```typescript
  // ── Nested extraction: check output dir for archives produced by extraction ──
  if (extracted > 0 && failed === 0 && !options.skipPostCleanup && !options.onlyArchives) {
    try {
      const nestedCandidates = (await findArchiveCandidates(options.targetDir))
        .filter((p) => !NESTED_EXTRACT_BLACKLIST_RE.test(p));
      if (nestedCandidates.length > 0) {
        logger.info(`Nested-Extraction: ${nestedCandidates.length} Archive im Output gefunden`);

        // Disk space check for nested archives too
        try {
          await checkDiskSpaceForExtraction(options.targetDir, nestedCandidates);
        } catch (spaceError) {
          logger.warn(`Nested-Extraction Disk-Space-Check fehlgeschlagen: ${String(spaceError)}`);
          // Don't fail the whole extraction, just skip nesting
          nestedCandidates.length = 0;
        }

        for (const nestedArchive of nestedCandidates) {
          if (options.signal?.aborted) {
            throw new Error("aborted:extract");
          }
          const nestedName = path.basename(nestedArchive);
          const nestedKey = archiveNameKey(nestedName);
          if (resumeCompleted.has(nestedKey)) {
            logger.info(`Nested-Extraction übersprungen (bereits entpackt): ${nestedName}`);
            continue;
          }
          const nestedStartedAt = Date.now();
          let nestedPercent = 0;
          emitProgress(extracted + failed, `nested: ${nestedName}`, "extracting", nestedPercent, 0);
          const nestedPulse = setInterval(() => {
            emitProgress(extracted + failed, `nested: ${nestedName}`, "extracting", nestedPercent, Date.now() - nestedStartedAt);
          }, 1100);
          const hybrid = Boolean(options.hybridMode);
          logger.info(`Nested-Entpacke: ${nestedName} -> ${options.targetDir}${hybrid ? " (hybrid)" : ""}`);
          try {
            const ext = path.extname(nestedArchive).toLowerCase();
            if (ext === ".zip") {
              try {
                await extractZipArchive(nestedArchive, options.targetDir, options.conflictMode, options.signal);
                nestedPercent = 100;
              } catch (zipErr) {
                if (!shouldFallbackToExternalZip(zipErr)) throw zipErr;
                const usedPw = await runExternalExtract(nestedArchive, options.targetDir, options.conflictMode, passwordCandidates, (v) => { nestedPercent = Math.max(nestedPercent, v); }, options.signal, hybrid);
                passwordCandidates = prioritizePassword(passwordCandidates, usedPw);
              }
            } else {
              const usedPw = await runExternalExtract(nestedArchive, options.targetDir, options.conflictMode, passwordCandidates, (v) => { nestedPercent = Math.max(nestedPercent, v); }, options.signal, hybrid);
              passwordCandidates = prioritizePassword(passwordCandidates, usedPw);
            }
            extracted += 1;
            resumeCompleted.add(nestedKey);
            await writeExtractResumeState(options.packageDir, resumeCompleted, options.packageId);
            logger.info(`Nested-Entpacken erfolgreich: ${nestedName}`);
            // Cleanup nested archive after successful extraction
            if (options.cleanupMode === "delete") {
              const nestedParts = collectArchiveCleanupTargets(nestedArchive);
              for (const part of nestedParts) {
                try { await fs.promises.unlink(part); } catch { /* ignore */ }
              }
            }
          } catch (nestedErr) {
            const errText = String(nestedErr);
            if (isExtractAbortError(errText)) throw new Error("aborted:extract");
            if (isNoExtractorError(errText)) {
              logger.warn(`Nested-Extraction: Kein Extractor, überspringe restliche`);
              break;
            }
            failed += 1;
            lastError = errText;
            logger.error(`Nested-Entpack-Fehler ${nestedName}: ${errText}`);
          } finally {
            clearInterval(nestedPulse);
          }
        }
      }
    } catch (nestedError) {
      const errText = String(nestedError);
      if (isExtractAbortError(errText)) throw new Error("aborted:extract");
      logger.warn(`Nested-Extraction Fehler: ${cleanErrorText(errText)}`);
    }
  }
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

**Step 4: Commit**

```
feat: add single-level nested archive extraction
```

---

### Task 4: Nested Extraction — Tests

**Files:**
- Modify: `tests/extractor.test.ts`

**Step 1: Add nested extraction test**

```typescript
describe("nested extraction", () => {
  it("extracts archives found inside extracted output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-nested-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    // Create inner zip with a text file
    const innerZip = new AdmZip();
    innerZip.addFile("deep.txt", Buffer.from("deep content"));

    // Create outer zip containing the inner zip
    const outerZip = new AdmZip();
    outerZip.addFile("inner.zip", innerZip.toBuffer());
    outerZip.writeZip(path.join(packageDir, "outer.zip"));

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none" as any,
      conflictMode: "overwrite" as any,
      removeLinks: false,
      removeSamples: false,
    });

    // outer.zip extracted (1) + inner.zip extracted (1) = 2
    expect(result.extracted).toBe(2);
    expect(result.failed).toBe(0);

    // deep.txt should exist in the target
    expect(fs.existsSync(path.join(targetDir, "deep.txt"))).toBe(true);
  });

  it("does not extract blacklisted extensions like .iso", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rd-nested-bl-"));
    tempDirs.push(root);
    const packageDir = path.join(root, "pkg");
    const targetDir = path.join(root, "out");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    // Create a zip that contains a file named "disc.iso"
    // (not a real archive, but tests the blacklist filter path)
    const zip = new AdmZip();
    zip.addFile("disc.iso", Buffer.alloc(64, 0));
    zip.addFile("readme.txt", Buffer.from("hello"));
    zip.writeZip(path.join(packageDir, "package.zip"));

    const result = await extractPackageArchives({
      packageDir,
      targetDir,
      cleanupMode: "none" as any,
      conflictMode: "overwrite" as any,
      removeLinks: false,
      removeSamples: false,
    });

    expect(result.extracted).toBe(1); // Only outer zip, no nested
    expect(fs.existsSync(path.join(targetDir, "disc.iso"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "readme.txt"))).toBe(true);
  });
});
```

**Step 2: Run all extractor tests**

Run: `npx vitest run tests/extractor.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```
test: add nested extraction tests
```

---

### Task 5: Full Build + Test Verification

**Step 1: Build**

Run: `npm run build`
Expected: Clean compile.

**Step 2: Run all fast tests**

Run: `npx vitest run tests/extractor.test.ts tests/utils.test.ts tests/storage.test.ts tests/integrity.test.ts tests/cleanup.test.ts tests/debrid.test.ts tests/auto-rename.test.ts`
Expected: All pass (except pre-existing cleanup.test.ts failures).

**Step 3: Final commit with version bump if releasing**

```
feat: disk space pre-check + nested extraction (JD2 parity)
```
