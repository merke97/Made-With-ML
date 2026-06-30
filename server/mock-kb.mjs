// A LOCAL STAND-IN for kb.dk, only for offline verification of the proxy +
// front-end. It returns spec-shaped Solr responses (envelope, facet_pivot,
// facet_ranges, docs) generated from a tiny synthetic model. Point the proxy at
// it with KB_BASE=http://localhost:8787 . NOT used in production.

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT) || 8787;

const CHANNELS = [
  { id: "DR1", m: "ds.tv", base: 90000 },
  { id: "DR2", m: "ds.tv", base: 60000 },
  { id: "DR K", m: "ds.tv", base: 30000 },
  { id: "Ramasjang", m: "ds.tv", base: 25000 },
  { id: "P1", m: "ds.radio", base: 120000 },
  { id: "P2", m: "ds.radio", base: 70000 },
  { id: "P3", m: "ds.radio", base: 110000 },
  { id: "P4", m: "ds.radio", base: 100000 },
  { id: "DR", m: "ds.radio", base: 300000 },
];
const TITLES = ["TV Avisen", "Radioavisen", "Deadline", "Orientering", "P3 Playliste", "Matador", "Klima", "Natur"];
const GENRES = ["Nyheder/politik og samfund", "Musik", "Kultur og oplysning", "Dokumentar"];
const HOUR = 3600_000,
  DAY = 86400_000;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function parseRange(s) {
  const m = /startTime:\[(\S+) TO (\S+)\]/.exec(s || "");
  if (!m) return null;
  return { from: m[1] === "*" ? -8e15 : Date.parse(m[1]), to: m[2] === "*" ? 8e15 : Date.parse(m[2]) };
}
const gapMs = (g) => (/YEAR/.test(g) ? 365 * DAY : /MONTH/.test(g) ? 30 * DAY : /HOUR/.test(g) ? HOUR : DAY);
const yearTrend = (y) => (y < 1989 ? 0.04 : y < 2000 ? 0.5 : y < 2014 ? 1 : 0.85);

function genDocs(fromMs, toMs, channelFilter, mediaFilter, cap) {
  const docs = [];
  const chans = CHANNELS.filter(
    (c) => (!channelFilter || c.id === channelFilter) && (!mediaFilter || c.m === mediaFilter),
  );
  const day0 = Math.floor(fromMs / DAY) * DAY;
  for (let d = day0; d < toMs && docs.length < cap * 2; d += DAY) {
    for (const c of chans) {
      let t = d + 6 * HOUR;
      let i = 0;
      while (t < d + 24 * HOUR) {
        const dur = (30 + ((c.base + i) % 60)) * 60000;
        const end = t + dur;
        if (end > fromMs && t < toMs) {
          const seed = (Math.floor(t / 60000) + c.base) % TITLES.length;
          docs.push({
            id: `${c.m}:oai:mock:${c.id}-${t}`,
            title: TITLES[seed],
            creator_affiliation: c.id,
            origin: c.m,
            startTime: iso(t),
            endTime: iso(end),
            duration_ms: dur,
            genre: GENRES[seed % GENRES.length],
            has_kaltura_id: seed % 3 === 0,
          });
        }
        t = end;
        i++;
      }
    }
  }
  docs.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return docs;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Content-Type", "application/json");

  if (url.pathname.endsWith("/authenticate/")) {
    res.setHeader("Set-Cookie", "kb-auth=mocktoken; Path=/; SameSite=Strict");
    res.end("{}");
    return;
  }
  if (!url.pathname.endsWith("/proxy/search/")) {
    res.writeHead(404).end("{}");
    return;
  }

  const p = url.searchParams;
  const fqs = p.getAll("fq");
  const range = fqs.map(parseRange).find(Boolean);
  const channel = (fqs.find((f) => f.startsWith("creator_affiliation:")) || "").replace(/.*"(.*)".*/, "$1") || null;
  const media = fqs.some((f) => f === "origin:ds.tv") ? "ds.tv" : fqs.some((f) => f === "origin:ds.radio") ? "ds.radio" : null;
  const out = { responseHeader: { status: 0, QTime: 3 }, response: { numFound: 0, start: 0, docs: [] } };

  // Channel pivot facet
  if (p.get("facet.pivot") === "origin,creator_affiliation") {
    const byOrigin = { "ds.radio": [], "ds.tv": [] };
    for (const c of CHANNELS) byOrigin[c.m].push({ field: "creator_affiliation", value: c.id, count: c.base });
    out.response.numFound = CHANNELS.reduce((s, c) => s + c.base, 0);
    out.facet_counts = {
      facet_pivot: {
        "origin,creator_affiliation": [
          { field: "origin", value: "ds.radio", count: 1600000, pivot: byOrigin["ds.radio"] },
          { field: "origin", value: "ds.tv", count: 322000, pivot: byOrigin["ds.tv"] },
        ],
      },
    };
    res.end(JSON.stringify(out));
    return;
  }

  // Range facet (histogram)
  if (p.get("facet.range") === "startTime") {
    const start = Date.parse(p.get("facet.range.start"));
    const end = Date.parse(p.get("facet.range.end"));
    const g = gapMs(p.get("facet.range.gap"));
    const counts = [];
    const mf = media === "ds.tv" ? 0.2 : media === "ds.radio" ? 0.8 : 1;
    const cf = channel ? (CHANNELS.find((c) => c.id === channel)?.base ?? 50000) / 300000 : 1;
    for (let t = start; t < end; t += g) {
      const y = new Date(t).getUTCFullYear();
      const n = Math.round((g / DAY) * 14 * mf * cf * yearTrend(y));
      counts.push(iso(t), n);
    }
    out.facet_counts = { facet_ranges: { startTime: { counts, gap: p.get("facet.range.gap"), start: p.get("facet.range.start"), end: p.get("facet.range.end") } } };
    out.response.numFound = counts.filter((_, i) => i % 2 === 1).reduce((s, n) => s + n, 0);
    res.end(JSON.stringify(out));
    return;
  }

  // Free-text search: filter a recent window by title substring.
  const q = p.get("q") || "*:*";
  const rows = Math.min(2000, Number(p.get("rows")) || 0);
  if (rows === 0) {
    out.response.numFound = 1926481;
    res.end(JSON.stringify(out));
    return;
  }
  let docs;
  if (q !== "*:*") {
    const term = q.toLowerCase();
    docs = genDocs(Date.parse("2013-01-01T00:00:00Z"), Date.parse("2013-04-01T00:00:00Z"), channel, media, rows).filter(
      (d) => d.title.toLowerCase().includes(term),
    );
  } else if (range) {
    docs = genDocs(range.from, range.to, channel, media, rows);
  } else {
    docs = [];
  }
  out.response.numFound = docs.length;
  out.response.docs = docs.slice(0, rows);
  res.end(JSON.stringify(out));
});

server.listen(PORT, () => console.log(`mock kb.dk on http://localhost:${PORT}`));
