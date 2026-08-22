package dev.awsaf.firekeep.client.camera;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.awsaf.firekeep.Firekeep;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * Serves the drone feeds to the dashboard over plain HTTP.
 *
 * <pre>
 * GET /drones                  the live roster, as JSON
 * GET /drones/&lt;id&gt;/stream      that drone's camera as MJPEG, one long-lived response
 * GET /drones/&lt;id&gt;/frame.jpg   the newest single frame
 * </pre>
 *
 * <p>MJPEG rather than anything cleverer because the browser decodes it in a plain {@code <img>}:
 * no player library, no WebSocket framing, no base64 inflating every frame by a third. On a LAN a
 * 480p feed at 8 fps is well under a megabit.
 */
public final class CameraServer {
    private static final String BOUNDARY = "firekeepframe";
    /** How long a stream waits for a new frame before re-checking that the drone still exists. */
    private static final long FRAME_WAIT_MILLIS = 1_000L;

    private static HttpServer server;

    private CameraServer() {
    }

    public static void start() {
        if (server != null) {
            return;
        }
        try {
            HttpServer http = HttpServer.create(new InetSocketAddress(CameraConfig.PORT), 0);
            http.createContext("/drones", CameraServer::handle);
            http.setExecutor(Executors.newCachedThreadPool(runnable -> {
                Thread thread = new Thread(runnable, "firekeep-camera-http");
                thread.setDaemon(true);
                return thread;
            }));
            http.start();
            server = http;
            Firekeep.LOGGER.info("drone camera server listening on port {}", CameraConfig.PORT);
        } catch (IOException e) {
            Firekeep.LOGGER.error("could not start the drone camera server on port {}: {}",
                    CameraConfig.PORT, e.toString());
        }
    }

    public static boolean isRunning() {
        return server != null;
    }

    private static void handle(HttpExchange exchange) throws IOException {
        try {
            // The dashboard normally proxies this through Next, but allow a direct browser too.
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");

            String path = exchange.getRequestURI().getPath();
            if (!exchange.getRequestMethod().equals("GET")) {
                send(exchange, 405, "text/plain", "GET only".getBytes(StandardCharsets.UTF_8));
                return;
            }

            if (path.equals("/drones") || path.equals("/drones/")) {
                send(exchange, 200, "application/json", roster().getBytes(StandardCharsets.UTF_8));
                return;
            }

            String rest = path.substring("/drones/".length());
            int slash = rest.lastIndexOf('/');
            if (slash <= 0) {
                send(exchange, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
                return;
            }

            String id = rest.substring(0, slash);
            String action = rest.substring(slash + 1);
            DroneFeed feed = DroneFeeds.byId(id);
            if (feed == null) {
                send(exchange, 404, "text/plain", ("no drone " + id).getBytes(StandardCharsets.UTF_8));
                return;
            }

            switch (action) {
                case "stream" -> stream(exchange, feed);
                case "frame.jpg" -> snapshot(exchange, feed);
                default -> send(exchange, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            // A dashboard tab closing mid-frame is normal, not worth a stack trace.
            Firekeep.LOGGER.debug("camera request ended: {}", e.toString());
        } finally {
            exchange.close();
        }
    }

    private static String roster() {
        List<String> entries = new ArrayList<>();
        long now = System.currentTimeMillis();

        for (DroneFeed feed : DroneFeeds.feeds()) {
            DroneFeed.Frame frame = feed.latest();
            StringBuilder entry = new StringBuilder("{");
            entry.append("\"id\":\"").append(escape(feed.id())).append("\",");
            entry.append("\"entityId\":").append(feed.entityId()).append(',');
            entry.append("\"x\":").append(round(feed.x())).append(',');
            entry.append("\"y\":").append(round(feed.y())).append(',');
            entry.append("\"z\":").append(round(feed.z())).append(',');
            entry.append("\"yaw\":").append(round(feed.yaw())).append(',');
            entry.append("\"viewers\":").append(feed.subscribers()).append(',');
            entry.append("\"width\":").append(CameraConfig.WIDTH).append(',');
            entry.append("\"height\":").append(CameraConfig.HEIGHT).append(',');
            entry.append("\"fps\":").append(CameraConfig.FPS).append(',');
            entry.append("\"live\":").append(frame != null && now - frame.capturedAt() < 3_000L).append(',');
            entry.append("\"frames\":").append(frame == null ? 0 : frame.sequence());
            entry.append('}');
            entries.add(entry.toString());
        }

        return "{\"clientFps\":" + DroneFeeds.clientFps()
                + ",\"drones\":[" + String.join(",", entries) + "]}";
    }

    private static void snapshot(HttpExchange exchange, DroneFeed feed) throws IOException {
        feed.requestSnapshot();
        DroneFeed.Frame frame = feed.latest();
        if (frame == null) {
            // First look at a drone nobody was watching: give the renderer a moment to produce one.
            try {
                frame = feed.awaitFrame(0L, FRAME_WAIT_MILLIS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (frame == null) {
            send(exchange, 503, "text/plain", "no frame yet".getBytes(StandardCharsets.UTF_8));
            return;
        }
        send(exchange, 200, "image/jpeg", frame.jpeg());
    }

    private static void stream(HttpExchange exchange, DroneFeed feed) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "multipart/x-mixed-replace; boundary=" + BOUNDARY);
        exchange.getResponseHeaders().set("Connection", "close");
        exchange.sendResponseHeaders(200, 0);

        feed.addSubscriber();
        try (OutputStream out = exchange.getResponseBody()) {
            long seen = 0L;
            while (DroneFeeds.byId(feed.id()) == feed) {
                DroneFeed.Frame frame;
                try {
                    frame = feed.awaitFrame(seen, FRAME_WAIT_MILLIS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (frame == null) {
                    continue;               // still nothing; loop re-checks that the drone is alive
                }
                seen = frame.sequence();

                out.write(("--" + BOUNDARY + "\r\n"
                        + "Content-Type: image/jpeg\r\n"
                        + "Content-Length: " + frame.jpeg().length + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                out.write(frame.jpeg());
                out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } finally {
            feed.removeSubscriber();
        }
    }

    private static void send(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static String round(double value) {
        return String.format("%.2f", value);
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
