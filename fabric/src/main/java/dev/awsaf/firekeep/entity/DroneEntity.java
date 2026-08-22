package dev.awsaf.firekeep.entity;

import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.InterpolationHandler;
import net.minecraft.world.entity.MoverType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import net.minecraft.world.phys.Vec3;

/**
 * A free-flying camera drone. It carries no AI: something else (a command, or the Fire Keep
 * server bridge) hands it a target position or a velocity, and the drone flies there smoothly
 * under acceleration and turn-rate limits.
 *
 * <p>All flight logic runs server side. The client only interpolates between the positions it is
 * sent ({@link #getInterpolation()}), which is what keeps the motion smooth enough to film.
 */
public class DroneEntity extends Entity {
    private static final EntityDataAccessor<Float> DATA_ROTOR_SPEED =
            SynchedEntityData.defineId(DroneEntity.class, EntityDataSerializers.FLOAT);
    private static final EntityDataAccessor<String> DATA_DRONE_ID =
            SynchedEntityData.defineId(DroneEntity.class, EntityDataSerializers.STRING);

    /** Blocks per tick (0.4 ~= 8 blocks/second). */
    public static final double DEFAULT_MAX_SPEED = 0.4D;
    /** Fraction of the velocity error corrected per tick; lower is smoother, slower to respond. */
    public static final double DEFAULT_ACCELERATION = 0.2D;
    public static final float DEFAULT_MAX_YAW_RATE = 7.0F;
    public static final float DEFAULT_MAX_PITCH_RATE = 5.0F;
    /** How close to the target counts as arrived, in blocks. */
    public static final double ARRIVAL_RADIUS = 0.12D;
    /**
     * Approach speed is {@code distance * acceleration * BRAKING_GAIN}. Velocity only tracks the
     * demand with a lag of {@code 1 / acceleration} ticks, so a gain much above half the
     * acceleration sails straight past the target; half keeps the arrival barely underdamped.
     */
    private static final double BRAKING_GAIN = 0.5D;
    private static final double MIN_MOVE = 1.0E-5D;

    private final InterpolationHandler interpolation = new InterpolationHandler(this);

    private Vec3 targetPosition;
    private Vec3 commandedVelocity = Vec3.ZERO;
    private boolean clearTargetOnArrival = true;
    /**
     * WASD-style stick from the dashboard. While set, {@link #desiredVelocity()} is rebuilt
     * each tick from the current look, so turning mid-flight keeps "forward" as forward.
     */
    private boolean inputFlight;
    private double inputForward;
    private double inputRight;
    private double inputUp;
    /** -1 look left, +1 look right; applied at {@link #maxYawRate} degrees per tick. */
    private double inputYaw;
    private boolean climbOnCollision = true;
    private Vec3 homePosition;

    private double maxSpeed = DEFAULT_MAX_SPEED;
    private double acceleration = DEFAULT_ACCELERATION;
    private float maxYawRate = DEFAULT_MAX_YAW_RATE;
    private float maxPitchRate = DEFAULT_MAX_PITCH_RATE;

    private float targetYaw;
    private float targetPitch;
    private boolean yawFollowsMotion = true;

    public DroneEntity(EntityType<? extends DroneEntity> type, Level level) {
        super(type, level);
        this.setNoGravity(true);
    }

    // ---------------------------------------------------------------- control API

    /** Flies to {@code position} and, once there, holds it (see {@link #setClearTargetOnArrival}). */
    public void setTargetPosition(Vec3 position) {
        this.targetPosition = position;
        this.clearFlightInput();
        this.commandedVelocity = Vec3.ZERO;
        this.yawFollowsMotion = true;
    }

    public Vec3 getTargetPosition() {
        return this.targetPosition;
    }

    public boolean hasTarget() {
        return this.targetPosition != null;
    }

    public boolean hasReachedTarget() {
        return this.targetPosition == null
                || this.position().distanceToSqr(this.targetPosition) <= ARRIVAL_RADIUS * ARRIVAL_RADIUS;
    }

    /** Drops the target without stopping; the drone keeps its current commanded velocity. */
    public void clearTarget() {
        this.targetPosition = null;
    }

    /** Cancels the target and brakes to a stationary hover. */
    public void hover() {
        this.targetPosition = null;
        this.commandedVelocity = Vec3.ZERO;
        this.clearFlightInput();
    }

