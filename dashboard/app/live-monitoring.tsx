"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./live-monitoring.module.css";
import { AREAS, type Filter } from "./drones";
import { CameraIcon, Chevron, EmptyImage } from "./icons";
import DroneControls from "./drone-controls";
import { detailSizeFor, streamUrl, type Profile, type Size } from "@/lib/cameras";
import { pauseFrames } from "@/lib/frames";
import type { Connection } from "@/lib/camera-feed";
import { useDroneFrame, useRoster, useTransport, type Transport } from "@/lib/use-cameras";

/**
 * How much of a feed a tile is asking for.
 *
 * `still` is the grid default: whatever the transport in use delivers at the grid's rate - a
 * share of the multiplexed stream, or a fetched frame. `stream` is this drone's own MJPEG
 * response, running as fast as the agent renders it, which is worth its own connection only for
 * a feed somebody is actually watching. `off` keeps the last frame on screen and asks for
 * nothing.
 */
type FeedMode = "off" | "still" | "stream";

type LiveMonitoringProps = {
  /** A drone the map has handed over, as a fresh object per request so repeats still land. */
  request: { id: string } | null;
};

export default function LiveMonitoring({ request }: LiveMonitoringProps) {
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Held by id, not by object: the roster is replaced wholesale every time it changes, so
  // anything remembered by reference would be stale a moment later.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controllingId, setControllingId] = useState<string | null>(null);
  const handledRequest = useRef<{ id: string } | null>(null);

  // Streaming by default; polling is the fallback, and a switch the operator can throw.
  const { transport, preferred, choose, connection, error } = useTransport();
  // Flying by hand needs a fresher position than a wall of thumbnails does - which only the
  // polling path has to be told, since the stream already carries the mod's own positions.
  const { drones, reachable, online } = useRoster(transport, controllingId !== null);

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
            <TransportSwitch preferred={preferred} transport={transport}
                             connection={connection} error={error} onChoose={choose} />
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
                  transport={transport}
                  mode={selectedId !== null ? "off" : focusedDrone?.id === drone.id ? "stream" : "still"}
                />
                {/* Opening the feed is the whole picture's job, so the target is the picture -
                    but it has to be a sibling of the HUD rather than its parent, because a
                    button inside a button is not a thing a browser will honour. */}
                <button className={styles.open} type="button" aria-label={`Open ${drone.id} feed`} onClick={() => setSelectedId(drone.id)} />
                <span className={styles.feedLabel}>{drone.id}</span>
                {/* The overlay owns the controls once it is open, so only ever one panel is
                    listening for the keys. */}
                {focusedDrone?.id === drone.id && selectedId === null && (
                  <DroneControls
                    compact
                    drone={drone}
                    controlling={controllingId === drone.id}
                    onToggleControl={toggleControl(drone.id)}
                  />
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
              <Feed id={selectedDrone.id} mode="stream" transport={transport} />
              {/* Where it is, and what the agent is actually rendering it at - which goes up
                  while this is the feed on screen and drops back on its own once it closes. */}
              <span className={styles.readout}>
                {Math.round(selectedDrone.x)}, {Math.round(selectedDrone.y)}, {Math.round(selectedDrone.z)}
                <b data-detail={selectedDrone.detail === true}>
                  {selectedDrone.width}×{selectedDrone.height} · {selectedDrone.fps} fps
                </b>
              </span>
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

/**
 * How the pictures are getting here, and a switch to change it.
 *
 * <p>Worth having on screen rather than buried in a setting: streaming and polling fail in
 * different ways, and being able to put the dashboard on the dumb transport is the quickest way
 * to find out whether a blank grid is Minecraft's fault or the stream's.
 */
function TransportSwitch({ preferred, transport, connection, error, onChoose }: {
  preferred: Transport;
  transport: Transport;
  connection: Connection;
  error: string | null;
  onChoose: (next: Transport) => void;
}) {
  // Asked for the stream and got polling: it dropped out from under us, and that is worth saying.
  const fellBack = preferred === "stream" && transport === "poll";
  const label = fellBack
    ? "Stream unavailable - polling"
    : transport === "stream"
      ? connection === "live" ? "Streaming" : "Connecting"
      : "Polling";

  return (
    <div className={styles.transport}>
      <span className={styles.transportState} data-state={fellBack ? "failed" : connection}
            title={error ?? undefined}>
        <i />{label}
      </span>
      <div className={styles.transportChoice} role="group" aria-label="Camera transport">
        {(["stream", "poll"] as const).map((option) => (
          <button key={option} type="button" data-active={preferred === option}
                  aria-pressed={preferred === option} onClick={() => onChoose(option)}>
            {option === "stream" ? "Stream" : "Poll"}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One drone's picture.
 *
 * <p>A fixed-ratio box with both images stacked inside it, rather than an image that decides the
 * layout. Nothing reflows when a stream takes over from the stills, and the box has a real width
 * from the first render - which is what lets the feed ask for a resolution that suits the space
 * it is actually being shown in rather than a fixed guess.
 *
 * <p>Its own MJPEG stream takes a moment to open, so the stills stay on screen underneath until
 * the first streamed frame lands, and the stream is only revealed then.
 */
function Feed({ id, mode, transport }: { id: string; mode: FeedMode; transport: Transport }) {
  const [streaming, setStreaming] = useState(false);
  const wantStream = mode === "stream";
  // Singled out: this is the picture somebody is actually looking at, so it is worth the agent
  // rendering this one drone properly rather than at its share of a thumbnail wall.
  const profile: Profile | undefined = wantStream ? "detail" : undefined;
  const { image: still, ready } = useDroneFrame(id, mode !== "off" && !streaming, transport, wantStream, profile);
  const box = useRef<HTMLDivElement>(null);
  const stream = useRef<HTMLImageElement>(null);
  const size = useFeedSize(box, wantStream);

  useEffect(() => {
    setStreaming(false);
    const element = stream.current;
    // Dropping the src is what actually closes the connection when this feed stops streaming.
    return () => element?.setAttribute("src", "");
  }, [id, wantStream, size]);

  return (
    <div className={styles.feedBox} ref={box}>
      {!ready && !streaming && (
        <EmptyImage label={wantStream ? "Connecting to the feed" : "Waiting for the first frame"} />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- frames are painted onto this by hand */}
      <img
        ref={still}
        className={styles.feedImage}
        style={{ opacity: ready && !streaming ? 1 : 0 }}
        alt={`${id} camera`}
      />
      {wantStream && size && (
        <img
          ref={stream}
          className={styles.feedImage}
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
