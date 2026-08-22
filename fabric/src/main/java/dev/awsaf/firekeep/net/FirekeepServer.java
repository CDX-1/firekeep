package dev.awsaf.firekeep.net;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Where the python capture server lives, and the one HTTP client the mod reaches it with.
 *
 * <p>Both source sets share this: the client side posts screenshots through it, the server
 * side pushes the live world feed. Every call here blocks, so nothing in this class may be
 * touched from the render thread or the server thread.
 */
public final class FirekeepServer {
    public static final String DEFAULT_URL = "http://127.0.0.1:8000";
    /** Where the server URL can be overridden without recompiling. */
    private static final String URL_ENV = "FIREKEEP_SERVER";
    private static final String URL_PROPERTY = "firekeep.server";

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private static volatile String baseUrl = defaultUrl();

    private FirekeepServer() {
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
            if (uri.getHost() == null || uri.getScheme() == null || !uri.getScheme().startsWith("http")) {
                throw new IllegalArgumentException("not an http(s) URL: " + url);
            }
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("not a URL: " + url, e);
        }
        return trimmed;
    }

    public static JsonObject get(String path, Duration timeout) throws IOException {
        return send(HttpRequest.newBuilder(uri(path)).timeout(timeout).GET().build());
    }

    public static JsonObject post(String path, String contentType, byte[] body, String source, Duration timeout)
            throws IOException {
        return send(HttpRequest.newBuilder(uri(path))
                .header("Content-Type", contentType)
                .header("X-Source", source)
                .timeout(timeout)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
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
}
