package dev.awsaf.firekeep.agent;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.awsaf.firekeep.Firekeep;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * Tells the dashboard which agent is filming which drone, and on what port.
 *
 * <p>Each agent serves only its own drone, on its own port, so with a fleet running there is no
 * single address the dashboard can ask for the whole roster. The server is the one process that
 * knows the whole mapping, so it publishes it here and the dashboard fans out from it.
 *
 * <pre>
 * GET /agents   {"host":"127.0.0.1","agents":[{"droneId":"alpha","port":8088,"running":true}]}
 * </pre>
 */
public final class AgentDirectoryServer {
    private static final int PORT = intValue("firekeep.agents.port", "FIREKEEP_AGENTS_PORT", 8087);
    /** The address the dashboard should use to reach the agents; they run beside this server. */
    private static final String HOST = stringValue("firekeep.agents.host", "FIREKEEP_AGENTS_HOST", "127.0.0.1");

    private static HttpServer server;

    private AgentDirectoryServer() {
    }

    public static void initialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(minecraftServer -> start());
        ServerLifecycleEvents.SERVER_STOPPING.register(minecraftServer -> stop());
    }

    private static void start() {
        if (server != null) {
            return;
        }
        try {
            HttpServer http = HttpServer.create(new InetSocketAddress(PORT), 0);
            http.createContext("/agents", AgentDirectoryServer::handle);
            http.setExecutor(Executors.newCachedThreadPool(runnable -> {
                Thread thread = new Thread(runnable, "firekeep-agent-directory");
                thread.setDaemon(true);
                return thread;
            }));
            http.start();
            server = http;
            Firekeep.LOGGER.info("agent directory listening on port {}", PORT);
        } catch (IOException e) {
            Firekeep.LOGGER.error("could not start the agent directory on port {}: {}", PORT, e.toString());
        }
    }

    private static void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    private static void handle(HttpExchange exchange) throws IOException {
        try {
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");

            byte[] body = directory().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        } finally {
            exchange.close();
        }
    }

    private static String directory() {
        List<String> entries = new ArrayList<>();
        for (AgentSupervisor.AgentInfo agent : AgentSupervisor.directory()) {
            entries.add("{\"droneId\":\"" + escape(agent.droneId()) + "\","
                    + "\"port\":" + agent.port() + ","
                    + "\"running\":" + agent.running() + "}");
        }
        return "{\"host\":\"" + escape(HOST) + "\",\"agents\":[" + String.join(",", entries) + "]}";
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static int intValue(String property, String environment, int fallback) {
        String raw = stringValue(property, environment, null);
        if (raw == null) {
            return fallback;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String stringValue(String property, String environment, String fallback) {
        String value = System.getProperty(property);
        if (value != null && !value.isBlank()) {
            return value;
        }
        value = System.getenv(environment);
        return value == null || value.isBlank() ? fallback : value;
    }
}
