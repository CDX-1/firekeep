package dev.awsaf.firekeep.drone;

import com.google.gson.JsonObject;
import dev.awsaf.firekeep.entity.DroneEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.function.Function;

/**
 * One drone's autopilot: the layer that turns "move east 5" into a route, and a route into the
 * position targets {@link DroneEntity} already knows how to fly to.
 *
 * <p>This is where the promise that n8n never does frame-by-frame control is actually kept.
 * A command is accepted once, and everything afterwards - planning around a burning house,
 * noticing the drone has wedged itself against a cliff, replanning, giving up and saying so -
 * happens here, on the server thread, twenty times a second.
 *
 * <p>Exactly one command is active at a time. A new one supersedes the old, whose caller is told
 * so rather than left waiting; that is what makes it safe for an AI to change its mind mid-flight.
 */
public final class DroneController {
    /** Standoff kept from a follow target, so two drones do not fight over the same block. */
    private static final double DEFAULT_FOLLOW_RADIUS = 4.0D;
    /** Progress smaller than this over a whole stuck window is not progress. */
    private static final double PROGRESS_EPSILON = 0.05D;
    /**
     * Ticks of grinding against a block before the route is thrown away.
     *
     * <p>The drone's own collision response nudges it upward to climb small obstructions, which
     * is right when it is flying free and wrong when it is following a plan - it fights the
     * route instead of the wall. Replanning from where the drone actually ended up settles it
     * long before the much slower no-progress timer would.
     */
    private static final int COLLISION_REPLAN_TICKS = 12;

    private final String droneId;
    private final DroneConfig config;

    private Vec3 home;
    private DroneStatus status = DroneStatus.AVAILABLE;
    private DroneCommand active;
    private CommandResult lastResult;

    private final Deque<Vec3> waypoints = new ArrayDeque<>();
    private Vec3 goal;
    private double lastDistance = Double.MAX_VALUE;
    private int ticksWithoutProgress;
    private int ticksColliding;
    private int replans;

    private List<Vec3> patrol = List.of();
    private int patrolIndex;

    private String followTarget;
    private double followRadius = DEFAULT_FOLLOW_RADIUS;

    private boolean scanPending;
    private boolean inHazard;

    public DroneController(String droneId, DroneConfig config, Vec3 home) {
        this.droneId = droneId;
        this.config = config;
        this.home = home;
    }

    /**
     * Adopts the drone's own stored home, or gives it one if it has never had a base.
     *
     * <p>The entity is the durable side of this pair - it survives restarts and re-indexing -
     * so it, not the controller, decides where "home" is.
     */
    void syncHome(DroneEntity drone) {
        Vec3 stored = drone.getHomePosition();
        if (stored != null) {
            this.home = stored;
        } else if (this.home != null) {
            drone.setHomePosition(this.home);
        }
    }

    // ---------------------------------------------------------------- state

    public String droneId() {
        return this.droneId;
    }

    public DroneStatus status() {
        return this.status;
    }

    public Vec3 home() {
        return this.home;
    }

    public DroneCommand active() {
        return this.active;
    }

    /** How the previous command ended, which is what an asynchronous caller polls for. */
    public CommandResult lastResult() {
        return this.lastResult;
    }

    public String activeLabel() {
        return this.active == null ? null : this.active.describe();
    }

    public Vec3 goal() {
        return this.goal;
    }

    public int waypointsRemaining() {
        return this.waypoints.size();
    }

    boolean consumeScanRequest() {
        boolean pending = this.scanPending;
        this.scanPending = false;
        return pending;
    }

    /** Completes a pending {@code scan} once the perception worker has produced its snapshot. */
    void onPerception(PerceptionSnapshot snapshot) {
        if (this.active == null || this.active.type() != CommandType.SCAN) {
            return;
        }
        DroneCommand command = this.active;
        finish(CommandResult.completed(command, "scan complete", snapshot.toJson()));
    }

    // ---------------------------------------------------------------- accepting orders

