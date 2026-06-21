#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decodeConnectionCode } from "./code.mjs";
import { debugGet } from "./http.mjs";

function loadServerMap() {
  const map = new Map();
  const raw = process.env.RDDIAG_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const [name, code] of Object.entries(parsed || {})) {
        map.set(String(name), String(code));
      }
    } catch {
      process.stderr.write("rd-diagnostics-mcp: RDDIAG_SERVERS ist kein gueltiges JSON, wird ignoriert\n");
    }
  }
  return map;
}

const SERVER_MAP = loadServerMap();
const DEFAULT_CODE = process.env.RDDIAG_CODE ? String(process.env.RDDIAG_CODE) : "";

function listAvailableServers() {
  const names = [...SERVER_MAP.keys()];
  if (DEFAULT_CODE) names.push("(RDDIAG_CODE-Default)");
  return names;
}

function resolveTarget(args) {
  let code = "";
  if (args && args.code) {
    code = String(args.code);
  } else if (args && args.server) {
    const found = SERVER_MAP.get(String(args.server));
    if (!found) {
      throw new Error(
        `Server "${args.server}" nicht konfiguriert. Bekannt: ${listAvailableServers().join(", ") || "(keine)"}`
      );
    }
    code = found;
  } else if (DEFAULT_CODE) {
    code = DEFAULT_CODE;
  } else if (SERVER_MAP.size === 1) {
    code = [...SERVER_MAP.values()][0];
  } else {
    throw new Error(
      `Kein Verbindungscode. Uebergib "code" oder "server", oder setze RDDIAG_CODE/RDDIAG_SERVERS. Bekannt: ${listAvailableServers().join(", ") || "(keine)"}`
    );
  }
  return decodeConnectionCode(code);
}

function targetLabel(target) {
  return target.name ? `${target.name} (${target.host}:${target.port})` : `${target.host}:${target.port}`;
}

function buildQuery(params) {
  const usable = Object.entries(params || {}).filter(
    ([, v]) => v !== undefined && v !== null && String(v).length > 0
  );
  if (usable.length === 0) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of usable) sp.set(k, String(v));
  return "?" + sp.toString();
}

