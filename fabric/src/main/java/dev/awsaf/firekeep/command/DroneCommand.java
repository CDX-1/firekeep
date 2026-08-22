package dev.awsaf.firekeep.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.awsaf.firekeep.agent.AgentSupervisor;
import dev.awsaf.firekeep.agent.DroneAgents;
import dev.awsaf.firekeep.entity.DroneEntity;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Manual controls for drones, mostly a testing surface until the Fire Keep server drives them.
 *
 * <pre>
 * /drone spawn [&lt;pos&gt;] [&lt;id&gt;]
 * /drone goto &lt;drones&gt; &lt;pos&gt;
 * /drone speed &lt;drones&gt; &lt;blocksPerSecond&gt;
 * /drone look &lt;drones&gt; &lt;yaw&gt; &lt;pitch&gt;
 * /drone stop &lt;drones&gt;
 * /drone remove &lt;drones&gt;
 * /drone list
 * /drone agent &lt;player&gt; &lt;droneId&gt;
 * /drone agent clear &lt;player&gt;
 * /drone agent deploy &lt;droneId&gt;
 * /drone agent undeploy &lt;droneId&gt;
 * /drone agent status
 * </pre>
 */
public final class DroneCommand {
    private static final int TICKS_PER_SECOND = 20;

    private DroneCommand() {
    }

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("drone")
                .requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
                .then(Commands.literal("spawn")
                        .executes(ctx -> spawn(ctx.getSource(), ctx.getSource().getPosition(), ""))
                        .then(Commands.argument("pos", Vec3Argument.vec3())
                                .executes(ctx -> spawn(ctx.getSource(), Vec3Argument.getVec3(ctx, "pos"), ""))
                                .then(Commands.argument("id", StringArgumentType.word())
                                        .executes(ctx -> spawn(ctx.getSource(), Vec3Argument.getVec3(ctx, "pos"),
                                                StringArgumentType.getString(ctx, "id"))))))
                .then(Commands.literal("goto")
                        .then(Commands.argument("drones", EntityArgument.entities())
                                .then(Commands.argument("pos", Vec3Argument.vec3())
                                        .executes(ctx -> {
                                            Vec3 target = Vec3Argument.getVec3(ctx, "pos");
                                            return forEachDrone(ctx, drone -> drone.setTargetPosition(target),
                                                    count -> "Sent " + count + " drone(s) to " + format(target));
                                        }))))
                .then(Commands.literal("speed")
                        .then(Commands.argument("drones", EntityArgument.entities())
                                .then(Commands.argument("blocksPerSecond", DoubleArgumentType.doubleArg(0.1D, 60.0D))
                                        .executes(ctx -> {
                                            double perSecond = DoubleArgumentType.getDouble(ctx, "blocksPerSecond");
                                            return forEachDrone(ctx, drone -> drone.setMaxSpeed(perSecond / TICKS_PER_SECOND),
                                                    count -> "Set " + count + " drone(s) to " + perSecond + " blocks/s");
                                        }))))
                .then(Commands.literal("look")
                        .then(Commands.argument("drones", EntityArgument.entities())
                                .then(Commands.argument("yaw", DoubleArgumentType.doubleArg(-180.0D, 180.0D))
                                        .then(Commands.argument("pitch", DoubleArgumentType.doubleArg(-90.0D, 90.0D))
                                                .executes(ctx -> {
                                                    float yaw = (float) DoubleArgumentType.getDouble(ctx, "yaw");
                                                    float pitch = (float) DoubleArgumentType.getDouble(ctx, "pitch");
                                                    return forEachDrone(ctx, drone -> {
                                                        drone.setYawFollowsMotion(false);
                                                        drone.setLook(yaw, pitch);
                                                    }, count -> "Aimed " + count + " drone(s)");
                                                })))))
                .then(Commands.literal("stop")
                        .then(Commands.argument("drones", EntityArgument.entities())
                                .executes(ctx -> forEachDrone(ctx, DroneEntity::hover,
                                        count -> "Stopped " + count + " drone(s)"))))
                .then(Commands.literal("remove")
                        .then(Commands.argument("drones", EntityArgument.entities())
                                .executes(ctx -> forEachDrone(ctx, drone -> drone.discard(),
                                        count -> "Removed " + count + " drone(s)"))))
                .then(Commands.literal("agent")
                        .then(Commands.literal("deploy")
                                .then(Commands.argument("droneId", StringArgumentType.word())
                                        .executes(ctx -> {
                                            String reply = AgentSupervisor.deploy(
                                                    StringArgumentType.getString(ctx, "droneId"));
                                            ctx.getSource().sendSuccess(() -> Component.literal(reply), true);
                                            return 1;
                                        })))
                        .then(Commands.literal("undeploy")
                                .then(Commands.argument("droneId", StringArgumentType.word())
                                        .executes(ctx -> {
                                            String reply = AgentSupervisor.undeploy(
                                                    StringArgumentType.getString(ctx, "droneId"));
                                            ctx.getSource().sendSuccess(() -> Component.literal(reply), true);
                                            return 1;
                                        })))
                        .then(Commands.literal("status")
                                .executes(ctx -> {
                                    for (String line : AgentSupervisor.status()) {
                                        ctx.getSource().sendSuccess(() -> Component.literal("  " + line), false);
                                    }
                                    return 1;
                                }))
                        .then(Commands.literal("clear")
                                .then(Commands.argument("player", EntityArgument.player())
                                        .executes(ctx -> {
                                            ServerPlayer player = EntityArgument.getPlayer(ctx, "player");
                                            DroneAgents.clear(player);
                                            ctx.getSource().sendSuccess(() -> Component.literal(
                                                    "Released agent " + player.getGameProfile().name()), true);
                                            return 1;
                                        })))
                        .then(Commands.argument("player", EntityArgument.player())
                                .then(Commands.argument("droneId", StringArgumentType.word())
                                        .executes(ctx -> {
                                            ServerPlayer player = EntityArgument.getPlayer(ctx, "player");
                                            String droneId = StringArgumentType.getString(ctx, "droneId");
                                            DroneAgents.assign(player, droneId);
                                            ctx.getSource().sendSuccess(() -> Component.literal(
                                                    player.getGameProfile().name() + " is now filming " + droneId), true);
                                            return 1;
                                        }))))
                .then(Commands.literal("list")
                        .executes(ctx -> list(ctx.getSource()))));
    }

    private static int spawn(CommandSourceStack source, Vec3 position, String droneId) {
        ServerLevel level = source.getLevel();
        float yaw = source.getRotation().y;
        DroneEntity drone = FirekeepEntities.spawn(level, position, yaw);
        if (drone == null) {
            source.sendFailure(Component.literal("Could not create a drone"));
            return 0;
        }

        if (!droneId.isEmpty()) {
            drone.setDroneId(droneId);
        }

        source.sendSuccess(() -> Component.literal("Drone " + drone.getId() + " deployed at " + format(position)), true);
        return 1;
    }

    private static int list(CommandSourceStack source) {
        List<? extends DroneEntity> drones =
                source.getLevel().getEntities(FirekeepEntities.DRONE, drone -> true);

        if (drones.isEmpty()) {
            source.sendSuccess(() -> Component.literal("No drones in this dimension"), false);
            return 0;
        }

        source.sendSuccess(() -> Component.literal("Drones in this dimension: " + drones.size()), false);
        for (DroneEntity drone : drones) {
            String label = drone.getDroneId().isEmpty() ? "#" + drone.getId() : drone.getDroneId();
            String target = drone.hasTarget() ? " -> " + format(drone.getTargetPosition()) : " (hovering)";
            source.sendSuccess(() -> Component.literal("  " + label + " at " + format(drone.position()) + target), false);
        }
        return drones.size();
    }

    private static int forEachDrone(CommandContext<CommandSourceStack> ctx, DroneAction action, FeedbackMessage feedback)
            throws CommandSyntaxException {
        List<DroneEntity> drones = collectDrones(EntityArgument.getEntities(ctx, "drones"));
        if (drones.isEmpty()) {
            ctx.getSource().sendFailure(Component.literal("No drones matched that selector"));
            return 0;
        }

        for (DroneEntity drone : drones) {
            action.apply(drone);
        }

        int count = drones.size();
        ctx.getSource().sendSuccess(() -> Component.literal(feedback.forCount(count)), true);
        return count;
    }

    private static List<DroneEntity> collectDrones(Collection<? extends Entity> entities) {
        List<DroneEntity> drones = new ArrayList<>();
        for (Entity entity : entities) {
            if (entity instanceof DroneEntity drone) {
                drones.add(drone);
            }
        }
        return drones;
    }

    private static String format(Vec3 position) {
        return String.format("%.1f, %.1f, %.1f", position.x, position.y, position.z);
    }

    @FunctionalInterface
    private interface DroneAction {
        void apply(DroneEntity drone);
    }

    @FunctionalInterface
    private interface FeedbackMessage {
        String forCount(int count);
    }
}
