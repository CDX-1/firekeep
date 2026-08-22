package dev.awsaf.firekeep.mixin.client;

import dev.awsaf.firekeep.client.agent.AgentMode;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

/**
 * Skips the agent's own view of the world: the single biggest saving in agent mode.
 *
 * <p>A normal client renders the level for the person at the keyboard, and only then does
 * {@code DroneFeeds} capture a drone on top - so every frame paid for two level renders and threw
 * one away. An agent has no viewer, so its own level render is switched off and the whole frame
 * goes to captures.
 *
 * <p>This flips vanilla's own {@code renderLevel} flag rather than cancelling the render outright.
 * Cancelling looked tempting and was wrong: the loading overlay decides it has finished from inside
 * {@code extractRenderState}, which {@code GameRenderer.render} drives, so an agent that skipped
 * the whole method sat on the loading screen forever and never connected. Leaving the method to run
 * keeps every screen and overlay ticking over normally, and the level - the expensive part, and the
 * only part an agent does not need - is what actually goes away.
 */
@Mixin(GameRenderer.class)
public class AgentRenderMixin {
    @ModifyVariable(method = "render", at = @At("HEAD"), argsOnly = true, index = 2)
    private boolean firekeep$skipOwnLevelRender(boolean renderLevel) {
        return !AgentMode.skipsOwnRender() && renderLevel;
    }
}
