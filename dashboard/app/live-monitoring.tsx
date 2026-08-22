"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./live-monitoring.module.css";
import { AREAS, type Filter } from "./drones";
import { CameraIcon, Chevron } from "./icons";
import DroneControls from "./drone-controls";
import DroneEventWindow from "./drone-event-window";
import FeedOverlay from "./feed-overlay";
import FleetComms from "./fleet-comms";
import FlightTelemetry, { type DroneTrailPoint } from "./flight-telemetry";
import { ROLE_LIST, callsignOf, roleOf } from "@/lib/roles";
import { detailSizeFor, streamUrl, type Profile, type Size } from "@/lib/cameras";
import type { Connection } from "@/lib/camera-feed";
import { useDroneFrame, useFeed, useRoster, type Drone } from "@/lib/use-cameras";

/**
 * How much of a feed a tile is asking for.
 *
 * `still` is the grid default: this drone's share of the multiplexed feed, at the grid's rate.
 * `stream` is this drone's own MJPEG response, running as fast as the agent renders it, which is
 * worth its own connection only for a feed somebody is actually watching. `off` keeps the last
 * frame on screen and asks for nothing - which is also what takes the drone off the shared feed,
 * so a grid hidden behind the viewer costs nothing.
 */
type FeedMode = "off" | "still" | "stream";

type LiveMonitoringProps = {
  /** A drone the map has handed over, as a fresh object per request so repeats still land. */
  request: { id: string } | null;
  /** Called when a feed's shutter has opened a report, so the dashboard can go and show it. */
  onReport?: (incidentId: string) => void;
};

