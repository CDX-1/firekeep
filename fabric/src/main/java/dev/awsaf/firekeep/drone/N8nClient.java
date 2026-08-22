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

/**
 * Fire-and-forget delivery of events and perception to an n8n webhook.
 *
 * <p>One daemon thread and a bounded queue, deliberately. Nothing on the server thread may ever
 * wait on n8n - an unreachable webhook has to cost a dropped message, never a tick - so the queue
 * drops its oldest entry when it fills rather than blocking the producer.
 *
 * <p>Delivery is at-most-once with a short retry. Anything that genuinely must not be lost should
 * be pulled from {@code GET /api/events} instead of pushed here.
 */
public final class N8nClient {
    private static final int QUEUE_DEPTH = 128;
    private static final int MAX_ATTEMPTS = 3;
    /** How long to stop trying after a failure, so a dead webhook is not retried every message. */
    private static final long QUIET_MILLIS = 10_000L;

    private static final Gson GSON = new Gson();

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final BlockingQueue<Envelope> outbox = new ArrayBlockingQueue<>(QUEUE_DEPTH);

    private final DroneConfig config;
    private volatile Thread pump;
    private volatile long quietUntil;
    private volatile boolean online;
    private volatile String lastError;

    private record Envelope(String url, String json) {
    }

    public N8nClient(DroneConfig config) {
        this.config = config;
    }

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
        if (thread != null) {
            thread.interrupt();
        }
        this.outbox.clear();
    }

    public boolean isOnline() {
        return this.online;
    }

    public String lastError() {
        return this.lastError;
    }

    /** Queues {@code body} for the configured webhook. Safe to call from the server thread. */
    public void send(JsonObject body) {
        send(this.config.n8nWebhookUrl, body);
    }

    public void send(String url, JsonObject body) {
        if (url == null || url.isBlank() || this.pump == null) {
            return;
        }
        Envelope envelope = new Envelope(url, GSON.toJson(body));
        // Newer state is more useful than older state, so shed from the front under pressure.
        while (!this.outbox.offer(envelope)) {
            this.outbox.poll();
        }
    }

    private void run() {
        Thread self = Thread.currentThread();
        while (this.pump == self && !self.isInterrupted()) {
            Envelope envelope;
            try {
                envelope = this.outbox.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                self.interrupt();
                return;
            }
            if (envelope == null) {
                continue;
            }
            if (System.currentTimeMillis() < this.quietUntil) {
                continue;                          // still cooling off from the last failure
            }
            deliver(envelope);
        }
    }

    private void deliver(Envelope envelope) {
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(envelope.url()))
                        .header("Content-Type", "application/json")
                        .header("User-Agent", "firekeep-mod")
                        .timeout(Duration.ofSeconds(8))
                        .POST(HttpRequest.BodyPublishers.ofString(envelope.json(), StandardCharsets.UTF_8));
                if (!this.config.n8nAuthValue.isBlank()) {
                    request.header(this.config.n8nAuthHeader, this.config.n8nAuthValue);
                }

                HttpResponse<Void> response = this.http.send(request.build(), HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() < 400) {
                    if (!this.online) {
                        Firekeep.LOGGER.info("n8n webhook reachable at {}", envelope.url());
                    }
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

            try {
                Thread.sleep(250L * attempt);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }

        if (this.online) {
            Firekeep.LOGGER.warn("n8n webhook unreachable ({}), pausing for {}s",
                    this.lastError, QUIET_MILLIS / 1000L);
        }
        this.online = false;
        this.quietUntil = System.currentTimeMillis() + QUIET_MILLIS;
    }
}
