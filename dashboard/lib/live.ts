/** The mod's live world feed, as it reaches the browser. */

const BASE = "/backend";

export interface LiveDrone {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** where it is flying, or null when it is holding position */
  target: [number, number, number] | null;
}

/** Sent once when a stream opens, and again on every heartbeat. */
export interface LiveSnapshot {
  dimension: string;
  /** identifies one run of the world; a change means the overlay is about somewhere else */
  session: string;
  origin_x: number;
  origin_z: number;
  width: number;
  height: number;
  chunks: number;
  hot: number;
  /** the burning columns, so a reloading dashboard can restore the glow */
  fires: [number, number][];
  drones: LiveDrone[];
  tick: number;
  /** seconds since the mod last pushed, or null if it never has */
  age: number | null;
  live: boolean;
}

/** One batch of changes. `columns` is flat: x, z, packed, x, z, packed... */
export interface LiveDelta {
  dimension: string;
  session: string;
  columns: number[];
  drones: LiveDrone[];
  hot: number;
  tick: number;
}

export const DIMENSION = "minecraft:overworld";

/** Everything the feed has seen so far, as one RGBA image. */
export const liveMapUrl = (dimension = DIMENSION) =>
  `${BASE}/api/world/live.png?dimension=${encodeURIComponent(dimension)}&t=${Date.now()}`;

export const streamUrl = (dimension = DIMENSION) =>
  `${BASE}/api/world/stream?dimension=${encodeURIComponent(dimension)}`;

export async function getLive(dimension = DIMENSION): Promise<LiveSnapshot> {
  const res = await fetch(`${BASE}/api/live?dimension=${encodeURIComponent(dimension)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/live -> ${res.status}`);
  return res.json();
}

/** Sends a real drone somewhere. The mod collects the order on its next feed push. */
export async function sendDroneTo(id: string, x: number, y: number, z: number) {
  const res = await fetch(`${BASE}/api/drones/goto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, x, y, z }),
  });
  if (!res.ok) throw new Error(`goto -> ${res.status}`);
  return res.json() as Promise<{ ok: boolean; queued: number }>;
}

/** Minecraft-style stick in the drone's camera frame. Hold to fly; send zeros or hover to stop. */
export async function sendDroneFly(
  id: string,
  stick: { forward?: number; right?: number; up?: number; yaw?: number },
) {
  const res = await fetch(`${BASE}/api/drones/fly`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...stick }),
  });
  if (!res.ok) throw new Error(`fly -> ${res.status}`);
  return res.json() as Promise<{ ok: boolean; queued: number }>;
}

/** Brakes the drone and holds wherever it is. */
export async function sendDroneHover(id: string) {
  const res = await fetch(`${BASE}/api/drones/hover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`hover -> ${res.status}`);
  return res.json() as Promise<{ ok: boolean; queued: number }>;
}
