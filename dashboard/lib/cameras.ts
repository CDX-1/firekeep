import type { DroneCamera, DroneArea } from "./types";

/** Everything goes through the /camera rewrite in next.config.ts. */
const BASE = "/camera";

/** How often the roster is re-read, so a drone that just took off shows up on its own. */
export const ROSTER_INTERVAL_MS = 1000;

/**
 * The roster rate while somebody is flying a drone by hand.
 *
 * Each order aims a step ahead of where the drone is, so how fresh that position is decides how
 * smoothly a held key flies. Once a second is fine for a wall of thumbnails and much too coarse
 * for flying; this is one small JSON request, and only while a drone is actually being flown.
 */
export const ROSTER_CONTROL_INTERVAL_MS = 250;
/**
 * How long a grid tile waits after painting before asking for another frame.
 *
 * This is a courtesy gap, not the real limit: how fast tiles actually refresh is set by the
 * shared queue in lib/frames, which is what keeps a wall of them from starving each other.
 */
export const TILE_INTERVAL_MS = 150;

/** The live roster. Throws if the Minecraft client is not running. */
export async function getDrones(signal?: AbortSignal): Promise<DroneCamera[]> {
  const res = await fetch(`${BASE}/drones`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`/drones -> ${res.status}`);
  const body = (await res.json()) as { drones?: DroneCamera[] };
  return body.drones ?? [];
}

/**
 * MJPEG, for an `<img>` that should stay live.
 *
 * <p>Served by the dashboard itself, which proxies whichever agent is filming this drone, so the
 * browser only ever talks to one origin however many agents are running.
 */
export const streamUrl = (id: string) => `${BASE}/drones/${encodeURIComponent(id)}/stream`;

/** The newest single frame. `tick` busts the cache; without it the browser reuses the first frame. */
export const snapshotUrl = (id: string, tick: number) =>
  `${BASE}/drones/${encodeURIComponent(id)}/frame.jpg?t=${tick}`;

/**
 * Which quarter of the world a drone is flying over, measured from the world origin - in Minecraft
 * north is -Z and east is +X.
 */
export function areaOf(drone: { x: number; z: number }): DroneArea {
  const north = drone.z < 0;
  const east = drone.x >= 0;
  if (north) return east ? "Northeast" : "Northwest";
  return east ? "Southeast" : "Southwest";
}
