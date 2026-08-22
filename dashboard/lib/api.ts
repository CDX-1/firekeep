import type { Backend, Health, Job, WorldMeta } from "./types";

/** Everything goes through the /backend rewrite in next.config.ts. */
const BASE = "/backend";

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const getHealth = () => json<Health>("/api/health");
export const getJobs = (signal?: AbortSignal) => json<Job[]>("/api/jobs", signal);
export const getJob = (id: string) => json<Job>(`/api/jobs/${id}`);

/** The live Minecraft world, read off the save on disk. */
export const getWorld = (dimension = "overworld") =>
  json<WorldMeta>(`/api/world?dimension=${encodeURIComponent(dimension)}`);

/** One pixel per block, transparent wherever the world is not generated yet. */
export const worldMapUrl = (dimension = "overworld") =>
  `${BASE}/api/world/map.png?dimension=${encodeURIComponent(dimension)}`;

/** Asset served out of that job's folder, e.g. pano.png */
export const assetUrl = (jobId: string, file: string) =>
  `${BASE}/jobs/${jobId}/${file}`;

/** POST a screenshot. Same contract the Fabric mod uses. */
export async function capture(file: File, { model, backend }: { model?: string; backend?: Backend } = {}) {
  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (backend) params.set("backend", backend);
  const q = params.size ? `?${params}` : "";
  const res = await fetch(`${BASE}/capture${q}`, {
    method: "POST",
    headers: { "X-Source": "dashboard" },
    body: await file.arrayBuffer(),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json() as Promise<{ job_id: string; status: string; backend: Backend; estimated_credits: number }>;
}
