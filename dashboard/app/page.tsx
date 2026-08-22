"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./page.module.css";
import IncidentReports from "./incident-reports";
import LiveMonitoring from "./live-monitoring";
import WorldMap from "./world-map";
import RiskMap from "./risk-map";
import { ActivityIcon, FlameIcon, GridIcon, MapIcon, ReportIcon, SearchIcon } from "./icons";

const TABS = [
  { id: "feeds", label: "Camera feeds", title: "Live Monitoring", Icon: GridIcon },
  { id: "map", label: "World map", title: "World Map", Icon: MapIcon },
  { id: "sim", label: "Disaster sim", title: "Disaster Simulation", Icon: FlameIcon },
  { id: "predictions", label: "Predictions", title: "Fire Risk Predictions", Icon: ActivityIcon },
  { id: "reports", label: "Incident reports", title: "Incident Reports", Icon: ReportIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** The two tabs that are the same map, differing only in what a click on it does. */
const MAP_TABS: TabId[] = ["map", "sim"];

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>("feeds");
  const [now, setNow] = useState<Date | null>(null);
  const [request, setRequest] = useState<{ id: string } | null>(null);
  const [report, setReport] = useState<{ id: string } | null>(null);
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // A new object every time, so asking for the same drone twice still reaches the feeds.
  const openDroneFeed = useCallback((id: string) => {
    setRequest({ id });
    setTab("feeds");
  }, []);

  // A feed has just had its drone photograph something. The report takes minutes to finish, so
  // the tab it lands on is opened now rather than when it is done - watching it fill in is the
  // only feedback that the shutter did anything.
  const openReport = useCallback((id: string) => {
    setReport({ id });
    setTab("reports");
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
            aria-controls={MAP_TABS.includes(id) ? "panel-map" : `panel-${id}`}
            onClick={() => setTab(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Every panel stays mounted: the map keeps its pan, zoom and drone positions while
          you are off looking at the feeds. The map and the simulator share one instance of
          it rather than each holding their own - two canvases and two world-feed connections
          would cost twice as much and then drift apart, and switching tabs would lose your
          place. Only what a click means changes. */}
      <div
        className={styles.panel}
        id="panel-feeds"
        role="tabpanel"
        aria-labelledby="tab-feeds"
        hidden={tab !== "feeds"}
      >
        <LiveMonitoring request={request} onReport={openReport} />
      </div>

      <div
        className={styles.panel}
        id="panel-map"
        role="tabpanel"
        aria-labelledby={`tab-${tab === "sim" ? "sim" : "map"}`}
        hidden={!MAP_TABS.includes(tab)}
      >
        <WorldMap
          active={MAP_TABS.includes(tab)}
          mode={tab === "sim" ? "simulate" : "drones"}
          onOpenDroneFeed={openDroneFeed}
        />
      </div>

      <div
        className={styles.panel}
        id="panel-predictions"
        role="tabpanel"
        aria-labelledby="tab-predictions"
        hidden={tab !== "predictions"}
      >
        <RiskMap active={tab === "predictions"} onOpenDroneFeed={openDroneFeed} />
      </div>

      <div
        className={styles.panel}
        id="panel-reports"
        role="tabpanel"
        aria-labelledby="tab-reports"
        hidden={tab !== "reports"}
      >
        <IncidentReports active={tab === "reports"} request={report} />
      </div>
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
