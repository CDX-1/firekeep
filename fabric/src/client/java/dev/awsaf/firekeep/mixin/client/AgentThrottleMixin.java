package dev.awsaf.firekeep.mixin.client;

import com.mojang.blaze3d.platform.FramerateLimitTracker;
import dev.awsaf.firekeep.client.agent.AgentMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Stops the client throttling an agent down to a crawl.
 *
 * <p>Vanilla drops the frame rate hard when nobody is interacting - {@code SHORT_AFK} and
 * {@code LONG_AFK} because no input has arrived, {@code WINDOW_ICONIFIED} because the window is not
 * on screen. An agent is permanently all three by design, so without this every feed would grind to
 * a few frames a second the moment it settled in. There is no options value that means "never", so
 * the reason is forced to {@code NONE} instead.
 */
@Mixin(FramerateLimitTracker.class)
public class AgentThrottleMixin {
    @Inject(method = "getThrottleReason", at = @At("HEAD"), cancellable = true)
    private void firekeep$neverThrottle(CallbackInfoReturnable<FramerateLimitTracker.FramerateThrottleReason> callback) {
        if (AgentMode.isAgent()) {
            callback.setReturnValue(FramerateLimitTracker.FramerateThrottleReason.NONE);
        }
    }

    @Inject(method = "isHeavilyThrottled", at = @At("HEAD"), cancellable = true)
    private void firekeep$neverHeavilyThrottled(CallbackInfoReturnable<Boolean> callback) {
        if (AgentMode.isAgent()) {
            callback.setReturnValue(false);
        }
    }
}
