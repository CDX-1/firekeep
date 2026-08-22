package dev.awsaf.firekeep.drone;

import net.minecraft.world.phys.Vec3;

import java.util.List;

/**
 * The raw result of one look at the world, captured on the server thread and safe to hand off.
 *
 * <p>Nothing in here is a live Minecraft object, which is the whole point: the expensive part of
 * perception is reading blocks, and that has to happen on the server thread, but turning a grid of
 * class bytes into prose does not. This record is the boundary between the two.
 *
 * <p>{@code cells} is indexed {@code ((dy * side) + dz) * side + dx} and holds
 * {@link BlockClass} ordinals; {@code blocks} is the same shape and holds indices into
 * {@code palette}, so a cluster can be named after the block it is actually made of.
 */
public record PerceptionScan(
        String droneId,
        String dimension,
        long gameTime,
        Vec3 position,
        float yaw,
        float pitch,
        Vec3 velocity,
        DroneStatus status,
        String activeCommand,
        Vec3 home,
        int hRadius,
        int vRadius,
        int side,
        int height,
        int originX,
        int originY,
        int originZ,
        byte[] cells,
        short[] blocks,
        List<String> palette,
        String biome,
        int groundY,
        String groundBlock,
        boolean raining,
        boolean thundering,
        List<EntitySighting> entities) {

    public int index(int dx, int dy, int dz) {
        return ((dy * this.side) + dz) * this.side + dx;
    }

    public BlockClass classAt(int dx, int dy, int dz) {
        if (dx < 0 || dz < 0 || dy < 0 || dx >= this.side || dz >= this.side || dy >= this.height) {
            return BlockClass.UNKNOWN;
        }
        return BlockClass.byOrdinal(this.cells[index(dx, dy, dz)]);
    }

    public String blockAt(int dx, int dy, int dz) {
        short palette = this.blocks[index(dx, dy, dz)];
        return palette >= 0 && palette < this.palette.size() ? this.palette.get(palette) : "unknown";
    }

    /** The drone's own cell, which is the centre of the grid by construction. */
    public int centreX() {
        return this.hRadius;
    }

    public int centreY() {
        return this.vRadius;
    }

    public int centreZ() {
        return this.hRadius;
    }
}
