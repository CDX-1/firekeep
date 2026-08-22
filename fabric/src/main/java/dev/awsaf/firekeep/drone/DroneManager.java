package dev.awsaf.firekeep.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.entity.DroneEntity;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.TicketType;
import net.minecraft.util.Mth;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/**
 * The fleet. One place that knows every drone, what it is doing, and what it can see.
 *
 * <p>Everything with a thread boundary in the drone bridge meets here, and the rule is simple:
 * the server thread writes, everyone else reads. Each tick this class re-indexes the drones,
 * runs their controllers, refreshes perception on a schedule, and republishes two concurrent maps
 * that {@link DroneApiServer} can serve straight out of without ever touching a Minecraft object.
 *
 * <p>Work coming the other way - a command from n8n - lands on a queue and is drained at the top
 * of the next tick, which is what lets an HTTP handler "control" a drone without ever racing the
 * game loop.
 */
public final class DroneManager {
    /** Perception is interpreted off-thread; one worker is plenty and keeps ordering obvious. */
    private static final ExecutorService PERCEPTION_WORKER = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "firekeep-perception");
        thread.setDaemon(true);
        return thread;
    });

    /**
     * A drone flying to a fire nobody is standing next to would otherwise leave the loaded world
     * and stop existing. This ticket travels with it: loading, so the chunks are there to perceive,
     * and simulating, so both the drone and the fire it was sent to keep ticking.
     */
    private static final TicketType DRONE_TICKET =
            new TicketType(TicketType.NO_TIMEOUT, TicketType.FLAG_LOADING | TicketType.FLAG_SIMULATION);
    /** Chunks either side of the drone; 2 covers the default perception radius with room to move. */
    private static final int TICKET_RADIUS = 2;
    /** Ticks a drone may be missing from the index before it is written off, covering chunk loads. */
    private static final int LOST_GRACE_TICKS = 100;

    private static final Map<UUID, DroneController> CONTROLLERS = new LinkedHashMap<>();
    private static final Map<UUID, Long> NEXT_SCAN = new HashMap<>();
    private static final Map<UUID, Held> HELD_CHUNKS = new HashMap<>();
    private static final Map<UUID, Integer> MISSING = new HashMap<>();
    private static final List<Deferred> DEFERRED = new ArrayList<>();

    private static final Map<String, DroneState> ROSTER = new ConcurrentHashMap<>();
    private static final Map<String, PerceptionSnapshot> PERCEPTION = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<Pending> INBOX = new ConcurrentLinkedQueue<>();

    private static volatile DroneConfig config;
    private static volatile N8nClient n8n;
    private static volatile MinecraftServer server;
    private static long lastPerceptionPush;
    private static int autoId;

    private DroneManager() {
    }

    /** Something an HTTP thread asked for, to be carried out on the next server tick. */
    private record Pending(String droneId, DroneCommand command,
                           CompletableFuture<PerceptionSnapshot> perception, Runnable task) {
    }

    /** Work that has to happen a few ticks from now rather than as soon as possible. */
    private record Deferred(long dueTick, Runnable task) {
    }

    /** The chunk region currently held open for one drone. */
    private record Held(ResourceKey<Level> dimension, ChunkPos pos) {
    }

    // ---------------------------------------------------------------- lifecycle

    public static void initialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(minecraftServer -> {
            server = minecraftServer;
            DroneConfig loaded = DroneConfig.load();
            config = loaded;

            N8nClient client = new N8nClient(loaded);
            client.start();
            n8n = client;
            DroneEvents.start(loaded, client);

            DroneApiServer.start(loaded);
            Firekeep.LOGGER.info("drone bridge ready: perception {}x{} blocks, n8n at {}",
                    loaded.perceptionRadius, loaded.perceptionVerticalRadius,
                    loaded.n8nWebhookUrl.isBlank() ? "<no webhook configured>" : loaded.n8nWebhookUrl);
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(minecraftServer -> {
            DroneApiServer.stop();
            N8nClient client = n8n;
            if (client != null) {
                client.stop();
            }
            n8n = null;
            server = null;
            releaseAllChunks(minecraftServer);
            CONTROLLERS.clear();
            NEXT_SCAN.clear();
            MISSING.clear();
            DEFERRED.clear();
            ROSTER.clear();
            PERCEPTION.clear();
            INBOX.clear();
        });

        ServerTickEvents.END_SERVER_TICK.register(DroneManager::tick);
    }

    public static DroneConfig config() {
        return config;
    }

    public static N8nClient n8n() {
        return n8n;
    }

    // ---------------------------------------------------------------- the tick

    private static void tick(MinecraftServer minecraftServer) {
        if (config == null) {
            return;
        }

        Map<String, DroneEntity> drones = index(minecraftServer);
        retireLostDrones(drones);
        drainInbox(drones);

        Function<String, Entity> lookup = id -> findEntity(minecraftServer, drones, id);
        long gameTime = minecraftServer.overworld().getGameTime();

        for (DroneEntity drone : drones.values()) {
            DroneController controller = CONTROLLERS.get(drone.getUUID());
            if (controller == null || !(drone.level() instanceof ServerLevel level)) {
                continue;
            }
            holdChunks(level, drone);
            controller.tick(level, drone, lookup);
            ROSTER.put(controller.droneId(), snapshot(controller, drone, level, gameTime));
            maybeScan(level, drone, controller, gameTime);
        }

        runDeferred(gameTime);
    }

    /** Runs work that asked to happen later, such as answering a spawn once the drone is indexed. */
    private static void runDeferred(long gameTime) {
        if (DEFERRED.isEmpty()) {
            return;
        }
        List<Runnable> due = new ArrayList<>();
        DEFERRED.removeIf(deferred -> {
            if (deferred.dueTick() > gameTime) {
                return false;
            }
            due.add(deferred.task());
            return true;
        });
        for (Runnable task : due) {
            task.run();
        }
    }

    private static void later(long ticks, Runnable task) {
        MinecraftServer minecraftServer = server;
        long now = minecraftServer == null ? 0L : minecraftServer.overworld().getGameTime();
        DEFERRED.add(new Deferred(now + ticks, task));
    }

    // ---------------------------------------------------------------- chunk tickets

    private static void holdChunks(ServerLevel level, DroneEntity drone) {
        ChunkPos pos = drone.chunkPosition();
        Held held = HELD_CHUNKS.get(drone.getUUID());
        if (held != null && held.dimension().equals(level.dimension()) && held.pos().equals(pos)) {
            return;
        }
        releaseChunks(drone.getUUID());
        level.getChunkSource().addTicketWithRadius(DRONE_TICKET, pos, TICKET_RADIUS);
        HELD_CHUNKS.put(drone.getUUID(), new Held(level.dimension(), pos));
    }

    private static void releaseChunks(UUID droneUuid) {
        Held held = HELD_CHUNKS.remove(droneUuid);
        MinecraftServer minecraftServer = server;
        if (held == null || minecraftServer == null) {
            return;
        }
        ServerLevel level = minecraftServer.getLevel(held.dimension());
        if (level != null) {
            level.getChunkSource().removeTicketWithRadius(DRONE_TICKET, held.pos(), TICKET_RADIUS);
        }
    }

    private static void releaseAllChunks(MinecraftServer minecraftServer) {
        for (Map.Entry<UUID, Held> entry : Map.copyOf(HELD_CHUNKS).entrySet()) {
            Held held = entry.getValue();
            ServerLevel level = minecraftServer.getLevel(held.dimension());
            if (level != null) {
                level.getChunkSource().removeTicketWithRadius(DRONE_TICKET, held.pos(), TICKET_RADIUS);
            }
        }
        HELD_CHUNKS.clear();
    }

    /**
     * Re-reads the world's drones and makes sure each has an id and a controller.
     *
     * <p>Ids are assigned here rather than at spawn because a drone can also arrive by
     * {@code /summon} or out of a saved chunk, and a drone n8n cannot name is a drone n8n cannot
     * use. The generated name is written back to the entity, so it survives a restart.
     */
    private static Map<String, DroneEntity> index(MinecraftServer minecraftServer) {
        Map<String, DroneEntity> drones = new LinkedHashMap<>();
        for (ServerLevel level : minecraftServer.getAllLevels()) {
            for (DroneEntity drone : level.getEntities(FirekeepEntities.DRONE, candidate -> !candidate.isRemoved())) {
                String id = drone.getDroneId();
                if (id.isBlank() || drones.containsKey(id)) {
                    id = nextFreeId(drones);
                    drone.setDroneId(id);
                }
                drones.put(id, drone);

                CONTROLLERS.computeIfAbsent(drone.getUUID(),
                        uuid -> new DroneController(drone.getDroneId(), config, drone.position()));
            }
        }
        return drones;
    }

    private static String nextFreeId(Map<String, DroneEntity> taken) {
        String candidate;
        do {
            candidate = String.format("drone_%02d", ++autoId);
        } while (taken.containsKey(candidate) || ROSTER.containsKey(candidate));
        return candidate;
    }

    /**
     * Forgets drones that have really gone, but not ones that are merely between chunk loads.
     *
     * <p>A freshly spawned drone is invisible to the entity index until its chunk finishes
     * loading, and a drone crossing into a new region briefly is too, so absence only counts
     * after {@link #LOST_GRACE_TICKS}.
     */
    private static void retireLostDrones(Map<String, DroneEntity> drones) {
        Map<UUID, String> alive = new HashMap<>();
        drones.forEach((id, drone) -> alive.put(drone.getUUID(), id));

        CONTROLLERS.entrySet().removeIf(entry -> {
            if (alive.containsKey(entry.getKey())) {
                MISSING.remove(entry.getKey());
                return false;
            }
            int missing = MISSING.merge(entry.getKey(), 1, Integer::sum);
            if (missing < LOST_GRACE_TICKS) {
                return false;
            }

            DroneController controller = entry.getValue();
            controller.onLost();
            ROSTER.remove(controller.droneId());
            PERCEPTION.remove(controller.droneId());
            NEXT_SCAN.remove(entry.getKey());
            MISSING.remove(entry.getKey());
            releaseChunks(entry.getKey());
            DroneEvents.emit("drone_offline", controller.droneId(), null);
            return true;
        });
    }

    private static void drainInbox(Map<String, DroneEntity> drones) {
        Pending pending;
        while ((pending = INBOX.poll()) != null) {
            if (pending.task() != null) {
                pending.task().run();
                continue;
            }

            DroneEntity drone = drones.get(pending.droneId());
            DroneController controller = drone == null ? null : CONTROLLERS.get(drone.getUUID());
            if (drone == null || controller == null || !(drone.level() instanceof ServerLevel level)) {
                if (pending.command() != null) {
                    pending.command().completion().complete(
                            CommandResult.failed(pending.command(), "no drone called '" + pending.droneId() + "'"));
                }
                if (pending.perception() != null) {
                    pending.perception().completeExceptionally(
                            new IllegalStateException("no drone called '" + pending.droneId() + "'"));
                }
                continue;
            }

            if (pending.command() != null) {
                controller.begin(level, drone, pending.command());
            }
            if (pending.perception() != null) {
                scan(level, drone, controller, pending.perception());
            }
        }
    }

    // ---------------------------------------------------------------- perception

    private static void maybeScan(ServerLevel level, DroneEntity drone, DroneController controller, long gameTime) {
        boolean requested = controller.consumeScanRequest();
        long due = NEXT_SCAN.getOrDefault(drone.getUUID(), 0L);
        if (!requested && gameTime < due) {
            return;
        }
        NEXT_SCAN.put(drone.getUUID(), gameTime + config.perceptionIntervalTicks);
        scan(level, drone, controller, null);
    }

    /**
     * Reads the world now, on this thread, and hands the interpretation to a worker.
     *
     * <p>The split matters: reading 4,851 blocks is a few tenths of a millisecond, but clustering
     * them, naming the clusters and drawing the map is not something to do inside a tick.
     */
    private static void scan(ServerLevel level, DroneEntity drone, DroneController controller,
                             CompletableFuture<PerceptionSnapshot> waiting) {
        DroneConfig current = config;
        PerceptionScan raw = DronePerception.scan(level, drone, current, controller.status(),
                controller.activeLabel(), controller.home());
        MinecraftServer minecraftServer = server;

        PERCEPTION_WORKER.execute(() -> {
            try {
                PerceptionSnapshot snapshot = DronePerception.interpret(raw, current);
                PERCEPTION.put(snapshot.droneId(), snapshot);
                DroneEvents.inspect(snapshot);
                if (waiting != null) {
                    waiting.complete(snapshot);
                }
                if (minecraftServer != null) {
                    // Completing a pending scan command touches controller state, which belongs
                    // to the server thread even when the value that satisfies it did not.
                    minecraftServer.execute(() -> controller.onPerception(snapshot));
                }
                pushPerception(snapshot, current);
            } catch (RuntimeException e) {
                Firekeep.LOGGER.error("perception failed for {}: {}", raw.droneId(), e.toString());
                if (waiting != null) {
                    waiting.completeExceptionally(e);
                }
            }
        });
    }

    private static void pushPerception(PerceptionSnapshot snapshot, DroneConfig current) {
        N8nClient client = n8n;
        if (client == null || !current.pushPerception || !current.hasWebhook()) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastPerceptionPush < current.perceptionPushIntervalSeconds * 1000L) {
            return;
        }
        lastPerceptionPush = now;

        JsonObject body = snapshot.toJson();
        body.addProperty("event", "perception");
        client.send(body);
    }

    // ---------------------------------------------------------------- outside world

    /** Every drone, newest state first published by the tick above. Safe from any thread. */
    public static List<DroneState> roster() {
        List<DroneState> states = new ArrayList<>(ROSTER.values());
        states.sort((a, b) -> a.id().compareTo(b.id()));
        return states;
    }

    public static DroneState state(String droneId) {
        return ROSTER.get(droneId);
    }

    /** The last snapshot taken for this drone, or null if it has not been scanned yet. */
    public static PerceptionSnapshot perception(String droneId) {
        return PERCEPTION.get(droneId);
    }

    /** Forces a fresh scan on the next tick and resolves once it has been interpreted. */
    public static CompletableFuture<PerceptionSnapshot> refreshPerception(String droneId) {
        CompletableFuture<PerceptionSnapshot> future = new CompletableFuture<>();
        INBOX.add(new Pending(droneId, null, future, null));
        return future;
    }

    /** Queues an order. The returned future completes when the drone finishes, fails or is redirected. */
    public static CompletableFuture<CommandResult> submit(DroneCommand command) {
        INBOX.add(new Pending(command.droneId(), command, null, null));
        return command.completion();
    }

    /** Runs {@code task} on the server thread at the start of the next tick. */
    public static void onServerThread(Runnable task) {
        INBOX.add(new Pending(null, null, null, task));
    }

    /**
     * Picks the closest drone that is free and sends it to {@code target}.
     *
     * <p>This is the multi-drone coordination primitive: the AI decides that something at a place
     * needs a drone, and the mod - which is the only side that knows where every drone actually is
     * right now - decides which one goes.
     */
    public static DispatchResult dispatch(Vec3 target, String dimension, JsonObject commandBody) {
        DroneState closest = null;
        double bestDistance = Double.MAX_VALUE;
        for (DroneState state : roster()) {
            if (!state.available()) {
                continue;
            }
            if (dimension != null && !dimension.isBlank() && !state.dimension().equals(dimension)) {
                continue;
            }
            double distance = state.position().distanceTo(target);
            if (distance < bestDistance) {
                bestDistance = distance;
                closest = state;
            }
        }
        if (closest == null) {
            return new DispatchResult(null, 0.0D, null);
        }

        DroneCommand command = DroneCommand.parse(closest.id(), commandBody);
        submit(command);
        String chosen = closest.id();
        onServerThread(() -> {
            for (DroneController controller : CONTROLLERS.values()) {
                if (controller.droneId().equals(chosen)) {
                    controller.markResponding();
                }
            }
        });
        return new DispatchResult(closest, bestDistance, command);
    }

    public record DispatchResult(DroneState drone, double distance, DroneCommand command) {
    }

    /**
     * Spawns a drone and resolves once it exists and has been indexed.
     *
     * <p>Two ticks, not one: the entity is added on the first, and only the indexing pass on the
     * second gives it an id and a controller - which is what the caller is actually asking for.
     */
    public static CompletableFuture<DroneState> spawn(String requestedId, Vec3 position, String dimension,
                                                      float yaw) {
        CompletableFuture<DroneState> future = new CompletableFuture<>();
        onServerThread(() -> {
            MinecraftServer minecraftServer = server;
            if (minecraftServer == null) {
                future.completeExceptionally(new IllegalStateException("server is not running"));
                return;
            }
            ServerLevel level = levelOf(minecraftServer, dimension);
            if (level == null) {
                future.completeExceptionally(new IllegalArgumentException("unknown dimension '" + dimension + "'"));
                return;
            }
            if (requestedId != null && !requestedId.isBlank() && ROSTER.containsKey(requestedId)) {
                future.completeExceptionally(new IllegalArgumentException(
                        "a drone called '" + requestedId + "' already exists"));
                return;
            }

            DroneEntity drone = FirekeepEntities.spawn(level, position, yaw);
            if (drone == null) {
                future.completeExceptionally(new IllegalStateException("could not create a drone"));
                return;
            }
            String id = requestedId == null || requestedId.isBlank() ? nextFreeId(Map.of()) : requestedId;
            drone.setDroneId(id);
            drone.setHomePosition(position);
            drone.setMaxSpeed(config.maxSpeedPerTick());
            CONTROLLERS.put(drone.getUUID(), new DroneController(id, config, position));
            holdChunks(level, drone);
            DroneEvents.emitAt("drone_spawned", id, position, null);

            // The entity index will not show it until its chunk is loaded, which is what the
            // ticket above is for; answer the caller once that has actually happened.
            completeWhenIndexed(id, future, 20);
        });
        return future;
    }

    private static void completeWhenIndexed(String id, CompletableFuture<DroneState> future, int attemptsLeft) {
        DroneState state = ROSTER.get(id);
        if (state != null) {
            future.complete(state);
            return;
        }
        if (attemptsLeft <= 0) {
            future.completeExceptionally(new IllegalStateException(
                    "drone '" + id + "' was created but its chunk has not finished loading"));
            return;
        }
        later(2L, () -> completeWhenIndexed(id, future, attemptsLeft - 1));
    }

    /** Removes a drone from the world. Resolves true if there was one to remove. */
    public static CompletableFuture<Boolean> remove(String droneId) {
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        onServerThread(() -> {
            MinecraftServer minecraftServer = server;
            if (minecraftServer == null) {
                future.complete(false);
                return;
            }
            for (ServerLevel level : minecraftServer.getAllLevels()) {
                for (DroneEntity drone : level.getEntities(FirekeepEntities.DRONE,
                        candidate -> droneId.equals(candidate.getDroneId()))) {
                    drone.discard();
                    DroneEvents.emitAt("drone_removed", droneId, drone.position(), null);
                    future.complete(true);
                    return;
                }
            }
            future.complete(false);
        });
        return future;
    }

    private static ServerLevel levelOf(MinecraftServer minecraftServer, String dimension) {
        if (dimension == null || dimension.isBlank()) {
            return minecraftServer.overworld();
        }
        Identifier identifier = Identifier.tryParse(dimension);
        if (identifier == null) {
            return null;
        }
        return minecraftServer.getLevel(ResourceKey.create(Registries.DIMENSION, identifier));
    }

    /** A short digest of the whole operation, for a coordinating flow's first request. */
    public static JsonObject world() {
        MinecraftServer minecraftServer = server;
        JsonObject json = new JsonObject();
        json.addProperty("online", minecraftServer != null);
        if (minecraftServer != null) {
            json.addProperty("game_time", minecraftServer.overworld().getGameTime());
            json.addProperty("day_time", minecraftServer.overworld().getOverworldClockTime() % 24000L);
            json.addProperty("raining", minecraftServer.overworld().isRaining());
            json.addProperty("thundering", minecraftServer.overworld().isThundering());
            json.addProperty("players", minecraftServer.getPlayerList().getPlayerCount());
        }

        List<DroneState> states = roster();
        json.addProperty("drones", states.size());
        json.addProperty("available", states.stream().filter(DroneState::available).count());

        JsonArray hazards = new JsonArray();
        for (PerceptionSnapshot snapshot : PERCEPTION.values()) {
            for (Feature hazard : snapshot.hazards()) {
                JsonObject entry = new JsonObject();
                entry.addProperty("type", hazard.type());
                entry.addProperty("size", hazard.size());
                entry.addProperty("seen_by", snapshot.droneId());
                entry.addProperty("dimension", snapshot.dimension());
                JsonObject at = new JsonObject();
                at.addProperty("x", hazard.x());
                at.addProperty("y", hazard.y());
                at.addProperty("z", hazard.z());
                entry.add("location", at);
                hazards.add(entry);
            }
        }
        json.add("known_hazards", hazards);
        return json;
    }

    // ---------------------------------------------------------------- helpers

    private static DroneState snapshot(DroneController controller, DroneEntity drone, ServerLevel level,
                                       long gameTime) {
        DroneCommand active = controller.active();
        return new DroneState(
                controller.droneId(),
                controller.status(),
                controller.available(),
                level.dimension().identifier().toString(),
                drone.position(),
                Mth.wrapDegrees(drone.getYRot()),
                drone.getXRot(),
                drone.getDeltaMovement(),
                controller.home(),
                controller.goal(),
                active == null ? null : active.describe(),
                active == null ? null : active.id(),
                controller.waypointsRemaining(),
                controller.lastResult(),
                drone.getMaxSpeed() * 20.0D,
                gameTime,
                drone.getId());
    }

    /** Resolves a follow target: another drone by id, or a player by name. */
    private static Entity findEntity(MinecraftServer minecraftServer, Map<String, DroneEntity> drones, String id) {
        if (id == null) {
            return null;
        }
        DroneEntity drone = drones.get(id);
        if (drone != null) {
            return drone;
        }
        for (ServerPlayer player : minecraftServer.getPlayerList().getPlayers()) {
            if (player.getGameProfile().name().equalsIgnoreCase(id)) {
                return player;
            }
        }
        return null;
    }
}
