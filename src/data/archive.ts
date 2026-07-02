import { ARCHIVE_END_MS, CHANNELS, CHANNELS_BY_ID } from "./channels";
import type { AccessState, AggregateBucket, Channel, MediaType, ProgrammeInstance } from "./types";
import type { AggregateIndex, TrackLOD } from "./aggregate";

// A century of synthetic DR archive, shaped like the real one:
//   * radio from 1925, television from 1954; channels launch and close;
//   * broadcast days grow from a few evening hours to 24/7 — so the terrain
//     genuinely swells across the century;
//   * era-gated programme titles (Pressens Radioavis before Radioavisen,
//     TV Aktuelt before TV Avisen, Matador in 1978, X Factor in 2008);
//   * availability mirrors digitisation: early decades are mostly
//     metadata-only or lost, the recent archive is mostly playable;
//   * weekly and seasonal rhythm: Saturday sport, Sunday film and høj­messe,
//     July reruns, a julekalender every December.
//
// It is far too much to materialise eagerly (millions of broadcasts), so the
// engine mirrors the production tile-server split: AGGREGATES for the whole
// century are computed procedurally from per-day statistics, while individual
// programme instances are generated deterministically per (channel, day) only
// when the camera actually needs them, behind an LRU cache. Bars and terrain
// only coexist inside the zoom crossfade, so the approximation is invisible.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Deterministic PRNG (mulberry32) — spatial memory only works if the terrain
// never changes between visits.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GLOBAL_SEED = 1925;

function dayRng(channel: Channel, dayKey: number): () => number {
  return mulberry32((GLOBAL_SEED + (channel.sortOrder + 1) * 2654435761 + dayKey * 97) >>> 0);
}

// ── era profiles ────────────────────────────────────────────────────────────

interface Era {
  from: number; // UTC year, inclusive
  start: number; // broadcast day start hour
  end: number; // broadcast day end hour (may pass midnight)
  avgMin: number;
  genres: [string, number][]; // weighted
  newsPerDay: number;
  /** Probability that a day is missing from the collection (archive gaps). */
  sparse: number;
}

