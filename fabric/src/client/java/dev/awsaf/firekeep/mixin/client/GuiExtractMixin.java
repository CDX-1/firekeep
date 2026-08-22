package dev.awsaf.firekeep.mixin.client;

import dev.awsaf.firekeep.client.camera.DroneCamera;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.gui.Gui;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Leaves the player's HUD alone while a drone frame is being captured.
 *
 * <p>A capture reuses {@code GameRenderer.extract}, which rebuilds the GUI render state as well as
 * the level's. Some of what the HUD extracts is consumed rather than copied - the debug overlay's
 * per-frame samples, for one - so an extra extract per capture leaves the player's own frame
 * drawing a half-empty overlay. Drone captures never draw the HUD, so they can skip it entirely.
 */
@Mixin(Gui.class)
public class GuiExtractMixin {
    @Inject(method = "extractRenderState", at = @At("HEAD"), cancellable = true)
    private void firekeep$skipWhileCapturing(DeltaTracker deltaTracker, boolean sleeping,
                                             boolean hudHidden, CallbackInfo callback) {
        if (DroneCamera.isCapturing()) {
            callback.cancel();
        }
    }
}
