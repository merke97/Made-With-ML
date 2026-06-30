import type { AccessState } from "../data/types";
import type { Store } from "../timeline/store";
import { formatDateTime } from "../timeline/ticks";
import { useExplorerState } from "./useStore";

const ACCESS_LABEL: Record<AccessState, string> = {
  available: "Tilgængelig online",
  metadata_only: "Kun metadata",
  restricted: "Adgangsbegrænset",
  unknown: "Ukendt status",
};

function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} t ${m % 60} min`;
}

// The accessible, textual surface for a selected broadcast. The canvas is the
// spatial explorer; this panel is normal DOM (screen-readable, copyable).
export function DetailPanel({ store }: { store: Store }) {
  const { selected } = useExplorerState(store);
  if (!selected) return null;

  const channel = store.channelsById.get(selected.channelId);

  return (
    <aside className="detail-panel" role="dialog" aria-label="Udsendelsesdetaljer">
      <button className="detail-close" aria-label="Luk" onClick={() => store.select(null)}>
        ×
      </button>
      <div className={`access-pill access-${selected.access}`}>{ACCESS_LABEL[selected.access]}</div>
      <h2>{selected.title}</h2>
      <dl>
        <div>
          <dt>Kanal</dt>
          <dd>{channel?.label ?? selected.channelId}</dd>
        </div>
        <div>
          <dt>Sendt</dt>
          <dd>{formatDateTime(selected.startMs)}</dd>
        </div>
        <div>
          <dt>Varighed</dt>
          <dd>
            {duration(selected.endMs - selected.startMs)} · til {formatDateTime(selected.endMs).split(", ")[1]}
          </dd>
        </div>
        <div>
          <dt>Genre</dt>
          <dd style={{ textTransform: "capitalize" }}>{selected.genre}</dd>
        </div>
      </dl>

      <div className="detail-actions">
        {selected.link ? (
          <a
            className="btn primary"
            href={selected.link}
            target="_blank"
            rel="noreferrer"
            aria-disabled={selected.access !== "available"}
          >
            Åbn i DR-arkivet
          </a>
        ) : (
          <button className="primary" disabled title="Deeplink kun for rigtige arkivdata">
            Åbn i DR-arkivet
          </button>
        )}
        <button onClick={() => store.setQuery(selected.title)}>Find genudsendelser</button>
      </div>
      <p className="detail-note">
        Klyngen <code>{selected.clusterId}</code> samler sandsynlige genudsendelser af samme program.
        {selected.link ? " Data fra DR-arkivet." : " Syntetiske data — “Åbn” aktiveres med rigtige arkivdata."}
      </p>
    </aside>
  );
}
