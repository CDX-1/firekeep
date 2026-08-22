/**
 * The fire risk model behind the Predictions map.
 *
 * Risk is worked out in two layers. The first is this file: a deterministic pass over what the
 * world actually reports - burning columns from the live feed, the disaster log, and where the
 * drones are - binned onto the map grid. It is cheap, it is always available, and it is honest
 * about the present.
 *
 * The second layer is the model behind /api/predict, which reads the same observations and says
 * where the fire is going *next*. That is the part the arithmetic here cannot do: fire spreads
 * with the terrain and with what has already burned, and a falloff curve has no opinion about
 * either. When the model is unreachable the baseline stands on its own, which is why it lives
 * here rather than inside the route.
 */

import type { SimEvent } from "./events";
import type { LiveSnapshot } from "./live";

// Number of grid columns/rows the map is divided into.
export const GRID_COLS = 10;
export const GRID_ROWS = 10;

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
  /** The model's reasoning for this cell, when it singled it out. Baseline cells have none. */
  note: string | null;
}

/** What the browser gets back from /api/predict. */
export interface RiskReport {
  /** "ai" when the model answered, "baseline" when we fell back to the arithmetic above. */
  source: "ai" | "baseline";
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

/**
 * Counts what the world is reporting into each cell, then scores it.
 *
 * The score is a distance-decayed sum: a cell is dangerous because it is burning, and slightly
 * dangerous because its neighbours are. Everything here is present tense - see the module note
 * for why the prediction proper lives elsewhere.
 */
export function baselineGrid(
  live: LiveSnapshot | null,
  events: SimEvent[],
  now = Date.now(),
): RiskCell[][] {
  const cells = emptyGrid();
  if (!live) return cells;

  const bounds: GridBounds = {
    origin_x: live.origin_x,
    origin_z: live.origin_z,
    width: live.width,
    height: live.height,
  };

  // Burning columns, and the block coordinates behind them for the nearest-fire readout.
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

  // The disaster log. A douse is the one kind that argues risk down, so it is scored separately
  // rather than being counted as just another thing that happened here.
  const cutoff = now / 1000 - EVENT_WINDOW;
  const doused = emptyGrid().map((row) => row.map(() => 0));
  for (const event of events) {
    if (event.created < cutoff || event.status === "failed" || event.status === "dropped") continue;
    const at = cellOf(event.x, event.z, bounds);
    if (!at) continue;
    if (event.kind === "extinguish") doused[at.row][at.col] += 1;
    else cells[at.row][at.col].events += 1;
  }

  const cellW = live.width / GRID_COLS;
  const cellH = live.height / GRID_ROWS;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const cell = cells[row][col];

      // Distance to the nearest fire, in blocks, measured from the middle of the cell.
      if (firePoints.length > 0) {
        const cx = live.origin_x + (col + 0.5) * cellW;
        const cz = live.origin_z + (row + 0.5) * cellH;
        let nearest = Infinity;
        for (const [fx, fz] of firePoints) {
          const d = Math.hypot(fx - cx, fz - cz);
          if (d < nearest) nearest = d;
        }
        cell.nearestFire = Math.round(nearest);
      }

      // Neighbour pressure: every burning cell pushes risk outwards, dropping off with distance.
      let pressure = 0;
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const source = cells[r][c];
          if (source.fires === 0 && source.events === 0) continue;
          const weight = source.fires + source.events * 0.5;
          const dist = Math.hypot(c - col, r - row);
          pressure += weight / (1 + dist * dist);
        }
      }

      // Compress the open-ended pressure onto the 1-5 scale. A cell that is itself alight floors
      // at 4 no matter how the curve lands - "burning" is never a moderate day out.
      let score = 1 + Math.log1p(pressure) * 1.6 - doused[row][col] * 0.8;
      if (cell.fires > 0) score = Math.max(score, cell.fires > 8 ? 5 : 4);
      cell.risk = clampRisk(score);
    }
  }

  return cells;
}

/**
 * The compact form the model is shown and answers in: one digit per cell, one string per row.
 *
 * A hundred cells as JSON objects is a lot of tokens to spend saying very little, and every one
 * of them is another chance for the reply to come back malformed. Ten ten-character strings are
 * hard to get wrong and trivial to check.
 */
export function gridToRows(cells: RiskCell[][]): string[] {
  return cells.map((row) => row.map((cell) => String(cell.risk)).join(""));
}

/** Reads the model's rows back onto the grid, keeping the baseline wherever the reply is junk. */
export function rowsToGrid(rows: unknown, baseline: RiskCell[][]): RiskCell[][] {
  if (!Array.isArray(rows)) return baseline;
  return baseline.map((row, r) =>
    row.map((cell, c) => {
      const line = rows[r];
      if (typeof line !== "string") return cell;
      const digit = Number.parseInt(line[c] ?? "", 10);
      if (!Number.isFinite(digit)) return cell;
      return { ...cell, risk: clampRisk(digit) };
    }),
  );
}
