"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./live-monitoring.module.css";
import { AREAS, type Area, type Filter } from "./drones";
import { CameraIcon, Chevron, EmptyImage } from "./icons";
import DroneControls from "./drone-controls";
import {
  ROSTER_CONTROL_INTERVAL_MS,
  ROSTER_INTERVAL_MS,
  TILE_INTERVAL_MS,
  areaOf,
  getDrones,
  streamUrl,
} from "@/lib/cameras";
import { fetchFrame, pauseFrames } from "@/lib/frames";
import type { DroneCamera } from "@/lib/types";

/** How long to wait before retrying a frame the agent could not give us yet. */
const FRAME_RETRY_MS = 600;

type Drone = DroneCamera & { area: Area };

/**
 * How a feed is being fed.
 *
 * `still` is the grid default: single frames, taken in turn with every other tile. `stream` is
 * one long-lived MJPEG response that runs as fast as the agent renders, which is worth a
 * connection only for a feed somebody is actually watching. `off` keeps the last frame on screen
 * and asks for nothing.
 */
type FeedMode = "off" | "still" | "stream";

type LiveMonitoringProps = {
  /** A drone the map has handed over, as a fresh object per request so repeats still land. */
  request: { id: string } | null;
};

export default function LiveMonitoring({ request }: LiveMonitoringProps) {
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Held by id, not by object: the roster is replaced on every poll, so anything remembered by
  // reference would be stale a second later.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controllingId, setControllingId] = useState<string | null>(null);
  const handledRequest = useRef<{ id: string } | null>(null);

  // Flying by hand needs a fresher position than a wall of thumbnails does.
  const { drones, offline } = useDroneRoster(controllingId ? ROSTER_CONTROL_INTERVAL_MS : ROSTER_INTERVAL_MS);

  const filteredDrones = activeFilter === "All" ? drones : drones.filter((drone) => drone.area === activeFilter);
  const focusedDrone = focusedId ? drones.find((drone) => drone.id === focusedId) ?? null : null;
  const visibleDrones = focusedDrone ? [focusedDrone] : filteredDrones;
  const selectedIndex = selectedId ? visibleDrones.findIndex((drone) => drone.id === selectedId) : -1;
  const selectedDrone = selectedIndex >= 0 ? visibleDrones[selectedIndex] : null;

  /** The one drone on screen in its own right, and so the only one that can be flown. */
  const watchedId = selectedDrone ? selectedDrone.id : (selectedId === null ? focusedDrone?.id ?? null : null);

  const selectArea = (area: Filter) => {
    setActiveFilter(area);
    setFocusedId(null);
    setSelectedId(null);
  };

  // A handover is honoured once, and only once the roster actually carries that drone: a
  // request can land a poll or two before the drone it names does.
  useEffect(() => {
    if (!request || request === handledRequest.current) return;
    const drone = drones.find((item) => item.id === request.id);
    if (!drone) return;
    handledRequest.current = request;
    setActiveFilter(drone.area);
    setFocusedId(drone.id);
    setSelectedId(null);
  }, [drones, request]);

  const moveViewer = (offset: number) => {
    if (selectedIndex < 0) return;
    setSelectedId(visibleDrones[(selectedIndex + offset + visibleDrones.length) % visibleDrones.length].id);
  };

  // A drone that lands or is removed takes its viewer, and its focus, down with it.
  useEffect(() => {
    if (selectedId && selectedIndex < 0) setSelectedId(null);
  }, [selectedId, selectedIndex]);

  useEffect(() => {
    if (focusedId && !focusedDrone) setFocusedId(null);
  }, [focusedId, focusedDrone]);

  // Control belongs to whatever is being watched; look away and you have handed it back.
  useEffect(() => {
    if (controllingId && controllingId !== watchedId) setControllingId(null);
  }, [controllingId, watchedId]);

  // The grid is behind a full-screen overlay while the viewer is open, so it has nothing to
  // show and no business holding connections the viewer needs.
  useEffect(() => {
    pauseFrames(selectedId !== null);
    return () => pauseFrames(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedDrone && !controllingId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape backs out one layer at a time: first hand back control, then close the viewer.
        if (controllingId) setControllingId(null);
        else if (selectedDrone) setSelectedId(null);
        return;
      }
      // Switching drones mid-flight would take the camera off the one being flown.
      if (!selectedDrone || controllingId) return;
      if (event.key === "ArrowLeft") moveViewer(-1);
      if (event.key === "ArrowRight") moveViewer(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedDrone, selectedIndex, visibleDrones, controllingId]);

  const toggleControl = (id: string) => (next: boolean) => setControllingId(next ? id : null);

  return (
    <>
      <div className={styles.workspace} data-sidebar-collapsed={sidebarCollapsed}>
        <aside className={styles.sidebar} aria-label="Drone regions">
          <button
            className={styles.sidebarToggle}
            type="button"
            aria-label={`${sidebarCollapsed ? "Show" : "Hide"} region filters`}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <Chevron direction={sidebarCollapsed ? "right" : "left"} />
          </button>
          {!sidebarCollapsed && <nav className={styles.regionList}>
            <button className={styles.allDrones} data-active={activeFilter === "All"} type="button" onClick={() => selectArea("All")}>
              <span>All</span><span>{drones.length}</span>
            </button>
            {AREAS.map((area) => {
              const areaDrones = drones.filter((drone) => drone.area === area);
              return <section className={styles.area} key={area}>
                <button className={styles.areaSelect} data-active={activeFilter === area} type="button" onClick={() => selectArea(area)}>
                  <span>{area}</span><span>{areaDrones.length}</span>
                </button>
                <div className={styles.droneList}>
                  {areaDrones.map((drone) => (
                    <button key={drone.id} data-active={focusedId === drone.id} type="button" onClick={() => {
                      setActiveFilter(area);
                      setFocusedId(drone.id);
                      setSelectedId(null);
                    }}><i /><CameraIcon /><span>{drone.id}</span></button>
                  ))}
                </div>
              </section>;
            })}
          </nav>}
        </aside>

        <section className={styles.grid} data-focused={Boolean(focusedDrone)} data-count={visibleDrones.length} aria-label="Drone camera feeds">
          {visibleDrones.map((drone) => (
            <article className={styles.feed} key={drone.id}>
              <button className={styles.viewport} type="button" aria-label={`Open ${drone.id} feed`} onClick={() => setSelectedId(drone.id)}>
                {/* Singled out from the sidebar there is only this one tile, so it can afford the
                    connection a stream costs - and flying by hand needs every frame it can get. */}
                <Feed
                  id={drone.id}
                  ratio
                  mode={selectedId !== null ? "off" : focusedDrone?.id === drone.id ? "stream" : "still"}
                />
                <span className={styles.feedLabel}>{drone.id}</span>
              </button>
              {/* The overlay owns the controls once it is open, so only ever one panel is
                  listening for the keys. */}
              {focusedDrone?.id === drone.id && selectedId === null && (
                <div className={styles.tileControls}>
                  <DroneControls
                    drone={drone}
                    controlling={controllingId === drone.id}
                    onToggleControl={toggleControl(drone.id)}
                  />
                </div>
              )}
            </article>
          ))}
          {visibleDrones.length === 0 && (
            <p className={styles.notice}>
              {offline
                ? "Waiting for the Minecraft client - no camera server on /camera yet."
                : activeFilter === "All"
                  ? "No drones in the air. Spawn one with /drone spawn."
                  : `No drones over the ${activeFilter.toLowerCase()}.`}
            </p>
          )}
        </section>
      </div>

      {selectedDrone && (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`${selectedDrone.id} feed`} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedId(null);
        }}>
          <div className={styles.viewer} data-single={visibleDrones.length === 1}>
            {visibleDrones.length > 1 && !controllingId && <button className={styles.viewerArrow} type="button" aria-label="Previous drone feed" onClick={() => moveViewer(-1)}>
              <Chevron direction="left" />
            </button>}
            <div className={styles.viewerPanel} key={selectedDrone.id}>
              <div className={styles.viewerImage}><Feed id={selectedDrone.id} mode="stream" /></div>
              <p>{selectedDrone.id} - {Math.round(selectedDrone.x)}, {Math.round(selectedDrone.y)}, {Math.round(selectedDrone.z)}</p>
              <DroneControls
                drone={selectedDrone}
                controlling={controllingId === selectedDrone.id}
                onToggleControl={toggleControl(selectedDrone.id)}
              />
            </div>
            {visibleDrones.length > 1 && !controllingId && <button className={styles.viewerArrow} type="button" aria-label="Next drone feed" onClick={() => moveViewer(1)}>
              <Chevron direction="right" />
            </button>}
          </div>
        </div>
      )}
    </>
  );
}

