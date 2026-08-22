"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./drone-controls.module.css";
import { sendDroneTo } from "@/lib/live";
import type { DroneCamera } from "@/lib/types";

/** How far ahead of the drone a nudge aims, in blocks. */
const STEPS = [5, 15, 50] as const;
const DEFAULT_STEP = 15;

/** Build height limits, so an order can never send a drone outside the world. */
const MIN_Y = -60;
const MAX_Y = 310;

/**
 * How often a held key re-aims the drone.
 *
 * Each tick points at a spot one step ahead of where the drone actually is, so holding a key
 * keeps a moving destination in front of it and letting go leaves it flying to the last one.
 * Slower than this and flight is lurchy; faster is wasted, since the mod only collects orders
 * when it pushes its feed, about five times a second.
 */
const HOLD_TICK_MS = 180;

type Direction = { forward: number; right: number; up: number };
type Command = { x: number; y: number; z: number };

const KEYS: Record<string, Direction> = {
  w: { forward: 1, right: 0, up: 0 },
  s: { forward: -1, right: 0, up: 0 },
  a: { forward: 0, right: -1, up: 0 },
  d: { forward: 0, right: 1, up: 0 },
  " ": { forward: 0, right: 0, up: 1 },
  shift: { forward: 0, right: 0, up: -1 },
};

/**
 * Manual flight for the drone being watched.
 *
 * <p>There is no new machinery behind this: every order is the same goto the map's arrow-drag
 * sends, worked out relative to where the drone actually is. The mod collects it on its next
 * world-feed push and flies there itself, so the feed shows the drone really moving rather than
 * anything guessed at here.
 *
 * <p>Directions are from the drone's point of view - forward is where the camera is looking -
 * because the operator is looking through that camera while flying it.
 *
 * <p>Every order aims one step ahead of the drone's current position rather than stacking on the
 * last one. Holding a key therefore keeps a destination a fixed distance in front of it, which
 * flies smoothly and, more importantly, cannot run away: let go and the drone is at most one step
 * from where it stops.
 */
