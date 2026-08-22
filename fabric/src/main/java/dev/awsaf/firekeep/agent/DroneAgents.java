package dev.awsaf.firekeep.agent;

import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.entity.DroneEntity;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.gamerules.GameRules;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keeps each rendering agent sitting on the drone it films.
 *
 * <p>An agent client can only render what its own player has been sent, and the server decides that
 * from the player's position - so an agent parked at spawn films void however good the capture
 * pipeline is. Riding the drone is what makes the feed work at any distance from a human.
 *
 * <p>Agents bind by name: a player called {@code agent-alpha} films the drone labelled
 * {@code alpha}, so launching an instance per drone needs no commands at all. {@code /drone agent}
 * overrides it by hand.
 */
public final class DroneAgents {
    /** A player whose name starts with this is a rendering agent; the rest of the name is a drone id. */
    public static final String NAME_PREFIX = "agent-";

    /** Below this, the drone has not really moved and a teleport packet would be wasted. */
    private static final double MOVE_EPSILON_SQR = 1.0E-4D;

    /** Player uuid to drone id. Touched only from the server thread, but joins arrive off it. */
    private static final Map<UUID, String> ASSIGNMENTS = new ConcurrentHashMap<>();

    private DroneAgents() {
    }

    public static void initialize() {
        ServerTickEvents.END_SERVER_TICK.register(DroneAgents::tick);

        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> onJoin(handler.getPlayer()));
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) ->
                ASSIGNMENTS.remove(handler.getPlayer().getUUID()));
    }

    /** Binds {@code player} to the drone labelled {@code droneId} and puts it in spectator. */
    public static void assign(ServerPlayer player, String droneId) {
        ASSIGNMENTS.put(player.getUUID(), droneId);
        makeSpectator(player);
        warnIfSpectatorsCannotLoadChunks(player);
        Firekeep.LOGGER.info("agent {} now filming drone {}", player.getGameProfile().name(), droneId);
    }

    /**
     * Agents are spectators, and a spectator only pulls chunks while this rule is on - vanilla
     * leaves it on, but with it off the server quietly stops sending an agent any terrain and every
     * feed goes black. That looks exactly like a broken capture pipeline, so say so plainly here.
     */
    private static void warnIfSpectatorsCannotLoadChunks(ServerPlayer player) {
        if (!player.level().getGameRules().get(GameRules.SPECTATORS_GENERATE_CHUNKS)) {
            Firekeep.LOGGER.warn("spectatorsGenerateChunks is off, so agent {} will not be sent any "
                    + "chunks and its feed will render empty; turn the rule on", player.getGameProfile().name());
        }
    }

    public static void clear(ServerPlayer player) {
        if (ASSIGNMENTS.remove(player.getUUID()) != null) {
            Firekeep.LOGGER.info("agent {} released", player.getGameProfile().name());
        }
    }

    /** The drone id {@code player} is filming, or null if it is not an agent. */
    public static String assignmentOf(ServerPlayer player) {
        return ASSIGNMENTS.get(player.getUUID());
    }

    public static Map<UUID, String> assignments() {
        return Map.copyOf(ASSIGNMENTS);
    }

    /** Auto-binds by name, so an instance per drone needs no operator input. */
    private static void onJoin(ServerPlayer player) {
        String name = player.getGameProfile().name();
        if (!name.startsWith(NAME_PREFIX)) {
            return;
        }
        String droneId = name.substring(NAME_PREFIX.length());
        if (droneId.isBlank()) {
            return;
        }
        assign(player, droneId);
    }

    private static void makeSpectator(ServerPlayer player) {
        if (player.gameMode() != GameType.SPECTATOR) {
            // Spectator keeps the agent out of the world: no collision, no block breaking, and
            // nothing of it shows up in another drone's shot.
            player.setGameMode(GameType.SPECTATOR);
        }
    }

    private static void tick(MinecraftServer server) {
        if (ASSIGNMENTS.isEmpty()) {
            return;
        }

        Map<String, DroneEntity> drones = index(server);

        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            String droneId = ASSIGNMENTS.get(player.getUUID());
            if (droneId == null) {
                continue;
            }
            DroneEntity drone = drones.get(droneId);
            if (drone == null) {
                continue;               // drone not spawned yet, or gone; hold position and wait
            }
            follow(player, drone);
        }
    }

    /**
     * Builds the drone id lookup once per tick rather than scanning per agent, so a fleet of agents
     * costs one pass over the drones instead of one each.
     */
    private static Map<String, DroneEntity> index(MinecraftServer server) {
        Map<String, DroneEntity> drones = new HashMap<>();
        for (ServerLevel level : server.getAllLevels()) {
            for (DroneEntity drone : level.getEntities(FirekeepEntities.DRONE, drone -> !drone.isRemoved())) {
                String id = drone.getDroneId();
                if (!id.isBlank()) {
                    drones.putIfAbsent(id, drone);
                }
            }
        }
        return drones;
    }

    private static void follow(ServerPlayer player, DroneEntity drone) {
        if (player.level() != drone.level()) {
            player.teleportTo((ServerLevel) drone.level(), drone.getX(), drone.getY(), drone.getZ(),
                    Set.of(), drone.getYRot(), drone.getXRot(), false);
            makeSpectator(player);
            return;
        }

        // A hovering drone would otherwise cost a teleport packet every tick for no movement.
        if (player.position().distanceToSqr(drone.position()) <= MOVE_EPSILON_SQR) {
            return;
        }

        // teleportTo rather than setPos: it is what updates the server's chunk tracking for this
        // player, and that tracking is exactly what decides which chunks the agent gets sent.
        player.teleportTo(drone.getX(), drone.getY(), drone.getZ());
    }
}
