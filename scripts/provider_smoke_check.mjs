const RAPIDGATOR_LINKS = [
  "https://rapidgator.net/file/837ef967aede4935e3e0374c4e663b40/GTHDERTPIIP7P401.part1.rar.html",
  "https://rapidgator.net/file/ef3c9d64c899f801d69d6888dad89dcd/GTHDERTPIIP7P401.part2.rar.html",
  "https://rapidgator.net/file/b38130fcf1e8448953250b9a1ed7958d/GTHDERTPIIP7P401.part3.rar.html"
];

const rdToken = process.env.RD_TOKEN || "";
const megaLogin = process.env.MEGA_LOGIN || "";
const megaPassword = process.env.MEGA_PASSWORD || "";
const bestToken = process.env.BEST_TOKEN || "";
const allDebridToken = process.env.ALLDEBRID_TOKEN || "";
let megaCookie = "";

if (!rdToken && !(megaLogin && megaPassword) && !bestToken && !allDebridToken) {
  console.error("No provider credentials configured. Set RD_TOKEN and/or MEGA_LOGIN+MEGA_PASSWORD and/or BEST_TOKEN and/or ALLDEBRID_TOKEN.");
  process.exit(1);
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function pickString(payload, keys) {
  if (!payload) {
    return "";
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function parseResponseError(status, bodyText, payload) {
  return pickString(payload, ["response_text", "error", "message", "error_description"]) || bodyText || `HTTP ${status}`;
}

async function callRealDebrid(link) {
  const response = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rdToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RD-Node-Downloader/1.1.12"
    },
    body: new URLSearchParams({ link })
  });
  const text = await response.text();
  const payload = asRecord(safeJson(text));
  if (!response.ok) {
    return { ok: false, error: parseResponseError(response.status, text, payload) };
  }
  const direct = pickString(payload, ["download", "link"]);
  if (!direct) {
    return { ok: false, error: "Real-Debrid returned no download URL" };
  }
  return {
    ok: true,
    direct,
    fileName: pickString(payload, ["filename", "fileName"])
  };
}

async function callMegaDebrid(link) {
  if (!megaCookie) {
    const loginRes = await fetch("https://www.mega-debrid.eu/index.php?form=login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0"
      },
      body: new URLSearchParams({ login: megaLogin, password: megaPassword, remember: "on" }),
      redirect: "manual"
    });
    if (loginRes.status >= 400) {
      return { ok: false, error: `Mega-Web login failed with HTTP ${loginRes.status}` };
    }
    megaCookie = loginRes.headers.getSetCookie()
      .map((chunk) => chunk.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    if (!megaCookie) {
      return { ok: false, error: "Mega-Web login returned no session cookie" };
    }
  }

  const debridRes = await fetch("https://www.mega-debrid.eu/index.php?form=debrid", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      Cookie: megaCookie,
      Referer: "https://www.mega-debrid.eu/index.php?page=debrideur&lang=de"
    },
    body: new URLSearchParams({ links: link, password: "", showLinks: "1" })
  });
  const html = await debridRes.text();
  const code = html.match(/processDebrid\(\d+,'([^']+)',0\)/i)?.[1] || "";
  if (!code) {
    return { ok: false, error: "Mega-Web returned no processDebrid code" };
  }

  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const ajaxRes = await fetch("https://www.mega-debrid.eu/index.php?ajax=debrid&json", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
        Cookie: megaCookie,
        Referer: "https://www.mega-debrid.eu/index.php?page=debrideur&lang=de"
      },
      body: new URLSearchParams({ code, autodl: "0" })
    });
    const txt = (await ajaxRes.text()).trim();
    if (txt === "reload") {
      await new Promise((resolve) => setTimeout(resolve, 650));
      continue;
    }
    if (txt === "false") {
      return { ok: false, error: "Mega-Web returned false" };
    }
    const payload = safeJson(txt);
    const direct = String(payload?.link || "");
    if (!direct) {
      const msg = String(payload?.text || txt || "Mega-Web no link");
      if (/hoster does not respond correctly|could not be done for this moment/i.test(msg)) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }
      return { ok: false, error: msg };
    }
    return {
      ok: true,
      direct,
      fileName: pickString(asRecord(payload), ["filename"]) || ""
    };
  }
  return { ok: false, error: "Mega-Web timeout while generating link" };
}

