package dev.awsaf.firekeep.drone;

import com.google.gson.JsonObject;

/** One thing worth waking n8n up for. */
public record DroneEvent(String event, String droneId, JsonObject payload, long atMillis) {

    public JsonObject toJson() {
        JsonObject json = new JsonObject();
        json.addProperty("event", this.event);
        if (this.droneId != null) {
            json.addProperty("drone_id", this.droneId);
        }
        json.addProperty("at", this.atMillis);
        if (this.payload != null) {
            this.payload.entrySet().forEach(entry -> json.add(entry.getKey(), entry.getValue()));
        }
        return json;
    }
}
