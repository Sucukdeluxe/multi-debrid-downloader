import { describe, expect, it } from "vitest";
import { encryptBackup, decryptBackup } from "../src/main/backup-crypto";

describe("backup-crypto", () => {
  it("encrypts and decrypts a round-trip correctly", () => {
    const original = JSON.stringify({
      version: 2,
      settings: { token: "my-secret-api-key", outputDir: "C:\\Downloads" },
      session: { packages: {}, items: {} },
      history: [{ id: "h1", name: "Test" }]
    });

    const encrypted = encryptBackup(original);
    const decrypted = decryptBackup(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces binary output that is not plaintext readable", () => {
    const secret = "super-secret-token-12345";
    const plaintext = JSON.stringify({ settings: { token: secret } });
    const encrypted = encryptBackup(plaintext);

    // The encrypted buffer should NOT contain the secret in plaintext
    expect(encrypted.toString("utf8")).not.toContain(secret);
    expect(encrypted.toString("latin1")).not.toContain(secret);
  });

  it("starts with the MDD1 magic bytes", () => {
    const encrypted = encryptBackup("test");
    expect(encrypted.subarray(0, 4).toString("utf8")).toBe("MDD1");
  });

  it("produces different ciphertext for the same input (random IV)", () => {
    const plaintext = "same input data";
    const a = encryptBackup(plaintext);
    const b = encryptBackup(plaintext);
    // IVs are different, so full buffers must differ
    expect(a.equals(b)).toBe(false);
    // But both decrypt to the same plaintext
    expect(decryptBackup(a)).toBe(plaintext);
    expect(decryptBackup(b)).toBe(plaintext);
  });

  it("throws on truncated data", () => {
    const encrypted = encryptBackup("test data");
    const truncated = encrypted.subarray(0, 10);
    expect(() => decryptBackup(truncated)).toThrow();
  });

  it("throws on corrupted ciphertext", () => {
    const encrypted = encryptBackup("test data");
    // Flip a byte in the ciphertext area
    const corrupted = Buffer.from(encrypted);
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(() => decryptBackup(corrupted)).toThrow();
  });

  it("throws on wrong magic bytes", () => {
    const encrypted = encryptBackup("test data");
    const wrongMagic = Buffer.from(encrypted);
    wrongMagic[0] = 0x00;
    expect(() => decryptBackup(wrongMagic)).toThrow(/Signatur/);
  });

  it("throws on empty buffer", () => {
    expect(() => decryptBackup(Buffer.alloc(0))).toThrow();
  });

  it("handles large payloads", () => {
    const large = JSON.stringify({ data: "x".repeat(1_000_000) });
    const encrypted = encryptBackup(large);
    const decrypted = decryptBackup(encrypted);
    expect(decrypted).toBe(large);
  });

  it("handles unicode content", () => {
    const unicode = JSON.stringify({ name: "Ünïcödé 日本語 🎉", path: "C:\\Benutzer\\Ö" });
    const encrypted = encryptBackup(unicode);
    expect(decryptBackup(encrypted)).toBe(unicode);
  });

  it("handles empty string round-trip", () => {
    const encrypted = encryptBackup("");
    expect(decryptBackup(encrypted)).toBe("");
  });
});
