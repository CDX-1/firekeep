package dev.awsaf.firekeep.client.capture;

import com.mojang.blaze3d.platform.NativeImage;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.CompletableFuture;

/**
 * Grabs a clean frame off the GPU and hands it back as PNG bytes.
 *
 * <p>The command asking for a shot is still running inside the chat screen, and the HUD is whatever
 * the player left it as - both of which Marble would happily reconstruct as floating 3D geometry.
 * So a request waits for the chat screen to close, hides the HUD, lets a couple of frames render,
 * captures, and only puts the HUD back once the pixels are actually off the GPU.
 */
public final class FrameGrabber {
    /** Longest we wait for the chat screen to go away before grabbing anyway. */
    private static final int SCREEN_TIMEOUT_TICKS = 40;
    /** Frames to let render with the HUD hidden before the capture. */
    private static final int SETTLE_TICKS = 2;
    /** The GPU read-back is asynchronous; give up on it rather than leave the HUD hidden forever. */
    private static final int READBACK_TIMEOUT_TICKS = 100;
    /** Longest edge of the uploaded image; Marble does not need a 5K retina frame. */
    private static final int MAX_EDGE = 1920;

    private static final Deque<Request> PENDING = new ArrayDeque<>();

    private FrameGrabber() {
    }

    public static void initialize() {
        ClientTickEvents.END_CLIENT_TICK.register(FrameGrabber::tick);
    }

    /**
     * Queue a capture. The returned future completes off the render thread with PNG bytes, or
     * completes exceptionally if the framebuffer could not be read.
     */
    public static CompletableFuture<byte[]> grab(boolean hideHud) {
        Request request = new Request(hideHud);
        Minecraft.getInstance().execute(() -> PENDING.add(request));
        return request.result;
    }

    private static void tick(Minecraft client) {
        Request request = PENDING.peek();
        if (request != null && request.advance(client)) {
            PENDING.poll();
        }
    }

    private enum Phase {
        WAITING_FOR_SCREEN,
        SETTLING,
        READING_BACK
    }

    private static final class Request {
        private final boolean hideHud;
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();

        private Phase phase = Phase.WAITING_FOR_SCREEN;
        private int ticksInPhase;
        private boolean hudWasHidden;
        private volatile boolean pixelsRead;

        private Request(boolean hideHud) {
            this.hideHud = hideHud;
        }

        /** @return true once this request is done with and can leave the queue. */
        private boolean advance(Minecraft client) {
            switch (phase) {
                case WAITING_FOR_SCREEN -> {
                    if (client.gui.screen() != null && ticksInPhase++ < SCREEN_TIMEOUT_TICKS) {
                        return false;
                    }
                    hudWasHidden = client.gui.hud.isHidden();
                    if (hideHud && !hudWasHidden) {
                        client.gui.hud.toggle();
                    }
                    enter(Phase.SETTLING);
                    return false;
                }
                case SETTLING -> {
                    if (ticksInPhase++ < SETTLE_TICKS) {
                        return false;
                    }
                    enter(Phase.READING_BACK);
                    try {
                        capture(client);
                    } catch (Throwable t) {
                        result.completeExceptionally(t);
                        restoreHud(client);
                        return true;
                    }
                    return false;
                }
                default -> {
                    // the HUD has to stay hidden until the read-back lands: the copy is queued on
                    // the command encoder and may not run until a later frame
                    if (!pixelsRead && ticksInPhase++ < READBACK_TIMEOUT_TICKS) {
                        return false;
                    }
                    restoreHud(client);
                    if (!pixelsRead) {
                        result.completeExceptionally(new IOException("the GPU never handed back a frame"));
                    }
                    return true;
                }
            }
        }

        private void enter(Phase next) {
            phase = next;
            ticksInPhase = 0;
        }

        private void capture(Minecraft client) {
            Screenshot.takeScreenshot(client.gameRenderer.mainRenderTarget(), image -> {
                int width;
                int height;
                int[] abgr;
                try (NativeImage owned = image) {
                    width = owned.getWidth();
                    height = owned.getHeight();
                    abgr = owned.getPixelsABGR();       // one bulk copy, then off the render thread
                } catch (Throwable t) {
                    pixelsRead = true;
                    result.completeExceptionally(t);
                    return;
                }
                pixelsRead = true;

                int w = width;
                int h = height;
                CompletableFuture.supplyAsync(() -> encode(abgr, w, h))
                        .whenComplete((png, error) -> {
                            if (error != null) {
                                result.completeExceptionally(error);
                            } else {
                                result.complete(png);
                            }
                        });
            });
        }

        private void restoreHud(Minecraft client) {
            if (hideHud && !hudWasHidden && client.gui.hud.isHidden()) {
                client.gui.hud.toggle();
            }
        }
    }

    private static byte[] encode(int[] abgr, int width, int height) {
        int[] argb = new int[abgr.length];
        for (int i = 0; i < abgr.length; i++) {
            int p = abgr[i];
            // NativeImage packs RGBA bytes little-endian, so an int reads as 0xAABBGGRR
            argb[i] = (p & 0xFF00FF00) | ((p & 0xFF) << 16) | ((p >> 16) & 0xFF);
        }

        BufferedImage full = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        full.setRGB(0, 0, width, height, argb, 0, width);

        ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 20);
        try {
            ImageIO.write(downscale(full, width, height), "png", buffer);
        } catch (IOException e) {
            throw new RuntimeException("could not encode the screenshot as PNG", e);
        }
        return buffer.toByteArray();
    }

    private static BufferedImage downscale(BufferedImage source, int width, int height) {
        int longest = Math.max(width, height);
        if (longest <= MAX_EDGE) {
            return source;
        }
        int w = Math.max(1, Math.round(width * (float) MAX_EDGE / longest));
        int h = Math.max(1, Math.round(height * (float) MAX_EDGE / longest));

        BufferedImage scaled = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = scaled.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(source, 0, 0, w, h, null);
        g.dispose();
        return scaled;
    }
}