    /**
     * Free-flight stick: {@code forward}/{@code right}/{@code up} in -1..1 along the camera,
     * {@code yaw} -1..1 to turn. Replaces any goto. Zero stick is a hover.
     */
    public void setFlightInput(double forward, double right, double up, double yaw) {
        if (forward == 0.0D && right == 0.0D && up == 0.0D && yaw == 0.0D) {
            this.hover();
            return;
        }
        this.targetPosition = null;
        this.commandedVelocity = Vec3.ZERO;
        this.yawFollowsMotion = false;
        if (!this.inputFlight) {
            this.targetYaw = this.getYRot();
            this.targetPitch = this.getXRot();
        }
        this.inputFlight = true;
        this.inputForward = forward;
        this.inputRight = right;
        this.inputUp = up;
        this.inputYaw = yaw;
    }

    private void clearFlightInput() {
        this.inputFlight = false;
        this.inputForward = 0.0D;
        this.inputRight = 0.0D;
        this.inputUp = 0.0D;
        this.inputYaw = 0.0D;
    }

    /** Free-flight control: a velocity in blocks per tick, used whenever no target is set. */
    public void setCommandedVelocity(Vec3 velocity) {
        this.clearFlightInput();
        this.commandedVelocity = velocity;
    }

    public Vec3 getCommandedVelocity() {
        return this.commandedVelocity;
    }

    /** Aims the drone, and with it the camera. Yaw only applies when {@link #setYawFollowsMotion} is off. */
    public void setLook(float yaw, float pitch) {
        this.targetYaw = Mth.wrapDegrees(yaw);
        this.targetPitch = Mth.clamp(pitch, -90.0F, 90.0F);
    }

    /** Adjusts only the camera's vertical angle without changing its heading or flight target. */
    public void setCameraPitch(float pitch) {
        this.targetPitch = Mth.clamp(pitch, -90.0F, 90.0F);
    }

    public void setYawFollowsMotion(boolean yawFollowsMotion) {
        this.yawFollowsMotion = yawFollowsMotion;
    }

    public boolean yawFollowsMotion() {
        return this.yawFollowsMotion;
    }

    public void setClearTargetOnArrival(boolean clearTargetOnArrival) {
        this.clearTargetOnArrival = clearTargetOnArrival;
    }

    /**
     * Whether hitting something sideways makes the drone try to rise over it.
     *
     * <p>On is right for free flight, where there is nothing but the target to go on. It is wrong
     * under a route that was planned around the obstruction, because the lift cancels the descent
     * the route is asking for and the drone hovers against the wall instead of flying through the
     * gap beside it. A controller that plans turns this off.
     */
    public void setClimbOnCollision(boolean climbOnCollision) {
        this.climbOnCollision = climbOnCollision;
    }

    public double getMaxSpeed() {
        return this.maxSpeed;
    }

    public void setMaxSpeed(double maxSpeed) {
        this.maxSpeed = Math.max(0.0D, maxSpeed);
    }

    public double getAcceleration() {
        return this.acceleration;
    }

    /** 0..1: the fraction of the velocity error corrected each tick. */
    public void setAcceleration(double acceleration) {
        this.acceleration = Mth.clamp(acceleration, 0.01D, 1.0D);
    }

    public void setTurnRates(float maxYawRate, float maxPitchRate) {
        this.maxYawRate = Math.max(0.1F, maxYawRate);
        this.maxPitchRate = Math.max(0.1F, maxPitchRate);
    }

    /**
     * Where this drone returns to when it is told to go home.
     *
     * <p>Kept on the entity rather than in the controller so it survives a restart, and so a
     * drone that briefly drops out of the controller's index does not silently adopt whatever
     * patch of sky it happened to be over as its base.
     */
    public Vec3 getHomePosition() {
        return this.homePosition;
    }

    public void setHomePosition(Vec3 homePosition) {
        this.homePosition = homePosition;
    }

    /** Free-form label so the Fire Keep server can address one specific drone. */
    public String getDroneId() {
        return this.entityData.get(DATA_DRONE_ID);
    }

    public void setDroneId(String droneId) {
        this.entityData.set(DATA_DRONE_ID, droneId);
    }

    /** 0.35 when idling, up to 1 at full throttle; drives the rotor animation client side. */
    public float getRotorSpeed() {
        return this.entityData.get(DATA_ROTOR_SPEED);
    }

    // ---------------------------------------------------------------- camera

