package dev.awsaf.firekeep.client.capture;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The mod's half of the conversation with the python capture server (python/server.py).
 *
 * <p>Every call here blocks, so nothing in this class may be touched from the render thread.
 */
public final class CaptureClient {
    public static final String DEFAULT_URL = "http://127.0.0.1:8000";
    /** Where the server URL can be overridden without recompiling. */
    private static final String URL_ENV = "FIREKEEP_SERVER";
    private static final String URL_PROPERTY = "firekeep.server";

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private static volatile String baseUrl = defaultUrl();

    private CaptureClient() {
    }

    public static String baseUrl() {
        return baseUrl;
    }

    /** @throws IllegalArgumentException if the URL is not something we can POST to */
    public static void setBaseUrl(String url) {
        baseUrl = normalize(url);
    }

    private static String defaultUrl() {
        String configured = System.getProperty(URL_PROPERTY, System.getenv(URL_ENV));
        try {
            return configured == null || configured.isBlank() ? DEFAULT_URL : normalize(configured);
        } catch (IllegalArgumentException e) {
            return DEFAULT_URL;
        }
    }

    private static String normalize(String url) {
        String trimmed = url.trim();
        if (!trimmed.contains("://")) {
            trimmed = "http://" + trimmed;
        }
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        try {
            URI uri = new URI(trimmed);
            if (uri.getHost() == null || !uri.getScheme().startsWith("http")) {
                throw new IllegalArgumentException("not an http(s) URL: " + url);
            }
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("not a URL: " + url, e);
        }
        return trimmed;
    }

    /** {@code GET /api/health} - {ok, credits, queued, busy, model, dry_run}. */
    public static JsonObject health() throws IOException {
        return getJson("/api/health");
    }

    /** {@code GET /api/jobs/<id>} - the job record, plus the Marble payload once it is done. */
    public static JsonObject job(String jobId) throws IOException {
        return getJson("/api/jobs/" + URLEncoder.encode(jobId, StandardCharsets.UTF_8));
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

        HttpRequest request = HttpRequest.newBuilder(uri(path))
                .header("Content-Type", "image/png")
                .header("X-Source", "firekeep-mod")
                .timeout(Duration.ofSeconds(60))
                .POST(HttpRequest.BodyPublishers.ofByteArray(png))
                .build();

        JsonObject body = send(request);
        JsonElement id = body.get("job_id");
        if (id == null || id.isJsonNull()) {
            throw new IOException("the server accepted the capture but returned no job id");
        }
        return id.getAsString();
    }

    private static JsonObject getJson(String path) throws IOException {
        return send(HttpRequest.newBuilder(uri(path))
                .timeout(Duration.ofSeconds(20))
                .GET()
                .build());
    }

    private static JsonObject send(HttpRequest request) throws IOException {
        HttpResponse<String> response;
        try {
            response = HTTP.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted talking to " + baseUrl, e);
        } catch (IOException e) {
            throw new IOException("cannot reach the capture server at " + baseUrl
                    + " (" + e.getMessage() + ")", e);
        }

        JsonObject body = parse(response.body());
        if (response.statusCode() >= 400) {
            String error = body != null && body.has("error")
                    ? body.get("error").getAsString()
                    : "HTTP " + response.statusCode();
            throw new IOException(error);
        }
        if (body == null) {
            throw new IOException("the server did not return JSON");
        }
        return body;
    }

    private static JsonObject parse(String body) {
        try {
            JsonElement parsed = JsonParser.parseString(body);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static URI uri(String path) {
        return URI.create(baseUrl + path);
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
