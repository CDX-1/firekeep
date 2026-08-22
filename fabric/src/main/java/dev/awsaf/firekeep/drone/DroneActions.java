package dev.awsaf.firekeep.drone;

import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LevelEvent;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;

/**
 * The things a drone does to the world rather than to itself. Server thread only.
 *
 * <p>Kept apart from the flight controller because these are the only operations in the whole
 * bridge that mutate the world, and they are the ones worth being able to find, audit and cap in
 * one place.
 */
public final class DroneActions {
    /** How far below the drone to look for the ground before giving up on a water drop. */
    private static final int GROUND_SEARCH = 24;

    private DroneActions() {
    }

    /** What one water drop achieved, so the report back to n8n can be specific. */
    public record WaterDrop(int extinguished, int remainingFires, int lavaFound, BlockPos impact) {
    }

    /**
     * Puts out every fire within {@code radius} of the ground beneath the drone.
     *
     * <p>Lava is counted but not touched: turning a lava flow to stone is a terrain edit an
     * autonomous agent should not be making on its own, and the count is what lets the model ask
     * for one deliberately.
     */
    public static WaterDrop dispenseWater(ServerLevel level, Vec3 from, int radius, boolean placeSource) {
        BlockPos impact = groundBelow(level, from);
        if (impact == null) {
            return new WaterDrop(0, 0, 0, null);
        }

        List<BlockPos> fires = new ArrayList<>();
        int lava = 0;
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        // The impact can be a leaf canopy. Search through the bounded drop column so a
        // suppression drone reaches flames burning below trees, not just the treetops.
        for (int dy = -GROUND_SEARCH; dy <= radius + 2; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    cursor.set(impact.getX() + dx, impact.getY() + dy, impact.getZ() + dz);
                    if (!level.isLoaded(cursor)) {
                        continue;
                    }
                    BlockState state = level.getBlockState(cursor);
                    BlockClass blockClass = BlockClass.of(state, level, cursor);
                    if (blockClass == BlockClass.FIRE) {
                        fires.add(cursor.immutable());
                    } else if (blockClass == BlockClass.LAVA) {
                        lava++;
                    }
                }
            }
        }

        for (BlockPos fire : fires) {
            level.removeBlock(fire, false);
            level.levelEvent(LevelEvent.SOUND_EXTINGUISH_FIRE, fire, 0);
        }

        if (placeSource) {
            BlockPos above = impact.above();
            if (level.getBlockState(above).isAir()) {
                level.setBlockAndUpdate(above, Blocks.WATER.defaultBlockState());
            }
        }

        level.sendParticles(ParticleTypes.SPLASH, impact.getX() + 0.5D, impact.getY() + 1.0D,
                impact.getZ() + 0.5D, 60, radius * 0.5D, 0.5D, radius * 0.5D, 0.05D);
        // Confirm the result in the same region after the action. This is cheap (the bounded
        // action volume was just read) and prevents a dashboard from calling a live fire clear.
        int remaining = 0;
        for (int dy = -GROUND_SEARCH; dy <= radius + 2; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    cursor.set(impact.getX() + dx, impact.getY() + dy, impact.getZ() + dz);
                    if (level.isLoaded(cursor)
                            && BlockClass.of(level.getBlockState(cursor), level, cursor) == BlockClass.FIRE) {
                        remaining++;
                    }
                }
            }
        }
        return new WaterDrop(fires.size(), remaining, lava, impact);
    }

    /** The first solid block under {@code from}, or null if there is none within reach. */
    public static BlockPos groundBelow(ServerLevel level, Vec3 from) {
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        int startY = Mth.floor(from.y);
        for (int dy = 0; dy <= GROUND_SEARCH; dy++) {
            int y = startY - dy;
            if (y < level.getMinY()) {
                return null;
            }
            cursor.set(Mth.floor(from.x), y, Mth.floor(from.z));
            if (!level.isLoaded(cursor)) {
                return null;
            }
            BlockClass blockClass = BlockClass.of(level.getBlockState(cursor), level, cursor);
            // A canopy stops the drop, which is the right answer for a fire burning under trees.
            if (blockClass != BlockClass.AIR && blockClass != BlockClass.PLANT) {
                return cursor.immutable();
            }
        }
        return null;
    }
}
