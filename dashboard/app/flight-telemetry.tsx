"use client";

import { useEffect, useMemo, useState } from "react";
import type { Drone } from "@/lib/use-cameras";
import styles from "./flight-telemetry.module.css";

type Telemetry = {
  battery: number;
  voltage: number;
  batteryTemp: number;
  motorTemp: number;
  signal: number;
  latency: number;
  speed: number;
  altitude: number;
  voltageTrace: number[];
  thermalTrace: number[];
};

export type DroneTrailPoint = {
  x: number;
  z: number;
  at: number;
  stopped: boolean;
};

/**
 * A deliberately isolated demo feed. The camera API does not emit hardware telemetry yet, but
 * having the presentation wired in lets the real sensor payload replace this one field-for-field.
 */
function simulatedTelemetry(drone: Drone, now: number): Telemetry {
  const seed = Array.from(drone.id).reduce((sum, character) => sum + character.charCodeAt(0), 0);
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

  return {
    battery,
    voltage,
    batteryTemp,
    motorTemp: 43 + wave(2.5) * 4.2,
    signal: 89 + Math.round(wave(3.1) * 5),
    latency: 24 + Math.round(Math.abs(wave(1.8)) * 11),
    speed,
    altitude,
    voltageTrace: trace(voltage, 0.24, 0),
    thermalTrace: trace(batteryTemp, 1.8, 0.9),
  };
}

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

export default function FlightTelemetry({ drone, trail }: { drone: Drone; trail: DroneTrailPoint[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const telemetry = useMemo(() => simulatedTelemetry(drone, now), [drone, now]);

  return <aside className={styles.telemetry} aria-label={`${drone.id} flight telemetry`}>
    <header className={styles.header}>
      <div>
        <h2>Flight telemetry</h2>
        <p>Simulated sensor feed</p>
      </div>
      <span className={styles.state}>{drone.live ? "Link active" : "Link delayed"}</span>
    </header>

    <RouteTrace points={trail} />

    <div className={styles.primaryReadings}>
      <Reading label="Battery" value={telemetry.battery.toFixed(0)} unit="%" warning={telemetry.battery < 30} />
      <Reading label="Altitude" value={telemetry.altitude.toFixed(1)} unit="m" />
      <Reading label="Ground speed" value={telemetry.speed.toFixed(1)} unit="m/s" />
      <Reading label="Signal" value={telemetry.signal.toFixed(0)} unit="%" />
    </div>

    <div className={styles.traces}>
      <Trace label="Battery voltage" value={telemetry.voltage.toFixed(1)} unit="V" values={telemetry.voltageTrace} tone="amber" />
      <Trace label="Battery temperature" value={telemetry.batteryTemp.toFixed(1)} unit="°C" values={telemetry.thermalTrace} tone="green" />
    </div>

    <div className={styles.systems}>
      <Reading label="Motor temperature" value={telemetry.motorTemp.toFixed(1)} unit="°C" />
      <Reading label="Video latency" value={telemetry.latency.toFixed(0)} unit="ms" />
      <Reading label="Camera profile" value={drone.detail ? "Detail" : "Grid"} unit="" />
      <Reading label="Frames captured" value={drone.frames.toLocaleString()} unit="" />
    </div>
  </aside>;
}
