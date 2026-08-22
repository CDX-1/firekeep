"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import styles from "./drone-controls.module.css";
import { sendDroneFly, sendDroneHover, sendDroneLook } from "@/lib/live";
import { DEFAULT_PITCH, rememberPitch } from "@/lib/camera-view";
import type { DroneCamera } from "@/lib/types";

/**
 * How often a held stick is re-sent.
 *
 * The drone keeps the last stick on its own, so this is only a keepalive in case a feed
 * POST dropped the order. Faster than the mod's flush is wasted.
 */
const HOLD_TICK_MS = 200;

type Stick = { forward: number; right: number; up: number; yaw: number };

const MOVE: Record<string, Partial<Stick>> = {
  w: { forward: 1 },
  s: { forward: -1 },
  a: { right: -1 },
  d: { right: 1 },
  " ": { up: 1 },
  shift: { up: -1 },
};

const LOOK: Record<string, number> = {
  q: -1,
  e: 1,
};

/**
 * Manual flight for the drone being watched.
 *
 * <p>Keys are a Minecraft creative stick, not a series of gotos. Holding W asks the drone to
 * keep flying along the camera; letting go tells it to hover. The mod applies that velocity
 * itself, so the feed shows the real motion rather than a destination jumping 15 blocks at a
 * time.
 *
 * <p>Directions are from the drone's point of view because the operator is looking through
 * that camera. Q and E turn in place the way the mouse would in game.
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
  const [error, setError] = useState<string | null>(null);
  const [flying, setFlying] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [pitch, setPitch] = useState(DEFAULT_PITCH);

  const id = useRef(drone.id);
  id.current = drone.id;
  const pressed = useRef(new Set<string>());
  const flyingRef = useRef(false);
  const pitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const stickOf = useCallback((): Stick => {
    const stick: Stick = { forward: 0, right: 0, up: 0, yaw: 0 };
    for (const key of pressed.current) {
      const move = MOVE[key];
      if (move) {
        stick.forward += move.forward ?? 0;
        stick.right += move.right ?? 0;
        stick.up += move.up ?? 0;
      }
      stick.yaw += LOOK[key] ?? 0;
    }
    return stick;
  }, []);

  const applyStick = useCallback(() => {
    const stick = stickOf();
    const moving = Boolean(stick.forward || stick.right || stick.up || stick.yaw);
    flyingRef.current = moving;
    setFlying(moving);
    setError(null);
    if (moving) {
      void sendDroneFly(id.current, stick).catch(report);
    } else {
      void sendDroneHover(id.current).catch(report);
    }
  }, [report, stickOf]);

  const hover = useCallback(() => {
    pressed.current.clear();
    setHeld([]);
    flyingRef.current = false;
    setFlying(false);
    setError(null);
    void sendDroneHover(id.current).catch(report);
  }, [report]);

  const setKey = useCallback((key: string, down: boolean) => {
    const keys = pressed.current;
    if (down) {
      if (keys.has(key)) return;
      keys.add(key);
    } else if (!keys.delete(key)) {
      return;
    }
    setHeld([...keys]);
  }, []);

  const clearKeys = useCallback(() => {
    pressed.current.clear();
    setHeld([]);
  }, []);

  const setCameraPitch = useCallback((next: number) => {
    setPitch(next);
    // Nothing reports the camera's tilt back, so the instrument layer aims with what we asked
    // for. Told here rather than when the order lands, so the sight moves with the slider.
    rememberPitch(id.current, next);
    if (pitchTimer.current !== null) clearTimeout(pitchTimer.current);
    pitchTimer.current = setTimeout(() => {
      pitchTimer.current = null;
      void sendDroneLook(id.current, next).catch(report);
    }, 120);
  }, [report]);

  // Handing control back, or moving to another drone, must not leave a key stuck down -
  // and a stick that was live has to be cancelled or the drone keeps flying on its own.
  useEffect(() => {
    clearKeys();
    setFlying(false);
    setError(null);
    if (!controlling) return;
    const watched = drone.id;
    return () => {
      if (flyingRef.current) void sendDroneHover(watched);
      flyingRef.current = false;
      if (pitchTimer.current !== null) clearTimeout(pitchTimer.current);
    };
  }, [drone.id, controlling, clearKeys]);

  useEffect(() => {
    if (!controlling) return;

    const keyOf = (event: KeyboardEvent) => {
      const key = event.key === "Shift" ? "shift" : event.key.toLowerCase();
      return key in MOVE || key in LOOK ? key : null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) {
        return;
      }

      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        hover();
        return;
      }

      const key = keyOf(event);
      if (!key) return;
      // Space scrolls the page and would re-press whichever button has focus - such as the one
      // that took control in the first place.
      event.preventDefault();
      if (event.repeat) return;
      setKey(key, true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyOf(event);
      if (!key) return;
      setKey(key, false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hover);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hover);
    };
  }, [controlling, hover, setKey]);

  // Push the stick whenever the held set changes, and keep it alive while anything is down.
  useEffect(() => {
    if (!controlling) return;
    applyStick();
    if (held.length === 0) return;
    const timer = setInterval(applyStick, HOLD_TICK_MS);
    return () => clearInterval(timer);
  }, [controlling, held, applyStick]);

  const bindPad = (key: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (!controlling) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setKey(key, true);
    },
    onPointerUp: () => setKey(key, false),
    onPointerCancel: () => setKey(key, false),
  });

  return (
    <div className={styles.controls} data-controlling={controlling} data-compact={compact} aria-label={`Fly ${drone.id}`}>
      <div className={styles.pad} data-live={controlling}>
        <button type="button" className={styles.up} disabled={!controlling} data-held={held.includes("w")} {...bindPad("w")} aria-label="Forward" title="Forward (W)"><Arrow direction="up" /></button>
        <button type="button" className={styles.left} disabled={!controlling} data-held={held.includes("a")} {...bindPad("a")} aria-label="Left" title="Left (A)"><Arrow direction="left" /></button>
        <button type="button" className={styles.hold} disabled={!controlling} onClick={hover} title="Hold position (H)">Hold</button>
        <button type="button" className={styles.right} disabled={!controlling} data-held={held.includes("d")} {...bindPad("d")} aria-label="Right" title="Right (D)"><Arrow direction="right" /></button>
        <button type="button" className={styles.down} disabled={!controlling} data-held={held.includes("s")} {...bindPad("s")} aria-label="Back" title="Back (S)"><Arrow direction="down" /></button>
      </div>

      <div className={styles.altitude}>
        <button type="button" disabled={!controlling} data-held={held.includes(" ")} {...bindPad(" ")} title="Climb (Space)"><Arrow direction="up" /><span>Space</span></button>
        <button type="button" disabled={!controlling} data-held={held.includes("shift")} {...bindPad("shift")} title="Descend (Shift)"><Arrow direction="down" /><span>Shift</span></button>
      </div>

      <div className={styles.settings}>
        <div className={styles.topRow}>
          <label className={styles.pitch}>
            <span>Camera down</span>
            <input
              type="range"
              min="0"
              max="90"
              step="1"
              value={pitch}
              disabled={!controlling}
              onChange={(event) => setCameraPitch(Number(event.target.value))}
              aria-label="Camera downward angle"
            />
            <output>{pitch}°</output>
          </label>
          <button
            type="button"
            className={styles.take}
            data-on={controlling}
            aria-pressed={controlling}
            onClick={() => onToggleControl(!controlling)}
          >{controlling ? "Release" : "Take control"}</button>
        </div>
        <p className={styles.status} data-error={Boolean(error)}>
          {error
            ? `Order failed: ${error}`
            : !controlling
              ? "Take control to fly this drone from the keyboard"
              : flying
                ? "Flying — W A S D · Q / E turn · Space / Shift · H hold"
                : "W A S D fly · Q / E turn · Space climb · Shift descend · H hold"}
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
