package dev.awsaf.firekeep.drone;

import dev.awsaf.firekeep.entity.DroneEntity;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The perception layer: block data in, a paragraph an AI can act on out.
 *
 * <p>Split deliberately in two. {@link #scan} runs on the server thread because that is the only
 * place blocks may be read, and does the least it can get away with - one pass over the box,
 * writing a {@link BlockClass} ordinal and a palette index per cell. {@link #interpret} runs on a
 * worker thread and does all the thinking: clustering, ray casting, naming, drawing the map.
 *
 * <p>A default 10x5x10 box is 4,851 cells. That is far too much to hand an LLM and exactly the
 * right amount to summarise, which is what this class exists to do.
 */
public final class DronePerception {
    /** A cluster larger than this is already unambiguous; stop growing it and save the work. */
    private static final int MAX_CLUSTER_CELLS = 512;
    /** Total clusters examined per snapshot, so a burning forest cannot make this unbounded. */
    private static final int MAX_CLUSTERS = 256;

    private DronePerception() {
    }

    // ---------------------------------------------------------------- server thread

    /**
     * Reads the world around {@code drone}. Server thread only.
     *
     * <p>Unloaded chunks are recorded as {@link BlockClass#UNKNOWN} rather than being loaded on
     * demand: dragging chunks into memory to satisfy a scan would let a drone's curiosity stall
     * the whole server.
     */
    public static PerceptionScan scan(ServerLevel level, DroneEntity drone, DroneConfig config,
                                      DroneStatus status, String activeCommand, Vec3 home) {
        int hRadius = config.perceptionRadius;
        int vRadius = config.perceptionVerticalRadius;
        int side = hRadius * 2 + 1;
        int height = vRadius * 2 + 1;

        Vec3 position = drone.position();
        int originX = Mth.floor(position.x) - hRadius;
        int originY = Mth.floor(position.y) - vRadius;
        int originZ = Mth.floor(position.z) - hRadius;

        byte[] cells = new byte[side * side * height];
        short[] blocks = new short[cells.length];
        List<String> palette = new ArrayList<>();
        Map<BlockState, Short> paletteIndex = new HashMap<>();
        palette.add("minecraft:air");
        paletteIndex.put(Blocks.AIR.defaultBlockState(), (short) 0);

        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        int minY = level.getMinY();
        int maxY = level.getMaxY();

        LevelChunk chunk = null;
        int chunkX = Integer.MIN_VALUE;
        int chunkZ = Integer.MIN_VALUE;

        for (int dy = 0; dy < height; dy++) {
            int worldY = originY + dy;
            boolean insideWorld = worldY >= minY && worldY < maxY;
            for (int dz = 0; dz < side; dz++) {
                int worldZ = originZ + dz;
                for (int dx = 0; dx < side; dx++) {
                    int worldX = originX + dx;
                    int slot = ((dy * side) + dz) * side + dx;

                    if (!insideWorld) {
                        cells[slot] = (byte) BlockClass.UNKNOWN.ordinal();
                        continue;
                    }

                    int cx = worldX >> 4;
                    int cz = worldZ >> 4;
                    if (cx != chunkX || cz != chunkZ) {
                        chunk = level.getChunkSource().getChunkNow(cx, cz);
                        chunkX = cx;
                        chunkZ = cz;
                    }
                    if (chunk == null) {
                        cells[slot] = (byte) BlockClass.UNKNOWN.ordinal();
                        continue;
                    }

                    cursor.set(worldX, worldY, worldZ);
                    BlockState state = chunk.getBlockState(cursor);
                    BlockClass blockClass = BlockClass.of(state, chunk, cursor);
                    cells[slot] = (byte) blockClass.ordinal();
                    if (blockClass != BlockClass.AIR) {
                        blocks[slot] = intern(state, palette, paletteIndex);
                    }
                }
            }
        }

        int groundY = level.getHeight(Heightmap.Types.MOTION_BLOCKING, Mth.floor(position.x), Mth.floor(position.z)) - 1;
        String groundBlock = "unknown";
        if (groundY >= minY && groundY < maxY) {
            cursor.set(Mth.floor(position.x), groundY, Mth.floor(position.z));
            groundBlock = name(level.getBlockState(cursor));
        }

        return new PerceptionScan(
                drone.getDroneId(),
                level.dimension().identifier().toString(),
                level.getGameTime(),
                position,
                Mth.wrapDegrees(drone.getYRot()),
                drone.getXRot(),
                drone.getDeltaMovement(),
                status,
                activeCommand,
                home,
                hRadius, vRadius, side, height,
                originX, originY, originZ,
                cells, blocks, palette,
                level.getBiome(BlockPos.containing(position)).getRegisteredName(),
                groundY,
                groundBlock,
                level.isRaining(),
                level.isThundering(),
                sightEntities(level, drone, config));
    }

    /**
     * A palette keeps the per-cell block name down to two bytes. Anything past 32,000 distinct
     * states in one 10-block box is not a real world, so the overflow simply reads back as air.
     */
    private static short intern(BlockState state, List<String> palette, Map<BlockState, Short> index) {
        Short existing = index.get(state);
        if (existing != null) {
            return existing;
        }
        if (palette.size() >= Short.MAX_VALUE) {
            return 0;
        }
        short slot = (short) palette.size();
        palette.add(name(state));
        index.put(state, slot);
        return slot;
    }

    private static String name(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static List<EntitySighting> sightEntities(ServerLevel level, DroneEntity drone, DroneConfig config) {
        double radius = config.entityRadius;
        AABB box = drone.getBoundingBox().inflate(radius);
        Vec3 eye = drone.position();

        List<EntitySighting> sightings = new ArrayList<>();
        for (Entity entity : level.getEntities(drone, box, candidate -> !candidate.isRemoved())) {
            Vec3 at = entity.position();
            double distance = at.distanceTo(eye);
            if (distance > radius) {
                continue;
            }
            Float health = entity instanceof LivingEntity living ? living.getHealth() : null;
            sightings.add(new EntitySighting(
                    label(entity),
                    typeName(entity),
                    category(entity),
                    round(at.x), round(at.y), round(at.z),
                    Compass.of(at.x - eye.x, at.y - eye.y, at.z - eye.z).label(),
                    round(distance),
                    entity.isOnFire(),
                    health));
        }
        sightings.sort(Comparator.comparingDouble(EntitySighting::distance));
        return List.copyOf(sightings);
    }

    private static String label(Entity entity) {
        if (entity instanceof DroneEntity other && !other.getDroneId().isBlank()) {
            return other.getDroneId();
        }
        if (entity instanceof ServerPlayer player) {
            return player.getGameProfile().name();
        }
        return entity.getStringUUID();
    }

    private static String typeName(Entity entity) {
        return EntityType.getKey(entity.getType()).toString();
    }

    /** The coarse bucket a rescue agent cares about: is it a person, a threat, or one of ours? */
    private static String category(Entity entity) {
        if (entity.getType() == FirekeepEntities.DRONE) {
            return "drone";
        }
        if (entity instanceof ServerPlayer) {
            return "player";
        }
        MobCategory mobCategory = entity.getType().getCategory();
        if (mobCategory == MobCategory.MONSTER) {
            return "hostile";
        }
        if (mobCategory == MobCategory.MISC) {
            return "object";
        }
        return "animal";
    }

    // ---------------------------------------------------------------- worker thread

    /** Turns a raw scan into the structured description n8n forwards to the model. */
    public static PerceptionSnapshot interpret(PerceptionScan scan, DroneConfig config) {
        int[] counts = new int[BlockClass.values().length];
        for (byte cell : scan.cells()) {
            counts[cell]++;
        }

        List<Cluster> clusters = cluster(scan);
        List<Feature> hazards = features(scan, clusters, config.maxFeatures,
                c -> c.blockClass == BlockClass.FIRE || c.blockClass == BlockClass.LAVA
                        || c.blockClass == BlockClass.HAZARD);
        List<Feature> resources = features(scan, clusters, config.maxFeatures,
                c -> c.blockClass == BlockClass.WATER);
        // Terrain the drone is flying over is the floor, not an obstacle. Only ground that
        // reaches the drone's own altitude - a cliff, a ridge, a wall of stone - is worth naming;
        // everything below it is already covered by "ground" and the downward clearance.
        int floorY = Mth.floor(scan.position().y) - 1;
        List<Feature> obstacles = features(scan, clusters, config.maxFeatures,
                c -> c.blockClass == BlockClass.WOOD || c.blockClass == BlockClass.BUILDING
                        || ((c.blockClass == BlockClass.OBSTACLE || c.blockClass == BlockClass.TERRAIN)
                        && c.size >= 4 && c.nearestY >= floorY));

        Map<String, Integer> clearance = clearance(scan);
        List<String> open = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : clearance.entrySet()) {
            if (entry.getValue() >= config.openClearance) {
                open.add(entry.getKey());
            }
        }

        int fire = counts[BlockClass.FIRE.ordinal()];
        int lava = counts[BlockClass.LAVA.ordinal()];
        int water = counts[BlockClass.WATER.ordinal()];
        int altitude = Mth.floor(scan.position().y) - scan.groundY();

        return new PerceptionSnapshot(
                scan.droneId(),
                scan.dimension(),
                scan.gameTime(),
                System.currentTimeMillis(),
                scan.position(),
                scan.yaw(),
                scan.pitch(),
                scan.velocity(),
                scan.status(),
                scan.activeCommand(),
                scan.home(),
                terrainLabel(scan, counts),
                scan.groundBlock(),
                altitude,
                scan.biome(),
                scan.raining(),
                scan.thundering(),
                List.copyOf(open),
                clearance,
                obstacles,
                hazards,
                resources,
                scan.entities(),
                hazardLevel(fire, lava, config),
                fire,
                lava,
                water,
                config.includeMap ? map(scan) : null,
                scan.hRadius(),
                scan.vRadius());
    }

    // ---------------------------------------------------------------- clustering

    private static final class Cluster {
        private BlockClass blockClass;
        private int size;
        private int nearestX;
        private int nearestY;
        private int nearestZ;
        private double nearestDistance = Double.MAX_VALUE;
        private String block = "unknown";
    }

    /**
     * Flood-fills contiguous cells of the same class, so twelve fire blocks on one roof arrive as
     * one fire rather than twelve. Six-connectivity: diagonal-only contact is not one object.
     */
    private static List<Cluster> cluster(PerceptionScan scan) {
        boolean[] seen = new boolean[scan.cells().length];
        List<Cluster> clusters = new ArrayList<>();
        Deque<int[]> frontier = new ArrayDeque<>();

        Vec3 eye = scan.position();
        for (int dy = 0; dy < scan.height() && clusters.size() < MAX_CLUSTERS; dy++) {
            for (int dz = 0; dz < scan.side() && clusters.size() < MAX_CLUSTERS; dz++) {
                for (int dx = 0; dx < scan.side() && clusters.size() < MAX_CLUSTERS; dx++) {
                    int start = scan.index(dx, dy, dz);
                    if (seen[start]) {
                        continue;
                    }
                    BlockClass blockClass = BlockClass.byOrdinal(scan.cells()[start]);
                    if (blockClass == BlockClass.AIR || blockClass == BlockClass.UNKNOWN) {
                        seen[start] = true;
                        continue;
                    }

                    Cluster cluster = new Cluster();
                    cluster.blockClass = blockClass;
                    Map<String, Integer> names = new LinkedHashMap<>();

                    seen[start] = true;
                    frontier.add(new int[]{dx, dy, dz});
                    while (!frontier.isEmpty()) {
                        int[] cell = frontier.poll();
                        cluster.size++;
                        names.merge(scan.blockAt(cell[0], cell[1], cell[2]), 1, Integer::sum);

                        double wx = scan.originX() + cell[0] + 0.5D;
                        double wy = scan.originY() + cell[1] + 0.5D;
                        double wz = scan.originZ() + cell[2] + 0.5D;
                        double distance = eye.distanceTo(new Vec3(wx, wy, wz));
                        if (distance < cluster.nearestDistance) {
                            cluster.nearestDistance = distance;
                            cluster.nearestX = scan.originX() + cell[0];
                            cluster.nearestY = scan.originY() + cell[1];
                            cluster.nearestZ = scan.originZ() + cell[2];
                        }

                        if (cluster.size >= MAX_CLUSTER_CELLS) {
                            continue;
                        }
                        for (int[] step : NEIGHBOURS) {
                            int nx = cell[0] + step[0];
                            int ny = cell[1] + step[1];
                            int nz = cell[2] + step[2];
                            if (nx < 0 || nz < 0 || ny < 0 || nx >= scan.side()
                                    || nz >= scan.side() || ny >= scan.height()) {
                                continue;
                            }
                            int neighbour = scan.index(nx, ny, nz);
                            if (seen[neighbour] || scan.cells()[neighbour] != (byte) blockClass.ordinal()) {
                                continue;
                            }
                            seen[neighbour] = true;
                            frontier.add(new int[]{nx, ny, nz});
                        }
                    }
                    frontier.clear();

                    cluster.block = names.entrySet().stream()
                            .max(Map.Entry.comparingByValue())
                            .map(Map.Entry::getKey)
                            .orElse("unknown");
                    clusters.add(cluster);
                }
            }
        }
        return clusters;
    }

    private static final int[][] NEIGHBOURS = {
            {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}
    };

    private static List<Feature> features(PerceptionScan scan, List<Cluster> clusters, int limit,
                                          java.util.function.Predicate<Cluster> wanted) {
        List<Cluster> matched = new ArrayList<>();
        for (Cluster cluster : clusters) {
            if (wanted.test(cluster)) {
                matched.add(cluster);
            }
        }
        matched.sort(Comparator.comparingDouble(cluster -> cluster.nearestDistance));

        List<Feature> features = new ArrayList<>();
        Vec3 eye = scan.position();
        for (int i = 0; i < matched.size() && i < limit; i++) {
            Cluster cluster = matched.get(i);
            features.add(new Feature(
                    describe(cluster),
                    Compass.of(cluster.nearestX + 0.5D - eye.x,
                            cluster.nearestY + 0.5D - eye.y,
                            cluster.nearestZ + 0.5D - eye.z).label(),
                    round(cluster.nearestDistance),
                    cluster.size,
                    cluster.nearestX,
                    cluster.nearestY,
                    cluster.nearestZ));
        }
        return List.copyOf(features);
    }

    /** "oak_tree", "spruce_log", "stone_wall" - the block's own name, minus the namespace. */
    private static String describe(Cluster cluster) {
        String block = cluster.block;
        int colon = block.indexOf(':');
        String plain = colon >= 0 ? block.substring(colon + 1) : block;
        if (cluster.blockClass == BlockClass.WOOD) {
            return plain.endsWith("_log") ? plain.substring(0, plain.length() - 4) + "_tree" : plain;
        }
        if (cluster.blockClass == BlockClass.FIRE || cluster.blockClass == BlockClass.LAVA
                || cluster.blockClass == BlockClass.WATER) {
            return cluster.blockClass.label();
        }
        if (cluster.blockClass == BlockClass.BUILDING) {
            return "building:" + plain;
        }
        return plain;
    }

    // ---------------------------------------------------------------- rays and labels

    /**
     * How far the drone could fly each way before hitting something, at its own altitude.
     *
     * <p>A single-height ray, not a swept volume: the drone is half a block tall, and pretending
     * otherwise would call every doorway blocked.
     */
    private static Map<String, Integer> clearance(PerceptionScan scan) {
        // Insertion-ordered so the JSON reads round the compass rather than at random.
        Map<String, Integer> clearance = new LinkedHashMap<>();
        int cx = scan.centreX();
        int cy = scan.centreY();
        int cz = scan.centreZ();

        for (Compass compass : Compass.HORIZONTAL) {
            boolean diagonal = compass.stepX() != 0 && compass.stepZ() != 0;
            int reach = diagonal ? (int) (scan.hRadius() / Math.sqrt(2.0D)) : scan.hRadius();
            int free = reach;
            for (int step = 1; step <= reach; step++) {
                BlockClass at = scan.classAt(cx + compass.stepX() * step, cy, cz + compass.stepZ() * step);
                if (at.blocking()) {
                    free = step - 1;
                    break;
                }
            }
            clearance.put(compass.label(), diagonal ? (int) Math.round(free * Math.sqrt(2.0D)) : free);
        }

        for (Compass compass : new Compass[]{Compass.UP, Compass.DOWN}) {
            int free = scan.vRadius();
            for (int step = 1; step <= scan.vRadius(); step++) {
                if (scan.classAt(cx, cy + compass.stepY() * step, cz).blocking()) {
                    free = step - 1;
                    break;
                }
            }
            clearance.put(compass.label(), free);
        }
        return java.util.Collections.unmodifiableMap(clearance);
    }

    /**
     * A one-word summary of where the drone is. The biome name is authoritative for climate, so
     * this describes the built and grown structure the biome cannot tell you about.
     */
    private static String terrainLabel(PerceptionScan scan, int[] counts) {
        double total = Math.max(1, scan.cells().length);
        double water = counts[BlockClass.WATER.ordinal()] / total;
        double lava = counts[BlockClass.LAVA.ordinal()] / total;
        double leaves = counts[BlockClass.FOLIAGE.ordinal()] / total;
        double cover = counts[BlockClass.PLANT.ordinal()] / total;
        double wood = counts[BlockClass.WOOD.ordinal()] / total;
        double solid = (counts[BlockClass.TERRAIN.ordinal()] + counts[BlockClass.OBSTACLE.ordinal()]) / total;
        int buildings = counts[BlockClass.BUILDING.ordinal()];

        if (lava > 0.02D) {
            return "volcanic";
        }
        if (water > 0.30D) {
            return "open_water";
        }
        if (buildings > 200) {
            return "urban";
        }
        if (buildings > 30) {
            return "settlement";
        }
        if (leaves > 0.12D || (wood > 0.01D && leaves > 0.06D)) {
            return "dense_forest";
        }
        if (leaves > 0.03D) {
            return "forest";
        }
        if (cover > 0.10D && solid < 0.20D) {
            return "grassland";
        }
        if (solid > 0.55D) {
            return "underground";
        }
        if (solid > 0.30D) {
            return "mountainous";
        }
        String ground = scan.groundBlock();
        if (ground.contains("sand")) {
            return "desert";
        }
        return solid < 0.05D ? "open_sky" : "open_field";
    }

    private static String hazardLevel(int fire, int lava, DroneConfig config) {
        int total = fire + lava;
        if (total == 0) {
            return "none";
        }
        if (total >= config.disasterFireCells) {
            return "severe";
        }
        return total >= 4 ? "moderate" : "minor";
    }

    /**
     * The coarse local map: one character per column, north at the top, the drone in the middle.
     *
     * <p>A grid survives an LLM's attention far better than a list of coordinates does - it makes
     * "the fire is between me and the lake" visible instead of derivable.
     */
    private static String map(PerceptionScan scan) {
        int side = scan.side();
        char[][] grid = new char[side][side];
        for (int dz = 0; dz < side; dz++) {
            for (int dx = 0; dx < side; dx++) {
                BlockClass best = BlockClass.AIR;
                for (int dy = 0; dy < scan.height(); dy++) {
                    BlockClass at = scan.classAt(dx, dy, dz);
                    if (at.priority() > best.priority()) {
                        best = at;
                    }
                }
                grid[dz][dx] = best.glyph();
            }
        }

        for (EntitySighting sighting : scan.entities()) {
            int dx = Mth.floor(sighting.x()) - scan.originX();
            int dz = Mth.floor(sighting.z()) - scan.originZ();
            if (dx < 0 || dz < 0 || dx >= side || dz >= side) {
                continue;
            }
            char glyph = switch (sighting.category()) {
                case "player" -> 'P';
                case "drone" -> 'd';
                case "hostile" -> 'x';
                case "animal" -> 'a';
                default -> grid[dz][dx];
            };
            grid[dz][dx] = glyph;
        }

        grid[scan.centreZ()][scan.centreX()] = 'D';

        StringBuilder out = new StringBuilder(side * (side + 1));
        for (int dz = 0; dz < side; dz++) {
            out.append(grid[dz]);
            if (dz < side - 1) {
                out.append('\n');
            }
        }
        return out.toString();
    }

    // ---------------------------------------------------------------- helpers

    private static double round(double value) {
        return Math.round(value * 100.0D) / 100.0D;
    }
}
