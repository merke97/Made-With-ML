import { buildAggregates, type AggregateIndex } from "./aggregate";
import { ARCHIVE_END_MS, ARCHIVE_START_MS, CHANNELS } from "./channels";
import { generateArchive, type ArchiveData } from "./generate";
import type { Channel } from "./types";

// A "World" is everything the renderer needs to draw: the channel geography,
// the time bounds, the programme data and its precomputed aggregates. There are
// two builders — synthetic (default, offline) and live (DR-arkivet via proxy).

export interface World {
  data: ArchiveData;
  agg: AggregateIndex;
  channels: Channel[];
  startMs: number;
  endMs: number;
  live: boolean;
  label: string;
}

export function buildSyntheticWorld(): World {
  const data = generateArchive();
  const agg = buildAggregates(data, CHANNELS);
  return {
    data,
    agg,
    channels: CHANNELS,
    startMs: ARCHIVE_START_MS,
    endMs: ARCHIVE_END_MS,
    live: false,
    label: "Syntetisk",
  };
}
