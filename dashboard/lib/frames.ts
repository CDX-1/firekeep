/**
 * Fair, bounded fetching of the grid's still frames - the polling transport's half of the page.
 *
 * Nothing here runs while the dashboard is streaming: the multiplexed feed in lib/camera-feed
 * delivers every tile's frames down one connection, which is what this whole queue exists to
 * work around. It is what the page falls back to, and none of the below stops being true then.
 *
 * A browser opens about six connections to one origin, and a cold `/frame.jpg` holds one for
 * up to a second while the agent renders that drone's first frame. A wall of tiles left to
 * fetch on their own therefore starves itself: the tiles that lose the race never paint at
 * all, and only start working once something else lets a connection go - which is why a tile
 * would stay blank until you clicked another one.
 *
 * So tiles do not fetch whenever they like; they take turns. At most {@link MAX_IN_FLIGHT}
 * requests are outstanding across the whole page, and waiting tiles are served in order, so
 * every tile paints and keeps refreshing. That also leaves connections spare for the roster
 * poll and for the expanded viewer's stream, which is the one the operator is looking at.
 */

import { snapshotUrl, type Profile } from "./cameras";

/**
 * How many still frames may be loading at once.
 *
 * Three leaves room in the browser's per-origin budget for the roster poll and the expanded
 * viewer's long-lived stream, which must never have to queue behind a wall of thumbnails.
 */
export const MAX_IN_FLIGHT = 3;

type Waiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
  /** The expanded viewer's own still, which must never wait behind a wall of thumbnails. */
  priority: boolean;
};

const waiting: Waiter[] = [];
let active = 0;
let paused = false;

function abortError() {
  return new DOMException("aborted", "AbortError");
}

function pump() {
  while (active < MAX_IN_FLIGHT && waiting.length > 0) {
    // Pausing is about the grid. A priority request is the drone somebody is looking at, so
    // it goes through regardless - pausing for it would be starving the one that matters.
    if (paused && !waiting[0].priority) return;
    const next = waiting.shift()!;
    next.signal.removeEventListener("abort", next.onAbort);
    active++;
    next.resolve();
  }
}

/** Waits for a turn. Every resolved acquire must be matched by exactly one release. */
function acquire(signal: AbortSignal, priority: boolean): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal, onAbort: () => {}, priority };
    waiter.onAbort = () => {
      const at = waiting.indexOf(waiter);
      if (at >= 0) waiting.splice(at, 1);
      reject(abortError());
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    // Priority requests go to the head; among equals it stays first come, first served.
    if (priority) waiting.unshift(waiter); else waiting.push(waiter);
    pump();
  });
}

function release() {
  active = Math.max(0, active - 1);
  pump();
}

/**
 * Stops handing out turns to the grid.
 *
 * Used while the expanded viewer is open: the tiles are behind a full-screen overlay, so they
 * have nothing to show and no business holding connections the viewer needs. Priority requests
 * still go through, and anything already in flight is left to finish on its own.
 */
export function pauseFrames(value: boolean) {
  paused = value;
  if (!paused) pump();
}

/** One still frame for a drone, once this caller's turn comes round. */
export async function fetchFrame(
  id: string,
  signal: AbortSignal,
  priority = false,
  profile?: Profile,
): Promise<Blob> {
  await acquire(signal, priority);
  try {
    // The agent serves the newest frame it has; the timestamp is only here to defeat caches.
    const res = await fetch(snapshotUrl(id, Date.now(), profile), { cache: "no-store", signal });
    if (!res.ok) throw new Error(`frame for ${id} -> ${res.status}`);
    return await res.blob();
  } finally {
    release();
  }
}

/** For tests and diagnostics: what the queue is doing right now. */
export function frameQueueState() {
  return { active, waiting: waiting.length, paused };
}
