package dev.awsaf.firekeep.client.camera;

import com.mojang.blaze3d.platform.NativeImage;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.client.agent.AgentMode;
import dev.awsaf.firekeep.entity.DroneEntity;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Keeps one {@link DroneFeed} per drone the client can see, and decides which one gets rendered next.
 *
 * <p>Only feeds somebody is actually watching are rendered, so a world full of drones costs nothing
 * until the dashboard opens. Among those, the drone whose last frame is oldest goes first, which
 * spreads the one-render-per-tick budget evenly however many feeds are open - except that a feed
 * somebody has singled out outranks the thumbnails, because it is asking for a frame several times
 * as often and would otherwise judder while a wall of tiles took its turns.
 */
public final class DroneFeeds {
    private static final Map<UUID, DroneFeed> FEEDS = new ConcurrentHashMap<>();

    /** Refreshed on the client tick, read on every frame; both run on the client thread. */
    private static List<DroneEntity> LIVE_DRONES = List.of();

    private static int framesThisSecond;
    private static long fpsWindowStart;
    private static volatile int clientFps;

    /**
     * The encoders.
     *
     * <p>One 1280x720 frame takes roughly 35ms to turn into a JPEG, so a single thread tops out
     * near 28 frames a second and two near 60 - which is what made a feed asking for 60 judder no
     * matter how fast the game was rendering. Encoding one frame does not depend on any other, so
     * this scales almost linearly: measured, four threads sustain about 128 frames a second at
     * 720p. They are the cheapest part of the machine to spend here, since the alternative is a
     * GPU that has already done its work sitting waiting for them.
     */
    private static final ExecutorService ENCODERS = Executors.newFixedThreadPool(
            CameraConfig.ENCODERS, runnable -> {
                Thread thread = new Thread(runnable, "firekeep-drone-encoder");
                thread.setDaemon(true);
                // Below the render thread: an encoder must never be what delays the next frame.
                thread.setPriority(Thread.NORM_PRIORITY - 1);
                return thread;
            });

    private DroneFeeds() {
    }

    public static void initialize() {
        ClientTickEvents.END_CLIENT_TICK.register(DroneFeeds::tick);
    }

    public static Collection<DroneFeed> feeds() {
        return FEEDS.values();
    }

    public static DroneFeed byId(String id) {
        for (DroneFeed feed : FEEDS.values()) {
            if (feed.id().equals(id)) {
                return feed;
            }
        }
        return null;
    }

    /** Roster upkeep only - which drones exist is a 20-a-second question. */
    private static void tick(Minecraft client) {
        ClientLevel level = client.level;
        if (level == null) {
            clear();
            LIVE_DRONES = List.of();
            return;
        }
        LIVE_DRONES = sync(level);
    }

    /**
     * Called at the end of every rendered frame: renders at most one drone, whichever has been
     * waiting longest. Tying captures to frames rather than ticks is what lifts the ceiling from
     * 20 frames a second shared between every feed to as fast as the game itself runs.
     */
    public static void onFrameRendered() {
        if (!AgentMode.shouldCaptureFeeds()) {
            return;
        }
        countFrame();

        List<DroneEntity> drones = LIVE_DRONES;
        if (drones.isEmpty() || DroneCamera.isBusy()) {
            return;
        }

        long now = System.currentTimeMillis();
        DroneEntity next = null;
        DroneFeed nextFeed = null;
        long oldest = Long.MAX_VALUE;
        long best = Long.MIN_VALUE;

        for (DroneEntity drone : drones) {
            DroneFeed feed = FEEDS.get(drone.getUUID());
            if (feed == null || !feed.isWatched(now)) {
                continue;
            }
            CameraConfig.Profile profile = feed.profile();
            if (now - feed.lastCaptureStart() < profile.intervalMillis()) {
                continue;
            }
            // The feed somebody has singled out goes first when two are both due. It asks for a
            // frame far more often than a thumbnail does, and losing those turns to a wall of
            // tiles is exactly what would make the one being watched judder.
            long weight = profile.weight();
            if (weight > best || (weight == best && feed.lastCaptureStart() < oldest)) {
                best = weight;
                oldest = feed.lastCaptureStart();
                next = drone;
                nextFeed = feed;
            }
        }

        if (next != null) {
            capture(next, nextFeed, now);
        }
    }

