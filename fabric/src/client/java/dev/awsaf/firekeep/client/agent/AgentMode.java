package dev.awsaf.firekeep.client.agent;

import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.client.camera.CameraConfig;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.sounds.SoundSource;
import org.lwjgl.glfw.GLFW;

/**
 * Applies the agent settings once the client is up.
 *
 * <p>Everything here is a per-instance cost that only exists to serve a human at the keyboard.
 * Stripping it is what lets a single machine hold many agents at once.
 */
public final class AgentMode {
    private AgentMode() {
    }

    /** True for an instance whose only job is filming drones. Read from the render hooks. */
    public static boolean isAgent() {
        return AgentConfig.ENABLED;
    }

    /**
     * Whether this client should film drones at all.
     *
     * <p>Only agents do, by default. A human's client that captures pays for a second level render
     * per frame and visibly flickers while its render target is swapped away, which is the whole
     * reason the feeds moved off it.
     */
    public static boolean shouldCaptureFeeds() {
        return AgentConfig.ENABLED || CameraConfig.FORCE_ON_HUMAN_CLIENT;
    }

    /** Whether this agent should skip drawing its own view of the level. */
    public static boolean skipsOwnRender() {
        return AgentConfig.ENABLED && AgentConfig.SKIP_OWN_RENDER;
    }

    public static void initialize() {
        if (!AgentConfig.ENABLED) {
            return;
        }

        Firekeep.LOGGER.info("firekeep agent mode: rendering drone feeds only, capped at {} fps",
                AgentConfig.effectiveFpsCap());

        ClientLifecycleEvents.CLIENT_STARTED.register(AgentMode::onClientStarted);
    }

    private static void onClientStarted(Minecraft client) {
        try {
            // Uncapped, an agent renders hundreds of frames a second that nobody reads. The cap is
            // what turns each instance into a fixed, predictable slice of the machine.
            client.options.framerateLimit().set(AgentConfig.effectiveFpsCap());
            // Vsync would peg every agent to the monitor's refresh and make them block on the swap.
            client.options.enableVsync().set(false);

            if (AgentConfig.MUTE) {
                client.options.getSoundSourceOptionInstance(SoundSource.MASTER).set(0.0);
            }

            if (AgentConfig.HIDE_WINDOW) {
                // The GL context survives hiding; only the desktop-visible surface goes away.
                GLFW.glfwHideWindow(client.getWindow().handle());
            }
        } catch (Throwable t) {
            Firekeep.LOGGER.error("could not apply agent settings", t);
        }
    }
}
