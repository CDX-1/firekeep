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
  const [selectedDrone, setSelectedDrone] = useState<Drone | null>(null);
  const visibleDrones = activeFilter === "All" ? DRONES : DRONES.filter((drone) => drone.area === activeFilter);
  const selectedIndex = selectedDrone ? visibleDrones.findIndex((drone) => drone.name === selectedDrone.name) : -1;

  const selectArea = (area: Filter) => {
    setActiveFilter(area);
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

  return (
    <main className={styles.dashboard}>
      <h1>Drone Dashboard</h1>
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
                    <button key={drone.name} type="button" onClick={() => {
                      setActiveFilter(area);
                      setSelectedDrone(drone);
                    }}>{drone.name}</button>
                  ))}
                </div>
              </section>;
            })}
          </nav>}
        </aside>

        <section className={styles.grid} aria-label="Drone camera feeds">
          {visibleDrones.map((drone) => (
            <article className={styles.feed} key={drone.name}>
              <button className={styles.viewport} type="button" aria-label={`Open ${drone.name} feed`} onClick={() => setSelectedDrone(drone)}>
                <EmptyImage />
              </button>
              <p>{drone.name}</p>
            </article>
          ))}
        </section>
      </div>

      {selectedDrone && (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`${selectedDrone.name} feed`} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedDrone(null);
        }}>
          <div className={styles.viewer}>
            <button className={styles.viewerArrow} type="button" aria-label="Previous drone feed" onClick={() => moveViewer(-1)}>
              <Chevron direction="left" />
            </button>
            <div className={styles.viewerPanel}>
              <div className={styles.viewerImage}><EmptyImage /></div>
              <p>{selectedDrone.name}</p>
            </div>
            <button className={styles.viewerArrow} type="button" aria-label="Next drone feed" onClick={() => moveViewer(1)}>
              <Chevron direction="right" />
            </button>
          </div>
        </div>
      )}
    </main>
  );
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
