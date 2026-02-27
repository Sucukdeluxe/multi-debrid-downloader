import { DebridService } from "../src/main/debrid";
import { defaultSettings } from "../src/main/constants";

const links = [
  "https://rapidgator.net/file/837ef967aede4935e3e0374c4e663b40/GTHDERTPIIP7P401.part1.rar.html",
  "https://rapidgator.net/file/ef3c9d64c899f801d69d6888dad89dcd/GTHDERTPIIP7P401.part2.rar.html",
  "https://rapidgator.net/file/b38130fcf1e8448953250b9a1ed7958d/GTHDERTPIIP7P401.part3.rar.html"
];

const settings = {
  ...defaultSettings(),
  token: process.env.RD_TOKEN || "",
  megaToken: process.env.MEGA_TOKEN || "",
  bestToken: process.env.BEST_TOKEN || "",
  allDebridToken: process.env.ALLDEBRID_TOKEN || "",
  providerPrimary: "alldebrid" as const,
  providerSecondary: "realdebrid" as const,
  providerTertiary: "megadebrid" as const,
  autoProviderFallback: true
};

if (!settings.token && !settings.megaToken && !settings.bestToken && !settings.allDebridToken) {
  console.error("No provider tokens set. Use RD_TOKEN/MEGA_TOKEN/BEST_TOKEN/ALLDEBRID_TOKEN.");
  process.exit(1);
}

async function main(): Promise<void> {
  const service = new DebridService(settings);
  for (const link of links) {
    try {
      const result = await service.unrestrictLink(link);
      console.log(`[OK] ${result.providerLabel} -> ${result.fileName}`);
    } catch (error) {
      console.log(`[FAIL] ${String(error)}`);
    }
  }
}

void main();
