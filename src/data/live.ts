import { buildAggregates } from "./aggregate";
import type { ArchiveData } from "./generate";
import type { Channel, ProgrammeInstance } from "./types";
import type { World } from "./world";

// Live data layer: fetches the real DR-arkivet via our proxy (/api/*), which
// holds the kb.dk auth cookie and forwards Solr queries. In dev the proxy is
// the Vite middleware; in production set VITE_API_BASE to a hosted proxy.
//
// This loads a *bounded window* (a date range) into the same in-memory shape
// the synthetic path produces, so the renderer is unchanged. The full
// "stream a tile per viewport" model is the natural next step on top of this.

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const MAX_LANES = 24; // keep the lane list legible

const iso = (ms: number) => new Date(ms).toISOString();

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`);
  if (!res.ok) throw new Error(`Proxy ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

interface ApiChannel {
  id: string;
  label: string;
  mediaType: "tv" | "radio";
  sortOrder: number;
  count: number;
}

export async function fetchChannels(activeFromMs: number): Promise<Channel[]> {
  const raw = await api<ApiChannel[]>("/channels");
  return raw.slice(0, MAX_LANES).map((c, i) => ({
    id: c.id,
    label: c.label,
    mediaType: c.mediaType,
    sortOrder: c.sortOrder ?? i,
    activeFromMs,
  }));
}

/** Load a real archive slice [fromMs, toMs] into a renderable World. */
export async function loadLiveWorld(fromMs: number, toMs: number): Promise<World> {
  const channels = await fetchChannels(fromMs);

  const byChannel = new Map<string, ProgrammeInstance[]>();
  const all: ProgrammeInstance[] = [];

  // One windowed request per channel keeps each under the ~2000-row cap.
  await Promise.all(
    channels.map(async (c) => {
      const res = await api<{ programmes: ProgrammeInstance[] }>(
        `/window?from=${encodeURIComponent(iso(fromMs))}&to=${encodeURIComponent(iso(toMs))}&channel=${encodeURIComponent(
          c.id,
        )}&n=2000`,
      );
      const progs = res.programmes ?? [];
      byChannel.set(c.id, progs);
      all.push(...progs);
    }),
  );

  all.sort((a, b) => a.startMs - b.startMs);
  for (const c of channels) if (!byChannel.has(c.id)) byChannel.set(c.id, []);

  const data: ArchiveData = { programmes: all, byChannel };
  const agg = buildAggregates(data, channels);

  return {
    data,
    agg,
    channels,
    startMs: fromMs,
    endMs: toMs,
    live: true,
    label: "DR-arkivet",
  };
}
