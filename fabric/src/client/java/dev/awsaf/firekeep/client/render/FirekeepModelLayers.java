package dev.awsaf.firekeep.client.render;

import dev.awsaf.firekeep.Firekeep;
import net.minecraft.client.model.geom.ModelLayerLocation;

public final class FirekeepModelLayers {
    public static final ModelLayerLocation DRONE = new ModelLayerLocation(Firekeep.id("drone"), "main");

    private FirekeepModelLayers() {
    }
}
