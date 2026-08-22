package dev.awsaf.firekeep.client.camera;

/**
 * Feed tuning, read once at startup.
 *
 * <p>Every value can be overridden with a system property ({@code -Dfirekeep.camera.fps=10}) or an
 * environment variable ({@code FIREKEEP_CAMERA_FPS}); a dotted name becomes an underscore, so
 * {@code firekeep.camera.detail.fps} is {@code FIREKEEP_CAMERA_DETAIL_FPS}.
 *
 * <p>There are two profiles. {@link #grid()} is what a wall of thumbnails gets: small, cheap, and
 * shared out between however many feeds are open. {@link #detail()} is what one drone gets while
 * somebody is actually looking at it - bigger, sharper and as often as the game will render it.
 * A drone is only ever on one of them, and only ever the one that has been asked for.
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
    public static final int PIPELINE = intValue("pipeline", 4, 1, 8);

    /**
     * How many frames may be turned into JPEGs at once.
     *
     * <p>The single narrowest part of the pipeline. A 720p frame costs about 35ms to encode, so
     * each thread is worth roughly 28 frames a second and they add up almost perfectly; four is
     * enough to keep a 60fps feed fed with room to spare. Capped at four by default however many
     * cores there are, because the point is to stop starving the feeds, not to eat the machine
     * the other agents are also living on.
     */
    public static final int ENCODERS = intValue(
            "encoders", Math.clamp(Runtime.getRuntime().availableProcessors() / 2, 2, 4), 1, 16);

    /**
     * Films drones from a client that is <em>not</em> an agent.
     *
     * <p>Off by default. Capturing means running a second level render inside the frame a human is
     * looking at, with the render target and camera entity swapped out and back - which is what
     * made the player's view flicker, and the reason the feeds moved to dedicated agents. Set
     * {@code -Dfirekeep.camera.force=true} to get the old behaviour back for a quick local test.
     */
    public static final boolean FORCE_ON_HUMAN_CLIENT = boolValue("force", false);

    /**
     * The feed somebody has singled out: the expanded viewer, or a drone filling the grid alone.
     *
     * <p>720p at 60 exists because at that point there is one feed being rendered, not twelve, so
     * the budget that was being shared can go to it. Quality is well above the grid's because a
     * frame that fills the screen shows every JPEG artefact the thumbnail was hiding.
     */
    public static final int DETAIL_WIDTH = intValue("detail.width", 1280, 64, 3840);
    public static final int DETAIL_HEIGHT = intValue("detail.height", 720, 64, 2160);
    public static final int DETAIL_FPS = intValue("detail.fps", 60, 1, 240);
    /**
     * Above about 0.85 a JPEG stops getting visibly better and starts getting a lot bigger: at
     * 720p, 0.92 is a 390KB frame where 0.85 is 290KB and 0.80 is 240KB. At 60fps that difference
     * is the gap between a feed that arrives and one that spends its time in flight, so the
     * default sits at the top of the range where the size is still buying sharpness.
     */
    public static final float DETAIL_QUALITY = floatValue("detail.quality", 0.85F, 0.1F, 1.0F);

    /** Ceilings for anything a client asks for by hand, so a request cannot melt the machine. */
    public static final int MAX_WIDTH = 3840;
    public static final int MAX_HEIGHT = 2160;
    public static final int MAX_FPS = 240;

    public static final long FRAME_INTERVAL_MILLIS = Math.max(1L, 1000L / FPS);

    private static final Profile GRID = new Profile(WIDTH, HEIGHT, FPS, QUALITY);
    private static final Profile DETAIL = new Profile(DETAIL_WIDTH, DETAIL_HEIGHT, DETAIL_FPS, DETAIL_QUALITY);

    private CameraConfig() {
    }

    /**
     * What one feed is being rendered at.
     *
     * @param fps the cap on how often this feed is captured; the game's own frame rate is still
     *            the real ceiling, since a capture rides on a rendered frame
     */
    public record Profile(int width, int height, int fps, float quality) {
        public Profile {
            width = Math.clamp(width, 64, MAX_WIDTH);
            height = Math.clamp(height, 64, MAX_HEIGHT);
            fps = Math.clamp(fps, 1, MAX_FPS);
            quality = Math.clamp(quality, 0.1F, 1.0F);
        }

        public long intervalMillis() {
            return Math.max(1L, 1000L / this.fps);
        }

        /**
         * How much work this profile is, for deciding which of two requests wins.
         *
         * <p>Pixels a second, near enough. Two viewers can want the same drone at once - a tile
         * asking for a thumbnail while the expanded viewer streams it - and the one asking for
         * more should not be quietly downgraded by the one asking for less.
         */
        public long weight() {
            return (long) this.width * this.height * this.fps;
        }
    }

    public static Profile grid() {
        return GRID;
    }

    public static Profile detail() {
        return DETAIL;
    }

    /** The profile a request named, or null if it named nothing recognisable. */
    public static Profile byName(String name) {
        if (name == null) {
            return null;
        }
        return switch (name.trim().toLowerCase()) {
            case "detail", "high", "full" -> DETAIL;
            case "grid", "thumb", "low" -> GRID;
            default -> null;
        };
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
        String env = System.getenv("FIREKEEP_CAMERA_" + name.toUpperCase().replace('.', '_'));
        return env == null || env.isBlank() ? null : env;
    }
}
