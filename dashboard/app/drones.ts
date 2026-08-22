/** The drone roster, shared by the camera wall and the world map. */

export const AREAS = ["Northeast", "Northwest", "Southwest", "Southeast"] as const;

export type Area = (typeof AREAS)[number];
export type Filter = "All" | Area;
export type Drone = { name: string; area: Area };

export const DRONES: Drone[] = AREAS.flatMap((area, areaIndex) =>
  Array.from({ length: 3 }, (_, index) => ({ name: `Drone ${areaIndex * 3 + index + 1}`, area })),
);

/**
 * Which half of the world an area covers, as fractions of the map bounds.
 * Minecraft's north is -Z and east is +X, so "Northeast" is the +X/-Z corner.
 */
export const AREA_QUADRANT: Record<Area, { east: boolean; south: boolean }> = {
  Northeast: { east: true, south: false },
  Northwest: { east: false, south: false },
  Southwest: { east: false, south: true },
  Southeast: { east: true, south: true },
};
