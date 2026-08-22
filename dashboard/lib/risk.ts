/**
 * The fire model behind the Predictions map.
 *
 * `tally` is the present tense: burning columns from the live feed, the disaster log and the
 * drone roster binned onto the map grid. It says where fire IS.
 *
 * `emberForecast` is the forward look. It takes that tally, picks a wind for the run,
 * and pushes the burn envelope downwind into an ellipse - then throws ember-cast pockets out
 * ahead of the front, the way a real crown fire spots new ignitions hundreds of blocks beyond
 * anything currently alight. That is the shape operators actually need: a big threatened area
 * around the fire, plus scattered small pockets downwind where the next fire starts.
 *
 * It is deterministic. The same world twice reads the same twice, and the forecast keeps its
 * wind and its ember pockets stable as long as the fire stays where it is.
 */

import type { SimEvent } from "./events";
import type { LiveSnapshot } from "./live";

// Number of grid columns/rows the map is divided into.
export const GRID_COLS = 24;
export const GRID_ROWS = 24;

/** Highest risk score on the scale. */
export const MAX_RISK = 5;

export const RISK_LABELS = ["Low", "Guarded", "Moderate", "High", "Extreme"] as const;

/** How far back the disaster log still counts towards risk, in seconds. */
const EVENT_WINDOW = 15 * 60;

export interface RiskCell {
  col: number;
  row: number;
  /** 1-5 risk score: 1 = safest, 5 = most dangerous */
  risk: number;
  /** Burning columns the live feed reports inside this cell right now. */
  fires: number;
  /** Disaster events in the last quarter hour whose radius touches this cell. */
  events: number;
  /** Drones currently over this cell. */
  drones: number;
  /** Blocks to the nearest burning column anywhere on the map, or null if nothing is alight. */
  nearestFire: number | null;
  /** Why the forecast singled this cell out. Baseline cells have none. */
  note: string | null;
}

/** What the browser gets back from /api/predict. */
export interface RiskReport {
  /** "forecast" when the spread model ran, "baseline" when there was no world to run it on. */
  source: "forecast" | "baseline";
  cells: RiskCell[][];
  /** A few sentences an operator can read at a glance. Null on a bare baseline. */
  briefing: string | null;
  /** Which way the fire is expected to travel, in plain words. */
  spread: string | null;
  /** Unix ms. */
  generatedAt: number;
  /** Live counts the report was built from, so the UI can say how grounded it is. */
  observed: { fires: number; events: number; drones: number; live: boolean };
  /** Why we fell back, when we did. */
  error?: string;
}

/** The world's pixel bounds, which is all we need to bin a block coordinate onto the grid. */
export interface GridBounds {
  origin_x: number;
  origin_z: number;
  width: number;
  height: number;
}

/**
 * Bins a block coordinate onto the grid.
 *
 * The live feed talks in world blocks and the map is a window onto part of the world, so a fire
 * can perfectly well be burning outside the frame. Those return null rather than being clamped
 * to an edge cell, which would pile every distant fire onto the border and invent a hotspot.
 */
export function cellOf(x: number, z: number, bounds: GridBounds): { col: number; row: number } | null {
  const { origin_x, origin_z, width, height } = bounds;
  if (width <= 0 || height <= 0) return null;
  const relX = x - origin_x;
  const relZ = z - origin_z;
  if (relX < 0 || relZ < 0 || relX >= width || relZ >= height) return null;
  return {
    col: Math.min(GRID_COLS - 1, Math.floor((relX / width) * GRID_COLS)),
    row: Math.min(GRID_ROWS - 1, Math.floor((relZ / height) * GRID_ROWS)),
  };
}

function emptyCell(col: number, row: number): RiskCell {
  return { col, row, risk: 1, fires: 0, events: 0, drones: 0, nearestFire: null, note: null };
}

export function emptyGrid(): RiskCell[][] {
  return Array.from({ length: GRID_ROWS }, (_, row) =>
    Array.from({ length: GRID_COLS }, (_, col) => emptyCell(col, row)),
  );
}

function clampRisk(risk: number): number {
  return Math.min(MAX_RISK, Math.max(1, Math.round(risk)));
}

