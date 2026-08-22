package dev.awsaf.firekeep.drone;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * A* over the block grid, so the drone routes around a burning building instead of into it.
 *
 * <p>Runs on the server thread, because it reads blocks - and is therefore strictly bounded:
 * {@link DroneConfig#pathNodeBudget} caps expansions and {@link DroneConfig#pathSearchRadius} caps
 * the box, so a hopeless request costs a known number of block reads rather than a frozen tick.
 * It is also only called when it is needed: {@link #clearLine} is tried first, and open sky is the
 * common case for something that flies.
 *
 * <p>The result is deliberately sparse. Raw A* output is one waypoint per block, which the flight
 * controller would follow as a staircase; {@link #simplify} collapses it back to the corners.
 */
public final class DronePathfinder {
    /** Axis steps plus the four horizontal diagonals: enough freedom to round a corner, cheap to expand. */
    private static final int[][] STEPS = {
            {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {0, 1, 0}, {0, -1, 0},
            {1, 0, 1}, {1, 0, -1}, {-1, 0, 1}, {-1, 0, -1}
    };

    /** Climbing is legal but discouraged, so a route prefers to go round before it goes over. */
    private static final double CLIMB_COST = 1.4D;

    /**
     * Extra cost for a cell with something solid immediately beside it.
     *
     * <p>The drone is nearly a block wide and the search treats it as a point, so a route that
     * scrapes along a wall is one the drone cannot actually fly. Making tight cells expensive
     * without making them illegal keeps a five-wide gap usable while routing through its middle,
     * and still lets a route squeeze through the only opening there is.
     */
    private static final double TIGHT_COST = 2.5D;

    private static final int BLOCKED = 0;
    private static final int OPEN = 1;
    /** Passable, but with a solid block against one of its faces. */
    private static final int TIGHT = 2;

    private DronePathfinder() {
    }

    /**
     * A route from {@code from} to {@code to}, or null when there is not one inside the budget.
     * The returned list ends at {@code to} itself and never includes the starting point.
     */
    public static List<Vec3> findPath(ServerLevel level, Vec3 from, Vec3 to, DroneConfig config) {
        Map<Long, Integer> cache = new HashMap<>();
        BlockPos start = BlockPos.containing(from);
        BlockPos goal = nearestOpen(level, BlockPos.containing(to), config, cache);
        if (goal == null) {
            return null;
        }
        if (start.equals(goal)) {
            return List.of(to);
        }

        int budget = config.pathNodeBudget;
        int reach = config.pathSearchRadius;

        Map<Long, Long> cameFrom = new HashMap<>();
        Map<Long, Double> best = new HashMap<>();
        PriorityQueue<Node> open = new PriorityQueue<>();

        long startKey = start.asLong();
        best.put(startKey, 0.0D);
        open.add(new Node(startKey, 0.0D, heuristic(start, goal)));

        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        int expanded = 0;

        while (!open.isEmpty() && expanded < budget) {
            Node node = open.poll();
            if (node.score > best.getOrDefault(node.key, Double.MAX_VALUE) + 1.0E-6D) {
                continue;                        // a cheaper route to this cell was already queued
            }
            expanded++;

            BlockPos current = BlockPos.of(node.key);
            if (current.equals(goal)) {
                return simplify(level, from, to, reconstruct(cameFrom, node.key), config, cache);
            }

            for (int[] step : STEPS) {
                cursor.set(current.getX() + step[0], current.getY() + step[1], current.getZ() + step[2]);
                if (start.distManhattan(cursor) > reach * 3) {
                    continue;
                }
                if (!passable(level, cursor, config, cache)) {
                    continue;
                }
                // A horizontal diagonal that clips a corner is not really passable.
                if (step[0] != 0 && step[2] != 0) {
                    if (!passable(level, cursor.set(current.getX() + step[0], current.getY(), current.getZ()),
                            config, cache)
                            || !passable(level, cursor.set(current.getX(), current.getY(),
                            current.getZ() + step[2]), config, cache)) {
                        continue;
                    }
                    cursor.set(current.getX() + step[0], current.getY(), current.getZ() + step[2]);
                }

                double stride = step[1] != 0 ? CLIMB_COST
                        : step[0] != 0 && step[2] != 0 ? 1.414D : 1.0D;
                if (cell(level, cursor, config, cache) == TIGHT) {
                    stride += TIGHT_COST;
                }
                double score = node.score + stride;
                long key = cursor.asLong();
                if (score >= best.getOrDefault(key, Double.MAX_VALUE) - 1.0E-6D) {
                    continue;
                }
                best.put(key, score);
                cameFrom.put(key, node.key);
                open.add(new Node(key, score, score + heuristic(cursor, goal)));
            }
        }
        return null;
    }

    /** True when the drone can fly straight from {@code from} to {@code to} without hitting anything. */
    public static boolean clearLine(ServerLevel level, Vec3 from, Vec3 to, DroneConfig config) {
        return clearLine(level, from, to, config, new HashMap<>());
    }

    private static boolean clearLine(ServerLevel level, Vec3 from, Vec3 to, DroneConfig config,
                                     Map<Long, Integer> cache) {
        Vec3 delta = to.subtract(from);
        double length = delta.length();
        if (length < 1.0E-4D) {
            return true;
        }
        // Half-block sampling: the smallest step that cannot skip past a one-block wall.
        int samples = (int) Math.ceil(length * 2.0D);
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        for (int i = 1; i <= samples; i++) {
            Vec3 at = from.add(delta.scale((double) i / samples));
            cursor.set(Mth.floor(at.x), Mth.floor(at.y), Mth.floor(at.z));
            if (!passable(level, cursor, config, cache)) {
                return false;
            }
        }
        return true;
    }

    // ---------------------------------------------------------------- passability

    /**
     * Whether a drone may occupy this block.
     *
     * <p>An unloaded chunk counts as blocked. That is not caution for its own sake: reading it
     * would force generation on the server thread, and flying into terrain nobody has loaded is
     * how a drone ends up inside a hillside.
     */
    public static boolean passable(ServerLevel level, BlockPos pos, DroneConfig config,
                                   Map<Long, Integer> cache) {
        return cell(level, pos, config, cache) != BLOCKED;
    }

    private static int cell(ServerLevel level, BlockPos pos, DroneConfig config, Map<Long, Integer> cache) {
        long key = pos.asLong();
        Integer cached = cache.get(key);
        if (cached != null) {
            return cached;
        }

        int state = compute(level, pos, config);
        cache.put(key, state);
        return state;
    }

    /**
     * Classifies one cell, reading the block and then its six faces.
     *
     * <p>The face scan pays for two things at once: it keeps the route away from fire (a full
     * clearance sphere would be 125 reads a node; the faces catch the case that matters for six)
     * and it is what marks a cell as {@link #TIGHT}.
     */
    private static int compute(ServerLevel level, BlockPos pos, DroneConfig config) {
        if (pos.getY() < level.getMinY() + 1 || pos.getY() >= level.getMaxY() - 1 || !level.isLoaded(pos)) {
            return BLOCKED;
        }
        // Y is never an operator or workflow decision. Keep every planned cell in the same
        // terrain-relative envelope, including over slopes and valleys between waypoints.
        int ground = level.getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING,
                pos.getX(), pos.getZ()) - 1;
        int altitude = pos.getY() - ground;
        if (altitude < config.minAltitudeAboveGround || altitude > config.maxAltitudeAboveGround) {
            return BLOCKED;
        }
        BlockClass here = BlockClass.of(level.getBlockState(pos), level, pos);
        if (here.blocking() || here.dangerous()) {
            return BLOCKED;
        }

        boolean tight = false;
        BlockPos.MutableBlockPos neighbour = new BlockPos.MutableBlockPos();
        for (int[] step : NEIGHBOURS) {
            neighbour.set(pos.getX() + step[0], pos.getY() + step[1], pos.getZ() + step[2]);
            if (!level.isLoaded(neighbour)) {
                continue;
            }
            BlockClass beside = BlockClass.of(level.getBlockState(neighbour), level, neighbour);
            if (config.hazardClearance > 0 && beside.dangerous()) {
                return BLOCKED;
            }
            // Ground underfoot is not a squeeze; a wall beside or a ceiling above is.
            if (beside.blocking() && step[1] >= 0) {
                tight = true;
            }
        }
        return tight ? TIGHT : OPEN;
    }

    private static final int[][] NEIGHBOURS = {
            {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}
    };

    /** The closest block to {@code goal} a drone could actually sit in, searched outward. */
    private static BlockPos nearestOpen(ServerLevel level, BlockPos goal, DroneConfig config,
                                        Map<Long, Integer> cache) {
        if (passable(level, goal, config, cache)) {
            return goal;
        }
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        for (int radius = 1; radius <= 5; radius++) {
            for (int dy = radius; dy >= -radius; dy--) {          // prefer climbing over burrowing
                for (int dx = -radius; dx <= radius; dx++) {
                    for (int dz = -radius; dz <= radius; dz++) {
                        if (Math.abs(dx) != radius && Math.abs(dy) != radius && Math.abs(dz) != radius) {
                            continue;                              // interior, already checked
                        }
                        cursor.set(goal.getX() + dx, goal.getY() + dy, goal.getZ() + dz);
                        if (passable(level, cursor, config, cache)) {
                            return cursor.immutable();
                        }
                    }
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- plumbing

    private record Node(long key, double score, double estimate) implements Comparable<Node> {
        @Override
        public int compareTo(Node other) {
            return Double.compare(this.estimate, other.estimate);
        }
    }

    private static double heuristic(BlockPos from, BlockPos to) {
        double dx = from.getX() - to.getX();
        double dy = from.getY() - to.getY();
        double dz = from.getZ() - to.getZ();
        // Slightly over-estimating breaks ties toward the goal and keeps the frontier small.
        return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.001D;
    }

    private static List<BlockPos> reconstruct(Map<Long, Long> cameFrom, long tail) {
        List<BlockPos> path = new ArrayList<>();
        Long cursor = tail;
        while (cursor != null) {
            path.add(BlockPos.of(cursor));
            cursor = cameFrom.get(cursor);
        }
        Collections.reverse(path);
        return path;
    }

    /**
     * Collapses the block-by-block route to the corners the drone actually has to turn at, by
     * skipping any waypoint the drone can already see past.
     */
    private static List<Vec3> simplify(ServerLevel level, Vec3 from, Vec3 to, List<BlockPos> path,
                                       DroneConfig config, Map<Long, Integer> cache) {
        List<Vec3> points = new ArrayList<>();
        for (BlockPos pos : path) {
            points.add(new Vec3(pos.getX() + 0.5D, pos.getY() + 0.5D, pos.getZ() + 0.5D));
        }
        if (!points.isEmpty()) {
            points.set(points.size() - 1, to);
        }

        List<Vec3> simplified = new ArrayList<>();
        Vec3 anchor = from;
        int i = 0;
        while (i < points.size()) {
            int furthest = i;
            for (int j = points.size() - 1; j > i; j--) {
                if (clearLine(level, anchor, points.get(j), config, cache)) {
                    furthest = j;
                    break;
                }
            }
            anchor = points.get(furthest);
            simplified.add(anchor);
            i = furthest + 1;
        }
        return simplified;
    }
}
