package dev.awsaf.firekeep.drone;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;

/**
 * Everything the drone bridge needs to know about the outside world, read from
 * {@code config/firekeep-drones.json} and overridable per-run by environment variables.
 *
 * <p>Nothing here is hardcoded at a call site: the API port, the n8n URLs, the shared secret and
 * the perception radii all come through this object. A missing file is written back as a
 * fully-populated template, with a freshly generated API key, so a first run leaves something
 * usable on disk rather than an empty stub.
 *
 * <p>Environment variables win over the file, because that is how you point one build at a
 * different n8n without editing anything:
 * {@code N8N_BASE_URL}, {@code N8N_WEBHOOK_URL}, {@code DRONE_API_KEY},
 * {@code DRONE_API_PORT}, {@code PERCEPTION_RADIUS}, {@code PERCEPTION_VERTICAL_RADIUS}.
 */
public final class DroneConfig {
    private static final String FILE_NAME = "firekeep-drones.json";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    // ---- api
    public final boolean apiEnabled;
    public final String apiHost;
    public final int apiPort;
    public final String apiKey;

    // ---- n8n
    public final String n8nBaseUrl;
    public final String n8nWebhookUrl;
    /** Header n8n expects on inbound webhooks, so the flow can reject anything else. */
    public final String n8nAuthHeader;
    public final String n8nAuthValue;
    public final boolean pushPerception;
    public final int perceptionPushIntervalSeconds;
    public final boolean eventsEnabled;

    // ---- perception
    public final int perceptionRadius;
    public final int perceptionVerticalRadius;
    /** How often a drone's cached perception is refreshed, in server ticks. */
    public final int perceptionIntervalTicks;
    public final int entityRadius;
    /** Cap on obstacles/hazards/resources reported per snapshot; the AI wants a shortlist. */
    public final int maxFeatures;
    public final boolean includeMap;
    /** A direction counts as open when nothing blocks it for at least this many blocks. */
    public final int openClearance;

    // ---- flight
    public final double maxSpeedBlocksPerSecond;
    public final double arrivalRadius;
    public final int stuckTicks;
    public final int maxReplans;
    public final int pathNodeBudget;
    public final int pathSearchRadius;
    /** Blocks of margin kept between a planned path and any fire or lava. */
    public final int hazardClearance;
    /** Height above ground a drone climbs to before crossing open terrain. */
    public final int cruiseAltitude;

    // ---- actions
    public final int waterRadius;
    /** Whether {@code dispense_water} also leaves a water source block behind. */
    public final boolean placeWaterSource;
    public final int fireEventCooldownSeconds;
    /** Fire cells in one cluster before it is reported as a disaster rather than a spark. */
    public final int disasterFireCells;

