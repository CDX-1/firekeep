"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./world-map.module.css";
import { AREAS, type Area } from "./drones";
import { getWorld, worldMapUrl } from "@/lib/api";
import type { WorldMeta } from "@/lib/types";
import { fallbackWorld } from "./fallback-world";
import { areaOf } from "@/lib/cameras";
import { LiveLayer } from "./live-layer";
import { DIMENSION, getLive, liveMapUrl, sendDroneTo, streamUrl,
         type LiveDelta, type LiveDrone, type LiveSnapshot } from "@/lib/live";

/**
 * How fast a marker catches up with the position the mod last reported, per second.
 *
 * Nothing here simulates flight: the mod owns where a drone is, and the feed lands about
 * five times a second. Drawing those samples raw would step visibly at 60fps, so markers
 * ease towards the newest one. It smooths the way to a real position, never invents one.
 */
const SMOOTHING = 14;

const MIN_SCALE = 0.12;   // screen pixels per block
const MAX_SCALE = 12;
const HIT_RADIUS = 15;    // screen pixels around a marker that count as a grab
const DRAG_SLOP = 5;      // below this, a drag is really just a click

const AREA_COLOR: Record<Area, string> = {
  Northeast: "#d0a06a",
  Northwest: "#8fb8ae",
  Southwest: "#b78ec9",
  Southeast: "#6fa8d0",
};

type Vec = { x: number; z: number };

/** A live drone as it is drawn: the mod's own numbers, eased between feed samples. */
type Marker = {
  id: string;
  /** the quadrant it is actually over, so the rail groups by where drones really are */
  area: Area;
  x: number;
  z: number;
  /** radians, already turned from the mod's degrees into screen space */
  yaw: number;
  target: Vec | null;
};

type View = { x: number; y: number; scale: number };

type Drag =
  | { kind: "pan"; pointer: number; fromX: number; fromY: number; viewX: number; viewY: number; moved: number }
  | { kind: "aim"; pointer: number; drone: string; fromX: number; fromY: number; toX: number; toY: number; moved: number };

/** What we are drawing under the drones: either the real save, or a stand-in. */
type Backdrop = { meta: WorldMeta; image: CanvasImageSource; real: boolean };

