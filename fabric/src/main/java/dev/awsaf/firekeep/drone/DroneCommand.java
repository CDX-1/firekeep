package dev.awsaf.firekeep.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * One order from n8n, parsed and validated before it ever reaches the server thread.
 *
 * <p>Parsing here rather than in the executor means a malformed command is rejected with a useful
 * HTTP 400 on the request that sent it, instead of failing silently a tick later where only the
 * server log would ever see it.
 */
public final class DroneCommand {
    private final String id;
    private final String droneId;
    private final CommandType type;
    private final JsonObject args;
    private final long submittedAtMillis;
    private final CompletableFuture<CommandResult> completion = new CompletableFuture<>();

    private DroneCommand(String droneId, CommandType type, JsonObject args) {
        this.id = UUID.randomUUID().toString().substring(0, 8);
        this.droneId = droneId;
        this.type = type;
        this.args = args;
        this.submittedAtMillis = System.currentTimeMillis();
    }

    /** @throws IllegalArgumentException with a message meant to be shown to whoever sent it */
    public static DroneCommand parse(String droneId, JsonObject body) {
        if (body == null) {
            throw new IllegalArgumentException("expected a JSON object body");
        }
        CommandType type = CommandType.parse(string(body, "command", null));
        if (type == null) {
            throw new IllegalArgumentException("unknown command '" + string(body, "command", "")
                    + "'; expected one of " + labels());
        }

        DroneCommand command = new DroneCommand(droneId, type, body);
        command.validate();
        return command;
    }

    private void validate() {
        switch (this.type) {
            case MOVE -> {
                if (direction() == null) {
                    throw new IllegalArgumentException("move needs a \"direction\" (north, southwest, up, ...)");
                }
                if (direction() == Compass.UP || direction() == Compass.DOWN) {
                    throw new IllegalArgumentException("vertical movement is controlled by the drone flight envelope");
                }
                if (distance() <= 0.0D) {
                    throw new IllegalArgumentException("move needs a positive \"distance\"");
                }
            }
            case MOVE_TO -> {
                if (target() == null) {
                    throw new IllegalArgumentException("move_to needs \"x\" and \"z\"; altitude is controlled by the drone");
                }
            }
            case FOLLOW -> {
                if (targetId() == null) {
                    throw new IllegalArgumentException("follow needs a \"target\" drone id or player name");
                }
            }
            case PATROL -> {
                if (waypoints().isEmpty()) {
                    throw new IllegalArgumentException("patrol needs a \"waypoints\" array of {x,y,z}");
                }
            }
            case SET_SPEED -> {
                if (speed() <= 0.0D) {
                    throw new IllegalArgumentException("set_speed needs a positive \"speed\" in blocks per second");
                }
            }
            default -> {
                // hover, scan, return_home, dispense_water, look, set_home and cancel take no
                // required arguments; every optional one has a sane default.
            }
        }
    }

    private static String labels() {
        StringBuilder out = new StringBuilder();
        for (CommandType type : CommandType.values()) {
            if (!out.isEmpty()) {
                out.append(", ");
            }
            out.append(type.label());
        }
        return out.toString();
    }

    // ---------------------------------------------------------------- accessors

    public String id() {
        return this.id;
    }

    public String droneId() {
        return this.droneId;
    }

    public CommandType type() {
        return this.type;
    }

    public long submittedAtMillis() {
        return this.submittedAtMillis;
    }

    public CompletableFuture<CommandResult> completion() {
        return this.completion;
    }

    public Compass direction() {
        return Compass.parse(string(this.args, "direction", null));
    }

    public double distance() {
        return number(this.args, "distance", 0.0D);
    }

    /** Horizontal destination; a caller-supplied Y is deliberately ignored by the flight controller. */
    public Vec3 target() {
        if (this.args.has("position") && this.args.get("position").isJsonObject()) {
            JsonObject position = this.args.getAsJsonObject("position");
            return vec(position);
        }
        return vec(this.args);
    }

    public String targetId() {
        return string(this.args, "target", null);
    }

    public double speed() {
        return number(this.args, "speed", 0.0D);
    }

    public Float yaw() {
        return this.args.has("yaw") ? (float) number(this.args, "yaw", 0.0D) : null;
    }

    public Float pitch() {
        return this.args.has("pitch") ? (float) number(this.args, "pitch", 0.0D) : null;
    }

    /** {@code look} may aim at a point instead of an angle; this is that point. */
    public Vec3 lookAt() {
        if (this.args.has("at") && this.args.get("at").isJsonObject()) {
            return vec(this.args.getAsJsonObject("at"));
        }
        return null;
    }

    public double radius() {
        return number(this.args, "radius", 0.0D);
    }

    public boolean loop() {
        return this.args.has("loop") && this.args.get("loop").getAsBoolean();
    }

    /** Extra height held above the straight line, so a move across a valley clears the ridge. */
    public double altitude() {
        return number(this.args, "altitude", Double.NaN);
    }

    public List<Vec3> waypoints() {
        List<Vec3> points = new ArrayList<>();
        if (!this.args.has("waypoints") || !this.args.get("waypoints").isJsonArray()) {
            return points;
        }
        for (JsonElement element : this.args.getAsJsonArray("waypoints")) {
            if (element.isJsonObject()) {
                Vec3 point = vec(element.getAsJsonObject());
                if (point != null) {
                    points.add(point);
                }
            } else if (element.isJsonArray()) {
                JsonArray triple = element.getAsJsonArray();
                if (triple.size() >= 2) {
                    points.add(new Vec3(triple.get(0).getAsDouble(), 0.0D,
                            triple.get(triple.size() - 1).getAsDouble()));
                }
            }
        }
        return points;
    }

    public String describe() {
        return switch (this.type) {
            case MOVE -> "move " + direction().label() + " " + distance();
            case MOVE_TO -> "move_to " + format(target());
            case FOLLOW -> "follow " + targetId();
            default -> this.type.label();
        };
    }

    private static String format(Vec3 vec) {
        return vec == null ? "?" : String.format("%.1f, %.1f, %.1f", vec.x, vec.y, vec.z);
    }

    // ---------------------------------------------------------------- json helpers

    private static Vec3 vec(JsonObject json) {
        if (json == null || !json.has("x") || !json.has("z")) {
            return null;
        }
        try {
            return new Vec3(json.get("x").getAsDouble(), 0.0D, json.get("z").getAsDouble());
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("x and z must be numbers");
        }
    }

    private static String string(JsonObject json, String key, String fallback) {
        try {
            return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static double number(JsonObject json, String key, double fallback) {
        try {
            return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsDouble() : fallback;
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("\"" + key + "\" must be a number");
        }
    }
}
