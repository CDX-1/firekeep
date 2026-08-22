/**
 * POST /api/predict - the fire risk map's inference backend.
 *
 * This is the one route the dashboard serves itself rather than proxying to Python. It has to
 * be: the Spuric key must not reach the browser, and a rewrite would hand it straight over. So
 * the browser asks Next, Next reads the world from the Python server over the loopback, and the
 * key stays on this side of the wire.
 *
 * The route never fails the request. A wildfire dashboard that shows nothing because an upstream
 * model timed out is worse than one showing the arithmetic baseline, so every failure path ends
 * in a 200 with `source: "baseline"` and the reason in `error`.
 */

import {
  GRID_COLS,
  GRID_ROWS,
  MAX_RISK,
  baselineGrid,
  cellOf,
  emptyGrid,
  gridToRows,
  rowsToGrid,
  type RiskCell,
  type RiskReport,
} from "@/lib/risk";
import { ROLE_IDS, ROLES, callsignOf, roleOf } from "@/lib/roles";
import type { SimEvent } from "@/lib/events";
import type { LiveSnapshot } from "@/lib/live";

/** The world lives behind the same server next.config.ts proxies /backend to. */
const SERVER = process.env.MARBLE_SERVER ?? "http://127.0.0.1:8000";

const BASE_URL = process.env.SPURIC_BASE_URL ?? "https://ai.spuric.com/v1";
const MODEL = process.env.SPURIC_MODEL ?? "spur-qwen3-235b";
const API_KEY = process.env.SPURIC_API_KEY ?? "";

/** Long enough for a 235B model to think, short enough that the panel is not just spinning. */
const AI_TIMEOUT_MS = 45_000;
const WORLD_TIMEOUT_MS = 8_000;

const DIMENSION = "minecraft:overworld";

// ---------------------------------------------------------------------------
// Reading the world

async function fromServer<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${SERVER}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(WORLD_TIMEOUT_MS),
      // The Python server lets loopback callers through, but honours a key when one is set.
      headers: process.env.FIREKEEP_API_KEY
        ? { Authorization: `Bearer ${process.env.FIREKEEP_API_KEY}` }
        : {},
    });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Talking to the model

/**
 * Qwen reasons out loud before it answers, and gateways differ on whether they strip that. It
 * may also wrap the JSON in a fence, or narrate a sentence either side of it. Rather than trust
 * any one of those to go our way, take the outermost braces and parse what is between them.
 */
function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

const SYSTEM_PROMPT = `You are the fire behaviour analyst for Firekeep, a wildfire response system operating over a Minecraft world monitored by camera drones.

You are given a ${GRID_COLS}x${GRID_ROWS} grid covering the mapped world, an observation table, and a baseline risk grid computed arithmetically from present conditions.

The baseline already knows where fire IS. Your job is to predict where it is GOING, over roughly the next ten minutes, and to correct the baseline where fire behaviour says it is wrong. Specifically:
- Fire spreads outward from burning cells; cells downwind and adjacent to large fire fronts deserve more risk than distance alone suggests.
- A cell that has already burned out has little left to burn - it should cool, not stay extreme.
- Isolated single ignitions rarely become fronts. Clusters do.
- Cells with drones on station are observed, not safer. Do not lower risk for drone presence.
- The fleet is split into roles: ${ROLE_IDS.map((id) => `${ROLES[id].code} ${ROLES[id].name} (${ROLES[id].tagline})`).join("; ")}. Coverage is about the right aircraft, not the count - a high cell watched only by a surveyor has nobody who can act on it. Mention that in the briefing when it is true; never change a risk score because of it.
- Cells with no fire anywhere near them and no recent events are genuinely low. Do not spread fear evenly across the map.

Risk is an integer 1 to ${MAX_RISK}: 1 low, 2 guarded, 3 moderate, 4 high, 5 extreme.

Reply with ONLY a JSON object, no prose and no code fence:
{
  "grid": ["<${GRID_COLS} digits>", ... exactly ${GRID_ROWS} strings],
  "spread": "<one short sentence on the direction fire is travelling, or that it is contained>",
  "briefing": "<2-3 sentences an operator reads at a glance: what is burning, what is threatened next, what to watch>",
  "hotspots": [{"col": <0-${GRID_COLS - 1}>, "row": <0-${GRID_ROWS - 1}>, "note": "<why this cell specifically>"}]
}
Give at most 4 hotspots, and only for cells you rate 4 or 5. Use 0-indexed col/row. If nothing is burning anywhere, say so plainly rather than inventing a threat.`;

