import { agentBases } from "../../../lib/agents";
import type { DroneCamera } from "../../../lib/types";

/** Never cached: the whole point is that it reflects the fleet as it is right now. */
export const dynamic = "force-dynamic";

interface AgentRoster {
  clientFps?: number;
  drones?: DroneCamera[];
}

/**
 * The merged roster, gathered from every running agent.
 *
 * <p>Agents are asked in parallel and one that is starting up or already gone is skipped rather
 * than failing the whole request - a fleet where one member is restarting should still show the
 * rest, not go blank.
 */
export async function GET() {
  const bases = await agentBases();

  const rosters = await Promise.all(
    bases.map(async (base) => {
      try {
        const res = await fetch(`${base}/drones`, { cache: "no-store" });
        if (!res.ok) return null;
        return (await res.json()) as AgentRoster;
      } catch {
        return null;
      }
    }),
  );

  const drones: DroneCamera[] = [];
  const seen = new Set<string>();
  let clientFps = 0;

  for (const roster of rosters) {
    if (!roster) continue;
    // Each agent reports its own frame rate; the slowest is what the operator should worry about.
    if (roster.clientFps) {
      clientFps = clientFps === 0 ? roster.clientFps : Math.min(clientFps, roster.clientFps);
    }
    for (const drone of roster.drones ?? []) {
      // An agent renders every drone it can see, so two agents standing near each other both
      // report the same drone. First one wins; the resolver decides who actually serves it.
      if (seen.has(drone.id)) continue;
      seen.add(drone.id);
      drones.push(drone);
    }
  }

  drones.sort((a, b) => a.id.localeCompare(b.id));

  return Response.json(
    { clientFps, drones, agents: bases.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
