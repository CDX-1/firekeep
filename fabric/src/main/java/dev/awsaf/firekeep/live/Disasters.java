package dev.awsaf.firekeep.live;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.Vec3;

/**
 * The disasters the dashboard can call down on the world.
 *
 * <p>The dashboard has no way to reach Minecraft directly, so an event travels the same road a
 * drone order does: posted to the python server, parked there, and handed back in the reply to
 * the mod's next world-feed push. {@link WorldFeed} dispatches it here, on the server thread.
 *
 * <p>Nothing here invents a way to burn things down. Fire is placed as fire and left to vanilla's
 * own spread, lightning is a real bolt, an explosion is the same call TNT makes - so what the
 * dashboard sets off behaves exactly like the thing it is imitating, and the map's fire glow lights
 * up through LevelChunkMixin without this having to tell it anything.
 */
public final class Disasters {
    /** Ignition points in one fire event. */
    private static final int MAX_POINTS = 256;
    /** Bolts in one storm. */
    private static final int MAX_BOLTS = 32;
    /** Explosion power. Vanilla TNT is 4; past about this the server just stalls. */
    private static final float MAX_POWER = 12.0F;
    /** No event may reach further than this, whatever the dashboard asks for. */
    private static final int MAX_RADIUS = 128;
    /** How far above and below the aimed column a dousing looks for flames. */
    private static final int DOUSE_DEPTH = 8;

    private Disasters() {
    }

    /**
     * Carries out one event and says what it did.
     *
     * <p>Server thread only - it places blocks and spawns entities. Never throws: a bad event is
     * reported back to the dashboard as a failure rather than taking the feed thread down.
     *
     * @return a report to hand back on the next feed push
     */
    public static JsonObject strike(ServerLevel level, JsonObject order) {
        JsonObject report = new JsonObject();
        report.addProperty("id", order.has("event_id") ? order.get("event_id").getAsString() : "");

        String kind = order.has("kind") ? order.get("kind").getAsString() : "fire";
        report.addProperty("kind", kind);

        try {
            int radius = clamp(intOf(order, "radius", 6), 0, MAX_RADIUS);
            int intensity = Math.max(1, intOf(order, "intensity", 3));
            double x = order.get("x").getAsDouble();
            double z = order.get("z").getAsDouble();
            // The map is top-down and has no y to give, so an event without one lands on whatever
            // the surface happens to be - which is what "put a fire there" means on a map.
            Double y = order.has("y") && !order.get("y").isJsonNull() ? order.get("y").getAsDouble() : null;

            int affected = switch (kind) {
                case "fire" -> ignite(level, x, y, z, radius, Math.min(intensity, MAX_POINTS));
                case "lightning" -> storm(level, x, y, z, radius, Math.min(intensity, MAX_BOLTS));
                case "explosion" -> detonate(level, x, y, z, Math.min(intensity, MAX_POWER));
                case "extinguish" -> douse(level, x, y, z, radius);
                default -> throw new IllegalArgumentException("unknown event kind " + kind);
            };

            report.addProperty("ok", true);
            report.addProperty("affected", affected);
        } catch (RuntimeException e) {
            report.addProperty("ok", false);
            report.addProperty("error", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        return report;
    }

    // ---------------------------------------------------------------- the events

    /**
     * Scatters ignition points over a disc and lets vanilla take it from there.
     *
     * <p>A wildfire is not drawn on, it is started: this lights a handful of blocks and the fire
     * tick spreads them through whatever is flammable nearby. That is why radius and intensity are
     * separate - a wide, sparse scatter and a tight, dense one grow into very different fires.
     */
    private static int ignite(ServerLevel level, double x, Double y, double z, int radius, int points) {
        RandomSource random = level.getRandom();
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        int lit = 0;

        // Enough tries that a sparse disc still finds its points, capped so a fire aimed at a lake
        // cannot spin here forever.
        for (int attempt = 0; attempt < points * 8 && lit < points; attempt++) {
            int[] spot = scatter(random, x, z, radius, attempt == 0);
            int top = y != null ? (int) Math.floor(y) : surfaceAt(level, spot[0], spot[1]);
            pos.set(spot[0], top, spot[1]);
            if (!level.isLoaded(pos) || !canBurnAt(level, pos)) {
                continue;
            }
            if (level.setBlockAndUpdate(pos, BaseFireBlock.getState(level, pos))) {
                lit++;
            }
        }
        return lit;
    }

    /** Real bolts, which do their own scorching, so a storm is a fire that starts itself. */
    private static int storm(ServerLevel level, double x, Double y, double z, int radius, int bolts) {
        RandomSource random = level.getRandom();
        int struck = 0;

        for (int i = 0; i < bolts; i++) {
            int[] spot = scatter(random, x, z, radius, i == 0);
            BlockPos at = new BlockPos(spot[0], y != null ? (int) Math.floor(y)
                    : surfaceAt(level, spot[0], spot[1]), spot[1]);
            if (!level.isLoaded(at)) {
                continue;
            }
            LightningBolt bolt = EntityTypes.LIGHTNING_BOLT.create(level, EntitySpawnReason.TRIGGERED);
            if (bolt == null) {
                continue;
            }
            bolt.snapTo(Vec3.atBottomCenterOf(at));
            if (level.addFreshEntity(bolt)) {
                struck++;
            }
        }
        return struck;
    }

    /** The same call primed TNT makes, fire and all. */
    private static int detonate(ServerLevel level, double x, Double y, double z, float power) {
        int top = y != null ? (int) Math.floor(y) : surfaceAt(level, (int) Math.floor(x), (int) Math.floor(z));
        BlockPos at = BlockPos.containing(x, top, z);
        if (!level.isLoaded(at)) {
            throw new IllegalArgumentException("that chunk is not loaded");
        }
        level.explode(null, x, top + 0.5D, z, power, true, Level.ExplosionInteraction.TNT);
        return Math.round(power);
    }

    /**
     * Puts a fire out, which is the job the drones are eventually meant to do themselves.
     *
     * <p>Sweeps the whole column rather than the surface alone, because a fire that has spread is
     * rarely all on one level, and clearing only the top of it leaves it to climb straight back.
     */
    private static int douse(ServerLevel level, double x, Double y, double z, int radius) {
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        int centreX = (int) Math.floor(x);
        int centreZ = (int) Math.floor(z);
        int doused = 0;

        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                if (dx * dx + dz * dz > radius * radius) {
                    continue;
                }
                int bx = centreX + dx;
                int bz = centreZ + dz;
                int top = y != null ? (int) Math.floor(y) : surfaceAt(level, bx, bz);
                for (int by = top + DOUSE_DEPTH; by >= top - DOUSE_DEPTH; by--) {
                    pos.set(bx, by, bz);
                    if (!level.isLoaded(pos)) {
                        break;
                    }
                    BlockState state = level.getBlockState(pos);
                    if (state.is(Blocks.FIRE) || state.is(Blocks.SOUL_FIRE)) {
                        level.setBlockAndUpdate(pos, Blocks.AIR.defaultBlockState());
                        doused++;
                    }
                }
            }
        }
        return doused;
    }

