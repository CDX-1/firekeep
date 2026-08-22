"use client";

/**
 * The camera hooks.
 *
 * One connection carries the roster and every frame, and the page paints when Minecraft
 * renders. There used to be a second transport beside it - a GET per tile per refresh, with a
 * fairness queue in front of it and a timer on the roster - kept as a fallback and as a way of
 * finding out whether a blank grid was the stream's fault. It is gone: it was a second code
 * path for every tile that was almost never exercised, and a wall of thumbnails fetched one at
 * a time was never a dashboard anybody wanted to look at.
 *
 * So a dropped stream now reconnects rather than degrading, and the page has one way of getting
 * a picture. What is left here is the React shape over lib/camera-feed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraFeed, type Connection, type FeedStatus } from "./camera-feed";
import { areaOf, type Roster } from "./cameras";
import type { DroneArea, DroneCamera } from "./types";

export type Drone = DroneCamera & { area: DroneArea };

export interface RosterState {
  drones: Drone[];
  /** The Python server answered. False means the dashboard's own backend is down. */
  reachable: boolean;
  /** The Python server reached at least one agent. False means Minecraft is not running. */
  online: boolean;
  clientFps: number;
}

const EMPTY: RosterState = { drones: [], reachable: false, online: false, clientFps: 0 };

function withAreas(roster: Roster): RosterState {
  return {
    drones: roster.drones.map((drone) => ({ ...drone, area: areaOf(drone) })),
    reachable: true,
    online: roster.online,
    clientFps: roster.clientFps,
  };
}

/**
 * The state of the one connection everything on the page is drawn from.
 *
 * Worth having on screen rather than buried: a grid that has gone blank is either Minecraft not
 * running or the stream not arriving, and those are different problems with different fixes.
 */
export function useFeed() {
  const [status, setStatus] = useState<FeedStatus>({
    connection: "connecting", online: false, agents: 0, clientFps: 0, error: null,
  });

  useEffect(() => cameraFeed.onStatus(setStatus), []);

  // The feed opens with the page and closes with it; nothing else turns it on or off.
  useEffect(() => {
    cameraFeed.open();
    return () => cameraFeed.close();
  }, []);

  return { connection: status.connection as Connection, error: status.error,
           online: status.online, agents: status.agents, clientFps: status.clientFps };
}

/**
 * The live roster.
 *
 * Pushed as the server notices it change - including the positions, which it merges from the
 * mod's own feed several times a second. Nothing here has a timer in it, which is why flying a
 * drone by hand stays smooth without anything having to be told that somebody is flying.
 */
export function useRoster(): RosterState {
  const [state, setState] = useState<RosterState>(EMPTY);
  useEffect(() => cameraFeed.onRoster((roster) => setState(withAreas(roster))), []);
  return state;
}

/**
 * The newest picture for one drone, painted straight onto an `<img>`.
 *
 * <p>The element is written to directly rather than through React state. A feed at 60 frames a
 * second is 60 renders a second per tile otherwise, and a wall of tiles multiplies that - React
 * reconciling twelve components sixty times a second is real work, and it is work done between
 * the frame arriving and the frame appearing. Setting `src` on an element we already hold is the
 * whole job, so the hook re-renders exactly once, when the first frame lands and the placeholder
 * can go.
 *
 * <p>Object URLs are released two frames behind, which is well after the browser has decoded
 * them and avoids leaking one per frame - at 60fps the old "revoke in two seconds" left a hundred
 * and twenty alive at any moment.
 */
export function useDroneFrame(id: string, active: boolean) {
  const image = useRef<HTMLImageElement | null>(null);
  const shown = useRef<string | null>(null);
  const stale = useRef<string | null>(null);
  const painted = useRef(false);
  const [ready, setReady] = useState(false);

  const release = useCallback(() => {
    for (const url of [shown.current, stale.current]) {
      if (url) URL.revokeObjectURL(url);
    }
    shown.current = stale.current = null;
  }, []);

  const paint = useCallback((frame: Blob) => {
    const element = image.current;
    if (!element) return;

    const url = URL.createObjectURL(frame);
    // Two frames back has certainly been decoded; letting it go now keeps at most two alive.
    if (stale.current) URL.revokeObjectURL(stale.current);
    stale.current = shown.current;
    shown.current = url;
    element.src = url;

    if (!painted.current) {
      painted.current = true;
      setReady(true);
    }
  }, []);

  // A different drone starts blank rather than showing the last one's picture.
  useEffect(() => {
    painted.current = false;
    setReady(false);
    image.current?.removeAttribute("src");
    release();
    return release;
  }, [id, release]);

  // Registering interest is what makes the server pull this drone off Minecraft at all, so a
  // tile that stops showing a picture stops costing one.
  useEffect(() => {
    if (!active) return;
    const want = cameraFeed.want(id);
    const off = cameraFeed.onFrame(id, paint);
    return () => {
      off();
      want();
    };
  }, [id, active, paint]);

  return { image, ready };
}