    /** Where the drone camera sits, ready for a point-of-view capture. */
    public Vec3 getCameraPosition(float partialTick) {
        return this.getEyePosition(partialTick);
    }

    public float getCameraYaw(float partialTick) {
        return this.getYRot(partialTick);
    }

    public float getCameraPitch(float partialTick) {
        return this.getXRot(partialTick);
    }

    /** Unit vector the camera is looking along. */
    public Vec3 getCameraDirection(float partialTick) {
        return this.getViewVector(partialTick);
    }

    // ---------------------------------------------------------------- flight

    @Override
    public void tick() {
        this.interpolation.interpolate();
        super.tick();

        if (this.level().isClientSide()) {
            return;
        }

        this.applyYawInput();
        Vec3 velocity = this.stepVelocity();
        this.setDeltaMovement(velocity);

        if (velocity.lengthSqr() > MIN_MOVE) {
            this.move(MoverType.SELF, velocity);
        }

        if (this.horizontalCollision || this.verticalCollision) {
            this.resolveCollision();
        }

        this.updateRotation(this.getDeltaMovement());
        this.entityData.set(DATA_ROTOR_SPEED, this.computeRotorSpeed(this.getDeltaMovement()));
    }

    /** Bleeds off whatever we just drove into a wall, so the drone settles instead of grinding. */
    private void resolveCollision() {
        Vec3 blocked = this.getDeltaMovement();
        Vec3 damped = new Vec3(
                this.horizontalCollision ? blocked.x * 0.2D : blocked.x,
                this.verticalCollision ? blocked.y * 0.2D : blocked.y,
                this.horizontalCollision ? blocked.z * 0.2D : blocked.z);

        if (this.climbOnCollision && this.targetPosition != null && this.horizontalCollision) {
            // Climb over the obstruction: the simplest response that keeps a target reachable.
            damped = damped.add(0.0D, this.maxSpeed * 0.25D, 0.0D);
        }

        this.setDeltaMovement(damped);
    }

    /** Blends the current velocity toward whatever the controls are asking for. */
    private Vec3 stepVelocity() {
        Vec3 desired = this.desiredVelocity();
        Vec3 velocity = this.getDeltaMovement();
        Vec3 stepped = velocity.add(desired.subtract(velocity).scale(this.acceleration));
        return stepped.lengthSqr() < MIN_MOVE ? Vec3.ZERO : stepped;
    }

    private void applyYawInput() {
        if (!this.inputFlight || this.inputYaw == 0.0D) {
            return;
        }
        this.targetYaw = Mth.wrapDegrees(this.targetYaw + (float) this.inputYaw * this.maxYawRate);
    }

    private Vec3 desiredVelocity() {
        if (this.inputFlight) {
            return this.velocityFromLook();
        }
        if (this.targetPosition == null) {
            return this.clampToMaxSpeed(this.commandedVelocity);
        }

        Vec3 delta = this.targetPosition.subtract(this.position());
        double distance = delta.length();
        if (distance <= ARRIVAL_RADIUS) {
            if (this.clearTargetOnArrival) {
                this.targetPosition = null;
            }
            return Vec3.ZERO;
        }

        double speed = Math.min(this.maxSpeed, distance * this.acceleration * BRAKING_GAIN);
        return delta.scale(speed / distance);
    }

    /** Minecraft creative-style: W follows the camera, A/D strafe, Space/Shift are world up. */
    private Vec3 velocityFromLook() {
        float yaw = this.getYRot() * ((float) Math.PI / 180.0F);
        float pitch = this.getXRot() * ((float) Math.PI / 180.0F);
        double cosPitch = Math.cos(pitch);
        double sinYaw = Math.sin(yaw);
        double cosYaw = Math.cos(yaw);

        double fx = -sinYaw * cosPitch;
        double fy = -Math.sin(pitch);
        double fz = cosYaw * cosPitch;
        double rx = -cosYaw;
        double rz = -sinYaw;

        Vec3 world = new Vec3(
                fx * this.inputForward + rx * this.inputRight,
                fy * this.inputForward + this.inputUp,
                fz * this.inputForward + rz * this.inputRight);
        double length = world.length();
        if (length < MIN_MOVE) {
            return Vec3.ZERO;
        }
        if (length > 1.0D) {
            world = world.scale(1.0D / length);
        }
        return world.scale(this.maxSpeed);
    }

