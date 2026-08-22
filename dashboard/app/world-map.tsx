"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./world-map.module.css";
import { AREAS, type Area } from "./drones";
import { getWorld, worldMapUrl } from "@/lib/api";
import type { WorldMeta } from "@/lib/types";
import { areaOf } from "@/lib/cameras";
import { ROLE_LIST, callsignOf, roleOf, type Role } from "@/lib/roles";
import { LiveLayer } from "./live-layer";
import { DIMENSION, getLive, liveMapUrl, sendDroneTo, spawnDrone, streamUrl,
         type LiveDelta, type LiveDrone, type LiveSnapshot } from "@/lib/live";
import Simulator from "./simulator";
import { EVENT_INFO, getEvents, isPending, mergeEvents, simulate,
         type EventKind, type LiveEvents, type SimEvent } from "@/lib/events";

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
  /**
   * What it is up there to do, which is what it is drawn as.
   *
   * The markers used to be coloured by quadrant, which said something the map already says -
   * the drone's position. Colouring by role says the thing the map cannot: that the two
   * aircraft over the same fire are a surveyor and a suppression ship, and that nobody has
   * sent a thermal.
   */
  role: Role;
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

/** The rendered Minecraft save under the live fleet overlay. */
type Backdrop = { meta: WorldMeta; image: CanvasImageSource };

/**
 * What the map is for right now.
 *
 * Both modes are the same map, the same feed and the same canvas - only what a click means and
 * which rail is beside it change. Keeping one instance is the point: the simulation tab opens on
 * exactly the view you left the drone tab at, already showing the fires you started.
 */
export type MapMode = "drones" | "simulate";

/** How the placement circle is aimed, so the render loop can read it without restarting. */
type SimSettings = { mode: MapMode; tool: EventKind; radius: number; placing: boolean };

/**
 * A drone that has been asked for but has not turned up yet.
 *
 * Spawning is not immediate and never looked it: the POST only queues the order, the mod builds
 * the drone on its next feed pull, and it reports it on the pull after that. That is a second or
 * two of a map that has not changed, which reads exactly like a click that missed.
 *
 * So the click leaves something behind. It is not an optimistic drone - nothing pretends there is
 * an aircraft there - it is a marker saying an order is outstanding, and it goes when the real
 * drone lands on the feed, or turns into a failure when it never does.
 */
type Deployment = {
  key: number;
  x: number;
  z: number;
  /** when the order went out, for the timeout and for the age on the rail */
  at: number;
  state: "deploying" | "lost";
};

/** How long a spawn has to produce a drone before it is called a failure. */
const DEPLOY_TIMEOUT_MS = 20_000;

/** How long the failure stays on screen after that, so it is not missed. */
const DEPLOY_LINGER_MS = 8_000;

/** A new drone this far from where one was ordered is taken to be that order arriving. */
const DEPLOY_RADIUS = 24;

type WorldMapProps = {
  active: boolean;
  mode: MapMode;
  onOpenDroneFeed: (id: string) => void;
};

