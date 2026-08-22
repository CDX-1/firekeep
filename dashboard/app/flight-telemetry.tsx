"use client";

import { useEffect, useMemo, useState } from "react";
import type { Drone } from "@/lib/use-cameras";
import { hotspotsNear, useIntel } from "@/lib/fleet-intel";
import { bearingName, roleOf } from "@/lib/roles";
import { simulatedTelemetry, type Telemetry } from "@/lib/simulated-telemetry";
import styles from "./flight-telemetry.module.css";

/**
 * The airframe panel beside a singled-out feed.
 *
 * It used to model its own battery and its own temperatures. It no longer does: the head-up
 * display over the picture shows the same aircraft, and two simulations of one battery is a
 * dashboard that disagrees with itself an inch apart. Both read {@link simulatedTelemetry}.
 *
 * What is left here is what the HUD does not carry - the flight path it has actually taken, the
 * two traces with history in them - and the four readings that depend on what the drone is *for*:
 * a suppression ship's operator wants the tank and the wind, a relay's wants the mesh, and
 * neither of them wants a generic signal percentage.
 */

export type DroneTrailPoint = {
  x: number;
  z: number;
  at: number;
  stopped: boolean;
};

function tracePoints(values: number[], width = 250, height = 62) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((value, index) => {
    const x = index / (values.length - 1) * width;
    const y = height - ((value - min) / range * (height - 10) + 5);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function Trace({ label, value, unit, values, tone }: {
  label: string;
  value: string;
  unit: string;
  values: number[];
  tone: "amber" | "green";
}) {
  return (
    <section className={styles.trace} aria-label={`${label}: ${value} ${unit}`}>
      <div className={styles.traceHeading}>
        <span>{label}</span>
        <strong>{value}<em>{unit}</em></strong>
      </div>
      <svg viewBox="0 0 250 62" preserveAspectRatio="none" role="img" aria-label={`${label} history`}>
        <path className={styles.gridLine} d="M0 15.5H250M0 31H250M0 46.5H250" />
        <polyline className={styles[tone]} points={tracePoints(values)} />
      </svg>
      <div className={styles.traceTime}><span>60 s ago</span><span>now</span></div>
    </section>
  );
}

function Reading({ label, value, unit, warning = false }: {
  label: string;
  value: string;
  unit: string;
  warning?: boolean;
}) {
  return <div className={styles.reading} data-warning={warning}>
    <span>{label}</span>
    <strong>{value}<em>{unit}</em></strong>
  </div>;
}

function RouteTrace({ points }: { points: DroneTrailPoint[] }) {
  if (points.length < 2) return null;

  const xs = points.map((point) => point.x);
  const zs = points.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const inset = 7;
  const pointAt = (point: DroneTrailPoint) => ({
    x: inset + (point.x - minX) / spanX * (100 - inset * 2),
    y: 100 - inset - (point.z - minZ) / spanZ * (100 - inset * 2),
  });
  const plotted = points.map(pointAt);
  const line = plotted.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const current = plotted.at(-1)!;

  return <svg className={styles.route} viewBox="0 0 100 100" role="img" aria-label="Recent flight path">
    <polyline className={styles.routeLine} points={line} />
    {points.map((point, index) => point.stopped && <circle
      className={styles.routeStop}
      cx={plotted[index].x}
      cy={plotted[index].y}
      r="2.7"
      key={`${point.at}-${index}`}
    />)}
    <circle className={styles.routeCurrent} cx={current.x} cy={current.y} r="3.2" />
  </svg>;
}

/**
 * The four readings this role is actually flown on.
 *
 * Deliberately not one panel with the irrelevant rows greyed out: a suppression ship and a mesh
 * relay do not measure the same things, and showing four blanks says they do.
 */
function roleReadings(drone: Drone, telemetry: Telemetry, hot: { distance: number }[], peers: number) {
  const role = roleOf(drone.id);
  switch (role.hud) {
    case "suppress": return [
      { label: "Retardant", value: telemetry.payload.toFixed(0), unit: "%", warning: telemetry.payload < 20 },
      { label: "Wind", value: `${telemetry.wind.toFixed(0)} ${bearingName(telemetry.windBearing)}`, unit: "kt" },
      { label: "Target", value: hot[0] ? Math.round(hot[0].distance).toString() : "—", unit: hot[0] ? "m" : "" },
      { label: "Drops", value: String(Math.floor(drone.frames / 900) % 9), unit: "" },
    ];
    case "thermal": return [
      { label: "Peak", value: Math.round(telemetry.peak).toString(), unit: "°C", warning: telemetry.peak > 460 },
      { label: "Ambient", value: (telemetry.batteryTemp - 8).toFixed(0), unit: "°C" },
      { label: "Sources", value: String(hot.length), unit: "" },
      { label: "Palette", value: "Ironbow", unit: "" },
    ];
    case "relay": return [
      { label: "Mesh peers", value: String(peers), unit: "", warning: peers === 0 },
      { label: "Backhaul", value: telemetry.uplink.toFixed(0), unit: "Mb" },
      { label: "Latency", value: telemetry.latency.toFixed(0), unit: "ms" },
      { label: "Altitude", value: telemetry.altitude.toFixed(0), unit: "m" },
    ];
    case "rescue": return [
      { label: "Returns", value: String(telemetry.contacts), unit: "" },
      { label: "Swept", value: telemetry.coverage.toFixed(0), unit: "%" },
      { label: "Nearest fire", value: hot[0] ? Math.round(hot[0].distance).toString() : "clear", unit: hot[0] ? "m" : "" },
      { label: "Battery", value: telemetry.battery.toFixed(0), unit: "%", warning: telemetry.battery < 30 },
    ];
    default: return [
      { label: "Coverage", value: telemetry.coverage.toFixed(0), unit: "%" },
      { label: "Hotspots", value: String(hot.length), unit: "" },
      { label: "Ground res", value: (telemetry.altitude / 40 + 0.4).toFixed(2), unit: "m/px" },
      { label: "Battery", value: telemetry.battery.toFixed(0), unit: "%", warning: telemetry.battery < 30 },
    ];
  }
}

export default function FlightTelemetry({ drone, trail }: { drone: Drone; trail: DroneTrailPoint[] }) {
  const [now, setNow] = useState(() => Date.now());
  const intel = useIntel();
  const role = roleOf(drone.id);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const telemetry = useMemo(() => simulatedTelemetry(drone, now, role), [drone, now, role]);
  const hot = useMemo(
    () => hotspotsNear(intel.hotspots, drone.x, drone.z, 300, 8),
    [intel.hotspots, drone.x, drone.z],
  );
  const peers = Math.max(0, intel.drones.length - 1);

  return <aside className={styles.telemetry} aria-label={`${drone.id} flight telemetry`}>
    <header className={styles.header}>
      <div>
        <h2>Flight telemetry</h2>
        <p>Simulated sensor feed</p>
      </div>
      <span className={styles.state}>{drone.live ? "Link active" : "Link delayed"}</span>
    </header>

    <RouteTrace points={trail} />

    <div className={styles.primaryReadings} style={{ "--role": role.color } as React.CSSProperties}>
      {roleReadings(drone, telemetry, hot, peers).map((reading) => (
        <Reading key={reading.label} {...reading} />
      ))}
    </div>

    <div className={styles.traces}>
      <Trace label="Battery voltage" value={telemetry.voltage.toFixed(1)} unit="V" values={telemetry.voltageTrace} tone="amber" />
      <Trace label="Battery temperature" value={telemetry.batteryTemp.toFixed(1)} unit="°C" values={telemetry.thermalTrace} tone="green" />
    </div>
  </aside>;
}