const PROFILES: Record<string, Era[]> = {
  DR1: [
    { from: 1954, start: 19.5, end: 22.5, avgMin: 40, newsPerDay: 1, sparse: 0.07, genres: [["nyheder", 2], ["dokumentar", 2], ["kultur", 2], ["drama", 2], ["underholdning", 2], ["film", 1]] },
    { from: 1965, start: 17, end: 24, avgMin: 45, newsPerDay: 2, sparse: 0.045, genres: [["nyheder", 2], ["dokumentar", 2], ["kultur", 1], ["drama", 2], ["underholdning", 2], ["børn", 1], ["sport", 1], ["film", 1]] },
    { from: 1980, start: 15, end: 24.5, avgMin: 45, newsPerDay: 2, sparse: 0.025, genres: [["nyheder", 2], ["dokumentar", 2], ["magasin", 2], ["drama", 2], ["underholdning", 2], ["børn", 1], ["sport", 1], ["film", 1]] },
    { from: 1996, start: 9, end: 25, avgMin: 45, newsPerDay: 2, sparse: 0.015, genres: [["nyheder", 2], ["magasin", 3], ["dokumentar", 2], ["drama", 2], ["underholdning", 2], ["sport", 1], ["film", 1]] },
    { from: 2007, start: 6, end: 25.5, avgMin: 45, newsPerDay: 3, sparse: 0.01, genres: [["nyheder", 2], ["magasin", 3], ["dokumentar", 2], ["drama", 2], ["underholdning", 2], ["sport", 1], ["film", 1]] },
  ],
  DR2: [
    { from: 1996, start: 12, end: 25, avgMin: 50, newsPerDay: 1, sparse: 0.015, genres: [["dokumentar", 3], ["kultur", 3], ["nyheder", 2], ["film", 1], ["magasin", 1]] },
    { from: 2005, start: 9, end: 25, avgMin: 50, newsPerDay: 2, sparse: 0.01, genres: [["dokumentar", 3], ["kultur", 3], ["nyheder", 2], ["film", 1], ["magasin", 2]] },
  ],
  DR3: [
    { from: 2013, start: 17, end: 26, avgMin: 40, newsPerDay: 0, sparse: 0.01, genres: [["underholdning", 3], ["dokumentar", 2], ["magasin", 2], ["musik", 1]] },
  ],
  DRK: [
    { from: 2009, start: 14, end: 24.5, avgMin: 55, newsPerDay: 0, sparse: 0.01, genres: [["kultur", 3], ["dokumentar", 3], ["film", 2], ["drama", 2]] },
  ],
  RAM: [
    { from: 2009, start: 6, end: 20, avgMin: 25, newsPerDay: 0, sparse: 0.01, genres: [["børn", 1]] },
  ],
  ULT: [
    { from: 2013, start: 6, end: 21, avgMin: 30, newsPerDay: 0, sparse: 0.01, genres: [["børn", 3], ["magasin", 1]] },
  ],
  P1: [
    { from: 1925, start: 17, end: 23, avgMin: 55, newsPerDay: 2, sparse: 0.12, genres: [["foredrag", 3], ["musik", 3], ["radioteater", 2], ["gudstjeneste", 1], ["nyheder", 1]] },
    { from: 1931, start: 12, end: 23.5, avgMin: 50, newsPerDay: 3, sparse: 0.08, genres: [["foredrag", 3], ["musik", 3], ["radioteater", 2], ["gudstjeneste", 1], ["nyheder", 2], ["magasin", 1]] },
    { from: 1940, start: 12, end: 22, avgMin: 50, newsPerDay: 4, sparse: 0.07, genres: [["foredrag", 2], ["musik", 3], ["radioteater", 2], ["gudstjeneste", 1], ["nyheder", 3]] },
    { from: 1946, start: 7, end: 24, avgMin: 45, newsPerDay: 6, sparse: 0.05, genres: [["foredrag", 2], ["musik", 2], ["radioteater", 2], ["gudstjeneste", 1], ["nyheder", 3], ["magasin", 2]] },
    { from: 1963, start: 6, end: 24, avgMin: 40, newsPerDay: 12, sparse: 0.03, genres: [["magasin", 3], ["nyheder", 3], ["dokumentar", 2], ["kultur", 2], ["radioteater", 1], ["foredrag", 1]] },
    { from: 1990, start: 5, end: 25, avgMin: 40, newsPerDay: 14, sparse: 0.015, genres: [["magasin", 3], ["nyheder", 3], ["dokumentar", 2], ["kultur", 2]] },
  ],
  P2: [
    { from: 1937, start: 16, end: 23, avgMin: 60, newsPerDay: 1, sparse: 0.08, genres: [["musik", 4], ["kultur", 2], ["radioteater", 1]] },
    { from: 1960, start: 12, end: 24, avgMin: 65, newsPerDay: 1, sparse: 0.04, genres: [["musik", 4], ["kultur", 2], ["radioteater", 1]] },
    { from: 1990, start: 6, end: 24, avgMin: 70, newsPerDay: 1, sparse: 0.02, genres: [["musik", 5], ["kultur", 2]] },
  ],
  P3: [
    { from: 1963, start: 9, end: 24, avgMin: 45, newsPerDay: 8, sparse: 0.04, genres: [["musik", 4], ["magasin", 2], ["nyheder", 1]] },
    { from: 1990, start: 5, end: 25, avgMin: 50, newsPerDay: 12, sparse: 0.02, genres: [["musik", 4], ["magasin", 3], ["nyheder", 1], ["underholdning", 1]] },
  ],
  P4: [
    { from: 1960, start: 6, end: 24, avgMin: 45, newsPerDay: 8, sparse: 0.05, genres: [["nyheder", 2], ["magasin", 3], ["musik", 3]] },
    { from: 1990, start: 5, end: 25, avgMin: 45, newsPerDay: 12, sparse: 0.02, genres: [["nyheder", 2], ["magasin", 3], ["musik", 3]] },
  ],
  P6B: [{ from: 2011, start: 0, end: 24, avgMin: 75, newsPerDay: 0, sparse: 0.01, genres: [["musik", 1]] }],
  P8J: [{ from: 2011, start: 0, end: 24, avgMin: 80, newsPerDay: 0, sparse: 0.01, genres: [["musik", 1]] }],
};

function eraFor(channel: Channel, year: number): Era {
  const eras = PROFILES[channel.id];
  let era = eras[0];
  for (const e of eras) if (year >= e.from) era = e;
  return era;
}

