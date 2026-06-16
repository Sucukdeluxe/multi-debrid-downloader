export function isMegaDebridResolveFailure(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return /supprim/.test(text)
    || text.includes("introuvable")
    || text.includes("n'existe plus")
    || text.includes("n existe plus")
    || text.includes("fichier inexistant");
}

export function germanMegaDebridResolveReason(errorText: string): string {
  const text = String(errorText || "").toLowerCase();
  if (text.includes("introuvable") || text.includes("fichier inexistant") || text.includes("n'existe plus") || text.includes("n existe plus")) {
    return "Datei beim Hoster nicht gefunden";
  }
  return "Datei beim Hoster gerade nicht abrufbar";
}
