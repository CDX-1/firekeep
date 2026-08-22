/** Mirrors the roster the Fabric mod's camera server serves at /drones. */

export const DRONE_AREAS = ["Northeast", "Northwest", "Southwest", "Southeast"] as const;
export type DroneArea = (typeof DRONE_AREAS)[number];

export interface DroneCamera {
  /** The drone's id in game, or drone-<entity id> for one that was never named. */
  id: string;
  entityId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Dashboards currently holding the stream open. */
  viewers: number;
  /** What this feed is being rendered at right now, not the agent's defaults. */
  width: number;
  height: number;
  fps: number;
  /** True while the agent is rendering this one at the detail profile for a viewer. */
  detail?: boolean;
  /** Whether a frame arrived in the last few seconds. */
  live: boolean;
  /** Frames captured since the drone appeared. */
  frames: number;
}

/** Mirrors the job record that server.py writes to out/jobs/<id>/job.json. */

export type JobStatus = "queued" | "generating" | "done" | "failed";

/** Who turns the screenshot into a world: World Labs directly, or the n8n workflow. */
export const BACKENDS = ["marble", "wildfire"] as const;
export type Backend = (typeof BACKENDS)[number];

export interface Job {
  id: string;
  status: JobStatus;
  /** absent on jobs captured before the wildfire backend existed - those are all marble */
  backend?: Backend;
  created: string;
  updated: string;
  model: string;
  /** null on a wildfire job until n8n reports the prompt it wrote itself */
  prompt: string | null;
  is_pano: boolean;
  /** where the capture came from, e.g. "firekeep-mod" or "watch:shot.png" */
  source: string;
  source_file: string;
  bytes: number;
  estimated_credits: number;
  progress: number | null;
  world_id: string | null;
  marble_url: string | null;
  /** wildfire only: the finished world, and the prompt n8n captioned the screenshot with */
  world_url?: string | null;
  generated_prompt?: string | null;
  /** file names inside the job folder; the shape of a wildfire payload is not ours to fix */
  assets: { preview?: string; pano?: string } & Record<string, string | undefined>;
  caption?: string | null;
  error: string | null;
  took_seconds?: number | null;
  /** only present on GET /api/jobs/<id> - the full Marble payload */
  world?: MarbleWorld;
}

export interface MarbleWorld {
  world_id: string;
  world_marble_url: string;
  assets: {
    caption?: string;
    thumbnail_url?: string;
    imagery?: { pano_url?: string | null };
    mesh?: { collider_mesh_url?: string | null; hq_mesh_url?: string | null };
    splats?: { spz_urls?: Record<string, string> };
  };
}

export interface Health {
  ok: boolean;
  /** null on a wildfire server - the credits being spent are n8n's, not ours */
  credits: number | string | null;
  queued: number;
  busy: number;
  model: string;
  backend: Backend;
  backends: Backend[];
  dry_run: boolean;
}

/** GET /api/world - the top-down map server.py renders from the live save. */
export interface WorldMeta {
  dimension: string;
  /** block coordinates of the map's top-left pixel */
  origin_x: number;
  origin_z: number;
  /** map size in pixels; blocks_per_pixel is 1 today */
  width: number;
  height: number;
  blocks_per_pixel: number;
  chunks: number;
  regions: number;
  took_seconds: number;
  name: string;
  spawn: { x: number; y: number; z: number } | null;
  save: string;
  map_url: string;
}
