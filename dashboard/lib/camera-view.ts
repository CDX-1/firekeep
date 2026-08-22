/**
 * Where a point in the world lands on a drone's picture.
 *
 * The instrument layers draw boxes around things that are really there - the fires the mod is
 * reporting, the other drones on the net - and a box is only worth drawing if it sits on the
 * thing it names. So this reproduces the camera the mod is rendering with: Minecraft's 70 degree
 * vertical field of view, the drone's own yaw, and the downward pitch the operator dialled in.
 *
 * It is an approximation in one respect, and knowingly. Nothing reports the camera's pitch back
 * to the dashboard - the mod takes a `look` order and never mentions it again - so the pitch used
 * here is the last one this dashboard asked for, remembered below. A drone somebody else tilted
 * will have its boxes sit high or low until this dashboard tilts it too.
 */

/** Minecraft's default vertical field of view, which is what the agents render at. */
const FOV_Y = 70;

/** Nothing is drawn nearer than this: at a few centimetres the maths explodes and the box fills the screen. */
const NEAR = 1.5;

/** What DroneControls opens its pitch slider at, so an untouched drone is not assumed level. */
export const DEFAULT_PITCH = 25;

const pitches = new Map<string, number>();

/** Remembers the downward tilt just ordered, so the overlays can aim with it. */
export function rememberPitch(id: string, pitch: number) {
  pitches.set(id, pitch);
}

/** The tilt this dashboard believes the camera is at. */
export function pitchOf(id: string) {
  return pitches.get(id) ?? DEFAULT_PITCH;
}

export interface Camera {
  x: number;
  y: number;
  z: number;
  /** Minecraft degrees: 0 faces +Z, and it grows anticlockwise seen from above. */
  yaw: number;
  /** degrees below the horizon */
  pitch: number;
}

export interface Projected {
  /** 0..1 across the picture, left to right. Outside that range means off frame. */
  u: number;
  /** 0..1 down the picture. */
  v: number;
  /** metres in front of the lens */
  depth: number;
  /** true while the point is inside the frame with a little margin, so a box is worth drawing */
  onScreen: boolean;
}

/**
 * Projects a world point onto the picture, or null when it is behind the camera.
 *
 * `aspect` is the picture's, not the sensor's: the field of view is vertical, so a 16:9 frame
 * sees wider than a 4:3 one at the same 70 degrees and a box has to move accordingly.
 */
export function project(camera: Camera, x: number, y: number, z: number, aspect = 16 / 9): Projected | null {
  const yaw = camera.yaw * Math.PI / 180;
  const pitch = camera.pitch * Math.PI / 180;

  // Facing +Z at yaw 0, and east is on your left there - so right is -X, not +X.
  const forwardX = -Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const rightX = -Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  const dx = x - camera.x;
  const dy = y - camera.y;
  const dz = z - camera.z;

  const along = dx * forwardX + dz * forwardZ;
  const lateral = dx * rightX + dz * rightZ;

  // Tilt the (along, up) pair down by the camera pitch; lateral is unaffected by a pure tilt.
  const depth = along * Math.cos(pitch) - dy * Math.sin(pitch);
  const up = along * Math.sin(pitch) + dy * Math.cos(pitch);
  if (depth < NEAR) return null;

  const tanY = Math.tan(FOV_Y * Math.PI / 360);
  const tanX = tanY * aspect;
  const u = 0.5 + 0.5 * (lateral / depth) / tanX;
  const v = 0.5 - 0.5 * (up / depth) / tanY;

  return { u, v, depth, onScreen: u > -0.08 && u < 1.08 && v > -0.08 && v < 1.08 };
}

/** How wide something `metres` across appears, as a fraction of the frame, at that distance. */
export function apparentWidth(metres: number, depth: number, aspect = 16 / 9) {
  const tanX = Math.tan(FOV_Y * Math.PI / 360) * aspect;
  return metres / (2 * depth * tanX);
}