export default function LiveMonitoring({ request, onReport }: LiveMonitoringProps) {
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Held by id, not by object: the roster is replaced wholesale every time it changes, so
  // anything remembered by reference would be stale a moment later.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controllingId, setControllingId] = useState<string | null>(null);
  const handledRequest = useRef<{ id: string } | null>(null);
  const trailCache = useRef<Record<string, DroneTrailPoint[]>>({});
  const [trails, setTrails] = useState<Record<string, DroneTrailPoint[]>>({});

  // One connection carries the roster and every frame, so nothing here has a rate to choose.
  // Flying by hand needs no special handling either: the stream already carries the mod's own
  // positions about five times a second.
  const { connection, error } = useFeed();
  const { drones, reachable, online } = useRoster();

  // Keep recent flight history even while another feed is selected. A point only enters when the
  // drone has moved far enough to make the line useful; a later point at the same location is a
  // meaningful stop rather than redundant noise.
  useEffect(() => {
    const now = Date.now();
    let changed = false;
    for (const drone of drones) {
      const trail = trailCache.current[drone.id] ?? [];
      const last = trail.at(-1);
      const distance = last ? Math.hypot(drone.x - last.x, drone.z - last.z) : Infinity;
      if (!last || distance >= 0.45 || now - last.at >= 4_000) {
        trail.push({ x: drone.x, z: drone.z, at: now, stopped: Boolean(last && distance < 0.45) });
        trailCache.current[drone.id] = trail.slice(-48);
        changed = true;
      }
    }
    if (changed) {
      setTrails(Object.fromEntries(Object.entries(trailCache.current)
        .map(([id, trail]) => [id, [...trail]])));
    }
  }, [drones]);

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
  // request can land a push or two before the drone it names does.
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
                  {areaDrones.map((drone) => {
                    const role = roleOf(drone.id);
                    return <button key={drone.id} data-active={focusedId === drone.id} type="button"
                      title={`${drone.id} - ${role.name}: ${role.tagline}`}
                      style={{ "--role": role.color } as React.CSSProperties}
                      onClick={() => {
                        setActiveFilter(area);
                        setFocusedId(drone.id);
                        setSelectedId(null);
                      }}>
                      <i /><CameraIcon />
                      <span className={styles.droneName}>{callsignOf(drone.id)}</span>
                      <span className={styles.roleTag}>{role.code}</span>
                    </button>;
                  })}
                </div>
              </section>;
            })}
            <FleetComposition drones={drones} />
            <FeedState connection={connection} error={error} />
            <FleetComms drones={drones} />
          </nav>}
        </aside>

        <section className={styles.grid} data-focused={Boolean(focusedDrone)} data-count={visibleDrones.length} aria-label="Drone camera feeds">
          {visibleDrones.map((drone) => (
            <article className={styles.feed} key={drone.id}>
              <div className={styles.viewport}>
                {/* Singled out from the sidebar there is only this one tile, so it can afford the
                    connection a stream costs - and flying by hand needs every frame it can get. */}
                <Feed
                  id={drone.id}
                  live={drone.live}
                  mode={selectedId !== null ? "off" : focusedDrone?.id === drone.id ? "stream" : "still"}
                />
                {/* Opening the feed is the whole picture's job, so the target is the picture -
                    but it has to be a sibling of the HUD rather than its parent, because a
                    button inside a button is not a thing a browser will honour. */}
                <FeedOverlay
                  drone={drone}
                  variant={focusedDrone?.id === drone.id && selectedId === null ? "focus" : "tile"}
                />
                <button className={styles.open} type="button" aria-label={`Open ${drone.id} feed`} onClick={() => setSelectedId(drone.id)} />
                <DroneEventWindow droneId={drone.id} compact />
                {/* The overlay owns the controls once it is open, so only ever one panel is
                    listening for the keys. */}
                {focusedDrone?.id === drone.id && selectedId === null && (
                  <>
                    <FlightTelemetry drone={drone} trail={trails[drone.id] ?? []} />
                    <DroneControls
                      compact
                      drone={drone}
                      controlling={controllingId === drone.id}
                      onToggleControl={toggleControl(drone.id)}
                      onReport={onReport}
                    />
                  </>
                )}
              </div>
            </article>
          ))}
          {visibleDrones.length === 0 && (
            <p className={styles.notice}>
              {!reachable
                ? "No answer from the server. Start it with ./server.py."
                : !online
                  ? "The server cannot reach any agent - Minecraft is not running, or the fleet is still starting."
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
              <Feed id={selectedDrone.id} mode="stream" live={selectedDrone.live} />
              {/* Where it is, what it is for, and what the agent is rendering it at all live on
                  the head-up display now, rather than on a strip underneath the picture. */}
              <FeedOverlay drone={selectedDrone} variant="viewer" />
              <DroneEventWindow droneId={selectedDrone.id} />
              <DroneControls
                drone={selectedDrone}
                controlling={controllingId === selectedDrone.id}
                onToggleControl={toggleControl(selectedDrone.id)}
                onReport={onReport}
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

/**
 * What the fleet is made of, at a glance.
 *
 * Roles are worked out from the drone ids rather than assigned by anyone, so the mix is whatever
 * happens to be in the air - which is exactly the thing an operator wants to know before sending
 * anyone anywhere. Four surveyors and no suppression is a fleet that can watch a fire burn.
 */
function FleetComposition({ drones }: { drones: Drone[] }) {
  if (drones.length === 0) return null;
  const counts = new Map<string, number>();
  for (const drone of drones) {
    const role = roleOf(drone.id);
    counts.set(role.id, (counts.get(role.id) ?? 0) + 1);
  }

  return (
    <div className={styles.composition} aria-label="Fleet composition">
      {ROLE_LIST.filter((role) => counts.has(role.id)).map((role) => (
        <span key={role.id} className={styles.compositionRole}
              style={{ "--role": role.color } as React.CSSProperties}
              title={`${counts.get(role.id)} x ${role.name} - ${role.tagline}`}>
          <i />{role.code}<b>{counts.get(role.id)}</b>
        </span>
      ))}
    </div>
  );
}

/**
 * Whether the pictures are getting here.
 *
 * There is nothing to choose any more - there is one connection and it carries everything - but
 * whether it is up is still worth a line on screen: a blank grid is either Minecraft not running
 * or the feed not arriving, and this is the half that says which. The reason for a drop is on
 * the title, because it is a developer's answer rather than an operator's.
 */
function FeedState({ connection, error }: { connection: Connection; error: string | null }) {
  const label = connection === "live" ? "Streaming"
    : connection === "retrying" ? "Reconnecting"
    : "Connecting";

  return (
    <div className={styles.feedStatus}>
      <span className={styles.feedStatusLine} data-state={connection} title={error ?? undefined}>
        <i />{label}
      </span>
    </div>
  );
}

/**
 * One drone's picture.
 *
 * <p>A fixed-ratio box with both images stacked inside it, rather than an image that decides the
 * layout. Nothing reflows when the drone's own stream takes over from the shared feed's frames,
 * and the box has a real width
 * from the first render - which is what lets the feed ask for a resolution that suits the space
 * it is actually being shown in rather than a fixed guess.
 *
 * <p>Its own MJPEG stream takes a moment to open, so the stills stay on screen underneath until
 * the first streamed frame lands, and the stream is only revealed then.
 */
function Feed({ id, mode, live }: { id: string; mode: FeedMode; live: boolean }) {
  const [streaming, setStreaming] = useState(false);
  const wantStream = mode === "stream";
  // Singled out: this is the picture somebody is actually looking at, so it is worth the agent
  // rendering this one drone properly rather than at its share of a thumbnail wall.
  const profile: Profile | undefined = wantStream ? "detail" : undefined;
  const { image: still, ready } = useDroneFrame(id, mode !== "off" && !streaming);
  const box = useRef<HTMLDivElement>(null);
  const stream = useRef<HTMLImageElement>(null);
  const size = useFeedSize(box, wantStream);

  useEffect(() => {
    setStreaming(false);
    const element = stream.current;
    // Dropping the src is what actually closes the connection when this feed stops streaming.
    return () => element?.setAttribute("src", "");
  }, [id, wantStream, size]);

  // Nothing has painted, so the box is black. Black on its own is indistinguishable from a
  // camera pointed at a cave, from a drone that has crashed, and from a dashboard that is
  // broken - so it says which it is.
  const blank = !ready && !streaming;

  return (
    <div className={styles.feedBox} ref={box}>
      {blank && <FeedWaiting id={id} live={live} detail={wantStream} />}
      {/* A picture that has stopped arriving is worse than no picture: it is a stale picture
          that looks current. The last frame stays - it is still the best information there is
          about where that drone was - but it is dimmed and labelled. */}
      {!blank && !live && (
        <span className={styles.lostBanner}><i />Feed lost &middot; reconnecting</span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- frames are painted onto this by hand */}
      <img
        ref={still}
        className={styles.feedImage}
        data-stale={!live}
        style={{ opacity: ready && !streaming ? 1 : 0 }}
        alt={`${id} camera`}
      />
      {wantStream && size && (
        <img
          ref={stream}
          className={styles.feedImage}
          data-stale={!live}
          style={{ opacity: streaming ? 1 : 0 }}
          src={streamUrl(id, profile, size)}
          alt={`${id} camera`}
          onLoad={() => setStreaming(true)}
        />
      )}
    </div>
  );
}


/**
 * What a black tile says while there is nothing to show.
 *
 * Which of these is true matters, because the fixes are different: a drone the server has never
 * heard from is a fleet problem, and a drone on the roster that has not yet rendered is just the
 * agent warming up and needs nothing but a moment.
 */
function FeedWaiting({ id, live, detail }: { id: string; live: boolean; detail: boolean }) {
  return (
    <div className={styles.waiting}>
      <span className={styles.waitingPulse} aria-hidden="true" />
      <strong>{live ? "Waiting for the feed" : "No signal"}</strong>
      <span>
        {!live
          ? `${id} is on the roster but not sending frames`
          : detail
            ? "Opening this drone’s own stream"
            : `${id} has not rendered its first frame yet`}
      </span>
    </div>
  );
}

/**
 * The resolution to ask this feed for, from the space it is being shown in.
 *
 * <p>A 1280-wide frame stretched across a 2000-pixel panel is soft, and a 1600-wide one squeezed
 * into a thumbnail is bytes nobody sees. Measured once the box has a width, snapped to a short
 * list of steps, and only changed when it crosses one - a stream has to be reopened to change
 * resolution, so a window being dragged must not reopen it on every frame.
 */
function useFeedSize(box: React.RefObject<HTMLDivElement | null>, active: boolean) {
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    if (!active) {
      setSize(null);
      return;
    }
    const element = box.current;
    if (!element) return;

    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) setSize((current) => {
        const next = detailSizeFor(width);
        return current && current.width === next.width ? current : next;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, active]);

  return size;
}
