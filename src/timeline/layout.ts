import type { Channel, MediaType } from "../data/types";
import { TRACK_ARCHIVE, TRACK_RADIO, TRACK_TV } from "../data/aggregate";
import type { Camera } from "./camera";
import { lerp, type ZoomState } from "./zoom";

// The track layout engine. It owns the single most important spatial promise:
// channel lanes have permanent vertical positions and never reorder while you
// scroll through time. Aggregate bands (Archive, TV, Radio) are drawn in the
// same space and smoothly split into those fixed lanes as you zoom in.
//
// Channels are injected (synthetic set or the live archive's real channels), so
// the geometry is built into a TrackModel once per channel-set rather than at
// module load.

export const RULER_H = 36;
export const GUTTER_W = 138;
const CHANNEL_H = 44;
const GROUP_HEADER_H = 28;
const GROUP_GAP = 16;
const AGG_TOP_PAD = 26;
const AGG_BOTTOM_PAD = 26;
const BAND_GAP = 16;

interface VRect {
  y: number;
  h: number;
}
const blendRect = (a: VRect, b: VRect, t: number): VRect => ({
  y: lerp(a.y, b.y, t),
  h: lerp(a.h, b.h, t),
});

export interface TrackModel {
  tv: Channel[];
  radio: Channel[];
  /** Fixed world-space rect (top + height) of each channel lane. */
  worldRects: Map<string, VRect>;
  contentHeight: number;
  tvHeaderY: number;
  radioHeaderY: number;
}

/** Build the permanent lane geometry for a channel set. Stable by construction. */
export function buildTrackModel(channels: Channel[]): TrackModel {
  const sorted = [...channels].sort((a, b) => a.sortOrder - b.sortOrder);
  const tv = sorted.filter((c) => c.mediaType === "tv");
  const radio = sorted.filter((c) => c.mediaType === "radio");
  const worldRects = new Map<string, VRect>();

  let y = RULER_H + 6;
  const tvHeaderY = y;
  y += GROUP_HEADER_H;
  for (const c of tv) {
    worldRects.set(c.id, { y, h: CHANNEL_H });
    y += CHANNEL_H;
  }
  y += GROUP_GAP;
  const radioHeaderY = y;
  y += GROUP_HEADER_H;
  for (const c of radio) {
    worldRects.set(c.id, { y, h: CHANNEL_H });
    y += CHANNEL_H;
  }

  return { tv, radio, worldRects, contentHeight: y + 18, tvHeaderY, radioHeaderY };
}

export interface RenderTrack {
  kind: "archive" | "media" | "channel";
  trackId: string;
  channel?: Channel;
  mediaType?: MediaType;
  y: number;
  h: number;
  alpha: number;
  label: string;
  labelAlpha: number;
}

export interface GroupHeader {
  label: string;
  y: number;
  alpha: number;
}

export interface Layout {
  tracks: RenderTrack[];
  groupHeaders: GroupHeader[];
  contentHeight: number;
}

export function computeLayout(camera: Camera, z: ZoomState, model: TrackModel): Layout {
  const aggTop = RULER_H + AGG_TOP_PAD;
  const aggBottom = camera.viewportHeight - AGG_BOTTOM_PAD;
  const aggH = Math.max(40, aggBottom - aggTop);

  const archiveRect: VRect = { y: aggTop, h: aggH };

  const nTv = Math.max(1, model.tv.length);
  const nRadio = Math.max(1, model.radio.length);
  const usable = aggH - BAND_GAP;
  const tvH = usable * (nTv / (nTv + nRadio));
  const radioH = usable * (nRadio / (nTv + nRadio));
  const tvBand: VRect = { y: aggTop, h: tvH };
  const radioBand: VRect = { y: aggTop + tvH + BAND_GAP, h: radioH };

  // Content height grows as channels resolve, enabling vertical scroll.
  const contentHeight = lerp(camera.viewportHeight, model.contentHeight, z.pChannel);
  camera.contentHeight = contentHeight;
  const scroll = camera.scrollY;

  const tracks: RenderTrack[] = [];

  tracks.push({
    kind: "archive",
    trackId: TRACK_ARCHIVE,
    y: archiveRect.y,
    h: archiveRect.h,
    alpha: 1 - z.pMedia,
    label: "Arkiv",
    labelAlpha: 1 - z.pMedia,
  });

  const mediaDefs: { id: string; type: MediaType; label: string; band: VRect }[] = [
    { id: TRACK_TV, type: "tv", label: "Fjernsyn", band: tvBand },
    { id: TRACK_RADIO, type: "radio", label: "Radio", band: radioBand },
  ];
  for (const m of mediaDefs) {
    const r = blendRect(archiveRect, m.band, z.pMedia);
    tracks.push({
      kind: "media",
      trackId: m.id,
      mediaType: m.type,
      y: r.y,
      h: r.h,
      alpha: z.pMedia * (1 - z.pChannel),
      label: m.label,
      labelAlpha: z.pMedia * (1 - z.pChannel),
    });
  }

  const channelsOf = (chs: Channel[], band: VRect) => {
    for (const c of chs) {
      const world = model.worldRects.get(c.id);
      if (!world) continue;
      const target: VRect = { y: world.y - scroll, h: world.h };
      const r = blendRect(band, target, z.pChannel);
      tracks.push({
        kind: "channel",
        trackId: c.id,
        channel: c,
        mediaType: c.mediaType,
        y: r.y,
        h: r.h,
        alpha: z.pChannel,
        label: c.label,
        labelAlpha: z.pChannel,
      });
    }
  };
  channelsOf(model.tv, tvBand);
  channelsOf(model.radio, radioBand);

  const groupHeaders: GroupHeader[] = [
    { label: "FJERNSYN", y: model.tvHeaderY - scroll, alpha: z.pChannel },
    { label: "RADIO", y: model.radioHeaderY - scroll, alpha: z.pChannel },
  ];

  return { tracks, groupHeaders, contentHeight };
}
