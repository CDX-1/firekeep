"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./feed-overlay.module.css";
import { apparentWidth, pitchOf, project, type Camera } from "@/lib/camera-view";
import { hotspotsNear, useIntel, type Hotspot, type Intel } from "@/lib/fleet-intel";
import { bearingName, bearingTo, callsignOf, roleOf, seedOf, type Role } from "@/lib/roles";
import { simulatedTelemetry, type Telemetry } from "@/lib/simulated-telemetry";
import type { Drone } from "@/lib/use-cameras";

/**
 * The instrument layer painted over a drone's picture.
 *
 * Two layers rather than one, and for a reason that only shows up on a wall of thumbnails.
 * Everything *spatial* - the reticle, the boxes drawn round fires, the horizon, the mesh legs
 * out to other aircraft - lives in an SVG with a fixed 1600x900 viewBox, so it scales with the
 * picture and a box stays on the thing it is naming at any tile size. Everything *textual* lives
 * in ordinary DOM sized in real pixels, because a readout that scaled with the tile would be six
 * pixels tall on a twelve-up wall, which is the same as not drawing it.
 *
 * What is drawn on top of that depends on the drone's role, and roles are the whole point: a
 * surveyor is boxing the fire and mapping its edge, a thermal ship is reading temperatures
 * through the smoke, a suppression ship is lining up a drop, a relay is holding the mesh
 * together and a SAR ship is sweeping for anything alive. Same airframe, same camera, five
 * completely different pictures.
 *
 * Everything here is read-only and `pointer-events: none`. Clicking a tile still opens it.
 */

/** How often the readouts re-read the clock. A single viewer can afford to look alive. */
const TICK_FULL_MS = 100;
/** A wall of tiles cannot - twelve overlays at 10Hz is a lot of React for a running timecode. */
const TICK_COMPACT_MS = 1_000;

/** The height the terrain is assumed to be at, since the fire list carries no Y. */
const GROUND = 64;

const VIEW_W = 1600;
const VIEW_H = 900;

/**
 * How much of the display there is room for.
 *
 * `tile` is one picture on a wall of them: geometry, callsign, tally, and nothing that needs
 * reading. `focus` is the single large tile, which has the flight telemetry panel beside it
 * already and so leaves the role panel off rather than stacking two panels in one corner.
 * `viewer` is the full-screen feed, where everything fits.
 */
export type OverlayVariant = "tile" | "focus" | "viewer";

type OverlayProps = {
  drone: Drone;
  variant?: OverlayVariant;
};

