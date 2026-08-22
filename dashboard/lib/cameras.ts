import type { DroneCamera, DroneArea } from "./types";

/**
 * The cameras, as the Python server serves them.
 *
 * Nothing here talks to Minecraft. Every drone is filmed by its own agent on its own port, and
 * resolving that used to be the dashboard's job - a route handler in this app fanned out to the
 * agent directory and proxied each feed. It is the Python server's job now: it is the piece
 * that already owns the world feed and the map, it holds one upstream connection per drone
 * however many dashboards are open, and keeping the game's addresses on one side of the wall
 * means a phone on the LAN needs to reach this app and nothing else.
 *
 * The server still serves the roster at `/api/cameras` and single frames at `<id>/frame.jpg`.
 * The dashboard no longer asks for either: everything on the page comes down the one feed.
 */
const BASE = "/backend/api/cameras";

/** What the server pushes down the feed as it changes. */
export interface Roster {
  drones: DroneCamera[];
  /** The slowest agent's frame rate, which is the one worth worrying about. */
  clientFps: number;
  agents: number;
  /** Whether the server could reach any agent at all. */
  online: boolean;
  watchers: number;
  revision: number;
}

/** Every camera on the page down one connection: the roster, and the frames it asks for. */
export const feedUrl = (ids: string[], fps?: number) =>
  `${BASE}/feed?ids=${encodeURIComponent(ids.join(","))}${fps ? `&fps=${fps}` : ""}`;

/**
 * How well a drone is being rendered.
 *
 * `grid` is the thumbnail wall's share of the game's frame budget. `detail` is what one drone
 * gets once somebody has singled it out - the agent renders it at 720p60 at high JPEG quality
 * instead of 480p30, which it can afford precisely because it is then rendering one feed and
 * not twelve. Asking is all the dashboard does; the numbers live on the agent.
 *
 * The request stands only while the connection asking for it is open, so closing the viewer
 * puts that drone back on thumbnails without anything having to say so.
 */
export type Profile = "grid" | "detail";

/**
 * The sizes a detail feed is asked for.
 *
 * A short list rather than the exact pixel width of the panel, because the agent keeps one
 * framebuffer per capture slot and reallocates it whenever the size changes - so an odd width per
 * viewer, or a new one on every window drag, would have it churning GPU memory instead of
 * rendering. Snapping to a few steps means a resize usually changes nothing at all.
 *
 * They stop at 1600x900 because past that the JPEG encoder, not the renderer, is the limit: a
 * 1600x900 frame costs about 46ms to encode against 29ms for 720p, which is the difference
 * between a feed that can run at 60 and one that cannot.
 */
export const DETAIL_SIZES = [
  { width: 854, height: 480 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
] as const;

export type Size = (typeof DETAIL_SIZES)[number];

/** The smallest step that still covers `cssWidth` at this screen's pixel density. */
export function detailSizeFor(cssWidth: number): Size {
  const wanted = cssWidth * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  return DETAIL_SIZES.find((size) => size.width >= wanted) ?? DETAIL_SIZES[DETAIL_SIZES.length - 1];
}

function query(profile?: Profile, size?: Size) {
  if (profile !== "detail") return "";
  const at = `?profile=detail`;
  return size ? `${at}&width=${size.width}&height=${size.height}` : at;
}

/**
 * MJPEG for one drone, for an `<img>` that should stay live.
 *
 * The feed carries the same frames without costing a connection, so this is only for the picture
 * somebody has actually singled out - not for a wall of tiles.
 */
export const streamUrl = (id: string, profile?: Profile, size?: Size) =>
  `${BASE}/${encodeURIComponent(id)}/stream${query(profile, size)}`;

/**
 * Which quarter of the world a drone is flying over, measured from the world origin - in
 * Minecraft north is -Z and east is +X.
 */
export function areaOf(drone: { x: number; z: number }): DroneArea {
  const north = drone.z < 0;
  const east = drone.x >= 0;
  if (north) return east ? "Northeast" : "Northwest";
  return east ? "Southeast" : "Southwest";
}
