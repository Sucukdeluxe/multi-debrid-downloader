import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeConnectionCode } from "../src/code.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, "..", "src", "bridge.mjs");
const TOKEN = "test-token-abc123";

const failures = [];
function check(name, cond, detail) {
  if (cond) {
    process.stdout.write(`  PASS ${name}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

function startFakeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const auth = req.headers.authorization || "";
      const tokenOk = auth === `Bearer ${TOKEN}` || url.searchParams.get("token") === TOKEN;
      if (!tokenOk) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const p = url.pathname;
      const q = Object.fromEntries(url.searchParams.entries());
      const send = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (p === "/health") return send({ status: "ok", appVersion: "1.7.222", uptime: 42 });
      if (p === "/diagnostics") return send({ meta: { appVersion: "1.7.222" }, status: { active: 1 }, query: q });
      if (p === "/errors") return send({ errors: [{ level: "ERROR", message: "boom" }], query: q });
      if (p === "/logs/main") return send({ lines: ["line1", "line2"], count: 2, query: q });
      if (p === "/status") return send({ active: 1, queued: 3 });
      if (p === "/items") return send({ items: [], query: q });
      if (p === "/accounts") return send({ accounts: [{ name: "acc1", premium: true }] });
      if (p === "/meta") return send({ appVersion: "1.7.222", endpoints: ["/health", "/diagnostics"] });
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path: p }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startBridge() {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 15000);
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { child, rpc, notify };
}

function textOf(callResult) {
  const c = callResult && callResult.result && callResult.result.content;
  if (!Array.isArray(c)) return "";
  return c.map((x) => x.text || "").join("\n");
}

async function run() {
  const fake = await startFakeServer();
  const port = fake.address().port;
  const code = encodeConnectionCode({ host: "127.0.0.1", port, token: TOKEN, name: "testserver" });
  const badCode = encodeConnectionCode({ host: "127.0.0.1", port, token: "WRONG", name: "testserver" });

  const bridge = startBridge();
  try {
    const init = await bridge.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "harness", version: "1.0.0" }
    });
    check("initialize handshake", !!(init.result && init.result.serverInfo), JSON.stringify(init.error || {}));
    check("server name reported", init.result && init.result.serverInfo && init.result.serverInfo.name === "rd-diagnostics-mcp");
    bridge.notify("notifications/initialized", {});

    const tools = await bridge.rpc("tools/list", {});
    const names = (tools.result && tools.result.tools || []).map((t) => t.name);
    check("tools/list returns tools", names.length >= 10, `got ${names.length}`);
    for (const expected of ["rd_ping", "rd_diagnostics", "rd_errors", "rd_logs", "rd_get", "rd_servers"]) {
      check(`tool present: ${expected}`, names.includes(expected));
    }

    const ping = await bridge.rpc("tools/call", { name: "rd_ping", arguments: { code } });
    const pingText = textOf(ping);
    check("rd_ping reaches server", /HTTP 200/.test(pingText) && /"status": "ok"/.test(pingText), pingText.slice(0, 200));
    check("rd_ping shows server label", /testserver \(127\.0\.0\.1:/.test(pingText));

    const diag = await bridge.rpc("tools/call", { name: "rd_diagnostics", arguments: { code, lines: 50, grep: "err" } });
    const diagText = textOf(diag);
    check("rd_diagnostics returns aggregate", /"appVersion": "1\.7\.222"/.test(diagText));
    check("rd_diagnostics passes query params", /"lines": "50"/.test(diagText) && /"grep": "err"/.test(diagText), diagText.slice(0, 300));

    const logs = await bridge.rpc("tools/call", { name: "rd_logs", arguments: { code, name: "main", lines: 5 } });
    const logsText = textOf(logs);
    check("rd_logs maps name→path + lines", /logs\/main\?lines=5/.test(logsText) && /"count": 2/.test(logsText), logsText.slice(0, 200));

    const errs = await bridge.rpc("tools/call", { name: "rd_errors", arguments: { code, level: "ERROR" } });
    check("rd_errors returns ring", /"message": "boom"/.test(textOf(errs)));

    const raw = await bridge.rpc("tools/call", { name: "rd_get", arguments: { code, path: "/meta" } });
    check("rd_get escape hatch hits arbitrary path", /"endpoints"/.test(textOf(raw)));

    const unauthorized = await bridge.rpc("tools/call", { name: "rd_ping", arguments: { code: badCode } });
    check("bad token → HTTP 401 + isError", /HTTP 401/.test(textOf(unauthorized)) && unauthorized.result.isError === true);

    const noCode = await bridge.rpc("tools/call", { name: "rd_ping", arguments: {} });
    check("missing code → graceful isError", noCode.result && noCode.result.isError === true && /Kein Verbindungscode/.test(textOf(noCode)));

    const unreachable = await bridge.rpc("tools/call", {
      name: "rd_ping",
      arguments: { code: encodeConnectionCode({ host: "127.0.0.1", port: 1, token: TOKEN }) }
    });
    check("unreachable → isError + hint", unreachable.result.isError === true && /nicht erreichbar|abgebrochen|FEHLER/.test(textOf(unreachable)), textOf(unreachable).slice(0, 160));
  } finally {
    bridge.child.kill();
    fake.close();
  }

  process.stdout.write("\n");
  if (failures.length) {
    process.stdout.write(`RESULT: ${failures.length} FAIL\n`);
    process.exit(1);
  }
  process.stdout.write("RESULT: ALL PASS\n");
  process.exit(0);
}

run().catch((err) => {
  process.stderr.write(`harness error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