    /**
     * Starts {@code command}, cancelling whatever was running. Server thread only.
     *
     * <p>Instantaneous commands finish inside this call, so an HTTP client that asked to wait gets
     * its answer on the same request.
     */
    public void begin(ServerLevel level, DroneEntity drone, DroneCommand command) {
        // Looking is a camera/gimbal adjustment, not a flight instruction. In particular, an
        // n8n workflow must be able to tilt the camera down while a move, patrol or follow is
        // still under way, rather than replacing that active command.
        if (command.type() == CommandType.LOOK) {
            look(level, drone, command);
            return;
        }

        if (this.active != null && this.active != command) {
            DroneCommand previous = this.active;
            this.active = null;
            previous.completion().complete(CommandResult.superseded(previous));
        }

        this.active = command;
        this.goal = null;
        this.waypoints.clear();
        this.lastDistance = Double.MAX_VALUE;
        this.ticksWithoutProgress = 0;
        this.ticksColliding = 0;
        this.replans = 0;

        switch (command.type()) {
            case MOVE -> beginMove(level, drone, command);
            case MOVE_TO -> beginMoveTo(level, drone, command, DroneStatus.MOVING);
            case RETURN_HOME -> {
                if (this.home == null) {
                    finish(CommandResult.failed(command, "this drone has no home; send set_home first"));
                    return;
                }
                travel(level, drone, this.home, DroneStatus.RETURNING);
            }
            case PATROL -> beginPatrol(level, drone, command);
            case FOLLOW -> {
                this.followTarget = command.targetId();
                this.followRadius = command.radius() > 0.0D ? command.radius() : DEFAULT_FOLLOW_RADIUS;
                this.status = DroneStatus.FOLLOWING;
                drone.setClearTargetOnArrival(false);
                // Following never "completes", so answer the caller now and keep flying.
                command.completion().complete(CommandResult.accepted(command));
            }
            case HOVER -> {
                drone.hover();
                this.status = DroneStatus.AVAILABLE;
                finish(CommandResult.completed(command, "holding position"));
            }
            case SCAN -> {
                this.status = DroneStatus.SCANNING;
                this.scanPending = true;
            }
            case DISPENSE_WATER -> dispense(level, drone, command);
            case LOOK -> look(level, drone, command); // handled above; retained for exhaustive dispatch
            case SET_SPEED -> {
                drone.setMaxSpeed(command.speed() / 20.0D);
                finish(CommandResult.completed(command, "speed set to " + command.speed() + " blocks/s"));
            }
            case SET_HOME -> {
                this.home = command.target() != null ? command.target() : drone.position();
                drone.setHomePosition(this.home);
                JsonObject data = new JsonObject();
                data.add("home", PerceptionSnapshot.vec(this.home));
                finish(CommandResult.completed(command, "home set", data));
            }
            case CANCEL -> {
                drone.hover();
                this.status = DroneStatus.AVAILABLE;
                finish(CommandResult.completed(command, "cancelled"));
            }
        }
    }

    private void beginMove(ServerLevel level, DroneEntity drone, DroneCommand command) {
        Vec3 step = command.direction().vector().scale(command.distance());
        Vec3 destination = drone.position().add(step);
        travel(level, drone, destination, DroneStatus.MOVING);
    }

    private void beginMoveTo(ServerLevel level, DroneEntity drone, DroneCommand command, DroneStatus moving) {
        travel(level, drone, command.target(), moving);
    }

    private void beginPatrol(ServerLevel level, DroneEntity drone, DroneCommand command) {
        this.patrol = List.copyOf(command.waypoints());
        this.patrolIndex = 0;
        travel(level, drone, this.patrol.get(0), DroneStatus.MOVING);
        if (command.loop()) {
            // A looping patrol has no end, so release the caller as soon as it is under way.
            command.completion().complete(CommandResult.accepted(command));
        }
    }

    private void dispense(ServerLevel level, DroneEntity drone, DroneCommand command) {
        this.status = DroneStatus.DISPENSING;
        int radius = command.radius() > 0.0D ? (int) Math.round(command.radius()) : this.config.waterRadius;
        DroneActions.WaterDrop drop = DroneActions.dispenseWater(level, drone.position(), radius,
                this.config.placeWaterSource);

        this.status = DroneStatus.AVAILABLE;
        if (drop.impact() == null) {
            finish(CommandResult.failed(command, "no ground beneath the drone to drop water on"));
            return;
        }
        if (drop.extinguished() == 0) {
            finish(CommandResult.failed(command, "no fire within " + radius + " blocks of the drop point"));
            return;
        }

        JsonObject data = new JsonObject();
        data.addProperty("extinguished", drop.extinguished());
        data.addProperty("remaining_fires", drop.remainingFires());
        data.addProperty("lava_nearby", drop.lavaFound());
        data.add("impact", PerceptionSnapshot.vec(Vec3.atCenterOf(drop.impact())));
        DroneEvents.emitAt("water_dispensed", this.droneId, Vec3.atCenterOf(drop.impact()), data.deepCopy());
        DroneEvents.recordSuppression(this.droneId, level.dimension().identifier().toString(),
                Vec3.atCenterOf(drop.impact()), drop.extinguished(), drop.remainingFires());
        finish(CommandResult.completed(command, "extinguished " + drop.extinguished() + " fire blocks", data));
    }