/** Union of genres a channel has ever broadcast (for catalogue search). */
export const CHANNEL_GENRES: Map<string, Set<string>> = new Map(
  CHANNELS.map((c) => {
    const s = new Set<string>();
    for (const e of PROFILES[c.id]) for (const [g] of e.genres) s.add(g);
    if (c.mediaType === "tv") s.add("julekalender");
    if (PROFILES[c.id].some((e) => e.newsPerDay > 0)) s.add("nyheder");
    if (c.mediaType === "tv") s.add("film"), s.add("sport");
    return [c.id, s];
  }),
);

// ── the title catalogue: a century of era-gated programmes ────────────────

export interface TitleEntry {
  t: string;
  g: string;
  from: number;
  to?: number;
  m: MediaType | "both";
}

export const CATALOGUE: TitleEntry[] = [
  // nyheder
  { t: "Pressens Radioavis", g: "nyheder", from: 1926, to: 1963, m: "radio" },
  { t: "Radioavisen", g: "nyheder", from: 1964, m: "radio" },
  { t: "TV Aktuelt", g: "nyheder", from: 1954, to: 1964, m: "tv" },
  { t: "TV Avisen", g: "nyheder", from: 1965, m: "tv" },
  { t: "Deadline", g: "nyheder", from: 2000, m: "tv" },
  { t: "21 Søndag", g: "nyheder", from: 2006, m: "tv" },
  { t: "Horisont", g: "nyheder", from: 1985, m: "tv" },
  { t: "Orientering", g: "nyheder", from: 1963, m: "radio" },
  { t: "Genstart", g: "nyheder", from: 2019, m: "radio" },
  { t: "P1 Morgen", g: "magasin", from: 1997, m: "radio" },
  // foredrag & gudstjeneste (den tidlige radio)
  { t: "Søndagsforedraget", g: "foredrag", from: 1925, to: 1965, m: "radio" },
  { t: "Skoleradioen", g: "foredrag", from: 1931, to: 1975, m: "radio" },
  { t: "Statsradiofoniens Foredragsrække", g: "foredrag", from: 1925, to: 1950, m: "radio" },
  { t: "Aftenens Kronik", g: "foredrag", from: 1940, to: 1990, m: "radio" },
  { t: "Højmessen", g: "gudstjeneste", from: 1925, m: "radio" },
  { t: "Morgenandagten", g: "gudstjeneste", from: 1931, m: "radio" },
  // radioteater
  { t: "Radioteatret", g: "radioteater", from: 1925, m: "radio" },
  { t: "Familien Hansen", g: "radioteater", from: 1929, to: 1949, m: "radio" },
  { t: "Hørespillet", g: "radioteater", from: 1926, to: 1980, m: "radio" },
  // musik
  { t: "Transmissionskoncerten", g: "musik", from: 1925, to: 1960, m: "radio" },
  { t: "Grammofonmusik", g: "musik", from: 1925, to: 1958, m: "radio" },
  { t: "Giro 413", g: "musik", from: 1946, m: "radio" },
  { t: "De Ringer - Vi Spiller", g: "musik", from: 1973, m: "radio" },
  { t: "Det Elektriske Barometer", g: "musik", from: 1988, m: "radio" },
  { t: "P3 Playliste", g: "musik", from: 2004, m: "radio" },
  { t: "Natradio", g: "musik", from: 1963, m: "radio" },
  { t: "Morgenmusik", g: "musik", from: 1937, m: "radio" },
  { t: "Eldorado", g: "musik", from: 1980, to: 1996, m: "radio" },
  { t: "Jazzklubben", g: "musik", from: 2011, m: "radio" },
  { t: "Aftenkoncerten", g: "musik", from: 1930, m: "radio" },
  { t: "Før Bjørnen Sover", g: "musik", from: 2011, m: "radio" },
  // drama (tv)
  { t: "Fjernsynsteatret", g: "drama", from: 1954, to: 1994, m: "tv" },
  { t: "Ka' De Li' Østers?", g: "drama", from: 1967, to: 1968, m: "tv" },
  { t: "Huset på Christianshavn", g: "drama", from: 1970, to: 1977, m: "tv" },
  { t: "En By i Provinsen", g: "drama", from: 1977, to: 1980, m: "tv" },
  { t: "Fiskerne", g: "drama", from: 1977, to: 1978, m: "tv" },
  { t: "Matador", g: "drama", from: 1978, to: 1985, m: "tv" },
  { t: "Riget", g: "drama", from: 1994, to: 2022, m: "tv" },
  { t: "Bryggeren", g: "drama", from: 1996, to: 1997, m: "tv" },
  { t: "Taxa", g: "drama", from: 1997, to: 1999, m: "tv" },
  { t: "Rejseholdet", g: "drama", from: 2000, to: 2004, m: "tv" },
  { t: "Nikolaj og Julie", g: "drama", from: 2002, to: 2003, m: "tv" },
  { t: "Krøniken", g: "drama", from: 2004, to: 2007, m: "tv" },
  { t: "Forbrydelsen", g: "drama", from: 2007, to: 2012, m: "tv" },
  { t: "Borgen", g: "drama", from: 2010, to: 2022, m: "tv" },
  { t: "Arvingerne", g: "drama", from: 2014, to: 2017, m: "tv" },
  { t: "Bedrag", g: "drama", from: 2016, to: 2019, m: "tv" },
  { t: "Herrens Veje", g: "drama", from: 2017, to: 2019, m: "tv" },
  { t: "Sygeplejeskolen", g: "drama", from: 2018, to: 2022, m: "tv" },
  { t: "Ulven Kommer", g: "drama", from: 2020, m: "tv" },
  // dokumentar
  { t: "Landet Rundt", g: "dokumentar", from: 1960, to: 1990, m: "tv" },
  { t: "Fjernsyn for Dyr", g: "dokumentar", from: 1962, to: 1978, m: "tv" },
  { t: "Naturens Verden", g: "dokumentar", from: 1975, m: "both" },
  { t: "Søndagsdokumentaren", g: "dokumentar", from: 1980, m: "tv" },
  { t: "Bag Facaden", g: "dokumentar", from: 2000, m: "tv" },
  { t: "Eksperimentet", g: "dokumentar", from: 2005, m: "tv" },
  { t: "Den Hemmelige Tjeneste", g: "dokumentar", from: 2010, m: "tv" },
  { t: "Historien om Danmark", g: "dokumentar", from: 2017, to: 2018, m: "tv" },
  { t: "P1 Dokumentar", g: "dokumentar", from: 1995, m: "radio" },
  // børn
  { t: "Børnetimen", g: "børn", from: 1925, to: 1968, m: "radio" },
  { t: "Ingrid og Lillebror", g: "børn", from: 1961, to: 1970, m: "tv" },
  { t: "Legestue", g: "børn", from: 1968, to: 1990, m: "tv" },
  { t: "Sonja fra Saxogade", g: "børn", from: 1968, to: 1972, m: "tv" },
  { t: "Kaj og Andrea", g: "børn", from: 1971, m: "tv" },
  { t: "Bamses Billedbog", g: "børn", from: 1983, m: "tv" },
  { t: "Store Nørd", g: "børn", from: 2007, m: "tv" },
  { t: "Ramasjang Live", g: "børn", from: 2009, m: "tv" },
  { t: "Motor Mille", g: "børn", from: 2009, m: "tv" },
  { t: "Rosa fra Rouladegade", g: "børn", from: 2010, m: "tv" },
  { t: "Onkel Reje", g: "børn", from: 2011, m: "tv" },
  // film
  { t: "Søndagsfilmen", g: "film", from: 1958, m: "tv" },
  { t: "Aftenens Spillefilm", g: "film", from: 1965, m: "tv" },
  { t: "Fredagsfilm", g: "film", from: 1970, m: "tv" },
  { t: "Klassikeren", g: "film", from: 1990, m: "tv" },
  // kultur
  { t: "Teaterforestillingen", g: "kultur", from: 1960, m: "tv" },
  { t: "Kunst & Kultur", g: "kultur", from: 1960, to: 1990, m: "radio" },
  { t: "Kulturkvarteret", g: "kultur", from: 1990, m: "radio" },
  { t: "Smagsdommerne", g: "kultur", from: 2004, m: "tv" },
  { t: "Kunstquizzen", g: "kultur", from: 2015, m: "tv" },
  // magasin
  { t: "Husmoderens Time", g: "magasin", from: 1928, to: 1960, m: "radio" },
  { t: "Familiespejlet", g: "magasin", from: 1950, to: 1970, m: "radio" },
  { t: "TV-Køkkenet", g: "magasin", from: 1965, to: 1990, m: "tv" },
  { t: "Go' Morgen P3", g: "magasin", from: 1994, m: "radio" },
  { t: "Mads & Monopolet", g: "magasin", from: 2002, m: "radio" },
  { t: "Aftenshowet", g: "magasin", from: 2007, m: "tv" },
  { t: "Hammerslag", g: "magasin", from: 2007, m: "tv" },
  { t: "Bonderøven", g: "magasin", from: 2008, to: 2019, m: "tv" },
  { t: "Brinkmanns Briks", g: "magasin", from: 2015, to: 2019, m: "radio" },
  // sport
  { t: "Landskampen", g: "sport", from: 1958, m: "tv" },
  { t: "Sportslørdag", g: "sport", from: 1965, m: "tv" },
  { t: "Sportsredaktionen", g: "sport", from: 1946, m: "radio" },
  { t: "Håndbold Direkte", g: "sport", from: 1990, m: "tv" },
  { t: "Tour-Magasinet", g: "sport", from: 1995, m: "tv" },
  // underholdning
  { t: "Kvit eller Dobbelt", g: "underholdning", from: 1957, to: 1965, m: "tv" },
  { t: "Melodi Grand Prix", g: "underholdning", from: 1957, m: "tv" },
  { t: "Lørdagsunderholdningen", g: "underholdning", from: 1958, to: 1980, m: "tv" },
  { t: "Gæt og Grimasser", g: "underholdning", from: 1959, to: 1975, m: "tv" },
  { t: "Husk Lige Tandbørsten", g: "underholdning", from: 1994, to: 1996, m: "tv" },
  { t: "X Factor", g: "underholdning", from: 2008, to: 2018, m: "tv" },
  { t: "Den Store Bagedyst", g: "underholdning", from: 2012, m: "tv" },
  { t: "Versus", g: "underholdning", from: 2013, to: 2019, m: "tv" },
  // julekalendere (én pr. år, december på DR1)
  { t: "Børnenes Julekalender", g: "julekalender", from: 1962, to: 1972, m: "tv" },
  { t: "Vinterbyøster", g: "julekalender", from: 1973, to: 1978, m: "tv" },
  { t: "Jul i Gammelby", g: "julekalender", from: 1979, to: 1983, m: "tv" },
  { t: "Nissebanden", g: "julekalender", from: 1984, to: 1988, m: "tv" },
  { t: "Nissebanden i Grønland", g: "julekalender", from: 1989, to: 1995, m: "tv" },
  { t: "Bamses Julerejse", g: "julekalender", from: 1996, to: 2005, m: "tv" },
  { t: "Absalons Hemmelighed", g: "julekalender", from: 2006, to: 2008, m: "tv" },
  { t: "Pagten", g: "julekalender", from: 2009, to: 2011, m: "tv" },
  { t: "Julestjerner", g: "julekalender", from: 2012, to: 2013, m: "tv" },
  { t: "Tidsrejsen", g: "julekalender", from: 2014, to: 2018, m: "tv" },
  { t: "Den Anden Verden", g: "julekalender", from: 2019, to: 2020, m: "tv" },
  { t: "Kometernes Jul", g: "julekalender", from: 2021, m: "tv" },
];

