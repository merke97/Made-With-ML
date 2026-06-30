// Core domain model for the DR Archive Temporal Explorer.
//
// The base world has only four permanent concepts: time, tracks, programme
// spans, and overlays. These types describe the first three; overlays are
// derived on top of programmes at render time.

export type MediaType = "tv" | "radio";

/** Availability honestly reflects that not every record can be played. */
export type AccessState =
  | "available" // playable online
  | "metadata_only" // we know it exists, no playable file
  | "restricted" // rights-limited / holdback
  | "unknown";

export interface Channel {
  id: string;
  label: string;
  mediaType: MediaType;
  /** Permanent vertical ordering. Rows never reorder while scrolling time. */
  sortOrder: number;
  /** Lane exists before this, but shows as inactive/empty. */
  activeFromMs: number;
  activeToMs?: number;
}

/** One specific broadcast at one specific time. Reruns are NOT collapsed. */
export interface ProgrammeInstance {
  id: string;
  title: string;
  channelId: string;
  startMs: number;
  endMs: number;
  mediaType: MediaType;
  genre: string;
  access: AccessState;
  /** Likely same work across reruns (used by a future "collapse reruns" overlay). */
  clusterId: string;
  /** Cheap lower-cased title for search; precomputed once. */
  search: string;
  /** Deep link into DR-arkivet (live data only). */
  link?: string;
}

export type AggregateLevel = "year" | "month" | "day";

/** Precomputed level-of-detail bucket for the zoomed-out terrain. */
export interface AggregateBucket {
  startMs: number;
  endMs: number;
  /** Sum of broadcast time inside the bucket (the base terrain metric). */
  broadcastMs: number;
  programmeCount: number;
  availableCount: number;
  restrictedCount: number;
  /** News broadcasts (TV Avisen / Radioavisen) — drives the news overlay terrain. */
  newsCount: number;
}

/** Aggregates for one track at one level, ordered by startMs. */
export interface TrackAggregate {
  trackId: string;
  level: AggregateLevel;
  buckets: AggregateBucket[];
}
