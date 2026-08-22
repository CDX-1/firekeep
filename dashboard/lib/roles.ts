/**
 * What each drone in the fleet is *for*.
 *
 * The mod does not know about roles - every drone it spawns is the same entity with the same
 * camera. A role is the dashboard's reading of the fleet: an operations doctrine laid over the
 * roster so that twelve identical quadcopters stop looking like twelve identical quadcopters.
 * It decides the colour a drone is drawn in on the map, the instrument package painted over its
 * video, which numbers its telemetry panel shows, and what it says on the radio.
 *
 * Roles are derived, not stored, and derived from the drone id alone. That matters more than it
 * looks: the camera wall takes its roster from the Python server and the map takes its roster
 * from the mod's world feed, and those two lists are assembled independently and arrive at
 * different rates. Anything positional or ordinal - "the third drone gets suppression" - would
 * have a drone change job every time a roster landed a beat early. A hash of the id cannot.
 */

export const ROLE_IDS = ["survey", "thermal", "suppress", "relay", "rescue"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export interface Role {
  id: RoleId;
  /** Three letters, and the front half of every callsign flown by this role. */
  code: string;
  name: string;
  /** One line an operator can read off a badge and know what the aircraft is doing up there. */
  tagline: string;
  /** Drawn in this colour everywhere: map marker, HUD frame, badge, radio line. */
  color: string;
  /** The same colour as bare channels, for CSS that needs its own alpha. */
  rgb: [number, number, number];
  /** What is bolted to the airframe, printed along the top of the video like a lens stamp. */
  sensor: string;
  /** The instrument layer drawn over this drone's picture. */
  hud: RoleId;
  /** Radio traffic this role sends, `{}` filled in from live state. */
  chatter: string[];
}

/**
 * The five jobs a wildfire fleet actually splits into.
 *
 * Deliberately not one role per drone: several drones flying the same job is the normal case,
 * and a fleet reads as a fleet precisely because there are two surveyors working a perimeter
 * from opposite ends rather than five specialists who each do one unrepeatable thing.
 */
export const ROLES: Record<RoleId, Role> = {
  survey: {
    id: "survey",
    code: "SVY",
    name: "Surveyor",
    tagline: "Maps the burn and calls the perimeter",
    color: "#b7d16a",
    rgb: [183, 209, 106],
    sensor: "EO 4K · LIDAR SWEEP",
    hud: "survey",
    chatter: [
      "sector sweep {sector} running, {coverage}% mapped",
      "perimeter marked at {bearing}, {range}m out",
      "logging {hot} hot columns this pass",
      "terrain model updated, handing to ops",
      "requesting altitude block {alt}m for the next leg",
    ],
  },
  thermal: {
    id: "thermal",
    code: "THR",
    name: "Thermal Recon",
    tagline: "Reads heat through smoke and canopy",
    color: "#e2604a",
    rgb: [226, 96, 74],
    sensor: "LWIR 640 · 30Hz",
    hud: "thermal",
    chatter: [
      "peak {temp}°C at {bearing}, that is an active head",
      "isotherm band tightening, fire is running",
      "cold trace behind the line, that flank is out",
      "smoke column obscuring EO, staying on IR",
      "flagging {hot} sources above threshold",
    ],
  },
  suppress: {
    id: "suppress",
    code: "SUP",
    name: "Suppression",
    tagline: "Carries retardant and puts it on the line",
    color: "#6fa8d0",
    rgb: [111, 168, 208],
    sensor: "EO 4K · DROP SIGHT",
    hud: "suppress",
    chatter: [
      "tank at {payload}%, holding for a run",
      "on final for the drop, corridor is clear",
      "released on the head, {payload}% remaining",
      "wind {wind} knots, correcting the approach",
      "returning to the pad to reload",
    ],
  },
  relay: {
    id: "relay",
    code: "RLY",
    name: "Comms Relay",
    tagline: "Holds the mesh up over the valley",
    color: "#b78ec9",
    rgb: [183, 142, 201],
    sensor: "MESH NODE · 5.8GHz",
    hud: "relay",
    chatter: [
      "mesh holding, {peers} nodes on the net",
      "backhaul at {uplink}Mb, no packet loss",
      "picking up a weak leg to {peer}, re-routing",
      "climbing for line of sight on the ridge",
      "net is clean, all stations readable",
    ],
  },
  rescue: {
    id: "rescue",
    code: "SAR",
    name: "Search & Rescue",
    tagline: "Sweeps for anything alive ahead of the fire",
    color: "#e6c15a",
    rgb: [230, 193, 90],
    sensor: "EO/IR · LIFESIGN",
    hud: "rescue",
    chatter: [
      "sweeping the {sector} draw, nothing so far",
      "possible contact at {bearing}, closing to confirm",
      "{contacts} signature{plural} on this pass, marking",
      "grid clear, moving to the next block",
      "holding over the contact for ground crews",
    ],
  },
};

export const ROLE_LIST = ROLE_IDS.map((id) => ROLES[id]);

/**
 * A stable 32-bit mix of a drone id.
 *
 * FNV-1a with an avalanche on the end. Plain FNV alone is fine for a hash table and poor here:
 * the ids that actually turn up are `drone-41`, `drone-42`, `drone-43`, and unmixed FNV maps
 * neighbouring strings to neighbouring values - which, taken modulo five, hands the whole fleet
 * out in one rotating order and makes the roles look like a countdown rather than an assignment.
 */
function hash(id: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d);
  value ^= value >>> 12;
  value = Math.imul(value, 0x297a2d39);
  value ^= value >>> 15;
  return value >>> 0;
}

/** The job this drone is flying. The same drone always gets the same one. */
export function roleOf(id: string): Role {
  return ROLES[ROLE_IDS[hash(id) % ROLE_IDS.length]];
}

/**
 * What the drone answers to on the radio, e.g. `SVY-114`.
 *
 * Two digits from the same hash rather than a counter, because a counter needs a roster to count
 * within and the roster is exactly the thing that is not stable. It means callsigns are not
 * consecutive, which is also true of every real fleet.
 */
export function callsignOf(id: string) {
  const role = roleOf(id);
  return `${role.code}-${String(hash(id) % 90 + 10)}`;
}

/** A stable 0..1 from a drone id and a label, for per-drone instrument values that must not jitter. */
export function seedOf(id: string, salt = "") {
  return hash(`${salt}:${id}`) / 0xffffffff;
}

/** `rgba()` from a role, so CSS can take a role colour at whatever alpha it needs. */
export const roleAlpha = (role: Role, alpha: number) =>
  `rgba(${role.rgb[0]}, ${role.rgb[1]}, ${role.rgb[2]}, ${alpha})`;

/** The eight-point compass bearing, the way it would be called over the radio. */
export const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function bearingName(degrees: number) {
  const index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
  return POINTS[index];
}

/**
 * Compass bearing from one point to another, in degrees, in Minecraft's frame.
 *
 * North is -Z and east is +X, and a bearing is measured clockwise from north - so it is
 * `atan2(east, north)` rather than the other way round.
 */
export function bearingTo(fromX: number, fromZ: number, toX: number, toZ: number) {
  const degrees = Math.atan2(toX - fromX, -(toZ - fromZ)) * 180 / Math.PI;
  return (degrees + 360) % 360;
}
