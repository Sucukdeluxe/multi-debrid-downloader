import crypto from "node:crypto";

export const SENSITIVE_KEYS = [
  "token",
  "megaLogin",
  "megaPassword",
  "bestToken",
  "allDebridToken",
  "archivePasswordList"
] as const;

export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

export interface EncryptedCredentials {
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12; // 96 bit for GCM
const SALT_LENGTH = 16;

function deriveKey(username: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(username, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

export function encryptCredentials(
  fields: Record<string, string>,
  username: string
): EncryptedCredentials {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(username, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(fields);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex")
  };
}

export function decryptCredentials(
  encrypted: EncryptedCredentials,
  username: string
): Record<string, string> {
  const salt = Buffer.from(encrypted.salt, "hex");
  const iv = Buffer.from(encrypted.iv, "hex");
  const tag = Buffer.from(encrypted.tag, "hex");
  const data = Buffer.from(encrypted.data, "hex");
  const key = deriveKey(username, salt);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return JSON.parse(decrypted.toString("utf8")) as Record<string, string>;
}
