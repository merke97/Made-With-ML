import { useState } from "react";
import type { World } from "../data/world";
import type { TimelineRenderer } from "../timeline/renderer";
import type { Store } from "../timeline/store";
import { MS } from "../timeline/zoom";
import { useExplorerState } from "./useStore";

interface Props {
  store: Store;
  rendererRef: React.RefObject<TimelineRenderer | null>;
  world: World;
  loading: string | null;
  onLoadLive: (fromMs: number, toMs: number) => void;
  onUseSynthetic: () => void;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function Toolbar({ store, rendererRef, world, loading, onLoadLive, onUseSynthetic }: Props) {
  const state = useExplorerState(store);
  const [jumpDate, setJumpDate] = useState(isoDay(world.startMs + (world.endMs - world.startMs) / 2));
  // Default live window: a dense week in 2013 (the archive's peak year).
  const [liveFrom, setLiveFrom] = useState("2013-03-04");
  const [liveTo, setLiveTo] = useState("2013-03-11");
  const matches = store.matchedSorted.length;

  const jump = () => {
    const ms = Date.parse(jumpDate + "T12:00:00Z");
    if (Number.isNaN(ms)) return;
    const clamped = Math.min(world.endMs - MS.day, Math.max(world.startMs, ms));
    rendererRef.current?.flyTo(clamped, MS.day / 1400);
  };

  const fetchLive = () => {
    const from = Date.parse(liveFrom + "T00:00:00Z");
    const to = Date.parse(liveTo + "T23:59:59Z");
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return;
    onLoadLive(from, to);
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">DR</span>
        <span className="brand-title">Arkivets Tidskort</span>
      </div>

      <div className="search">
        <input
          type="search"
          placeholder="Søg i arkivet (fx Berlinmuren, TV Avisen)…"
          value={state.query}
          onChange={(e) => store.setQuery(e.target.value)}
          aria-label="Søg i arkivet"
        />
        {state.query.trim().length >= 2 && (
          <span className="search-count">{matches.toLocaleString("da-DK")} træffere</span>
        )}
      </div>

      <div className="layers" role="group" aria-label="Lag">
        <label className={state.showNews ? "on" : ""}>
          <input type="checkbox" checked={state.showNews} onChange={(e) => store.patch({ showNews: e.target.checked })} />
          Nyheder
        </label>
        <label className={state.dimRestricted ? "on" : ""}>
          <input
            type="checkbox"
            checked={state.dimRestricted}
            onChange={(e) => store.patch({ dimRestricted: e.target.checked })}
          />
          Dæmp begrænset
        </label>
      </div>

      <div className="datejump">
        <input
          type="date"
          min={isoDay(world.startMs)}
          max={isoDay(world.endMs)}
          value={jumpDate}
          onChange={(e) => setJumpDate(e.target.value)}
        />
        <button onClick={jump}>Gå til dato</button>
      </div>

      {/* Data source: synthetic (default/offline) or a live DR-arkivet slice. */}
      <div className="source" role="group" aria-label="Datakilde">
        <div className="seg">
          <button className={world.live ? "" : "on"} onClick={onUseSynthetic} disabled={!!loading}>
            Syntetisk
          </button>
          <button className={world.live ? "on" : ""} onClick={fetchLive} disabled={!!loading} title="Hent valgt uge fra DR-arkivet">
            DR-arkivet
          </button>
        </div>
        {world.live && (
          <div className="live-window">
            <input type="date" value={liveFrom} onChange={(e) => setLiveFrom(e.target.value)} />
            <span>–</span>
            <input type="date" value={liveTo} onChange={(e) => setLiveTo(e.target.value)} />
            <button onClick={fetchLive} disabled={!!loading}>
              Hent
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
