// Framework-agnostic API surface (spec §11). Each handler returns plain JSON.
// Used both by the standalone server (server/index.mjs) and the Vite dev
// middleware, so the front-end talks to /api/* with no CORS in either mode.

import { search } from "./kb.mjs";
import {
  channelsParams,
  histogramParams,
  mapDocs,
  numFound,
  parseChannels,
  parseHistogram,
  searchParams,
  totalParams,
  windowParams,
} from "./solr.mjs";

// Tiny TTL cache for stable aggregates (channels, histograms). Live searches
// and windows are never cached.
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.p;
  const p = Promise.resolve(fn()).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { t: now, p });
  return p;
}

const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const ms = (v) => (v == null || v === "" ? undefined : Date.parse(v));

/**
 * Route an /api request. `path` is the part after /api (e.g. "/channels");
 * `q` is a URLSearchParams. Returns { status, body }.
 */
export async function handleApi(path, q) {
  try {
    switch (path) {
      case "/channels": {
        const body = await cached("channels", 6 * 3600_000, async () =>
          parseChannels(await search(channelsParams())),
        );
        return { status: 200, body };
      }

      case "/total": {
        const json = await search(
          totalParams({ q: q.get("q") || "*:*", media: q.get("media"), channel: q.get("channel"), genre: q.get("genre") }),
        );
        return { status: 200, body: { total: numFound(json) } };
      }

      case "/histogram": {
        const gap = q.get("gap") || "month";
        const opts = {
          q: q.get("q") || "*:*",
          gap,
          fromMs: ms(q.get("from")),
          toMs: ms(q.get("to")),
          media: q.get("media"),
          channel: q.get("channel"),
          genre: q.get("genre"),
        };
        if (opts.fromMs == null || opts.toMs == null) return { status: 400, body: { error: "from/to required" } };
        const key = "hist:" + JSON.stringify(opts);
        const body = await cached(key, 3600_000, async () => parseHistogram(await search(histogramParams(opts)), gap));
        return { status: 200, body: { gap, buckets: body } };
      }

      case "/window": {
        const opts = {
          fromMs: ms(q.get("from")),
          toMs: ms(q.get("to")),
          media: q.get("media"),
          channel: q.get("channel"),
          genre: q.get("genre"),
          sort: q.get("sort") || "time",
          n: num(q.get("n"), 2000),
        };
        if (opts.fromMs == null || opts.toMs == null) return { status: 400, body: { error: "from/to required" } };
        const json = await search(windowParams(opts));
        return { status: 200, body: { programmes: mapDocs(json), numFound: numFound(json) } };
      }

      case "/search": {
        const query = (q.get("q") || "").trim();
        if (query.length < 2) return { status: 200, body: { programmes: [], numFound: 0 } };
        const json = await search(
          searchParams({
            q: query,
            media: q.get("media"),
            channel: q.get("channel"),
            fromMs: ms(q.get("from")),
            toMs: ms(q.get("to")),
            rows: num(q.get("rows"), 500),
          }),
        );
        return { status: 200, body: { programmes: mapDocs(json), numFound: numFound(json) } };
      }

      default:
        return { status: 404, body: { error: "unknown endpoint" } };
    }
  } catch (e) {
    return { status: 502, body: { error: String(e?.message || e) } };
  }
}
