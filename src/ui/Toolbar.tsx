import { useState } from "react";
import { ARCHIVE_END_MS, ARCHIVE_START_MS } from "../data/channels";
import type { TimelineRenderer } from "../timeline/renderer";
import type { Store } from "../timeline/store";
import { MS } from "../timeline/zoom";
import { useExplorerState } from "./useStore";

interface Props {
  store: Store;
  rendererRef: React.RefObject<TimelineRenderer | null>;
}

export function Toolbar({ store, rendererRef }: Props) {
  const state = useExplorerState(store);
  const [date, setDate] = useState("2021-06-15");
  const matches = store.matchedSorted.length;

  const jump = () => {
    const ms = Date.parse(date + "T12:00:00Z");
    if (Number.isNaN(ms)) return;
    const clamped = Math.min(ARCHIVE_END_MS - MS.day, Math.max(ARCHIVE_START_MS, ms));
    // Land at day-level detail so channel lanes and programmes are visible.
    rendererRef.current?.flyTo(clamped, MS.day / 1400);
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
          <input
            type="checkbox"
            checked={state.showNews}
            onChange={(e) => store.patch({ showNews: e.target.checked })}
          />
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
        <input type="date" min="2019-01-01" max="2023-12-31" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={jump}>Gå til dato</button>
      </div>
    </header>
  );
}
