"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./page.module.css";
import LiveMonitoring from "./live-monitoring";
import WorldMap from "./world-map";
import { GridIcon, MapIcon, SearchIcon } from "./icons";
import { DRONES, type Drone } from "./drones";

const TABS = [
  { id: "feeds", label: "Camera feeds", title: "Live Monitoring", Icon: GridIcon },
  { id: "map", label: "World map", title: "World Map", Icon: MapIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>("feeds");
  const [now, setNow] = useState<Date | null>(null);
  const [drones, setDrones] = useState<Drone[]>(DRONES);
  const [requestedDrone, setRequestedDrone] = useState<string | null>(null);
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openDroneFeed = useCallback((name: string) => {
    setRequestedDrone(name);
    setTab("feeds");
  }, []);

  return (
    <main className={styles.dashboard}>
      <header className={styles.topbar}>
        <h1>{active.title}</h1>
        <label className={styles.search}>
          <SearchIcon />
          <span className="sr-only">Search footage</span>
          <input type="search" placeholder="Search footage" />
        </label>
        <time dateTime={now?.toISOString()}>{now ? formatDateTime(now) : ""}</time>
      </header>

      <div className={styles.tabs} role="tablist" aria-label="Dashboard views">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={styles.tab}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setTab(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Both panels stay mounted: the map keeps its pan, zoom and drone positions
          while you are off looking at the feeds. */}
      {TABS.map(({ id }) => (
        <div
          key={id}
          className={styles.panel}
          id={`panel-${id}`}
          role="tabpanel"
          aria-labelledby={`tab-${id}`}
          hidden={tab !== id}
        >
          {id === "feeds" ? (
            <LiveMonitoring drones={drones} requestedDrone={requestedDrone} />
          ) : (
            <WorldMap active={tab === "map"} onDronesChange={setDrones} onOpenDroneFeed={openDroneFeed} />
          )}
        </div>
      ))}
    </main>
  );
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
