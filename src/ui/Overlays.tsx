import { useEffect, useRef, useState } from "react";
import type { Store } from "../timeline/store";
import { formatDay } from "../timeline/ticks";
import { computeZoomState } from "../timeline/zoom";

// Live readout of where the camera is in the semantic-zoom continuum. Reads the
// camera each animation frame (throttled) — this is the only React surface that
// reflects raw camera state, so the rest of the app never re-renders on pan.
function phaseLabel(zoomState: ReturnType<typeof computeZoomState>): string {
  if (zoomState.pChannel > 0.85 && zoomState.pProgramme > 0.5) return "Udsendelser";
  if (zoomState.pChannel > 0.5) return "Kanaler";
  if (zoomState.pMedia > 0.5) return "Fjernsyn / Radio";
  return "Hele arkivet";
}

export function StatusReadout({ store, live }: { store: Store; live: boolean }) {
  const [text, setText] = useState({ phase: "Hele arkivet", date: "" });
  const last = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last.current < 120) return;
      last.current = now;
      const cam = store.camera;
      const z = computeZoomState(cam.msPerPixel);
      setText({ phase: phaseLabel(z), date: formatDay(cam.centerTimeMs) });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  return (
    <div className="status">
      <span className={`status-source ${live ? "live" : ""}`}>{live ? "● DR-arkivet (live)" : "Syntetisk data"}</span>
      <span className="status-phase">{text.phase}</span>
      <span className="status-date">{text.date}</span>
    </div>
  );
}

export function Legend() {
  return (
    <div className="legend" aria-hidden>
      <div className="legend-row">
        <span className="dot tv" /> Fjernsyn
        <span className="dot radio" /> Radio
      </div>
      <div className="legend-row access">
        <span className="bar solid" /> Tilgængelig
        <span className="bar outline" /> Kun metadata
        <span className="bar dim" /> Begrænset
      </div>
    </div>
  );
}

export function HelpHint() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="help">
      <button className="help-close" aria-label="Skjul" onClick={() => setOpen(false)}>
        ×
      </button>
      <strong>Bevæg dig gennem sendehistorien</strong>
      <ul>
        <li>
          <b>Træk</b> for at panorere — vandret er tid, lodret er kanaler
        </li>
        <li>
          <b>Scroll</b> eller <b>knib</b> (to fingre) for at zoome
        </li>
        <li>
          <b>Dobbelt-klik / dobbelt-tap</b> zoomer ind
        </li>
        <li>Zoom ind: arkivet deler sig i fjernsyn, radio, kanaler og udsendelser</li>
        <li>
          <b>Tap</b> en udsendelse for detaljer
        </li>
      </ul>
    </div>
  );
}