export default function FeedOverlay({ drone, variant = "tile" }: OverlayProps) {
  const compact = variant === "tile";
  const role = roleOf(drone.id);
  const callsign = callsignOf(drone.id);
  const intel = useIntel();
  const now = useTicker(compact ? TICK_COMPACT_MS : TICK_FULL_MS);
  const telemetry = useMemo(() => simulatedTelemetry(drone, now, role), [drone, now, role]);

  const camera: Camera = { x: drone.x, y: drone.y, z: drone.z, yaw: drone.yaw, pitch: pitchOf(drone.id) };
  // Minecraft yaw has 0 facing +Z, which is south; a compass bearing has 0 at north.
  const bearing = ((drone.yaw % 360) + 540) % 360;

  // Stroke weights and type inside the SVG are multiplied by this: a thumbnail is a quarter the
  // size, so a 1.5-unit line on it is a third of a pixel and simply is not there.
  const k = compact ? 2.4 : 1;

  const nearby = useMemo(
    () => hotspotsNear(intel.hotspots, drone.x, drone.z, 300, compact ? 4 : 8),
    [intel.hotspots, drone.x, drone.z, compact],
  );

  return (
    <div
      className={styles.hud}
      data-compact={compact}
      data-role={role.id}
      data-stale={!drone.live}
      style={{ "--role": role.color, "--role-rgb": role.rgb.join(", ") } as React.CSSProperties}
      aria-hidden="true"
    >
      {role.hud === "thermal" && <div className={styles.thermalPalette} />}
      <div className={styles.grain} />

      <svg className={styles.geometry} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
        <Brackets k={k} />
        {!compact && <Horizon roll={telemetry.roll} pitch={camera.pitch} k={k} />}
        {!compact && <CompassRibbon bearing={bearing} k={k} />}
        <RoleGeometry
          role={role}
          drone={drone}
          camera={camera}
          telemetry={telemetry}
          intel={intel}
          nearby={nearby}
          compact={compact}
          k={k}
          now={now}
        />
        <Reticle role={role} k={k} />
      </svg>

      <div className={styles.topStrip}>
        <span className={styles.callsign}><i />{callsign}</span>
        <span className={styles.roleName}>{role.name}</span>
        <span className={styles.droneId}>{drone.id}</span>
        {!compact && <span className={styles.sensor}>{role.sensor}</span>}
        <span className={styles.spacer} />
        {!compact && <span className={styles.mission}>OP FIREKEEP · {drone.area.toUpperCase()}</span>}
        <span className={styles.rec} data-live={drone.live}>REC</span>
        <span className={styles.timecode}>{timecode(drone.frames, drone.fps)}</span>
      </div>

      <div className={styles.bottomStrip}>
        <span className={styles.cell}>{Math.round(drone.x)} {Math.round(drone.y)} {Math.round(drone.z)}</span>
        <span className={styles.cell}>HDG {Math.round(bearing).toString().padStart(3, "0")}° {bearingName(bearing)}</span>
        <span className={styles.cell}>ALT {telemetry.altitude.toFixed(0)}m</span>
        {!compact && <span className={styles.cell}>GS {telemetry.speed.toFixed(1)}</span>}
        <span className={styles.spacer} />
        <RoleChip role={role} telemetry={telemetry} nearby={nearby} intel={intel} />
        {!compact && <span className={styles.cell}>{telemetry.latency}ms</span>}
        <span className={styles.cell} data-warning={telemetry.battery < 30}>
          BAT {telemetry.battery.toFixed(0)}%
        </span>
      </div>

      {variant === "viewer" && <RolePanel role={role} telemetry={telemetry} nearby={nearby} intel={intel} drone={drone} />}
      {!compact && <div className={styles.stamp}>{drone.width}×{drone.height} · {drone.fps}fps · {drone.detail ? "detail" : "grid"} · sim sensor suite</div>}
    </div>
  );
}

// --------------------------------------------------------------------- chrome

/** The corner brackets, which is most of what makes a picture read as a feed rather than a photo. */
function Brackets({ k }: { k: number }) {
  const inset = 26;
  const arm = 78;
  const corners = [
    [inset, inset, 1, 1],
    [VIEW_W - inset, inset, -1, 1],
    [inset, VIEW_H - inset, 1, -1],
    [VIEW_W - inset, VIEW_H - inset, -1, -1],
  ] as const;

  return <g className={styles.bracket} strokeWidth={2.2 * k}>
    {corners.map(([x, y, sx, sy]) => (
      <path key={`${x},${y}`} d={`M${x} ${y + sy * arm} L${x} ${y} L${x + sx * arm} ${y}`} />
    ))}
  </g>;
}

/**
 * The artificial horizon.
 *
 * Driven by the camera's downward tilt, which is a real number the operator set, and a roll that
 * is not - a drone that never banks looks like a photograph of a drone.
 */
function Horizon({ roll, pitch, k }: { roll: number; pitch: number; k: number }) {
  // 70 degrees of vertical field over 900 units, so a degree is this many units down the frame.
  const perDegree = VIEW_H / 70;
  // Tilted down, the horizon rides up the frame - by exactly the angle it is tilted.
  const y = VIEW_H / 2 - pitch * perDegree;

  return <g className={styles.horizon} transform={`rotate(${-roll.toFixed(2)} ${VIEW_W / 2} ${y})`}
            strokeWidth={1.6 * k}>
    <path d={`M120 ${y} H${VIEW_W / 2 - 130}`} />
    <path d={`M${VIEW_W / 2 + 130} ${y} H${VIEW_W - 120}`} />
    {[-20, -10, 10, 20].map((degrees) => {
      const ty = y + degrees * perDegree;
      const half = degrees % 20 === 0 ? 96 : 58;
      return <g key={degrees}>
        <path d={`M${VIEW_W / 2 - half} ${ty} h${half - 34}`} />
        <path d={`M${VIEW_W / 2 + 34} ${ty} h${half - 34}`} />
        <text className={styles.svgLabel} x={VIEW_W / 2 - half - 10} y={ty + 5 * k}
              fontSize={17 * k} textAnchor="end">{Math.abs(degrees)}</text>
      </g>;
    })}
  </g>;
}

