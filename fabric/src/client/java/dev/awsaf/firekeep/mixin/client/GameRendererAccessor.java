package dev.awsaf.firekeep.mixin.client;

import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.resource.CrossFrameResourcePool;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Mutable;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * Lets the drone cameras point the level renderer at their own small framebuffer for one render.
 *
 * <p>Vanilla's panorama grabber gets the same effect by resizing the real main target, but that
 * reallocates a screen-sized colour and depth texture twice per capture. Drone feeds capture many
 * times a second, so they swap in a persistent target instead and put the original back.
 */
@Mixin(GameRenderer.class)
public interface GameRendererAccessor {
    @Mutable
    @Accessor("mainRenderTarget")
    void firekeep$setMainRenderTarget(RenderTarget target);

    /**
     * The pool the level passes borrow their targets from. {@code GameRenderer.render} hands it back
     * at the end of every frame; a capture calls {@code renderLevel} directly and has to do the same,
     * or each frame leaks its render targets.
     */
    @Accessor("resourcePool")
    CrossFrameResourcePool firekeep$resourcePool();
}
