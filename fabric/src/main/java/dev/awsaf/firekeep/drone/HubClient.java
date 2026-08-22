package dev.awsaf.firekeep.drone;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.net.FirekeepServer;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Non-blocking JSON delivery to the Fire Keep hub - the python server at
 * {@link FirekeepServer#baseUrl()}, which is the only thing outside this process the mod
 * knows how to reach.
 *
 * <p>This used to POST straight at an n8n webhook, which meant a Minecraft config file held
 * somebody else's URL and shared secret, and a workflow that moved needed the server
 * restarted. The hub owns all of that now: the mod says what happened, once, to one address,
 * and the hub decides who else should hear about it.
 *
 * <p>The delivery guarantees are unchanged and deliberately weak. Events go onto a bounded
 * queue and out on a daemon thread, a run of failures buys a quiet period, and a full queue
 * sheds its oldest entry - because the newest report of a fire is the one worth having, and
 * <b>an unreachable hub must never cost a tick</b>.
 */
public final class HubClient {
    private static final int QUEUE_DEPTH = 128;
    private static final int MAX_ATTEMPTS = 3;
    private static final long QUIET_MILLIS = 10_000L;
    private static final Gson GSON = new Gson();

    /** Where the hub takes what Minecraft has to say. */
    public static final String EVENTS_PATH = "/api/mod/events";

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final BlockingQueue<String> outbox = new ArrayBlockingQueue<>(QUEUE_DEPTH);
    private final DroneConfig config;
    private volatile Thread pump;
    private volatile long quietUntil;
    private volatile boolean online;
    private volatile String lastError;

    public HubClient(DroneConfig config) { this.config = config; }

    public void start() {
        stop();
        Thread thread = new Thread(this::run, "firekeep-hub");
        thread.setDaemon(true);
        this.pump = thread;
        thread.start();
    }

    public void stop() {
        Thread thread = this.pump;
        this.pump = null;
        if (thread != null) thread.interrupt();
        this.outbox.clear();
    }

    public boolean isOnline() { return this.online; }
    public String lastError() { return this.lastError; }

    /** Where events are being sent, for the health endpoint and the startup log. */
    public String endpoint() { return this.config.hubUrl() + EVENTS_PATH; }

    /** Safe on the game and perception threads; oldest event is shed only if the queue is full. */
    public void send(JsonObject body) {
        if (!this.config.eventsEnabled || this.pump == null) return;
        String json = GSON.toJson(body);
        while (!this.outbox.offer(json)) this.outbox.poll();
    }

    private void run() {
        Thread self = Thread.currentThread();
        while (this.pump == self && !self.isInterrupted()) {
            try {
                String json = this.outbox.poll(1, TimeUnit.SECONDS);
                if (json == null || System.currentTimeMillis() < this.quietUntil) continue;
                deliver(json);
            } catch (InterruptedException e) {
                self.interrupt();
                return;
            }
        }
    }

    private void deliver(String json) {
        String url = endpoint();
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url))
                        .header("Content-Type", "application/json")
                        .header("User-Agent", "firekeep-mod")
                        .header("X-Source", "minecraft")
                        .timeout(Duration.ofSeconds(8))
                        .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
                // The hub only asks for a key when it is exposed; on a laptop it is blank.
                if (!this.config.hubKey.isBlank()) {
                    request.header("Authorization", "Bearer " + this.config.hubKey);
                }
                HttpResponse<Void> response = this.http.send(request.build(), HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() < 400) {
                    if (!this.online) Firekeep.LOGGER.info("hub reachable at {}", url);
                    this.online = true;
                    this.lastError = null;
                    return;
                }
                this.lastError = "HTTP " + response.statusCode();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                this.lastError = e.getMessage();
            }
            try { Thread.sleep(250L * attempt); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
        if (this.online) Firekeep.LOGGER.warn("hub unreachable ({}), pausing for {}s", this.lastError, QUIET_MILLIS / 1000L);
        this.online = false;
        this.quietUntil = System.currentTimeMillis() + QUIET_MILLIS;
    }
}
