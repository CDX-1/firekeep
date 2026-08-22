package dev.awsaf.firekeep.drone;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.awsaf.firekeep.Firekeep;
import net.minecraft.world.phys.Vec3;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The HTTP face of the fleet - the only thing n8n ever talks to.
 *
 * <pre>
 * GET    /api/health
 * GET    /api/world
 * GET    /api/drones
 * POST   /api/drones                       spawn one
 * GET    /api/drones/{id}
 * DELETE /api/drones/{id}
 * GET    /api/drones/{id}/perception       ?fresh=true forces a scan
 * POST   /api/drones/{id}/command          ?wait=true blocks until the drone finishes
 * GET    /api/drones/{id}/command          what it is doing and how the last one ended
 * POST   /api/dispatch                     send the nearest free drone somewhere
 * GET    /api/events                       ?limit=50, the recent event log
 * </pre>
 *
 * <p>Every handler runs on the HTTP server's own pool and reads only the concurrent state
 * {@link DroneManager} publishes; anything that has to touch the game is queued and, if the caller
 * asked to wait, awaited with a timeout. Nothing here can stall a tick.
 *
 * <p>Bound to loopback by default and gated on a bearer token, because this is a remote control
 * for a running server, not a status page.
 */
public final class DroneApiServer {
    private static final Gson GSON = new Gson();
    private static final int MAX_BODY_BYTES = 64 * 1024;

    private static HttpServer server;
    private static volatile DroneConfig config;

    private DroneApiServer() {
    }

    public static void start(DroneConfig droneConfig) {
        stop();
        config = droneConfig;
        if (!droneConfig.apiEnabled) {
            Firekeep.LOGGER.info("drone API disabled in config");
            return;
        }

        try {
            HttpServer http = HttpServer.create(
                    new InetSocketAddress(droneConfig.apiHost, droneConfig.apiPort), 0);
            http.createContext("/api", DroneApiServer::route);
            http.setExecutor(Executors.newFixedThreadPool(4, runnable -> {
                Thread thread = new Thread(runnable, "firekeep-drone-api");
                thread.setDaemon(true);
                return thread;
            }));
            http.start();
            server = http;
            Firekeep.LOGGER.info("drone API listening on http://{}:{}/api (bearer token required)",
                    droneConfig.apiHost, droneConfig.apiPort);
        } catch (IOException e) {
            Firekeep.LOGGER.error("could not start the drone API on {}:{} - {}",
                    droneConfig.apiHost, droneConfig.apiPort, e.toString());
        }
    }

    public static void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    // ---------------------------------------------------------------- routing