    private void look(ServerLevel level, DroneEntity drone, DroneCommand command) {
        Vec3 at = command.lookAt();
        if (at != null) {
            // A focus target is horizontal intent just like a flight target. Resolve its height
            // from the world here so workflows never choose a drone's Y coordinate.
            int ground = level.getHeight(Heightmap.Types.MOTION_BLOCKING,
                    net.minecraft.util.Mth.floor(at.x), net.minecraft.util.Mth.floor(at.z)) - 1;
            at = new Vec3(at.x, ground, at.z);
            Vec3 delta = at.subtract(drone.position());
            double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
            drone.setYawFollowsMotion(false);
            drone.setLook(Compass.yawTowards(delta.x, delta.z),
                    (float) -Math.toDegrees(Math.atan2(delta.y, horizontal)));
            command.completion().complete(CommandResult.completed(command, "camera aimed at target"));
            return;
        }

        Float yaw = command.yaw();
        Float pitch = command.pitch();
        if (yaw == null && pitch == null) {
            drone.setYawFollowsMotion(true);
            command.completion().complete(CommandResult.completed(command, "camera released to follow motion"));
            return;
        }
        if (yaw != null) {
            drone.setYawFollowsMotion(false);
            drone.setLook(yaw, pitch == null ? drone.getXRot() : pitch);
        } else {
            // A pitch-only request is the usual surveillance case. It deliberately leaves yaw
            // following the active route, so tilting down does not steer or interrupt flight.
            drone.setCameraPitch(pitch);
        }
        command.completion().complete(CommandResult.completed(command, "camera aimed"));
    }

    // ---------------------------------------------------------------- flying

    /** One server tick of whatever is currently running. Server thread only. */
    public void tick(ServerLevel level, DroneEntity drone, Function<String, Entity> lookup) {
        syncHome(drone);
        watchHazards(level, drone);

        if (this.active == null) {
            drone.setClimbOnCollision(true);
            if (this.status != DroneStatus.STUCK) {
                this.status = DroneStatus.AVAILABLE;
            }
            return;
        }

        // Under a plan the drone must fly the route it was given, not improvise around what it
        // bumps into; free flight is the other way round.
        drone.setClimbOnCollision(!planned(this.active.type()));

        switch (this.active.type()) {
            case MOVE, MOVE_TO, RETURN_HOME, PATROL -> navigate(level, drone);
            case FOLLOW -> follow(level, drone, lookup);
            default -> {
                // Everything else finished the moment it was accepted, except scan, which is
                // waiting on the perception worker rather than on anything that happens here.
            }
        }
    }

    private static boolean planned(CommandType type) {
        return switch (type) {
            case MOVE, MOVE_TO, RETURN_HOME, PATROL -> true;
            default -> false;
        };
    }

    private void navigate(ServerLevel level, DroneEntity drone) {
        Vec3 next = this.waypoints.peek();
        if (next == null) {
            arrive(level, drone);
            return;
        }

        if (drone.horizontalCollision || drone.verticalCollision) {
            if (++this.ticksColliding >= COLLISION_REPLAN_TICKS) {
                this.ticksColliding = 0;
                onNoProgress(level, drone);
                return;
            }
        } else {
            this.ticksColliding = 0;
        }

        // The last waypoint is the destination and deserves the configured precision. The ones
        // before it are only corners to round, and insisting on hitting them exactly is what
        // makes a drone stall in a doorway.
        double tolerance = this.waypoints.size() > 1
                ? Math.max(this.config.arrivalRadius, 0.6D)
                : this.config.arrivalRadius;

        double distance = drone.position().distanceTo(next);
        if (distance <= tolerance) {
            this.waypoints.poll();
            this.lastDistance = Double.MAX_VALUE;
            this.ticksWithoutProgress = 0;
            Vec3 following = this.waypoints.peek();
            if (following == null) {
                arrive(level, drone);
            } else {
                drone.setTargetPosition(following);
            }
            return;
        }

        if (!drone.hasTarget()) {
            drone.setTargetPosition(next);
        }

        if (distance < this.lastDistance - PROGRESS_EPSILON) {
            this.lastDistance = distance;
            this.ticksWithoutProgress = 0;
            return;
        }

        if (++this.ticksWithoutProgress <= this.config.stuckTicks) {
            return;
        }
        onNoProgress(level, drone);
    }

