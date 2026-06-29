import { useEffect, useRef } from "react";
import type { AggregateIndex } from "../data/aggregate";
import type { ArchiveData } from "../data/generate";
import { TimelineRenderer } from "../timeline/renderer";
import type { Store } from "../timeline/store";

interface Props {
  store: Store;
  data: ArchiveData;
  agg: AggregateIndex;
  onReady: (renderer: TimelineRenderer) => void;
}

// Mounts the PixiJS canvas and translates pointer/wheel input into camera
// moves. The model is map-like: drag pans both axes, wheel zooms under the
// cursor (keeping the time under the cursor pinned).
export function TimelineView({ store, data, agg, onReady }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const renderer = new TimelineRenderer(data, agg, store);
    let disposed = false;

    const rect = wrap.getBoundingClientRect();
    renderer
      .init(canvas, Math.max(320, rect.width), Math.max(240, rect.height))
      .then(() => {
        if (disposed) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        onReady(renderer);
      });

    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      rendererRef.current?.resize(Math.max(320, r.width), Math.max(240, r.height));
    });
    ro.observe(wrap);

    return () => {
      disposed = true;
      ro.disconnect();
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── pointer + wheel handlers ────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!;

    // Active pointers (touch + mouse) by id. One pointer pans; two pinch-zoom.
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinchDist = 0; // previous two-finger distance
    let lastTapTime = 0;

    const rectOf = () => canvas.getBoundingClientRect();
    const local = (clientX: number, clientY: number) => {
      const r = rectOf();
      return { x: clientX - r.left, y: clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      if (pointers.size === 2) pinchDist = currentPinchDist();
      canvas.setPointerCapture(e.pointerId);
    };

    const currentPinchDist = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const pinchMid = () => {
      const [a, b] = [...pointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    const onMove = (e: PointerEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      const prev = pointers.get(e.pointerId);

      if (pointers.size >= 2 && prev) {
        // Pinch: zoom about the midpoint, and pan with the midpoint drift.
        const beforeMid = pinchMid();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const afterMid = pinchMid();
        const dist = currentPinchDist();
        if (pinchDist > 0 && dist > 0) {
          const anchorX = local(afterMid.x, afterMid.y).x;
          store.camera.zoomAt(anchorX, pinchDist / dist);
          store.camera.panByPixels(afterMid.x - beforeMid.x);
          store.camera.scrollByPixels(-(afterMid.y - beforeMid.y));
        }
        pinchDist = dist;
        moved += 99;
        return;
      }

      if (prev && (e.buttons || e.pointerType === "touch")) {
        // Single-pointer drag = pan both axes.
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        moved += Math.abs(dx) + Math.abs(dy);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        store.camera.panByPixels(dx);
        store.camera.scrollByPixels(-dy);
        canvas.style.cursor = "grabbing";
      } else {
        const { x, y } = local(e.clientX, e.clientY);
        const hit = r.programmeAt(x, y);
        r.setHovered(hit);
        canvas.style.cursor = hit ? "pointer" : "grab";
      }
    };

    const onUp = (e: PointerEvent) => {
      const r = rendererRef.current;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const wasSingle = pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;

      if (wasSingle && moved < 6 && r) {
        const { x, y } = local(e.clientX, e.clientY);
        // Double-tap zooms in (the only "zoom" gesture besides pinch on touch).
        const now = e.timeStamp;
        if (now - lastTapTime < 300) {
          store.camera.zoomAt(x, 0.45);
          lastTapTime = 0;
        } else {
          store.select(r.programmeAt(x, y));
          lastTapTime = now;
        }
      }
      canvas.style.cursor = "grab";
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x } = local(e.clientX, e.clientY);
      if (e.shiftKey) {
        store.camera.panByPixels(-(e.deltaY + e.deltaX));
      } else {
        store.camera.zoomAt(x, Math.exp(e.deltaY * 0.0012));
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = "grab";

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="timeline-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
