"use client";

/**
 * What the fleet can see, shared by everything that draws an instrument over a picture.
 *
 * The world feed already carries the burning columns and every drone's position, but it carries
 * them to the map, on the map's own streaming connection, inside the map's component. The camera
 * wall needs the same facts to put a box round a fire on the video - and it needs them once,
 * not once per tile: a wall of twelve overlays each polling the world would be twelve copies of
 * an eight-thousand-entry fire list every few seconds.
 *
 * So this is one poller behind a subscription. It runs only while something is listening, it
 * clusters the raw columns into hotspots before anyone sees them, and every overlay reads the
 * same snapshot. Nothing here commands anything; it is the intelligence picture, not the fleet.
 */

import { useEffect, useState } from "react";
import { getLive, type LiveDrone } from "./live";
import type { GridBounds } from "./risk";

/** Slow on purpose: a fire front does not move meaningfully inside three seconds. */
const POLL_MS = 3_000;

/** After a failure, back off rather than hammering a server that is plainly not there. */
const RETRY_MS = 6_000;

/** Burning columns are merged into cells this wide, in blocks, before anything is drawn. */
const CLUSTER = 14;

/** A fire is a fire; past this many clusters the HUD is noise rather than information. */
const MAX_HOTSPOTS = 48;

/** A run of burning columns treated as one thing worth flying to. */
export interface Hotspot {
  x: number;
  z: number;
  /** burning columns inside the cluster, which is what the HUD calls intensity */
  columns: number;
  /** rough radius in blocks, from how many columns are alight */
  radius: number;
}

export interface Intel {
  hotspots: Hotspot[];
  /** every drone the mod knows about, which is how a relay finds its peers */
  drones: LiveDrone[];
  /**
   * The area the feed covers, which is the same frame the risk grid is cut from.
   *
   * Carried here so the Predictions map can bin the live drones onto its own grid without a
   * second poll of the world - and, more to the point, onto the *same* grid the report was
   * built against, so the aircraft a cell lists are the aircraft that cell was scored with.
   */
  bounds: GridBounds | null;
  /** burning columns in the whole world, not just the clustered ones */
  hot: number;
  /** whether the mod is actually pushing, rather than the server serving a stale snapshot */
  live: boolean;
  /** false until the first answer, so an overlay can say "acquiring" rather than "no fires" */
  known: boolean;
}

const EMPTY: Intel = { hotspots: [], drones: [], bounds: null, hot: 0, live: false, known: false };

let current: Intel = EMPTY;
const listeners = new Set<(intel: Intel) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/**
 * Folds the raw burning columns into clusters.
 *
 * A grid rather than a real clustering pass: the columns arrive sorted and in the thousands, and
 * anything that compares points to each other is quadratic on exactly the input that matters -
 * a fire that has got away. Snapping to a cell and averaging inside it is one pass and reads the
 * same on screen.
 */
function cluster(fires: [number, number][]): Hotspot[] {
  const cells = new Map<string, { x: number; z: number; columns: number }>();
  for (const [x, z] of fires) {
    const key = `${Math.floor(x / CLUSTER)}:${Math.floor(z / CLUSTER)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.x += x;
      cell.z += z;
      cell.columns += 1;
    } else {
      cells.set(key, { x, z, columns: 1 });
    }
  }

  return [...cells.values()]
    .sort((a, b) => b.columns - a.columns)
    .slice(0, MAX_HOTSPOTS)
    .map((cell) => ({
      x: cell.x / cell.columns,
      z: cell.z / cell.columns,
      columns: cell.columns,
      // area grows with the count, so the radius is its root - a cluster twice as wide is four
      // times the columns, and a bare linear radius would draw a scratch fire the size of a town
      radius: Math.max(3, Math.min(CLUSTER, Math.sqrt(cell.columns) * 1.6)),
    }));
}

function publish(next: Intel) {
  current = next;
  for (const listener of listeners) listener(next);
}

async function poll() {
  if (!running) return;
  try {
    const snapshot = await getLive();
    if (!running) return;
    publish({
      hotspots: cluster(snapshot.fires ?? []),
      drones: snapshot.drones ?? [],
      bounds: snapshot.width > 0 && snapshot.height > 0
        ? { origin_x: snapshot.origin_x, origin_z: snapshot.origin_z,
            width: snapshot.width, height: snapshot.height }
        : null,
      hot: snapshot.hot ?? 0,
      live: snapshot.live,
      known: true,
    });
    timer = setTimeout(poll, POLL_MS);
  } catch {
    if (!running) return;
    // The overlays keep the last picture rather than blanking: an instrument that empties on a
    // dropped poll looks like the fire went out.
    publish({ ...current, live: false });
    timer = setTimeout(poll, RETRY_MS);
  }
}

function subscribe(listener: (intel: Intel) => void) {
  listeners.add(listener);
  listener(current);
  if (!running) {
    running = true;
    void poll();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    running = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/** The shared intelligence picture. Polling starts with the first caller and stops with the last. */
export function useIntel(active = true): Intel {
  const [intel, setIntel] = useState<Intel>(current);
  useEffect(() => (active ? subscribe(setIntel) : undefined), [active]);
  return active ? intel : current;
}

/** The hotspots within `range` blocks of a point, nearest first. */
export function hotspotsNear(hotspots: Hotspot[], x: number, z: number, range = 260, limit = 8) {
  return hotspots
    .map((hotspot) => ({ hotspot, distance: Math.hypot(hotspot.x - x, hotspot.z - z) }))
    .filter((entry) => entry.distance <= range)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}
