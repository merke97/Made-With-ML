// kb.dk access layer: holds the anonymous auth cookie and forwards Solr calls.
// The browser can't do this itself (no CORS + SameSite=Strict cookie), which is
// the whole reason this proxy exists.

const KB_BASE = process.env.KB_BASE || "https://www.kb.dk/ds-api/bff/v1";

let cookie = "";

function captureCookies(res) {
  // Node's fetch exposes getSetCookie(); fall back to the single-header form.
  const list = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  if (list.length) cookie = list.map((c) => c.split(";")[0]).join("; ");
}

async function authenticate() {
  const res = await fetch(`${KB_BASE}/authenticate/`, { redirect: "follow" });
  captureCookies(res);
  await res.arrayBuffer(); // drain
}

function buildQuery(tuples) {
  const sp = new URLSearchParams();
  for (const [k, v] of tuples) sp.append(k, v); // repeatable keys (fq) preserved
  return sp.toString();
}

/**
 * GET against a kb.dk path (e.g. "proxy/search/") with tuple params.
 * Re-authenticates once on 401, matching the spec's retry rule.
 */
export async function kbGet(path, tuples) {
  const url = `${KB_BASE}/${path}?${buildQuery(tuples)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cookie) await authenticate();
    const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
    if (res.status === 401 && attempt === 0) {
      cookie = "";
      continue;
    }
    if (!res.ok) throw new Error(`kb.dk ${res.status} ${res.statusText} for ${path}`);
    return res.json();
  }
  throw new Error("unreachable");
}

export const search = (tuples) => kbGet("proxy/search/", tuples);
export { KB_BASE };
