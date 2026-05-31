/**
 * Zeitstempel für Log-Dateien in LOKALER Zeit mit explizitem UTC-Offset
 * (ISO 8601, z. B. "2026-05-31T19:29:43.605+02:00").
 *
 * Vorher nutzten alle Logger `new Date().toISOString()` → UTC ("...Z"). Auf einem
 * CEST-Server (UTC+2) las der User dadurch z. B. "17:29:43" statt der erwarteten
 * lokalen "19:29:43". Lokale Zeit MIT Offset bleibt eindeutig + maschinell parsebar
 * (Date.parse versteht den Offset), zeigt dem User aber die Uhrzeit seiner Zeitzone.
 */
export function logTimestamp(date: Date = new Date()): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  // getTimezoneOffset() liefert Minuten, die man zur LOKALEN Zeit ADDIEREN muss, um
  // UTC zu erhalten — also negiert = Offset der lokalen Zone gegenüber UTC.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`
  );
}
