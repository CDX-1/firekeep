"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./page.module.css";
import IncidentReports from "./incident-reports";
import LiveMonitoring from "./live-monitoring";
import WorldMap from "./world-map";
import RiskMap from "./risk-map";
import { ActivityIcon, FlameIcon, GridIcon, MapIcon, ReportIcon, SearchIcon } from "./icons";

const TOOLS = [
  { id: "fleet", label: "Fleet", Icon: MapIcon },
  { id: "sim", label: "Disaster sim", Icon: FlameIcon },
  { id: "feeds", label: "Camera feeds", Icon: GridIcon },
  { id: "predictions", label: "Predictions", Icon: ActivityIcon },
  { id: "reports", label: "Incident reports", Icon: ReportIcon },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];
const OVERLAY_TOOLS: ToolId[] = ["feeds", "predictions", "reports"];

export default function Dashboard() {
  const [tool, setTool] = useState<ToolId>("fleet");
  const [now, setNow] = useState<Date | null>(null);
  const [request, setRequest] = useState<{ id: string } | null>(null);
  const [report, setReport] = useState<{ id: string } | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openDroneFeed = useCallback((id: string) => {
    setRequest({ id });
    setTool("feeds");
  }, []);

  const openReport = useCallback((id: string) => {
    setReport({ id });
    setTool("reports");
  }, []);

  const closeOverlay = useCallback(() => setTool("fleet"), []);

  return (
    <main className={styles.dashboard}>
      <header className={styles.topbar}>
        <h1>Firekeep</h1>
        <label className={styles.search}>
          <SearchIcon />
          <span className="sr-only">Search footage</span>
          <input type="search" placeholder="Search footage" />
        </label>
        <time dateTime={now?.toISOString()}>{now ? formatDateTime(now) : ""}</time>
      </header>

      <nav className={styles.tools} aria-label="Map tools">
        {TOOLS.map(({ id, label, Icon }) => (
          <button key={id} className={styles.tool} type="button" aria-pressed={tool === id} onClick={() => setTool(id)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <section className={styles.workspace} aria-label="Live world map">
        <WorldMap active mode={tool === "sim" ? "simulate" : "drones"} onOpenDroneFeed={openDroneFeed} />
      </section>

      {OVERLAY_TOOLS.includes(tool) && (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`${tool} tool`}>
          <div className={styles.overlayBar}>
            <span>{TOOLS.find((entry) => entry.id === tool)?.label}</span>
            <button type="button" onClick={closeOverlay}>Close</button>
          </div>
          <div className={styles.overlayBody}>
            {tool === "feeds" && <LiveMonitoring request={request} onReport={openReport} />}
            {tool === "predictions" && <RiskMap active onOpenDroneFeed={openDroneFeed} />}
            {tool === "reports" && <IncidentReports active request={report} />}
          </div>
        </div>
      )}
    </main>
  );
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "short", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}