// Era-neutral fallbacks so no era ever runs dry of titles.
const FALLBACKS: Record<string, string[]> = {
  nyheder: ["Nyhedsoversigten"],
  drama: ["Aftenens Skuespil"],
  dokumentar: ["Dokumentartimen"],
  film: ["Aftenens Film"],
  børn: ["Børnenes Time"],
  kultur: ["Kulturmagasinet"],
  musik: ["Musik i Æteren"],
  magasin: ["Dagens Magasin"],
  sport: ["Sportsudsendelsen"],
  underholdning: ["Aftenens Underholdning"],
  radioteater: ["Radioteatret"],
  foredrag: ["Foredrag uden Titel · Arkivbånd"],
  gudstjeneste: ["Gudstjenesten"],
  julekalender: ["Julekalenderen"],
};

const poolCache = new Map<string, string[]>();
function titlePool(genre: string, media: MediaType, year: number): string[] {
  const key = `${genre}:${media}:${year}`;
  let pool = poolCache.get(key);
  if (!pool) {
    pool = CATALOGUE.filter(
      (e) => e.g === genre && (e.m === "both" || e.m === media) && year >= e.from && year <= (e.to ?? 9999),
    ).map((e) => e.t);
    if (!pool.length) pool = FALLBACKS[genre] ?? ["Udsendelse uden Titel"];
    poolCache.set(key, pool);
  }
  return pool;
}