export default function WorldMap({ active }: { active: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const markersRef = useRef<Marker[]>([]);
  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<string | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const fittedRef = useRef(false);
  const layerRef = useRef<LiveLayer | null>(null);
  const sessionRef = useRef<string>("");
  const liveRef = useRef<LiveDrone[]>([]);

  const [feed, setFeed] = useState<LiveSnapshot | null>(null);
  const [liveDrones, setLiveDrones] = useState<LiveDrone[]>([]);
  const [backdrop, setBackdrop] = useState<Backdrop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Vec | null>(null);
  const [zoom, setZoom] = useState(1);
  const [, setPulse] = useState(0);          // nudges the side rail to re-read the sim

  // ---------------------------------------------------------------- the world

  const load = useCallback(async (refresh = false) => {
    setError(null);
    try {
      const meta = await getWorld();
      const image = await loadImage(worldMapUrl() + (refresh ? `&refresh=1&t=${Date.now()}` : ""));
      setBackdrop({ meta, image, real: true });
    } catch (cause) {
      // No server, or no save yet: draw a stand-in so the tab still works.
      setError(cause instanceof Error ? cause.message : String(cause));
      setBackdrop(fallbackWorld());
    }
    fittedRef.current = false;
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Everything the mod knows, kept current.
   *
   * The stream only carries changes, so a dashboard opening mid-session first pulls the
   * snapshot image the server keeps for exactly this reason, then patches it from there.
   * A new session id means the world was restarted and the overlay is about somewhere else.
   */
  const seed = useCallback(async (snapshot: LiveSnapshot) => {
    const layer = layerRef.current ?? (layerRef.current = new LiveLayer());
    sessionRef.current = snapshot.session;
    if (!snapshot.width || !snapshot.height) {
      layer.reset({ origin_x: snapshot.origin_x, origin_z: snapshot.origin_z, width: 0, height: 0 });
      return;
    }
    try {
      layer.adopt(await loadImage(liveMapUrl(snapshot.dimension)), snapshot);
    } catch {
      layer.reset(snapshot);           // nothing live yet; the stream will fill it in
    }
    layer.seedHot(snapshot.fires ?? []);
  }, []);

  useEffect(() => {
    let closed = false;
    const source = new EventSource(streamUrl(DIMENSION));

    const onSnapshot = (event: MessageEvent) => {
      const snapshot = JSON.parse(event.data) as LiveSnapshot;
      setFeed(snapshot);
      setLiveDrones(snapshot.drones);
      if (!closed && snapshot.session !== sessionRef.current) void seed(snapshot);
    };

    source.addEventListener("hello", onSnapshot);
    source.addEventListener("status", onSnapshot);
    source.addEventListener("delta", (event) => {
      const delta = JSON.parse((event as MessageEvent).data) as LiveDelta;
      if (delta.session !== sessionRef.current) {
        // the world restarted under us; take the snapshot again rather than mixing them
        void getLive(delta.dimension).then((snapshot) => {
          setFeed(snapshot);
          return seed(snapshot);
        }).catch(() => undefined);
        return;
      }
      layerRef.current?.apply(delta.columns);
      setLiveDrones(delta.drones);
      setFeed((current) => (current ? { ...current, hot: delta.hot, tick: delta.tick, age: 0, live: true } : current));
    });

    // EventSource retries on its own; surface the gap rather than fighting it
    source.onerror = () => setFeed((current) => (current ? { ...current, live: false } : current));

    return () => { closed = true; source.close(); };
  }, [seed]);

  useEffect(() => { liveRef.current = liveDrones; }, [liveDrones]);

  // The feed goes quiet the moment Minecraft closes; age it out so the badge tells the truth.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setFeed((current) => {
        if (!current || current.age === null) return current;
        const age = current.age + 1;
        return { ...current, age, live: age < 6 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // ---------------------------------------------------------------- viewport

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !backdrop) return;
    const { clientWidth: w, clientHeight: h } = stage;
    if (!w || !h) return;

    const { width, height } = backdrop.meta;
    const scale = clamp(Math.min(w / width, h / height) * 0.94, MIN_SCALE, MAX_SCALE);
    viewRef.current = {
      scale,
      x: (w - width * scale) / 2,
      y: (h - height * scale) / 2,
    };
    setZoom(scale);
    fittedRef.current = true;
  }, [backdrop]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      if (!fittedRef.current && stage.clientWidth > 0) fit();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    if (active && !fittedRef.current) fit();
  }, [active, backdrop, fit]);

  const zoomBy = useCallback((factor: number, anchorX?: number, anchorY?: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const view = viewRef.current;
    const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === view.scale) return;

    const ax = anchorX ?? stage.clientWidth / 2;
    const ay = anchorY ?? stage.clientHeight / 2;
    // keep whatever is under the anchor pinned there
    viewRef.current = {
      scale: next,
      x: ax - (ax - view.x) * (next / view.scale),
      y: ay - (ay - view.y) * (next / view.scale),
    };
    setZoom(next);
  }, []);

  // ---------------------------------------------------------------- the loop

  useEffect(() => {
    if (!active || !backdrop) return;
    let frame = 0;
    let last = performance.now();
    let sinceRail = 0;

    const step = (time: number) => {
      const dt = Math.min(0.1, (time - last) / 1000);
      last = time;

      syncMarkers(markersRef.current, liveRef.current, dt);
      layerRef.current?.flush();
      draw(canvasRef.current, backdrop, viewRef.current, markersRef.current, {
        selected,
        hovered: hoverRef.current,
        drag: dragRef.current,
        layer: layerRef.current,
        time,
      });

      sinceRail += dt;
      if (sinceRail > 0.12) {
        sinceRail = 0;
        setPulse((n) => n + 1);
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, backdrop, selected]);

  // ---------------------------------------------------------------- pointers

  const toWorld = useCallback((sx: number, sy: number): Vec => {
    const { x, y, scale } = viewRef.current;
    const meta = backdrop?.meta;
    return {
      x: (sx - x) / scale + (meta?.origin_x ?? 0),
      z: (sy - y) / scale + (meta?.origin_z ?? 0),
    };
  }, [backdrop]);

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const pick = useCallback((sx: number, sy: number) => {
    const view = viewRef.current;
    const meta = backdrop?.meta;
    if (!meta) return null;
    let best: { name: string; distance: number } | null = null;
    const consider = (name: string, worldX: number, worldZ: number) => {
      const dx = (worldX - meta.origin_x) * view.scale + view.x - sx;
      const dy = (worldZ - meta.origin_z) * view.scale + view.y - sy;
      const distance = Math.hypot(dx, dy);
      if (distance <= HIT_RADIUS && (!best || distance < best.distance)) {
        best = { name, distance };
      }
    };

    // pick against the drawn positions, so a click lands on what is under the cursor
    for (const marker of markersRef.current) consider(marker.id, marker.x, marker.z);
    return best === null ? null : (best as { name: string }).name;
  }, [backdrop]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { x, y } = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);

    const hit = pick(x, y);
    if (hit) {
      setSelected(hit);
      dragRef.current = { kind: "aim", pointer: event.pointerId, drone: hit, fromX: x, fromY: y, toX: x, toY: y, moved: 0 };
      return;
    }

    const view = viewRef.current;
    dragRef.current = { kind: "pan", pointer: event.pointerId, fromX: x, fromY: y, viewX: view.x, viewY: view.y, moved: 0 };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(event);
    cursorRef.current = { x, y };
    setCursor(toWorld(x, y));

    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) {
      hoverRef.current = pick(x, y);
      return;
    }

    drag.moved = Math.max(drag.moved, Math.hypot(x - drag.fromX, y - drag.fromY));
    if (drag.kind === "pan") {
      viewRef.current = { ...viewRef.current, x: drag.viewX + (x - drag.fromX), y: drag.viewY + (y - drag.fromY) };
    } else {
      drag.toX = x;
      drag.toY = y;
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // A short drag out of a drone was a click; a real one is a flight order.
    if (drag.kind !== "aim" || drag.moved <= DRAG_SLOP) return;
    const target = toWorld(drag.toX, drag.toY);

    const drone = liveRef.current.find((d) => d.id === drag.drone);
    if (!drone) return;

    // The drone belongs to the mod: post the order and let the feed show the result. Its
    // altitude is kept - the map is top-down and has nothing to say about y.
    setOrderError(null);
    void sendDroneTo(drone.id, target.x, drone.y, target.z)
      .catch((cause) => setOrderError(cause instanceof Error ? cause.message : String(cause)));
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    zoomBy(Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dragRef.current = null;
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // ---------------------------------------------------------------- commands

  const centerOnPoint = useCallback((worldX: number, worldZ: number) => {
    const stage = stageRef.current;
    const meta = backdrop?.meta;
    if (!stage || !meta) return;
    const { scale } = viewRef.current;
    viewRef.current = {
      scale,
      x: stage.clientWidth / 2 - (worldX - meta.origin_x) * scale,
      y: stage.clientHeight / 2 - (worldZ - meta.origin_z) * scale,
    };
  }, [backdrop]);

  /** Holding is an order to where it already is; the mod clears the target on arrival. */
  const holdSelected = useCallback(() => {
    const drone = liveRef.current.find((d) => d.id === selected);
    if (!drone) return;
    setOrderError(null);
    void sendDroneTo(drone.id, drone.x, drone.y, drone.z)
      .catch((cause) => setOrderError(cause instanceof Error ? cause.message : String(cause)));
  }, [selected]);

  const flying = liveDrones.filter((drone) => drone.target !== null).length;
  const selectedLive = liveDrones.find((drone) => drone.id === selected) ?? null;
  const meta = backdrop?.meta;

  const bounds = useMemo(() => {
    if (!meta) return null;
    return {
      x: [meta.origin_x, meta.origin_x + meta.width - 1] as const,
      z: [meta.origin_z, meta.origin_z + meta.height - 1] as const,
    };
  }, [meta]);

  return (
    <div className={styles.map}>
      <div className={styles.stage} ref={stageRef}>
        <canvas
          className={styles.canvas}
          ref={canvasRef}
          data-dragging={dragRef.current?.kind ?? "none"}
          aria-label="Top-down map of the Minecraft world with drone positions"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => { cursorRef.current = null; hoverRef.current = null; setCursor(null); }}
          onWheel={onWheel}
        />

        <div className={styles.hint} aria-hidden="true">
          Drag an arrow out of a drone to send it there &middot; drag the map to pan &middot; scroll to zoom
          {feed?.live && " · the mod is streaming changes as they happen"}
        </div>

        <div className={styles.zoomControls}>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>&minus;</button>
          <button type="button" className={styles.wide} onClick={fit}>Fit</button>
        </div>

        <footer className={styles.status}>
          <span className={styles.world} data-real={backdrop?.real ?? false}>
            {backdrop ? backdrop.meta.name : "loading world"}
          </span>
          {meta && <span>{meta.width}&times;{meta.height} blocks &middot; {meta.chunks} chunks</span>}
          {bounds && <span>X {bounds.x[0]} to {bounds.x[1]} &middot; Z {bounds.z[0]} to {bounds.z[1]}</span>}
          <span className={styles.feedState} data-live={feed?.live ?? false}>
            {feed?.live
              ? `live · tick ${feed.tick}`
              : feed?.age == null ? "no mod feed" : `stale ${Math.round(feed.age)}s`}
          </span>
          {(feed?.hot ?? 0) > 0 && (
            <span className={styles.fires}>{feed?.hot} burning</span>
          )}
          <span className={styles.spacer} />
          <span>{cursor ? `X ${Math.floor(cursor.x)}  Z ${Math.floor(cursor.z)}` : "—"}</span>
          <span>{zoom >= 1 ? `${zoom.toFixed(1)}×` : `1/${(1 / zoom).toFixed(1)}×`}</span>
          <button type="button" onClick={() => void load(true)}>Reload</button>
        </footer>

        {!backdrop && <p className={styles.loading}>Reading the world off disk&hellip;</p>}
        {error && backdrop && !backdrop.real && (
          <p className={styles.notice}>
            Showing a stand-in world, not the one the drones are in &mdash; {error}. Either
            <code>python3 server.py</code> is not running, or it found no world to read: it
            looks for the server&rsquo;s own world under <code>fabric/run</code>, then
            <code>fabric/run/saves</code>. Point it with <code>--save</code> or
            <code>FIREKEEP_SAVE</code>, then hit Reload.
          </p>
        )}
      </div>

      <aside className={styles.rail} aria-label="Drones on the map">
        <header>
          <span>Drones</span>
          <span>{flying ? `${flying} in transit` : "all holding"}</span>
        </header>
        {liveDrones.length === 0 && (
          <p className={styles.empty}>
            {feed?.live
              ? "No drones in the world yet. Spawn one with /drone spawn."
              : "Waiting for the mod\u2019s world feed."}
          </p>
        )}
        <ul>
          {AREAS.map((area) => {
            // grouped by the quadrant each drone is actually over, so this follows them
            const inArea = liveDrones.filter((drone) => areaOf(drone) === area);
            if (inArea.length === 0) return null;
            return (
              <li key={area}>
                <p className={styles.areaLabel}><i style={{ background: AREA_COLOR[area] }} />{area}</p>
                <ul>
                  {inArea.map((drone) => (
                    <li key={drone.id}>
                      <button
                        type="button"
                        data-active={selected === drone.id}
                        onClick={() => { setSelected(drone.id); centerOnPoint(drone.x, drone.z); }}
                      >
                        <span>{drone.id}</span>
                        <span className={styles.coords}>
                          {Math.round(drone.x)}, {Math.round(drone.z)}
                        </span>
                        {drone.target && <span className={styles.transit} aria-label="in transit" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
        <footer>
          {selectedLive ? (
            <>
              <p>{selectedLive.id}</p>
              <p className={styles.coords}>
                {selectedLive.target
                  ? `flying to ${Math.round(selectedLive.target[0])}, ${Math.round(selectedLive.target[2])}`
                  : `holding at y ${Math.round(selectedLive.y)}`}
              </p>
              <button type="button" onClick={holdSelected} disabled={!selectedLive.target}>Hold</button>
              {orderError
                ? <p className={styles.orderError}>Order failed: {orderError}</p>
                : <p className={styles.coords}>Drag it on the map to send it somewhere.</p>}
            </>
          ) : (
            <p className={styles.coords}>Pick a drone, or drag one on the map.</p>
          )}
        </footer>
      </aside>
    </div>
  );
}

// --------------------------------------------------------------------------
// markers

/**
 * Brings the drawn markers in line with what the mod last reported.
 *
 * A drone that has just appeared is placed exactly where the feed says; one already on the
 * map eases towards its new position, because the feed lands about five times a second and
 * the canvas redraws sixty. Drones that left the world drop off the map with it.
 *
 * The array is updated in place: the render loop holds it in a ref across frames.
 */
function syncMarkers(markers: Marker[], live: LiveDrone[], dt: number) {
  const chase = 1 - Math.exp(-SMOOTHING * dt);
  const existing = new Map(markers.map((marker) => [marker.id, marker]));
  const next: Marker[] = [];

  for (const drone of live) {
    const area = areaOf(drone);
    // the mod reports degrees, with 0 facing south; the marker is drawn nose-up
    const yaw = (drone.yaw - 90) * Math.PI / 180;
    const target = drone.target ? { x: drone.target[0], z: drone.target[2] } : null;

    const marker = existing.get(drone.id);
    if (!marker) {
      next.push({ id: drone.id, area, x: drone.x, z: drone.z, yaw, target });
      continue;
    }

    marker.area = area;
    marker.target = target;
    marker.x += (drone.x - marker.x) * chase;
    marker.z += (drone.z - marker.z) * chase;
    // turn the short way round, so passing due north does not spin the marker
    marker.yaw += Math.atan2(Math.sin(yaw - marker.yaw), Math.cos(yaw - marker.yaw)) * chase;
    next.push(marker);
  }

  markers.length = 0;
  markers.push(...next);
}

// --------------------------------------------------------------------------
// rendering

type Overlay = {
  selected: string | null;
  hovered: string | null;
  drag: Drag | null;
  layer: LiveLayer | null;
  time: number;
};

function draw(canvas: HTMLCanvasElement | null, backdrop: Backdrop, view: View, markers: Marker[], overlay: Overlay) {
  if (!canvas) return;
  const stage = canvas.parentElement;
  if (!stage) return;

  const dpr = window.devicePixelRatio || 1;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const { meta } = backdrop;
  const toScreenX = (bx: number) => (bx - meta.origin_x) * view.scale + view.x;
  const toScreenY = (bz: number) => (bz - meta.origin_z) * view.scale + view.y;

  // the map itself: nearest-neighbour once a block is bigger than a pixel
  ctx.imageSmoothingEnabled = view.scale < 1;
  ctx.drawImage(backdrop.image, view.x, view.y, meta.width * view.scale, meta.height * view.scale);

  // whatever the mod has told us since the last save goes straight on top
  const layer = overlay.layer;
  if (layer?.ready) {
    ctx.drawImage(layer.surface, toScreenX(layer.originX), toScreenY(layer.originZ),
      layer.width * view.scale, layer.height * view.scale);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, meta.width * view.scale, meta.height * view.scale);
  ctx.clip();
  drawGrid(ctx, meta, view, width, height);
  ctx.restore();

  if (layer?.ready && layer.hot > 0) {
    drawFire(ctx, layer, view, toScreenX(layer.originX), toScreenY(layer.originZ), overlay.time);
  }

  // drag arrow first, so markers sit on top of it
  const aim = overlay.drag?.kind === "aim" ? overlay.drag : null;
  if (aim && aim.moved > DRAG_SLOP) {
    const marker = markers.find((m) => m.id === aim.drone);
    if (marker) {
      const blocks = Math.hypot(aim.toX - toScreenX(marker.x), aim.toY - toScreenY(marker.z)) / view.scale;
      drawArrow(ctx, toScreenX(marker.x), toScreenY(marker.z), aim.toX, aim.toY, AREA_COLOR[marker.area], blocks);
    }
  }

  for (const marker of markers) {
    const x = toScreenX(marker.x);
    const y = toScreenY(marker.z);
    if (x < -60 || y < -60 || x > width + 60 || y > height + 60) continue;

    const color = AREA_COLOR[marker.area];
    if (marker.target) {
      drawRoute(ctx, x, y, toScreenX(marker.target.x), toScreenY(marker.target.z), color);
    }
    drawDrone(ctx, x, y, { name: marker.id, yaw: marker.yaw }, color, {
      selected: overlay.selected === marker.id,
      hovered: overlay.hovered === marker.id,
      labelled: true,
    });
  }
}

/**
 * The glow over burning columns.
 *
 * The heat buffer is one white dot per fire, so blurring it additively costs the same
 * whether three blocks are alight or three thousand - which matters, because a fire that
 * has got away from you is exactly when the map needs to stay smooth.
 */
function drawFire(ctx: CanvasRenderingContext2D, layer: LiveLayer, view: View,
                  x: number, y: number, time: number) {
  const w = layer.width * view.scale;
  const h = layer.height * view.scale;
  const pulse = 0.42 + 0.18 * Math.sin(time / 320);
  const blur = Math.max(2, Math.min(18, view.scale * 2.6));

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.imageSmoothingEnabled = true;

  ctx.globalAlpha = pulse * 0.55;
  ctx.filter = `blur(${blur.toFixed(1)}px)`;
  ctx.drawImage(layer.heat, x, y, w, h);

  // a tighter, hotter core inside the halo
  ctx.globalAlpha = pulse;
  ctx.filter = `blur(${(blur / 3).toFixed(1)}px)`;
  ctx.drawImage(layer.heat, x, y, w, h);
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, meta: WorldMeta, view: View, width: number, height: number) {
  const lines = (step: number, style: string) => {
    const spacing = step * view.scale;
    if (spacing < 26) return;
    ctx.strokeStyle = style;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const firstX = Math.ceil(meta.origin_x / step) * step;
    for (let bx = firstX; bx <= meta.origin_x + meta.width; bx += step) {
      const x = Math.round((bx - meta.origin_x) * view.scale + view.x) + 0.5;
      if (x < 0 || x > width) continue;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    const firstZ = Math.ceil(meta.origin_z / step) * step;
    for (let bz = firstZ; bz <= meta.origin_z + meta.height; bz += step) {
      const y = Math.round((bz - meta.origin_z) * view.scale + view.y) + 0.5;
      if (y < 0 || y > height) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  };

  lines(16, "rgba(0, 0, 0, .13)");        // chunks
  lines(512, "rgba(255, 255, 255, .16)"); // regions
}

function drawDrone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  drone: { name: string; yaw: number },
  color: string,
  state: { selected: boolean; hovered: boolean; labelled: boolean },
) {
  const radius = state.selected ? 8 : 7;

  ctx.save();
  ctx.translate(x, y);

  if (state.selected || state.hovered) {
    ctx.beginPath();
    ctx.arc(0, 0, radius + 7, 0, Math.PI * 2);
    ctx.strokeStyle = state.selected ? color : "rgba(255, 255, 255, .35)";
    ctx.lineWidth = state.selected ? 1.6 : 1;
    ctx.stroke();
  }

  ctx.rotate(drone.yaw + Math.PI / 2);

  // four rotors on stubby arms, seen from directly above
  ctx.strokeStyle = "rgba(8, 10, 9, .75)";
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    ctx.moveTo(0, 0);
    ctx.lineTo(ax * radius, ay * radius);
  }
  ctx.stroke();

  ctx.fillStyle = color;
  for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    ctx.beginPath();
    ctx.arc(ax * radius, ay * radius, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(0, 0, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = "#0d0f0e";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // nose, so the heading reads at a glance
  ctx.beginPath();
  ctx.moveTo(0, -radius - 4.5);
  ctx.lineTo(-2.6, -radius - 0.8);
  ctx.lineTo(2.6, -radius - 0.8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.restore();

  if (state.labelled) {
    label(ctx, drone.name, x, y + radius + 6);
  }
}

/** The dashed line a drone is currently following, with a crosshair on the target. */
function drawRoute(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(6, 8, 7, .5)";
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  const crosshair = () => {
    ctx.beginPath();
    ctx.arc(x1, y1, 4.5, 0, Math.PI * 2);
    ctx.moveTo(x1 - 7.5, y1);
    ctx.lineTo(x1 + 7.5, y1);
    ctx.moveTo(x1, y1 - 7.5);
    ctx.lineTo(x1, y1 + 7.5);
    ctx.stroke();
  };

  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = "rgba(6, 8, 7, .5)";
  crosshair();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  crosshair();
  ctx.restore();
}

/** The arrow you pull out of a drone while aiming it. */
function drawArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, blocks: number) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const length = Math.hypot(x1 - x0, y1 - y0);
  const head = Math.min(14, length * 0.4);

  const shaft = () => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - Math.cos(angle) * head * 0.8, y1 - Math.sin(angle) * head * 0.8);
    ctx.stroke();
  };

  const point = () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-head, -head * 0.46);
    ctx.lineTo(-head * 0.66, 0);
    ctx.lineTo(-head, head * 0.46);
    ctx.closePath();
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // dark underlay, so the arrow reads over pale sand as well as dark forest
  ctx.strokeStyle = "rgba(6, 8, 7, .6)";
  ctx.lineWidth = 5.5;
  shaft();
  ctx.save();
  ctx.translate(x1, y1);
  ctx.rotate(angle);
  point();
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  shaft();
  ctx.translate(x1, y1);
  ctx.rotate(angle);
  point();
  ctx.fill();
  ctx.restore();

  label(ctx, `${Math.round(blocks)} blocks`, x1, y1 + 16);
}

/** A small plate of monospace text, legible over any terrain. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = "rgba(8, 10, 9, .78)";
  ctx.fillRect(x - w / 2, y, w, 13);
  ctx.fillStyle = "#dfe6e3";
  ctx.fillText(text, x, y + 2);
  ctx.restore();
}

// --------------------------------------------------------------------------

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the map image failed to load"));
    image.src = src;
  });
}
