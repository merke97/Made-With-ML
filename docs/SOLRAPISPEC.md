# DR-arkivet Solr API — integration spec

How to pull data from the Royal Danish Library's DR-archive search backend (the
Solr index behind kb.dk's DR-arkivet). Everything here is what powers this project's
`server.py`; copy it into a new project as your data layer.

---

## 0. TL;DR

- The archive is a **Solr index** exposed through kb.dk at
  `https://www.kb.dk/ds-api/bff/v1/proxy/search/`.
- It needs an **anonymous auth cookie** (fetched once from `/authenticate/`) and returns
  **no CORS headers** → a browser can't call it directly. **You must run a tiny server-side
  proxy** that holds the cookie and forwards requests. (Same reason this project has one.)
- The proxy endpoint behaves like a **standard Solr `select` handler**: `q`, `fq`, `rows`,
  `start`, `sort`, `fl`, `facet*`, `json.facet`, `cursorMark`.
- **`q=*:*` = match everything.** ~1.93M records, 1931–2025.
- A query-cost guard ("**SolrShield**") rejects expensive requests: **`rows` is capped
  around ~2000**, and **faceting is only allowed on an allowlist of fields**. Invalid field
  names → HTTP 403/400.

---

## 1. Access model: auth + proxy

### Why a proxy is mandatory
1. The API requires an `Authorization` cookie that is `SameSite=Strict` → browsers won't
   attach it cross-site.
2. The API returns no `Access-Control-Allow-Origin` → browser fetch is blocked by CORS.

So: **browser → your server → kb.dk**. Your server fetches the cookie once, keeps it, and
proxies the Solr calls.

### Auth flow
1. `GET https://www.kb.dk/ds-api/bff/v1/authenticate/`
   → response sets the anonymous auth cookie(s). Keep them in a cookie jar / session.
2. Send that cookie on every subsequent request to `…/proxy/search/`.
3. If a call returns **HTTP 401**, the cookie expired → re-call `/authenticate/` and retry once.

Reference implementation (Python stdlib, no deps — exactly what this project does):

```python
import http.cookiejar, urllib.request, urllib.parse, json

KB = "https://www.kb.dk/ds-api/bff/v1"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def authenticate():
    opener.open(urllib.request.Request(KB + "/authenticate/"), timeout=30).read()

def kb_get(path, params):
    """path e.g. 'proxy/search/'; params is a list of (key, value) tuples."""
    qs = urllib.parse.urlencode(params, doseq=True)   # doseq → repeatable keys like fq
    url = f"{KB}/{path}?{qs}"
    for attempt in range(2):
        try:
            with opener.open(urllib.request.Request(url), timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 0:
                authenticate(); continue
            raise
    raise RuntimeError("unreachable")

authenticate()
```

Node equivalent: hit `/authenticate/`, capture `set-cookie`, replay it as `Cookie:` on each
`/proxy/search/` request. Use a single keep-alive session.

> Multiple keys with the same name (`fq` especially) must be sent as **repeated query
> params** (`fq=a&fq=b`), not comma-joined. That's why params are a list of tuples + `doseq`.

---

## 2. The search endpoint

```
GET /ds-api/bff/v1/proxy/search/?<solr params>
```

It's a Solr query handler. The important parameters:

| Param | Meaning |
|---|---|
| `q` | main query. `*:*` = everything. Otherwise full-text or fielded (see §3). |
| `fq` | filter query — narrows without affecting score. **Repeatable.** Combine with AND. |
| `rows` | page size. **Cap ~2000** (higher → 403). Use `rows=0` when you only want counts/facets. |
| `start` | offset for paging (0-based). Avoid for deep paging — use `cursorMark` (§4). |
| `sort` | e.g. `score desc`, `startTime asc`, `random_12345 asc` (§5). |
| `fl` | comma-list of fields to return. Always set it for bulk pulls (smaller/faster). |
| `facet=true` + `facet.field` / `facet.range` / `facet.pivot` | aggregations (§6). |
| `json.facet` | JSON Facet API — terms/stats (§6). |
| `cursorMark` | deep-paging cursor (§4). |

### Response envelope (standard Solr)

