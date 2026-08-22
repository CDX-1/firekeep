package dev.awsaf.firekeep.mixin.client;

import dev.awsaf.firekeep.client.camera.DroneFeeds;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Drives drone captures once per rendered frame rather than once per client tick.
 *
 * <p>Client ticks come 20 times a second, which was the hard ceiling on the total feed frame rate
 * however few drones were flying. Frames come as fast as the game runs, and the tail of one is the
 * same safe spot between frames that the tick hook was - the frame has been presented, and the next
 * one has not started building yet.
 */
@Mixin(Minecraft.class)
public class MinecraftFrameMixin {
    @Inject(method = "renderFrame", at = @At("TAIL"))
    private void firekeep$captureDroneFeeds(boolean renderLevel, CallbackInfo callback) {
        DroneFeeds.onFrameRendered();
    }
}
