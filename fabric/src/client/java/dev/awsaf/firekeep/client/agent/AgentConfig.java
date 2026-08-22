package dev.awsaf.firekeep.client.agent;

import dev.awsaf.firekeep.client.camera.CameraConfig;

/**
 * Turns an ordinary client into a headless-ish rendering agent.
 *
 * <p>An agent exists only to film drones: nobody looks at its screen, so it skips its own view
 * entirely and spends the whole frame on drone captures. Same override convention as
 * {@link CameraConfig} - a system property ({@code -Dfirekeep.agent.enabled=true}) or an
 * environment variable ({@code FIREKEEP_AGENT_ENABLED}).
 */
public final class AgentConfig {
    /** The master switch. Off by default, so a human's client behaves exactly as before. */
    public static final boolean ENABLED = boolValue("enabled", false);

    /**
     * Hides the OS window once the game is up.
     *
     * <p>The GL context stays valid and off-screen rendering carries on; this only stops the
     * desktop compositing a window nobody reads, and stops agents stealing focus at launch.
     */
    public static final boolean HIDE_WINDOW = boolValue("hide-window", true);

    /**
     * Frames per second the agent is allowed to render, or 0 to derive it from the feed rate.
     *
     * <p>This is the lever that makes instance count scale. Uncapped, every agent renders as fast
     * as the GPU allows and burns a core producing frames nobody reads; capped just above the feed
     * rate, each agent takes a small fixed slice and the machine holds many more of them.
     */
    public static final int FPS_CAP = intValue("fps-cap", 0, 0, 260);

    /**
     * Skips the agent's own view of the level.
     *
     * <p>Off, because it does not currently work: a drone capture calls {@code renderLevel} itself,
     * but only produces terrain if the vanilla level render already ran this frame. Skipping the
     * agent's own render leaves the capture drawing an empty world - sky and nothing else. Whatever
     * the capture depends on (chunk section compilation and upload being the likeliest, the
     * lightmap another) rides on the vanilla pass, so for now the agent renders its own view too.
     *
     * <p>Turning it on is still the single biggest saving available, and the proper fix is not this
     * flag at all: an agent should point the <em>vanilla</em> render at the drone and its offscreen
     * target, so the one render a frame already is the drone's.
     */
    public static final boolean SKIP_OWN_RENDER = boolValue("skip-own-render", false);

    /** Master volume goes to zero: an agent has no listener, and the mixing is pure overhead. */
    public static final boolean MUTE = boolValue("mute", true);

    private AgentConfig() {
    }

    /** The frame rate an agent should run at: a little above the feed rate, so captures never wait. */
    public static int effectiveFpsCap() {
        return FPS_CAP > 0 ? FPS_CAP : Math.min(260, CameraConfig.FPS + 5);
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

    private static String raw(String name) {
        String property = System.getProperty("firekeep.agent." + name);
        if (property != null && !property.isBlank()) {
            return property;
        }
        String environment = System.getenv("FIREKEEP_AGENT_" + name.toUpperCase().replace('-', '_'));
        return environment == null || environment.isBlank() ? null : environment;
    }
}
