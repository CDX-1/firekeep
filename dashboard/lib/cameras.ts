import type { DroneCamera, DroneArea } from "./types";

/** Everything goes through the /camera rewrite in next.config.ts. */
const BASE = "/camera";

/** How often the roster is re-read, so a drone that just took off shows up on its own. */
export const ROSTER_INTERVAL_MS = 1000;
/** Fallback rate for tiles that could not get a live stream; see MAX_LIVE_TILES. */
export const TILE_INTERVAL_MS = 250;

/**
 * How many grid tiles get a real MJPEG stream.
 *
 * <p>Browsers allow six concurrent connections to one origin, and every open stream holds one for
 * as long as it is on screen. Four leaves room for the roster poll and for the expanded viewer's
 * own stream; tiles past that fall back to polling single frames, which is choppy but does not
 * starve the rest of the page.
 */
export const MAX_LIVE_TILES = 4;

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
