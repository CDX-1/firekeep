package dev.awsaf.firekeep;

import dev.awsaf.firekeep.command.DroneCommand;
import dev.awsaf.firekeep.entity.FirekeepEntities;
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

        CommandRegistrationCallback.EVENT.register((dispatcher, buildContext, selection) ->
                DroneCommand.register(dispatcher));

        LOGGER.info("Fire Keep initialized");
    }
}