/** The heading tape across the top, ticked every ten degrees and lettered at the eight points. */
function CompassRibbon({ bearing, k }: { bearing: number; k: number }) {
  const span = 90;                       // degrees of tape visible
  const perDegree = (VIEW_W - 560) / span;
  const centre = VIEW_W / 2;
  const first = Math.ceil((bearing - span / 2) / 10) * 10;
  const ticks: React.ReactElement[] = [];

  for (let degrees = first; degrees <= bearing + span / 2; degrees += 10) {
    const x = centre + (degrees - bearing) * perDegree;
    const cardinal = ((degrees % 360) + 360) % 360 % 45 === 0;
    ticks.push(
      <g key={degrees}>
        <path d={`M${x} 62 v${cardinal ? 16 : 9}`} strokeWidth={1.7 * k} />
        {cardinal && <text className={styles.svgLabel} x={x} y={96 + 6 * k} fontSize={18 * k}
                           textAnchor="middle">{bearingName(degrees)}</text>}
      </g>,
    );
  }

  return <g className={styles.compass}>
    {ticks}
    <path className={styles.compassCaret} d={`M${centre} 56 l-9 -13 h18 Z`} strokeWidth={1.5 * k} />
  </g>;
}

/** The centre mark, cut differently for every role - it is the first thing you see. */
function Reticle({ role, k }: { role: Role; k: number }) {
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const w = 1.8 * k;

  if (role.hud === "suppress") {
    // A bomb sight: a ring with wings, and a pipper you would put on the fire.
    return <g className={styles.reticle} strokeWidth={w}>
      <circle cx={cx} cy={cy} r="46" />
      <circle cx={cx} cy={cy} r="4.5" className={styles.reticleFill} />
      <path d={`M${cx - 96} ${cy} h34 M${cx + 62} ${cy} h34 M${cx} ${cy - 96} v34 M${cx} ${cy + 62} v34`} />
      <path d={`M${cx - 62} ${cy - 26} l16 26 l-16 26 M${cx + 62} ${cy - 26} l-16 26 l16 26`} />
    </g>;
  }

  if (role.hud === "thermal") {
    // A spot meter: the square the temperature readout is actually taken from.
    return <g className={styles.reticle} strokeWidth={w}>
      <rect x={cx - 34} y={cy - 34} width="68" height="68" />
      <path d={`M${cx - 60} ${cy} h20 M${cx + 40} ${cy} h20 M${cx} ${cy - 60} v20 M${cx} ${cy + 40} v20`} />
    </g>;
  }

  if (role.hud === "relay") {
    // A node, with the arcs coming off it.
    return <g className={styles.reticle} strokeWidth={w}>
      <circle cx={cx} cy={cy} r="7" className={styles.reticleFill} />
      {[26, 46, 66].map((r, index) => (
        <path key={r} d={arc(cx, cy, r, -52, 52)} opacity={0.85 - index * 0.22} />
      ))}
      {[26, 46, 66].map((r, index) => (
        <path key={`b${r}`} d={arc(cx, cy, r, 128, 232)} opacity={0.85 - index * 0.22} />
      ))}
    </g>;
  }

  if (role.hud === "rescue") {
    // A search ring, with the sweep running round it.
    return <g className={styles.reticle} strokeWidth={w}>
      <circle cx={cx} cy={cy} r="52" strokeDasharray="10 12" />
      <circle cx={cx} cy={cy} r="3.5" className={styles.reticleFill} />
      <path d={`M${cx - 78} ${cy} h26 M${cx + 52} ${cy} h26 M${cx} ${cy - 78} v26 M${cx} ${cy + 52} v26`} />
    </g>;
  }

  // Surveyor: a mapping frame with a centre cross.
  return <g className={styles.reticle} strokeWidth={w}>
    <path d={`M${cx - 62} ${cy - 44} h-22 v22 M${cx + 62} ${cy - 44} h22 v22
              M${cx - 62} ${cy + 44} h-22 v-22 M${cx + 62} ${cy + 44} h22 v-22`} />
    <path d={`M${cx - 16} ${cy} h32 M${cx} ${cy - 16} v32`} />
  </g>;
}

