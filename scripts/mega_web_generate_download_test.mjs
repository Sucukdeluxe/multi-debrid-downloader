const LOGIN = process.env.MEGA_LOGIN || "";
const PASSWORD = process.env.MEGA_PASSWORD || "";

const LINKS = [
  "https://rapidgator.net/file/90b5397dfc3e1a0e561db7d6b89d5604/scnb-rrw7-S08E01.part1.rar.html",
  "https://rapidgator.net/file/8ddf856dc833310c5cae9db82caf9682/scnb-rrw7-S08E01.part2.rar.html",
  "https://rapidgator.net/file/440eed67d266476866332ae224c3fad5/scnb-rrw7-S08E01.part3.rar.html"
];

if (!LOGIN || !PASSWORD) {
  throw new Error("Set MEGA_LOGIN and MEGA_PASSWORD env vars");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieFrom(headers) {
  const raw = headers.get("set-cookie") || "";
  return raw.split(",").map((x) => x.split(";")[0].trim()).filter(Boolean).join("; ");
}

function parseDebridCodes(html) {
  const re = /processDebrid\((\d+),'([^']+)',0\)/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ id: Number(m[1]), code: m[2] });
  }
  return out;
}

async function resolveCode(cookie, code) {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const res = await fetch("https://www.mega-debrid.eu/index.php?ajax=debrid&json", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
        Cookie: cookie,
        Referer: "https://www.mega-debrid.eu/index.php?page=debrideur&lang=de"
      },
      body: new URLSearchParams({
        code,
        autodl: "0"
      })
    });
    const text = (await res.text()).trim();
    if (text === "reload") {
      await sleep(800);
      continue;
    }
    if (text === "false") {
      return { ok: false, reason: "false" };
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed?.link) {
        return { ok: true, link: String(parsed.link), text: String(parsed.text || "") };
      }
      return { ok: false, reason: text };
    } catch {
      return { ok: false, reason: text };
    }
  }
  return { ok: false, reason: "timeout" };
}

async function probeDownload(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Range: "bytes=0-4095",
      "User-Agent": "Mozilla/5.0"
    },
    redirect: "manual"
  });
  return {
    status: res.status,
    location: res.headers.get("location") || "",
    contentType: res.headers.get("content-type") || "",
    contentLength: res.headers.get("content-length") || ""
  };
}

async function main() {
  const loginRes = await fetch("https://www.mega-debrid.eu/index.php?form=login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0"
    },
    body: new URLSearchParams({
      login: LOGIN,
      password: PASSWORD,
      remember: "on"
    }),
    redirect: "manual"
  });

  const cookie = cookieFrom(loginRes.headers);
  console.log("login", loginRes.status, loginRes.headers.get("location") || "");

  const debridRes = await fetch("https://www.mega-debrid.eu/index.php?form=debrid", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      Cookie: cookie,
      Referer: "https://www.mega-debrid.eu/index.php?page=debrideur&lang=de"
    },
    body: new URLSearchParams({
      links: LINKS.join("\n"),
      password: "",
      showLinks: "1"
    })
  });

  const html = await debridRes.text();
  const codes = parseDebridCodes(html);
  console.log("codes", codes.length);
  if (codes.length === 0) {
    throw new Error("No processDebrid codes found");
  }

  for (let i = 0; i < Math.min(3, codes.length); i += 1) {
    const c = codes[i];
    const resolved = await resolveCode(cookie, c.code);
    if (!resolved.ok) {
      console.log(`[FAIL] code ${c.code}: ${resolved.reason}`);
      continue;
    }
    console.log(`[OK] code ${c.code} -> ${resolved.link}`);
    const probe = await probeDownload(resolved.link);
    console.log(`     probe status=${probe.status} type=${probe.contentType} len=${probe.contentLength} loc=${probe.location}`);
  }
}

await main();