async function callBestDebrid(link) {
  const encoded = encodeURIComponent(link);
  const requests = [
    {
      url: `https://bestdebrid.com/api/v1/generateLink?link=${encoded}`,
      useHeader: true
    },
    {
      url: `https://bestdebrid.com/api/v1/generateLink?auth=${encodeURIComponent(bestToken)}&link=${encoded}`,
      useHeader: false
    }
  ];

  let lastError = "Unknown BestDebrid error";
  for (const req of requests) {
    const headers = {
      "User-Agent": "RD-Node-Downloader/1.1.12"
    };
    if (req.useHeader) {
      headers.Authorization = bestToken;
    }
    const response = await fetch(req.url, {
      method: "GET",
      headers
    });
    const text = await response.text();
    const parsed = safeJson(text);
    const payload = Array.isArray(parsed) ? asRecord(parsed[0]) : asRecord(parsed);

    if (!response.ok) {
      lastError = parseResponseError(response.status, text, payload);
      continue;
    }

    const direct = pickString(payload, ["download", "debridLink", "link"]);
    if (!direct) {
      lastError = pickString(payload, ["response_text", "message", "error"]) || "BestDebrid returned no download URL";
      continue;
    }
    return {
      ok: true,
      direct,
      fileName: pickString(payload, ["filename", "fileName"])
    };
  }
  return { ok: false, error: lastError };
}

async function callAllDebrid(link) {
  const response = await fetch("https://api.alldebrid.com/v4/link/unlock", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${allDebridToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RD-Node-Downloader/1.1.12"
    },
    body: new URLSearchParams({ link })
  });

  const text = await response.text();
  const payload = asRecord(safeJson(text));
  if (!response.ok) {
    return { ok: false, error: parseResponseError(response.status, text, payload) };
  }

  if (pickString(payload, ["status"]) === "error") {
    const err = asRecord(payload?.error);
    return { ok: false, error: pickString(err, ["message", "code"]) || "AllDebrid API error" };
  }

  const data = asRecord(payload?.data);
  const direct = pickString(data, ["link"]);
  if (!direct) {
    return { ok: false, error: "AllDebrid returned no download URL" };
  }
  return {
    ok: true,
    direct,
    fileName: pickString(data, ["filename"])
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

async function main() {
  const providers = [];
  if (rdToken) {
    providers.push({ name: "Real-Debrid", run: callRealDebrid });
  }
  if (megaLogin && megaPassword) {
    providers.push({ name: "Mega-Debrid", run: callMegaDebrid });
  }
  if (bestToken) {
    providers.push({ name: "BestDebrid", run: callBestDebrid });
  }
  if (allDebridToken) {
    providers.push({ name: "AllDebrid", run: callAllDebrid });
  }

  let failures = 0;

  for (const link of RAPIDGATOR_LINKS) {
    console.log(`\nLink: ${link}`);
    const results = [];
    for (const provider of providers) {
      try {
        const result = await provider.run(link);
        results.push({ provider: provider.name, ...result });
      } catch (error) {
        results.push({ provider: provider.name, ok: false, error: String(error) });
      }
    }

    for (const result of results) {
      if (result.ok) {
        console.log(`  [OK]   ${result.provider} -> ${hostFromUrl(result.direct)} ${result.fileName ? `(${result.fileName})` : ""}`);
      } else {
        console.log(`  [FAIL] ${result.provider} -> ${result.error}`);
      }
    }

    const fallbackPick = results.find((entry) => entry.ok);
    if (fallbackPick) {
      console.log(`  [AUTO] Selected by fallback order: ${fallbackPick.provider}`);
    } else {
      failures += 1;
      console.log("  [AUTO] No provider could unrestrict this link");
    }
  }

  if (failures > 0) {
    process.exitCode = 2;
  }
}

await main().catch((e) => { console.error(e); process.exit(1); });
