package dev.awsaf.firekeep.live;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.material.MapColor;

/**
 * Turns one block column into the pixel a top-down map would show for it.
 *
 * <p>This is vanilla's own map logic, not an approximation of it: the colour comes from
 * {@link BlockState#getMapColor}, and the light and dark tiers are {@link MapColor.Brightness},
 * chosen by comparing the column to the one immediately north of it - which is what gives a
 * Minecraft map its sense of relief. Water is shaded by depth instead, same as vanilla.
 *
 * <p>Everything here reads chunks that are already loaded and never triggers generation, so it
 * is safe to call from the server thread.
 */
public final class Surface {
    /** Set on columns that are on fire or covered in lava. */
    public static final int HOT = 1 << 0;
    /** The column had nothing to paint - outside the world, or an unloaded neighbour. */
    public static final int EMPTY = 1 << 1;

    private Surface() {
    }

    /**
     * Samples one column.
     *
     * @return the map colour in the low 24 bits, flags in the high 8
     */
    public static int sample(ServerLevel level, LevelChunk chunk, int worldX, int worldZ,
                             BlockPos.MutableBlockPos scratch) {
        int minY = level.getMinY();
        int surfaceY = topOf(level, chunk, worldX, worldZ, scratch);
        if (surfaceY < minY) {
            return pack(0, EMPTY);
        }

        scratch.set(worldX, surfaceY, worldZ);
        BlockState state = chunk.getBlockState(scratch);
        MapColor color = state.getMapColor(level, scratch);

        int flags = state.getFluidState().is(net.minecraft.tags.FluidTags.LAVA)
                || color == MapColor.FIRE ? HOT : 0;

        MapColor.Brightness brightness;
        int waterDepth = waterDepth(chunk, worldX, worldZ, surfaceY);
        if (waterDepth > 0) {
            // vanilla shades open water by how deep it is, with a checker to break up the banding
            double shade = waterDepth * 0.1D + ((worldX + worldZ) & 1) * 0.2D;
            brightness = shade < 0.5D ? MapColor.Brightness.HIGH
                    : shade > 0.9D ? MapColor.Brightness.LOW : MapColor.Brightness.NORMAL;
        } else {
            int north = northHeight(level, chunk, worldX, worldZ, surfaceY, scratch);
            double shade = (surfaceY - north) + (((worldX + worldZ) & 1) - 0.5D) * 0.4D;
            brightness = shade > 0.6D ? MapColor.Brightness.HIGH
                    : shade < -0.6D ? MapColor.Brightness.LOW : MapColor.Brightness.NORMAL;
        }

        return pack(color.calculateARGBColor(brightness) & 0xFFFFFF, flags);
    }

    /** Highest block in the column that actually paints on a map, or below the floor if none does. */
    private static int topOf(ServerLevel level, LevelChunk chunk, int worldX, int worldZ,
                             BlockPos.MutableBlockPos scratch) {
        int minY = level.getMinY();
        int y = chunk.getHeight(Heightmap.Types.WORLD_SURFACE, worldX & 15, worldZ & 15) + 1;
        while (y > minY) {
            y--;
            scratch.set(worldX, y, worldZ);
            if (chunk.getBlockState(scratch).getMapColor(level, scratch) != MapColor.NONE) {
                return y;
            }
        }
        return minY - 1;
    }

    /** Blocks of water sitting on top of the floor, or 0 when the column is dry. */
    private static int waterDepth(LevelChunk chunk, int worldX, int worldZ, int surfaceY) {
        int floor = chunk.getHeight(Heightmap.Types.OCEAN_FLOOR, worldX & 15, worldZ & 15);
        return Math.max(0, surfaceY - floor);
    }

    /**
     * Surface height of the column one step north, for the relief shading.
     *
     * <p>Falls back to this column's own height when north is in a chunk that is not loaded:
     * a flat pixel is better than dragging a chunk into memory to shade one dot.
     */
    private static int northHeight(ServerLevel level, LevelChunk chunk, int worldX, int worldZ,
                                   int fallback, BlockPos.MutableBlockPos scratch) {
        int northZ = worldZ - 1;
        LevelChunk northChunk = (northZ >> 4) == (worldZ >> 4)
                ? chunk
                : level.getChunkSource().getChunkNow(worldX >> 4, northZ >> 4);
        if (northChunk == null) {
            return fallback;
        }
        int y = topOf(level, northChunk, worldX, northZ, scratch);
        return y < level.getMinY() ? fallback : y;
    }

    private static int pack(int rgb, int flags) {
        return ((flags & 0xFF) << 24) | (rgb & 0xFFFFFF);
    }
}
