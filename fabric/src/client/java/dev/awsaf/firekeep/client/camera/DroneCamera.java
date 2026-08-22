package dev.awsaf.firekeep.client.camera;

import com.mojang.blaze3d.GpuFormat;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.pipeline.TextureTarget;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.platform.Window;
import com.mojang.blaze3d.systems.RenderSystem;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.mixin.client.CameraAccessor;
import dev.awsaf.firekeep.mixin.client.GameRendererAccessor;
import net.minecraft.client.Camera;
import net.minecraft.client.CameraType;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.world.entity.Entity;
import org.joml.Vector4f;

import java.util.function.Consumer;

/**
 * Renders the level from a drone's point of view into an offscreen framebuffer.
 *
 * <p>This is vanilla's panorama trick with the expensive part taken out: point the game renderer at
 * a small persistent target, make the drone the camera entity, run one level render, and read the
 * pixels back. Everything is put back before the next real frame, so the player's view never
 * flickers.
 *
 * <p>Must be called on the render thread, and only one capture may be in flight - the read-back is
 * queued on the GPU and reads whatever is in the target when it lands, so a second render would
 * overwrite the frame the first one is still waiting for.
 */
public final class DroneCamera {
    /** Rendered at DeltaTracker.ONE: no interpolation, the drone exactly where the last tick left it. */
    private static final DeltaTracker DELTA = DeltaTracker.ONE;

    /** Opaque black behind the sky, so a frame that renders nothing is black rather than garbage. */
    private static final Vector4f CLEAR_COLOR = new Vector4f(0.0F, 0.0F, 0.0F, 1.0F);

    /** Vanilla clears depth to zero - the projection is reversed-Z, so zero is the far plane. */
    private static final double CLEAR_DEPTH = 0.0D;

    /** A read-back that has not landed by now is never going to; every feed waits on it, so give up. */
    private static final long READBACK_TIMEOUT_MILLIS = 2_000L;

    /**
     * One framebuffer per capture that can be in flight at once.
     *
     * <p>The GPU read-back lands a frame or two after the render that filled it, and reads whatever
     * is in the target at that point - so a capture cannot reuse a target another capture is still
     * waiting on. A handful of slots lets several captures overlap instead of one at a time, which
     * is what keeps the feeds moving when more drones are up than the frame rate can serve.
     */
    private static final Slot[] SLOTS = new Slot[CameraConfig.PIPELINE];

    private static int nextSlot;
    /** True only for the few statements a capture spends inside the game renderer. */
    private static boolean capturing;

    private DroneCamera() {
    }

    private static final class Slot {
        private RenderTarget target;
        private boolean busy;
        private long busySince;
        private int width;
        private int height;
    }

    /** True while a capture is inside the game renderer, so hooks can leave the player's frame alone. */
    public static boolean isCapturing() {
        return capturing;
    }

    /** True when every slot is waiting on a read-back, so no further capture can start this frame. */
    public static boolean isBusy() {
        return freeSlot() == null;
    }

    private static Slot freeSlot() {
        long now = System.currentTimeMillis();
        for (int i = 0; i < SLOTS.length; i++) {
            Slot slot = SLOTS[(nextSlot + i) % SLOTS.length];
            if (slot == null) {
                continue;
            }
            if (slot.busy && now - slot.busySince > READBACK_TIMEOUT_MILLIS) {
                Firekeep.LOGGER.warn("a drone camera read-back never came back; carrying on without it");
                slot.busy = false;
            }
            if (!slot.busy) {
                return slot;
            }
        }
        // Slots are created on demand so an unused pipeline costs no video memory.
        for (int i = 0; i < SLOTS.length; i++) {
            if (SLOTS[i] == null) {
                SLOTS[i] = new Slot();
                return SLOTS[i];
            }
        }
        return null;
    }