    /**
     * The drone has stopped making headway. Replan first - the world may simply have changed
     * under it - and only give up once replanning has stopped helping.
     */
    private void onNoProgress(ServerLevel level, DroneEntity drone) {
        this.ticksWithoutProgress = 0;
        this.ticksColliding = 0;
        this.lastDistance = Double.MAX_VALUE;
        // Replanning from a standstill, rather than from whatever the drone was doing when it hit
        // the wall, keeps the new route anchored to where it really is.
        drone.hover();

        if (this.replans++ < this.config.maxReplans && this.goal != null) {
            if (plan(level, drone, this.goal)) {
                return;
            }
        }

        this.status = DroneStatus.STUCK;
        drone.hover();
        JsonObject payload = new JsonObject();
        payload.addProperty("reason", "no progress toward the target");
        payload.addProperty("replans", this.replans);
        if (this.goal != null) {
            payload.add("goal", PerceptionSnapshot.vec(this.goal));
        }
        DroneEvents.emitAt("drone_stuck", this.droneId, drone.position(), payload);

        DroneCommand command = this.active;
        if (command != null) {
            finish(CommandResult.failed(command, "drone is stuck and cannot reach the target"));
        }
    }

    private void arrive(ServerLevel level, DroneEntity drone) {
        DroneCommand command = this.active;
        if (command == null) {
            return;
        }

        if (command.type() == CommandType.PATROL && !this.patrol.isEmpty()) {
            this.patrolIndex++;
            if (this.patrolIndex < this.patrol.size()) {
                travel(level, drone, this.patrol.get(this.patrolIndex), DroneStatus.MOVING);
                return;
            }
            if (command.loop()) {
                this.patrolIndex = 0;
                travel(level, drone, this.patrol.get(0), DroneStatus.MOVING);
                return;
            }
        }

        drone.hover();
        this.status = DroneStatus.AVAILABLE;

        JsonObject payload = new JsonObject();
        payload.addProperty("command", command.type().label());
        payload.addProperty("command_id", command.id());
        DroneEvents.emitAt("drone_arrived", this.droneId, drone.position(), payload);

        JsonObject data = new JsonObject();
        data.add("position", PerceptionSnapshot.vec(drone.position()));
        finish(CommandResult.completed(command, "arrived", data));
    }

    private void follow(ServerLevel level, DroneEntity drone, Function<String, Entity> lookup) {
        Entity target = lookup.apply(this.followTarget);
        if (target == null || target.isRemoved() || target.level() != level) {
            drone.hover();
            this.status = DroneStatus.AVAILABLE;
            DroneCommand command = this.active;
            if (command != null) {
                finish(CommandResult.failed(command,
                        "follow target '" + this.followTarget + "' is not in this world"));
            }
            return;
        }

        // Trail the target from behind and above, which is where a camera wants to be anyway.
        Vec3 delta = drone.position().subtract(target.position());
        Vec3 offset = delta.horizontalDistanceSqr() < 1.0E-4D
                ? new Vec3(this.followRadius, 0.0D, 0.0D)
                : new Vec3(delta.x, 0.0D, delta.z).normalize().scale(this.followRadius);
        this.goal = flightPosition(level, target.position().add(offset));
        drone.setClearTargetOnArrival(false);
        drone.setTargetPosition(this.goal);
    }

    // ---------------------------------------------------------------- planning

    private void travel(ServerLevel level, DroneEntity drone, Vec3 destination, DroneStatus moving) {
        DroneCommand command = this.active;
        if (destination == null) {
            if (command != null) {
                finish(CommandResult.failed(command, "no destination"));
            }
            return;
        }

        destination = flightPosition(level, destination);
        this.goal = destination;
        this.status = moving;
        drone.setClearTargetOnArrival(false);

        if (plan(level, drone, destination)) {
            return;
        }
        if (command != null) {
            this.status = DroneStatus.AVAILABLE;
            drone.hover();
            finish(CommandResult.failed(command, "no route to " + format(destination)));
        }
    }