/** Polls the mod for the live roster, so drones appear and disappear on their own. */
function useDroneRoster(intervalMs: number) {
  const [drones, setDrones] = useState<Drone[]>([]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const roster = await getDrones(controller.signal);
        if (cancelled) return;
        setDrones(roster.map((drone) => ({ ...drone, area: areaOf(drone) })));
        setOffline(false);
      } catch {
        if (cancelled) return;
        setDrones([]);
        setOffline(true);
      }
    };

    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [intervalMs]);

  return { drones, offline };
}

/**
 * The newest still for one drone, refreshed while `active`.
 *
 * <p>Frames are fetched through the shared queue in lib/frames rather than by the caller itself,
 * so a wall of tiles takes turns instead of racing for the browser's handful of connections to
 * this origin. The last frame is kept when a feed goes quiet, so nothing blanks out.
 */
function useDroneFrame(id: string, active: boolean, priority = false) {
  const [src, setSrc] = useState<string | null>(null);
  const shown = useRef<string | null>(null);

  const show = useCallback((next: string | null) => {
    const previous = shown.current;
    shown.current = next;
    setSrc(next);
    // The old frame is still on screen until the new one decodes, so let it go a moment later.
    if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 2_000);
  }, []);

  // A different drone starts blank rather than showing the last one's picture.
  useEffect(() => {
    show(null);
    return () => {
      if (shown.current) URL.revokeObjectURL(shown.current);
      shown.current = null;
    };
  }, [id, show]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let stopped = false;

    const run = async () => {
      while (!stopped) {
        try {
          const blob = await fetchFrame(id, controller.signal, priority);
          if (stopped) return;
          show(URL.createObjectURL(blob));
          await wait(TILE_INTERVAL_MS, controller.signal);
        } catch {
          if (stopped) return;
          // 503 while the agent renders this drone's first frame, or an agent restarting.
          await wait(FRAME_RETRY_MS, controller.signal).catch(() => undefined);
        }
      }
    };

    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [id, active, priority, show]);

  return src;
}

