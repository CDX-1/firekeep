package dev.awsaf.firekeep.drone;

import com.google.gson.JsonObject;
import net.minecraft.world.phys.Vec3;

/**
 * A drone as the outside world sees it: enough for n8n to pick one, and nothing that would need
 * a lock or a Minecraft object to read. Rebuilt on the server thread every tick and published
 * into a concurrent map, so an HTTP handler never touches the game.
 */
public record DroneState(
        String id,
        DroneStatus status,
        boolean available,
        String dimension,
        Vec3 position,
        float yaw,
        float pitch,
        Vec3 velocity,
        Vec3 home,
        Vec3 goal,
        String activeCommand,
        String activeCommandId,
        int waypointsRemaining,
        CommandResult lastResult,
        double speedBlocksPerSecond,
        long gameTime,
        int entityId) {

    public JsonObject toJson() {
        JsonObject json = new JsonObject();
        json.addProperty("id", this.id);
        json.addProperty("status", this.status.label());
        json.addProperty("available", this.available);
        json.addProperty("dimension", this.dimension);
        json.add("position", PerceptionSnapshot.vec(this.position));
        json.add("velocity", PerceptionSnapshot.vec(this.velocity));

        JsonObject rotation = new JsonObject();
        rotation.addProperty("yaw", PerceptionSnapshot.round(this.yaw));
        rotation.addProperty("pitch", PerceptionSnapshot.round(this.pitch));
        json.add("rotation", rotation);

        if (this.home != null) {
            json.add("home", PerceptionSnapshot.vec(this.home));
        }
        if (this.goal != null) {
            json.add("goal", PerceptionSnapshot.vec(this.goal));
        }
        if (this.activeCommand != null) {
            json.addProperty("active_command", this.activeCommand);
            json.addProperty("active_command_id", this.activeCommandId);
            json.addProperty("waypoints_remaining", this.waypointsRemaining);
        }
        if (this.lastResult != null) {
            json.add("last_result", this.lastResult.toJson());
        }
        json.addProperty("speed_blocks_per_second", PerceptionSnapshot.round(this.speedBlocksPerSecond));
        json.addProperty("game_time", this.gameTime);
        json.addProperty("entity_id", this.entityId);
        return json;
    }
}
