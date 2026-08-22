package dev.awsaf.firekeep.drone;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/** Non-blocking JSON delivery to the configured n8n Webhook URL. */
public final class N8nClient {
    private static final int QUEUE_DEPTH = 128;
    private static final int MAX_ATTEMPTS = 3;
    private static final long QUIET_MILLIS = 10_000L;
    private static final Gson GSON = new Gson();

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final BlockingQueue<String> outbox = new ArrayBlockingQueue<>(QUEUE_DEPTH);
    private final DroneConfig config;
    private volatile Thread pump;
    private volatile long quietUntil;
    private volatile boolean online;
    private volatile String lastError;

    public N8nClient(DroneConfig config) { this.config = config; }

    public void start() {
        stop();
        Thread thread = new Thread(this::run, "firekeep-n8n");
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

    /** Safe on the game and perception threads; oldest event is shed only if the queue is full. */
    public void send(JsonObject body) {
        if (!this.config.hasWebhook() || this.pump == null) return;
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
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(this.config.n8nWebhookUrl))
                        .header("Content-Type", "application/json")
                        .header("User-Agent", "firekeep-mod")
                        .timeout(Duration.ofSeconds(8))
                        .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
                if (!this.config.n8nAuthValue.isBlank()) request.header(this.config.n8nAuthHeader, this.config.n8nAuthValue);
                HttpResponse<Void> response = this.http.send(request.build(), HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() < 400) {
                    if (!this.online) Firekeep.LOGGER.info("n8n webhook reachable at {}", this.config.n8nWebhookUrl);
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
        if (this.online) Firekeep.LOGGER.warn("n8n webhook unreachable ({}), pausing for {}s", this.lastError, QUIET_MILLIS / 1000L);
        this.online = false;
        this.quietUntil = System.currentTimeMillis() + QUIET_MILLIS;
    }
}
