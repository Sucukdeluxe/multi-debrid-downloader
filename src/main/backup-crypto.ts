import crypto from "node:crypto";

// Fixed app key — like JDownloader 2: deterministic, works on any machine.
// Not meant to protect against reverse-engineering, just prevents casual
// plaintext snooping when someone opens the backup file.
const APP_KEY_MATERIAL = "MDD-v2-backup-aes256gcm-2026";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16;
const MAGIC = Buffer.from("MDD1"); // file signature

function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(APP_KEY_MATERIAL).digest();
}

/**
 * Encrypt a UTF-8 string into an MDD backup buffer.
 * Format: MAGIC(4) | IV(12) | AUTH_TAG(16) | CIPHERTEXT(…)
 */
export function encryptBackup(plaintext: string): Buffer {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

/**
 * Decrypt an MDD backup buffer back to a UTF-8 string.
 * Throws on invalid/corrupted data.
 */
export function decryptBackup(data: Buffer): string {
  if (data.length < MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Backup-Datei zu kurz oder ungültig");
  }
  const magic = data.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error("Keine gültige MDD-Backup-Datei (falsche Signatur)");
  }
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const authTag = data.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
