/**
 * The disaster simulator, as it reaches the browser.
 *
 * Nothing here reaches Minecraft directly - there is no way to. An event is posted to the
 * python server, parked next to the drone orders, and handed to the mod in the reply to its
 * next world-feed push; the mod says what it did on the push after that. So an event has a
 * life rather than a result, and the four statuses below are that life: asked for, on its way,
 * and then what actually happened when it landed.
 */

const BASE = "/backend";

/** What each kind does in game lives in Disasters.java; this is what an operator needs. */
export const EVENT_KINDS = ["fire", "lightning", "explosion", "extinguish"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type EventStatus = "queued" | "sent" | "done" | "failed" | "dropped"
  | "detected" | "validating" | "responding" | "contained" | "cleared" | "escalated";

export interface SimEvent {
  id: string;
  kind: EventKind;
  dimension: string;
  x: number;
  /** null means "wherever the surface is" - the map is top-down and has no height to give */
  y: number | null;
  z: number;
  /** how far the event is scattered, in blocks */
  radius: number;
  /** ignition points, bolts, or blast power, depending on the kind */
  intensity: number;
  label: string;
  source: string;
  /** unix seconds */
  created: number;
  finished?: number;
  status: EventStatus;
  /** Present for drone-detected fire clusters; simulator-created events use status alone. */
  lifecycle?: EventStatus;
  /** blocks lit, bolts landed, or blocks doused, once the mod has reported back */
  affected: number | null;
  error: string | null;
}

/** What one `events` message on the world stream carries. */
export interface LiveEvents {
  dimension: string;
  events: SimEvent[];
}

export interface EventRequest {
  kind: EventKind;
  x: number;
  z: number;
  y?: number | null;
  radius?: number;
  intensity?: number;
  dimension?: string;
  label?: string;
}

/**
 * What each kind means where an operator will read it.
 *
 * `unit` names what `intensity` counts, which is different for every kind - a slider labelled
 * "intensity" alone tells you nothing about whether 8 is eight fires or an eight-power blast.
 */
export const EVENT_INFO: Record<EventKind, {
  label: string;
  unit: string;
  max: number;
  /** whether the kind scatters over an area at all */
  scatters: boolean;
  blurb: string;
  color: string;
}> = {
  fire: {
    label: "Wildfire",
    unit: "ignition points",
    max: 40,
    scatters: true,
    blurb: "Lights scattered blocks and lets vanilla fire spread do the rest.",
    color: "#e2604a",
  },
  lightning: {
    label: "Lightning",
    unit: "strikes",
    max: 12,
    scatters: true,
    blurb: "Real bolts, which scorch what they hit - a fire that starts itself.",
    color: "#d9c26a",
  },
  explosion: {
    label: "Explosion",
    unit: "blast power",
    max: 12,
    scatters: false,
    blurb: "The same blast primed TNT makes. 4 is one block of TNT.",
    color: "#d08a4a",
  },
  extinguish: {
    label: "Douse",
    unit: "",
    max: 1,
    scatters: true,
    blurb: "Clears every flame in the circle. The undo, and the drones' eventual job.",
    color: "#6fa8d0",
  },
};

/** True while the event is still on its way and its outcome is unknown. */
export const isPending = (event: SimEvent) => event.status === "queued" || event.status === "sent";

/** The disaster log, newest first. */
export async function getEvents(dimension = "minecraft:overworld") {
  const res = await fetch(`${BASE}/api/events?dimension=${encodeURIComponent(dimension)}`,
    { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/events -> ${res.status}`);
  return res.json() as Promise<{ events: SimEvent[]; live: boolean; kinds: EventKind[] }>;
}

/** Sets one off. Resolves as soon as it is queued, long before anything burns. */
export async function simulate(request: EventRequest) {
  const res = await fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as { ok: boolean; event: SimEvent; queued: number; live: boolean };
}

/**
 * Folds an update into the log, newest first.
 *
 * The stream sends a record every time one moves on, and a record the log has never seen when
 * it is first queued, so one merge handles both.
 */
export function mergeEvents(current: SimEvent[], incoming: SimEvent[]) {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.created - a.created);
}
