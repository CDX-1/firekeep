const BASE = "/backend";

export type DroneEventSeverity = "info" | "low" | "medium" | "high" | "critical";

/** A workflow observation tied to a camera feed, not a command to the drone. */
export interface DroneFeedEvent {
  id: string;
  drone_id: string;
  type: string;
  severity: DroneEventSeverity;
  message: string;
  location: { x: number | null; y: number | null; z: number | null; dimension: string };
  created: number;
}

export async function getDroneEvents(droneId: string) {
  const query = new URLSearchParams({ drone_id: droneId, limit: "6" });
  const res = await fetch(`${BASE}/api/drone-events?${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/drone-events -> ${res.status}`);
  return res.json() as Promise<{ events: DroneFeedEvent[] }>;
}
