package dev.awsaf.firekeep.live;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.entity.DroneEntity;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import dev.awsaf.firekeep.net.FirekeepServer;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerChunkEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.phys.Vec3;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Streams the living world to the capture server, so the dashboard map can show a fire
 * spreading rather than whatever the last autosave happened to catch.
 *
 * <p>The shape is: a mixin marks a column dirty whenever a block under it changes, this class
 * coalesces those marks and, a few times a second, samples only the dirty columns and hands a
 * batch to a background thread to POST. Nothing on the server thread ever waits on the network,
 * and a server that is not running costs one failed connection every {@link #RETRY_SECONDS}.
 *
 * <p>Region files on disk still provide the baseline map - they hold the whole explored world,
 * while this only ever knows about chunks that are loaded. The two are complementary and the
 * dashboard draws this on top.
 */
public final class WorldFeed {
    /** How often the dirty set is drained, in server ticks (20/s). */
    private static final int FLUSH_TICKS = 4;
    /** Columns per batch. Anything over stays dirty and goes out next flush. */
    private static final int MAX_COLUMNS = 16_000;
    /** Depth of the send queue; older batches are dropped first when the server is slow. */
    private static final int QUEUE_DEPTH = 4;
    /** How long to stop trying after a failed push. */
    private static final int RETRY_SECONDS = 10;

    private static final Map<ServerLevel, LongOpenHashSet> DIRTY = new HashMap<>();
    private static final BlockingQueue<byte[]> OUTBOX = new ArrayBlockingQueue<>(QUEUE_DEPTH);
    private static final BlockPos.MutableBlockPos SCRATCH = new BlockPos.MutableBlockPos();

    /** Identifies one run of the world, so the dashboard knows when to throw its overlay away. */
    private static volatile String session = "";
    private static volatile boolean online;
    private static volatile String lastError;
    private static long quietUntil;
    private static int tick;
    private static Thread sender;
    private static volatile MinecraftServer running;

    private WorldFeed() {
    }

    public static void initialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            running = server;
            session = UUID.randomUUID().toString().substring(0, 8);
            startSender();
            Firekeep.LOGGER.info("live world feed -> {} (session {})", FirekeepServer.baseUrl(), session);
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            running = null;
            synchronized (DIRTY) {
                DIRTY.clear();
            }
            OUTBOX.clear();
            stopSender();
        });

        // A freshly loaded chunk is news to the dashboard even if nothing in it has changed.
        ServerChunkEvents.CHUNK_LOAD.register((level, chunk, newlyGenerated) -> markChunk(level, chunk));
        ServerChunkEvents.CHUNK_UNLOAD.register((level, chunk) -> forgetChunk(level, chunk.getPos()));

        ServerTickEvents.END_SERVER_TICK.register(server -> {
            if (++tick % FLUSH_TICKS != 0) {
                return;
            }
            for (ServerLevel level : server.getAllLevels()) {
                flush(level);
            }
        });
    }

    public static boolean isOnline() {
        return online;
    }

    public static String status() {
        if (online) {
            return "live -> " + FirekeepServer.baseUrl();
        }
        return "offline (" + (lastError == null ? "not started" : lastError) + ")";
    }

    // ---------------------------------------------------------------- collecting

    /**
     * Notes that the column at {@code x, z} needs re-sampling.
     *
     * <p>Called from the mixin on every block change, so it does the least work it can: a set
     * insert and nothing else. The column one step south is marked too, because relief shading
     * reads its northern neighbour and that neighbour just moved.
     */
    public static void markDirty(ServerLevel level, int x, int z) {
        synchronized (DIRTY) {
            LongOpenHashSet columns = DIRTY.computeIfAbsent(level, ignored -> new LongOpenHashSet());
            columns.add(key(x, z));
            columns.add(key(x, z + 1));
        }
    }

    private static void markChunk(ServerLevel level, LevelChunk chunk) {
        ChunkPos pos = chunk.getPos();
        synchronized (DIRTY) {
            LongOpenHashSet columns = DIRTY.computeIfAbsent(level, ignored -> new LongOpenHashSet());
            for (int dz = 0; dz < 16; dz++) {
                for (int dx = 0; dx < 16; dx++) {
                    columns.add(key(pos.getMinBlockX() + dx, pos.getMinBlockZ() + dz));
                }
            }
        }
    }

    private static void forgetChunk(ServerLevel level, ChunkPos pos) {
        synchronized (DIRTY) {
            LongOpenHashSet columns = DIRTY.get(level);
            if (columns == null) {
                return;
            }
            for (int dz = 0; dz < 16; dz++) {
                for (int dx = 0; dx < 16; dx++) {
                    columns.remove(key(pos.getMinBlockX() + dx, pos.getMinBlockZ() + dz));
                }
            }
        }
    }

    // ---------------------------------------------------------------- sending

    private static void flush(ServerLevel level) {
        long[] batch = drain(level);
        List<? extends DroneEntity> drones = level.getEntities(FirekeepEntities.DRONE, drone -> true);
        if (batch.length == 0 && drones.isEmpty()) {
            return;
        }
        if (System.currentTimeMillis() < quietUntil) {
            return;
        }

        String payload = encode(level, batch, drones);
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        // The newest picture of the world is the useful one, so drop the oldest batch if we
        // are already behind rather than letting the queue grow stale.
        while (!OUTBOX.offer(bytes)) {
            OUTBOX.poll();
        }
    }

    /** Takes up to {@link #MAX_COLUMNS} dirty columns off the set, leaving the rest for later. */
    private static long[] drain(ServerLevel level) {
        synchronized (DIRTY) {
            LongOpenHashSet columns = DIRTY.get(level);
            if (columns == null || columns.isEmpty()) {
                return new long[0];
            }
            int take = Math.min(columns.size(), MAX_COLUMNS);
            long[] out = new long[take];
            var it = columns.iterator();
            for (int i = 0; i < take; i++) {
                out[i] = it.nextLong();
                it.remove();
            }
            return out;
        }
    }

    private static String encode(ServerLevel level, long[] batch, List<? extends DroneEntity> drones) {
        StringBuilder json = new StringBuilder(batch.length * 24 + 256);
        json.append("{\"session\":\"").append(session)
                .append("\",\"dimension\":\"").append(level.dimension().identifier())
                .append("\",\"tick\":").append(level.getGameTime())
                .append(",\"columns\":[");

        int written = 0;
        int hot = 0;
        for (long column : batch) {
            int x = (int) (column >> 32);
            int z = (int) column;
            LevelChunk chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
            if (chunk == null) {
                continue;                       // unloaded between the mark and now
            }
            int sampled = Surface.sample(level, chunk, x, z, SCRATCH);
            if ((sampled >>> 24 & Surface.EMPTY) != 0) {
                continue;
            }
            if ((sampled >>> 24 & Surface.HOT) != 0) {
                hot++;
            }
            if (written++ > 0) {
                json.append(',');
            }
            // flat triples: x, z, then colour in the low 24 bits and flags in the high 8
            json.append(x).append(',').append(z).append(',').append(sampled);
        }

        json.append("],\"drones\":[");
        for (int i = 0; i < drones.size(); i++) {
            DroneEntity drone = drones.get(i);
            Vec3 at = drone.position();
            Vec3 target = drone.getTargetPosition();
            if (i > 0) {
                json.append(',');
            }
            json.append("{\"id\":\"").append(drone.getDroneId().isEmpty()
                            ? "drone-" + drone.getId() : escape(drone.getDroneId()))
                    .append("\",\"x\":").append(round(at.x))
                    .append(",\"y\":").append(round(at.y))
                    .append(",\"z\":").append(round(at.z))
                    .append(",\"yaw\":").append(round(drone.getYRot()))
                    .append(",\"target\":");
            if (target == null) {
                json.append("null");
            } else {
                json.append('[').append(round(target.x)).append(',')
                        .append(round(target.y)).append(',').append(round(target.z)).append(']');
            }
            json.append('}');
        }
        json.append("],\"hot\":").append(hot).append('}');
        return json.toString();
    }

    private static void startSender() {
        stopSender();
        Thread thread = new Thread(WorldFeed::pump, "firekeep-world-feed");
        thread.setDaemon(true);
        sender = thread;
        thread.start();
    }

    private static void stopSender() {
        Thread thread = sender;
        sender = null;
        if (thread != null) {
            thread.interrupt();
        }
    }

    private static void pump() {
        Thread self = Thread.currentThread();
        while (sender == self && !self.isInterrupted()) {
            byte[] batch;
            try {
                batch = OUTBOX.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                self.interrupt();
                return;
            }
            if (batch == null) {
                continue;
            }

            try {
                JsonObject reply = FirekeepServer.post("/api/live", "application/json", batch,
                        "firekeep-mod", Duration.ofSeconds(5));
                apply(reply);
                if (!online) {
                    Firekeep.LOGGER.info("live world feed connected to {}", FirekeepServer.baseUrl());
                }
                online = true;
                lastError = null;
            } catch (IOException e) {
                if (online || lastError == null) {
                    Firekeep.LOGGER.warn("live world feed paused: {}", e.getMessage());
                }
                online = false;
                lastError = e.getMessage();
                quietUntil = System.currentTimeMillis() + RETRY_SECONDS * 1000L;
                OUTBOX.clear();
            }
        }
    }

    /**
     * Carries out any drone orders the dashboard left in the reply.
     *
     * <p>Piggybacking on the feed's own response means an order costs no extra request and
     * lands within one flush. The work itself is handed to the server thread, since that is
     * the only place an entity may be touched.
     */
    private static void apply(JsonObject reply) {
        MinecraftServer server = running;
        if (server == null || reply == null || !reply.has("commands")) {
            return;
        }
        JsonElement commands = reply.get("commands");
        if (!commands.isJsonArray() || commands.getAsJsonArray().isEmpty()) {
            return;
        }

        JsonArray orders = commands.getAsJsonArray();
        server.execute(() -> {
            for (JsonElement element : orders) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject order = element.getAsJsonObject();
                if (!order.has("id")) {
                    continue;
                }
                DroneEntity drone = findDrone(server, order.get("id").getAsString());
                if (drone == null) {
                    continue;
                }
                if (flag(order, "hover")) {
                    drone.hover();
                    continue;
                }
                if (flag(order, "fly")) {
                    drone.setFlightInput(
                            number(order, "forward"),
                            number(order, "right"),
                            number(order, "up"),
                            number(order, "yaw"));
                    continue;
                }
                if (!order.has("x") || !order.has("y") || !order.has("z")) {
                    continue;
                }
                drone.setTargetPosition(new Vec3(order.get("x").getAsDouble(),
                        order.get("y").getAsDouble(), order.get("z").getAsDouble()));
                drone.setClearTargetOnArrival(true);
            }
        });
    }

    private static boolean flag(JsonObject order, String key) {
        return order.has(key) && order.get(key).getAsBoolean();
    }

    private static double number(JsonObject order, String key) {
        return order.has(key) ? order.get(key).getAsDouble() : 0.0D;
    }

    /** Looks a drone up by its feed id across every dimension. Server thread only. */
    private static DroneEntity findDrone(MinecraftServer server, String id) {
        for (ServerLevel level : server.getAllLevels()) {
            for (DroneEntity drone : level.getEntities(FirekeepEntities.DRONE, drone -> true)) {
                String label = drone.getDroneId().isEmpty() ? "drone-" + drone.getId() : drone.getDroneId();
                if (label.equals(id)) {
                    return drone;
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- helpers

    private static long key(int x, int z) {
        return ((long) x << 32) | (z & 0xFFFFFFFFL);
    }

    /** Two decimals is plenty for a map and keeps the payload small. */
    private static double round(double value) {
        return Math.round(value * 100.0D) / 100.0D;
    }

    private static String escape(String raw) {
        StringBuilder out = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c >= ' ') {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** Unused today, kept so the drone list has somewhere obvious to grow. */
    static List<String> droneIds(ServerLevel level) {
        List<String> ids = new ArrayList<>();
        for (DroneEntity drone : level.getEntities(FirekeepEntities.DRONE, drone -> true)) {
            ids.add(drone.getDroneId());
        }
        return ids;
    }
}
