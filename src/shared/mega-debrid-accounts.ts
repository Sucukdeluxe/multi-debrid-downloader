export interface MegaDebridAccountEntry {
  id: string;
  login: string;
  password: string;
  index: number;
  label: string;
  maskedLogin: string;
}

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET_BASIS;
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) || 0);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(36);
}

export function getMegaDebridAccountId(login: string): string {
  return `mda_${fnv1a64(login.trim().toLowerCase())}`;
}

export function maskMegaDebridLogin(login: string): string {
  const trimmed = login.trim();
  if (!trimmed) {
    return "Nicht hinterlegt";
  }
  if (trimmed.length <= 4) {
    return `${trimmed[0]}${"*".repeat(trimmed.length - 1)}`;
  }
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.max(3, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

export function getMegaDebridAccountLabel(index: number): string {
  return `Account ${index + 1}`;
}

export function parseMegaDebridAccounts(raw: string, legacyPassword = ""): MegaDebridAccountEntry[] {
  const seen = new Set<string>();
  const lines = String(raw || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: MegaDebridAccountEntry[] = [];
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    let login: string;
    let password: string;
    if (colonIdx >= 0) {
      login = line.slice(0, colonIdx).trim();
      password = line.slice(colonIdx + 1).trim();
    } else {
      login = line;
      password = legacyPassword;
    }
    if (!login || !password) {
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({
      id: getMegaDebridAccountId(login),
      login,
      password,
      index: entries.length,
      label: getMegaDebridAccountLabel(entries.length),
      maskedLogin: maskMegaDebridLogin(login)
    });
  }
  return entries;
}

export function serializeMegaDebridAccounts(accounts: { login: string; password: string }[]): string {
  return accounts
    .filter((a) => a.login.trim() && a.password.trim())
    .map((a) => `${a.login.trim()}:${a.password.trim()}`)
    .join("\n");
}

export function getMegaDebridAccountIds(raw: string, legacyPassword = ""): string[] {
  return parseMegaDebridAccounts(raw, legacyPassword).map((entry) => entry.id);
}
