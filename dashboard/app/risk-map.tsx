"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./risk-map.module.css";
import { getWorld, worldMapUrl } from "@/lib/api";
import { fallbackWorld } from "./fallback-world";
import {
  GRID_COLS,
  GRID_ROWS,
  MAX_RISK,
  RISK_LABELS,
  cellOf,
  emptyGrid,
  type RiskCell,
  type RiskReport,
} from "@/lib/risk";
import { useIntel } from "@/lib/fleet-intel";
import { ROLE_LIST, callsignOf, roleOf } from "@/lib/roles";
import type { WorldMeta } from "@/lib/types";

// -------------------------------------------------------------------------
// Types

type View = { x: number; y: number; scale: number };
type Backdrop = { meta: WorldMeta; image: CanvasImageSource; real: boolean };

// -------------------------------------------------------------------------
// Risk colour scale — 5 bands, one per risk level.
//
// The overlay sits on a full-colour world map, so a plain translucent fill
// would pick up whatever is underneath and read as a different colour over
// water than over forest. To keep each band looking the same everywhere, the
// grid is drawn in two passes: a uniform dark scrim over the whole map first,
// then the band colours on top of that known, flat substrate.

/** Map a 1-5 risk score to its 0-indexed colour band. */
function riskBand(risk: number): number { return clampRisk(risk) - 1; }

/** Flat dark wash laid over the map before any band colour is drawn. */
const SCRIM = "rgba(9, 11, 16, 0.38)";

const BAND_FILL = [
  "rgba( 34, 197,  94, 0.42)",  // 1 – green
  "rgba(234, 204,   8, 0.42)",  // 2 – amber
  "rgba(249, 115,  22, 0.44)",  // 3 – orange
  "rgba(239,  68,  68, 0.46)",  // 4 – red
  "rgba(192,  38, 211, 0.48)",  // 5 – vivid purple (extreme)
] as const;

const BAND_STROKE = [
  "rgb( 74, 222, 128)",  // green
  "rgb(250, 204,  21)",  // amber
  "rgb(251, 146,  60)",  // orange
  "rgb(248, 113, 113)",  // red
  "rgb(217,  70, 239)",  // vivid purple (extreme)
] as const;

function clampRisk(risk: number): number { return Math.min(MAX_RISK, Math.max(1, Math.round(risk))); }

// -------------------------------------------------------------------------
// The prediction backend
//
// /api/predict runs the spread model over the live fire feed: burn envelope downwind of the
// front, plus the ember-cast pockets ahead of it. It answers 200 even when the feed is missing,
// falling back to an empty grid, so there is no error branch to handle here - only a `source`.

async function fetchPrediction(signal: AbortSignal): Promise<RiskReport> {
  const res = await fetch("/api/predict", { method: "POST", cache: "no-store", signal });
  if (!res.ok) throw new Error(`/api/predict -> ${res.status}`);
  return res.json() as Promise<RiskReport>;
}

// -------------------------------------------------------------------------
// Helpers

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.crossOrigin = "anonymous";
    img.src = src;
  });
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 12;
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// -------------------------------------------------------------------------
// Component