/**
 * One drone's picture.
 *
 * <p>A stream takes a moment to open, so stills are fetched alongside it and shown first. That is
 * what stops a feed you just opened from sitting behind "no image" while it connects; once the
 * stream delivers a frame it takes over and the stills stop.
 */
function Feed({ id, mode, ratio = false }: { id: string; mode: FeedMode; ratio?: boolean }) {
  const [streaming, setStreaming] = useState(false);
  const wantStream = mode === "stream";
  const still = useDroneFrame(id, mode !== "off" && !streaming, wantStream);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setStreaming(false);
    const element = image.current;
    // Dropping the src is what actually closes the connection when this feed stops streaming.
    return () => element?.setAttribute("src", "");
  }, [id, wantStream]);

  return (
    <>
      {!(wantStream && streaming) && (still
        ? <img className={styles.feedImage} src={still} alt={`${id} camera`} />
        : <EmptyImage ratio={ratio} label={wantStream ? "Connecting to the feed" : "Waiting for the first frame"} />)}
      {wantStream && (
        <img
          ref={image}
          className={styles.feedImage}
          style={streaming ? undefined : { display: "none" }}
          src={streamUrl(id)}
          alt={`${id} camera`}
          onLoad={() => setStreaming(true)}
        />
      )}
    </>
  );
}

/** A cancellable sleep, so a feed that goes away stops waiting rather than finishing its nap. */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