```jsonc
{
  "responseHeader": { "status": 0, "QTime": 12 },
  "response": {
    "numFound": 1926481,        // total matches (the real count)
    "start": 0,
    "docs": [ { …record… }, … ]
  },
  // present only when faceting:
  "facet_counts": {
    "facet_fields":  { "genre": ["Radio-rodekasse", 822010, "Nyheder…", 209114, …] },
    "facet_ranges":  { "startTime": { "counts": ["1931-01-01T00:00:00Z", 12, …], "gap":"+1YEAR" } },
    "facet_pivot":   { "temporal_start_day_da,temporal_start_hour_da": [ … ] }
  },
  // present only when using json.facet:
  "facets": { "count": 1926481, "names": { "buckets": [ {"val":"…","count":123}, … ] } },
  // present only when using cursorMark:
  "nextCursorMark": "AoIIP4AAAC…"
}
```

---

## 3. Query language (`q` / `fq`)

- **Everything:** `q=*:*`
- **Free text:** `q=månelanding` → matches across **title + description + speech
  transcription** (see caveat in §7).
- **Fielded:** `q=description:"klima"` or `q=title:"matador"` — restrict to one field.
  Quote multi-word phrases.
- **Boolean:** `q=klima AND grønland`, `q=(eu OR ef) NOT sport`.
- **Filters (`fq`)** — same syntax, repeatable, AND-combined, cached, no scoring:
  - Medium: `fq=origin:ds.radio` (or `origin:ds.tv`)
  - Channel: `fq=creator_affiliation:"DR1"`
  - Genre: `fq=genre:"Nyheder/politik og samfund"`
  - Year: `fq=temporal_start_year:1972`
  - Date range: `fq=startTime:[1969-07-20T00:00:00Z TO 1969-07-21T23:59:59Z]`
  - Boolean flag: `fq=has_kaltura_id:true`

**Build a filtered search** = `q` (text or `*:*`) + one `fq` per active filter. Example:
"matador on TV in the 90s" →
`q=matador&fq=origin:ds.tv&fq=startTime:[1990-01-01T00:00:00Z TO 1999-12-31T23:59:59Z]`.

Range syntax: `[a TO b]` inclusive, `{a TO b}` exclusive, `*` = open end
(`startTime:[2000-01-01T00:00:00Z TO *]`). Timestamps are **UTC ISO-8601 with `Z`**, no
milliseconds (`2013-03-06T14:00:00Z`).

---

## 4. Pulling data — sample, count, or the whole thing

Three strategies depending on what you actually need:

### A. Counts / distributions (cheap, preferred)
Don't pull rows — let Solr aggregate. `rows=0` + a facet (§6). One request gives you per-year
counts, channel totals, etc. This is how you get "the shape of the data" without paging 1.9M
records.

```
q=*:*&rows=0&facet=true&facet.range=startTime
   &facet.range.start=1931-01-01T00:00:00Z&facet.range.end=2026-01-01T00:00:00Z
   &facet.range.gap=%2B1YEAR
```

### B. A sample (for a viz / preview)
`sort=random_<seed> asc` + `rows<=2000`. Stable per seed; change seed to reshuffle. Add `fq`
to sample within a slice (decade, channel, query).

### C. The full census (every record)
You **cannot** use large `start` offsets (deep paging is expensive → SolrShield will reject).
Use a **cursor**:

```
1st page:  q=*:*&sort=id asc&rows=2000&cursorMark=*&fl=id,title,startTime,origin,…
next page: …&cursorMark=<nextCursorMark from previous response>
stop when: nextCursorMark == the cursorMark you sent (no progress)
```

Rules: `cursorMark` **requires a deterministic sort that includes a unique tiebreaker** —
`sort=id asc` (or `score desc, id asc`). ~1.93M ÷ 2000 ≈ **~965 requests**. Always set `fl`
to only the fields you need. Be polite (sequential or low concurrency; cache results).

> Verify cursorMark is permitted through the proxy on your first run; if it's blocked, fall
> back to **bounded windows**: slice by `fq=startTime:[…]` (e.g. month by month) so each
> window is < 2000 rows, and page within it. Time-slicing is the reliable way to walk
> everything under the row cap.

### Just the total number
`q=*:*&rows=0` → read `response.numFound`.

---

## 5. Sorting

| `sort` | Use |
|---|---|
| `score desc` | relevance (default for text search). |
| `startTime asc` / `desc` | chronological — for schedules, "first ever", timelines. |
| `random_<seed> asc` | reproducible random sample. `<seed>` = digits, e.g. `random_4271 asc`. |
| `id asc` | stable order required by `cursorMark`. |

You can chain: `sort=startTime asc, id asc`.

---

## 6. Faceting (aggregations)

### Field facets — value lists with counts (for dropdowns)
```
q=*:*&rows=0&facet=true&facet.field=genre&facet.limit=60
→ facet_counts.facet_fields.genre = ["Radio-rodekasse",822010,"Nyheder…",209114,…]
   (flat [value,count,value,count,…] — parse in pairs)
```
**Allowed facet fields only** (SolrShield allowlist — anything else → 403):
`origin, resource_description, categories, genre, genre_sub, creator_affiliation,
collection, creator_full_name, subject_full_name, location, catalog, id`.