// --------------------------------------------------------------- role geometry

type GeometryProps = {
  role: Role;
  drone: Drone;
  camera: Camera;
  telemetry: Telemetry;
  intel: Intel;
  nearby: { hotspot: Hotspot; distance: number }[];
  compact: boolean;
  k: number;
  now: number;
};

function RoleGeometry(props: GeometryProps) {
  switch (props.role.hud) {
    case "survey": return <SurveyLayer {...props} />;
    case "thermal": return <ThermalLayer {...props} />;
    case "suppress": return <SuppressLayer {...props} />;
    case "relay": return <RelayLayer {...props} />;
    case "rescue": return <RescueLayer {...props} />;
  }
}

/**
 * The surveyor's picture: the ground it is mapping, and every fire in shot boxed and called.
 *
 * The grid is the real world grid - Minecraft's own 16-block chunk lines, projected through the
 * same camera the agent is rendering with. It costs a few hundred projections a frame, which is
 * why it is not drawn on thumbnails.
 */
function SurveyLayer({ camera, nearby, drone, telemetry, compact, k }: GeometryProps) {
  return <>
    {!compact && <GroundGrid camera={camera} k={k} />}
    <g className={styles.sweep}>
      <rect x="0" y="-6" width={VIEW_W} height="6" />
    </g>
    {nearby.map(({ hotspot, distance }) => (
      <HotspotBox key={`${hotspot.x},${hotspot.z}`} camera={camera} drone={drone}
                  hotspot={hotspot} distance={distance} k={k}
                  label={`FIRE · ${Math.round(distance)}m`} />
    ))}
    {!compact && <text className={styles.svgTag} x={VIEW_W / 2} y={VIEW_H - 108} fontSize={19 * k}
                       textAnchor="middle">
      SECTOR MAPPING {telemetry.coverage.toFixed(0)}%
    </text>}
  </>;
}

/** Chunk lines on the ground, drawn where the camera would actually see them. */
function GroundGrid({ camera, k }: { camera: Camera; k: number }) {
  const paths = useMemo(() => {
    const step = 16;
    const reach = 176;
    const lines: string[] = [];

    const build = (fixed: number, along: "x" | "z") => {
      const points: string[] = [];
      let open = false;
      for (let offset = -reach; offset <= reach; offset += 14) {
        const base = along === "x" ? camera.x : camera.z;
        const moving = base + offset;
        const at = along === "x"
          ? project(camera, moving, GROUND, fixed)
          : project(camera, fixed, GROUND, moving);
        if (!at || at.u < -0.5 || at.u > 1.5 || at.v < -0.5 || at.v > 1.5) {
          if (open) { lines.push(points.join(" ")); points.length = 0; open = false; }
          continue;
        }
        points.push(`${open ? "L" : "M"}${(at.u * VIEW_W).toFixed(1)} ${(at.v * VIEW_H).toFixed(1)}`);
        open = true;
      }
      if (open) lines.push(points.join(" "));
    };

    for (let offset = -reach; offset <= reach; offset += step) {
      build(Math.round((camera.z + offset) / step) * step, "x");
      build(Math.round((camera.x + offset) / step) * step, "z");
    }
    return lines;
  }, [camera.x, camera.y, camera.z, camera.yaw, camera.pitch]);

  return <g className={styles.groundGrid} strokeWidth={1 * k}>
    {paths.map((d, index) => <path key={index} d={d} />)}
  </g>;
}

/** A box round a fire, wherever it is on screen, with how far away it is. */
function HotspotBox({ camera, drone, hotspot, distance, label, k, tone }: {
  camera: Camera;
  drone: Drone;
  hotspot: Hotspot;
  distance: number;
  label: string;
  k: number;
  tone?: "hot";
}) {
  const at = project(camera, hotspot.x, GROUND, hotspot.z);
  if (!at || !at.onScreen) return null;

  const width = Math.max(28, Math.min(560, apparentWidth(hotspot.radius * 2.4, at.depth) * VIEW_W));
  const height = width * 0.62;
  const x = at.u * VIEW_W - width / 2;
  const y = at.v * VIEW_H - height / 2;
  const bearing = bearingName(bearingTo(drone.x, drone.z, hotspot.x, hotspot.z));
  const corner = Math.min(width, height) * 0.3;

  return <g className={styles.track} data-tone={tone}>
    <path strokeWidth={1.9 * k} d={
      `M${x} ${y + corner} V${y} H${x + corner}
       M${x + width - corner} ${y} H${x + width} V${y + corner}
       M${x + width} ${y + height - corner} V${y + height} H${x + width - corner}
       M${x + corner} ${y + height} H${x} V${y + height - corner}`} />
    <text className={styles.svgTag} x={x} y={y - 9 * k} fontSize={17 * k}>
      {label} · {bearing}
    </text>
    <text className={styles.svgTagDim} x={x + width} y={y + height + 20 * k} fontSize={15 * k}
          textAnchor="end">{hotspot.columns} COL</text>
  </g>;
}