    private DroneConfig(JsonObject root) {
        JsonObject api = child(root, "api");
        this.apiEnabled = bool(api, "enabled", true);
        this.apiHost = string(api, "host", "127.0.0.1");
        this.apiPort = envInt("DRONE_API_PORT", "firekeep.drone.api.port", integer(api, "port", 8090));
        this.apiKey = envString("DRONE_API_KEY", "firekeep.drone.api.key", string(api, "apiKey", ""));

        JsonObject n8n = child(root, "n8n");
        this.n8nBaseUrl = trimSlash(envString("N8N_BASE_URL", "firekeep.n8n.baseUrl",
                string(n8n, "baseUrl", "http://127.0.0.1:5678")));
        this.n8nWebhookUrl = envString("N8N_WEBHOOK_URL", "firekeep.n8n.webhookUrl",
                string(n8n, "webhookUrl", ""));
        this.n8nAuthHeader = string(n8n, "authHeader", "X-Firekeep-Key");
        this.n8nAuthValue = envString("N8N_WEBHOOK_KEY", "firekeep.n8n.webhookKey",
                string(n8n, "authValue", ""));
        this.pushPerception = bool(n8n, "pushPerception", false);
        this.perceptionPushIntervalSeconds = clamp(integer(n8n, "perceptionPushIntervalSeconds", 5), 1, 3600);
        this.eventsEnabled = bool(n8n, "events", true);

        JsonObject perception = child(root, "perception");
        this.perceptionRadius = clamp(envInt("PERCEPTION_RADIUS", "firekeep.perception.radius",
                integer(perception, "radius", 10)), 2, 32);
        this.perceptionVerticalRadius = clamp(envInt("PERCEPTION_VERTICAL_RADIUS",
                "firekeep.perception.verticalRadius", integer(perception, "verticalRadius", 5)), 1, 32);
        this.perceptionIntervalTicks = clamp(integer(perception, "intervalTicks", 20), 2, 1200);
        this.entityRadius = clamp(integer(perception, "entityRadius", 24), 4, 128);
        this.maxFeatures = clamp(integer(perception, "maxFeatures", 6), 1, 32);
        this.includeMap = bool(perception, "includeMap", true);
        this.openClearance = clamp(integer(perception, "openClearance", 4), 1, 32);

        JsonObject flight = child(root, "flight");
        this.maxSpeedBlocksPerSecond = clampDouble(number(flight, "maxSpeedBlocksPerSecond", 8.0D), 0.5D, 60.0D);
        this.arrivalRadius = clampDouble(number(flight, "arrivalRadius", 0.5D), 0.15D, 8.0D);
        this.stuckTicks = clamp(integer(flight, "stuckTicks", 60), 10, 1200);
        this.maxReplans = clamp(integer(flight, "maxReplans", 3), 0, 20);
        this.pathNodeBudget = clamp(integer(flight, "pathNodeBudget", 4000), 200, 60_000);
        this.pathSearchRadius = clamp(integer(flight, "pathSearchRadius", 48), 8, 192);
        this.hazardClearance = clamp(integer(flight, "hazardClearance", 2), 0, 8);
        this.cruiseAltitude = clamp(integer(flight, "cruiseAltitude", 4), 0, 64);

        JsonObject actions = child(root, "actions");
        this.waterRadius = clamp(integer(actions, "waterRadius", 3), 1, 16);
        this.placeWaterSource = bool(actions, "placeWaterSource", false);
        this.fireEventCooldownSeconds = clamp(integer(actions, "fireEventCooldownSeconds", 60), 1, 3600);
        this.disasterFireCells = clamp(integer(actions, "disasterFireCells", 12), 1, 4096);
    }

    /** Blocks per tick, which is the unit {@link dev.awsaf.firekeep.entity.DroneEntity} thinks in. */
    public double maxSpeedPerTick() {
        return this.maxSpeedBlocksPerSecond / 20.0D;
    }

    public boolean hasWebhook() {
        return this.eventsEnabled && !this.n8nWebhookUrl.isBlank();
    }

    // ---------------------------------------------------------------- loading

    public static DroneConfig load() {
        Path path = FabricLoader.getInstance().getConfigDir().resolve(FILE_NAME);
        JsonObject root = null;
        if (Files.exists(path)) {
            try {
                root = GSON.fromJson(Files.readString(path, StandardCharsets.UTF_8), JsonObject.class);
            } catch (Exception e) {
                Firekeep.LOGGER.error("could not read {}, using defaults: {}", FILE_NAME, e.toString());
            }
        }

        boolean fresh = root == null;
        if (fresh) {
            root = new JsonObject();
        }

        DroneConfig config = new DroneConfig(root);
        if (config.apiKey.isBlank()) {
            // An open control API on a machine that also runs n8n is not something to leave to
            // chance, so mint a key rather than defaulting to "no auth".
            config = new DroneConfig(withGeneratedKey(root));
            fresh = true;
        }
        if (fresh) {
            write(path, config);
        }
        return config;
    }

    private static JsonObject withGeneratedKey(JsonObject root) {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        child(root, "api").addProperty("apiKey", HexFormat.of().formatHex(bytes));
        return root;
    }

