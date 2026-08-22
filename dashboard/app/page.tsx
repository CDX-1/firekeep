"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import { MAX_LIVE_TILES, ROSTER_INTERVAL_MS, TILE_INTERVAL_MS, areaOf, getDrones, snapshotUrl, streamUrl } from "../lib/cameras";
import { DRONE_AREAS, type DroneArea, type DroneCamera } from "../lib/types";

type Filter = "All" | DroneArea;
type Drone = DroneCamera & { area: DroneArea };

export default function Dashboard() {
  const { drones, offline } = useDroneRoster();
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visibleDrones = activeFilter === "All" ? drones : drones.filter((drone) => drone.area === activeFilter);
  const selectedIndex = selectedId ? visibleDrones.findIndex((drone) => drone.id === selectedId) : -1;
  const selectedDrone = selectedIndex >= 0 ? visibleDrones[selectedIndex] : null;

  const selectArea = (area: Filter) => {
    setActiveFilter(area);
    setSelectedId(null);
  };

  const moveViewer = (offset: number) => {
    if (selectedIndex < 0) return;
    setSelectedId(visibleDrones[(selectedIndex + offset + visibleDrones.length) % visibleDrones.length].id);
  };

  // A drone that lands or is removed takes its viewer down with it.
  useEffect(() => {
    if (selectedId && selectedIndex < 0) setSelectedId(null);
  }, [selectedId, selectedIndex]);

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
    <main className={styles.dashboard}>
      <h1>Drone Dashboard</h1>
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
            {DRONE_AREAS.map((area) => {
              const areaDrones = drones.filter((drone) => drone.area === area);
              return <section className={styles.area} key={area}>
                <button className={styles.areaSelect} data-active={activeFilter === area} type="button" onClick={() => selectArea(area)}>
                  <span>{area}</span><span>{areaDrones.length}</span>
                </button>
                <div className={styles.droneList}>
                  {areaDrones.map((drone) => (
                    <button key={drone.id} type="button" onClick={() => {
                      setActiveFilter(area);
                      setSelectedId(drone.id);
                    }}>{drone.id}</button>
                  ))}
                </div>
              </section>;
            })}
          </nav>}
        </aside>

        <section className={styles.grid} aria-label="Drone camera feeds">
          {visibleDrones.map((drone, index) => (
            <article className={styles.feed} key={drone.id}>
              <button className={styles.viewport} type="button" aria-label={`Open ${drone.id} feed`} onClick={() => setSelectedId(drone.id)}>
                <TileFeed id={drone.id} live={index < MAX_LIVE_TILES && selectedId === null} />
              </button>
              <p>{drone.id}</p>
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
          <div className={styles.viewer}>
            <button className={styles.viewerArrow} type="button" aria-label="Previous drone feed" onClick={() => moveViewer(-1)}>
              <Chevron direction="left" />
            </button>
            <div className={styles.viewerPanel}>
              <div className={styles.viewerImage}><LiveFeed id={selectedDrone.id} /></div>
              <p>{selectedDrone.id} - {Math.round(selectedDrone.x)}, {Math.round(selectedDrone.y)}, {Math.round(selectedDrone.z)}</p>
            </div>
            <button className={styles.viewerArrow} type="button" aria-label="Next drone feed" onClick={() => moveViewer(1)}>
              <Chevron direction="right" />
            </button>
          </div>
        </div>
      )}
    </main>
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
 * A grid tile.
 *
 * <p>The first few tiles get a real MJPEG stream and move as fast as the agent renders. The rest
 * poll single frames, because a browser only allows six connections to one origin and the roster
 * poll and the expanded viewer need some of those. Tiles give up their stream entirely while the
 * expanded viewer is open, so the drone somebody is actually looking at gets the connection.
 */
function TileFeed({ id, live }: { id: string; live: boolean }) {
  const [tick, setTick] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setHasFrame(false);
  }, [id, live]);

  useEffect(() => {
    if (live) {
      // Dropping the src is what actually closes the connection when this tile stops streaming.
      const element = image.current;
      return () => element?.setAttribute("src", "");
    }
    const timer = setInterval(() => setTick((value) => value + 1), TILE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [id, live]);

  return (
    <>
      {!hasFrame && <EmptyImage />}
      <img
        ref={image}
        className={styles.feedImage}
        style={hasFrame ? undefined : { display: "none" }}
        src={live ? streamUrl(id) : snapshotUrl(id, tick)}
        alt={`${id} camera`}
        onLoad={() => setHasFrame(true)}
      />
    </>
  );
}

/** The expanded viewer: one long-lived MJPEG response, decoded by the browser as it arrives. */
function LiveFeed({ id }: { id: string }) {
  const image = useRef<HTMLImageElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setHasFrame(false);
    const element = image.current;
    // Dropping the src is what actually closes the connection when the viewer moves on.
    return () => element?.setAttribute("src", "");
  }, [id]);

  return (
    <>
      {!hasFrame && <EmptyImage />}
      <img
        ref={image}
        className={styles.feedImage}
        style={hasFrame ? undefined : { display: "none" }}
        src={streamUrl(id)}
        alt={`${id} camera`}
        onLoad={() => setHasFrame(true)}
      />
    </>
  );
}

function EmptyImage() {
  return <span className={styles.emptyImage}><ImageIcon /><span>No image received</span></span>;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  const paths = { left: "m14.5 4-8 8 8 8", right: "m9.5 4 8 8-8 8" };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[direction]} /></svg>;
}

function ImageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="1" /><circle cx="8.5" cy="9" r="1.4" /><path d="m4 17 4.8-4.8 3.15 3.15 2.25-2.25L20 19" /></svg>;
}