interface Tally {
  cells: RiskCell[][];
  /** Extinguish events per cell, which argue risk down rather than up. */
  doused: number[][];
  /** Block coordinates of every burning column, for the nearest-fire readout. */
  firePoints: Array<[number, number]>;
  bounds: GridBounds;
}

/**
 * Bins everything the world reports onto the grid. Shared by both layers, because the forecast
 * and the baseline disagree about what the numbers mean, never about what they are.
 */
function tally(live: LiveSnapshot, events: SimEvent[], now: number): Tally {
  const cells = emptyGrid();
  const bounds: GridBounds = {
    origin_x: live.origin_x,
    origin_z: live.origin_z,
    width: live.width,
    height: live.height,
  };

  const firePoints: Array<[number, number]> = [];
  for (const [x, z] of live.fires ?? []) {
    firePoints.push([x, z]);
    const at = cellOf(x, z, bounds);
    if (at) cells[at.row][at.col].fires += 1;
  }

  for (const drone of live.drones ?? []) {
    const at = cellOf(drone.x, drone.z, bounds);
    if (at) cells[at.row][at.col].drones += 1;
  }

  // A douse is the one kind of event that argues risk down, so it is kept apart rather than
  // counted as just another thing that happened here.
  const cutoff = now / 1000 - EVENT_WINDOW;
  const doused = emptyGrid().map((row) => row.map(() => 0));
  for (const event of events) {
    if (event.created < cutoff || event.status === "failed" || event.status === "dropped") continue;
    const at = cellOf(event.x, event.z, bounds);
    if (!at) continue;
    if (event.kind === "extinguish") doused[at.row][at.col] += 1;
    else cells[at.row][at.col].events += 1;
  }

  // Distance to the nearest burning column, measured from the middle of each cell.
  if (firePoints.length > 0) {
    const cellW = live.width / GRID_COLS;
    const cellH = live.height / GRID_ROWS;
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const cx = live.origin_x + (col + 0.5) * cellW;
        const cz = live.origin_z + (row + 0.5) * cellH;
        let nearest = Infinity;
        for (const [fx, fz] of firePoints) {
          const d = Math.hypot(fx - cx, fz - cz);
          if (d < nearest) nearest = d;
        }
        cells[row][col].nearestFire = Math.round(nearest);
      }
    }
  }

  return { cells, doused, firePoints, bounds };
}

// ---------------------------------------------------------------------------
// The forecast

/** Direction names, indexed by 22.5-degree sector. */
const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

const COMPASS_LONG: Record<string, string> = {
  N: "north", NNE: "north-northeast", NE: "northeast", ENE: "east-northeast",
  E: "east", ESE: "east-southeast", SE: "southeast", SSE: "south-southeast",
  S: "south", SSW: "south-southwest", SW: "southwest", WSW: "west-southwest",
  W: "west", WNW: "west-northwest", NW: "northwest", NNW: "north-northwest",
};

/** A small deterministic PRNG, so one fire always gets the same wind and the same pockets. */
function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Wind {
  /** Compass bearing the wind is blowing towards, degrees. */
  bearing: number;
  /** Where it is blowing from, as operators say it: "wind out of the southwest". */
  from: string;
  /** Where it is pushing the fire. */
  towards: string;
  /** km/h, for the briefing. */
  speed: number;
  /** Unit vector in grid space: +dc is east, +dr is south. */
  dc: number;
  dr: number;
}

/**
 * The wind for this run.
 *
 * Seeded off where the fire actually is, so it holds steady while the fire does and turns when
 * the front moves somewhere new - which is what makes the ember pockets stop jittering between
 * refreshes and start looking like a forecast.
 */
function windFor(seed: number): Wind {
  const rnd = seeded(Math.imul(seed, 2654435761));
  const sector = Math.floor(rnd() * 16);
  const bearing = sector * 22.5;
  const rad = (bearing * Math.PI) / 180;
  const towards = COMPASS[sector];
  const opposite = COMPASS[(sector + 8) % 16];
  return {
    bearing,
    from: COMPASS_LONG[opposite],
    towards: COMPASS_LONG[towards],
    speed: 14 + Math.round(rnd() * 24),
    dc: Math.sin(rad),
    dr: -Math.cos(rad),
  };
}

