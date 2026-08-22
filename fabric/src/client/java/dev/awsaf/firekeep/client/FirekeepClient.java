package dev.awsaf.firekeep.client;

import dev.awsaf.firekeep.client.agent.AgentMode;
import dev.awsaf.firekeep.client.camera.CameraServer;
import dev.awsaf.firekeep.client.camera.DroneFeeds;
import dev.awsaf.firekeep.client.capture.FrameGrabber;
import dev.awsaf.firekeep.client.command.ScreenshotCommand;
import dev.awsaf.firekeep.client.render.DroneModel;
import dev.awsaf.firekeep.client.render.DroneRenderer;
import dev.awsaf.firekeep.client.render.FirekeepModelLayers;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.rendering.v1.ModelLayerRegistry;
import net.minecraft.client.renderer.entity.EntityRenderers;

public class FirekeepClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        ModelLayerRegistry.registerModelLayer(FirekeepModelLayers.DRONE, DroneModel::createBodyLayer);
        EntityRenderers.register(FirekeepEntities.DRONE, DroneRenderer::new);

        FrameGrabber.initialize();
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, buildContext) ->
                ScreenshotCommand.register(dispatcher));

        AgentMode.initialize();

        // Only agents film drones. A human's client keeps its frame to itself, and leaves the
        // camera port free for an agent running on the same machine.
        if (AgentMode.shouldCaptureFeeds()) {
            DroneFeeds.initialize();
            CameraServer.start();
        }
    }
}
