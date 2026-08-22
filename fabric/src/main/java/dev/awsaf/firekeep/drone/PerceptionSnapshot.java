package dev.awsaf.firekeep.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Map;

/**
 * What one drone understands about where it is - the payload n8n hands to the model.
 *
 * <p>Everything here is already a decision-ready fact. There are no block coordinates the model
 * has to reduce itself, no raw grids, and nothing it would have to count. The JSON is a few
 * kilobytes whatever the world is doing, because every list is capped and every region is
 * summarised rather than enumerated.
 */
public record PerceptionSnapshot(
        String droneId,
        String dimension,
        long gameTime,
        long capturedAtMillis,
        Vec3 position,
        float yaw,
        float pitch,
        Vec3 velocity,
        DroneStatus status,
        String activeCommand,
        Vec3 home,
        String terrain,
        String ground,
        int altitude,
        String biome,
        boolean raining,
        boolean thundering,
        List<String> openDirections,
        Map<String, Integer> clearance,
        List<Feature> obstacles,
        List<Feature> hazards,
        List<Feature> resources,
        List<EntitySighting> entities,
        String hazardLevel,
        int fireCells,
        int lavaCells,
        int waterCells,
        String map,
        int radius,
        int verticalRadius) {

    /** The legend for {@link #map}, sent alongside it so the model never has to be told twice. */
    public static final String MAP_LEGEND =
            "D=drone F=fire L=lava W=water T=tree t=leaves B=building #=terrain o=obstacle "
                    + "!=hazard ,=ground cover ?=unknown .=open  P=player d=other drone x=hostile "
                    + "a=animal. "
                    + "North is the top row, east is to the right, one character per block column.";

    public JsonObject toJson() {
        JsonObject root = new JsonObject();
        root.addProperty("drone_id", this.droneId);
        root.addProperty("status", this.status.label());
        root.addProperty("dimension", this.dimension);
        root.addProperty("game_time", this.gameTime);
        root.addProperty("captured_at", this.capturedAtMillis);
        if (this.activeCommand != null) {
            root.addProperty("active_command", this.activeCommand);
        }

        root.add("position", vec(this.position));
        root.add("velocity", vec(this.velocity));
        if (this.home != null) {
            root.add("home", vec(this.home));
        }

        JsonObject rotation = new JsonObject();
        rotation.addProperty("yaw", round(this.yaw));
        rotation.addProperty("pitch", round(this.pitch));
        rotation.addProperty("facing", Compass.of(-Math.sin(Math.toRadians(this.yaw)), 0.0D,
                Math.cos(Math.toRadians(this.yaw))).label());
        root.add("rotation", rotation);

        JsonObject environment = new JsonObject();
        environment.addProperty("terrain", this.terrain);
        environment.addProperty("biome", this.biome);
        environment.addProperty("ground", this.ground);
        environment.addProperty("altitude_above_ground", this.altitude);
        environment.addProperty("weather", this.thundering ? "thunder" : this.raining ? "rain" : "clear");
        environment.addProperty("hazard_level", this.hazardLevel);
        environment.add("open_directions", strings(this.openDirections));

        JsonObject clear = new JsonObject();
        this.clearance.forEach(clear::addProperty);
        environment.add("clearance", clear);

        environment.add("obstacles", features(this.obstacles));
        environment.add("hazards", features(this.hazards));
        environment.add("resources", features(this.resources));

        JsonObject counts = new JsonObject();
        counts.addProperty("fire", this.fireCells);
        counts.addProperty("lava", this.lavaCells);
        counts.addProperty("water", this.waterCells);
        environment.add("block_counts", counts);
        root.add("environment", environment);

        root.add("entities", entitiesJson());

        if (this.map != null) {
            JsonObject localMap = new JsonObject();
            localMap.addProperty("radius", this.radius);
            localMap.addProperty("vertical_radius", this.verticalRadius);
            localMap.addProperty("legend", MAP_LEGEND);
            localMap.addProperty("grid", this.map);
            root.add("local_map", localMap);
        }
        return root;
    }

    private JsonArray entitiesJson() {
        JsonArray array = new JsonArray();
        for (EntitySighting sighting : this.entities) {
            JsonObject json = new JsonObject();
            json.addProperty("id", sighting.id());
            json.addProperty("type", sighting.type());
            json.addProperty("category", sighting.category());
            json.addProperty("direction", sighting.direction());
            json.addProperty("distance", sighting.distance());
            json.addProperty("on_fire", sighting.onFire());
            if (sighting.health() != null) {
                json.addProperty("health", sighting.health());
            }
            JsonObject at = new JsonObject();
            at.addProperty("x", sighting.x());
            at.addProperty("y", sighting.y());
            at.addProperty("z", sighting.z());
            json.add("position", at);
            array.add(json);
        }
        return array;
    }

    private static JsonArray features(List<Feature> features) {
        JsonArray array = new JsonArray();
        for (Feature feature : features) {
            JsonObject json = new JsonObject();
            json.addProperty("type", feature.type());
            json.addProperty("direction", feature.direction());
            json.addProperty("distance", feature.distance());
            json.addProperty("size", feature.size());
            JsonObject at = new JsonObject();
            at.addProperty("x", feature.x());
            at.addProperty("y", feature.y());
            at.addProperty("z", feature.z());
            json.add("position", at);
            array.add(json);
        }
        return array;
    }

    private static JsonArray strings(List<String> values) {
        JsonArray array = new JsonArray();
        values.forEach(array::add);
        return array;
    }

    static JsonObject vec(Vec3 vec) {
        JsonObject json = new JsonObject();
        json.addProperty("x", round(vec.x));
        json.addProperty("y", round(vec.y));
        json.addProperty("z", round(vec.z));
        return json;
    }

    static double round(double value) {
        return Math.round(value * 100.0D) / 100.0D;
    }
}
