package dev.awsaf.firekeep.client.camera;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Iterator;

/** Turns the pixels the GPU hands back into the JPEG frames the dashboard consumes. */
public final class Frames {
    private Frames() {
    }

    public static byte[] toJpeg(int[] abgr, int width, int height, float quality) throws IOException {
        int[] rgb = new int[abgr.length];
        for (int i = 0; i < abgr.length; i++) {
            int pixel = abgr[i];
            // NativeImage packs RGBA bytes little-endian, so an int reads as 0xAABBGGRR
            rgb[i] = (pixel & 0x0000FF00) | ((pixel & 0xFF) << 16) | ((pixel >> 16) & 0xFF);
        }

        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, width, height, rgb, 0, width);

        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("no JPEG encoder available");
        }

        ImageWriter writer = writers.next();
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 16);
        try (MemoryCacheImageOutputStream out = new MemoryCacheImageOutputStream(buffer)) {
            writer.setOutput(out);
            ImageWriteParam params = writer.getDefaultWriteParam();
            params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            params.setCompressionQuality(quality);
            writer.write(null, new IIOImage(image, null, null), params);
        } finally {
            writer.dispose();
        }
        return buffer.toByteArray();
    }
}