/** Thermal: isotherms round every source, and a temperature on the one under the pipper. */
function ThermalLayer({ camera, nearby, telemetry, k }: GeometryProps) {
  return <>
    {nearby.map(({ hotspot, distance }) => {
      const at = project(camera, hotspot.x, GROUND, hotspot.z);
      if (!at || !at.onScreen) return null;
      const radius = Math.max(18, Math.min(320, apparentWidth(hotspot.radius * 2, at.depth) * VIEW_W / 2));
      const temperature = Math.round(180 + hotspot.columns * 9 + (telemetry.peak - 340) * 0.4);
      return <g key={`${hotspot.x},${hotspot.z}`} className={styles.isotherm}>
        {[1, 0.68, 0.4].map((scale, index) => (
          <circle key={scale} cx={at.u * VIEW_W} cy={at.v * VIEW_H} r={radius * scale}
                  strokeWidth={1.6 * k} opacity={0.35 + index * 0.22} />
        ))}
        <text className={styles.svgTag} x={at.u * VIEW_W} y={at.v * VIEW_H - radius - 10 * k}
              fontSize={17 * k} textAnchor="middle">
          {temperature}°C · {Math.round(distance)}m
        </text>
      </g>;
    })}
  </>;
}

/**
 * Suppression: the corridor the aircraft would fly the drop down, and the release point.
 *
 * The corridor is projected forward along the drone's own heading, so it swings with the camera
 * the way a real sight would - it is a line on the ground, not a graphic stuck to the glass.
 */
function SuppressLayer({ camera, drone, nearby, telemetry, compact, k }: GeometryProps) {
  const target = nearby[0];
  const yaw = camera.yaw * Math.PI / 180;
  const forwardX = -Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const rightX = -Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  const rail = (side: number) => {
    const points: string[] = [];
    for (let ahead = 12; ahead <= 140; ahead += 8) {
      const at = project(camera,
        drone.x + forwardX * ahead + rightX * side * 9,
        GROUND,
        drone.z + forwardZ * ahead + rightZ * side * 9);
      if (!at) continue;
      points.push(`${points.length === 0 ? "M" : "L"}${(at.u * VIEW_W).toFixed(1)} ${(at.v * VIEW_H).toFixed(1)}`);
    }
    return points.join(" ");
  };

  return <>
    <g className={styles.corridor} strokeWidth={2.1 * k}>
      <path d={rail(-1)} />
      <path d={rail(1)} />
    </g>
    {target && <HotspotBox camera={camera} drone={drone} hotspot={target.hotspot}
                           distance={target.distance} k={k} tone="hot"
                           label={`TARGET · ${Math.round(target.distance)}m`} />}
    {!compact && <text className={styles.svgTag} x={VIEW_W / 2} y={VIEW_H / 2 + 132} fontSize={20 * k}
                       textAnchor="middle" data-armed={telemetry.payload > 15}>
      {telemetry.payload > 15 ? (target ? "ARMED · IN RANGE" : "ARMED · NO TARGET") : "TANK EMPTY · RTB"}
    </text>}
  </>;
}

