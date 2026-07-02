import { ARCHIVE_END_MS, CHANNELS } from "../data/channels";
import { Archive, CATALOGUE, CHANNEL_GENRES, DAY, type TitleEntry } from "../data/archive";
import type { ProgrammeInstance } from "../data/types";
import { Camera } from "./camera";

// Minimal observable store for UI state that both React (chrome) and the
// PixiJS renderer need to read. Camera lives here too; interaction mutates it
// in place and the renderer reads it every frame.
//
// Search works against the title CATALOGUE (the archive is a lazy century —
// there is no eager instance list to filter). A query resolves to per-channel
// era intervals: the strata recede outside them at any zoom, individual bars
// match by title text, and Enter scans nearby days for a concrete broadcast.

export interface ExplorerState {
  query: string;
  showNews: boolean;
  dimRestricted: boolean;
  selected: ProgrammeInstance | null;
}

/** Rough broadcasts-per-day for a genre, for the honest "ca." count. */
const FREQ: Record<string, number> = {
  nyheder: 5,
  drama: 0.3,
  dokumentar: 0.4,
  film: 0.2,
  børn: 1.5,
  kultur: 0.5,
  musik: 1.2,
  magasin: 0.9,
  sport: 0.25,
  underholdning: 0.3,
  radioteater: 0.4,
  foredrag: 0.6,
  gudstjeneste: 0.15,
  julekalender: 0.07,
};

export class Store {
  camera = new Camera();
  state: ExplorerState = {
    query: "",
    showNews: false,
    dimRestricted: false,
    selected: null,
  };

  /** Lower-cased active query ("" = inactive). */
  queryNorm = "";
  /** True when the query matched at least one catalogue title. */
  queryActive = false;
  /** Per-channel [startMs, endMs) eras where matches can exist (merged). */
  matchIntervals: Map<string, [number, number][]> = new Map();
  /** Honest order-of-magnitude estimate of matching broadcasts. */
  estimatedCount = 0;
  /** Start of the earliest matching era, for the answer line. */
  oldestMs: number | null = null;

  private listeners = new Set<() => void>();

  constructor(public archive: Archive) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  setQuery(query: string) {
    this.state = { ...this.state, query };
    const q = query.trim().toLowerCase();
    this.queryNorm = q.length >= 2 ? q : "";
    this.matchIntervals = new Map();
    this.estimatedCount = 0;
    this.oldestMs = null;
    this.queryActive = false;

    if (this.queryNorm) {
      const titles = CATALOGUE.filter((e) => e.t.toLowerCase().includes(this.queryNorm));
      for (const c of CHANNELS) {
        const genres = CHANNEL_GENRES.get(c.id)!;
        const spans: [number, number][] = [];
        for (const t of titles) {
          if (t.m !== "both" && t.m !== c.mediaType) continue;
          if (!genres.has(t.g)) continue;
          const s = Math.max(Date.UTC(t.from, 0, 1), c.activeFromMs);
          const e = Math.min(Date.UTC((t.to ?? 2026) + 1, 0, 1), c.activeToMs ?? ARCHIVE_END_MS);
          if (s >= e) continue;
          spans.push([s, e]);
          this.estimatedCount += Math.round(((e - s) / DAY) * (FREQ[t.g] ?? 0.3));
          this.oldestMs = this.oldestMs === null ? s : Math.min(this.oldestMs, s);
        }
        if (spans.length) this.matchIntervals.set(c.id, mergeSpans(spans));
      }
      this.queryActive = this.matchIntervals.size > 0;
    }
    this.emit();
  }

  matchesProgramme(p: ProgrammeInstance): boolean {
    return this.queryNorm !== "" && p.search.includes(this.queryNorm);
  }

  /** Any match possible for this channel inside [startMs, endMs)? */
  bucketHasMatch(channelId: string, startMs: number, endMs: number): boolean {
    const spans = this.matchIntervals.get(channelId);
    if (!spans) return false;
    for (const [s, e] of spans) if (s < endMs && e > startMs) return true;
    return false;
  }

  /**
   * Find a concrete matching broadcast near the camera centre: clamp into the
   * nearest matching era, then scan days outward. Bounded and deterministic.
   */
  findNearestMatch(centerMs: number): ProgrammeInstance | null {
    if (!this.queryActive) return null;
    // Nearest point inside any interval.
    let target = centerMs;
    let bestDist = Infinity;
    for (const spans of this.matchIntervals.values()) {
      for (const [s, e] of spans) {
        const p = Math.min(Math.max(centerMs, s), e - DAY);
        const d = Math.abs(p - centerMs);
        if (d < bestDist) {
          bestDist = d;
          target = p;
        }
      }
    }
    const targetDay = Math.floor(target / DAY) * DAY;
    for (let offset = 0; offset < 300; offset++) {
      for (const sign of offset === 0 ? [1] : [1, -1]) {
        const day = targetDay + sign * offset * DAY;
        for (const [channelId, spans] of this.matchIntervals) {
          if (!spans.some(([s, e]) => day >= s && day < e)) continue;
          for (const p of this.archive.day(channelId, day)) {
            if (this.matchesProgramme(p)) return p;
          }
        }
      }
    }
    return null;
  }

  patch(partial: Partial<ExplorerState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  select(p: ProgrammeInstance | null) {
    this.state = { ...this.state, selected: p };
    this.emit();
  }
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

export type { TitleEntry };
