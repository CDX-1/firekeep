"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./risk-map.module.css";
import { getWorld, worldMapUrl } from "@/lib/api";
import { fallbackWorld } from "./fallback-world";
import type { WorldMeta } from "@/lib/types";

// -------------------------------------------------------------------------
// Types

interface RiskCell {
  col: number;
  row: number;
  /** 0-9 risk score: 0 = safest, 9 = most dangerous */
  risk: number;
  humidity: number;    // %
  temperature: number; // °C
  windSpeed: number;   // km/h
  windDir: string;
  droneId: string | null;
}

type View = { x: number; y: number; scale: number };
type Backdrop = { meta: WorldMeta; image: CanvasImageSource; real: boolean };

// -------------------------------------------------------------------------
// Risk colour scale — 5 distinct bands, each covering 2 risk levels.
// Fill colours are kept very transparent so the map shows through;
// border colours are vivid so the grid reads clearly.

/** Map a 0-9 risk score to one of 5 colour bands. */
function riskBand(risk: number): number { return Math.min(4, Math.floor(risk / 2)); }

const BAND_FILL = [
  "rgba(34,  197,  94, 0.18)",  // 0-1 – green
  "rgba(234, 204,   8, 0.20)",  // 2-3 – amber
  "rgba(249, 115,  22, 0.22)",  // 4-5 – orange
  "rgba(239,  68,  68, 0.26)",  // 6-7 – red
  "rgba( 88,  28, 135, 0.32)",  // 8-9 – deep purple-red (extreme)
] as const;

const BAND_STROKE = [
  "rgba( 34, 197,  94, 0.75)",  // green
  "rgba(234, 179,   8, 0.85)",  // amber
  "rgba(249, 115,  22, 0.90)",  // orange
  "rgba(239,  68,  68, 0.90)",  // red
  "rgba(192,  38, 211, 0.95)",  // vivid purple (extreme)
] as const;

const BAND_LABELS = ["Low", "Guarded", "Moderate", "High", "Extreme"];

const RISK_LABELS = [
  "Minimal", "Very Low", "Low", "Guarded", "Moderate",
  "Elevated", "High", "Very High", "Severe", "Extreme",
];

// Number of grid columns/rows to divide the map into
const GRID_COLS = 10;
const GRID_ROWS = 10;

// -------------------------------------------------------------------------
// Mock data generation

function generateRiskGrid(meta: WorldMeta): RiskCell[][] {
  const cells: RiskCell[][] = [];
  const seed = meta.name.length;

  for (let row = 0; row < GRID_ROWS; row++) {
    cells[row] = [];
    for (let col = 0; col < GRID_COLS; col++) {
      // Seeded pseudo-random-ish so it's stable across re-renders
      const n  = Math.sin(seed + col * 7.3  + row * 13.7) * 0.5 + 0.5;
      const n2 = Math.sin(seed + col * 3.1  + row *  5.9 + 1.4) * 0.5 + 0.5;
      const n3 = Math.sin(seed + col * 11.2 + row *  2.3 + 2.7) * 0.5 + 0.5;

      const humidity    = Math.round(10 + n  * 55);  // 10-65 %
      const temperature = Math.round(18 + n2 * 28);  // 18-46 °C
      const windSpeed   = Math.round(5  + n3 * 65);  // 5-70 km/h

      const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      const windDir = dirs[Math.floor(n3 * dirs.length)];

      // Risk formula: low humidity + high temp + high wind = more risk
      const rawRisk =
        (1 - humidity / 65)    * 3.5 +
        (temperature / 46)     * 3.0 +
        (windSpeed / 70)       * 2.5;

      const risk = Math.min(9, Math.max(0, Math.round(rawRisk)));

      cells[row][col] = { col, row, risk, humidity, temperature, windSpeed, windDir, droneId: null };
    }
  }
  return cells;
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

export default function RiskMap({ active }: { active: boolean }) {
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
  const [selected, setSelected] = useState<RiskCell | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hoveredCell, setHoveredCell] = useState<{ col: number; row: number } | null>(null);

  // -----------------------------------------------------------------------
  // Load world

  useEffect(() => {
    async function load() {
      try {
        const meta = await getWorld();
        const image = await loadImage(worldMapUrl());
        setBackdrop({ meta, image, real: true });
        setCells(generateRiskGrid(meta));
      } catch {
        const fb = fallbackWorld();
        setBackdrop({ meta: fb.meta, image: fb.image, real: false });
        setCells(generateRiskGrid(fb.meta));
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
          ? "rgba(255, 255, 255, 0.95)"
          : isHovered
          ? "rgba(255, 255, 255, 0.60)"
          : BAND_STROKE[band];
        ctx.lineWidth = isSelected ? 2.5 : isHovered ? 1.5 : 0.6;
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
      const pos = screenToCell(sx, sy);
      if (pos) {
        const cell = cells[pos.row]?.[pos.col];
        if (cell) setSelected(cell);
      } else {
        setSelected(null);
      }
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
        {selected && popupPos && (
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
              <span className={styles.popupRiskDot} style={{ background: BAND_STROKE[riskBand(selected.risk)] }} />
              <strong>{RISK_LABELS[selected.risk]}</strong>
              <span className={styles.popupScore}>Risk Score: {selected.risk}/9</span>
            </div>
            <div className={styles.popupGrid}>
              <span className={styles.popupKey}>Humidity</span>
              <span className={styles.popupVal}>{selected.humidity}%</span>
              <span className={styles.popupKey}>Temperature</span>
              <span className={styles.popupVal}>{selected.temperature}°C</span>
              <span className={styles.popupKey}>Wind</span>
              <span className={styles.popupVal}>{selected.windSpeed} km/h {selected.windDir}</span>
              <span className={styles.popupKey}>Grid cell</span>
              <span className={styles.popupVal}>col {selected.col + 1}, row {selected.row + 1}</span>
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
          <span>Risk Scale</span>
          <span className={styles.legendSub}>5 bands</span>
        </header>

        <div className={styles.legendScale}>
          {BAND_LABELS.map((label, i) => (
            <div key={i} className={styles.legendItem}>
              <span className={styles.legendSwatch} style={{ background: BAND_STROKE[i] }} />
              <span className={styles.legendLabel}>{label}</span>
            </div>
          ))}
        </div>

        <div className={styles.legendDivider} />

        <div className={styles.legendInfo}>
          <p className={styles.legendInfoTitle}>How risk is calculated</p>
          <p className={styles.legendInfoBody}>
            Each grid cell is scored using drone-reported humidity, temperature, and
            wind speed. Low humidity, high temperatures, and strong winds all raise
            the fire risk score.
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
                  onClick={() => setSelected(maxRisk)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelected(maxRisk); }}
                >
                  <span className={styles.legendStatLabel}>Hotspot ↗</span>
                  <span className={styles.legendStatValue} style={{ color: BAND_STROKE[riskBand(maxRisk.risk)] }}>
                    {maxRisk.col + 1},{maxRisk.row + 1}
                  </span>
                </div>
                <div className={styles.legendStat}>
                  <span className={styles.legendStatLabel}>Peak risk</span>
                  <span className={styles.legendStatValue} style={{ color: BAND_STROKE[riskBand(maxRisk.risk)] }}>
                    {maxRisk.risk}/9
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
