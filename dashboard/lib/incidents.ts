/**
 * Incident reports, as the Python server serves them.
 *
 * A report is one drone's photographs of something, the picture n8n generated from them, a map
 * of the ground they cover, and the write-up over the top. Mirrors the record incidents.py
 * writes to out/incidents/<id>/incident.json - the shape is theirs, not ours.
 */

const BASE = "/backend";

/**
 * generating is n8n's part, writing is the analyst's, and then the report stands.
 *
 * There is no state for taking the photographs: they are already in hand by the time the
 * server answers, which is the point - the picture is the part somebody is waiting for.
 */
export type IncidentStatus = "generating" | "writing" | "done" | "failed";

export const SEVERITIES = ["clear", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Where the world-feed put the drone when the shutter went. */
export interface IncidentPosition {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Everything the server already knew about the ground in the photographs. */
export interface IncidentScene {
  position: IncidentPosition | null;
  live: boolean;
  /** burning columns in the whole dimension, not just this incident */
  hot_total: number;
  /**
   * Burning columns within reach of the drone. The coordinates themselves are not sent with
   * the roster - they are what the map PNG is painted from, and there are thousands of them;
   * /api/incidents/<id> has them if anything ever needs to draw its own.
   */
  fires_nearby: number;
  /** blocks to the closest flame, or null when nothing is alight in range */
  nearest_fire: number | null;
  events: {
    id: string;
    kind: string;
    x: number;
    z: number;
    radius: number;
    intensity: number;
    status: string;
    created: number;
    affected: number | null;
  }[];
  observations: { id: string; type: string; severity: string; message: string }[];
  others: { id: string; distance: number }[];
  error: string | null;
}

/** What was drawn, so the dashboard can label the map without re-deriving it. */
export interface IncidentMap {
  origin_x: number;
  origin_z: number;
  width: number;
  height: number;
  scale: number;
  blocks_per_pixel: number;
  center: { x: number; z: number };
  known_columns: number;
  fires: number;
  events: number;
  /** false when the live feed had never seen this ground - the map is markers on an empty field */
  terrain: boolean;
}

/** The write-up. `source` says whether a model wrote it or the numbers did. */
export interface IncidentReport {
  source: "ai" | "baseline";
  model: string | null;
  headline: string;
  severity: Severity;
  summary: string;
  scene: string;
  spread: string;
  impact: string;
  actions: string[];
  confidence: string;
  /** why the model was not used, when it was not */
  error: string | null;
}

export interface Incident {
  id: string;
  status: IncidentStatus;
  created: string;
  updated: string;
  drone_id: string;
  dimension: string;
  kind: string;
  note: string;
  source: string;
  radius: number;
  shots: number;
  photos: string[];
  /** the image n8n generated from the photograph, once it has */
  generated: string | null;
  generated_prompt: string | null;
  caption: string | null;
  world_url: string | null;
  generation_error: string | null;
  /**
   * True while n8n is still generating its view. A report is finished and readable long before
   * this goes false - the caption arrives in seconds, the picture in minutes.
   */
  generating: boolean;
  progress: number | null;
  map: string | null;
  map_meta: IncidentMap | null;
  scene: IncidentScene;
  report: IncidentReport | null;
  error: string | null;
  took_seconds: number | null;
  photo_errors?: string[];
}

/** Whether the analyst has a key; the reports say so themselves, but the bar says it up front. */
export interface AnalystInfo {
  available: boolean;
  base: string;
  model: string;
}

/** A report that is still being written, and so still worth polling for. */
export const isWorking = (incident: Incident) =>
  incident.status === "generating" || incident.status === "writing";

/** One file out of a report's folder: a photograph, the map, the generated view. */
export const incidentAsset = (id: string, file: string) => `${BASE}/incidents/${id}/${file}`;

export async function getIncidents(signal?: AbortSignal) {
  const res = await fetch(`${BASE}/api/incidents`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`/api/incidents -> ${res.status}`);
  return res.json() as Promise<{ incidents: Incident[]; analyst: AnalystInfo }>;
}

/**
 * Asks a drone to photograph what it can see and write it up.
 *
 * Resolves as soon as the photographs are taken - a second or two - and long before n8n and
 * the analyst have finished with them, which is why the record comes back mid-flight.
 */
export async function openIncident(request: {
  droneId: string;
  shots?: number;
  note?: string;
  radius?: number;
}) {
  const res = await fetch(`${BASE}/api/incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Source": "dashboard" },
    body: JSON.stringify({
      drone_id: request.droneId,
      shots: request.shots,
      note: request.note,
      radius: request.radius,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as { ok: boolean; incident: Incident };
}
