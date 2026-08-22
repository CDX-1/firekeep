/**
 * The quadrants the camera wall and the world map both group drones by.
 *
 * There is no roster here any more: both tabs take theirs from the running game - the
 * camera wall from the agents' /camera/drones, the map from the mod's live world feed -
 * and work out the area from where a drone actually is with `areaOf` in lib/cameras.
 *
 * The areas themselves live in lib/types with the rest of the shapes the mod sends, so
 * there is one list rather than two that can drift apart.
 */

import { DRONE_AREAS, type DroneArea } from "@/lib/types";

export const AREAS = DRONE_AREAS;

export type Area = DroneArea;
export type Filter = "All" | Area;
