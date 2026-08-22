"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./world-map.module.css";
import { AREA_QUADRANT, AREAS, DRONES, type Area } from "./drones";
import { getWorld, worldMapUrl } from "@/lib/api";
import type { WorldMeta } from "@/lib/types";
import { fallbackWorld } from "./fallback-world";

/**
 * Flight feel. A real DroneEntity cruises at 8 blocks/s, which would take a full
 * minute to cross this map, so the markers fly at dashboard speed instead. The
 * shape of the motion is the mod's: velocity chases a demand that tapers off as
 * the target gets close, so they ease in rather than stopping dead.
 */
const CRUISE = 95;        // blocks per second
const RESPONSE = 3.4;     // how fast velocity catches up with the demand, per second
const BRAKING = 1.7;      // approach speed per block of remaining distance
const CREEP = 5;          // floor under the approach speed, so arrivals do not crawl
const ARRIVED = 0.5;      // blocks

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

/** Where an area's three drones start, as offsets from the centre of the map. */
const SPREAD: readonly (readonly [number, number])[] = [[0.16, 0.30], [0.30, 0.15], [0.42, 0.39]];

type Vec = { x: number; z: number };

type MapDrone = {
  name: string;
  area: Area;
  x: number;
  z: number;
  vx: number;
  vz: number;
  target: Vec | null;
  yaw: number;
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
  const dronesRef = useRef<MapDrone[]>([]);
  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<string | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const fittedRef = useRef(false);

  const [backdrop, setBackdrop] = useState<Backdrop | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // Drop the drones into their quadrant as soon as we know how big the world is.
  useEffect(() => {
    if (!backdrop) return;
    const { origin_x, origin_z, width, height } = backdrop.meta;
    dronesRef.current = DRONES.map((drone, index) => {
      const { east, south } = AREA_QUADRANT[drone.area];
      // three offsets from the middle of the map, as fractions of its size
      const [across, along] = SPREAD[index % SPREAD.length];
      return {
        ...drone,
        x: origin_x + width * (0.5 + (east ? across : -across)),
        z: origin_z + height * (0.5 + (south ? along : -along)),
        vx: 0,
        vz: 0,
        target: null,
        yaw: south ? Math.PI / 2 : -Math.PI / 2,
      };
    });
    setSelected(null);
  }, [backdrop]);

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

      fly(dronesRef.current, dt);
      draw(canvasRef.current, backdrop, viewRef.current, dronesRef.current, {
        selected,
        hovered: hoverRef.current,
        drag: dragRef.current,
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
    for (const drone of dronesRef.current) {
      const dx = (drone.x - meta.origin_x) * view.scale + view.x - sx;
      const dy = (drone.z - meta.origin_z) * view.scale + view.y - sy;
      const distance = Math.hypot(dx, dy);
      if (distance <= HIT_RADIUS && (!best || distance < best.distance)) {
        best = { name: drone.name, distance };
      }
    }
    return best?.name ?? null;
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
    if (drag.kind === "aim" && drag.moved > DRAG_SLOP) {
      const drone = dronesRef.current.find((d) => d.name === drag.drone);
      const meta = backdrop?.meta;
      if (drone && meta) {
        const target = toWorld(drag.toX, drag.toY);
        drone.target = {
          x: clamp(target.x, meta.origin_x, meta.origin_x + meta.width - 1),
          z: clamp(target.z, meta.origin_z, meta.origin_z + meta.height - 1),
        };
      }
    }
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

  const centerOn = useCallback((name: string) => {
    const stage = stageRef.current;
    const meta = backdrop?.meta;
    const drone = dronesRef.current.find((d) => d.name === name);
    if (!stage || !meta || !drone) return;
    const { scale } = viewRef.current;
    viewRef.current = {
      scale,
      x: stage.clientWidth / 2 - (drone.x - meta.origin_x) * scale,
      y: stage.clientHeight / 2 - (drone.z - meta.origin_z) * scale,
    };
  }, [backdrop]);

  const holdSelected = useCallback(() => {
    const drone = dronesRef.current.find((d) => d.name === selected);
    if (drone) drone.target = null;
  }, [selected]);

  const flying = dronesRef.current.filter((drone) => drone.target !== null).length;
  const selectedDrone = dronesRef.current.find((drone) => drone.name === selected) ?? null;
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
          <span className={styles.spacer} />
          <span>{cursor ? `X ${Math.floor(cursor.x)}  Z ${Math.floor(cursor.z)}` : "—"}</span>
          <span>{zoom >= 1 ? `${zoom.toFixed(1)}×` : `1/${(1 / zoom).toFixed(1)}×`}</span>
          <button type="button" onClick={() => void load(true)}>Reload</button>
        </footer>

        {!backdrop && <p className={styles.loading}>Reading the world off disk&hellip;</p>}
        {error && backdrop && !backdrop.real && (
          <p className={styles.notice}>
            Showing a stand-in world &mdash; the capture server did not answer ({error}).
            Start <code>python3 server.py</code> and hit Reload.
          </p>
        )}
      </div>

      <aside className={styles.rail} aria-label="Drones on the map">
        <header>
          <span>Drones</span>
          <span>{flying ? `${flying} in transit` : "all holding"}</span>
        </header>
        <ul>
          {AREAS.map((area) => (
            <li key={area}>
              <p className={styles.areaLabel}><i style={{ background: AREA_COLOR[area] }} />{area}</p>
              <ul>
                {dronesRef.current.filter((drone) => drone.area === area).map((drone) => (
                  <li key={drone.name}>
                    <button
                      type="button"
                      data-active={selected === drone.name}
                      onClick={() => { setSelected(drone.name); centerOn(drone.name); }}
                    >
                      <span>{drone.name}</span>
                      <span className={styles.coords}>
                        {Math.round(drone.x)}, {Math.round(drone.z)}
                      </span>
                      {drone.target && <span className={styles.transit} aria-label="in transit" />}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <footer>
          {selectedDrone ? (
            <>
              <p>{selectedDrone.name}</p>
              <p className={styles.coords}>
                {selectedDrone.target
                  ? `flying to ${Math.round(selectedDrone.target.x)}, ${Math.round(selectedDrone.target.z)}`
                  : "holding position"}
              </p>
              <button type="button" onClick={holdSelected} disabled={!selectedDrone.target}>Hold</button>
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
// simulation

function fly(drones: MapDrone[], dt: number) {
  for (const drone of drones) {
    let demandX = 0;
    let demandZ = 0;

    if (drone.target) {
      const ex = drone.target.x - drone.x;
      const ez = drone.target.z - drone.z;
      const distance = Math.hypot(ex, ez);
      if (distance <= ARRIVED) {
        drone.x = drone.target.x;
        drone.z = drone.target.z;
        drone.vx = 0;
        drone.vz = 0;
        drone.target = null;
        continue;
      } else {
        const speed = Math.min(CRUISE, distance * BRAKING + CREEP);
        demandX = (ex / distance) * speed;
        demandZ = (ez / distance) * speed;
      }
    }

    const chase = 1 - Math.exp(-RESPONSE * dt);
    drone.vx += (demandX - drone.vx) * chase;
    drone.vz += (demandZ - drone.vz) * chase;

    const speed = Math.hypot(drone.vx, drone.vz);
    if (speed < 0.02) {
      drone.vx = 0;
      drone.vz = 0;
      continue;
    }

    drone.x += drone.vx * dt;
    drone.z += drone.vz * dt;
    drone.yaw = Math.atan2(drone.vz, drone.vx);
  }
}

// --------------------------------------------------------------------------
// rendering

type Overlay = { selected: string | null; hovered: string | null; drag: Drag | null };

function draw(canvas: HTMLCanvasElement | null, backdrop: Backdrop, view: View, drones: MapDrone[], overlay: Overlay) {
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

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, meta.width * view.scale, meta.height * view.scale);
  ctx.clip();
  drawGrid(ctx, meta, view, width, height);
  ctx.restore();

  // drag arrow first, so markers sit on top of it
  const aim = overlay.drag?.kind === "aim" ? overlay.drag : null;
  if (aim && aim.moved > DRAG_SLOP) {
    const drone = drones.find((d) => d.name === aim.drone);
    if (drone) {
      const blocks = Math.hypot(aim.toX - toScreenX(drone.x), aim.toY - toScreenY(drone.z)) / view.scale;
      drawArrow(ctx, toScreenX(drone.x), toScreenY(drone.z), aim.toX, aim.toY, AREA_COLOR[drone.area], blocks);
    }
  }

  for (const drone of drones) {
    const x = toScreenX(drone.x);
    const y = toScreenY(drone.z);
    if (x < -60 || y < -60 || x > width + 60 || y > height + 60) continue;

    if (drone.target) {
      drawRoute(ctx, x, y, toScreenX(drone.target.x), toScreenY(drone.target.z), AREA_COLOR[drone.area]);
    }
    drawDrone(ctx, x, y, drone, {
      selected: overlay.selected === drone.name,
      hovered: overlay.hovered === drone.name,
      labelled: overlay.selected === drone.name || overlay.hovered === drone.name || view.scale > 0.9,
    });
  }
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
  drone: MapDrone,
  state: { selected: boolean; hovered: boolean; labelled: boolean },
) {
  const color = AREA_COLOR[drone.area];
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
