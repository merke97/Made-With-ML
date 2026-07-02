import { RADIO_CHANNELS, TV_CHANNELS } from "../data/channels";
import type { Channel, MediaType } from "../data/types";
import { TRACK_ARCHIVE, TRACK_RADIO, TRACK_TV } from "../data/aggregate";
import type { Camera } from "./camera";
import { lerp, type ZoomState } from "./zoom";

// The track layout engine. It owns the single most important spatial promise:
// channel lanes have permanent vertical positions and never reorder while you
// scroll through time. Aggregate bands (Archive, TV, Radio) are drawn in the
// same space and smoothly split into those fixed lanes as you zoom in.

export const RULER_H = 36;
export const GUTTER_W = 138;
// Lanes stretch to fill the viewport (so resolving into channels never shrinks
// the world into a strip with dead space below), within sane bounds.
const CHANNEL_H_MIN = 44;
const CHANNEL_H_MAX = 112;
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

/** Fixed world-space y of each channel lane (top), measured from content top. */
function channelWorldRects(channelH: number): {
  byId: Map<string, VRect>;
  contentHeight: number;
  tvHeaderY: number;
  radioHeaderY: number;
} {
  const byId = new Map<string, VRect>();
  let y = RULER_H + 6;

  const tvHeaderY = y;
  y += GROUP_HEADER_H;
  for (const c of TV_CHANNELS) {
    byId.set(c.id, { y, h: channelH });
    y += channelH;
  }

  y += GROUP_GAP;
  const radioHeaderY = y;
  y += GROUP_HEADER_H;
  for (const c of RADIO_CHANNELS) {
    byId.set(c.id, { y, h: channelH });
    y += channelH;
  }

  return { byId, contentHeight: y + 18, tvHeaderY, radioHeaderY };
}

// Rebuilt only when the viewport height (and thus lane height) changes; lane
// positions stay permanent for any given viewport.
let worldCache = channelWorldRects(CHANNEL_H_MIN);
let worldCacheH = CHANNEL_H_MIN;

function laneHeightFor(viewportHeight: number): number {
  const nLanes = TV_CHANNELS.length + RADIO_CHANNELS.length;
  const fixedH = RULER_H + 6 + 2 * GROUP_HEADER_H + GROUP_GAP + 18;
  const h = Math.floor((viewportHeight - fixedH) / nLanes);
  return Math.min(CHANNEL_H_MAX, Math.max(CHANNEL_H_MIN, h));
}

export function computeLayout(camera: Camera, z: ZoomState): Layout {
  const channelH = laneHeightFor(camera.viewportHeight);
  if (channelH !== worldCacheH) {
    worldCache = channelWorldRects(channelH);
    worldCacheH = channelH;
  }
  const CHANNEL_WORLD = worldCache;
  const aggTop = RULER_H + AGG_TOP_PAD;
  const aggBottom = camera.viewportHeight - AGG_BOTTOM_PAD;
  const aggH = Math.max(40, aggBottom - aggTop);

  // Aggregate-regime rects (viewport space, unscrolled).
  const archiveRect: VRect = { y: aggTop, h: aggH };

  const nTv = TV_CHANNELS.length;
  const nRadio = RADIO_CHANNELS.length;
  const usable = aggH - BAND_GAP;
  const tvH = usable * (nTv / (nTv + nRadio));
  const radioH = usable * (nRadio / (nTv + nRadio));
  const tvBand: VRect = { y: aggTop, h: tvH };
  const radioBand: VRect = { y: aggTop + tvH + BAND_GAP, h: radioH };

  // Content height grows as channels resolve, enabling vertical scroll.
  const contentHeight = lerp(camera.viewportHeight, CHANNEL_WORLD.contentHeight, z.pChannel);
  camera.contentHeight = contentHeight;
  const scroll = camera.scrollY;

  const tracks: RenderTrack[] = [];

  // Archive band: present until TV/Radio take over.
  tracks.push({
    kind: "archive",
    trackId: TRACK_ARCHIVE,
    y: archiveRect.y,
    h: archiveRect.h,
    alpha: 1 - z.pMedia,
    label: "Arkiv",
    labelAlpha: 1 - z.pMedia,
  });

  // Media bands: emerge from the archive band, then hand off to channels.
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

  // Channel lanes: emerge from their media band into permanent, fixed rows.
  const channelsOf = (chs: Channel[], band: VRect) => {
    for (const c of chs) {
      const world = CHANNEL_WORLD.byId.get(c.id)!;
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
  channelsOf(TV_CHANNELS, tvBand);
  channelsOf(RADIO_CHANNELS, radioBand);

  const groupHeaders: GroupHeader[] = [
    { label: "FJERNSYN", y: CHANNEL_WORLD.tvHeaderY - scroll, alpha: z.pChannel },
    { label: "RADIO", y: CHANNEL_WORLD.radioHeaderY - scroll, alpha: z.pChannel },
  ];

  return { tracks, groupHeaders, contentHeight };
}
