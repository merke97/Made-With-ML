import { useEffect, useRef, useState } from "react";
import { CHANNELS_BY_ID } from "../data/channels";
import type { AccessState } from "../data/types";
import type { TimelineRenderer } from "../timeline/renderer";
import type { Store } from "../timeline/store";
import { formatDateTime } from "../timeline/ticks";
import { useExplorerState } from "./useStore";

const ACCESS_LABEL: Record<AccessState, string> = {
  available: "tilgængelig",
  metadata_only: "kun metadata",
  restricted: "adgangsbegrænset",
  unknown: "ukendt status",
};

function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} t ${m % 60} min`;
}

interface Props {
  store: Store;
  rendererRef: React.RefObject<TimelineRenderer | null>;
}

// No panel, no box: the selected broadcast lifts on the canvas and its
// metadata is set in the space beside it. This component only does the
// typesetting — position tracks the lifted bar every frame.
export function MetaFloat({ store, rendererRef }: Props) {
  const { selected } = useExplorerState(store);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = ref.current;
      const rect = rendererRef.current?.getSelectedRect() ?? null;
      if (!el) return;
      if (!rect || !selected) {
        setVisible(false);
        return;
      }
      setVisible(true);
      const stage = el.parentElement!;
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      const w = Math.min(340, sw - 32);
      const below = rect.y + rect.h + 26;
      const x = Math.max(16, Math.min(rect.x, sw - w - 16));
      // Sit under the lifted bar; if there is no room, sit above it.
      const y = below + 150 < sh ? below : Math.max(12, rect.y - 160);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.width = `${w}px`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rendererRef, selected]);

  if (!selected) return null;
  const channel = CHANNELS_BY_ID.get(selected.channelId);

  return (
    <div ref={ref} className="meta-float" role="dialog" aria-label="Udsendelse" style={{ opacity: visible ? 1 : 0 }}>
      <p className="mf-title">{selected.title}</p>
      <p className="mf-facts">
        {channel?.label ?? selected.channelId} · {formatDateTime(selected.startMs)} ·{" "}
        {duration(selected.endMs - selected.startMs)} · {ACCESS_LABEL[selected.access]}
      </p>
      <div className="mf-acts">
        {selected.access === "available" && (
          <a className="play" href="#" onClick={(e) => e.preventDefault()}>
            Afspil i DR-arkivet
          </a>
        )}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            store.setQuery(selected.title);
          }}
        >
          Alle genudsendelser
        </a>
      </div>
    </div>
  );
}
