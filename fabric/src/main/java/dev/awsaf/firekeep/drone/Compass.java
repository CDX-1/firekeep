package dev.awsaf.firekeep.drone;

import net.minecraft.world.phys.Vec3;

/**
 * The vocabulary the AI uses for direction: eight compass points plus up and down.
 *
 * <p>An agent reasons in "north", not in {@code -Z}, so every direction that crosses the bridge
 * goes through here in both directions - {@link #of} for perception, {@link #vector} for commands.
 * Minecraft's north is negative Z and east is positive X, which is the one convention this class
 * exists to hide.
 */
public enum Compass {
    NORTH("north", 0, -1),
    NORTHEAST("northeast", 1, -1),
    EAST("east", 1, 0),
    SOUTHEAST("southeast", 1, 1),
    SOUTH("south", 0, 1),
    SOUTHWEST("southwest", -1, 1),
    WEST("west", -1, 0),
    NORTHWEST("northwest", -1, -1),
    UP("up", 0, 0),
    DOWN("down", 0, 0);

    /** The eight horizontal points, in clockwise order from north. */
    public static final Compass[] HORIZONTAL = {NORTH, NORTHEAST, EAST, SOUTHEAST, SOUTH, SOUTHWEST, WEST, NORTHWEST};

    private final String label;
    private final int dx;
    private final int dz;

    Compass(String label, int dx, int dz) {
        this.label = label;
        this.dx = dx;
        this.dz = dz;
    }

    public String label() {
        return this.label;
    }

    public int stepX() {
        return this.dx;
    }

    public int stepZ() {
        return this.dz;
    }

    public int stepY() {
        return this == UP ? 1 : this == DOWN ? -1 : 0;
    }

    /** A unit vector, so a diagonal move of n blocks really travels n blocks. */
    public Vec3 vector() {
        Vec3 raw = new Vec3(this.dx, this.stepY(), this.dz);
        return raw.lengthSqr() == 0.0D ? Vec3.ZERO : raw.normalize();
    }

    /** Parses a name the AI produced; also accepts the short forms n/ne/e/se/s/sw/w/nw/u/d. */
    public static Compass parse(String raw) {
        if (raw == null) {
            return null;
        }
        String key = raw.trim().toLowerCase();
        for (Compass compass : values()) {
            if (compass.label.equals(key)) {
                return compass;
            }
        }
        return switch (key) {
            case "n" -> NORTH;
            case "ne" -> NORTHEAST;
            case "e" -> EAST;
            case "se" -> SOUTHEAST;
            case "s" -> SOUTH;
            case "sw" -> SOUTHWEST;
            case "w" -> WEST;
            case "nw" -> NORTHWEST;
            case "u", "above" -> UP;
            case "d", "below" -> DOWN;
            default -> null;
        };
    }

    /**
     * The direction something at the given offset lies in.
     *
     * <p>Vertical wins only when the offset is mostly vertical, because "the fire is below you" is
     * far less useful than "the fire is north of you" whenever there is any horizontal component
     * worth flying along.
     */
    public static Compass of(double dx, double dy, double dz) {
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        if (horizontal < 0.5D) {
            return dy >= 0.0D ? UP : DOWN;
        }
        // atan2 with (dx, -dz) puts north at 0 and runs clockwise, matching HORIZONTAL's order.
        double degrees = Math.toDegrees(Math.atan2(dx, -dz));
        int octant = (int) Math.round(((degrees % 360.0D) + 360.0D) % 360.0D / 45.0D) % 8;
        return HORIZONTAL[octant];
    }

    /** Yaw in Minecraft's own convention: 0 is south, and it increases clockwise through west. */
    public static float yawTowards(double dx, double dz) {
        return (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0D);
    }
}