function prettyBody(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function connectionHint(err) {
  const m = String((err && err.code) || err && err.message || "");
  if (/ECONNREFUSED/.test(m)) return "Debug-Server nicht erreichbar — auf dem Server aktiviert? Port/Firewall offen?";
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "Host nicht aufloesbar — stimmt die Adresse im Verbindungscode?";
  if (/ETIMEDOUT|Zeitueberschreitung/.test(m)) return "Zeitueberschreitung — Server/Netz langsam oder Port geblockt.";
  if (/ECONNRESET|EPIPE/.test(m)) return "Verbindung abgebrochen — falscher Port/Scheme (http vs https)?";
  if (/Fingerprint/.test(m)) return "TLS-Fingerprint passt nicht — Code stammt evtl. von einem anderen Server.";
  return "";
}

async function requestTool(args, path, params, opts = {}) {
  let target;
  try {
    target = resolveTarget(args);
  } catch (err) {
    return { content: [{ type: "text", text: `# Verbindungsfehler\n${err.message}` }], isError: true };
  }
  const fullPath = path + buildQuery(params);
  const label = targetLabel(target);
  try {
    const res = await debugGet(target, fullPath, { timeoutMs: opts.timeoutMs || 20000 });
    const isError = res.status < 200 || res.status >= 300;
    let extra = "";
    if (res.status === 401) extra = "\n(401 = Token im Verbindungscode ist abgelaufen/rotiert. Neuen Code anfordern.)";
    if (res.status === 503) extra = "\n(503 = Download-Manager nicht bereit. App laeuft, aber noch nicht initialisiert?)";
    const head = `# ${label} ${fullPath} → HTTP ${res.status}${extra}`;
    return { content: [{ type: "text", text: head + "\n" + prettyBody(res.body) }], isError };
  } catch (err) {
    const hint = connectionHint(err);
    const text = `# ${label} ${fullPath} → FEHLER\n${err.message}${hint ? "\n→ " + hint : ""}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

const CODE_FIELD = {
  code: z.string().optional().describe("Verbindungscode (rddiag:v1:...). Optional, wenn server/RDDIAG_CODE gesetzt ist."),
  server: z.string().optional().describe("Name eines via RDDIAG_SERVERS konfigurierten Servers statt eines vollen Codes.")
};

const server = new McpServer({ name: "rd-diagnostics-mcp", version: "1.0.0" });

server.registerTool(
  "rd_servers",
  {
    title: "Konfigurierte Server",
    description: "Listet die in dieser Bridge konfigurierten Server (RDDIAG_SERVERS / RDDIAG_CODE). Verbindet sich nicht.",
    inputSchema: {}
  },
  async () => {
    const names = [...SERVER_MAP.keys()];
    const lines = [];
    lines.push(`Konfigurierte Server: ${names.length}`);
    for (const n of names) lines.push(`- ${n}`);
    lines.push(`Default (RDDIAG_CODE): ${DEFAULT_CODE ? "gesetzt" : "nicht gesetzt"}`);
    lines.push("");
    lines.push("Tools akzeptieren entweder code:<rddiag:v1:...> oder server:<name>.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "rd_ping",
  {
    title: "Erreichbarkeit pruefen",
    description: "Schneller Health-Check (GET /health): App-Version, Uptime, Speicher. Zuerst aufrufen, um Erreichbarkeit + Token zu pruefen.",
    inputSchema: { ...CODE_FIELD }
  },
  async (args) => requestTool(args, "/health", {}, { timeoutMs: 10000 })
);

server.registerTool(
  "rd_diagnostics",
  {
    title: "Gesamtdiagnose",
    description: "Aggregierter Zustand (GET /diagnostics): Meta, Status, Settings, Stats, Accounts, History, Host + die wichtigsten Logs. Der 'alles auf einen Blick'-Endpunkt.",
    inputSchema: {
      ...CODE_FIELD,
      lines: z.number().int().positive().optional().describe("Anzahl Log-Zeilen pro Log (Default 150)."),
      grep: z.string().optional().describe("Filter fuer Log-Zeilen."),
      package: z.string().optional().describe("Optional auf ein Paket fokussieren.")
    }
  },
  async (args) => requestTool(args, "/diagnostics", { lines: args.lines, grep: args.grep, package: args.package }, { timeoutMs: 30000 })
);

server.registerTool(
  "rd_status",
  {
    title: "Live-Status",
    description: "Laufzeit-Status (GET /status): aktive Downloads, Queue, Provider-Zustand.",
    inputSchema: { ...CODE_FIELD }
  },
  async (args) => requestTool(args, "/status", {})
);

server.registerTool(
  "rd_items",
  {
    title: "Download-Items",
    description: "Einzelne Download-Items (GET /items), optional gefiltert nach Status/Paket.",
    inputSchema: {
      ...CODE_FIELD,
      status: z.string().optional().describe("Status-Filter (z.B. downloading, error, done)."),
      package: z.string().optional().describe("Paket-Filter.")
    }
  },
  async (args) => requestTool(args, "/items", { status: args.status, package: args.package })
);

server.registerTool(
  "rd_packages",
  {
    title: "Pakete",
    description: "Pakete (GET /packages), optional mit enthaltenen Items.",
    inputSchema: {
      ...CODE_FIELD,
      package: z.string().optional().describe("Bestimmtes Paket."),
      includeItems: z.boolean().optional().describe("Items mitliefern.")
    }
  },
  async (args) => requestTool(args, "/packages", { package: args.package, includeItems: args.includeItems ? "1" : "" })
);

server.registerTool(
  "rd_errors",
  {
    title: "Letzte Fehler",
    description: "Fehler-Ring (GET /errors): die letzten Fehler mit Level/Quelle. 'Was ist schiefgelaufen'.",
    inputSchema: {
      ...CODE_FIELD,
      level: z.string().optional().describe("Level-Filter (ERROR, WARN, ...)."),
      limit: z.number().int().positive().optional().describe("Anzahl (Default 100).")
    }
  },
  async (args) => requestTool(args, "/errors", { level: args.level, limit: args.limit })
);

const LOG_PATHS = {
  main: "/logs/main",
  audit: "/logs/audit",
  rename: "/logs/rename",
  trace: "/logs/trace",
  session: "/logs/session",
  conversion: "/logs/conversion",
  package: "/logs/package",
  item: "/logs/item"
};

server.registerTool(
  "rd_logs",
  {
    title: "Log lesen",
    description: "Liest das Ende eines Logs (GET /logs/<name>). name: main|audit|rename|trace|session|conversion|package|item. conversion = Pro-Item Link-Aufloesungs-Lebenszyklus (Token, API, Web, Rotation, Abbrueche mit Zeiten). Fuer package/item zusaetzlich package/item angeben.",
    inputSchema: {
      ...CODE_FIELD,
      name: z.enum(["main", "audit", "rename", "trace", "session", "conversion", "package", "item"]).describe("Welches Log."),
      lines: z.number().int().positive().optional().describe("Anzahl Zeilen vom Ende (Default 100)."),
      grep: z.string().optional().describe("Filter."),
      package: z.string().optional().describe("Nur fuer name=package."),
      item: z.string().optional().describe("Nur fuer name=item.")
    }
  },
  async (args) => {
    const path = LOG_PATHS[args.name];
    return requestTool(args, path, { lines: args.lines, grep: args.grep, package: args.package, item: args.item });
  }
);

server.registerTool(
  "rd_history",
  {
    title: "Verlauf",
    description: "Abgeschlossener Verlauf (GET /history), optional nach Status/Suchbegriff.",
    inputSchema: {
      ...CODE_FIELD,
      limit: z.number().int().positive().optional().describe("Anzahl (Default 50)."),
      status: z.string().optional().describe("Status-Filter."),
      grep: z.string().optional().describe("Suchbegriff.")
    }
  },
  async (args) => requestTool(args, "/history", { limit: args.limit, status: args.status, grep: args.grep })
);

server.registerTool(
  "rd_accounts",
  {
    title: "Accounts",
    description: "Debrid-Accounts (GET /accounts, Token redigiert): Gueltigkeit, Premium, Cooldown/Rotation.",
    inputSchema: { ...CODE_FIELD }
  },
  async (args) => requestTool(args, "/accounts", {})
);

server.registerTool(
  "rd_providers",
  {
    title: "Provider-Laufzeitzustand",
    description: "Live Provider-Runtime (GET /providers): pro Mega-Account/Debrid-Link-Key der AKTIVE Cooldown (until/remainingMs/Grund/Kategorie), in-flight-Tiefe, Mega-Rotationscursor, Empty-Response-Streaks. Die 'warum kuehlt es JETZT ab'-Ansicht — beantwortet Cooldown-Fragen direkt statt aus Log-Arithmetik.",
    inputSchema: { ...CODE_FIELD }
  },
  async (args) => requestTool(args, "/providers", {})
);

server.registerTool(
  "rd_host",
  {
    title: "Host-Diagnose",
    description: "Windows-Host-Diagnose (GET /host/diagnostics): Laufwerke, Speicher, Pfade.",
    inputSchema: { ...CODE_FIELD }
  },
  async (args) => requestTool(args, "/host/diagnostics", {})
);

server.registerTool(
  "rd_self_check",
  {
    title: "Self-Check",
    description: "Setup/Self-Check (GET /self-check): erkennt Konfigurations-/Pfadprobleme.",
    inputSchema: { ...CODE_FIELD }
  },
  async (args) => requestTool(args, "/self-check", {})
);

server.registerTool(
  "rd_get",
  {
    title: "Roh-Endpunkt (Escape-Hatch)",
    description: "Beliebigen Debug-Server-Pfad lesen (GET <path>), wenn kein spezialisiertes Tool passt. Pfad inkl. fuehrendem / und optionalem Query-String, z.B. /meta oder /stats.",
    inputSchema: {
      ...CODE_FIELD,
      path: z.string().describe("Pfad mit fuehrendem /, optional ?query. Nur GET, read-only.")
    }
  },
  async (args) => {
    const p = String(args.path || "");
    if (!p.startsWith("/")) {
      return { content: [{ type: "text", text: "# Fehler\npath muss mit / beginnen" }], isError: true };
    }
    return requestTool(args, p, {}, { timeoutMs: 30000 });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `rd-diagnostics-mcp bereit. Server: ${listAvailableServers().join(", ") || "(keine vorkonfiguriert; code pro Aufruf uebergeben)"}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`rd-diagnostics-mcp Startfehler: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