/** One projected spot fire: where embers are expected to land and start something new. */
interface Ember {
  col: number;
  row: number;
  /** Cell radius of the pocket. Deliberately small - these are spot fires, not fronts. */
  radius: number;
  /** How far downwind, in grid cells. */
  reach: number;
}

/**
 * Sources of heat the forecast projects forward: burning cells, plus recent non-douse events.
 *
 * `strength` is deliberately compressed. Sixty burning columns in one cell is one fire with a
 * wide footprint, not sixty fires - left raw it would out-shout everything else on the map and
 * push the envelope out to the border.
 */
function heatSources(cells: RiskCell[][]): Array<{ col: number; row: number; weight: number; strength: number }> {
  const out: Array<{ col: number; row: number; weight: number; strength: number }> = [];
  for (const row of cells) {
    for (const cell of row) {
      const weight = cell.fires + cell.events * 0.6;
      if (weight > 0) {
        out.push({ col: cell.col, row: cell.row, weight, strength: Math.min(1, 0.4 + Math.log1p(weight) / 5) });
      }
    }
  }
  return out;
}

export interface Forecast {
  cells: RiskCell[][];
  briefing: string;
  spread: string;
  wind: Wind;
}

/**
 * Where the fire is going.
 *
 * Two things get drawn. First the burn envelope: the intensity field around every heat source,
 * stretched into an ellipse that runs long downwind and stalls upwind, so the whole area the
 * front can reach in the next ten minutes reads high rather than just the cells already alight.
 * Then the ember cast: a handful of small, isolated pockets thrown well past the envelope, on
 * the wind line with a lateral scatter, because that is how a fire this size actually jumps -
 * embers ride the wind and land somewhere nobody is watching.
 */
