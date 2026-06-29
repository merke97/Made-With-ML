import type { Channel } from "./types";

// The base track structure is intentionally boring and stable: Archive →
// Television/Radio → individual channels. No invented intermediate groups —
// those belong in overlays/filters, not the spatial geography.

export const ARCHIVE_START_MS = Date.UTC(2019, 0, 1); // 2019-01-01
export const ARCHIVE_END_MS = Date.UTC(2024, 0, 1); // 2024-01-01

const y = (year: number, month = 0, day = 1) => Date.UTC(year, month, day);

// sortOrder defines the permanent vertical position of every lane. Some
// channels launch part-way through the span; their lane exists earlier but
// shows as inactive (the "empty vs not-yet-launched" distinction).
export const CHANNELS: Channel[] = [
  { id: "DR1", label: "DR1", mediaType: "tv", sortOrder: 0, activeFromMs: ARCHIVE_START_MS },
  { id: "DR2", label: "DR2", mediaType: "tv", sortOrder: 1, activeFromMs: ARCHIVE_START_MS },
  { id: "DRK", label: "DR K", mediaType: "tv", sortOrder: 2, activeFromMs: ARCHIVE_START_MS },
  { id: "RAM", label: "DR Ramasjang", mediaType: "tv", sortOrder: 3, activeFromMs: ARCHIVE_START_MS },
  { id: "ULT", label: "DR Ultra", mediaType: "tv", sortOrder: 4, activeFromMs: y(2020, 7, 1) }, // launches mid-span
  { id: "P1", label: "P1", mediaType: "radio", sortOrder: 5, activeFromMs: ARCHIVE_START_MS },
  { id: "P2", label: "P2", mediaType: "radio", sortOrder: 6, activeFromMs: ARCHIVE_START_MS },
  { id: "P3", label: "P3", mediaType: "radio", sortOrder: 7, activeFromMs: ARCHIVE_START_MS },
  { id: "P4", label: "P4 København", mediaType: "radio", sortOrder: 8, activeFromMs: ARCHIVE_START_MS },
  { id: "P6", label: "P6 Beat", mediaType: "radio", sortOrder: 9, activeFromMs: y(2021, 2, 1) }, // launches mid-span
];

export const CHANNELS_BY_ID: Map<string, Channel> = new Map(CHANNELS.map((c) => [c.id, c]));

export const TV_CHANNELS = CHANNELS.filter((c) => c.mediaType === "tv");
export const RADIO_CHANNELS = CHANNELS.filter((c) => c.mediaType === "radio");
