package dev.awsaf.firekeep.client;

import dev.awsaf.firekeep.client.render.DroneModel;
import dev.awsaf.firekeep.client.render.DroneRenderer;
import dev.awsaf.firekeep.client.render.FirekeepModelLayers;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.ModelLayerRegistry;
import net.minecraft.client.renderer.entity.EntityRenderers;

public class FirekeepClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        ModelLayerRegistry.registerModelLayer(FirekeepModelLayers.DRONE, DroneModel::createBodyLayer);
        EntityRenderers.register(FirekeepEntities.DRONE, DroneRenderer::new);
    }
}
