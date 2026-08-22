"use client";

import { useEffect, useState } from "react";
import styles from "./live-monitoring.module.css";
import { AREAS, DRONES, type Drone, type Filter } from "./drones";
import { CameraIcon, Chevron, EmptyImage } from "./icons";

export default function LiveMonitoring() {
  const [activeFilter, setActiveFilter] = useState<Filter>("All");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focusedDrone, setFocusedDrone] = useState<Drone | null>(null);
  const [selectedDrone, setSelectedDrone] = useState<Drone | null>(null);
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

  return (
    <>
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
                <EmptyImage ratio />
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
    </>
  );
}
