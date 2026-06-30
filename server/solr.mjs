// Pure Solr query builders + response mappers for the DR-arkivet API.
// No I/O here — everything is a pure function so it can be unit-tested offline.
// See SOLRAPISPEC.md for the upstream contract.

export const ROWS_CAP = 2000; // SolrShield rejects larger pages.

const GAP_MS = {
  year: 365 * 86400_000,
  month: 30 * 86400_000,
  day: 86400_000,
  hour: 3600_000,
};
const GAP_SOLR = {
  year: "+1YEAR",
  month: "+1MONTH",
  day: "+1DAY",
  hour: "+1HOUR",
};

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const first = (v) => (Array.isArray(v) ? v[0] : v);

/** Build a Solr time-range fq, with open ends supported. */
export function timeRangeFq(fromMs, toMs) {
  const a = fromMs == null ? "*" : iso(fromMs);
  const b = toMs == null ? "*" : iso(toMs);
  return `startTime:[${a} TO ${b}]`;
}

/** Common filter tuples shared by window/histogram/search. */
function filterTuples({ media, channel, genre } = {}) {
  const t = [];
  if (media === "tv") t.push(["fq", "origin:ds.tv"]);
  else if (media === "radio") t.push(["fq", "origin:ds.radio"]);
  if (channel) t.push(["fq", `creator_affiliation:"${channel}"`]);
  if (genre) t.push(["fq", `genre:"${genre}"`]);
  return t;
}

// ── parameter builders (return arrays of [key,value] tuples) ───────────────

/** One request that yields per-medium channel counts via a pivot facet. */
export function channelsParams() {
  return [
    ["q", "*:*"],
    ["rows", "0"],
    ["facet", "true"],
    ["facet.pivot", "origin,creator_affiliation"],
    ["facet.limit", "-1"],
  ];
}

export function totalParams({ q = "*:*", media, channel, genre, fromMs, toMs } = {}) {
  const t = [
    ["q", q],
    ["rows", "0"],
    ...filterTuples({ media, channel, genre }),
  ];
  if (fromMs != null || toMs != null) t.push(["fq", timeRangeFq(fromMs, toMs)]);
  return t;
}

export function histogramParams({ q = "*:*", gap = "month", fromMs, toMs, media, channel, genre }) {
  const solrGap = GAP_SOLR[gap] ?? GAP_SOLR.month;
  return [
    ["q", q],
    ["rows", "0"],
    ["facet", "true"],
    ["facet.range", "startTime"],
    ["facet.range.start", iso(fromMs)],
    ["facet.range.end", iso(toMs)],
    ["facet.range.gap", solrGap],
    ...filterTuples({ media, channel, genre }),
  ];
}

export function windowParams({ fromMs, toMs, media, channel, genre, sort = "time", n = ROWS_CAP }) {
  const rows = Math.max(1, Math.min(ROWS_CAP, n | 0));
  const sortExpr = sort === "random" ? "random_4271 asc" : "startTime asc, id asc";
  return [
    ["q", "*:*"],
    ["rows", String(rows)],
    ["sort", sortExpr],
    ["fq", timeRangeFq(fromMs, toMs)],
    ...filterTuples({ media, channel, genre }),
    ["fl", "id,title,creator_affiliation,origin,startTime,endTime,duration_ms,genre,has_kaltura_id"],
  ];
}

export function searchParams({ q, media, channel, fromMs, toMs, rows = 200, start = 0 }) {
  const r = Math.max(1, Math.min(ROWS_CAP, rows | 0));
  const t = [
    ["q", q],
    ["rows", String(r)],
    ["start", String(start | 0)],
    ["sort", "score desc, id asc"],
    ...filterTuples({ media, channel }),
    ["fl", "id,title,creator_affiliation,origin,startTime,endTime,duration_ms,genre,has_kaltura_id"],
  ];
  if (fromMs != null || toMs != null) t.push(["fq", timeRangeFq(fromMs, toMs)]);
  return t;
}

// ── response mappers ───────────────────────────────────────────────────────

const MEDIUM = (origin) => (origin === "ds.tv" ? "tv" : "radio");

/** Pivot facet → ordered channel list classified by dominant medium. */
export function parseChannels(json, { minCount = 50 } = {}) {
  const pivot = json?.facet_counts?.facet_pivot?.["origin,creator_affiliation"] ?? [];
  const totals = new Map(); // affiliation -> { tv, radio }
  for (const originBucket of pivot) {
    const medium = MEDIUM(originBucket.value);
    for (const ch of originBucket.pivot ?? []) {
      const name = first(ch.value);
      if (!name) continue;
      const rec = totals.get(name) ?? { tv: 0, radio: 0 };
      rec[medium] += ch.count;
      totals.set(name, rec);
    }
  }
  const channels = [];
  for (const [name, rec] of totals) {
    const total = rec.tv + rec.radio;
    if (total < minCount) continue;
    channels.push({ id: name, label: name, mediaType: rec.tv >= rec.radio ? "tv" : "radio", count: total });
  }
  // Stable geography: TV first, then radio; each by volume desc.
  channels.sort((a, b) => (a.mediaType !== b.mediaType ? (a.mediaType === "tv" ? -1 : 1) : b.count - a.count));
  channels.forEach((c, i) => (c.sortOrder = i));
  return channels;
}

/** Range facet → [{ startMs, endMs, count }] buckets. */
export function parseHistogram(json, gap = "month") {
  const counts = json?.facet_counts?.facet_ranges?.startTime?.counts ?? [];
  const gapMs = GAP_MS[gap] ?? GAP_MS.month;
  const buckets = [];
  for (let i = 0; i < counts.length; i += 2) {
    const startMs = Date.parse(counts[i]);
    const count = counts[i + 1] || 0;
    const nextLabel = counts[i + 2];
    const endMs = nextLabel ? Date.parse(nextLabel) : startMs + gapMs;
    buckets.push({ startMs, endMs, count });
  }
  return buckets;
}

const KB_POST = "https://www.kb.dk/find-materiale/dr-arkivet/post/";

/** A single Solr doc → the front-end's programme shape. */
export function mapDoc(doc) {
  const startMs = Date.parse(first(doc.startTime));
  const endRaw = first(doc.endTime);
  const durMs = Number(first(doc.duration_ms)) || 0;
  const endMs = endRaw ? Date.parse(endRaw) : startMs + durMs;
  const title = (first(doc.title) || "(uden titel)").toString();
  const channelId = first(doc.creator_affiliation) || "Ukendt";
  const playable = first(doc.has_kaltura_id) === true || first(doc.has_kaltura_id) === "true";
  return {
    id: first(doc.id),
    title,
    channelId,
    startMs,
    endMs: endMs > startMs ? endMs : startMs + 60_000,
    mediaType: MEDIUM(first(doc.origin)),
    genre: (first(doc.genre) || "ukendt").toString(),
    access: playable ? "available" : "metadata_only",
    clusterId: `${channelId}:${title}`,
    search: title.toLowerCase(),
    link: KB_POST + encodeURIComponent(first(doc.id) ?? ""),
  };
}

export function mapDocs(json) {
  return (json?.response?.docs ?? []).map(mapDoc).filter((p) => Number.isFinite(p.startMs));
}

export const numFound = (json) => json?.response?.numFound ?? 0;