// ── availability: digitisation history ─────────────────────────────────────

function availabilityShare(year: number): number {
  if (year < 1935) return 0.02;
  if (year < 1950) return 0.05;
  if (year < 1965) return 0.12;
  if (year < 1980) return 0.28;
  if (year < 1995) return 0.45;
  if (year < 2007) return 0.62;
  return 0.8;
}

function accessFor(year: number, genre: string, rng: () => number): AccessState {
  if (genre === "sport") return rng() < 0.65 ? "restricted" : "metadata_only";
  const avail = availabilityShare(year);
  const unknown = year < 1950 ? 0.3 : year < 1980 ? 0.12 : 0.03;
  const r = rng();
  if (r < avail) return "available";
  if (r < avail + unknown) return "unknown";
  // The remainder splits between catalogued-but-unplayable and rights-limited.
  return r < avail + unknown + (1 - avail - unknown) * 0.75 ? "metadata_only" : "restricted";
}

// ── per-day generation (deterministic, lazy) ────────────────────────────────

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function weightedPick(rng: () => number, weighted: [string, number][]): string {
  let total = 0;
  for (const [, w] of weighted) total += w;
  let r = rng() * total;
  for (const [g, w] of weighted) {
    r -= w;
    if (r <= 0) return g;
  }
  return weighted[0][0];
}

