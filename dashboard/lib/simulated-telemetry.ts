/**
 * The hardware readings the drones do not actually have.
 *
 * The camera API reports where a drone is, how fast it is being rendered and how many frames it
 * has produced. Everything an operator would otherwise be reading - cells, temperatures, link
 * quality, what is in the retardant tank - has no source, so it is modelled here: slow sine
 * drifts around a per-drone baseline taken from the drone's id, which is stable, so a drone does
 * not come back from a tab switch with a different battery.
 *
 * It lives on its own rather than inside the telemetry panel because the panel is no longer the
 * only thing reading it. The instrument layer painted over the video shows the same numbers, and
 * two independent simulations would have the HUD and the panel disagree about the battery of the
 * drone they are both describing - which is the one thing a fake instrument must never do.
 *
 * Every field here is invented. The real ones are on {@link Drone} itself.
 */

import { seedOf, type Role } from "./roles";

export interface Telemetry {
  battery: number;
  voltage: number;
  batteryTemp: number;
  motorTemp: number;
  signal: number;
  latency: number;
  speed: number;
  altitude: number;
  /** degrees, tiny - just enough to keep the horizon line alive */
  roll: number;
  /** knots, shared by every drone in the air because it is the same weather */
  wind: number;
  windBearing: number;
  voltageTrace: number[];
  thermalTrace: number[];
  /** suppression: how much retardant is left, as a percentage */
  payload: number;
  /** relay: mesh legs held, and the backhaul they add up to */
  uplink: number;
  /** thermal: the hottest thing in frame, in Celsius */
  peak: number;
  /** survey: how much of the assigned block has been flown */
  coverage: number;
  /** rescue: lifesign returns on this pass */
  contacts: number;
}

interface Source {
  id: string;
  y: number;
  frames: number;
}

/**
 * A drone's instruments at a moment.
 *
 * `now` is passed in rather than read here so that a panel and an overlay rendering in the same
 * tick produce identical numbers, and so a test can ask for a specific second.
 */
export function simulatedTelemetry(drone: Source, now: number, role?: Role): Telemetry {
  const seed = seedOf(drone.id) * 100;
  const phase = now / 6_000 + seed;
  const wave = (offset: number) => Math.sin(phase + offset);

  const altitude = Math.max(0, drone.y - 62);
  const speed = Math.max(0.1, 6.5 + wave(0.7) * 1.3);
  const battery = Math.max(16, Math.min(100, 78 - (seed % 19) - wave(0.3) * 2));
  const batteryTemp = 34 + wave(1.2) * 2.8;
  const voltage = 21.4 + battery / 100 * 3.5 + wave(2.1) * 0.12;
  const trace = (base: number, amplitude: number, offset: number) =>
    Array.from({ length: 28 }, (_, index) =>
      base + Math.sin(phase - (28 - index) * 0.17 + offset) * amplitude
      + Math.sin(phase * 0.37 - index * 0.6 + offset) * amplitude * 0.24,
    );

  // The weather is the world's, not the aircraft's, so it is deliberately not seeded per drone.
  const windPhase = now / 21_000;

  return {
    battery,
    voltage,
    batteryTemp,
    motorTemp: 43 + wave(2.5) * 4.2,
    signal: 89 + Math.round(wave(3.1) * 5),
    latency: 24 + Math.round(Math.abs(wave(1.8)) * 11),
    speed,
    altitude,
    roll: wave(4.4) * 3.5 + Math.sin(phase * 2.3) * 1.2,
    wind: 7 + Math.sin(windPhase) * 4 + Math.sin(windPhase * 3.1) * 1.5,
    windBearing: (215 + Math.sin(windPhase * 0.7) * 40 + 360) % 360,
    voltageTrace: trace(voltage, 0.24, 0),
    thermalTrace: trace(batteryTemp, 1.8, 0.9),

    // Role instruments. Every drone carries the numbers; only its own role shows them.
    payload: Math.max(0, Math.min(100, 62 + wave(1.05) * 36)),
    uplink: 118 + wave(0.4) * 34,
    peak: 340 + wave(1.7) * 180,
    // Coverage is a job in progress rather than an oscillation: it climbs and starts again,
    // paced off the frames the agent has actually rendered so it moves when the drone is flying.
    coverage: (drone.frames / 42 + seed) % 100,
    contacts: role?.id === "rescue" ? Math.floor(Math.abs(wave(2.9)) * 3) : 0,
  };
}
