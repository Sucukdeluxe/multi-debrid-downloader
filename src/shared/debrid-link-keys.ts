export interface DebridLinkApiKeyEntry {
  id: string;
  token: string;
  index: number;
  label: string;
  masked: string;
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

export function maskDebridLinkApiKey(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return "Nicht hinterlegt";
  }
  if (trimmed.length <= 6) {
    return "*".repeat(trimmed.length);
  }
  return `${trimmed.slice(0, 3)}${"*".repeat(Math.max(4, trimmed.length - 6))}${trimmed.slice(-3)}`;
}

export function getDebridLinkApiKeyId(token: string): string {
  return `dlk_${fnv1a64(token.trim())}`;
}

export function getDebridLinkApiKeyLabel(index: number): string {
  return `Key ${index + 1}`;
}

export function parseDebridLinkApiKeys(raw: string): DebridLinkApiKeyEntry[] {
  const seen = new Set<string>();
  const tokens = String(raw || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((token) => {
      if (seen.has(token)) {
        return false;
      }
      seen.add(token);
      return true;
    });

  return tokens.map((token, index) => ({
    id: getDebridLinkApiKeyId(token),
    token,
    index,
    label: getDebridLinkApiKeyLabel(index),
    masked: maskDebridLinkApiKey(token)
  }));
}

export function getDebridLinkApiKeyIds(raw: string): string[] {
  return parseDebridLinkApiKeys(raw).map((entry) => entry.id);
}
