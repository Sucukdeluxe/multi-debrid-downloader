import { describe, expect, it } from "vitest";
import { isMegaDebridResolveFailure, germanMegaDebridResolveReason } from "../src/shared/mega-debrid-errors";

describe("isMegaDebridResolveFailure", () => {
  it("detects the real Mega-Debrid French resolve-failure phrase", () => {
    expect(isMegaDebridResolveFailure("Mega-Debrid API: Fichier supprimé chez l'hébergeur")).toBe(true);
  });

  it("matches inside the aggregated provider-chain error (api fail | web timeout)", () => {
    const aggregated = "Unrestrict fehlgeschlagen: Mega-Debrid API: Mega-Debrid (API): Fichier supprimé chez l'hébergeur | Mega-Debrid Web: Mega-Debrid (Web): Abbruch/Timeout nach 60s";
    expect(isMegaDebridResolveFailure(aggregated)).toBe(true);
  });

  it("matches the de-accented variant", () => {
    expect(isMegaDebridResolveFailure("Fichier supprime chez l'hebergeur")).toBe(true);
  });

  it("matches other Mega-Debrid resolve phrases", () => {
    expect(isMegaDebridResolveFailure("Fichier introuvable")).toBe(true);
    expect(isMegaDebridResolveFailure("Le fichier n'existe plus")).toBe(true);
  });

  it("does NOT match unrelated/transient text", () => {
    expect(isMegaDebridResolveFailure("Abbruch/Timeout nach 60s")).toBe(false);
    expect(isMegaDebridResolveFailure("Quota/Limit erreicht")).toBe(false);
  });
});

describe("germanMegaDebridResolveReason (transient wording, NOT 'tot')", () => {
  it("renders 'supprimé' as a transient, retryable German reason", () => {
    const reason = germanMegaDebridResolveReason("Mega-Debrid API: Fichier supprimé chez l'hébergeur");
    expect(reason).toBe("Datei beim Hoster gerade nicht abrufbar");
    expect(reason.toLowerCase()).not.toContain("tot");
    expect(reason.toLowerCase()).not.toContain("gelöscht");
  });

  it("renders not-found phrases in German", () => {
    expect(germanMegaDebridResolveReason("Fichier introuvable")).toBe("Datei beim Hoster nicht gefunden");
  });
});
