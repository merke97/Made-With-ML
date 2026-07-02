// "Tidsrummet" — the daylight design system. One grand object on warm paper.
// Every colour on screen must point at one of the six encodings (medium,
// amount, state, focus, selection, place); anything else was deleted.
//
// The two categorical hues (billedrørs-blue / lamp-amber) pass all four
// contrast + CVD checks against the light ground. Density is *pigment*: more
// broadcast time = deeper ink laid into the paper (pale → deep within a hue).

export const GROUND = 0xf3ede0; // mid paper (CSS paints the actual gradient)
export const INK = 0x2b2416; // warm near-black
export const INK_DIM = 0x77694f;
export const INK_FAINT = 0xa79877;
export const PAPER_TEXT = 0xf6f1e6; // text on solid pigment

export const TV = 0x2f74ad;
export const TV_DEEP = 0x1d4e79;
export const TV_PALE = 0xc9dceb;
export const RADIO = 0xac6f2f;
export const RADIO_DEEP = 0x7c4e1e;
export const RADIO_PALE = 0xe9d3b4;

export const DR_RED = 0xc8102e; // the only red: selection + play

/** Linear interpolation between two 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export interface MediumInk {
  base: number;
  deep: number;
  pale: number;
}

export function inkFor(mediaType?: string): MediumInk {
  return mediaType === "radio"
    ? { base: RADIO, deep: RADIO_DEEP, pale: RADIO_PALE }
    : { base: TV, deep: TV_DEEP, pale: TV_PALE };
}

/** Pigment for a density t in [0,1]: pale wash → deep ink. */
export function pigment(ink: MediumInk, t: number): number {
  return mixColor(ink.pale, ink.deep, 0.12 + 0.88 * t);
}