/** The observation table, kept to cells that have something to report. */
function describeObservations(cells: RiskCell[][], live: LiveSnapshot | null, events: SimEvent[]): string {
  const lines: string[] = [];

  if (live) {
    lines.push(
      `World: ${live.width}x${live.height} blocks from (${live.origin_x}, ${live.origin_z}). ` +
        `Each grid cell is ${Math.round(live.width / GRID_COLS)}x${Math.round(live.height / GRID_ROWS)} blocks. ` +
        `col 0 is west, row 0 is north. Feed is ${live.live ? "live" : "stale"}, ${live.hot} burning columns total.`,
    );
  }

  // Which aircraft are over which cell, so "on station" can mean something more than a count.
  const stationed = new Map<string, string[]>();
  for (const drone of live?.drones ?? []) {
    const at = live ? cellOf(drone.x, drone.z, live) : null;
    if (!at) continue;
    const key = `${at.col},${at.row}`;
    const list = stationed.get(key) ?? [];
    list.push(`${callsignOf(drone.id)} ${roleOf(drone.id).code}`);
    stationed.set(key, list);
  }

  const fleet = live?.drones ?? [];
  if (fleet.length > 0) {
    const byRole = ROLE_IDS
      .map((id) => ({ role: ROLES[id], count: fleet.filter((d) => roleOf(d.id).id === id).length }))
      .filter((entry) => entry.count > 0)
      .map((entry) => `${entry.count} ${entry.role.code}`);
    lines.push(`Fleet in the air: ${fleet.length} aircraft - ${byRole.join(", ")}.`);
  }

  const active = cells.flat().filter((c) => c.fires > 0 || c.events > 0 || c.drones > 0);
  if (active.length === 0) {
    lines.push("No fires, no recent events, no drones over the mapped area.");
  } else {
    lines.push("Cells reporting activity (col,row):");
    for (const c of active) {
      const parts: string[] = [];
      if (c.fires) parts.push(`${c.fires} burning columns`);
      if (c.events) parts.push(`${c.events} recent events`);
      const crews = stationed.get(`${c.col},${c.row}`);
      if (crews?.length) parts.push(`on station: ${crews.join(", ")}`);
      else if (c.drones) parts.push(`${c.drones} drone(s) on station`);
      lines.push(`  (${c.col},${c.row}): ${parts.join(", ")}`);
    }
  }

  const recent = events.slice(0, 8);
  if (recent.length > 0) {
    lines.push("Disaster log, newest first:");
    for (const e of recent) {
      const age = Math.max(0, Math.round(Date.now() / 1000 - e.created));
      lines.push(
        `  ${e.kind} at (${e.x}, ${e.z}) radius ${e.radius}, intensity ${e.intensity}, ` +
          `${e.status}, ${age}s ago${e.affected != null ? `, ${e.affected} blocks affected` : ""}`,
      );
    }
  }

  return lines.join("\n");
}

interface AiReply {
  grid?: unknown;
  spread?: unknown;
  briefing?: unknown;
  hotspots?: unknown;
}

async function askModel(prompt: string): Promise<AiReply> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      // Risk assessment should not roll dice; the same world twice should read the same twice.
      temperature: 0.2,
      max_tokens: 1600,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`model ${res.status}: ${detail.slice(0, 200)}`);
  }

  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("model returned no content");
  return extractJson(content) as AiReply;
}

// ---------------------------------------------------------------------------
// Handler

export async function POST(): Promise<Response> {
  const [live, eventLog] = await Promise.all([
    fromServer<LiveSnapshot | null>(`/api/live?dimension=${encodeURIComponent(DIMENSION)}`, null),
    fromServer<{ events: SimEvent[] }>(`/api/events?dimension=${encodeURIComponent(DIMENSION)}`, { events: [] }),
  ]);

  const events = eventLog?.events ?? [];
  const hasWorld = !!live && live.width > 0 && live.height > 0;
  const baseline = hasWorld ? baselineGrid(live, events) : emptyGrid();

  const observed = {
    fires: live?.hot ?? 0,
    events: events.length,
    drones: live?.drones?.length ?? 0,
    live: !!live?.live,
  };

  const report = (extra: Partial<RiskReport>): RiskReport => ({
    source: "baseline",
    cells: baseline,
    briefing: null,
    spread: null,
    generatedAt: Date.now(),
    observed,
    ...extra,
  });

  if (!API_KEY) {
    return Response.json(report({ error: "SPURIC_API_KEY is not set" }));
  }
  if (!hasWorld) {
    // Nothing to reason about. Spending a 235B call to be told an empty map is empty is waste.
    return Response.json(report({ error: "no world on the live feed" }));
  }

  const prompt = [
    describeObservations(baseline, live, events),
    "",
    "Baseline risk grid (row 0 first, one digit per cell):",
    ...gridToRows(baseline).map((row, i) => `  row ${i}: ${row}`),
  ].join("\n");

  try {
    const reply = await askModel(prompt);
    const cells = rowsToGrid(reply.grid, baseline);

    // Attach the model's per-cell reasoning to the cells it named.
    if (Array.isArray(reply.hotspots)) {
      for (const spot of reply.hotspots.slice(0, 4)) {
        const col = Number(spot?.col);
        const row = Number(spot?.row);
        const note = typeof spot?.note === "string" ? spot.note : null;
        if (!note || !Number.isInteger(col) || !Number.isInteger(row)) continue;
        if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) continue;
        cells[row][col] = { ...cells[row][col], note };
      }
    }

    return Response.json(
      report({
        source: "ai",
        cells,
        briefing: typeof reply.briefing === "string" ? reply.briefing : null,
        spread: typeof reply.spread === "string" ? reply.spread : null,
      }),
    );
  } catch (err) {
    return Response.json(report({ error: err instanceof Error ? err.message : String(err) }));
  }
}
