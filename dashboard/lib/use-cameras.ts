"use client";

/**
 * The camera hooks, in both transports.
 *
 * Streaming is the real one: one connection carries the roster and every frame, and the page
 * paints when Minecraft renders. Polling is what the dashboard used to do - a GET per tile per
 * refresh, and a timer on the roster - and it is kept because it is the only thing that works
 * through something that will not pass a streaming response, and because being able to turn
 * the clever transport off is how you find out whether it is the thing that is broken.
 *
 * Which one is in use is a single value threaded through these hooks. Nothing else in the page
 * knows the difference.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraFeed, type Connection, type FeedStatus } from "./camera-feed";
import {
  ROSTER_CONTROL_INTERVAL_MS,
  ROSTER_INTERVAL_MS,
  TILE_INTERVAL_MS,
  areaOf,
  getRoster,
  type Profile,
  type Roster,
} from "./cameras";
import { fetchFrame } from "./frames";
import type { DroneArea, DroneCamera } from "./types";

/** How long to wait before retrying a frame the server could not give us yet. */
const FRAME_RETRY_MS = 600;

export type Transport = "stream" | "poll";
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
 * Which transport the page is using, and the state of the streaming one.
 *
 * The choice is a preference rather than a setting: asking for the stream and not getting one
 * falls back on its own, because a dashboard that shows nothing is worse than a dashboard that
 * polls. Asking for it again after that retries from scratch.
 */
export function useTransport() {
  const [preferred, setPreferred] = useState<Transport>("stream");
  const [status, setStatus] = useState<FeedStatus>({
    connection: "connecting", online: false, agents: 0, clientFps: 0, error: null,
  });

  useEffect(() => cameraFeed.onStatus(setStatus), []);

  // A stream that has given up is not worth waiting on; the tiles go back to asking.
  const transport: Transport = preferred === "stream" && status.connection !== "failed"
    ? "stream"
    : "poll";

  // Streaming is the default, so the feed opens with the page and closes with it.
  useEffect(() => {
    cameraFeed.open();
    return () => cameraFeed.close();
  }, []);

  const choose = useCallback((next: Transport) => {
    setPreferred(next);
    // The connection is driven from here rather than from an effect on `preferred`, because
    // asking for the stream after it has given up does not change `preferred` - it was
    // "stream" the whole time, and only the fallback moved. That click still has to reconnect.
    if (next === "poll") {
      cameraFeed.close();
      return;
    }
    cameraFeed.reset();
    cameraFeed.open();
  }, []);

  return { transport, preferred, choose, connection: status.connection as Connection,
           error: status.error };
}

/**
 * The live roster.
 *
 * Streaming, this arrives as the server notices it change - including the positions, which it
 * merges from the mod's own feed several times a second. Polling, it is a timer, and flying by
 * hand has to wind that timer up to stay smooth.
 */
export function useRoster(transport: Transport, flying: boolean): RosterState {
  const [state, setState] = useState<RosterState>(EMPTY);

  useEffect(() => {
    if (transport !== "stream") return;
    return cameraFeed.onRoster((roster) => setState(withAreas(roster)));
  }, [transport]);

  useEffect(() => {
    if (transport !== "poll") return;
    const intervalMs = flying ? ROSTER_CONTROL_INTERVAL_MS : ROSTER_INTERVAL_MS;
    const controller = new AbortController();
    let cancelled = false;

    const poll = async () => {
      try {
        const roster = await getRoster(controller.signal);
        if (!cancelled) setState(withAreas(roster));
      } catch {
        if (!cancelled) setState(EMPTY);
      }
    };

    void poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [transport, flying]);

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
 *
 * <p>`profile` only reaches the polling path: a still for a drone somebody has singled out is
 * worth asking for at full size, because in that mode it is the picture rather than a
 * placeholder. The streaming path takes whatever the shared feed is carrying.
 */
export function useDroneFrame(
  id: string,
  active: boolean,
  transport: Transport,
  priority = false,
  profile?: Profile,
) {
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

  // -- streaming: the frames come to us -----------------------------------
  useEffect(() => {
    if (!active || transport !== "stream") return;
    const want = cameraFeed.want(id);
    const off = cameraFeed.onFrame(id, paint);
    return () => {
      off();
      want();
    };
  }, [id, active, transport, paint]);

  // -- polling: we go and get them ----------------------------------------
  useEffect(() => {
    if (!active || transport !== "poll") return;
    const controller = new AbortController();
    let stopped = false;

    const run = async () => {
      while (!stopped) {
        try {
          const blob = await fetchFrame(id, controller.signal, priority, profile);
          if (stopped) return;
          paint(blob);
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
  }, [id, active, transport, priority, profile, paint]);

  return { image, ready };
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