export default function DroneControls({
  drone,
  controlling,
  onToggleControl,
  compact = false,
}: {
  drone: DroneCamera;
  controlling: boolean;
  onToggleControl: (next: boolean) => void;
  /** A grid tile: room for the bar, but not for a pad on top of a thumbnail. */
  compact?: boolean;
}) {
  const [step, setStep] = useState<number>(DEFAULT_STEP);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Command | null>(null);
  const [held, setHeld] = useState<string[]>([]);

  // Read by the hold timer, which must see the newest values without being restarted.
  const latest = useRef({ drone, step });
  latest.current = { drone, step };
  const pressed = useRef(new Set<string>());

  const order = useCallback((x: number, y: number, z: number) => {
    const command = { x, y, z };
    setSent(command);
    setError(null);
    void sendDroneTo(latest.current.drone.id, x, y, z).catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  /** Aims one step ahead of the drone, along the given direction in its own frame. */
  const move = useCallback((direction: Direction) => {
    const { drone: at, step: size } = latest.current;
    // Minecraft yaw: 0 faces +Z, and turning increases it towards -X.
    const yaw = (at.yaw * Math.PI) / 180;
    const forwardX = -Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = -Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    order(
      at.x + (forwardX * direction.forward + rightX * direction.right) * size,
      Math.min(MAX_Y, Math.max(MIN_Y, at.y + direction.up * size)),
      at.z + (forwardZ * direction.forward + rightZ * direction.right) * size,
    );
  }, [order]);

  /** Holding is an order to where it already is; the mod counts that as arrived and stops. */
  const hold = useCallback(() => {
    const at = latest.current.drone;
    order(at.x, at.y, at.z);
  }, [order]);

  const clearKeys = useCallback(() => {
    pressed.current.clear();
    setHeld([]);
  }, []);

  // Handing control back, or moving to another drone, must not leave a key stuck down.
  useEffect(() => {
    clearKeys();
    setSent(null);
    setError(null);
  }, [drone.id, controlling, clearKeys]);

  useEffect(() => {
    if (!controlling) return;

    const keyOf = (event: KeyboardEvent) => {
      const key = event.key === "Shift" ? "shift" : event.key.toLowerCase();
      return key in KEYS ? key : null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) {
        return;
      }

      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        hold();
        return;
      }

      const key = keyOf(event);
      if (!key) return;
      // Space scrolls the page and would re-press whichever button has focus - such as the one
      // that took control in the first place.
      event.preventDefault();
      if (event.repeat) return;             // the hold timer does the repeating, not the OS
      pressed.current.add(key);
      setHeld([...pressed.current]);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyOf(event);
      if (!key) return;
      pressed.current.delete(key);
      setHeld([...pressed.current]);
    };

    // Alt-tabbing away with a key down would otherwise fly the drone off forever.
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
      clearKeys();
    };
  }, [controlling, hold, clearKeys]);

  // While anything is held, keep re-aiming ahead of the drone.
  useEffect(() => {
    if (!controlling || held.length === 0) return;

    const fly = () => {
      const direction = { forward: 0, right: 0, up: 0 };
      for (const key of pressed.current) {
        const part = KEYS[key];
        direction.forward += part.forward;
        direction.right += part.right;
        direction.up += part.up;
      }
      if (direction.forward || direction.right || direction.up) move(direction);
    };

    fly();
    const timer = setInterval(fly, HOLD_TICK_MS);
    return () => clearInterval(timer);
  }, [controlling, held, move]);

  return (
    <div className={styles.controls} data-controlling={controlling} data-compact={compact} aria-label={`Fly ${drone.id}`}>
      <div className={styles.pad} data-live={controlling}>
        <button type="button" className={styles.up} disabled={!controlling} data-held={held.includes("w")} onClick={() => move(KEYS.w)} aria-label="Forward" title="Forward (W)"><Arrow direction="up" /></button>
        <button type="button" className={styles.left} disabled={!controlling} data-held={held.includes("a")} onClick={() => move(KEYS.a)} aria-label="Left" title="Left (A)"><Arrow direction="left" /></button>
        <button type="button" className={styles.hold} disabled={!controlling} onClick={hold} title="Hold position (H)">Hold</button>
        <button type="button" className={styles.right} disabled={!controlling} data-held={held.includes("d")} onClick={() => move(KEYS.d)} aria-label="Right" title="Right (D)"><Arrow direction="right" /></button>
        <button type="button" className={styles.down} disabled={!controlling} data-held={held.includes("s")} onClick={() => move(KEYS.s)} aria-label="Back" title="Back (S)"><Arrow direction="down" /></button>
      </div>

      <div className={styles.altitude}>
        <button type="button" disabled={!controlling} data-held={held.includes(" ")} onClick={() => move(KEYS[" "])} title="Climb (Space)"><Arrow direction="up" /><span>Space</span></button>
        <button type="button" disabled={!controlling} data-held={held.includes("shift")} onClick={() => move(KEYS.shift)} title="Descend (Shift)"><Arrow direction="down" /><span>Shift</span></button>
      </div>

      <div className={styles.settings}>
        <div className={styles.topRow}>
          <button
            type="button"
            className={styles.take}
            data-on={controlling}
            aria-pressed={controlling}
            onClick={() => onToggleControl(!controlling)}
          >{controlling ? "Release" : "Take control"}</button>
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
        </div>
        <p className={styles.status} data-error={Boolean(error)}>
          {error
            ? `Order failed: ${error}`
            : !controlling
              ? "Take control to fly this drone from the keyboard"
              : sent
                ? `W A S D · Space / Shift · H hold — heading for ${Math.round(sent.x)}, ${Math.round(sent.y)}, ${Math.round(sent.z)}`
                : "W A S D fly · Space climb · Shift descend · H hold · Esc release"}
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
