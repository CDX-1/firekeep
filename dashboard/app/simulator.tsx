"use client";

import styles from "./simulator.module.css";
import { EVENT_INFO, EVENT_KINDS, isPending, type EventKind, type SimEvent } from "@/lib/events";

/**
 * The rail beside the map in simulation mode: pick a disaster, size it, then click the world.
 *
 * The map owns the placement itself - this only says what the next click should do and shows
 * what every previous one did. Everything here is deliberately about the round trip: an event is
 * queued here, carried out in Minecraft, and only then does the log know what it burned.
 */

type SimulatorProps = {
  tool: EventKind;
  onTool: (kind: EventKind) => void;
  radius: number;
  onRadius: (blocks: number) => void;
  intensity: number;
  onIntensity: (amount: number) => void;
  events: SimEvent[];
  /** columns the mod currently reports burning, straight off the world feed */
  burning: number;
  /** whether the mod is pushing at all; nothing placed while it is not will ever land */
  live: boolean;
  error: string | null;
  onFocus: (event: SimEvent) => void;
};

/** How far a single event may be scattered. Well under the mod's own 128-block ceiling. */
export const MAX_RADIUS = 64;

export default function Simulator({
  tool, onTool, radius, onRadius, intensity, onIntensity,
  events, burning, live, error, onFocus,
}: SimulatorProps) {
  const info = EVENT_INFO[tool];
  const inFlight = events.filter(isPending).length;

  return (
    <aside className={styles.rail} aria-label="Disaster simulation">
      <header>
        <span>Disaster sim</span>
        <span className={styles.feedState} data-live={live}>
          {live ? "world live" : "no world"}
        </span>
      </header>

      <div className={styles.controls}>
        <div className={styles.kinds} role="group" aria-label="Event to place">
          {EVENT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              data-active={tool === kind}
              style={{ "--kind": EVENT_INFO[kind].color } as React.CSSProperties}
              onClick={() => onTool(kind)}
            >
              <i />
              <span>{EVENT_INFO[kind].label}</span>
            </button>
          ))}
        </div>

        <p className={styles.blurb}>{info.blurb}</p>

        {info.scatters && (
          <label className={styles.slider}>
            <span>Radius</span>
            <input
              type="range"
              min={0}
              max={MAX_RADIUS}
              value={radius}
              onChange={(e) => onRadius(Number(e.target.value))}
            />
            <b>{radius} m</b>
          </label>
        )}

        {info.unit && (
          <label className={styles.slider}>
            <span>Intensity</span>
            <input
              type="range"
              min={1}
              max={info.max}
              value={Math.min(intensity, info.max)}
              onChange={(e) => onIntensity(Number(e.target.value))}
            />
            <b>{Math.min(intensity, info.max)}</b>
          </label>
        )}
        {info.unit && <p className={styles.unit}>{info.unit}</p>}

        <p className={styles.place}>
          Click the map to place a {info.label.toLowerCase()}.
          {!live && " Nothing will land until Minecraft is running."}
        </p>
      </div>

      <ul className={styles.log}>
        {events.length === 0 && (
          <li className={styles.empty}>
            Nothing has been set off yet. Whatever you place here burns in the real world, and
            the map shows it spreading.
          </li>
        )}
        {events.map((event) => (
          <li key={event.id}>
            <button type="button" onClick={() => onFocus(event)}>
              <i style={{ background: EVENT_INFO[event.kind].color }} />
              <span className={styles.what}>
                {EVENT_INFO[event.kind].label}
                <em>{Math.round(event.x)}, {Math.round(event.z)}</em>
              </span>
              <span className={styles.outcome} data-status={event.status}>
                {outcome(event)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <footer>
        {error && <p className={styles.error}>{error}</p>}
        <p className={styles.tally}>
          <span data-burning={burning > 0}>{burning} burning</span>
          <span>{inFlight ? `${inFlight} in flight` : `${events.length} placed`}</span>
        </p>
      </footer>
    </aside>
  );
}

/** What became of one event, in the words of the thing it actually did. */
function outcome(event: SimEvent) {
  switch (event.status) {
    case "queued":
      return "queued";
    case "sent":
      return "in flight";
    case "dropped":
      return "never landed";
    case "failed":
      return event.error ? shorten(event.error) : "failed";
    case "detected": return "detected";
    case "validating": return "validating cluster";
    case "responding": return "crew responding";
    case "contained": return `${event.affected ?? 0} fire blocks remain`;
    case "cleared": return "cleared after dousing";
    case "escalated": return "spreading";
    default:
      break;
  }

  const count = event.affected ?? 0;
  switch (event.kind) {
    case "fire": return count === 0 ? "nothing caught" : `${count} lit`;
    case "lightning": return `${count} struck`;
    case "explosion": return `power ${count}`;
    default: return count === 0 ? "nothing to douse" : `${count} doused`;
  }
}

function shorten(message: string) {
  return message.length > 28 ? `${message.slice(0, 27)}…` : message;
}
