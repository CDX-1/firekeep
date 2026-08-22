package dev.awsaf.firekeep.client.camera;

/**
 * Feed tuning, read once at startup.
 *
 * <p>Every value can be overridden with a system property ({@code -Dfirekeep.camera.fps=10}) or an
 * environment variable ({@code FIREKEEP_CAMERA_FPS}).
 */
public final class CameraConfig {
    public static final int PORT = intValue("port", 8088, 1, 65535);
    public static final int WIDTH = intValue("width", 480, 64, 1920);
    public static final int HEIGHT = intValue("height", 270, 64, 1080);
    /**
     * Per drone. Captures ride on rendered frames, one drone per frame, so the real ceiling is the
     * game's own frame rate divided by the number of feeds being watched.
     */
    public static final int FPS = intValue("fps", 30, 1, 120);
    /** JPEG quality; 0.7 is where a 480p Minecraft frame stops looking crunchy. */
    public static final float QUALITY = floatValue("quality", 0.7F, 0.1F, 1.0F);
    /**
     * How many captures may be in flight at once, each with its own framebuffer.
     *
     * <p>A read-back lands a frame or two after the render that filled it, so a capture cannot
     * reuse a target another capture is still waiting on. More slots let captures overlap instead
     * of stalling one behind the other, at half a megabyte of video memory each.
     */
    public static final int PIPELINE = intValue("pipeline", 3, 1, 8);

    /**
     * Films drones from a client that is <em>not</em> an agent.
     *
     * <p>Off by default. Capturing means running a second level render inside the frame a human is
     * looking at, with the render target and camera entity swapped out and back - which is what
     * made the player's view flicker, and the reason the feeds moved to dedicated agents. Set
     * {@code -Dfirekeep.camera.force=true} to get the old behaviour back for a quick local test.
     */
    public static final boolean FORCE_ON_HUMAN_CLIENT = boolValue("force", false);

    public static final long FRAME_INTERVAL_MILLIS = Math.max(1L, 1000L / FPS);

    private CameraConfig() {
    }

    private static boolean boolValue(String name, boolean fallback) {
        String raw = raw(name);
        return raw == null ? fallback : Boolean.parseBoolean(raw.trim());
    }

    private static int intValue(String name, int fallback, int min, int max) {
        String raw = raw(name);
        if (raw == null) {
            return fallback;
        }
        try {
            return Math.clamp(Integer.parseInt(raw.trim()), min, max);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static float floatValue(String name, float fallback, float min, float max) {
        String raw = raw(name);
        if (raw == null) {
            return fallback;
        }
        try {
            return Math.clamp(Float.parseFloat(raw.trim()), min, max);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String raw(String name) {
        String property = System.getProperty("firekeep.camera." + name);
        if (property != null && !property.isBlank()) {
            return property;
        }
        String env = System.getenv("FIREKEEP_CAMERA_" + name.toUpperCase());
        return env == null || env.isBlank() ? null : env;
    }
}
