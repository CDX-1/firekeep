"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./live-monitoring.module.css";
import { AREAS, type Area, type Filter } from "./drones";
import { CameraIcon, Chevron, EmptyImage } from "./icons";
import DroneControls from "./drone-controls";
import { ROSTER_INTERVAL_MS, TILE_INTERVAL_MS, areaOf, getDrones, streamUrl } from "@/lib/cameras";
import { fetchFrame, pauseFrames } from "@/lib/frames";
import type { DroneCamera } from "@/lib/types";

/** How long to wait before retrying a frame the agent could not give us yet. */
const FRAME_RETRY_MS = 600;

type Drone = DroneCamera & { area: Area };

export default function LiveMonitoring() {
  const { drones, offline } = useDroneRoster();
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Both held by id, not by object: the roster is replaced on every poll, so anything
  // remembered by reference would be stale a second later.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filteredDrones = activeFilter === "All" ? drones : drones.filter((drone) => drone.area === activeFilter);
  const focusedDrone = focusedId ? drones.find((drone) => drone.id === focusedId) ?? null : null;
  const visibleDrones = focusedDrone ? [focusedDrone] : filteredDrones;
  const selectedIndex = selectedId ? visibleDrones.findIndex((drone) => drone.id === selectedId) : -1;
  const selectedDrone = selectedIndex >= 0 ? visibleDrones[selectedIndex] : null;

  const selectArea = (area: Filter) => {
    setActiveFilter(area);
    setFocusedId(null);
    setSelectedId(null);
  };

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

  // The grid is behind a full-screen overlay while the viewer is open, so it has nothing to
  // show and no business holding connections the viewer's stream needs.
  useEffect(() => {
    pauseFrames(selectedId !== null);
    return () => pauseFrames(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedDrone) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
      if (event.key === "ArrowLeft") moveViewer(-1);
      if (event.key === "ArrowRight") moveViewer(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedDrone, selectedIndex, visibleDrones]);

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
                <TileFeed id={drone.id} active={selectedId === null} />
                <span className={styles.feedLabel}>{drone.id}</span>
              </button>
              {/* Singled out from the sidebar and not expanded: this is the drone being watched,
                  so it gets the controls. The overlay owns them once it is open, so only ever
                  one panel is listening for the keys. */}
              {focusedDrone?.id === drone.id && selectedId === null && (
                <div className={styles.tileControls}><DroneControls drone={drone} /></div>
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
            {visibleDrones.length > 1 && <button className={styles.viewerArrow} type="button" aria-label="Previous drone feed" onClick={() => moveViewer(-1)}>
              <Chevron direction="left" />
            </button>}
            <div className={styles.viewerPanel} key={selectedDrone.id}>
              <div className={styles.viewerImage}><LiveFeed id={selectedDrone.id} /></div>
              <p>{selectedDrone.id} - {Math.round(selectedDrone.x)}, {Math.round(selectedDrone.y)}, {Math.round(selectedDrone.z)}</p>
              <DroneControls drone={selectedDrone} />
            </div>
            {visibleDrones.length > 1 && <button className={styles.viewerArrow} type="button" aria-label="Next drone feed" onClick={() => moveViewer(1)}>
              <Chevron direction="right" />
            </button>}
          </div>
        </div>
      )}
    </>
  );
}

/** Polls the mod for the live roster, so drones appear and disappear on their own. */
function useDroneRoster() {
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
    const timer = setInterval(poll, ROSTER_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return { drones, offline };
}

/**
 * The newest frame for one drone, refreshed while `active`.
 *
 * <p>Frames are fetched through the shared queue in lib/frames rather than by the tile itself,
 * so a wall of them takes turns instead of racing for the browser's handful of connections to
 * this origin. The last frame is kept when a tile goes quiet, so nothing blanks out.
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

/** A grid tile: stills, taken in turn with every other tile. */
function TileFeed({ id, active }: { id: string; active: boolean }) {
  const src = useDroneFrame(id, active);

  if (!src) return <EmptyImage ratio label="Waiting for the first frame" />;
  return <img className={styles.feedImage} src={src} alt={`${id} camera`} />;
}

/**
 * The expanded viewer: one long-lived MJPEG response, decoded by the browser as it arrives.
 *
 * <p>A stream takes a moment to open, so a still is fetched alongside it and shown first. That
 * is what stops the drone you just opened from sitting behind "no image" while it connects.
 * Once the stream delivers a frame it takes over and the stills stop.
 */
function LiveFeed({ id }: { id: string }) {
  const [streaming, setStreaming] = useState(false);
  // Priority: this is the drone being watched, so its still never queues behind the grid.
  const snapshot = useDroneFrame(id, !streaming, true);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setStreaming(false);
    const element = image.current;
    // Dropping the src is what actually closes the connection when the viewer moves on.
    return () => element?.setAttribute("src", "");
  }, [id]);

  return (
    <>
      {!streaming && (snapshot
        ? <img className={styles.feedImage} src={snapshot} alt={`${id} camera`} />
        : <EmptyImage label="Connecting to the feed" />)}
      <img
        ref={image}
        className={styles.feedImage}
        style={streaming ? undefined : { display: "none" }}
        src={streamUrl(id)}
        alt={`${id} camera`}
        onLoad={() => setStreaming(true)}
      />
    </>
  );
}

/** A cancellable sleep, so a tile that goes away stops waiting rather than finishing its nap. */
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