    /** Writes the config back out fully expanded, so every knob is visible and editable. */
    private static void write(Path path, DroneConfig c) {
        JsonObject root = new JsonObject();
        root.addProperty("_comment", "Fire Keep drone bridge. Environment overrides: N8N_BASE_URL, "
                + "N8N_WEBHOOK_URL, DRONE_API_KEY, DRONE_API_PORT, PERCEPTION_RADIUS, "
                + "PERCEPTION_VERTICAL_RADIUS.");

        JsonObject api = new JsonObject();
        api.addProperty("enabled", c.apiEnabled);
        api.addProperty("host", c.apiHost);
        api.addProperty("port", c.apiPort);
        api.addProperty("apiKey", c.apiKey);
        root.add("api", api);

        JsonObject n8n = new JsonObject();
        n8n.addProperty("baseUrl", c.n8nBaseUrl);
        n8n.addProperty("webhookUrl", c.n8nWebhookUrl);
        n8n.addProperty("authHeader", c.n8nAuthHeader);
        n8n.addProperty("authValue", c.n8nAuthValue);
        n8n.addProperty("events", c.eventsEnabled);
        n8n.addProperty("pushPerception", c.pushPerception);
        n8n.addProperty("perceptionPushIntervalSeconds", c.perceptionPushIntervalSeconds);
        root.add("n8n", n8n);

        JsonObject perception = new JsonObject();
        perception.addProperty("radius", c.perceptionRadius);
        perception.addProperty("verticalRadius", c.perceptionVerticalRadius);
        perception.addProperty("intervalTicks", c.perceptionIntervalTicks);
        perception.addProperty("entityRadius", c.entityRadius);
        perception.addProperty("maxFeatures", c.maxFeatures);
        perception.addProperty("includeMap", c.includeMap);
        perception.addProperty("openClearance", c.openClearance);
        root.add("perception", perception);

        JsonObject flight = new JsonObject();
        flight.addProperty("maxSpeedBlocksPerSecond", c.maxSpeedBlocksPerSecond);
        flight.addProperty("arrivalRadius", c.arrivalRadius);
        flight.addProperty("stuckTicks", c.stuckTicks);
        flight.addProperty("maxReplans", c.maxReplans);
        flight.addProperty("pathNodeBudget", c.pathNodeBudget);
        flight.addProperty("pathSearchRadius", c.pathSearchRadius);
        flight.addProperty("hazardClearance", c.hazardClearance);
        flight.addProperty("cruiseAltitude", c.cruiseAltitude);
        root.add("flight", flight);

        JsonObject actions = new JsonObject();
        actions.addProperty("waterRadius", c.waterRadius);
        actions.addProperty("placeWaterSource", c.placeWaterSource);
        actions.addProperty("fireEventCooldownSeconds", c.fireEventCooldownSeconds);
        actions.addProperty("disasterFireCells", c.disasterFireCells);
        root.add("actions", actions);

        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, GSON.toJson(root), StandardCharsets.UTF_8);
            Firekeep.LOGGER.info("wrote drone config to {}", path);
        } catch (IOException e) {
            Firekeep.LOGGER.error("could not write {}: {}", FILE_NAME, e.toString());
        }
    }

    // ---------------------------------------------------------------- readers

    private static JsonObject child(JsonObject root, String key) {
        if (root.has(key) && root.get(key).isJsonObject()) {
            return root.getAsJsonObject(key);
        }
        JsonObject created = new JsonObject();
        root.add(key, created);
        return created;
    }

    private static boolean bool(JsonObject json, String key, boolean fallback) {
        try {
            return json.has(key) ? json.get(key).getAsBoolean() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static int integer(JsonObject json, String key, int fallback) {
        try {
            return json.has(key) ? json.get(key).getAsInt() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static double number(JsonObject json, String key, double fallback) {
        try {
            return json.has(key) ? json.get(key).getAsDouble() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static String string(JsonObject json, String key, String fallback) {
        try {
            return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static String envString(String environment, String property, String fallback) {
        String value = System.getProperty(property);
        if (value == null || value.isBlank()) {
            value = System.getenv(environment);
        }
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static int envInt(String environment, String property, int fallback) {
        String raw = envString(environment, property, null);
        if (raw == null) {
            return fallback;
        }
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String trimSlash(String url) {
        String out = url.trim();
        while (out.endsWith("/")) {
            out = out.substring(0, out.length() - 1);
        }
        return out;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double clampDouble(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }
}
