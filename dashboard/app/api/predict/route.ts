/**
 * POST /api/predict - the fire risk map's backend.
 *
 * The browser asks Next, Next reads the world from the Python server over the loopback, and the
 * spread model runs here. It is arithmetic, not inference: a wind, an elliptical burn envelope
 * pushed downwind of everything alight, and a scatter of ember-cast pockets ahead of the front.
 * See lib/risk.ts for the model itself.
 *
 * The route never fails the request. A wildfire dashboard that shows nothing because an upstream
 * feed timed out is worse than one showing the arithmetic baseline, so every failure path ends
 * in a 200 with `source: "baseline"` and the reason in `error`.
 */

import { emberForecast, emptyGrid, type RiskReport } from "@/lib/risk";
import type { SimEvent } from "@/lib/events";
import type { LiveSnapshot } from "@/lib/live";

/** The world lives behind the same server next.config.ts proxies /backend to. */
const SERVER = process.env.MARBLE_SERVER ?? "http://127.0.0.1:8000";

const WORLD_TIMEOUT_MS = 8_000;

const DIMENSION = "minecraft:overworld";

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

export async function POST(): Promise<Response> {
  const [live, eventLog] = await Promise.all([
    fromServer<LiveSnapshot | null>(`/api/live?dimension=${encodeURIComponent(DIMENSION)}`, null),
    fromServer<{ events: SimEvent[] }>(`/api/events?dimension=${encodeURIComponent(DIMENSION)}`, { events: [] }),
  ]);

  const events = eventLog?.events ?? [];

  const observed = {
    fires: live?.hot ?? 0,
    events: events.length,
    drones: live?.drones?.length ?? 0,
    live: !!live?.live,
  };

  const forecast = emberForecast(live, events);

  if (!forecast) {
    const report: RiskReport = {
      source: "baseline",
      cells: emptyGrid(),
      briefing: null,
      spread: null,
      generatedAt: Date.now(),
      observed,
      error: "no world on the live feed",
    };
    return Response.json(report);
  }

  const report: RiskReport = {
    source: "forecast",
    cells: forecast.cells,
    briefing: forecast.briefing,
    spread: forecast.spread,
    generatedAt: Date.now(),
    observed,
  };
  return Response.json(report);
}
