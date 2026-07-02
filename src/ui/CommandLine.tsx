import { useEffect, useRef, useState } from "react";
import { ARCHIVE_END_MS, ARCHIVE_START_MS } from "../data/channels";
import type { TimelineRenderer } from "../timeline/renderer";
import type { Store } from "../timeline/store";
import { formatDay } from "../timeline/ticks";
import { MS } from "../timeline/zoom";
import { useExplorerState } from "./useStore";

// The one control. Summoned with "/" (or by just typing), it understands
// search words, dates and lenses; released, it sinks back into the paper.
// Everything the old toolbar did lives in this single line.

const MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];

/** Parse Danish-ish dates: "15. juni 2021", "juni 2021", "2021", "2021-06-15". */
function parseDate(raw: string): { ms: number; mpp: number } | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], 12), mpp: MS.day / 1400 };
  m = s.match(/^(\d{1,2})\.?\s+([a-zæøå]+)\.?\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.startsWith(m![2]));
    if (mon >= 0) return { ms: Date.UTC(+m[3], mon, +m[1], 12), mpp: MS.day / 1400 };
  }
  m = s.match(/^([a-zæøå]+)\.?\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.startsWith(m![1]));
    if (mon >= 0) return { ms: Date.UTC(+m[2], mon, 15, 12), mpp: (30 * MS.day) / 1100 };
  }
  m = s.match(/^(\d{4})$/);
  if (m && +m[1] >= 1900 && +m[1] <= 2100) return { ms: Date.UTC(+m[1], 6, 1), mpp: (365 * MS.day) / 1100 };
  return null;
}

const LENSES: { match: RegExp; key: "showNews" | "dimRestricted"; label: string }[] = [
  { match: /^nyheder$/, key: "showNews", label: "nyheder" },
  { match: /^(kun\s+)?tilgængelige?$/, key: "dimRestricted", label: "kun tilgængelige" },
];

interface Props {
  store: Store;
  rendererRef: React.RefObject<TimelineRenderer | null>;
}

export function CommandLine({ store, rendererRef }: Props) {
  const state = useExplorerState(store);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Summon on "/" or by simply starting to type; Esc releases (and unwinds).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typingElsewhere = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "Escape") {
        if (open) {
          setOpen(false);
          setText("");
          store.setQuery("");
        } else if (state.query) {
          store.setQuery("");
        } else if (state.showNews || state.dimRestricted) {
          store.patch({ showNews: false, dimRestricted: false });
        } else if (state.selected) {
          store.select(null);
        }
        return;
      }
      if (typingElsewhere || open) return;
      if (e.key === "/" || /^[\p{L}\d]$/u.test(e.key)) {
        e.preventDefault();
        const seed = e.key === "/" ? "" : e.key;
        setText(seed);
        setOpen(true);
        if (seed) store.setQuery(seed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, state.query, state.showNews, state.dimRestricted, state.selected, store]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const matches = store.matchedSorted;
  const date = parseDate(text);
  const lens = LENSES.find((l) => l.match.test(text.trim().toLowerCase()));

  const answer = (() => {
    if (!text.trim()) return "søgeord · dato (15. juni 2021) · nyheder · kun tilgængelige";
    if (lens) return `enter — ${state[lens.key] ? "sluk" : "tænd"} linsen “${lens.label}”`;
    if (date) return `enter — flyv til ${formatDay(date.ms)}`;
    if (text.trim().length < 2) return "skriv videre …";
    if (!matches.length) return "ingen udsendelser · resten af arkivet står urørt";
    return `${matches.length.toLocaleString("da-DK")} udsendelser · ældste ${formatDay(matches[0].startMs)} · enter flyver til nærmeste`;
  })();

  const onChange = (v: string) => {
    setText(v);
    // Dates and lens words are commands, not searches — don't recede the world.
    if (parseDate(v) || LENSES.some((l) => l.match.test(v.trim().toLowerCase()))) store.setQuery("");
    else store.setQuery(v);
  };

  const submit = () => {
    if (lens) {
      store.patch({ [lens.key]: !state[lens.key] } as Partial<typeof state>);
      store.setQuery("");
      setText("");
      setOpen(false);
      return;
    }
    if (date) {
      const clamped = Math.min(ARCHIVE_END_MS - MS.day, Math.max(ARCHIVE_START_MS, date.ms));
      rendererRef.current?.flyTo(clamped, date.mpp);
      setText("");
      setOpen(false);
      return;
    }
    if (matches.length) {
      // Fly to the match nearest ahead of the current view centre.
      const center = store.camera.centerTimeMs;
      let lo = 0,
        hi = matches.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (matches[mid].startMs < center) lo = mid + 1;
        else hi = mid;
      }
      const target = matches[Math.min(lo, matches.length - 1)];
      rendererRef.current?.flyTo((target.startMs + target.endMs) / 2, MS.day / 1400);
      store.select(target);
      setOpen(false); // the query stays — the world remains focused
    }
  };

  const activeLenses = [
    state.query.trim().length >= 2 ? `“${state.query.trim()}” · ${matches.length.toLocaleString("da-DK")}` : null,
    state.showNews ? "nyheder" : null,
    state.dimRestricted ? "kun tilgængelige" : null,
  ].filter(Boolean);

  if (!open) {
    // The line is always physically present as a whisper on the paper — tap
    // (the only way in on touch) or press "/" and it rises.
    return (
      <button className="lens-whisper" onClick={() => { setText(state.query); setOpen(true); }}>
        {activeLenses.length ? (
          <>
            {activeLenses.join(" · ")} <span className="esc">esc rydder</span>
          </>
        ) : (
          <span className="summon">Søg i arkivet</span>
        )}
      </button>
    );
  }

  return (
    <div className="command" role="search">
      <input
        ref={inputRef}
        value={text}
        aria-label="Søg, dato eller linse"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        onBlur={() => {
          if (!text.trim()) setOpen(false);
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="command-answer">{answer}</div>
    </div>
  );
}