    /**
     * Fills the waypoint queue with a route to {@code destination}.
     *
     * <p>Straight line first, because a drone in open sky is the normal case and A* would be pure
     * cost there. Only when the line is blocked does this pay for a search, and only if that fails
     * too does it try again from cruise altitude - climbing out of a valley is the single most
     * common reason a ground-level search finds nothing.
     */
    private boolean plan(ServerLevel level, DroneEntity drone, Vec3 destination) {
        this.waypoints.clear();
        Vec3 from = drone.position();

        if (DronePathfinder.clearLine(level, from, destination, this.config)) {
            this.waypoints.add(destination);
            drone.setTargetPosition(destination);
            return true;
        }

        List<Vec3> path = DronePathfinder.findPath(level, from, destination, this.config);
        if (path == null && this.config.cruiseAltitude > 0) {
            Vec3 cruise = new Vec3(from.x, Math.min(from.y + this.config.cruiseAltitude,
                    ceilingAt(level, from.x, from.z)), from.z);
            if (DronePathfinder.clearLine(level, from, cruise, this.config)) {
                List<Vec3> above = DronePathfinder.findPath(level, cruise, destination, this.config);
                if (above != null) {
                    this.waypoints.add(cruise);
                    this.waypoints.addAll(above);
                    drone.setTargetPosition(cruise);
                    return true;
                }
            }
        }
        if (path == null) {
            return false;
        }

        this.waypoints.addAll(path);
        drone.setTargetPosition(this.waypoints.peek());
        return true;
    }

    /**
     * Resolves every route's vertical coordinate at execution time. This is intentionally the
     * only place autonomous routes choose Y: workflows and operators state a map position, while
     * terrain determines a safe, bounded altitude at that position.
     */
    private Vec3 flightPosition(ServerLevel level, Vec3 horizontalTarget) {
        int x = net.minecraft.util.Mth.floor(horizontalTarget.x);
        int z = net.minecraft.util.Mth.floor(horizontalTarget.z);
        // MOTION_BLOCKING sees leaves as well as terrain. Flight clearance is therefore
        // canopy-relative, so a route rises over tall trees and descends over open ground.
        int ground = level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1;
        double y = Math.max(ground + this.config.minAltitudeAboveGround,
                Math.min(ground + this.config.targetAltitudeAboveGround,
                        ground + this.config.maxAltitudeAboveGround));
        return new Vec3(horizontalTarget.x, y, horizontalTarget.z);
    }

    private double ceilingAt(ServerLevel level, double x, double z) {
        int ground = level.getHeight(Heightmap.Types.MOTION_BLOCKING,
                net.minecraft.util.Mth.floor(x), net.minecraft.util.Mth.floor(z)) - 1;
        return ground + this.config.maxAltitudeAboveGround;
    }

    // ---------------------------------------------------------------- health

    /**
     * Notices the drone flying into something that hurts.
     *
     * <p>{@link DroneEntity} is deliberately invulnerable, so there is no damage event to listen
     * for; the honest signal is the block it is sitting in. Reported on the edge only, or a drone
     * hovering over a fire would emit forever.
     */
    private void watchHazards(ServerLevel level, DroneEntity drone) {
        BlockPos at = drone.blockPosition();
        BlockClass here = BlockClass.of(level.getBlockState(at), level, at);
        boolean dangerous = here.dangerous() || drone.isOnFire();
        if (dangerous && !this.inHazard) {
            JsonObject payload = new JsonObject();
            payload.addProperty("hazard", drone.isOnFire() ? "burning" : here.label());
            payload.addProperty("status", this.status.label());
            DroneEvents.emitAt("drone_damaged", this.droneId, drone.position(), payload);
        }
        this.inHazard = dangerous;
    }

    // ---------------------------------------------------------------- completion

    private void finish(CommandResult result) {
        DroneCommand command = this.active;
        this.active = null;
        this.lastResult = result;
        this.waypoints.clear();
        if (command != null) {
            command.completion().complete(result);
        }
        if (!result.ok() && command != null) {
            DroneEvents.emit("command_failed", this.droneId, failure(command, result.message()));
        }
    }

    private static JsonObject failure(DroneCommand command, String reason) {
        JsonObject payload = new JsonObject();
        payload.addProperty("command", command.type().label());
        payload.addProperty("command_id", command.id());
        payload.addProperty("reason", reason);
        return payload;
    }

    private static String format(Vec3 position) {
        return String.format("%.1f, %.1f, %.1f", position.x, position.y, position.z);
    }

    /** Called when the drone entity vanishes underneath us. */
    void onLost() {
        this.status = DroneStatus.OFFLINE;
        DroneCommand command = this.active;
        this.active = null;
        if (command != null) {
            command.completion().complete(CommandResult.failed(command, "drone left the world"));
        }
    }

    /** Marks a drone as on a disaster call rather than merely in transit. */
    public void markResponding() {
        if (this.status == DroneStatus.MOVING) {
            this.status = DroneStatus.RESPONDING;
        }
    }

    /** A quiet knob for the fleet coordinator: how busy this drone looks from outside. */
    public boolean available() {
        return this.active == null && this.status.dispatchable();
    }
}