export default function RiskMap({ active, onOpenDroneFeed }: {
  active: boolean;
  /** Hands a drone over to the camera wall, the same way the world map does. */
  onOpenDroneFeed: (id: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const fittedRef = useRef(false);
  const isDragging = useRef(false);
  const dragStart = useRef({ px: 0, py: 0, vx: 0, vy: 0 });
  const pointerMoved = useRef(0);

  const [backdrop, setBackdrop] = useState<Backdrop | null>(null);
  const [cells, setCells] = useState<RiskCell[][]>([]);
  const [report, setReport] = useState<RiskReport | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [selected, setSelected] = useState<{ col: number; row: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hoveredCell, setHoveredCell] = useState<{ col: number; row: number } | null>(null);

  // Read the selection out of the live grid rather than holding a copy, so a cell whose risk the
  // forecast has just revised does not sit stale behind an open popup.
  const selectedCell = selected ? cells[selected.row]?.[selected.col] ?? null : null;

  /*
   * Who is over the selected cell, right now.
   *
   * The report carries a drone *count* per cell, taken when the forecast ran - which can be half
   * a minute old, and never said which aircraft anyway. The live feed is already being
   * polled for the rest of the dashboard, so the panel names them off that instead: a count that
   * disagrees with the roster is worse than no count, and "two on station" is a different
   * situation from "two surveyors on station and no suppression".
   */
  const intel = useIntel(active);
  const onStation = selected && intel.bounds
    ? intel.drones.filter((drone) => {
        const at = cellOf(drone.x, drone.z, intel.bounds!);
        return at && at.col === selected.col && at.row === selected.row;
      })
    : [];

  // -----------------------------------------------------------------------
  // Load world

  useEffect(() => {
    async function load() {
      try {
        const meta = await getWorld();
        const image = await loadImage(worldMapUrl());
        setBackdrop({ meta, image, real: true });
      } catch {
        const fb = fallbackWorld();
        setBackdrop({ meta: fb.meta, image: fb.image, real: false });
      }
    }
    void load();
  }, []);

  // -----------------------------------------------------------------------
  // Fit viewport

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !backdrop) return;
    const { clientWidth: w, clientHeight: h } = stage;
    if (!w || !h) return;
    const { width, height } = backdrop.meta;
    const scale = clamp(Math.min(w / width, h / height) * 0.94, MIN_SCALE, MAX_SCALE);
    viewRef.current = {
      scale,
      x: (w - width * scale) / 2,
      y: (h - height * scale) / 2,
    };
    setZoom(scale);
    fittedRef.current = true;
  }, [backdrop]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const obs = new ResizeObserver(() => { if (!fittedRef.current && stage.clientWidth > 0) fit(); });
    obs.observe(stage);
    return () => obs.disconnect();
  }, [fit]);

  useEffect(() => { if (active && !fittedRef.current) fit(); }, [active, backdrop, fit]);

  // -----------------------------------------------------------------------
  // Prediction lifecycle

  const abortRef = useRef<AbortController | null>(null);

  const predict = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPredicting(true);
    try {
      const next = await fetchPrediction(controller.signal);
      if (controller.signal.aborted) return;
      setReport(next);
      setCells(next.cells?.length ? next.cells : emptyGrid());
    } catch {
      // An aborted or failed request leaves the previous reading on screen, which is the right
      // thing for a monitoring panel: the last known state beats a blank map.
    } finally {
      if (!controller.signal.aborted) setPredicting(false);
    }
  }, []);

  // Predict when the tab is opened, then keep it fresh while it is being watched. The fire front
  // does not move in seconds, so this is deliberately unhurried.
  useEffect(() => {
    if (!active) return;
    void predict();
    const timer = setInterval(() => void predict(), 30_000);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [active, predict]);

  // -----------------------------------------------------------------------
  // Render map canvas

  const renderMap = useCallback(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas || !backdrop) return;
    const stage = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.style.width = `${w}px`;
    }
    if (canvas.height !== Math.round(h * dpr)) {
      canvas.height = Math.round(h * dpr);
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { meta } = backdrop;
    const { x, y, scale } = viewRef.current;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(backdrop.image, x, y, meta.width * scale, meta.height * scale);
  }, [backdrop]);

  // -----------------------------------------------------------------------
  // Render grid canvas

  const renderGrid = useCallback(() => {
    const canvas = gridCanvasRef.current;
    if (!canvas || !backdrop || cells.length === 0) return;
    const stage = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.style.width = `${w}px`;
    }
    if (canvas.height !== Math.round(h * dpr)) {
      canvas.height = Math.round(h * dpr);
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { meta } = backdrop;
    const { x: vx, y: vy, scale } = viewRef.current;
    const mapW = meta.width * scale;
    const mapH = meta.height * scale;
    const cellW = mapW / GRID_COLS;
    const cellH = mapH / GRID_ROWS;

    // Pass 1: flat scrim across the whole map, so every band colour lands on
    // the same substrate regardless of the terrain beneath it.
    ctx.fillStyle = SCRIM;
    ctx.fillRect(vx, vy, mapW, mapH);

    // Pass 2: band colours and borders.
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const cell = cells[row]?.[col];
        if (!cell) continue;
        const cx = vx + col * cellW;
        const cy = vy + row * cellH;
        const band = riskBand(cell.risk);
        const isHovered  = hoveredCell?.col === col && hoveredCell?.row === row;
        const isSelected = selected?.col   === col && selected?.row   === row;

        ctx.fillStyle = BAND_FILL[band];
        ctx.fillRect(cx, cy, cellW, cellH);

        ctx.strokeStyle = isSelected
          ? "rgb(255, 255, 255)"
          : isHovered
          ? "rgba(255, 255, 255, 0.85)"
          : BAND_STROKE[band];
        ctx.lineWidth = isSelected ? 3 : isHovered ? 2 : 1.25;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1);
      }
    }
  }, [backdrop, cells, hoveredCell, selected]);

  // -----------------------------------------------------------------------
  // Render loop

  useEffect(() => {
    if (!active || !backdrop) return;
    let frame = 0;
    const step = () => {
      renderMap();
      renderGrid();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, backdrop, renderMap, renderGrid]);

  // -----------------------------------------------------------------------
  // Zoom

  const zoomBy = useCallback((factor: number, ax?: number, ay?: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const view = viewRef.current;
    const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === view.scale) return;
    const anchorX = ax ?? stage.clientWidth / 2;
    const anchorY = ay ?? stage.clientHeight / 2;
    viewRef.current = {
      scale: next,
      x: anchorX - (anchorX - view.x) * (next / view.scale),
      y: anchorY - (anchorY - view.y) * (next / view.scale),
    };
    setZoom(next);
  }, []);

  // -----------------------------------------------------------------------
  // Pointer interactions on the grid canvas

  const screenToCell = useCallback((sx: number, sy: number): { col: number; row: number } | null => {
    if (!backdrop) return null;
    const { x: vx, y: vy, scale } = viewRef.current;
    const { meta } = backdrop;
    const mapW = meta.width * scale;
    const mapH = meta.height * scale;
    const relX = sx - vx;
    const relY = sy - vy;
    if (relX < 0 || relY < 0 || relX > mapW || relY > mapH) return null;
    const col = Math.floor((relX / mapW) * GRID_COLS);
    const row = Math.floor((relY / mapH) * GRID_ROWS);
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null;
    return { col, row };
  }, [backdrop]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = e.currentTarget.getBoundingClientRect();
    isDragging.current = true;
    pointerMoved.current = 0;
    dragStart.current = {
      px: e.clientX - box.left,
      py: e.clientY - box.top,
      vx: viewRef.current.x,
      vy: viewRef.current.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;

    if (isDragging.current) {
      const dx = sx - dragStart.current.px;
      const dy = sy - dragStart.current.py;
      pointerMoved.current = Math.hypot(dx, dy);
      viewRef.current = {
        ...viewRef.current,
        x: dragStart.current.vx + dx,
        y: dragStart.current.vy + dy,
      };
    }

    const cell = screenToCell(sx, sy);
    setHoveredCell(cell);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;

    if (isDragging.current && pointerMoved.current < 6) {
      // It's a click
      setSelected(screenToCell(sx, sy));
    }
    isDragging.current = false;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const ax = e.clientX - box.left;
    const ay = e.clientY - box.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomBy(factor, ax, ay);
  };

  // -----------------------------------------------------------------------
  // Popup positioning: figure out the screen position of the selected cell

  const getPopupPos = (): { top: number; left: number } | null => {
    if (!selected || !backdrop || !stageRef.current) return null;
    const { x: vx, y: vy, scale } = viewRef.current;
    const { meta } = backdrop;
    const mapW = meta.width * scale;
    const mapH = meta.height * scale;
    const cellW = mapW / GRID_COLS;
    const cellH = mapH / GRID_ROWS;
    const cx = vx + selected.col * cellW + cellW / 2;
    const cy = vy + selected.row * cellH;
    return { top: cy, left: cx };
  };

  const popupPos = getPopupPos();

  return (
    <div className={styles.riskMap}>
      <div className={styles.stage} ref={stageRef}>
        {/* Bottom layer: world map image */}
        <canvas className={styles.mapCanvas} ref={mapCanvasRef} />

        {/* Top layer: risk grid + interactions */}
        <canvas
          className={styles.gridCanvas}
          ref={gridCanvasRef}
          aria-label="Risk grid overlay. Click a cell for details."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { isDragging.current = false; setHoveredCell(null); }}
          onPointerCancel={() => { isDragging.current = false; }}
          onWheel={onWheel}
        />

        {/* Cell detail popup — click anywhere outside to dismiss */}
        {selectedCell && popupPos && (
          <div
            className={styles.popup}
            style={{
              top: Math.max(8, popupPos.top - 8),
              left: Math.max(8, popupPos.left),
              transform: "translate(-50%, -100%)",
            }}
            role="dialog"
            aria-label="Cell risk details"
          >
            <div className={styles.popupRisk}>
              <span className={styles.popupRiskDot} style={{ background: BAND_STROKE[riskBand(selectedCell.risk)] }} />
              <strong>{RISK_LABELS[riskBand(selectedCell.risk)]}</strong>
              <span className={styles.popupScore}>Risk {selectedCell.risk}/{MAX_RISK}</span>
            </div>
            {selectedCell.note && <p className={styles.popupNote}>{selectedCell.note}</p>}
            <div className={styles.popupGrid}>
              <span className={styles.popupKey}>Burning</span>
              <span className={styles.popupVal}>
                {selectedCell.fires > 0 ? `${selectedCell.fires} columns` : "nothing alight"}
              </span>
              <span className={styles.popupKey}>Nearest fire</span>
              <span className={styles.popupVal}>
                {selectedCell.nearestFire == null ? "—" : `${selectedCell.nearestFire} blocks`}
              </span>
              <span className={styles.popupKey}>Recent events</span>
              <span className={styles.popupVal}>{selectedCell.events || "none"}</span>
              <span className={styles.popupKey}>Grid cell</span>
              <span className={styles.popupVal}>col {selectedCell.col + 1}, row {selectedCell.row + 1}</span>
            </div>

            {/* Who is over it, by role - and a way straight to what they are looking at. */}
            <div className={styles.popupStation}>
              <span className={styles.popupKey}>On station</span>
              {onStation.length === 0
                ? <span className={styles.popupVal}>
                    {selectedCell.risk >= 4 ? "nobody — this cell is uncovered" : "nobody"}
                  </span>
                : <ul className={styles.station}>
                    {onStation.map((drone) => {
                      const role = roleOf(drone.id);
                      return <li key={drone.id} style={{ "--role": role.color } as React.CSSProperties}>
                        <button type="button" onClick={() => onOpenDroneFeed(drone.id)}
                                title={`Watch ${drone.id} - ${role.name}`}>
                          <i />
                          <span>{callsignOf(drone.id)}</span>
                          <em>{role.code}</em>
                        </button>
                      </li>;
                    })}
                  </ul>}
            </div>
          </div>
        )}

        {/* Zoom controls */}
        <div className={styles.zoomControls}>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>−</button>
          <button type="button" className={styles.wide} onClick={fit}>Fit</button>
        </div>

        <div className={styles.hint} aria-hidden="true">
          Click a grid cell for details · drag to pan · scroll to zoom
        </div>

        <footer className={styles.status}>
          <span>{backdrop?.real ? backdrop.meta.name : "stand-in world"}</span>
          <span className={styles.spacer} />
          <span>{zoom >= 1 ? `${zoom.toFixed(1)}×` : `1/${(1 / zoom).toFixed(1)}×`}</span>
        </footer>
      </div>

      {/* Side panel: legend + summary */}
      <aside className={styles.legend}>
        <header className={styles.legendHeader}>
          <span>Fire Risk</span>
          <button
            type="button"
            className={styles.legendRefresh}
            onClick={() => void predict()}
            disabled={predicting}
          >
            {predicting ? "Reading…" : "Re-run"}
          </button>
        </header>

        {intel.drones.length > 0 && (
          <div className={styles.fleet} aria-label="Fleet composition">
            {ROLE_LIST.map((role) => {
              const count = intel.drones.filter((drone) => roleOf(drone.id).id === role.id).length;
              if (count === 0) return null;
              return <span key={role.id} style={{ "--role": role.color } as React.CSSProperties}
                           title={`${count} x ${role.name} - ${role.tagline}`}>
                <i />{role.code}<b>{count}</b>
              </span>;
            })}
          </div>
        )}

        {report && (
          <div className={styles.provenance}>
            <span
              className={`${styles.sourceBadge} ${report.source === "forecast" ? styles.sourceAi : styles.sourceBaseline}`}
            >
              {report.source === "forecast" ? "Spread forecast" : "No feed"}
            </span>
            <span className={styles.provenanceMeta}>
              {report.observed.fires} burning · {report.observed.drones} drones
              {report.observed.live ? "" : " · feed stale"}
            </span>
          </div>
        )}

        {/* The forecast's read, and - when there was nothing to read - why not. */}
        {report?.briefing && (
          <div className={styles.briefing}>
            <p className={styles.briefingBody}>{report.briefing}</p>
            {report.spread && <p className={styles.briefingSpread}>{report.spread}</p>}
          </div>
        )}
        {report?.error && (
          <p className={styles.fallbackNote}>
            No forecast this run. {report.error}
          </p>
        )}

        <div className={styles.legendScale}>
          {RISK_LABELS.map((label, i) => (
            <div key={i} className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{ background: BAND_STROKE[i] }} />
              <span className={styles.legendLabel}>{i + 1} · {label}</span>
            </div>
          ))}
        </div>

        <div className={styles.legendDivider} />

        <div className={styles.legendInfo}>
          <p className={styles.legendInfoTitle}>How risk is calculated</p>
          <p className={styles.legendInfoBody}>
            Live burning columns and the disaster log are binned onto the grid, then
            pushed downwind into a burn envelope for the next ten minutes. Small
            pockets ahead of the front are projected ember cast - where the wind is
            expected to drop embers and start the next fire.
          </p>
        </div>

        {cells.length > 0 && (() => {
          const allCells = cells.flat();
          const maxRisk = allCells.reduce((a, c) => a.risk > c.risk ? a : c);
          const avgRisk = (allCells.reduce((s, c) => s + c.risk, 0) / allCells.length).toFixed(1);
          return (
            <>
              <div className={styles.legendDivider} />
              <div className={styles.legendStats}>
                <div className={styles.legendStat}>
                  <span className={styles.legendStatLabel}>Avg risk</span>
                  <span className={styles.legendStatValue}>{avgRisk}</span>
                </div>
                <div
                  className={`${styles.legendStat} ${styles.legendStatClickable}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select hotspot at col ${maxRisk.col + 1}, row ${maxRisk.row + 1}`}
                  onClick={() => setSelected({ col: maxRisk.col, row: maxRisk.row })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSelected({ col: maxRisk.col, row: maxRisk.row });
                  }}
                >
                  <span className={styles.legendStatLabel}>Hotspot ↗</span>
                  <span className={styles.legendStatValue} style={{ color: BAND_STROKE[riskBand(maxRisk.risk)] }}>
                    {maxRisk.col + 1},{maxRisk.row + 1}
                  </span>
                </div>
                <div className={styles.legendStat}>
                  <span className={styles.legendStatLabel}>Peak risk</span>
                  <span className={styles.legendStatValue} style={{ color: BAND_STROKE[riskBand(maxRisk.risk)] }}>
                    {maxRisk.risk}/{MAX_RISK}
                  </span>
                </div>
              </div>
            </>
          );
        })()}
      </aside>
    </div>
  );
}
