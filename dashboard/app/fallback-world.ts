/**
 * A stand-in world for when server.py is not running.
 *
 * It is generated, not real, but it is painted with the same map palette and the
 * same north-facing relief shading the Python renderer uses, so the map tab looks
 * and behaves the same whether or not there is a save to read.
 */

import type { WorldMeta } from "@/lib/types";

const SIZE = 512;
const ORIGIN = -SIZE / 2;

// the vanilla map colours this needs, and the brightness tiers applied to them
const DEEP_WATER = 0x2b2bcc;
const WATER = 0x4040ff;
const SAND = 0xf7e9a3;
const GRASS = 0x7fb238;
const FOREST = 0x007c00;
const STONE = 0x707070;
const SNOW = 0xffffff;
const LOW = 180;
const NORMAL = 220;
const HIGH = 255;

export function fallbackWorld(): { meta: WorldMeta; image: CanvasImageSource; real: boolean } {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const pixels = ctx.createImageData(SIZE, SIZE);

  const heights = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      heights[z * SIZE + x] = terrain(x, z);
    }
  }

  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x;
      const h = heights[i];
      const checker = (x + z) & 1;

      let color: number;
      let brightness: number;
      if (h < 58) {
        color = h < 46 ? DEEP_WATER : WATER;
        const d = (62 - h) * 0.1 + checker * 0.2;
        brightness = d < 0.5 ? HIGH : d > 0.9 ? LOW : NORMAL;
      } else {
        color = h < 63 ? SAND : h < 96 ? (fine(x, z) > 0.52 ? FOREST : GRASS) : h < 122 ? STONE : SNOW;
        const north = z > 0 ? heights[i - SIZE] : h;
        const d = (h - north) + (checker - 0.5) * 0.4;
        brightness = d > 0.6 ? HIGH : d < -0.6 ? LOW : NORMAL;
      }

      const o = i * 4;
      pixels.data[o] = ((color >> 16) & 0xff) * brightness / 255;
      pixels.data[o + 1] = ((color >> 8) & 0xff) * brightness / 255;
      pixels.data[o + 2] = (color & 0xff) * brightness / 255;
      pixels.data[o + 3] = 255;
    }
  }

  ctx.putImageData(pixels, 0, 0);

  return {
    real: false,
    image: canvas,
    meta: {
      dimension: "overworld",
      origin_x: ORIGIN,
      origin_z: ORIGIN,
      width: SIZE,
      height: SIZE,
      blocks_per_pixel: 1,
      chunks: (SIZE / 16) ** 2,
      regions: (SIZE / 512) ** 2,
      took_seconds: 0,
      name: "Sample world",
      spawn: { x: 0, y: 72, z: 0 },
      save: "",
      map_url: "",
    },
  };
}

/**
 * Surface height in blocks.
 *
 * Three octaves decide where the continents are; one round of smoothstep pulls
 * the mid-range apart so the map gets real coastlines rather than one soft dome.
 * The constants are tuned for roughly 20% ocean and 60% forest and grass, which
 * is about what the generated overworld next door looks like.
 */
function terrain(x: number, z: number) {
  const continent = smooth(fbm(x, z, 170, 3));
  return 4 + continent * 118 + noise(x / 21, z / 21) * 7 + noise(x / 8, z / 8) * 3;
}

/** Octaves of value noise at halving scale and amplitude, normalised to 0..1. */
function fbm(x: number, z: number, scale: number, octaves: number) {
  let total = 0;
  let range = 0;
  let amplitude = 1;
  for (let i = 0; i < octaves; i++) {
    total += noise(x / scale, z / scale) * amplitude;
    range += amplitude;
    amplitude /= 2;
    scale /= 2;
  }
  return total / range;
}

/** Small-scale noise that decides grass vs forest. */
function fine(x: number, z: number) {
  return noise(x / 7, z / 7) * 0.55 + noise(x / 29, z / 29) * 0.45;
}

function noise(x: number, z: number) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fz = smooth(z - z0);
  const top = lerp(hash(x0, z0), hash(x0 + 1, z0), fx);
  const bottom = lerp(hash(x0, z0 + 1), hash(x0 + 1, z0 + 1), fx);
  return lerp(top, bottom, fz);
}

function hash(x: number, z: number) {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