/** Relay: a leg drawn to every other drone the mod knows about, with how good it is. */
function RelayLayer({ camera, drone, intel, compact, k }: GeometryProps) {
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const peers = intel.drones.filter((peer) => peer.id !== drone.id).slice(0, 6);

  return <g className={styles.mesh}>
    {peers.map((peer) => {
      const at = project(camera, peer.x, peer.y, peer.z);
      const distance = Math.hypot(peer.x - drone.x, peer.z - drone.z);
      // Off screen, the leg still exists - it is drawn as a stub pointing the right way.
      if (!at || !at.onScreen) return null;
      const x = at.u * VIEW_W;
      const y = at.v * VIEW_H;
      const quality = Math.max(24, Math.round(100 - distance / 4));
      return <g key={peer.id} data-weak={quality < 55}>
        <path strokeWidth={1.5 * k} strokeDasharray={`${6 * k} ${7 * k}`}
              d={`M${cx} ${cy} L${x} ${y}`} />
        <circle cx={x} cy={y} r={9 * k} strokeWidth={1.8 * k} />
        {!compact && <text className={styles.svgTag} x={x} y={y - 18 * k} fontSize={16 * k}
                           textAnchor="middle">
          {callsignOf(peer.id)} · {quality}%
        </text>}
      </g>;
    })}
  </g>;
}

/**
 * Search and rescue: the sweep, and what it thinks it found.
 *
 * The contacts are invented - nothing reports living things to the dashboard - but they are put
 * on the ground in world coordinates rather than on the glass, so they hold still while the
 * camera moves across them, and they are labelled as returns with a confidence rather than as
 * facts. The panel says SIM in as many words.
 */
function RescueLayer({ camera, drone, telemetry, compact, k, now }: GeometryProps) {
  const contacts = useMemo(() => {
    const yaw = camera.yaw * Math.PI / 180;
    const forwardX = -Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    // A slow index so the sweep finds different things over time rather than the same three.
    const pass = Math.floor(now / 24_000);
    return Array.from({ length: 3 }, (_, index) => {
      const a = seedOf(drone.id, `sar${index}:${pass}`);
      const b = seedOf(drone.id, `sar${index}:${pass}:b`);
      const ahead = 28 + a * 90;
      const across = (b - 0.5) * 90;
      return {
        key: `${pass}-${index}`,
        x: drone.x + forwardX * ahead - Math.cos(yaw) * across,
        z: drone.z + forwardZ * ahead - Math.sin(yaw) * across,
        confidence: Math.round(42 + a * 54),
        strong: b > 0.62,
      };
    }).slice(0, Math.max(1, telemetry.contacts + 1));
  }, [camera.yaw, drone.id, drone.x, drone.z, now, telemetry.contacts]);

  return <>
    <g className={styles.sweepRing}>
      <circle cx={VIEW_W / 2} cy={VIEW_H / 2} r="90" strokeWidth={2.4 * k} />
    </g>
    {contacts.map((contact) => {
      const at = project(camera, contact.x, GROUND, contact.z);
      if (!at || !at.onScreen) return null;
      const x = at.u * VIEW_W;
      const y = at.v * VIEW_H;
      const size = Math.max(16, Math.min(90, apparentWidth(2.4, at.depth) * VIEW_W));
      return <g key={contact.key} className={styles.contact} data-strong={contact.strong}>
        <rect x={x - size / 2} y={y - size} width={size} height={size * 1.6} strokeWidth={1.8 * k} />
        {!compact && <text className={styles.svgTag} x={x} y={y - size - 10 * k} fontSize={16 * k}
                           textAnchor="middle">SIG {contact.confidence}%</text>}
      </g>;
    })}
  </>;
}

// ----------------------------------------------------------------- readouts

/** The one number from this role that belongs in the bottom strip whatever else is going on. */
function RoleChip({ role, telemetry, nearby, intel }: {
  role: Role;
  telemetry: Telemetry;
  nearby: { hotspot: Hotspot; distance: number }[];
  intel: Intel;
}) {
  const text = {
    survey: `MAP ${telemetry.coverage.toFixed(0)}%`,
    thermal: `PEAK ${Math.round(telemetry.peak)}°C`,
    suppress: `TANK ${telemetry.payload.toFixed(0)}%`,
    relay: `MESH ${Math.max(0, intel.drones.length - 1)}`,
    rescue: `SIG ${telemetry.contacts}`,
  }[role.hud];

  return <span className={styles.roleChip}>{text}{nearby.length > 0 && ` · ${nearby.length} HOT`}</span>;
}

/**
 * The role's own instrument, down the right-hand edge.
 *
 * One panel per role rather than one panel with the role's row highlighted: the whole point is
 * that a suppression ship and a relay do not measure the same things, and a common panel with
 * four greyed-out rows says the opposite.
 */
