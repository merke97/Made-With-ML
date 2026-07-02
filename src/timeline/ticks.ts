import { MS, smoothstep } from "./zoom";

// Adaptive time-ruler ticks. Instead of switching granularity at hard
// thresholds (which pops the whole gridline forest in a single frame), every
// level — year, month, day, 6h, hour — fades in continuously as its pixel
// spacing grows. Gridlines appear before labels, since labels need more room.

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const pad = (n: number) => (n < 10 ? "0" + n : "" + n);

export interface Tick {
  ms: number;
  label: string;
  major: boolean;
  /** 0..1 tick/gridline strength — finer levels fade in as spacing allows. */
  alpha: number;
  /** 0..1 label strength — labels need more room than gridlines. */
  labelAlpha: number;
}

// Pixel spacing over which a level's gridlines / labels fade in.
const GRID_IN = [22, 56] as const;
const LABEL_IN = [50, 92] as const;

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}`;
}

export function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function computeTicks(viewStart: number, viewEnd: number, msPerPixel: number): Tick[] {
  const ticks: Tick[] = [];
  // Coarser levels claim their boundary first (a month tick is also a day
  // tick, midnight is also an hour tick) so each moment renders exactly once.
  const seen = new Set<number>();
  const push = (ms: number, label: string, major: boolean, alpha: number, labelAlpha: number) => {
    if (seen.has(ms)) return;
    seen.add(ms);
    ticks.push({ ms, label, major, alpha, labelAlpha });
  };
  const fade = (spacingMs: number): [number, number] => {
    const px = spacingMs / msPerPixel;
    return [smoothstep(GRID_IN[0], GRID_IN[1], px), smoothstep(LABEL_IN[0], LABEL_IN[1], px)];
  };

  const [aMonth, lMonth] = fade(30 * MS.day);
  const [aDay, lDay] = fade(MS.day);
  const [a6h, l6h] = fade(6 * MS.hour);
  const [aHour, lHour] = fade(MS.hour);

  // Years are the bedrock — always present, always labelled.
  {
    const y0 = new Date(viewStart).getUTCFullYear();
    const y1 = new Date(viewEnd).getUTCFullYear() + 1;
    for (let y = y0; y <= y1; y++) push(Date.UTC(y, 0, 1), `${y}`, true, 1, 1);
  }

  if (aMonth > 0.02) {
    // Walk the calendar — months aren't fixed length.
    const d = new Date(viewStart);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    for (;;) {
      const t = Date.UTC(y, m, 1);
      if (t > viewEnd) break;
      push(t, `${MONTHS[m]} ${y}`, true, aMonth, lMonth);
      if (++m > 11) {
        m = 0;
        y++;
      }
    }
  }

  if (aDay > 0.02) {
    const start = Math.floor(viewStart / MS.day) * MS.day;
    for (let t = start; t <= viewEnd; t += MS.day) {
      const d = new Date(t);
      // Days read as major once hours are on stage.
      push(t, `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`, a6h > 0.5, aDay, lDay);
    }
  }

  if (a6h > 0.02) {
    const start = Math.floor(viewStart / MS.day) * MS.day;
    for (let t = start; t <= viewEnd; t += 6 * MS.hour) {
      push(t, `${pad(new Date(t).getUTCHours())}:00`, false, a6h, l6h);
    }
  }

  if (aHour > 0.02) {
    const start = Math.floor(viewStart / MS.hour) * MS.hour;
    for (let t = start; t <= viewEnd; t += MS.hour) {
      push(t, `${pad(new Date(t).getUTCHours())}:00`, false, aHour, lHour);
    }
  }

  return ticks;
}
