package dev.awsaf.firekeep.client.capture;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.net.FirekeepServer;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The mod's half of the conversation with the python capture server (python/server.py).
 *
 * <p>The URL and the HTTP plumbing live in {@link FirekeepServer}, which the server-side world
 * feed shares. Every call here blocks, so nothing in this class may be touched from the render
 * thread.
 */
public final class CaptureClient {
    public static final String DEFAULT_URL = FirekeepServer.DEFAULT_URL;

    private CaptureClient() {
    }

    public static String baseUrl() {
        return FirekeepServer.baseUrl();
    }

    /** @throws IllegalArgumentException if the URL is not something we can POST to */
    public static void setBaseUrl(String url) {
        FirekeepServer.setBaseUrl(url);
    }

    /** {@code GET /api/health} - {ok, credits, queued, busy, model, dry_run}. */
    public static JsonObject health() throws IOException {
        return FirekeepServer.get("/api/health", Duration.ofSeconds(20));
    }

    /** {@code GET /api/jobs/<id>} - the job record, plus the Marble payload once it is done. */
    public static JsonObject job(String jobId) throws IOException {
        return FirekeepServer.get("/api/jobs/" + encode(jobId), Duration.ofSeconds(20));
    }

    /**
     * {@code POST /capture} with the raw PNG body. Returns the queued job id.
     *
     * @param prompt style guidance, or null to use the server's default
     * @param model  Marble model, or null to use the server's default
     */
    public static String submit(byte[] png, String prompt, String model) throws IOException {
        List<String> query = new ArrayList<>();
        if (prompt != null && !prompt.isBlank()) {
            query.add("prompt=" + encode(prompt));
        }
        if (model != null && !model.isBlank()) {
            query.add("model=" + encode(model));
        }
        String path = query.isEmpty() ? "/capture" : "/capture?" + String.join("&", query);

        JsonObject body = FirekeepServer.post(path, "image/png", png, "firekeep-mod",
                Duration.ofSeconds(60));
        JsonElement id = body.get("job_id");
        if (id == null || id.isJsonNull()) {
            throw new IOException("the server accepted the capture but returned no job id");
        }
        return id.getAsString();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