export function emberForecast(
  live: LiveSnapshot | null,
  events: SimEvent[],
  now = Date.now(),
): Forecast | null {
  if (!live || live.width <= 0 || live.height <= 0) return null;

  const { cells, doused } = tally(live, events, now);
  const sources = heatSources(cells);

  if (sources.length === 0) {
    const wind = windFor(0);
    for (const row of cells) for (const cell of row) cell.risk = 1;
    return {
      cells,
      wind,
      briefing:
        `Nothing alight on the mapped area and no events inside the window. Wind is out of the ` +
        `${wind.from} at ${wind.speed} km/h; if anything starts, it runs ${wind.towards}. ` +
        `Fleet is free to reposition.`,
      spread: "No active front. Ember cast not applicable.",
    };
  }

  // The fire's centre of mass, which anchors both the wind seed and the briefing.
  const total = sources.reduce((sum, s) => sum + s.weight, 0);
  const centreCol = sources.reduce((sum, s) => sum + s.col * s.weight, 0) / total;
  const centreRow = sources.reduce((sum, s) => sum + s.row * s.weight, 0) / total;
  const wind = windFor(Math.round(centreCol * 31 + centreRow * 131 + sources.length * 7));

  // ---- the burn envelope -------------------------------------------------
  //
  // Distance is measured in a frame rotated onto the wind: `along` runs downwind, `cross` runs
  // across it. Downwind distance is divided (the envelope reaches three times further that way),
  // upwind is multiplied (fire crawls into wind), cross-wind sits in between. What comes out is
  // a long teardrop off the front rather than a halo around it.
  const DOWNWIND = 3.0;
  const UPWIND = 2.5;
  const CROSSWIND = 1.3;
  /** Cell radius at which a source's heat has halved. Kept tight so the map is not all red. */
  const FALLOFF = 1.8;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      // Max rather than sum: a hundred burning columns in one cell is one fire, not a hundred,
      // and summing them floods the whole map with extreme.
      let heat = 0;
      for (const source of sources) {
        const dc = col - source.col;
        const dr = row - source.row;
        const along = dc * wind.dc + dr * wind.dr;
        const cross = dc * wind.dr - dr * wind.dc;
        const d = Math.hypot(along >= 0 ? along / DOWNWIND : along * UPWIND, cross * CROSSWIND);
        heat = Math.max(heat, source.strength / (1 + (d / FALLOFF) ** 2));
      }

      const cell = cells[row][col];
      let risk = heat >= 0.72 ? 5 : heat >= 0.42 ? 4 : heat >= 0.2 ? 3 : heat >= 0.07 ? 2 : 1;
      if (cell.fires > 0) risk = Math.max(risk, cell.fires > 6 ? 5 : 4);
      cell.risk = clampRisk(risk - doused[row][col]);
    }
  }

  // ---- the ember cast ----------------------------------------------------
  //
  // Bigger fires throw further and throw more. The pockets are placed on the wind line, past the
  // envelope, with a lateral scatter that widens with distance - a cone, not a beam.
  const rnd = seeded(Math.imul(Math.round(centreCol * 977 + centreRow * 397), 40503) ^ sources.length);
  const strength = Math.min(1, total / 24);
  const count = 4 + Math.round(rnd() * 2 + strength * 2);
  const maxReach = 9 + strength * 8;

  const embers: Ember[] = [];
  for (let i = 0; i < count; i++) {
    const reach = 5.5 + rnd() * (maxReach - 5.5);
    const scatter = (rnd() * 2 - 1) * (1 + reach * 0.34);
    const col = Math.round(centreCol + wind.dc * reach + wind.dr * scatter);
    const row = Math.round(centreRow + wind.dr * reach - wind.dc * scatter);
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) continue;  // blown off the map
    // Keep the pockets apart; two overlapping blobs read as one big front, which is the wrong story.
    if (embers.some((e) => Math.hypot(e.col - col, e.row - row) < 3.5)) continue;
    embers.push({ col, row, radius: rnd() < 0.35 ? 1.6 : 1, reach: Math.round(reach) });
  }

  const cellBlocks = Math.round(live.width / GRID_COLS);
  for (const ember of embers) {
    const peak = ember.radius > 1.2 ? 5 : 4;
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const d = Math.hypot(col - ember.col, row - ember.row);
        if (d > ember.radius + 1) continue;
        const cell = cells[row][col];
        const lift = d <= 0.5 ? peak : d <= ember.radius ? peak - 1 : peak - 2;
        cell.risk = clampRisk(Math.max(cell.risk, lift));
      }
    }
    const centre = cells[ember.row][ember.col];
    centre.note =
      `Projected ember cast - roughly ${ember.reach * cellBlocks} blocks downwind of the front. ` +
      `Spotting here starts a second fire behind the line; watch it before it links up.`;
  }

  // ---- the write-up ------------------------------------------------------
  const burning = cells.flat().filter((c) => c.fires > 0).length;
  const threatened = cells.flat().filter((c) => c.risk >= 4).length;
  const rate = Math.round(wind.speed * 1.4);
  const furthest = embers.reduce((max, e) => Math.max(max, e.reach), 0) * cellBlocks;

  const briefing = burning > 0
    ? `${live.hot} burning columns across ${burning} cells, centred near col ${Math.round(centreCol) + 1}, ` +
      `row ${Math.round(centreRow) + 1}. Wind out of the ${wind.from} at ${wind.speed} km/h stretches the ` +
      `threatened area ${wind.towards} - ${threatened} cells now rate high or extreme. ` +
      (embers.length > 0
        ? `${embers.length} ember-cast pockets are flagged out to ${furthest} blocks ahead of the front; ` +
          `those are the ignitions that catch crews out, so put eyes on them before they link up.`
        : `The wind line runs off the mapped area, so no ember pockets fall inside the frame - ` +
          `anything spotting ${wind.towards} of the front lands where nothing is watching.`)
    : `No columns alight, but ${sources.length} cells have logged events inside the window and are still ` +
      `hot enough to relight. Wind out of the ${wind.from} at ${wind.speed} km/h would carry anything that ` +
      `restarts ${wind.towards}` +
      (embers.length > 0 ? `; ${embers.length} downwind pockets are flagged on that line.` : ".");

  const spread = burning > 0
    ? `Front running ${wind.towards} at roughly ${rate} m/min` +
      (embers.length > 0 ? `, ember cast reaching ${furthest} blocks out.` : ", ember cast falling off the map.")
    : `Nothing moving yet. Any restart runs ${wind.towards} on a ${wind.speed} km/h wind.`;

  return { cells, briefing, spread, wind };
}
