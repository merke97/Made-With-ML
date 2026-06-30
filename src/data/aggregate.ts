import type { ArchiveData } from "./generate";
import type { AggregateBucket, AggregateLevel, Channel, ProgrammeInstance, TrackAggregate } from "./types";

// Track ids used by the layout/renderer for aggregate rollups.
export const TRACK_ARCHIVE = "ARCHIVE";
export const TRACK_TV = "TV";
export const TRACK_RADIO = "RADIO";

function bucketKey(ms: number, level: AggregateLevel): number {
  const d = new Date(ms);
  if (level === "year") return Date.UTC(d.getUTCFullYear(), 0, 1);
  if (level === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function bucketEnd(startMs: number, level: AggregateLevel): number {
  const d = new Date(startMs);
  if (level === "year") return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  if (level === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return startMs + 24 * 3600_000;
}

function bucketize(programmes: ProgrammeInstance[], level: AggregateLevel): TrackAggregate & { max: number } {
  const map = new Map<number, AggregateBucket>();
  for (const p of programmes) {
    const key = bucketKey(p.startMs, level);
    let b = map.get(key);
    if (!b) {
      b = {
        startMs: key,
        endMs: bucketEnd(key, level),
        broadcastMs: 0,
        programmeCount: 0,
        availableCount: 0,
        restrictedCount: 0,
        newsCount: 0,
      };
      map.set(key, b);
    }
    b.broadcastMs += p.endMs - p.startMs;
    b.programmeCount += 1;
    if (p.access === "available") b.availableCount += 1;
    else if (p.access === "restricted") b.restrictedCount += 1;
    if (p.genre === "nyheder") b.newsCount += 1;
  }
  const buckets = [...map.values()].sort((a, b) => a.startMs - b.startMs);
  let max = 1;
  for (const b of buckets) max = Math.max(max, b.broadcastMs);
  return { trackId: "", level, buckets, max };
}

export interface TrackLOD {
  year: TrackAggregate;
  month: TrackAggregate;
  day: TrackAggregate;
  /** Per-level max broadcastMs, for brightness normalisation. */
  max: Record<AggregateLevel, number>;
}

export type AggregateIndex = Map<string, TrackLOD>;

function lodFor(programmes: ProgrammeInstance[], trackId: string): TrackLOD {
  const year = bucketize(programmes, "year");
  const month = bucketize(programmes, "month");
  const day = bucketize(programmes, "day");
  const tag = (t: TrackAggregate) => ((t.trackId = trackId), t);
  return {
    year: tag(year),
    month: tag(month),
    day: tag(day),
    max: { year: year.max, month: month.max, day: day.max },
  };
}

/** Precompute LOD aggregates for every channel and every rollup track. */
export function buildAggregates(data: ArchiveData, channels: Channel[]): AggregateIndex {
  const index: AggregateIndex = new Map();

  for (const c of channels) {
    index.set(c.id, lodFor(data.byChannel.get(c.id) ?? [], c.id));
  }

  const tvProgs = channels
    .filter((c) => c.mediaType === "tv")
    .flatMap((c) => data.byChannel.get(c.id) ?? [])
    .sort((a, b) => a.startMs - b.startMs);
  const radioProgs = channels
    .filter((c) => c.mediaType === "radio")
    .flatMap((c) => data.byChannel.get(c.id) ?? [])
    .sort((a, b) => a.startMs - b.startMs);

  index.set(TRACK_TV, lodFor(tvProgs, TRACK_TV));
  index.set(TRACK_RADIO, lodFor(radioProgs, TRACK_RADIO));
  index.set(TRACK_ARCHIVE, lodFor(data.programmes, TRACK_ARCHIVE));

  return index;
}
