"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./fleet-comms.module.css";
import { hotspotsNear, useIntel } from "@/lib/fleet-intel";
import { bearingName, bearingTo, callsignOf, roleOf, seedOf } from "@/lib/roles";
import { simulatedTelemetry } from "@/lib/simulated-telemetry";
import type { Drone } from "@/lib/use-cameras";

/**
 * The radio.
 *
 * None of this is a message from anywhere - there is no radio, and the drones have nothing to
 * say. It is the fleet narrating itself: every few seconds one aircraft is picked, a line is
 * taken from its role's phrasebook, and the gaps in it are filled from what that drone is
 * actually doing right now - the bearing to the nearest fire it can see, how much of the world
 * is alight, the peers on the net, the tank.
 *
 * That last part is what makes it worth having rather than being decoration. A surveyor calling
 * a perimeter at 240 metres north-east is calling a fire that is really there, at a bearing you
 * can check against the map, and the line stops appearing when the fire goes out. It is a
 * readable summary of the fleet's state that happens to be written as radio traffic.
 */

/** The gap between transmissions, either side of a coin flip so it does not tick like a metronome. */
const QUIET_MS = 4_200;
const SPREAD_MS = 5_000;

/** Enough scrollback to see what has been happening, not enough to be a memory leak. */
const MAX_LINES = 60;

interface Transmission {
  key: number;
  /** who is talking - a callsign, or OPS for the ground station */
  from: string;
  color: string;
  text: string;
  at: number;
  /** ground station traffic is drawn differently from an aircraft's */
  ops?: boolean;
}

/** What ops says, which is the only voice not tied to an aircraft. */
const OPS_LINES = [
  "all stations, {hot} columns burning, hold assigned blocks",
  "wind is {wind} knots out of the {windPoint}, expect the head to run",
  "{fleet} aircraft on station, net is clean",
  "no new ignitions this cycle, stay on pattern",
  "advise fuel state on the next pass",
];

export default function FleetComms({ drones }: { drones: Drone[] }) {
  const [log, setLog] = useState<Transmission[]>([]);
  const roster = useRef<Drone[]>(drones);
  const intel = useIntel();
  const picture = useRef(intel);
  const counter = useRef(0);

  roster.current = drones;
  picture.current = intel;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const speak = () => {
      const line = compose(roster.current, picture.current, counter.current++);
      if (line) setLog((current) => [line, ...current].slice(0, MAX_LINES));
      timer = setTimeout(speak, QUIET_MS + Math.random() * SPREAD_MS);
    };

    timer = setTimeout(speak, 900);
    return () => clearTimeout(timer);
  }, []);

  return (
    <section className={styles.comms} aria-label="Fleet radio traffic">
      <header className={styles.head}>
        <span className={styles.title}>Fleet net</span>
        <span className={styles.state} data-live={intel.live}>{intel.live ? "open" : "idle"}</span>
      </header>
      {log.length === 0
        ? <p className={styles.empty}>Waiting for traffic</p>
        : <ol className={styles.log}>
            {log.map((line) => (
              <li key={line.key} data-ops={line.ops}>
                <span className={styles.stamp}>{clock(line.at)}</span>
                <span className={styles.from} style={{ color: line.color }}>{line.from}</span>
                <span className={styles.text}>{line.text}</span>
              </li>
            ))}
          </ol>}
    </section>
  );
}

/**
 * One transmission.
 *
 * Ops speaks every fifth turn so the net is not only aircraft talking past each other; the rest
 * of the time a drone is chosen by rotation rather than at random, which is how every aircraft
 * gets heard from instead of the same one four times running.
 */
function compose(drones: Drone[], intel: ReturnType<typeof useIntel>, turn: number): Transmission | null {
  if (drones.length === 0) return null;
  const now = Date.now();
  const key = now * 1000 + (turn % 1000);

  if (turn % 5 === 4) {
    const any = simulatedTelemetry(drones[0], now);
    return {
      key,
      from: "OPS",
      color: "#8fb8ae",
      ops: true,
      at: now,
      text: fill(OPS_LINES[turn / 5 % OPS_LINES.length | 0], {
        hot: String(intel.hot),
        wind: any.wind.toFixed(0),
        windPoint: bearingName(any.windBearing).toLowerCase(),
        fleet: String(drones.length),
      }),
    };
  }

  const drone = drones[turn % drones.length];
  const role = roleOf(drone.id);
  const telemetry = simulatedTelemetry(drone, now, role);
  const nearest = hotspotsNear(intel.hotspots, drone.x, drone.z, 400, 1)[0];
  const peers = drones.filter((peer) => peer.id !== drone.id);

  // Which line of the phrasebook: seeded by the drone so two ships of the same role rarely say
  // the same thing in the same breath, and nudged by the turn so neither repeats itself.
  const index = Math.floor(seedOf(drone.id, `say${turn}`) * role.chatter.length) % role.chatter.length;

  return {
    key,
    from: callsignOf(drone.id),
    color: role.color,
    at: now,
    text: fill(role.chatter[index], {
      sector: drone.area.toLowerCase(),
      coverage: telemetry.coverage.toFixed(0),
      bearing: nearest ? bearingName(bearingTo(drone.x, drone.z, nearest.hotspot.x, nearest.hotspot.z)).toLowerCase() : "the ridge",
      range: nearest ? String(Math.round(nearest.distance)) : "—",
      hot: String(intel.hot),
      alt: telemetry.altitude.toFixed(0),
      temp: String(Math.round(telemetry.peak)),
      payload: telemetry.payload.toFixed(0),
      wind: telemetry.wind.toFixed(0),
      peers: String(peers.length),
      peer: peers.length > 0 ? callsignOf(peers[turn % peers.length].id) : "the pad",
      uplink: telemetry.uplink.toFixed(0),
      contacts: String(telemetry.contacts),
      plural: telemetry.contacts === 1 ? "" : "s",
    }),
  };
}

/** The time a call went out, as a radio log would write it. */
function clock(at: number) {
  const when = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(when.getHours())}${pad(when.getMinutes())}`;
}

/** Substitutes `{name}` from the table, leaving anything unknown alone rather than blanking it. */
function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