function julekalenderFor(year: number): string {
  const valid = CATALOGUE.filter((e) => e.g === "julekalender" && year >= e.from && year <= (e.to ?? 9999));
  if (!valid.length) return "Julekalenderen";
  return valid[year % valid.length].t;
}

interface DayStats {
  broadcastMs: number;
  programmeCount: number;
  availableCount: number;
  restrictedCount: number;
  newsCount: number;
}

const NO_DAY: DayStats = { broadcastMs: 0, programmeCount: 0, availableCount: 0, restrictedCount: 0, newsCount: 0 };

function channelActive(channel: Channel, dayStart: number): boolean {
  return dayStart >= channel.activeFromMs && dayStart < (channel.activeToMs ?? ARCHIVE_END_MS);
}

/** Cheap per-day statistics for the terrain — same rng prefix as generateDay. */
function dayStats(channel: Channel, dayStart: number): DayStats {
  if (!channelActive(channel, dayStart)) return NO_DAY;
  const year = new Date(dayStart).getUTCFullYear();
  const era = eraFor(channel, year);
  const rng = dayRng(channel, dayStart / DAY);
  if (rng() < era.sparse) return NO_DAY; // archive gap — the day is lost
  const hours = era.end - era.start;
  const broadcastMs = hours * HOUR * (0.82 + 0.3 * rng());
  const programmeCount = Math.max(1, Math.round((hours * 60) / era.avgMin));
  const availableCount = Math.round(programmeCount * availabilityShare(year));
  return {
    broadcastMs,
    programmeCount,
    availableCount,
    restrictedCount: Math.round(programmeCount * 0.1),
    newsCount: era.newsPerDay,
  };
}