    /**
     * Renders one frame from {@code drone}'s camera.
     *
     * @param sink receives the frame on the render thread, some frames later, and owns closing it;
     *             it is not called if the read-back fails
     * @return false if another capture is still in flight or the client cannot render right now
     */
    public static boolean capture(Entity drone, int width, int height, Consumer<NativeImage> sink) {
        Minecraft client = Minecraft.getInstance();
        if (client.level == null || client.player == null || drone.isRemoved()) {
            return false;
        }
        if (drone.level() != client.level) {
            return false;
        }

        Slot slot = freeSlot();
        if (slot == null) {
            return false;
        }

        Window window = client.getWindow();
        GameRendererAccessor renderer = (GameRendererAccessor) client.gameRenderer;
        Camera camera = client.gameRenderer.mainCamera();
        CameraAccessor cameraState = (CameraAccessor) camera;

        RenderTarget previousTarget = client.gameRenderer.mainRenderTarget();
        Entity previousCamera = client.getCameraEntity();
        CameraType previousCameraType = client.options.getCameraType();
        float previousEyeHeight = cameraState.firekeep$eyeHeight();
        float previousEyeHeightOld = cameraState.firekeep$eyeHeightOld();
        int previousWidth = window.getWidth();
        int previousHeight = window.getHeight();

        slot.busy = true;
        slot.busySince = System.currentTimeMillis();
        nextSlot = (nextSlot + 1) % SLOTS.length;
        capturing = true;
        boolean queued = false;
        try {
            RenderTarget scratch = target(slot, width, height);
            clear(scratch);

            renderer.firekeep$setMainRenderTarget(scratch);
            // The projection and the frustum are both derived from the window, not from the target.
            window.setWidth(width);
            window.setHeight(height);
            client.options.setCameraType(CameraType.FIRST_PERSON);
            client.setCameraEntity(drone);
            client.gameRenderer.setRenderBlockOutline(false);
            // Panoramic mode is what keeps the player's own arm and held item out of the drone's
            // frame, and it pins the field of view at 90 degrees so the feed does not zoom around
            // with whatever the player's fov option or sprinting is doing.
            camera.enablePanoramicMode();
            cameraState.firekeep$setEyeHeight(drone.getEyeHeight());
            cameraState.firekeep$setEyeHeightOld(drone.getEyeHeight());

            client.gameRenderer.update(DELTA);
            client.gameRenderer.extract(DELTA, true);
            client.gameRenderer.renderLevel(DELTA);

            Screenshot.takeScreenshot(scratch, image -> {
                slot.busy = false;
                sink.accept(image);
            });
            endFrame(client, renderer);
            queued = true;
        } catch (Throwable t) {
            Firekeep.LOGGER.error("drone camera render failed", t);
        } finally {
            capturing = false;
            client.gameRenderer.setRenderBlockOutline(true);
            camera.disablePanoramicMode();
            cameraState.firekeep$setEyeHeight(previousEyeHeight);
            cameraState.firekeep$setEyeHeightOld(previousEyeHeightOld);
            client.setCameraEntity(previousCamera == null ? client.player : previousCamera);
            client.options.setCameraType(previousCameraType);
            window.setWidth(previousWidth);
            window.setHeight(previousHeight);
            renderer.firekeep$setMainRenderTarget(previousTarget);
            if (!queued) {
                slot.busy = false;
            }
        }
        return queued;
    }

    /**
     * Wipes the target before rendering into it.
     *
     * <p>{@code renderLevel} does not clear anything - vanilla clears the main target at the top of
     * {@code GameRenderer.render}, one step above it, and a capture never goes through that path.
     * So without this a slot still holds the colour and, worse, the depth of whatever it was last
     * used for: a different drone, {@code CameraConfig.PIPELINE} captures ago. Stale depth is what
     * makes it visible, because the sky is drawn at the far plane and loses the depth test against
     * any terrain left in the buffer - so the sky comes and goes as the slots cycle.
     */
    private static void clear(RenderTarget scratch) {
        RenderSystem.getDevice().createCommandEncoder().clearColorAndDepthTextures(
                scratch.getColorTexture(), CLEAR_COLOR, scratch.getDepthTexture(), CLEAR_DEPTH);
    }

    /**
     * Closes out the extra frame we just rendered.
     *
     * <p>Submitting first is what makes the capture show the drone's viewpoint rather than the
     * player's. Rendering only <em>records</em> draw calls, and the camera position they read lives
     * in the dynamic uniform ring buffer - so leaving them queued lets the player's next frame
     * overwrite that buffer, and the drone's geometry ends up drawn around the player. (Vanilla's
     * panorama grabber gets away with skipping this: it only ever turns the camera on the spot,
     * where the position it borrows is the right one anyway.)
     *
     * <p>The rest is the bookkeeping a real frame ends with: reset the uniform ring buffer, clear
     * the level renderer's per-frame state, hand the render targets back to the pool. Skipping any
     * of it leaks GPU memory on every capture.
     */
    private static void endFrame(Minecraft client, GameRendererAccessor renderer) {
        RenderSystem.getDevice().createCommandEncoder().submit();
        RenderSystem.getDynamicUniforms().reset();
        client.levelRenderer.endFrame();
        renderer.firekeep$resourcePool().endFrame();
    }

    /** Frees the offscreen targets; call when the client leaves a world. */
    public static void release() {
        for (int i = 0; i < SLOTS.length; i++) {
            Slot slot = SLOTS[i];
            if (slot == null || slot.target == null) {
                continue;
            }
            if (slot.busy) {
                // A queued read-back still points at this target's texture. It is half a megabyte;
                // keeping it until the next world costs far less than freeing it under the GPU.
                continue;
            }
            slot.target.destroyBuffers();
            slot.target = null;
            slot.width = 0;
            slot.height = 0;
            SLOTS[i] = null;
        }
    }

    private static RenderTarget target(Slot slot, int width, int height) {
        if (slot.target == null) {
            slot.target = new TextureTarget("firekeep drone camera", width, height, true, GpuFormat.RGBA8_UNORM);
        } else if (slot.width != width || slot.height != height) {
            slot.target.resize(width, height);
        }
        slot.width = width;
        slot.height = height;
        return slot.target;
    }
}
