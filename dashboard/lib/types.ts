/** Mirrors the job record that server.py writes to out/jobs/<id>/job.json. */

export type JobStatus = "queued" | "generating" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  created: string;
  updated: string;
  model: string;
  prompt: string;
  is_pano: boolean;
  /** where the capture came from, e.g. "firekeep-mod" or "watch:shot.png" */
  source: string;
  source_file: string;
  bytes: number;
  estimated_credits: number;
  progress: number | null;
  world_id: string | null;
  marble_url: string | null;
  assets: { preview?: string; pano?: string };
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
  credits: number | string;
  queued: number;
  busy: number;
  model: string;
  dry_run: boolean;
}