    // ---------------------------------------------------------------- helpers

    /**
     * A random column inside the disc, or dead centre for the first one.
     *
     * <p>Uniform over the area rather than over the radius - drawing the radius flat piles every
     * event up in the middle and leaves the edge of a wide fire bare.
     */
    private static int[] scatter(RandomSource random, double x, double z, int radius, boolean centre) {
        if (centre || radius <= 0) {
            return new int[]{(int) Math.floor(x), (int) Math.floor(z)};
        }
        double angle = random.nextDouble() * Math.PI * 2;
        double distance = Math.sqrt(random.nextDouble()) * radius;
        return new int[]{(int) Math.floor(x + Math.cos(angle) * distance),
                (int) Math.floor(z + Math.sin(angle) * distance)};
    }

    /** The first free block above the ground, which is where a fire would sit. */
    private static int surfaceAt(ServerLevel level, int x, int z) {
        return level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z);
    }

    /**
     * Whether fire would look like it belongs at {@code pos}.
     *
     * <p>Vanilla's own canBePlacedAt is stricter than we want here - it refuses ground that is
     * merely not flammable, which rules out lighting a fire on stone at all. This asks the two
     * questions that actually matter: is there room, and is there something under it to sit on.
     */
    private static boolean canBurnAt(ServerLevel level, BlockPos pos) {
        if (!level.getBlockState(pos).isAir()) {
            return false;
        }
        BlockState below = level.getBlockState(pos.below());
        return !below.isAir() && below.getFluidState().isEmpty();
    }

    private static int intOf(JsonObject order, String key, int fallback) {
        return order.has(key) && !order.get(key).isJsonNull() ? order.get(key).getAsInt() : fallback;
    }

    private static int clamp(int value, int low, int high) {
        return Math.min(high, Math.max(low, value));
    }
}
