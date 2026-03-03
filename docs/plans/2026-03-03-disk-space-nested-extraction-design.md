# Disk Space Pre-Check + Nested Extraction

## Context
Two feature gaps identified from JDownloader 2 comparison:
1. JD2 checks disk space before extraction (DiskSpaceReservation)
2. JD2 supports archives within archives (nested/deep extraction)

## Feature 1: Disk Space Pre-Check

### Approach
Before extracting, calculate total archive size (sum of all archive parts) and check free disk space on the target drive. Use 1.1x archive size as minimum requirement (scene releases are mostly video with minimal compression).

### Behavior
- Check runs once in `extractPackageArchives()` before the extraction loop
- On insufficient space: abort extraction, set status to failed with message "Nicht genug Speicherplatz: X GB benötigt, Y GB frei"
- User can retry after freeing space (existing retry mechanism)
- Uses `fs.statfs()` (Node 18+) or platform-specific fallback for free space

### Implementation Location
- `extractor.ts`: New `checkDiskSpace()` function
- Called at the top of `extractPackageArchives()` after finding candidates
- Calculates total size from `collectArchiveCleanupTargets()` for each candidate

## Feature 2: Nested Extraction (1 Level Deep)

### Approach
After successfully extracting all archives, scan the output directory for new archive files. If found, extract them once (no further nesting check).

### Blacklist
Skip: `.iso`, `.img`, `.bin`, `.dmg` (disk images should not be auto-extracted)

### Behavior
- Runs after successful extraction of all top-level archives
- Calls `findArchiveCandidates()` on `targetDir`
- Filters out blacklisted extensions
- Extracts found archives with same options (passwords, conflict mode, etc.)
- No recursive nesting — exactly one additional pass
- Progress reported as second phase
- Cleanup of nested archives follows same cleanup mode

### Implementation Location
- `extractor.ts`: New nested extraction pass at end of `extractPackageArchives()`
- After the main extraction loop succeeds, before cleanup
- Reuses existing `runExternalExtract()` / `extractZipArchive()`

## Files
- `src/main/extractor.ts` — both features
- `tests/extractor.test.ts` — disk space check tests (mock fs.statfs)
