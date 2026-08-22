/**
 * Works out which agent to ask for a given drone.
 *
 * <p>Each rendering agent is its own Minecraft client serving only the drone it films, on its own
 * port, so there is no one address that has the whole roster. The Fabric server publishes the
 * mapping and this resolves against it; everything the browser sees still comes from the dashboard
 * origin, so a phone on the LAN only has to reach this app.
 */

/** The Fabric server's directory endpoint. */
const DIRECTORY = process.env.FIREKEEP_DIRECTORY ?? "http://127.0.0.1:8087";

/**
 * Used when the directory is unreachable or empty - which is the normal case for a single agent
 * started by hand rather than by the supervisor.
 */
const FALLBACK = process.env.FIREKEEP_CAMERAS ?? "http://127.0.0.1:8088";

/** The directory changes only when an agent starts or stops, so a short cache is plenty. */
const CACHE_MS = 2000;

interface DirectoryEntry {
  droneId: string;
  port: number;
  running: boolean;
}

interface Directory {
  /** droneId to the base URL of the agent filming it. */
  bases: Map<string, string>;
  /** Every distinct agent base, for questions that are not about one drone. */
  all: string[];
}

let cache: { at: number; value: Directory } | null = null;

async function fetchDirectory(): Promise<Directory> {
  const bases = new Map<string, string>();

  try {
    const res = await fetch(`${DIRECTORY}/agents`, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { host?: string; agents?: DirectoryEntry[] };
      const host = body.host ?? "127.0.0.1";
      for (const agent of body.agents ?? []) {
        // A stopped agent still answers nothing useful; skip it so the roster stays honest.
        if (agent.running) bases.set(agent.droneId, `http://${host}:${agent.port}`);
      }
    }
  } catch {
    // The Fabric server may simply not be up. Fall through to the single-agent fallback.
  }

  if (bases.size === 0) return { bases, all: [FALLBACK] };
  return { bases, all: [...new Set(bases.values())] };
}

async function directory(): Promise<Directory> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const value = await fetchDirectory();
  cache = { at: now, value };
  return value;
}

/** Every agent base worth asking for a roster. */
export async function agentBases(): Promise<string[]> {
  return (await directory()).all;
}

/** The agent serving {@code id}, falling back to the single configured camera server. */
export async function baseFor(id: string): Promise<string> {
  const { bases } = await directory();
  return bases.get(id) ?? FALLBACK;
}
