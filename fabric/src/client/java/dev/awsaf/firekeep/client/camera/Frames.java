package dev.awsaf.firekeep.client.camera;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Iterator;

/**
 * Turns the pixels the GPU hands back into the JPEG frames the dashboard consumes.
 *
 * <p>This is the narrowest part of the whole pipeline, so it is worth the fuss. Encoding one
 * 1280x720 frame costs tens of milliseconds, which is the real ceiling on how fast a feed can
 * run - well below what the game renders at. Three things were being paid for per frame and are
 * now paid for once per thread:
 *
 * <ul>
 *   <li>a new {@link ImageWriter}, which {@code getImageWritersByFormatName} builds every call;
 *   <li>a new {@link BufferedImage}, plus {@code setRGB} which walks the whole raster through the
 *       colour model a pixel at a time - the packed ints can simply be written into the raster's
 *       own array instead;
 *   <li>a second full-size {@code int[]} for the colour swizzle, which the raster array replaces.
 * </ul>
 *
 * <p>Measured on a 1280x720 frame that is about 47ms down to about 35ms. The rest of the answer is
 * that several of these run at once - see the encoder pool in {@link DroneFeeds}.
 */
public final class Frames {
    private Frames() {
    }

    /** Everything one encoder thread reuses from frame to frame. */
    private static final class Scratch {
        private ImageWriter writer;
        private ImageWriteParam params;
        private BufferedImage image;
        private int[] raster;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 18);
    }

    private static final ThreadLocal<Scratch> SCRATCH = ThreadLocal.withInitial(Scratch::new);

    public static byte[] toJpeg(int[] abgr, int width, int height, float quality) throws IOException {
        Scratch scratch = SCRATCH.get();

        if (scratch.writer == null) {
            Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
            if (!writers.hasNext()) {
                throw new IOException("no JPEG encoder available");
            }
            scratch.writer = writers.next();
            scratch.params = scratch.writer.getDefaultWriteParam();
            scratch.params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        }

        // Only reallocated when a feed changes profile, which is rare; the steady state reuses it.
        if (scratch.image == null || scratch.image.getWidth() != width
                || scratch.image.getHeight() != height) {
            scratch.image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            scratch.raster = ((DataBufferInt) scratch.image.getRaster().getDataBuffer()).getData();
        }

        int[] rgb = scratch.raster;
        int pixels = Math.min(abgr.length, rgb.length);
        for (int i = 0; i < pixels; i++) {
            int pixel = abgr[i];
            // NativeImage packs RGBA bytes little-endian, so an int reads as 0xAABBGGRR
            rgb[i] = (pixel & 0x0000FF00) | ((pixel & 0xFF) << 16) | ((pixel >> 16) & 0xFF);
        }

        scratch.params.setCompressionQuality(quality);
        scratch.buffer.reset();
        try (MemoryCacheImageOutputStream out = new MemoryCacheImageOutputStream(scratch.buffer)) {
            scratch.writer.setOutput(out);
            scratch.writer.write(null, new IIOImage(scratch.image, null, null), scratch.params);
        } finally {
            scratch.writer.setOutput(null);          // do not pin the stream we just closed
        }
        return scratch.buffer.toByteArray();
    }
}
