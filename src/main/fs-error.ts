// Maps low-level filesystem/OS error codes to a human-readable cause so that a
// generic "write failed" or "timeout" can be reported as the specific root cause
// (disk full, permission denied, ...). Pure + side-effect-free for testing.

const DISK_ERROR_REASONS: Record<string, string> = {
  ENOSPC: "Festplatte voll (ENOSPC)",
  EDQUOT: "Speicher-Kontingent erschöpft (EDQUOT)",
  EROFS: "Laufwerk schreibgeschützt (EROFS)",
  EACCES: "Zugriff verweigert (EACCES)",
  EPERM: "Operation nicht erlaubt (EPERM)",
  EMFILE: "Zu viele offene Dateien (EMFILE)",
  ENFILE: "System-Limit offener Dateien erreicht (ENFILE)",
  EBUSY: "Datei/Laufwerk belegt (EBUSY)",
  ENODEV: "Gerät nicht vorhanden (ENODEV)",
  ENXIO: "Gerät getrennt (ENXIO)",
  EIO: "Ein-/Ausgabefehler des Datenträgers (EIO)"
};

export function classifyDiskError(err: unknown): string | null {
  const code = extractErrorCode(err);
  if (code && DISK_ERROR_REASONS[code]) {
    return DISK_ERROR_REASONS[code];
  }
  // Some errors arrive as plain strings/messages without a `.code`; fall back to
  // scanning the text for a known code token.
  const text = errorText(err);
  for (const knownCode of Object.keys(DISK_ERROR_REASONS)) {
    if (text.includes(knownCode)) {
      return DISK_ERROR_REASONS[knownCode];
    }
  }
  return null;
}

function extractErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code.toUpperCase();
    }
  }
  return "";
}

function errorText(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(err ?? "");
}