    private static void route(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            Map<String, String> query = parseQuery(exchange.getRequestURI().getRawQuery());

            if ("OPTIONS".equals(method)) {
                respond(exchange, 204, null);
                return;
            }
            // Health is the one thing an unauthenticated probe may see, so a misconfigured token
            // still shows up as "reachable but rejected" rather than as a dead port.
            if (path.equals("/api/health")) {
                respond(exchange, 200, health());
                return;
            }
            if (!authorised(exchange)) {
                respond(exchange, 401, error("missing or invalid API key; send "
                        + "Authorization: Bearer <DRONE_API_KEY>"));
                return;
            }

            String[] parts = path.split("/");
            // "", "api", ...
            String head = parts.length > 2 ? parts[2] : "";

            switch (head) {
                case "world" -> requireGet(exchange, method, DroneManager::world);
                case "events" -> requireGet(exchange, method, () -> events(query));
                case "dispatch" -> {
                    if (!"POST".equals(method)) {
                        respond(exchange, 405, error("use POST"));
                        return;
                    }
                    respond(exchange, 200, dispatch(readBody(exchange)));
                }
                case "drones" -> drones(exchange, method, parts, query);
                default -> respond(exchange, 404, error("no such endpoint: " + path));
            }
        } catch (DroneCommandExecutor.RejectedException e) {
            respond(exchange, e.status(), error(e.getMessage()));
        } catch (IllegalArgumentException e) {
            respond(exchange, 400, error(e.getMessage()));
        } catch (Exception e) {
            Firekeep.LOGGER.error("drone API error", e);
            respond(exchange, 500, error(String.valueOf(e.getMessage())));
        } finally {
            exchange.close();
        }
    }

    private static void drones(HttpExchange exchange, String method, String[] parts,
                               Map<String, String> query) throws IOException {
        if (parts.length <= 3) {
            switch (method) {
                case "GET" -> respond(exchange, 200, roster());
                case "POST" -> respond(exchange, 201, spawn(readBody(exchange)));
                default -> respond(exchange, 405, error("use GET or POST"));
            }
            return;
        }

        String droneId = decode(parts[3]);
        String tail = parts.length > 4 ? parts[4] : "";

        if (tail.isEmpty()) {
            switch (method) {
                case "GET" -> {
                    DroneState state = DroneManager.state(droneId);
                    if (state == null) {
                        respond(exchange, 404, error("no drone called '" + droneId + "'"));
                        return;
                    }
                    respond(exchange, 200, state.toJson());
                }
                case "DELETE" -> {
                    boolean removed = await(DroneManager.remove(droneId), 5_000L);
                    respond(exchange, removed ? 200 : 404,
                            removed ? ok("removed " + droneId) : error("no drone called '" + droneId + "'"));
                }
                default -> respond(exchange, 405, error("use GET or DELETE"));
            }
            return;
        }

        if (DroneManager.state(droneId) == null) {
            respond(exchange, 404, error("no drone called '" + droneId + "'"));
            return;
        }

        switch (tail) {
            case "perception" -> {
                if (!"GET".equals(method)) {
                    respond(exchange, 405, error("use GET"));
                    return;
                }
                respond(exchange, 200, perception(droneId, query));
            }
            case "command" -> {
                switch (method) {
                    case "POST" -> respond(exchange, 200, command(droneId, readBody(exchange), query));
                    case "GET" -> respond(exchange, 200, commandStatus(droneId));
                    default -> respond(exchange, 405, error("use GET or POST"));
                }
            }
            default -> respond(exchange, 404, error("no such endpoint"));
        }
    }

    // ---------------------------------------------------------------- handlers

    private static JsonObject health() {
        JsonObject json = new JsonObject();
        json.addProperty("ok", true);
        json.addProperty("mod", Firekeep.MOD_ID);
        DroneConfig current = config;
        if (current != null) {
            json.addProperty("perception_radius", current.perceptionRadius);
            json.addProperty("perception_vertical_radius", current.perceptionVerticalRadius);
            json.addProperty("webhook_configured", current.hasWebhook());
        }
        N8nClient client = DroneManager.n8n();
        if (client != null) {
            json.addProperty("webhook_online", client.isOnline());
            if (client.lastError() != null) {
                json.addProperty("webhook_error", client.lastError());
            }
        }
        json.addProperty("drones", DroneManager.roster().size());
        return json;
    }

    private static JsonObject roster() {
        JsonArray array = new JsonArray();
        for (DroneState state : DroneManager.roster()) {
            array.add(state.toJson());
        }
        JsonObject json = new JsonObject();
        json.add("drones", array);
        json.addProperty("count", array.size());
        return json;
    }

    private static JsonObject spawn(JsonObject body) throws IOException {
        double x = required(body, "x");
        double y = required(body, "y");
        double z = required(body, "z");
        String id = body.has("id") ? body.get("id").getAsString() : null;
        String dimension = body.has("dimension") ? body.get("dimension").getAsString() : null;
        float yaw = body.has("yaw") ? body.get("yaw").getAsFloat() : 0.0F;

        DroneState state = await(DroneManager.spawn(id, new Vec3(x, y, z), dimension, yaw), 10_000L);
        if (state == null) {
            throw new IllegalStateException("the drone was created but has not been indexed yet");
        }
        return state.toJson();
    }

    private static JsonObject perception(String droneId, Map<String, String> query) throws IOException {
        boolean fresh = flag(query, "fresh");
        PerceptionSnapshot snapshot = fresh
                ? await(DroneManager.refreshPerception(droneId), 5_000L)
                : DroneManager.perception(droneId);

        if (snapshot == null) {
            // The periodic scan has simply not come round yet; ask for one rather than 404ing.
            snapshot = await(DroneManager.refreshPerception(droneId), 5_000L);
        }
        return snapshot.toJson();
    }

    /**
     * Accepts an order.
     *
     * <p>Asynchronous by default, which is what a flow that fans out to several drones wants, and
     * synchronous on {@code ?wait=true}, which is what a flow that wants to reason about the
     * outcome wants. The waiting version is safe because the wait happens on an HTTP pool thread.
     */
    private static JsonObject command(String droneId, JsonObject body, Map<String, String> query) {
        DroneCommand command = DroneCommandExecutor.submit(droneId, body);

        boolean wait = flag(query, "wait") || (body.has("await") && body.get("await").getAsBoolean());
        if (!wait) {
            JsonObject json = CommandResult.accepted(command).toJson();
            json.addProperty("status", "queued");
            return json;
        }
        return DroneCommandExecutor.await(command, DroneCommandExecutor.timeoutFrom(body)).toJson();
    }

    private static JsonObject commandStatus(String droneId) {
        DroneState state = DroneManager.state(droneId);
        JsonObject json = new JsonObject();
        json.addProperty("drone_id", droneId);
        json.addProperty("status", state == null ? "unknown" : state.status().label());
        if (state != null && state.activeCommand() != null) {
            json.addProperty("active_command", state.activeCommand());
            json.addProperty("active_command_id", state.activeCommandId());
            json.addProperty("waypoints_remaining", state.waypointsRemaining());
        }
        // How the last one ended, so a caller that did not wait can still find out.
        if (state != null && state.lastResult() != null) {
            json.add("last_result", state.lastResult().toJson());
        }
        return json;
    }

    private static JsonObject dispatch(JsonObject body) {
        double x = required(body, "x");
        double y = required(body, "y");
        double z = required(body, "z");
        String dimension = body.has("dimension") ? body.get("dimension").getAsString() : null;

        JsonObject order = body.has("command") && body.get("command").isJsonObject()
                ? body.getAsJsonObject("command")
                : null;
        if (order == null) {
            order = new JsonObject();
            order.addProperty("command", "move_to");
            order.addProperty("x", x);
            order.addProperty("y", y);
            order.addProperty("z", z);
        }

        DroneManager.DispatchResult result = DroneManager.dispatch(new Vec3(x, y, z), dimension, order);
        JsonObject json = new JsonObject();
        if (result.drone() == null) {
            json.addProperty("dispatched", false);
            json.addProperty("message", "no drone is available"
                    + (dimension == null ? "" : " in " + dimension));
            return json;
        }
        json.addProperty("dispatched", true);
        json.addProperty("drone_id", result.drone().id());
        json.addProperty("distance", PerceptionSnapshot.round(result.distance()));
        json.addProperty("command_id", result.command().id());
        json.add("drone", result.drone().toJson());
        return json;
    }

    private static JsonObject events(Map<String, String> query) {
        int limit = 50;
        String raw = query.get("limit");
        if (raw != null) {
            try {
                limit = Math.max(1, Math.min(256, Integer.parseInt(raw)));
            } catch (NumberFormatException ignored) {
                // a nonsense limit is not worth failing the request over
            }
        }

        List<DroneEvent> recent = DroneEvents.recent(limit);
        JsonArray array = new JsonArray();
        for (DroneEvent event : recent) {
            array.add(event.toJson());
        }
        JsonObject json = new JsonObject();
        json.add("events", array);
        json.addProperty("count", array.size());
        return json;
    }

    // ---------------------------------------------------------------- plumbing

    private interface Producer {
        JsonObject get();
    }

    private static void requireGet(HttpExchange exchange, String method, Producer producer) throws IOException {
        if (!"GET".equals(method)) {
            respond(exchange, 405, error("use GET"));
            return;
        }
        respond(exchange, 200, producer.get());
    }

    private static boolean authorised(HttpExchange exchange) {
        DroneConfig current = config;
        if (current == null || current.apiKey.isBlank()) {
            return true;                              // no key configured means no gate
        }
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        if (header != null && header.regionMatches(true, 0, "Bearer ", 0, 7)
                && constantTimeEquals(header.substring(7).trim(), current.apiKey)) {
            return true;
        }
        String key = exchange.getRequestHeaders().getFirst("X-API-Key");
        return key != null && constantTimeEquals(key.trim(), current.apiKey);
    }

    /** Compares without leaking the answer through how long it took. */
    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) {
            return false;
        }
        int difference = 0;
        for (int i = 0; i < a.length(); i++) {
            difference |= a.charAt(i) ^ b.charAt(i);
        }
        return difference == 0;
    }

    private static JsonObject readBody(HttpExchange exchange) throws IOException {
        byte[] bytes = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES);
        if (bytes.length == 0) {
            return new JsonObject();
        }
        try {
            return JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("body must be a JSON object");
        }
    }

    private static <T> T await(CompletableFuture<T> future, long millis) throws IOException {
        try {
            return future.get(millis, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw new IllegalStateException("the server did not respond within " + millis + "ms");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof IllegalArgumentException argument) {
                throw argument;
            }
            throw new IllegalStateException(cause == null ? e.toString() : cause.getMessage());
        }
    }

    private static double required(JsonObject body, String key) {
        if (!body.has(key)) {
            throw new IllegalArgumentException("missing \"" + key + "\"");
        }
        try {
            return body.get(key).getAsDouble();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("\"" + key + "\" must be a number");
        }
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> query = new HashMap<>();
        if (raw == null || raw.isEmpty()) {
            return query;
        }
        for (String pair : raw.split("&")) {
            int equals = pair.indexOf('=');
            if (equals < 0) {
                query.put(decode(pair), "true");
            } else {
                query.put(decode(pair.substring(0, equals)), decode(pair.substring(equals + 1)));
            }
        }
        return query;
    }

    private static boolean flag(Map<String, String> query, String key) {
        String value = query.get(key);
        return value != null && !value.equalsIgnoreCase("false") && !value.equals("0");
    }

    private static String decode(String raw) {
        return java.net.URLDecoder.decode(raw, StandardCharsets.UTF_8);
    }

    private static JsonObject error(String message) {
        JsonObject json = new JsonObject();
        json.addProperty("ok", false);
        json.addProperty("error", message == null ? "unknown error" : message);
        return json;
    }

    private static JsonObject ok(String message) {
        JsonObject json = new JsonObject();
        json.addProperty("ok", true);
        json.addProperty("message", message);
        return json;
    }

    private static void respond(HttpExchange exchange, int status, JsonObject body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

        if (body == null) {
            exchange.sendResponseHeaders(status, -1);
            return;
        }
        byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
