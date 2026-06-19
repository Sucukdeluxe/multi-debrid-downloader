import http from "node:http";
import https from "node:https";

function normalizeFp(fp) {
  return String(fp || "").replace(/:/g, "").toLowerCase();
}

export function debugGet(target, path, { timeoutMs = 20000 } = {}) {
  const scheme = target.scheme === "https" ? "https" : "http";
  const lib = scheme === "https" ? https : http;
  const rel = path.startsWith("/") ? path : "/" + path;
  const url = new URL(rel, `${scheme}://${target.host}:${target.port}`);
  const pinning = scheme === "https" && !!target.fingerprint;

  return new Promise((resolve, reject) => {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/json"
      },
      timeout: timeoutMs
    };
    if (scheme === "https") {
      options.rejectUnauthorized = !target.fingerprint;
    }

    const req = lib.request(url, options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode || 0, body: data, headers: res.headers });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Zeitueberschreitung nach ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      reject(err);
    });

    if (pinning) {
      req.on("socket", (socket) => {
        socket.on("secureConnect", () => {
          const cert = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate() : null;
          const got = normalizeFp(cert && cert.fingerprint256);
          const want = normalizeFp(target.fingerprint);
          if (!got || got !== want) {
            req.destroy(new Error(`TLS-Fingerprint stimmt nicht (erwartet ${want || "?"}, erhalten ${got || "?"})`));
            return;
          }
          req.end();
        });
      });
    } else {
      req.end();
    }
  });
}
