"use client";

import { useEffect, useState } from "react";
import styles from "./drone-event-window.module.css";
import { getDroneEvents, type DroneFeedEvent } from "@/lib/drone-events";

const REFRESH_MS = 2_500;

/** Recent workflow observations, layered over the camera rather than competing with it. */
export default function DroneEventWindow({ droneId, compact = false }: { droneId: string; compact?: boolean }) {
  const [events, setEvents] = useState<DroneFeedEvent[]>([]);

  useEffect(() => {
    let active = true;
    const refresh = () => getDroneEvents(droneId).then(({ events: next }) => {
      if (active) setEvents(next);
    }).catch(() => {
      // An unavailable event relay must never make the video feed look unavailable.
    });
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [droneId]);

  const visible = compact ? events.slice(0, 1) : events;
  return (
    <section className={styles.window} data-compact={compact} aria-label={`${droneId} incident events`}>
      <div className={styles.title}>Events</div>
      {visible.length === 0 ? <p className={styles.empty}>No events reported</p> : (
        <ol className={styles.list}>
          {visible.map((event) => <li key={event.id} data-severity={event.severity}>
            <span className={styles.type}>{event.type}</span>
            <span className={styles.message}>{event.message}</span>
            <span className={styles.location}>{formatLocation(event)}</span>
          </li>)}
        </ol>
      )}
    </section>
  );
}

function formatLocation(event: DroneFeedEvent) {
  const { x, y, z } = event.location;
  return x === null || z === null ? "Location unavailable" :
    `${Math.round(x)}, ${y === null ? "?" : Math.round(y)}, ${Math.round(z)}`;
}
