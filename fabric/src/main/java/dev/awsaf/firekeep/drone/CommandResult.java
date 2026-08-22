package dev.awsaf.firekeep.drone;

import com.google.gson.JsonObject;

/**
 * How an order ended. Every command produces exactly one of these, whether it was awaited over
 * HTTP or reported later through the event webhook.
 */
public record CommandResult(
        String commandId,
        String droneId,
        String command,
        boolean ok,
        String status,
        String message,
        JsonObject data) {

    public static CommandResult accepted(DroneCommand command) {
        return new CommandResult(command.id(), command.droneId(), command.type().label(), true,
                "accepted", "command accepted", null);
    }

    public static CommandResult completed(DroneCommand command, String message) {
        return new CommandResult(command.id(), command.droneId(), command.type().label(), true,
                "completed", message, null);
    }

    public static CommandResult completed(DroneCommand command, String message, JsonObject data) {
        return new CommandResult(command.id(), command.droneId(), command.type().label(), true,
                "completed", message, data);
    }

    public static CommandResult failed(DroneCommand command, String message) {
        return new CommandResult(command.id(), command.droneId(), command.type().label(), false,
                "failed", message, null);
    }

    public static CommandResult superseded(DroneCommand command) {
        return new CommandResult(command.id(), command.droneId(), command.type().label(), false,
                "superseded", "replaced by a newer command", null);
    }

    public JsonObject toJson() {
        JsonObject json = new JsonObject();
        json.addProperty("command_id", this.commandId);
        json.addProperty("drone_id", this.droneId);
        json.addProperty("command", this.command);
        json.addProperty("ok", this.ok);
        json.addProperty("status", this.status);
        json.addProperty("message", this.message);
        if (this.data != null) {
            json.add("data", this.data);
        }
        return json;
    }
}
