import type { Channel } from "./types";

// The real shape of the DR archive: radio from 1925, television from the
// 1950s, channels launching (and closing) across a century. The base track
// structure stays boring and stable — Archive → Television/Radio → channels —
// and every lane keeps its permanent position even before launch and after
// closure. History is visible in the object, not written next to it.

export const ARCHIVE_START_MS = Date.UTC(1925, 3, 1); // Statsradiofonien, april 1925
export const ARCHIVE_END_MS = Date.UTC(2026, 0, 1);

const y = (year: number, month = 0, day = 1) => Date.UTC(year, month, day);

// sortOrder defines the permanent vertical position of every lane.
export const CHANNELS: Channel[] = [
  { id: "DR1", label: "DR1", mediaType: "tv", sortOrder: 0, activeFromMs: y(1954, 9, 2) },
  { id: "DR2", label: "DR2", mediaType: "tv", sortOrder: 1, activeFromMs: y(1996, 7, 30) },
  { id: "DR3", label: "DR3", mediaType: "tv", sortOrder: 2, activeFromMs: y(2013, 0, 28), activeToMs: y(2020, 0, 2) },
  { id: "DRK", label: "DR K", mediaType: "tv", sortOrder: 3, activeFromMs: y(2009, 10, 1), activeToMs: y(2020, 0, 2) },
  { id: "RAM", label: "DR Ramasjang", mediaType: "tv", sortOrder: 4, activeFromMs: y(2009, 10, 1) },
  { id: "ULT", label: "DR Ultra", mediaType: "tv", sortOrder: 5, activeFromMs: y(2013, 2, 4), activeToMs: y(2020, 0, 2) },
  { id: "P1", label: "P1", mediaType: "radio", sortOrder: 6, activeFromMs: y(1925, 3, 1) },
  { id: "P2", label: "P2", mediaType: "radio", sortOrder: 7, activeFromMs: y(1937, 9, 1) },
  { id: "P3", label: "P3", mediaType: "radio", sortOrder: 8, activeFromMs: y(1963, 0, 1) },
  { id: "P4", label: "P4 København", mediaType: "radio", sortOrder: 9, activeFromMs: y(1960, 3, 1) },
  { id: "P6B", label: "P6 Beat", mediaType: "radio", sortOrder: 10, activeFromMs: y(2011, 10, 1) },
  { id: "P8J", label: "P8 Jazz", mediaType: "radio", sortOrder: 11, activeFromMs: y(2011, 10, 1) },
];

export const CHANNELS_BY_ID: Map<string, Channel> = new Map(CHANNELS.map((c) => [c.id, c]));

export const TV_CHANNELS = CHANNELS.filter((c) => c.mediaType === "tv");
export const RADIO_CHANNELS = CHANNELS.filter((c) => c.mediaType === "radio");