export default function WorldMap({ active, mode, onOpenDroneFeed }: WorldMapProps) {
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
  const eventsRef = useRef<SimEvent[]>([]);
  const deployRef = useRef<Deployment[]>([]);
  // Which drones the feed has already shown us, so a drone appearing is something we can notice.
  const knownDrones = useRef<Set<string>>(new Set());
  const simRef = useRef<SimSettings>({ mode: "drones", tool: "fire", radius: 8, placing: false });

  const [feed, setFeed] = useState<LiveSnapshot | null>(null);
  const [liveDrones, setLiveDrones] = useState<LiveDrone[]>([]);
  const [backdrop, setBackdrop] = useState<Backdrop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // armed by the Launch a drone button; the next click on the map puts one there, then disarms
  const [placing, setPlacing] = useState(false);
  const [cursor, setCursor] = useState<Vec | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [zoom, setZoom] = useState(1);
  const [, setPulse] = useState(0);          // nudges the side rail to re-read the sim

  // the simulator: what the next click on the map will set off, and everything already set off
  const [tool, setTool] = useState<EventKind>("fire");
  const [radius, setRadius] = useState(8);
  const [intensity, setIntensity] = useState(6);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [simError, setSimError] = useState<string | null>(null);

  // ---------------------------------------------------------------- the world

  const load = useCallback(async (refresh = false) => {
    setError(null);
    let failure: unknown;
    // Minecraft can be saving its region files when the first request lands. Retry that short
    // window rather than substituting a fictional map for the world the drones are actually in.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const meta = await getWorld();
        const suffix = refresh || attempt > 0 ? `&refresh=1&t=${Date.now()}` : "";
        const image = await loadImage(worldMapUrl() + suffix);
        setBackdrop({ meta, image });
        fittedRef.current = false;
        return;
      } catch (cause) {
        failure = cause;
        if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
      }
    }
    setError(failure instanceof Error ? failure.message : String(failure));
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

    // Disasters move on in their own time - queued, collected by the mod, then carried out -
    // so the server pushes each step down the same stream rather than making us poll for it.
    source.addEventListener("events", (event) => {
      const batch = JSON.parse((event as MessageEvent).data) as LiveEvents;
      setEvents((current) => mergeEvents(current, batch.events));
    });

    // EventSource retries on its own; surface the gap rather than fighting it
    source.onerror = () => setFeed((current) => (current ? { ...current, live: false } : current));

    return () => { closed = true; source.close(); };
  }, [seed]);

  // The stream only carries changes, so the log starts from what the server already has.
  useEffect(() => {
    getEvents(DIMENSION)
      .then(({ events: seeded }) => setEvents((current) => mergeEvents(current, seeded)))
      .catch(() => undefined);       // no server yet; the map's own notice already says so
  }, []);

  useEffect(() => { liveRef.current = liveDrones; }, [liveDrones]);
  useEffect(() => { deployRef.current = deployments; }, [deployments]);

  /**
   * Retires a deployment marker when the drone it was waiting for turns up.
   *
   * Matched by position rather than by name, because the dashboard does not get to choose the
   * name - the mod does, on its own side, after the order has been queued. What we do know is
   * where we asked for it, and a drone that has just appeared within a few blocks of that is the
   * one we asked for.
   */
  useEffect(() => {
    const arrived = liveDrones.filter((drone) => !knownDrones.current.has(drone.id));
    knownDrones.current = new Set(liveDrones.map((drone) => drone.id));
    if (arrived.length === 0) return;

    setDeployments((current) => {
      if (current.length === 0) return current;
      const remaining = [...current];
      for (const drone of arrived) {
        let best = -1;
        let bestDistance = DEPLOY_RADIUS;
        remaining.forEach((deployment, index) => {
          if (deployment.state !== "deploying") return;
          const distance = Math.hypot(deployment.x - drone.x, deployment.z - drone.z);
          if (distance <= bestDistance) {
            best = index;
            bestDistance = distance;
          }
        });
        if (best >= 0) remaining.splice(best, 1);
      }
      return remaining.length === current.length ? current : remaining;
    });
  }, [liveDrones]);

  // An order that never produced a drone says so rather than fading out as though it worked.
  useEffect(() => {
    if (deployments.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setDeployments((current) => {
        const next = current
          .map((deployment) => deployment.state === "deploying" && now - deployment.at > DEPLOY_TIMEOUT_MS
            ? { ...deployment, state: "lost" as const }
            : deployment)
          .filter((deployment) => deployment.state === "deploying"
            || now - deployment.at < DEPLOY_TIMEOUT_MS + DEPLOY_LINGER_MS);
        return next.length === current.length
          && next.every((item, index) => item.state === current[index].state)
          ? current
          : next;
      });
    }, 500);
    return () => clearInterval(timer);
  }, [deployments.length]);
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { simRef.current = { mode, tool, radius, placing }; }, [mode, tool, radius, placing]);

  // arming is about the drone map; switching to the simulator means you wanted a fire, not a drone
  useEffect(() => { if (mode !== "drones") setPlacing(false); }, [mode]);

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
        events: eventsRef.current,
        deployments: deployRef.current,
        sim: simRef.current,
        cursor: cursorRef.current,
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

    // While armed, a press is never a grab: the point of the next click is where the new drone
    // goes, and grabbing whatever happened to be under it would send that one flying instead.
    const hit = placing ? null : pick(x, y);
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

  /**
   * Sets off whatever the simulator rail is currently holding, at a point on the map.
   *
   * The request only says it was queued: the fire itself arrives later, over the world feed,
   * like any other change to the world. That is why nothing is drawn optimistically here.
   */
  const place = useCallback((at: Vec) => {
    setSimError(null);
    const info = EVENT_INFO[tool];
    void simulate({
      kind: tool,
      x: Math.round(at.x),
      z: Math.round(at.z),
      radius: info.scatters ? radius : 0,
      intensity: Math.min(intensity, info.max),
      dimension: DIMENSION,
    })
      .then(({ event }) => setEvents((current) => mergeEvents(current, [event])))
      .catch((cause) => setSimError(cause instanceof Error ? cause.message : String(cause)));
  }, [tool, radius, intensity]);

  /**
   * Puts a new drone where the map was clicked.
   *
   * Only x and z: the map is top-down, and the mod drops the drone just above the ground rather
   * than guessing an altitude here. No drone is drawn until the feed reports it, which is a
   * second or so - but a "deploying" marker goes down straight away, so the wait looks like a
   * wait rather than like a click that did nothing.
   */
  const plop = useCallback((at: Vec) => {
    setPlacing(false);
    setOrderError(null);
    const x = Math.round(at.x);
    const z = Math.round(at.z);
    void spawnDrone(x, z, DIMENSION)
      // Only once the server has taken the order: a marker put down before that would sit there
      // saying a drone is on its way next to an error saying it never left.
      .then(() => setDeployments((current) => [...current,
        { key: Date.now() + current.length, x, z, at: Date.now(), state: "deploying" }]))
      .catch((cause) => setOrderError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // In simulation mode a click on open map places an event; the same slop that tells a
    // click from a flight order tells it from a pan.
    if (drag.kind === "pan") {
      // Against the view as it was when the press landed: even a click nudges the map a
      // pixel or two, and at a zoomed-out scale a pixel or two is a long way to be wrong by.
      if ((mode === "simulate" || placing) && drag.moved <= DRAG_SLOP) {
        const { scale } = viewRef.current;
        const meta = backdrop?.meta;
        const at = {
          x: (drag.fromX - drag.viewX) / scale + (meta?.origin_x ?? 0),
          z: (drag.fromY - drag.viewY) / scale + (meta?.origin_z ?? 0),
        };
        if (mode === "simulate") place(at); else plop(at);
      }
      return;
    }

    // A short drag out of a drone was a click; a real one is a flight order.
    if (drag.moved <= DRAG_SLOP) return;
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

  /** Double-clicking a drone on the map hands you over to its feed, still on that drone. */
  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const id = pick(event.clientX - box.left, event.clientY - box.top);
    if (!id) return;
    event.preventDefault();
    setSelected(id);
    onOpenDroneFeed(id);
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dragRef.current = null;
        setPlacing(false);
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
          data-mode={mode}
          data-placing={placing}
          aria-label="Top-down map of the Minecraft world with drone positions"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => { cursorRef.current = null; hoverRef.current = null; setCursor(null); }}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
        />

        <div className={styles.hint} aria-hidden="true">
          {mode === "simulate"
            ? <>Click the map to set off a {EVENT_INFO[tool].label.toLowerCase()} &middot; drag to pan &middot; scroll to zoom</>
            : placing
              ? <>Click the map to launch a new drone there &middot; Escape to cancel &middot; drag to pan</>
              : <>Drag an arrow out of a drone to send it there &middot; drag the map to pan &middot; scroll to zoom</>}
          {feed?.live && " · the mod is streaming changes as they happen"}
        </div>

        <div className={styles.zoomControls}>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>&minus;</button>
          <button type="button" className={styles.wide} onClick={fit}>Fit</button>
        </div>

        <footer className={styles.status}>
          <span className={styles.world} data-real={Boolean(backdrop)}>
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
        {error && !backdrop && (
          <p className={styles.notice}>
            The real Minecraft world could not be read yet &mdash; {error}. It will never show a
            substitute map. Check that the hub can read the server save, then use Reload.
          </p>
        )}
      </div>

      {mode === "simulate" ? (
        <Simulator
          tool={tool}
          onTool={setTool}
          radius={radius}
          onRadius={setRadius}
          intensity={intensity}
          onIntensity={setIntensity}
          events={events}
          burning={feed?.hot ?? 0}
          live={feed?.live ?? false}
          error={simError}
          onFocus={(event) => centerOnPoint(event.x, event.z)}
        />
      ) : (
      <aside className={styles.rail} aria-label="Drones on the map">
        <header>
          <span>Drones</span>
          <span>{flying ? `${flying} in transit` : "all holding"}</span>
        </header>
        <button
          type="button"
          className={styles.place}
          data-armed={placing}
          aria-pressed={placing}
          onClick={() => setPlacing((armed) => !armed)}
        >
          {placing ? "Click the map to place it" : "Launch a drone"}
        </button>
        {deployments.length > 0 && (
          <ul className={styles.deployList} aria-label="Drones being deployed">
            {deployments.map((deployment) => (
              <li key={deployment.key} data-state={deployment.state}>
                <i />
                <span>{deployment.state === "lost" ? "No drone arrived" : "Deploying drone"}</span>
                <button type="button" className={styles.coords}
                        onClick={() => centerOnPoint(deployment.x, deployment.z)}>
                  {deployment.x}, {deployment.z}
                </button>
              </li>
            ))}
          </ul>
        )}
        {liveDrones.length > 0 && (
          <div className={styles.legend} aria-label="Fleet composition">
            {ROLE_LIST.map((role) => {
              const count = liveDrones.filter((drone) => roleOf(drone.id).id === role.id).length;
              if (count === 0) return null;
              return <span key={role.id} style={{ "--role": role.color } as React.CSSProperties}
                           title={`${count} x ${role.name} - ${role.tagline}`}>
                <i />{role.code}<b>{count}</b>
              </span>;
            })}
          </div>
        )}
        {liveDrones.length === 0 && deployments.length === 0 && (
          <p className={styles.empty}>
            {feed?.live
              ? "No drones in the world yet. Launch one on the map, or use /drone spawn."
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
                  {inArea.map((drone) => {
                    const role = roleOf(drone.id);
                    return <li key={drone.id}>
                      <button
                        type="button"
                        data-active={selected === drone.id}
                        style={{ "--role": role.color } as React.CSSProperties}
                        title={`${drone.id} - ${role.name}: ${role.tagline}`}
                        onClick={() => { setSelected(drone.id); centerOnPoint(drone.x, drone.z); }}
                      >
                        <span className={styles.roleTag}>{role.code}</span>
                        <span>{callsignOf(drone.id)}</span>
                        <span className={styles.coords}>
                          {Math.round(drone.x)}, {Math.round(drone.z)}
                        </span>
                        {drone.target && <span className={styles.transit} aria-label="in transit" />}
                      </button>
                    </li>;
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
        <footer>
          {selectedLive ? (
            <>
              <p>{callsignOf(selectedLive.id)} <em className={styles.roleName}>{roleOf(selectedLive.id).name}</em></p>
              <p className={styles.coords}>{selectedLive.id} &middot; {roleOf(selectedLive.id).tagline.toLowerCase()}</p>
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
          ) : orderError ? (
            <p className={styles.orderError}>{orderError}</p>
          ) : (
            <p className={styles.coords}>Pick a drone, or drag one on the map.</p>
          )}
        </footer>
      </aside>
      )}
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
    const role = roleOf(drone.id);
    // Minecraft yaw is degrees with 0 facing +Z, so forward is (-sin, cos). drawDrone turns the
    // marker by yaw + 90 degrees and its nose starts pointing screen-up, which lands the nose on
    // that forward vector only with +90 here - with -90 every drone was drawn facing backwards.
    const yaw = (drone.yaw + 90) * Math.PI / 180;
    const target = drone.target ? { x: drone.target[0], z: drone.target[2] } : null;

    const marker = existing.get(drone.id);
    if (!marker) {
      next.push({ id: drone.id, area, role, x: drone.x, z: drone.z, yaw, target });
      continue;
    }

    marker.area = area;
    marker.role = role;
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
  events: SimEvent[];
  /** spawns that have been ordered and not yet arrived */
  deployments: Deployment[];
  sim: SimSettings;
  /** where the pointer is on the canvas, for the placement circle */
  cursor: { x: number; y: number } | null;
  time: number;
};

/** Events older than this stop being drawn - the burn scar under them says it better by then. */
const EVENT_FADE_SECONDS = 240;
/** Newest first, so a busy log never costs more than this many rings a frame. */
const MAX_EVENT_RINGS = 60;

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

  // where the disasters were called down, and where the next one would land
  drawEvents(ctx, overlay.events, view, toScreenX, toScreenY, overlay.time);
  if (overlay.sim.mode === "simulate" && overlay.cursor && !overlay.drag) {
    drawPlacement(ctx, overlay.cursor, overlay.sim, view);
  }
  if (overlay.sim.placing && overlay.cursor && !overlay.drag) {
    drawNewDrone(ctx, overlay.cursor, overlay.time);
  }

  // Orders that have gone out and not yet produced an aircraft.
  for (const deployment of overlay.deployments) {
    drawDeploying(ctx, toScreenX(deployment.x), toScreenY(deployment.z), deployment, overlay.time);
  }

  // drag arrow first, so markers sit on top of it
  const aim = overlay.drag?.kind === "aim" ? overlay.drag : null;
  if (aim && aim.moved > DRAG_SLOP) {
    const marker = markers.find((m) => m.id === aim.drone);
    if (marker) {
      const blocks = Math.hypot(aim.toX - toScreenX(marker.x), aim.toY - toScreenY(marker.z)) / view.scale;
      drawArrow(ctx, toScreenX(marker.x), toScreenY(marker.z), aim.toX, aim.toY, marker.role.color, blocks);
    }
  }

  for (const marker of markers) {
    const x = toScreenX(marker.x);
    const y = toScreenY(marker.z);
    if (x < -60 || y < -60 || x > width + 60 || y > height + 60) continue;

    const color = marker.role.color;
    if (marker.target) {
      drawRoute(ctx, x, y, toScreenX(marker.target.x), toScreenY(marker.target.z), color);
    }
    drawDrone(ctx, x, y, { name: callsignOf(marker.id), yaw: marker.yaw, role: marker.role }, color, {
      selected: overlay.selected === marker.id,
      hovered: overlay.hovered === marker.id,
      labelled: true,
    });
  }
}

/**
 * Where each simulated disaster was called down.
 *
 * A ring the size of the event, fading out over a few minutes: long enough to see what you just
 * did and where it is spreading from, short enough that an hour of drills does not bury the map.
 * One that has not landed yet pulses instead, because a queued fire and a fire that failed to
 * catch look identical on the ground and are not at all the same thing.
 */
function drawEvents(ctx: CanvasRenderingContext2D, events: SimEvent[], view: View,
                    toScreenX: (bx: number) => number, toScreenY: (bz: number) => number,
                    time: number) {
  const now = Date.now() / 1000;

  ctx.save();
  for (const event of events.slice(0, MAX_EVENT_RINGS)) {
    const age = now - event.created;
    const pending = isPending(event);
    if (!pending && age > EVENT_FADE_SECONDS) continue;

    const fade = pending ? 1 : 1 - age / EVENT_FADE_SECONDS;
    const x = toScreenX(event.x);
    const y = toScreenY(event.z);
    const detectedFire = event.lifecycle !== undefined;
    // A detection reports a cluster centre, not its geometric footprint. Exact burning columns
    // come from the live layer beneath it, so this is deliberately a reticle rather than a
    // made-up area circle based on the number of detected blocks.
    const ring = Math.max(detectedFire ? 12 : 7, event.radius * view.scale);

    ctx.globalAlpha = fade * (pending ? 0.45 + 0.35 * Math.sin(time / 260) : 0.7);
    const suppression = event.status === "contained" || event.status === "cleared";
    ctx.strokeStyle = suppression ? "#75bee7" : EVENT_INFO[event.kind].color;
    ctx.lineWidth = detectedFire ? 1.8 : 1.3;
    ctx.setLineDash(pending ? [3, 4] : []);
    ctx.beginPath();
    ctx.arc(x, y, ring, 0, Math.PI * 2);
    ctx.stroke();

    // A water ripple makes a successful dousing pass legible on the real map.
    if (suppression) {
      ctx.globalAlpha = fade * 0.55;
      ctx.beginPath();
      ctx.arc(x, y, ring * (0.35 + 0.15 * Math.sin(time / 180)), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = fade;
    ctx.beginPath();
    ctx.moveTo(x - 3.5, y);
    ctx.lineTo(x + 3.5, y);
    ctx.moveTo(x, y - 3.5);
    ctx.lineTo(x, y + 3.5);
    ctx.stroke();

    if (detectedFire && !suppression) {
      ctx.globalAlpha = fade * .92;
      label(ctx, `Fire cluster · ${event.affected ?? event.intensity} blocks`, x, y + ring + 7);
    }
  }
  ctx.restore();
}

/** The circle under the cursor showing where and how wide the next event would be. */
function drawPlacement(ctx: CanvasRenderingContext2D, cursor: { x: number; y: number },
                       sim: SimSettings, view: View) {
  const info = EVENT_INFO[sim.tool];
  const ring = info.scatters ? Math.max(6, sim.radius * view.scale) : 9;

  ctx.save();
  ctx.strokeStyle = info.color;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.2;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, ring, 0, Math.PI * 2);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(cursor.x - 6, cursor.y);
  ctx.lineTo(cursor.x + 6, cursor.y);
  ctx.moveTo(cursor.x, cursor.y - 6);
  ctx.lineTo(cursor.x, cursor.y + 6);
  ctx.stroke();
  ctx.restore();

  label(ctx, info.scatters ? `${info.label} · ${sim.radius}m` : info.label,
    cursor.x, cursor.y + ring + 6);
}

/**
 * The drone that would appear if you clicked now.
 *
 * Drawn as the real marker with a placement ring over it, so what you are about to put down looks
 * like what you will get - pulsing rather than solid, because until the feed reports it there is
 * no drone there at all.
 */
function drawNewDrone(ctx: CanvasRenderingContext2D, cursor: { x: number; y: number }, time: number) {
  ctx.save();
  ctx.globalAlpha = 0.55 + 0.2 * Math.sin(time / 260);
  drawDrone(ctx, cursor.x, cursor.y, { name: "", yaw: 0, role: null }, "#e6e2d8",
    { selected: false, hovered: true, labelled: false });

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#e6e2d8";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  label(ctx, "New drone", cursor.x, cursor.y + 22);
}


/**
 * An outstanding spawn order.
 *
 * A dashed ring closing inwards while it waits, because the wait has a length and a ring that
 * only pulses does not say whether it is two seconds in or twenty. When it runs out the mark
 * goes red and says so rather than quietly disappearing, which would be indistinguishable from
 * a drone that arrived somewhere off screen.
 */
function drawDeploying(ctx: CanvasRenderingContext2D, x: number, y: number,
                       deployment: Deployment, time: number) {
  const lost = deployment.state === "lost";
  const color = lost ? "#e2604a" : "#8fb8ae";
  const progress = Math.min(1, (Date.now() - deployment.at) / DEPLOY_TIMEOUT_MS);

  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.globalAlpha = lost ? .95 : .55 + .3 * Math.sin(time / 240);

  // the outer ring, closing as the wait runs down
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.stroke();

  if (!lost) {
    ctx.setLineDash([]);
    ctx.globalAlpha = .9;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 15, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
  }

  // a landing cross under it, so the point being deployed to is unambiguous
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-6, 0);
  ctx.lineTo(6, 0);
  ctx.moveTo(0, -6);
  ctx.lineTo(0, 6);
  ctx.stroke();
  ctx.restore();

  label(ctx, lost ? "No drone arrived" : "Deploying drone", x, y + 21);
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

  // Keep an unblurred core on the same pixels the mod marked as burning. At a close zoom this
  // is the exact fire location; the halo remains useful while viewing the whole world.
  ctx.globalAlpha = Math.min(1, pulse + .18);
  ctx.filter = "none";
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
  drone: { name: string; yaw: number; role: Role | null },
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

  if (drone.role) drawRoleGlyph(ctx, drone.role, radius, color);

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


/**
 * The mark that says what an aircraft is, drawn around it and turned with it.
 *
 * Colour alone is not enough on a map that is already every colour terrain comes in - and it is
 * no help at all to somebody who cannot separate the olive from the amber. Each role gets a
 * shape as well: a forward wedge for the surveyor's sweep, a heat halo for the thermal ship, a
 * drop bracket under the suppression ship, arcs off a relay, and a search ring for SAR.
 *
 * Drawn inside the marker's own rotation, so the surveyor's wedge points where it is looking.
 */
function drawRoleGlyph(ctx: CanvasRenderingContext2D, role: Role, radius: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.1;
  ctx.globalAlpha = .55;

  switch (role.id) {
    case "survey": {
      // the swathe under the camera, opening away from the nose
      const reach = radius + 15;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, reach, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
      ctx.closePath();
      ctx.globalAlpha = .18;
      ctx.fill();
      ctx.globalAlpha = .6;
      ctx.stroke();
      break;
    }
    case "thermal": {
      ctx.setLineDash([2, 3]);
      for (const scale of [1.55, 2.1]) {
        ctx.beginPath();
        ctx.arc(0, 0, radius * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case "suppress": {
      // the bracket the load would fall through
      const drop = radius + 12;
      ctx.beginPath();
      ctx.moveTo(-6, drop - 5);
      ctx.lineTo(-6, drop);
      ctx.lineTo(6, drop);
      ctx.lineTo(6, drop - 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, radius + 2);
      ctx.lineTo(0, drop - 2);
      ctx.stroke();
      break;
    }
    case "relay": {
      for (const scale of [1.5, 2, 2.5]) {
        ctx.beginPath();
        ctx.arc(0, 0, radius * scale, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.stroke();
      }
      break;
    }
    case "rescue": {
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, radius + 8, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
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
