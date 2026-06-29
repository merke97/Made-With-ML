import { MS } from "./zoom";

// Adaptive time-ruler ticks. The granularity (hour → year) follows the zoom so
// there are always a handful of legible labels, never a crowded axis.

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const pad = (n: number) => (n < 10 ? "0" + n : "" + n);

export interface Tick {
  ms: number;
  label: string;
  major: boolean;
}

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
  const pxPerDay = MS.day / msPerPixel;
  const pxPerMonth = (30 * MS.day) / msPerPixel;

  const pushFixed = (step: number, fmt: (ms: number) => string, majorStep?: number) => {
    const start = Math.floor(viewStart / step) * step;
    for (let t = start; t <= viewEnd; t += step) {
      ticks.push({ ms: t, label: fmt(t), major: majorStep ? t % majorStep === 0 : true });
    }
  };

  if (pxPerDay > 1400) {
    pushFixed(MS.hour, (t) => `${pad(new Date(t).getUTCHours())}:00`, MS.day);
  } else if (pxPerDay > 240) {
    pushFixed(6 * MS.hour, (t) => `${pad(new Date(t).getUTCHours())}:00`, MS.day);
  } else if (pxPerDay > 36) {
    pushFixed(MS.day, (t) => `${new Date(t).getUTCDate()}. ${MONTHS[new Date(t).getUTCMonth()]}`);
  } else if (pxPerMonth > 70) {
    // Month ticks (walk the calendar — months aren't fixed length).
    const d = new Date(viewStart);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    for (;;) {
      const t = Date.UTC(y, m, 1);
      if (t > viewEnd) break;
      ticks.push({ ms: t, label: `${MONTHS[m]} ${y}`, major: m === 0 });
      if (++m > 11) {
        m = 0;
        y++;
      }
    }
  } else {
    // Year ticks.
    const startYear = new Date(viewStart).getUTCFullYear();
    const endYear = new Date(viewEnd).getUTCFullYear();
    for (let y = startYear; y <= endYear + 1; y++) {
      ticks.push({ ms: Date.UTC(y, 0, 1), label: `${y}`, major: true });
    }
  }
  return ticks;
}
