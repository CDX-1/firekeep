"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

const AREAS = ["Northeast", "Northwest", "Southwest", "Southeast"] as const;
type Area = (typeof AREAS)[number];
type Filter = "All" | Area;
type Drone = { name: string; area: Area };

const DRONES: Drone[] = AREAS.flatMap((area, areaIndex) =>
  Array.from({ length: 3 }, (_, index) => ({ name: `Drone ${areaIndex * 3 + index + 1}`, area })),
);

export default function Dashboard() {
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focusedDrone, setFocusedDrone] = useState<Drone | null>(null);
  const [selectedDrone, setSelectedDrone] = useState<Drone | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const filteredDrones = activeFilter === "All" ? DRONES : DRONES.filter((drone) => drone.area === activeFilter);
  const visibleDrones = focusedDrone ? [focusedDrone] : filteredDrones;
  const selectedIndex = selectedDrone ? visibleDrones.findIndex((drone) => drone.name === selectedDrone.name) : -1;

  const selectArea = (area: Filter) => {
    setActiveFilter(area);
    setFocusedDrone(null);
    setSelectedDrone(null);
  };

  const moveViewer = (offset: number) => {
    if (selectedIndex < 0) return;
    setSelectedDrone(visibleDrones[(selectedIndex + offset + visibleDrones.length) % visibleDrones.length]);
  };

  useEffect(() => {
    if (!selectedDrone) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedDrone(null);
      if (event.key === "ArrowLeft") moveViewer(-1);
      if (event.key === "ArrowRight") moveViewer(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedDrone, selectedIndex, visibleDrones]);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className={styles.dashboard}>
      <header className={styles.topbar}>
        <h1>Live Monitoring</h1>
        <label className={styles.search}>
          <SearchIcon />
          <span className={styles.srOnly}>Search footage</span>
          <input type="search" placeholder="Search footage" />
        </label>
        <time dateTime={now?.toISOString()}>{now ? formatDateTime(now) : ""}</time>
      </header>
      <div className={styles.workspace} data-sidebar-collapsed={sidebarCollapsed}>
        <aside className={styles.sidebar} aria-label="Drone regions">
          <button
            className={styles.sidebarToggle}
            type="button"
            aria-label={`${sidebarCollapsed ? "Show" : "Hide"} region filters`}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <Chevron direction={sidebarCollapsed ? "right" : "left"} />
          </button>
          {!sidebarCollapsed && <nav className={styles.regionList}>
            <button className={styles.allDrones} data-active={activeFilter === "All"} type="button" onClick={() => selectArea("All")}>
              <span>All</span><span>{DRONES.length}</span>
            </button>
            {AREAS.map((area) => {
              const areaDrones = DRONES.filter((drone) => drone.area === area);
              return <section className={styles.area} key={area}>
                <button className={styles.areaSelect} data-active={activeFilter === area} type="button" onClick={() => selectArea(area)}>
                  <span>{area}</span><span>{areaDrones.length}</span>
                </button>
                <div className={styles.droneList}>
                  {areaDrones.map((drone) => (
                    <button key={drone.name} data-active={focusedDrone?.name === drone.name} type="button" onClick={() => {
                      setActiveFilter(area);
                      setFocusedDrone(drone);
                      setSelectedDrone(null);
                    }}><i /><CameraIcon /><span>{drone.name}</span></button>
                  ))}
                </div>
              </section>;
            })}
          </nav>}
        </aside>

        <section className={styles.grid} data-focused={Boolean(focusedDrone)} data-count={visibleDrones.length} aria-label="Drone camera feeds">
          {visibleDrones.map((drone) => (
            <article className={styles.feed} key={drone.name}>
              <button className={styles.viewport} type="button" aria-label={`Open ${drone.name} feed`} onClick={() => setSelectedDrone(drone)}>
                <EmptyImage />
                <span className={styles.feedLabel}>{drone.name}</span>
              </button>
            </article>
          ))}
        </section>
      </div>

      {selectedDrone && (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`${selectedDrone.name} feed`} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedDrone(null);
        }}>
          <div className={styles.viewer} data-single={visibleDrones.length === 1}>
            {visibleDrones.length > 1 && <button className={styles.viewerArrow} type="button" aria-label="Previous drone feed" onClick={() => moveViewer(-1)}>
              <Chevron direction="left" />
            </button>}
            <div className={styles.viewerPanel} key={selectedDrone.name}>
              <div className={styles.viewerImage}><EmptyImage /></div>
              <p>{selectedDrone.name}</p>
            </div>
            {visibleDrones.length > 1 && <button className={styles.viewerArrow} type="button" aria-label="Next drone feed" onClick={() => moveViewer(1)}>
              <Chevron direction="right" />
            </button>}
          </div>
        </div>
      )}
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

function EmptyImage() {
  return <span className={styles.emptyImage}><ImageIcon /><span>No image received</span></span>;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  const paths = { left: "m14.5 4-8 8 8 8", right: "m9.5 4 8 8-8 8" };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[direction]} /></svg>;
}

function ImageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="1" /><circle cx="8.5" cy="9" r="1.4" /><path d="m4 17 4.8-4.8 3.15 3.15 2.25-2.25L20 19" /></svg>;
}

function CameraIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 4.5 10.4 3h3.2l1.2 1.5H18A2.5 2.5 0 0 1 20.5 7v9A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16V7A2.5 2.5 0 0 1 6 4.5h3.2Z" /><circle cx="12" cy="11.5" r="3" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg>;
}