    private Vec3 clampToMaxSpeed(Vec3 velocity) {
        double lengthSqr = velocity.lengthSqr();
        if (lengthSqr <= this.maxSpeed * this.maxSpeed) {
            return velocity;
        }
        return velocity.scale(this.maxSpeed / Math.sqrt(lengthSqr));
    }

    private void updateRotation(Vec3 velocity) {
        float desiredYaw = this.targetYaw;
        double horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
        if (this.yawFollowsMotion && horizontalSpeed > 0.01D) {
            desiredYaw = (float) (Mth.atan2(velocity.z, velocity.x) * (180.0D / Math.PI)) - 90.0F;
            // Hold this heading once the drone stops. Without remembering it, arriving drops the
            // yaw back to whatever was last set by hand - usually the spawn yaw - and the drone
            // turns away from the shot on its own the moment it settles.
            this.targetYaw = Mth.wrapDegrees(desiredYaw);
        }

        this.setYRot(Mth.approachDegrees(this.getYRot(), desiredYaw, this.maxYawRate));
        this.setXRot(Mth.approachDegrees(this.getXRot(), this.targetPitch, this.maxPitchRate));
    }

    private float computeRotorSpeed(Vec3 velocity) {
        float throttle = (float) Math.min(1.0D, velocity.length() / Math.max(this.maxSpeed, 1.0E-4D));
        return 0.35F + throttle * 0.65F;
    }

    // ---------------------------------------------------------------- entity plumbing

    @Override
    public InterpolationHandler getInterpolation() {
        return this.interpolation;
    }

    @Override
    protected void defineSynchedData(SynchedEntityData.Builder builder) {
        builder.define(DATA_ROTOR_SPEED, 0.35F);
        builder.define(DATA_DRONE_ID, "");
    }

    @Override
    public boolean isPickable() {
        return !this.isRemoved();
    }

    @Override
    public boolean isPushable() {
        return false;
    }

    @Override
    public boolean canBeCollidedWith(Entity entity) {
        return false;
    }

    @Override
    public boolean hurtServer(ServerLevel level, DamageSource source, float amount) {
        // Drones are equipment, not targets: only /drone remove or /kill takes one down.
        return false;
    }

    @Override
    protected void readAdditionalSaveData(ValueInput input) {
        this.targetPosition = input.read("TargetPosition", Vec3.CODEC).orElse(null);
        this.commandedVelocity = input.read("CommandedVelocity", Vec3.CODEC).orElse(Vec3.ZERO);
        this.maxSpeed = input.getDoubleOr("MaxSpeed", DEFAULT_MAX_SPEED);
        this.acceleration = input.getDoubleOr("Acceleration", DEFAULT_ACCELERATION);
        this.maxYawRate = input.getFloatOr("MaxYawRate", DEFAULT_MAX_YAW_RATE);
        this.maxPitchRate = input.getFloatOr("MaxPitchRate", DEFAULT_MAX_PITCH_RATE);
        this.targetYaw = input.getFloatOr("TargetYaw", this.getYRot());
        this.targetPitch = input.getFloatOr("TargetPitch", this.getXRot());
        this.yawFollowsMotion = input.getBooleanOr("YawFollowsMotion", true);
        this.clearTargetOnArrival = input.getBooleanOr("ClearTargetOnArrival", true);
        this.homePosition = input.read("HomePosition", Vec3.CODEC).orElse(null);
        this.setDroneId(input.getStringOr("DroneId", ""));
    }

    @Override
    protected void addAdditionalSaveData(ValueOutput output) {
        output.storeNullable("TargetPosition", Vec3.CODEC, this.targetPosition);
        output.store("CommandedVelocity", Vec3.CODEC, this.commandedVelocity);
        output.putDouble("MaxSpeed", this.maxSpeed);
        output.putDouble("Acceleration", this.acceleration);
        output.putFloat("MaxYawRate", this.maxYawRate);
        output.putFloat("MaxPitchRate", this.maxPitchRate);
        output.putFloat("TargetYaw", this.targetYaw);
        output.putFloat("TargetPitch", this.targetPitch);
        output.putBoolean("YawFollowsMotion", this.yawFollowsMotion);
        output.putBoolean("ClearTargetOnArrival", this.clearTargetOnArrival);
        output.storeNullable("HomePosition", Vec3.CODEC, this.homePosition);
        output.putString("DroneId", this.getDroneId());
    }
}