    /** Adds feeds for drones that appeared, drops the ones that left. */
    private static List<DroneEntity> sync(ClientLevel level) {
        List<DroneEntity> drones = new ArrayList<>();
        Set<UUID> present = new HashSet<>();

        for (var entity : level.entitiesForRendering()) {
            if (entity instanceof DroneEntity drone && !drone.isRemoved()) {
                drones.add(drone);
                present.add(drone.getUUID());

                DroneFeed feed = FEEDS.get(drone.getUUID());
                if (feed != null && feed.hasPlaceholderName() && !drone.getDroneId().isBlank()) {
                    // The drone's label rides in a synced-data packet that lands a tick or two after
                    // the entity itself, so the feed adopts the real name once it turns up.
                    feed.close();
                    FEEDS.remove(drone.getUUID());
                    feed = null;
                }

                if (feed == null) {
                    String name = nameFor(drone);
                    feed = new DroneFeed(drone, name, drone.getDroneId().isBlank());
                    FEEDS.put(drone.getUUID(), feed);
                    Firekeep.LOGGER.info("drone feed {} online", feed.id());
                } else {
                    feed.track(drone);
                }
            }
        }

        FEEDS.entrySet().removeIf(entry -> {
            if (present.contains(entry.getKey())) {
                return false;
            }
            Firekeep.LOGGER.info("drone feed {} offline", entry.getValue().id());
            entry.getValue().close();
            return true;
        });

        return drones;
    }

    private static String nameFor(DroneEntity drone) {
        String id = drone.getDroneId();
        if (id == null || id.isBlank()) {
            return "drone-" + drone.getId();
        }
        // Two drones sharing a label would collide in the URL space; keep the first one's name.
        for (DroneFeed feed : FEEDS.values()) {
            if (!feed.uuid().equals(drone.getUUID()) && feed.id().equals(id)) {
                return id + "-" + drone.getId();
            }
        }
        return id;
    }

    private static void capture(DroneEntity drone, DroneFeed feed, long now) {
        CameraConfig.Profile profile = feed.profile();
        long capture = feed.nextCapture();
        feed.markCaptureStarted(now);
        boolean started = DroneCamera.capture(drone, profile.width(), profile.height(), image -> {
            int width;
            int height;
            int[] pixels;
            try (NativeImage owned = image) {
                width = owned.getWidth();
                height = owned.getHeight();
                pixels = owned.getPixelsABGR();     // one bulk copy, then off the render thread
            } catch (Throwable t) {
                Firekeep.LOGGER.warn("could not read the frame for {}: {}", feed.id(), t.toString());
                return;
            }

            ENCODERS.execute(() -> {
                try {
                    feed.publish(capture, Frames.toJpeg(pixels, width, height, profile.quality()),
                            width, height);
                } catch (Throwable t) {
                    Firekeep.LOGGER.warn("could not encode the frame for {}: {}", feed.id(), t.toString());
                }
            });
        });

        if (!started) {
            // Try again next tick rather than leaving this feed marked as freshly captured.
            feed.markCaptureStarted(now - profile.intervalMillis());
        }
    }

    /**
     * The game's own frame rate, which is also the budget every feed shares. Reported on the roster
     * so the dashboard can show when the feeds are limited by the machine rather than by config.
     */
    public static int clientFps() {
        return clientFps;
    }

    private static void countFrame() {
        framesThisSecond++;
        long now = System.currentTimeMillis();
        if (now - fpsWindowStart >= 1000L) {
            clientFps = (int) Math.round(framesThisSecond * 1000.0 / (now - fpsWindowStart));
            framesThisSecond = 0;
            fpsWindowStart = now;
        }
    }

    private static void clear() {
        if (FEEDS.isEmpty()) {
            return;
        }
        FEEDS.values().forEach(DroneFeed::close);
        FEEDS.clear();
        DroneCamera.release();
    }
}
