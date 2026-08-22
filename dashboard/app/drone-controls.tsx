"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./drone-controls.module.css";
import { sendDroneTo } from "@/lib/live";
import type { DroneCamera } from "@/lib/types";

/** How far one nudge moves the drone, in blocks. */
const STEPS = [5, 15, 50] as const;
const DEFAULT_STEP = 15;

/** Build height limits, so a nudge can never order a drone outside the world. */
const MIN_Y = -60;
const MAX_Y = 310;

/**
 * How long a command keeps being the thing the next one builds on.
 *
 * The roster only refreshes about once a second, so pressing forward three times quickly would
 * otherwise send three orders to nearly the same place. Each command stacks on the last instead,
 * until this lapses and the drone's actual reported position takes over again.
 */
const STACK_MS = 2500;

type Command = { x: number; y: number; z: number; at: number };

/**
 * Manual flight for the drone being watched.
 *
 * <p>There is no new machinery behind this: every button works out a point relative to where the
 * drone is and sends the same goto order the map's arrow-drag uses. The mod collects it on its
 * next world-feed push and flies there itself, so what you see in the feed is the drone actually
 * moving rather than anything predicted here.
 *
 * <p>Directions are from the drone's point of view - forward is where the camera is looking -
 * because the operator is looking through that camera while pressing the keys.
 */
export default function DroneControls({ drone, armed = true }: { drone: DroneCamera; armed?: boolean }) {
  const [step, setStep] = useState<number>(DEFAULT_STEP);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Command | null>(null);
  const stacked = useRef<Command | null>(null);

  // A different drone is a different flight; nothing from the last one carries over.
  useEffect(() => {
    stacked.current = null;
    setSent(null);
    setError(null);
  }, [drone.id]);

  const order = useCallback((x: number, y: number, z: number) => {
    const command: Command = { x, y, z, at: Date.now() };
    stacked.current = command;
    setSent(command);
    setError(null);
    void sendDroneTo(drone.id, x, y, z).catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)));
  }, [drone.id]);

  /** Where the next nudge starts from: the last command while it is fresh, else the drone. */
  const from = useCallback(() => {
    const last = stacked.current;
    if (last && Date.now() - last.at < STACK_MS) return last;
    return { x: drone.x, y: drone.y, z: drone.z };
  }, [drone.x, drone.y, drone.z]);

  const move = useCallback((forward: number, right: number, up: number) => {
    const base = from();
    // Minecraft yaw: 0 faces +Z, and turning increases it towards -X.
    const yaw = (drone.yaw * Math.PI) / 180;
    const forwardX = -Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = -Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    order(
      base.x + (forwardX * forward + rightX * right) * step,
      Math.min(MAX_Y, Math.max(MIN_Y, base.y + up * step)),
      base.z + (forwardZ * forward + rightZ * right) * step,
    );
  }, [drone.yaw, from, order, step]);

  /** Holding is an order to where it already is; the mod counts that as arrived and stops. */
  const hold = useCallback(() => {
    stacked.current = null;
    order(drone.x, drone.y, drone.z);
  }, [drone.x, drone.y, drone.z, order]);

  useEffect(() => {
    if (!armed) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // never fly the drone while somebody is typing in the search box
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case "w": move(1, 0, 0); break;
        case "s": move(-1, 0, 0); break;
        case "a": move(0, -1, 0); break;
        case "d": move(0, 1, 0); break;
        case "r": move(0, 0, 1); break;
        case "f": move(0, 0, -1); break;
        case "h": hold(); break;
        default: return;
      }
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [armed, move, hold]);

  return (
    <div className={styles.controls} aria-label={`Fly ${drone.id}`}>
      <div className={styles.pad}>
        <button type="button" className={styles.up} onClick={() => move(1, 0, 0)} aria-label="Forward" title="Forward (W)"><Arrow direction="up" /></button>
        <button type="button" className={styles.left} onClick={() => move(0, -1, 0)} aria-label="Left" title="Left (A)"><Arrow direction="left" /></button>
        <button type="button" className={styles.hold} onClick={hold} title="Hold position (H)">Hold</button>
        <button type="button" className={styles.right} onClick={() => move(0, 1, 0)} aria-label="Right" title="Right (D)"><Arrow direction="right" /></button>
        <button type="button" className={styles.down} onClick={() => move(-1, 0, 0)} aria-label="Back" title="Back (S)"><Arrow direction="down" /></button>
      </div>

      <div className={styles.altitude}>
        <button type="button" onClick={() => move(0, 0, 1)} title="Climb (R)"><Arrow direction="up" /><span>Climb</span></button>
        <button type="button" onClick={() => move(0, 0, -1)} title="Descend (F)"><Arrow direction="down" /><span>Descend</span></button>
      </div>

      <div className={styles.settings}>
        <p className={styles.stepLabel}>Step</p>
        <div className={styles.steps} role="group" aria-label="Step size in blocks">
          {STEPS.map((size) => (
            <button
              key={size}
              type="button"
              data-active={step === size}
              onClick={() => setStep(size)}
              aria-pressed={step === size}
            >{size}</button>
          ))}
        </div>
        <p className={styles.status} data-error={Boolean(error)}>
          {error
            ? `Order failed: ${error}`
            : sent
              ? `Sent to ${Math.round(sent.x)}, ${Math.round(sent.y)}, ${Math.round(sent.z)}`
              : "W A S D fly · R F altitude · H hold"}
        </p>
      </div>
    </div>
  );
}

function Arrow({ direction }: { direction: "up" | "down" | "left" | "right" }) {
  const paths = {
    up: "M12 19V5m0 0-6 6m6-6 6 6",
    down: "M12 5v14m0 0 6-6m-6 6-6-6",
    left: "M19 12H5m0 0 6-6m-6 6 6 6",
    right: "M5 12h14m0 0-6-6m6 6-6 6",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[direction]} /></svg>;
}
