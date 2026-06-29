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
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const localPos = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = e.clientX;
        lastY = e.clientY;
        store.camera.panByPixels(dx);
        store.camera.scrollByPixels(-dy);
        canvas.style.cursor = "grabbing";
      } else {
        const { x, y } = localPos(e);
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
      if (dragging && moved < 5 && r) {
        const { x, y } = localPos(e);
        const hit = r.programmeAt(x, y);
        store.select(hit);
      }
      dragging = false;
      canvas.style.cursor = "grab";
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x } = localPos(e);
      if (e.shiftKey) {
        store.camera.panByPixels(-(e.deltaY + e.deltaX));
      } else {
        const factor = Math.exp(e.deltaY * 0.0012);
        store.camera.zoomAt(x, factor);
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = "grab";

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
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
