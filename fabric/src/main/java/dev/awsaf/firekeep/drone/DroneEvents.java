package dev.awsaf.firekeep.drone;

import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The mod's outbound notice board: every agent detection and drone outcome goes through here.
 *
 * <p>Two consumers, deliberately. Events are pushed to the configured n8n webhook and kept in a
 * short ring buffer so {@code GET /api/events} still works when that webhook is unavailable.
 *
 * <p>The interesting work is suppression. A forest fire changes state every tick, and an agent
 * that receives {@code fire_detected} twenty times a second is worse than one that receives it
 * once, so sightings are folded onto a coarse grid and rate-limited per cell.
 */
public final class DroneEvents {
    private static final int HISTORY = 256;
    /** Fires within the same 8-block cube are the same fire as far as an alert is concerned. */
    private static final int DEDUP_GRID = 8;

    private static final Deque<DroneEvent> RECENT = new ArrayDeque<>();
    private static final Map<String, Long> REPORTED = new HashMap<>();

    private static volatile DroneConfig config;
    private static volatile N8nClient client;

    private DroneEvents() {
    }

    public static void start(DroneConfig droneConfig, N8nClient eventClient) {
        config = droneConfig;
        client = eventClient;
        synchronized (RECENT) {
            RECENT.clear();
            REPORTED.clear();
        }
    }

    public static void emit(String event, String droneId, JsonObject payload) {
        DroneEvent record = new DroneEvent(event, droneId, payload, System.currentTimeMillis());
        synchronized (RECENT) {
            RECENT.addLast(record);
            while (RECENT.size() > HISTORY) {
                RECENT.removeFirst();
            }
        }

        N8nClient sink = client;
        DroneConfig current = config;
        if (sink != null && current != null && current.hasWebhook()) {
            sink.send(record.toJson());
        }
        Firekeep.LOGGER.debug("drone event {} ({})", event, droneId);
    }

    /** Convenience for the common shape: an event about a drone at a place. */
    public static void emitAt(String event, String droneId, Vec3 position, JsonObject extra) {
        JsonObject payload = extra == null ? new JsonObject() : extra;
        if (position != null) {
            payload.add("location", PerceptionSnapshot.vec(position));
        }
        emit(event, droneId, payload);
    }

    public static List<DroneEvent> recent(int limit) {
        synchronized (RECENT) {
            List<DroneEvent> events = new ArrayList<>(RECENT);
            int from = Math.max(0, events.size() - limit);
            return List.copyOf(events.subList(from, events.size()));
        }
    }

    /**
     * Looks a fresh snapshot over for anything the operator has not been told about yet.
     *
     * <p>Called from the perception worker, once per snapshot per drone.
     */
    public static void inspect(PerceptionSnapshot snapshot) {
        DroneConfig current = config;
        if (current == null || !current.eventsEnabled) {
            return;
        }

        for (Feature hazard : snapshot.hazards()) {
            if (!hazard.type().equals(BlockClass.FIRE.label()) && !hazard.type().equals(BlockClass.LAVA.label())) {
                continue;
            }
            String incidentId = incidentId(hazard.type(), snapshot.dimension(), hazard.x(), hazard.y(), hazard.z());
            if (!claim(incidentId, current.fireEventCooldownSeconds)) {
                continue;
            }

            boolean disaster = hazard.size() >= current.disasterFireCells;
            JsonObject payload = new JsonObject();
            payload.addProperty("hazard", hazard.type());
            payload.addProperty("size", hazard.size());
            payload.addProperty("direction", hazard.direction());
            payload.addProperty("distance", hazard.distance());
            payload.addProperty("severity", snapshot.hazardLevel());
            payload.addProperty("terrain", snapshot.terrain());
            payload.addProperty("biome", snapshot.biome());
            payload.addProperty("dimension", snapshot.dimension());
            payload.addProperty("incident_id", incidentId);

            JsonObject location = new JsonObject();
            location.addProperty("x", hazard.x());
            location.addProperty("y", hazard.y());
            location.addProperty("z", hazard.z());
            payload.add("location", location);
            emit(disaster ? "disaster_detected" : "fire_detected", snapshot.droneId(), payload);
        }
    }

    /**
     * Takes the right to report a hazard at this spot, or refuses because somebody already did.
     *
     * @return true the first time a cell is claimed, and again once the cooldown has elapsed
     */
    private static boolean claim(String incidentId, int cooldownSeconds) {
        long now = System.currentTimeMillis();

        synchronized (REPORTED) {
            REPORTED.entrySet().removeIf(entry -> entry.getValue() < now);
            Long until = REPORTED.get(incidentId);
            if (until != null) {
                return false;
            }
            REPORTED.put(incidentId, now + cooldownSeconds * 1000L);
            return true;
        }
    }

    /** Stable across agents: all sightings in the same dimension/grid cell name one incident. */
    private static String incidentId(String type, String dimension, int x, int y, int z) {
        return type + ":" + dimension + ":"
                + Math.floorDiv(x, DEDUP_GRID) + ":"
                + Math.floorDiv(y, DEDUP_GRID) + ":"
                + Math.floorDiv(z, DEDUP_GRID);
    }
}
