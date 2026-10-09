import type { Scenario, Terrain } from "@cuas/sim";
import { useEffect, useRef } from "react";
import { MapRenderer, type MapModel } from "./mapDraw.ts";

interface Props {
  scenario: Scenario;
  terrain: Terrain;
  /** Called every animation frame; return what to draw. */
  getModel: () => MapModel;
  selected: string | null;
  onSelect?: (id: string | null) => void;
  showRanges?: boolean;
  highlightEffector?: string | null;
  fitMetres?: number;
}

/** Canvas tactical display with its own render loop (60 fps, independent of React state). */
export default function TacticalMap({ scenario, terrain, getModel, selected, onSelect, showRanges, highlightEffector, fitMetres }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const live = useRef({ getModel, selected, onSelect });
  live.current = { getModel, selected, onSelect };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const r = new MapRenderer(canvas, scenario, terrain);
    rendererRef.current = r;
    let raf = 0;
    const loop = () => {
      r.resize();
      r.draw(live.current.getModel(), live.current.selected);
      raf = requestAnimationFrame(loop);
    };
    r.resize();
    if (fitMetres) r.fit(fitMetres);
    raf = requestAnimationFrame(loop);

    let down: { x: number; y: number; moved: boolean } | null = null;
    const pos = (e: MouseEvent) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const onDown = (e: MouseEvent) => {
      down = { ...pos(e), moved: false };
    };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const p = pos(e);
      if (down.moved || Math.hypot(p.x - down.x, p.y - down.y) > 4) {
        r.pan(p.x - down.x, p.y - down.y);
        down = { ...p, moved: true };
      }
    };
    const onUp = (e: MouseEvent) => {
      if (down && !down.moved && live.current.onSelect) {
        const p = pos(e);
        live.current.onSelect(r.hitTrack(live.current.getModel(), p.x, p.y));
      }
      down = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = pos(e);
      r.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    canvas.addEventListener("mousedown", onDown);
    addEventListener("mousemove", onMove);
    addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousedown", onDown);
      removeEventListener("mousemove", onMove);
      removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [scenario, terrain, fitMetres]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.showRanges = !!showRanges;
      rendererRef.current.highlightEffector = highlightEffector ?? null;
    }
  }, [showRanges, highlightEffector]);

  return <canvas ref={canvasRef} aria-label="Tactical display" />;
}
