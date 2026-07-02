import { useEffect, useRef, useState } from "react";
import { buildAggregates, type AggregateIndex } from "./data/aggregate";
import { generateArchive, type ArchiveData } from "./data/generate";
import type { TimelineRenderer } from "./timeline/renderer";
import { Store } from "./timeline/store";
import { DetailPanel } from "./ui/DetailPanel";
import { HelpHint, Legend, StatusReadout } from "./ui/Overlays";
import { TimelineView } from "./ui/TimelineView";
import { Toolbar } from "./ui/Toolbar";

interface Built {
  data: ArchiveData;
  agg: AggregateIndex;
  store: Store;
}

export default function App() {
  // The synthetic archive (~10 channels × 5 years) is large enough to block the
  // main thread for a beat, so build it after first paint behind a splash. The
  // real product would instead stream viewport tiles from a temporal tile server.
  const [built, setBuilt] = useState<Built | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const [, setReady] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      const data = generateArchive();
      const agg = buildAggregates(data);
      const store = new Store(data);
      // Dev-only hook for the interaction trace harness (see repo history).
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
        (window as unknown as { __store: Store }).__store = store;
      }
      setBuilt({ data, agg, store });
    }, 30);
    return () => clearTimeout(id);
  }, []);

  if (!built) {
    return (
      <div className="splash">
        <div className="splash-mark">DR</div>
        <div className="splash-title">Arkivets Tidskort</div>
        <div className="splash-sub">Bygger det syntetiske arkiv…</div>
        <div className="splash-bar">
          <span />
        </div>
      </div>
    );
  }

  const { data, agg, store } = built;
  return (
    <div className="app">
      <Toolbar store={store} rendererRef={rendererRef} />
      <main className="stage">
        <TimelineView
          store={store}
          data={data}
          agg={agg}
          onReady={(r) => {
            rendererRef.current = r;
            setReady(true);
          }}
        />
        <StatusReadout store={store} />
        <Legend />
        <HelpHint />
        <DetailPanel store={store} />
      </main>
    </div>
  );
}
