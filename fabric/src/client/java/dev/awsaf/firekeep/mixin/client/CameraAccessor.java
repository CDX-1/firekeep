package dev.awsaf.firekeep.mixin.client;

import net.minecraft.client.Camera;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * The camera's eye height is smoothed towards the camera entity's over several client ticks, and
 * the entity it smooths towards is the player - so a drone capture would otherwise sit 1.62 blocks
 * above the drone, at the player's eye height. A capture sets it outright and puts it back after.
 */
@Mixin(Camera.class)
public interface CameraAccessor {
    @Accessor("eyeHeight")
    float firekeep$eyeHeight();

    @Accessor("eyeHeight")
    void firekeep$setEyeHeight(float eyeHeight);

    @Accessor("eyeHeightOld")
    float firekeep$eyeHeightOld();

    @Accessor("eyeHeightOld")
    void firekeep$setEyeHeightOld(float eyeHeightOld);
}