### Range facets — time buckets (year/month/day/hour) and duration
```
facet.range=startTime
facet.range.start=2013-01-01T00:00:00Z
facet.range.end=2014-01-01T00:00:00Z
facet.range.gap=%2B1MONTH      // +1YEAR | +1MONTH | +7DAY | +1DAY | +1HOUR (URL-encode the +)
→ facet_counts.facet_ranges.startTime.counts = ["2013-01-01T00:00:00Z",1863,…]
```
Pick the gap so the bucket count stays sane (~50–400). To split a histogram by medium, run
two range queries with `fq=origin:ds.radio` and `fq=origin:ds.tv` and **merge by bucket
label** (the two responses can differ in length — don't zip by index).

### Pivot facets — cross-tabs (e.g. weekday × hour heatmap)
```
facet.pivot=temporal_start_day_da,temporal_start_hour_da&facet.limit=-1
→ nested {value, count, pivot:[…]} structure
```

### JSON Facet API — exact-term aggregation
Used here to get top programme *names* in a year:
```
json.facet={names:{type:terms,field:title_strict,limit:10}}
→ facets.names.buckets = [{val:"…", count:…}, …]
```
`title_strict` is a non-tokenised string field (good for exact grouping; comes back
lowercased).

---

## 7. The record (what `fl` can return)

Each record ≈ 83 fields. Set `fl` to the ones you use. Common returnable fields:

| Field | Notes |
|---|---|
| `id` | e.g. `ds.radio:oai:io:3cfdf0a9-…`. Build a deep link: `https://www.kb.dk/find-materiale/dr-arkivet/post/` + `encodeURIComponent(id)`. |
| `title` | **may be multivalued** (array) — take first if so. |
| `description` | human-written summary (often empty). |
| `origin` | `ds.radio` / `ds.tv` → medium. |
| `creator_affiliation` | channel (DR1, P3, …). |
| `genre`, `genre_sub`, `categories` | classification (often "…-rodekasse" = uncatalogued). |
| `resource_description` | `AudioObject` / `VideoObject`. |
| `collection` | holding institution. |
| `startTime`, `endTime` | full UTC timestamps. |
| `duration_ms` | length in ms. |
| `temporal_start_year` / `_month` / `_day_da` / `_hour_da` | pre-split time parts. |
| `has_transcription`, `has_subtitles`, `has_subtitles_for_hearing_impaired` | flags. |
| `color`, `premiere`, `live_broadcast`, `retransmission`, `surround_sound` | flags. |
| `kaltura_id` / `has_kaltura_id` | playable media handle (for the player). |
| `creator_full_name`, `subject_full_name` | people (sparse). |

**Transcription caveat:** free-text search matches the **speech transcription**, but that text
is **never returned** in `docs` and is **machine-generated** (noisy on old audio → false
matches, e.g. "podcast" in 1962). For precision, restrict `q` to `description:` / `title:`;
for coverage, use full text. Consider a UI toggle.

---

## 8. Field reference for filtering (real values)

### Categorical (filter **and** facet)
| Dimension | Field | Top values |
|---|---|---|
| Medium | `origin` | `ds.radio` (1.60M) · `ds.tv` (322k) |
| Type | `resource_description` | AudioObject · VideoObject |
| Channel | `creator_affiliation` | DR, P1, P3, P2, P4, DR1, DR2, Ramasjang, P5, Klassisk, Ultra, Jazz, P8, Beat, P6, DR K … |
| Genre | `genre` | Radio-rodekasse (822k), Nyheder/politik og samfund (209k), Kultur og oplysning (90k), Humor/quiz/underholdning (82k), Musik (74k), Børn og unge (42k), Dokumentar (28k), Livsstil (13k), TV-rodekasse (12k), Film og serier (7k), Natur og videnskab (4k) |
| Genre (sub) | `genre_sub` | Nyheder, Musik, Underholdning, Dokumentarserie, Oplysning og kultur, Aktualitet og debat, For de mindste, Religion, Dramatik og fiktion, Quiz, Mad, Hus & Have … |
| Category | `categories` | Radio, Nyheder, Børn & Ungdom, Nyheder & Aktualitet, Underholdning, Musik, Samfundsforhold (fakta), Dokumentar, Religion … |
| Collection | `collection` | Det Kgl. Bibliotek; Radio/TV-samlingen · Statsbiblioteket; Radio/TV-samlingen |

### Time & numeric (filter only — no plain facet list; use ranges)
`temporal_start_year` (1931–2025), `temporal_start_month` (1–12),
`temporal_start_day_da` (Monday…Sunday), `temporal_start_hour_da` (0–23),
`startTime`/`endTime` (timestamps), `duration_ms`.

### Boolean flags (filter on/off)
`has_transcription`, `has_subtitles`, `has_subtitles_for_hearing_impaired`, `color`
(B/W vs colour, flips ~1967), `premiere`, `live_broadcast`, `retransmission`,
`surround_sound`, `has_kaltura_id`.

All filters AND together. `creator_full_name`/`subject_full_name` are facetable but sparse;
`location`/`catalog` exist but are effectively empty.

---

## 9. Hard limits & gotchas

- **`rows` cap ≈ 2000** per request (observed: 2000 OK, 2500 → 403). Page with `cursorMark` or
  time-slices for more.
- **Facet allowlist** (§6) — faceting any other field → 403. Time/duration/flags are filterable
  but **not** facetable as value lists (use range facets).
- **Inventing a field name** → 403/400.
- **Deep `start` offsets** are rejected/expensive — use `cursorMark`.
- **Transcription** is searchable but not returned, and noisy (§7).
- **Very uneven over time:** sparse pre-1989 (1972 ≈ 285 records), ~47k/yr by 1990, **peak
  ~88k in 2013**. Any year filter/histogram should expect this — old years legitimately look tiny.
- **83% radio / 17% TV** overall; TV is comparatively sparse in recent years vs radio.
- Encode `+` in gaps as `%2B` (`facet.range.gap=%2B1YEAR`).
- 401 mid-session → re-authenticate and retry.

---

## 10. Worked examples

All are `GET …/ds-api/bff/v1/proxy/search/?<params>` with the auth cookie attached.

**Total count**
```
q=*:*&rows=0
→ response.numFound
```

**Ranked text search, page 1 (20 hits)**
```
q=månelanding&rows=20&start=0&sort=score desc
&fl=id,title,description,origin,creator_affiliation,genre,startTime,duration_ms,has_kaltura_id
```

**Filtered search (TV, 1990s, channel DR1)**
```
q=*:*&rows=40&sort=startTime asc
&fq=origin:ds.tv&fq=creator_affiliation:"DR1"
&fq=startTime:[1990-01-01T00:00:00Z TO 1999-12-31T23:59:59Z]
&fl=id,title,startTime,duration_ms,genre
```

**Per-year counts of a term (trend line)**
```
q=description:"klima"&rows=0&facet=true&facet.range=startTime
&facet.range.start=1931-01-01T00:00:00Z&facet.range.end=2026-01-01T00:00:00Z&facet.range.gap=%2B1YEAR
```

**Channel dropdown (value list + counts)**
```
q=*:*&rows=0&facet=true&facet.field=creator_affiliation&facet.limit=60
```

**One calendar day, chronological (a schedule)**
```
q=*:*&rows=2000&sort=startTime asc
&fq=startTime:[2015-03-06T00:00:00Z TO 2015-03-06T23:59:59Z]
&fl=id,title,creator_affiliation,origin,startTime,duration_ms,genre
```

**Random sample within a decade**
```
q=*:*&rows=500&sort=random_4271 asc
&fq=startTime:[2000-01-01T00:00:00Z TO 2009-12-31T23:59:59Z]&fl=id,title,startTime,origin,genre
```

**Weekday × hour heatmap**
```
q=*:*&rows=0&facet=true&facet.pivot=temporal_start_day_da,temporal_start_hour_da&facet.limit=-1
```

**Walk every record (cursor)**
```
q=*:*&sort=id asc&rows=2000&cursorMark=*&fl=id,startTime,origin
… then repeat with cursorMark=<nextCursorMark> until it stops changing.
```

---

## 11. Suggested proxy surface (what to expose to your front-end)

Mirror this project's shape — thin, cached for stable aggregates, never cache live searches:

- `GET /api/search?q=&media=&channel=&genre=&yearFrom=&yearTo=&rows=&start=` → ranked docs + `numFound`
- `GET /api/facets?field=` → value list+counts for one **allowlisted** field (cache these)
- `GET /api/histogram?from=&to=&gap=&q=&media=&channel=&genre=` → per-bucket counts (range facet)
- `GET /api/window?from=&to=&sort=time|random&n=&…filters` → a slice of real records

Cache the per-year baseline and facet lists (small, stable). Hit Solr live for searches.