function RolePanel({ role, telemetry, nearby, intel, drone }: {
  role: Role;
  telemetry: Telemetry;
  nearby: { hotspot: Hotspot; distance: number }[];
  intel: Intel;
  drone: Drone;
}) {
  if (role.hud === "suppress") {
    return <aside className={styles.panel}>
      <h3>Retardant</h3>
      <div className={styles.tank}>
        <span style={{ height: `${telemetry.payload}%` }} data-low={telemetry.payload < 20} />
      </div>
      <Row label="Load" value={`${telemetry.payload.toFixed(0)}%`} />
      <Row label="Wind" value={`${telemetry.wind.toFixed(0)} kt ${bearingName(telemetry.windBearing)}`} />
      <Row label="Target" value={nearby[0] ? `${Math.round(nearby[0].distance)} m` : "none"} />
      <Row label="Drops" value={String(Math.floor(drone.frames / 900) % 9)} />
    </aside>;
  }

  if (role.hud === "thermal") {
    return <aside className={styles.panel}>
      <h3>Thermal</h3>
      <div className={styles.scale} />
      <Row label="Peak" value={`${Math.round(telemetry.peak)}°C`} />
      <Row label="Ambient" value={`${(telemetry.batteryTemp - 8).toFixed(0)}°C`} />
      <Row label="Sources" value={String(nearby.length)} />
      <Row label="Palette" value="IRONBOW" />
    </aside>;
  }

  if (role.hud === "relay") {
    const peers = intel.drones.filter((peer) => peer.id !== drone.id).slice(0, 5);
    return <aside className={styles.panel}>
      <h3>Mesh</h3>
      {peers.length === 0 && <p className={styles.panelEmpty}>No peers on the net</p>}
      {peers.map((peer) => {
        const distance = Math.hypot(peer.x - drone.x, peer.z - drone.z);
        const quality = Math.max(18, Math.round(100 - distance / 4));
        return <div className={styles.link} key={peer.id} data-weak={quality < 55}>
          <span>{callsignOf(peer.id)}</span>
          <i><b style={{ width: `${quality}%` }} /></i>
          <em>{quality}%</em>
        </div>;
      })}
      <Row label="Backhaul" value={`${telemetry.uplink.toFixed(0)} Mb`} />
    </aside>;
  }

  if (role.hud === "rescue") {
    return <aside className={styles.panel}>
      <h3>Lifesign <b>SIM</b></h3>
      <Row label="Returns" value={String(telemetry.contacts)} />
      <Row label="Swept" value={`${telemetry.coverage.toFixed(0)}%`} />
      <Row label="Threshold" value="34 dB" />
      <Row label="Nearest fire" value={nearby[0] ? `${Math.round(nearby[0].distance)} m` : "clear"} />
    </aside>;
  }

  return <aside className={styles.panel}>
    <h3>Survey</h3>
    <Row label="Coverage" value={`${telemetry.coverage.toFixed(0)}%`} />
    <Row label="Hotspots" value={String(nearby.length)} />
    <Row label="World hot" value={intel.known ? String(intel.hot) : "—"} />
    <Row label="Ground res" value={`${(telemetry.altitude / 40 + 0.4).toFixed(2)} m/px`} />
  </aside>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className={styles.row}><span>{label}</span><strong>{value}</strong></div>;
}

// ------------------------------------------------------------------ plumbing

/** A clock that only exists while something is mounted to read it. */
function useTicker(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * A running timecode, from frames the agent has really captured.
 *
 * Not the wall clock: a feed that has been up for four minutes should say four minutes, and a
 * drone that just spawned should start from zero. The frame counter is exactly that.
 */
function timecode(frames: number, fps: number) {
  const rate = Math.max(1, Math.round(fps));
  const total = Math.floor(frames / rate);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(frames % rate)}`;
}

/** An SVG arc path, because the relay reticle is made of them. */
function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const point = (degrees: number) => {
    const radians = degrees * Math.PI / 180;
    return `${(cx + Math.cos(radians) * r).toFixed(2)} ${(cy + Math.sin(radians) * r).toFixed(2)}`;
  };
  return `M${point(from)} A${r} ${r} 0 0 1 ${point(to)}`;
}
