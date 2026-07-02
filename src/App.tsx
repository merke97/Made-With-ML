import { useEffect, useRef, useState } from "react";
import { Archive } from "./data/archive";
import type { TimelineRenderer } from "./timeline/renderer";
import { Store } from "./timeline/store";
import { CommandLine } from "./ui/CommandLine";
import { MetaFloat } from "./ui/MetaFloat";
import { BrandWhisper, FirstRunWhisper } from "./ui/Overlays";
import { TimelineView } from "./ui/TimelineView";

interface Built {
  archive: Archive;
  store: Store;
}

export default function App() {
  // A century of archive: aggregates are computed procedurally at startup
  // (fast), while individual broadcasts are generated lazily per day as the
  // camera needs them — the same split as the production temporal tile server.
  const [built, setBuilt] = useState<Built | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const [, setReady] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      const archive = new Archive();
      const store = new Store(archive);
      // Dev-only hook for the interaction trace harness (see repo history).
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
        (window as unknown as { __store: Store }).__store = store;
      }
      setBuilt({ archive, store });
    }, 30);
    return () => clearTimeout(id);
  }, []);

  if (!built) {
    return (
      <div className="splash">
        <div className="splash-mark">DR</div>
        <div className="splash-title">Tidsrummet</div>
        <div className="splash-sub">Åbner hundrede års arkiv…</div>
        <div className="splash-bar">
          <span />
        </div>
      </div>
    );
  }

  const { archive, store } = built;
  return (
    <div className="app">
      <main className="stage">
        <TimelineView
          store={store}
          archive={archive}
          onReady={(r) => {
            rendererRef.current = r;
            setReady(true);
          }}
        />
        <BrandWhisper />
        <FirstRunWhisper />
        <MetaFloat store={store} rendererRef={rendererRef} />
        <CommandLine store={store} rendererRef={rendererRef} />
      </main>
    </div>
  );
}
