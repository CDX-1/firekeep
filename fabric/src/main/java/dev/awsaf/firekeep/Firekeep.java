package dev.awsaf.firekeep;

import dev.awsaf.firekeep.agent.AgentDirectoryServer;
import dev.awsaf.firekeep.agent.AgentSupervisor;
import dev.awsaf.firekeep.agent.DroneAgents;
import dev.awsaf.firekeep.command.DroneCommand;
import dev.awsaf.firekeep.drone.DroneManager;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import dev.awsaf.firekeep.live.WorldFeed;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Firekeep implements ModInitializer {
    public static final String MOD_ID = "firekeep";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public static Identifier id(String path) {
        return Identifier.fromNamespaceAndPath(MOD_ID, path);
    }

    @Override
    public void onInitialize() {
        FirekeepEntities.initialize();
        WorldFeed.initialize();
        DroneAgents.initialize();
        DroneManager.initialize();
        AgentSupervisor.initialize();
        AgentDirectoryServer.initialize();

        CommandRegistrationCallback.EVENT.register((dispatcher, buildContext, selection) ->
                DroneCommand.register(dispatcher));

        LOGGER.info("Fire Keep initialized");
    }
}
