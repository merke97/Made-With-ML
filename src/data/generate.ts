import { ARCHIVE_END_MS, ARCHIVE_START_MS, CHANNELS } from "./channels";
import type { AccessState, Channel, ProgrammeInstance } from "./types";

// Deterministic PRNG (mulberry32) so the synthetic archive is stable across
// reloads — spatial memory only works if the terrain doesn't change.
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

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Title pools per genre. The news titles are deliberately exact so the
// TV Avisen / Radioavisen overlay and search have something to match.
const TV_NEWS = "TV Avisen";
const RADIO_NEWS = "Radioavisen";

const POOLS: Record<string, string[]> = {
  nyheder: [TV_NEWS, RADIO_NEWS, "Deadline", "21 Søndag", "Horisont"],
  drama: ["Forbrydelsen", "Bedrag", "Arvingerne", "Sygeplejeskolen", "Borgen"],
  dokumentar: ["Historien om Danmark", "Den hemmelige tjeneste", "Naturens Verden", "Eksperimentet"],
  film: ["Søndagsfilm", "Aftenens film", "Klassikeren"],
  børn: ["Ramasjang Live", "Motor Mille", "Onkel Reje", "Sofie og Sel! "],
  kultur: ["Smagsdommerne", "Bag om", "Kulturkvarteret", "Kunstquizzen"],
  musik: ["P3 Playliste", "Det elektriske barometer", "Morgenmusik", "Natradio", "Genstart"],
  magasin: ["Aftenshowet", "Go' morgen Danmark", "Magasinet", "Orientering"],
  sport: ["Sportslørdag", "Super Mandag", "Tour-magasinet", "Håndbold direkte"],
};

// Which genres each channel tends to broadcast, and rough day windows.
const CHANNEL_PROFILE: Record<
  string,
  { genres: string[]; startHour: number; endHour: number; avgMin: number }
> = {
  DR1: { genres: ["nyheder", "drama", "magasin", "dokumentar", "film", "sport"], startHour: 6, endHour: 25, avgMin: 45 },
  DR2: { genres: ["dokumentar", "kultur", "nyheder", "film"], startHour: 7, endHour: 25, avgMin: 50 },
  DRK: { genres: ["kultur", "dokumentar", "film", "drama"], startHour: 9, endHour: 24, avgMin: 55 },
  RAM: { genres: ["børn"], startHour: 6, endHour: 20, avgMin: 25 },
  ULT: { genres: ["børn", "magasin"], startHour: 6, endHour: 21, avgMin: 30 },
  P1: { genres: ["nyheder", "magasin", "kultur"], startHour: 5, endHour: 24, avgMin: 40 },
  P2: { genres: ["musik", "kultur"], startHour: 6, endHour: 24, avgMin: 60 },
  P3: { genres: ["musik", "magasin", "nyheder"], startHour: 5, endHour: 25, avgMin: 50 },
  P4: { genres: ["nyheder", "magasin", "musik"], startHour: 5, endHour: 24, avgMin: 45 },
  P6: { genres: ["musik"], startHour: 0, endHour: 24, avgMin: 75 },
};

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function accessFor(rng: () => number, genre: string): AccessState {
  // Sports are frequently rights-restricted; everything has some holdback.
  if (genre === "sport") return rng() < 0.7 ? "restricted" : "metadata_only";
  const r = rng();
  if (r < 0.72) return "available";
  if (r < 0.85) return "metadata_only";
  if (r < 0.95) return "restricted";
  return "unknown";
}

export interface ArchiveData {
  programmes: ProgrammeInstance[];
  /** Per-channel programmes sorted by startMs, for fast viewport queries. */
  byChannel: Map<string, ProgrammeInstance[]>;
}

/**
 * Generate a synthetic archive: ~10 channels over 5 years with realistic daily
 * rhythms, recurring programmes (reruns share a clusterId), occasional empty
 * days, and channels that launch part-way through.
 */
export function generateArchive(seed = 1987): ArchiveData {
  const programmes: ProgrammeInstance[] = [];
  let nextId = 0;

  for (const channel of CHANNELS) {
    const profile = CHANNEL_PROFILE[channel.id];
    // Per-channel seed keeps each lane independent yet reproducible.
    const rng = mulberry32(seed + channel.sortOrder * 7919);

    for (let dayStart = ARCHIVE_START_MS; dayStart < ARCHIVE_END_MS; dayStart += DAY) {
      if (dayStart < channel.activeFromMs) continue; // lane exists but pre-launch
      if (channel.activeToMs && dayStart >= channel.activeToMs) continue;

      // Occasional sparse/empty days (maintenance, gaps in collection).
      if (rng() < 0.04) continue;

      generateDay(channel, profile, dayStart, rng, programmes, () => `p${nextId++}`);
    }
  }

  programmes.sort((a, b) => a.startMs - b.startMs);

  const byChannel = new Map<string, ProgrammeInstance[]>();
  for (const c of CHANNELS) byChannel.set(c.id, []);
  for (const p of programmes) byChannel.get(p.channelId)!.push(p);

  return { programmes, byChannel };
}

function generateDay(
  channel: Channel,
  profile: (typeof CHANNEL_PROFILE)[string],
  dayStart: number,
  rng: () => number,
  out: ProgrammeInstance[],
  mintId: () => string,
) {
  let cursor = dayStart + profile.startHour * HOUR;
  const dayEnd = dayStart + profile.endHour * HOUR;

  while (cursor < dayEnd) {
    const genre = pick(rng, profile.genres);

    // News has fixed, recognisable slots so the overlay reads as a pattern.
    const isNewsSlot =
      (channel.id === "DR1" && nearHour(cursor, dayStart, 18.5)) ||
      (channel.id === "DR1" && nearHour(cursor, dayStart, 21)) ||
      ((channel.id === "P1" || channel.id === "P4") && Math.abs((cursor - dayStart) % HOUR) < 5 * MIN);

    let title: string;
    let usedGenre = genre;
    let durationMin: number;

    if (isNewsSlot) {
      usedGenre = "nyheder";
      title = channel.mediaType === "tv" ? TV_NEWS : RADIO_NEWS;
      durationMin = channel.mediaType === "tv" ? 25 : 8;
    } else {
      title = pick(rng, POOLS[genre] ?? POOLS.magasin).trim();
      // Length varies around the channel's average, in 5-minute steps.
      durationMin = Math.max(10, Math.round((profile.avgMin * (0.5 + rng() * 1.1)) / 5) * 5);
    }

    const start = cursor;
    const end = Math.min(cursor + durationMin * MIN, dayEnd + 1.5 * HOUR);

    out.push({
      id: mintId(),
      title,
      channelId: channel.id,
      startMs: start,
      endMs: end,
      mediaType: channel.mediaType,
      genre: usedGenre,
      access: isNewsSlot ? "available" : accessFor(rng, usedGenre),
      // Reruns of a given title on a given channel share a cluster.
      clusterId: `${channel.id}:${title}`,
      search: title.toLowerCase(),
    });

    cursor = end;
  }
}

function nearHour(t: number, dayStart: number, hour: number): boolean {
  const h = (t - dayStart) / HOUR;
  return Math.abs(h - hour) < 0.6;
}