/** Materialise one channel-day. Deterministic: same day, same broadcasts. */
function generateDay(channel: Channel, dayStart: number): ProgrammeInstance[] {
  if (!channelActive(channel, dayStart)) return [];
  const d = new Date(dayStart);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const date = d.getUTCDate();
  const weekday = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const era = eraFor(channel, year);
  const dayKey = dayStart / DAY;
  const rng = dayRng(channel, dayKey);
  if (rng() < era.sparse) return [];
  rng(); // density draw, shared with dayStats

  const media = channel.mediaType;
  const isJuleseason = month === 11 && date <= 24;
  const isJuly = month === 6;
  const out: ProgrammeInstance[] = [];
  let n = 0;

  const push = (title: string, genre: string, startMs: number, durMin: number, access?: AccessState) => {
    const endMs = startMs + durMin * MIN;
    out.push({
      id: `${channel.id}:${dayKey}:${n++}`,
      title,
      channelId: channel.id,
      startMs,
      endMs,
      mediaType: media,
      genre,
      access: access ?? accessFor(year, genre, rng),
      clusterId: `${channel.id}:${title}`,
      search: title.toLowerCase(),
    });
    return endMs;
  };

  const newsTitle =
    media === "tv" ? (year >= 1965 ? "TV Avisen" : "TV Aktuelt") : year >= 1964 ? "Radioavisen" : "Pressens Radioavis";
  const newsAccess: AccessState | undefined = year >= 2007 ? "available" : undefined;

  // Radio news: short bulletins at the top of the hour, era-scaled.
  const radioNewsEvery = era.newsPerDay >= 8 ? 1 : era.newsPerDay >= 4 ? 3 : 6;

  let cursor = dayStart + era.start * HOUR + (weekday === 0 && year < 1990 ? 0.5 * HOUR : 0);
  const dayEnd = dayStart + era.end * HOUR;

  // Fixed slots fire at most once (news bulletins: once per hour) — without
  // these guards a short bulletin can end inside its own trigger window.
  let lastNewsHour = -1;
  let eveningNewsDone = false;
  let lateNewsDone = false;
  let julDone = false;
  let messeDone = false;
  let filmDone = false;
  let sportDone = false;

  while (cursor < dayEnd) {
    const hour = (cursor - dayStart) / HOUR;

    // News slots.
    if (media === "radio" && era.newsPerDay > 0 && year >= 1926) {
      const rh = Math.round(hour);
      if (Math.abs(hour - rh) < 0.12 && rh % radioNewsEvery === 0 && rh !== lastNewsHour) {
        lastNewsHour = rh;
        cursor = push(newsTitle, "nyheder", Math.max(cursor, dayStart + rh * HOUR), year < 1964 ? 10 : 6, newsAccess);
        continue;
      }
    }
    if (media === "tv" && era.newsPerDay > 0 && !eveningNewsDone && Math.abs(hour - 18.5) < 0.4) {
      eveningNewsDone = true;
      cursor = push(newsTitle, "nyheder", cursor, 25, newsAccess);
      continue;
    }
    if (media === "tv" && era.newsPerDay >= 2 && !lateNewsDone && Math.abs(hour - 21) < 0.4) {
      lateNewsDone = true;
      cursor = push(newsTitle, "nyheder", cursor, 25, newsAccess);
      continue;
    }
    // The julekalender: one episode every December evening on DR1.
    if (isJuleseason && !julDone && channel.id === "DR1" && year >= 1962 && Math.abs(hour - 20) < 0.5) {
      julDone = true;
      cursor = push(julekalenderFor(year), "julekalender", cursor, 25);
      continue;
    }
    // Sunday: højmesse on P1, film in the tv evening.
    if (media === "radio" && channel.id === "P1" && weekday === 0 && !messeDone && Math.abs(hour - 10) < 0.5) {
      messeDone = true;
      cursor = push("Højmessen", "gudstjeneste", cursor, 75);
      continue;
    }
    if (media === "tv" && weekday === 0 && year >= 1958 && !filmDone && Math.abs(hour - 20.5) < 0.6) {
      filmDone = true;
      if (rng() < 0.6) {
        cursor = push(pick(rng, titlePool("film", media, year)), "film", cursor, 90 + Math.round(rng() * 8) * 5);
        continue;
      }
    }
    // Saturday afternoon sport block on DR1.
    if (channel.id === "DR1" && weekday === 6 && year >= 1965 && !sportDone && hour >= 14 && hour < 15) {
      sportDone = true;
      if (rng() < 0.8) {
        cursor = push("Sportslørdag", "sport", cursor, 120 + Math.round(rng() * 12) * 10);
        continue;
      }
    }

    let genre = weightedPick(rng, era.genres);
    // Daypart sanity: films and drama belong to the evening, children to the day.
    if ((genre === "film" || genre === "drama" || genre === "radioteater") && hour < 17) genre = media === "tv" ? "magasin" : "musik";
    if (genre === "børn" && (hour < 7 || hour > 19) && channel.id !== "RAM" && channel.id !== "ULT") genre = "magasin";

    let pool = titlePool(genre, media, year);
    // July is rerun season: the pool narrows, the same titles come back.
    if (isJuly && pool.length > 3) pool = pool.slice(0, Math.ceil(pool.length / 3));

    const durMin = Math.max(10, Math.round((era.avgMin * (0.5 + rng() * 1.1)) / 5) * 5);
    cursor = push(pick(rng, pool), genre, cursor, durMin);
  }

  return out;
}

