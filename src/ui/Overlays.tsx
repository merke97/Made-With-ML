import { useEffect, useRef, useState } from "react";

// The only chrome left: a brand whisper that steps aside while you drive, and
// a single first-visit hint that teaches the grip once, then never returns.

export function BrandWhisper() {
  const [quiet, setQuiet] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    const wake = () => {
      setQuiet(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setQuiet(false), 1800);
    };
    window.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("wheel", wake, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("wheel", wake);
      window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className={`brand-whisper${quiet ? " quiet" : ""}`} aria-hidden>
      <span className="brand-dr">DR</span>
      <span className="brand-name">Tidsrummet</span>
    </div>
  );
}

const HINT_KEY = "tidsrummet-hint-seen";

export function FirstRunWhisper() {
  const [gone, setGone] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (gone) return;
    const dismiss = () => {
      setGone(true);
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        /* private mode */
      }
    };
    window.addEventListener("wheel", dismiss, { passive: true, once: true });
    window.addEventListener("pointerdown", dismiss, { passive: true, once: true });
    return () => {
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("pointerdown", dismiss);
    };
  }, [gone]);

  if (gone) return null;
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return (
    <div className="firstrun-whisper" aria-hidden>
      {coarse ? (
        <>Knib for at nærme dig · træk for at bevæge dig · dobbelttryk dykker</>
      ) : (
        <>
          Rul for at nærme dig · træk for at bevæge dig · tryk <b>/</b> for at søge
        </>
      )}
    </div>
  );
}
