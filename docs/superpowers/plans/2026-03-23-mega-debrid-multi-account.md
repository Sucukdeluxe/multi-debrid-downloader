# Mega-Debrid Multi-Account Support

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan.

**Goal:** Multiple Mega-Debrid accounts with automatic fallback when an account hits Fair-Use limits or errors.

**Architecture:** Follow the existing Debrid-Link multi-key pattern. Store credentials as newline-separated `login:password` pairs. Account rotation uses linear iteration with cooldown/disable/daily-limit checks.

**Tech Stack:** TypeScript, Electron, React

---

### Task 1: Create mega-debrid-accounts.ts parser module

**Files:**
- Create: `src/shared/mega-debrid-accounts.ts`

- [ ] Create `MegaDebridAccountEntry` interface (id, login, password, index, label, maskedLogin)
- [ ] Create `parseMegaDebridAccounts(raw: string): MegaDebridAccountEntry[]` - split by newlines, parse `login:password` pairs, deduplicate by login, generate stable IDs via FNV-1a hash (`mda_` prefix)
- [ ] Create `getMegaDebridAccountId(login: string): string`
- [ ] Create `maskMegaDebridLogin(login: string): string`
- [ ] Create `getMegaDebridAccountLabel(index: number): string` - "Account 1", "Account 2"
- [ ] Create `serializeMegaDebridAccounts(accounts: {login: string, password: string}[]): string` - back to newline-separated format
- [ ] Backward compat: if raw string has no `:` separator, treat as legacy single-login (use megaPassword from settings)

### Task 2: Extend AppSettings with multi-account fields

**Files:**
- Modify: `src/shared/types.ts`

- [ ] Replace `megaLogin: string` → `megaCredentials: string` (newline-separated `login:password` pairs)
- [ ] Keep `megaPassword: string` for backward compat (migration reads it once)
- [ ] Add `megaDebridDisabledAccountIds: string[]`
- [ ] Add `megaDebridAccountDailyLimitBytes: Record<string, number>`
- [ ] Add `megaDebridAccountDailyUsageBytes: Record<string, number>`
- [ ] Add `megaDebridAccountTotalUsageBytes: Record<string, number>`

### Task 3: Add per-account daily limit functions

**Files:**
- Modify: `src/shared/provider-daily-limits.ts`

- [ ] Add `getMegaDebridAccountDailyLimitBytes(settings, accountId)`
- [ ] Add `getMegaDebridAccountDailyUsageBytes(settings, accountId, epochMs)`
- [ ] Add `isMegaDebridAccountDailyLimitReached(settings, accountId, epochMs)`
- [ ] Add `addMegaDebridAccountDailyUsageBytes(settings, accountId, bytes, epochMs)`
- [ ] Add `addMegaDebridAccountTotalUsageBytes(settings, accountId, bytes)`
- [ ] Add `isMegaDebridAccountDisabled(settings, accountId)`

### Task 4: Migrate storage from single to multi-account

**Files:**
- Modify: `src/main/storage.ts`

- [ ] In `normalizeSettings`: migrate old `megaLogin`+`megaPassword` → `megaCredentials` format (`login:password`)
- [ ] Normalize new fields with defaults

### Task 5: Implement account rotation in debrid.ts

**Files:**
- Modify: `src/main/debrid.ts`

- [ ] Add in-memory cooldown cache for Mega accounts (like `debridLinkKeyCooldowns`)
- [ ] Update `hasMegaDebridCredentials()` to check `parseMegaDebridAccounts().length > 0`
- [ ] Update Mega-Debrid API unrestrict to iterate accounts (skip disabled/limited/cooldown)
- [ ] Update Mega-Debrid Web unrestrict to iterate accounts
- [ ] Return `sourceAccountId` and `sourceAccountLabel` on success
- [ ] On failure: classify error, apply cooldown, try next account

### Task 6: Update download-manager usage tracking

**Files:**
- Modify: `src/main/download-manager.ts`

- [ ] Track per-account bytes for Mega-Debrid (like Debrid-Link key tracking)
- [ ] Update `isProviderDailyLimited` to check if ANY Mega account is available

### Task 7: Update UI for multi-account management

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] Update Mega-Debrid account dialog: textarea for credentials (`login:password` per line)
- [ ] Display account list with masked logins, enable/disable toggle, per-account daily limits
- [ ] Update account summary display to show individual accounts

### Task 8: Tests

- [ ] Unit tests for `parseMegaDebridAccounts` (parse, deduplicate, legacy compat)
- [ ] Unit tests for per-account daily limits
- [ ] Run full test suite: `npx vitest run`
