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
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The mod's outbound notice board: every agent detection and drone outcome goes through here.
 *
 * <p>Two consumers, deliberately. Events are pushed to the hub, which decides who else hears
 * about them, and kept in a short ring buffer so {@code GET /api/events} still answers when the
 * hub is down.
 *
 * <p>The interesting work is suppression. A forest fire changes state every tick, and an agent
 * that receives {@code fire_detected} twenty times a second is worse than one that receives it
 * once, so sightings are folded onto a coarse grid and rate-limited per cell.
 */
public final class DroneEvents {
    private static final int HISTORY = 256;
    /** Nearby fire features belong to one operational incident, not one alert per block. */
    private static final double CLUSTER_RADIUS = 24.0D;
    private static final long CLUSTER_TTL_MILLIS = 90_000L;

    private static final Deque<DroneEvent> RECENT = new ArrayDeque<>();
    private static final Map<String, Long> REPORTED = new HashMap<>();
    private static final Map<String, Incident> INCIDENTS = new HashMap<>();
    private static final AtomicInteger NEXT_INCIDENT = new AtomicInteger();

    private static volatile DroneConfig config;
    private static volatile HubClient client;

    private DroneEvents() {
    }

    public static void start(DroneConfig droneConfig, HubClient eventClient) {
        config = droneConfig;
        client = eventClient;
        synchronized (RECENT) {
            RECENT.clear();
            REPORTED.clear();
            INCIDENTS.clear();
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

        HubClient sink = client;
        DroneConfig current = config;
        if (sink != null && current != null && current.eventsEnabled) {
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
            Incident incident = sighting(snapshot, hazard);
            if (!claim(incident.id, current.fireEventCooldownSeconds)) {
                continue;
            }

            boolean disaster = incident.fireBlocks >= current.disasterFireCells;
            JsonObject payload = new JsonObject();
            payload.addProperty("hazard", hazard.type());
            payload.addProperty("size", hazard.size());
            payload.addProperty("direction", hazard.direction());
            payload.addProperty("distance", hazard.distance());
            payload.addProperty("severity", snapshot.hazardLevel());
            payload.addProperty("terrain", snapshot.terrain());
            payload.addProperty("biome", snapshot.biome());
            payload.addProperty("dimension", snapshot.dimension());
            payload.addProperty("incident_id", incident.id);
            payload.addProperty("lifecycle", incident.lifecycle);
            payload.addProperty("cluster_fire_blocks", incident.fireBlocks);
            payload.addProperty("cluster_reports", incident.reports);

            JsonObject location = new JsonObject();
            location.addProperty("x", hazard.x());
            location.addProperty("y", hazard.y());
            location.addProperty("z", hazard.z());
            payload.add("location", location);
            // Only the first report starts a dispatch. Later reports update the same cluster so
            // a patch of adjacent flame never becomes a fleet of duplicate incidents.
            emit(incident.reports == 1 ? (disaster ? "disaster_detected" : "fire_detected")
                    : "incident_update", snapshot.droneId(), payload);
        }
    }

    /** Records a real water action against the nearest live fire cluster. Server thread only. */
    public static void recordSuppression(String droneId, String dimension, Vec3 impact,
                                         int extinguished, int remainingFires) {
        Incident incident;
        synchronized (RECENT) {
            long now = System.currentTimeMillis();
            expireIncidents(now);
            incident = nearestIncident(dimension, impact.x, impact.z);
            if (incident == null) {
                return;
            }
            incident.fireBlocks = Math.max(0, Math.max(remainingFires, incident.fireBlocks - extinguished));
            incident.lastSeen = now;
            incident.lifecycle = remainingFires == 0 ? "cleared" : "contained";
        }

        JsonObject payload = incidentPayload(incident);
        payload.addProperty("extinguished", extinguished);
        payload.addProperty("remaining_fires", remainingFires);
        payload.add("impact", PerceptionSnapshot.vec(impact));
        emit("suppression_applied", droneId, payload.deepCopy());
        emit("incident_update", droneId, payload);
    }

    private static Incident sighting(PerceptionSnapshot snapshot, Feature hazard) {
        synchronized (RECENT) {
            long now = System.currentTimeMillis();
            expireIncidents(now);
            Incident incident = nearestIncident(snapshot.dimension(), hazard.x(), hazard.z());
            if (incident == null) {
                String id = "fire:" + snapshot.dimension() + ":cluster:" + NEXT_INCIDENT.incrementAndGet();
                incident = new Incident(id, snapshot.dimension(), hazard.x(), hazard.y(), hazard.z(), now);
                INCIDENTS.put(id, incident);
            } else {
                // Keep the centre stable enough to aim responders while still following spread.
                incident.x = (incident.x * incident.reports + hazard.x()) / (incident.reports + 1.0D);
                incident.y = hazard.y();
                incident.z = (incident.z * incident.reports + hazard.z()) / (incident.reports + 1.0D);
            }
            incident.reports++;
            incident.fireBlocks = Math.max(incident.fireBlocks, hazard.size());
            incident.lastSeen = now;
            incident.reporters.add(snapshot.droneId());
            if (incident.reports > 1 && !"cleared".equals(incident.lifecycle)) {
                incident.lifecycle = "validating";
            }
            return incident;
        }
    }

    private static Incident nearestIncident(String dimension, double x, double z) {
        Incident best = null;
        double bestDistance = CLUSTER_RADIUS * CLUSTER_RADIUS;
        for (Incident incident : INCIDENTS.values()) {
            if (!incident.dimension.equals(dimension) || "cleared".equals(incident.lifecycle)) continue;
            double dx = incident.x - x;
            double dz = incident.z - z;
            double distance = dx * dx + dz * dz;
            if (distance <= bestDistance) {
                best = incident;
                bestDistance = distance;
            }
        }
        return best;
    }

    private static void expireIncidents(long now) {
        INCIDENTS.entrySet().removeIf(entry -> now - entry.getValue().lastSeen > CLUSTER_TTL_MILLIS);
    }

    private static JsonObject incidentPayload(Incident incident) {
        JsonObject payload = new JsonObject();
        payload.addProperty("incident_id", incident.id);
        payload.addProperty("dimension", incident.dimension);
        payload.addProperty("lifecycle", incident.lifecycle);
        payload.addProperty("cluster_fire_blocks", incident.fireBlocks);
        payload.addProperty("cluster_reports", incident.reports);
        JsonObject location = new JsonObject();
        location.addProperty("x", incident.x);
        location.addProperty("y", incident.y);
        location.addProperty("z", incident.z);
        payload.add("location", location);
        return payload;
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

    private static final class Incident {
        private final String id;
        private final String dimension;
        private final Set<String> reporters = new HashSet<>();
        private double x;
        private int y;
        private double z;
        private int fireBlocks;
        private int reports;
        private long lastSeen;
        private String lifecycle = "detected";

        private Incident(String id, String dimension, int x, int y, int z, long now) {
            this.id = id;
            this.dimension = dimension;
            this.x = x;
            this.y = y;
            this.z = z;
            this.lastSeen = now;
        }
    }
}
