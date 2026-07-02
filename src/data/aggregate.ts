import type { AggregateLevel, TrackAggregate } from "./types";

// Track ids used by the layout/renderer for the rollup bands. Since the
// terrain is drawn as per-channel strata at every level, no separate rollup
// aggregates exist — the ids only name the layout bands.
export const TRACK_ARCHIVE = "ARCHIVE";
export const TRACK_TV = "TV";
export const TRACK_RADIO = "RADIO";

export interface TrackLOD {
  year: TrackAggregate;
  month: TrackAggregate;
  day: TrackAggregate;
  /** Per-level max broadcastMs, for pigment normalisation. */
  max: Record<AggregateLevel, number>;
}

export type AggregateIndex = Map<string, TrackLOD>;