// ── aggregates for the whole century (procedural, no materialisation) ──────

function rollup(channel: Channel): TrackLOD {
  const dayBuckets: AggregateBucket[] = [];
  const monthMap = new Map<number, AggregateBucket>();
  const yearMap = new Map<number, AggregateBucket>();

  const firstDay = Math.floor(channel.activeFromMs / DAY) * DAY;
  const lastDay = Math.min(channel.activeToMs ?? ARCHIVE_END_MS, ARCHIVE_END_MS);

  const bucket = (map: Map<number, AggregateBucket>, startMs: number, endMs: number): AggregateBucket => {
    let b = map.get(startMs);
    if (!b) {
      b = { startMs, endMs, broadcastMs: 0, programmeCount: 0, availableCount: 0, restrictedCount: 0, newsCount: 0 };
      map.set(startMs, b);
    }
    return b;
  };

  for (let day = firstDay; day < lastDay; day += DAY) {
    const s = dayStats(channel, day);
    if (s.broadcastMs <= 0) continue;
    const d = new Date(day);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    dayBuckets.push({ startMs: day, endMs: day + DAY, ...s });
    const mb = bucket(monthMap, Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1));
    const yb = bucket(yearMap, Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1));
    for (const b of [mb, yb]) {
      b.broadcastMs += s.broadcastMs;
      b.programmeCount += s.programmeCount;
      b.availableCount += s.availableCount;
      b.restrictedCount += s.restrictedCount;
      b.newsCount += s.newsCount;
    }
  }

  const months = [...monthMap.values()].sort((a, b) => a.startMs - b.startMs);
  const years = [...yearMap.values()].sort((a, b) => a.startMs - b.startMs);
  const maxOf = (arr: AggregateBucket[]) => arr.reduce((m, b) => Math.max(m, b.broadcastMs), 1);

  return {
    year: { trackId: channel.id, level: "year", buckets: years },
    month: { trackId: channel.id, level: "month", buckets: months },
    day: { trackId: channel.id, level: "day", buckets: dayBuckets },
    max: { year: maxOf(years), month: maxOf(months), day: maxOf(dayBuckets) },
  };
}

// ── the archive: aggregates + lazy day provider ────────────────────────────

const DAY_CACHE_MAX = 4096;

export class Archive {
  aggregates: AggregateIndex = new Map();
  private dayCache = new Map<string, ProgrammeInstance[]>();

  constructor() {
    for (const c of CHANNELS) this.aggregates.set(c.id, rollup(c));
  }

  /** Programmes for one channel-day, generated on demand and LRU-cached. */
  day(channelId: string, dayStart: number): ProgrammeInstance[] {
    const key = `${channelId}:${dayStart}`;
    const hit = this.dayCache.get(key);
    if (hit) {
      this.dayCache.delete(key);
      this.dayCache.set(key, hit); // refresh recency
      return hit;
    }
    const channel = CHANNELS_BY_ID.get(channelId);
    const progs = channel ? generateDay(channel, dayStart) : [];
    this.dayCache.set(key, progs);
    if (this.dayCache.size > DAY_CACHE_MAX) {
      const oldest = this.dayCache.keys().next().value as string;
      this.dayCache.delete(oldest);
    }
    return progs;
  }

  /** All programmes overlapping [startMs, endMs), sorted by start. */
  range(channelId: string, startMs: number, endMs: number): ProgrammeInstance[] {
    const out: ProgrammeInstance[] = [];
    const first = Math.floor(startMs / DAY) * DAY - DAY; // catch past-midnight spillover
    for (let day = first; day < endMs; day += DAY) {
      const progs = this.day(channelId, day);
      for (const p of progs) if (p.endMs > startMs && p.startMs < endMs) out.push(p);
    }
    return out;
  }

  /** The programme on air on a channel at an instant (hit-testing). */
  at(channelId: string, timeMs: number): ProgrammeInstance | null {
    const day = Math.floor(timeMs / DAY) * DAY;
    for (const dd of [day, day - DAY]) {
      for (const p of this.day(channelId, dd)) {
        if (timeMs >= p.startMs && timeMs <= p.endMs) return p;
      }
    }
    return null;
  }
}

export { DAY };
