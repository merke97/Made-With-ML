import { useEffect, useMemo, useRef, useState } from "react";
import { loadLiveWorld } from "./data/live";
import { buildSyntheticWorld, type World } from "./data/world";
import type { TimelineRenderer } from "./timeline/renderer";
import { Store } from "./timeline/store";
import { DetailPanel } from "./ui/DetailPanel";
import { HelpHint, Legend, StatusReadout } from "./ui/Overlays";
import { TimelineView } from "./ui/TimelineView";
import { Toolbar } from "./ui/Toolbar";

export default function App() {
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState<string | null>("Bygger det syntetiske arkiv…");
  const [error, setError] = useState<string | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const [, setReady] = useState(false);

  // Build the synthetic world after first paint (it blocks the thread a beat).
  useEffect(() => {
    const id = setTimeout(() => {
      setWorld(buildSyntheticWorld());
      setLoading(null);
    }, 30);
    return () => clearTimeout(id);
  }, []);

  // A fresh Store (camera + channel map) per world; remounting the canvas keys
  // off the same identity so the renderer rebuilds cleanly on a source switch.
  const store = useMemo(() => (world ? new Store(world.data, world.channels, world) : null), [world]);

  async function loadLive(fromMs: number, toMs: number) {
    setError(null);
    setLoading("Henter fra DR-arkivet…");
    try {
      const w = await loadLiveWorld(fromMs, toMs);
      rendererRef.current = null;
      setWorld(w);
    } catch (e) {
      setError(`Kunne ikke hente arkivdata: ${e instanceof Error ? e.message : e}. Kør proxyen lokalt (npm run server).`);
    } finally {
      setLoading(null);
    }
  }

  function useSynthetic() {
    rendererRef.current = null;
    setWorld(buildSyntheticWorld());
  }

  if (!world || !store) {
    return <Splash message={loading ?? "Indlæser…"} />;
  }

  return (
    <div className="app">
      <Toolbar
        store={store}
        rendererRef={rendererRef}
        world={world}
        loading={loading}
        onLoadLive={loadLive}
        onUseSynthetic={useSynthetic}
      />
      {error && <div className="banner error">{error}</div>}
      <main className="stage">
        <TimelineView
          key={`${world.label}:${world.startMs}:${world.endMs}`}
          store={store}
          data={world.data}
          agg={world.agg}
          channels={world.channels}
          onReady={(r) => {
            rendererRef.current = r;
            setReady(true);
          }}
        />
        <StatusReadout store={store} live={world.live} />
        <Legend />
        <HelpHint />
        <DetailPanel store={store} />
        {loading && <div className="loading-veil">{loading}</div>}
      </main>
    </div>
  );
}

function Splash({ message }: { message: string }) {
  return (
    <div className="splash">
      <div className="splash-mark">DR</div>
      <div className="splash-title">Arkivets Tidskort</div>
      <div className="splash-sub">{message}</div>
      <div className="splash-bar">
        <span />
      </div>
    </div>
  );
}
