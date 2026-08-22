package dev.awsaf.firekeep.client.camera;

import dev.awsaf.firekeep.entity.DroneEntity;

import java.util.UUID;

/**
 * One drone's live feed: the newest encoded frame, and whoever is waiting for the next one.
 *
 * <p>Written from the client thread, read from the HTTP threads, so the frame handoff is a single
 * volatile reference to an immutable record plus a monitor for the waiters.
 */
public final class DroneFeed {
    /** A feed with no viewers for this long stops being rendered. */
    private static final long VIEWER_GRACE_MILLIS = 2_500L;

    private final UUID uuid;
    private final String id;
    /** True while the feed is named after the entity id, because the drone had no label yet. */
    private final boolean placeholderName;
    private final int entityId;

    private final Object frameLock = new Object();
    private volatile Frame frame;
    private volatile long sequence;

    /** Viewers holding an open stream, plus the last time somebody asked for a single frame. */
    private volatile int subscribers;
    private volatile long lastSnapshotRequest;
    private volatile long lastCaptureStart;

    private volatile double x;
    private volatile double y;
    private volatile double z;
    private volatile float yaw;

    public DroneFeed(DroneEntity drone, String id, boolean placeholderName) {
        this.uuid = drone.getUUID();
        this.id = id;
        this.placeholderName = placeholderName;
        this.entityId = drone.getId();
        this.track(drone);
    }

    public record Frame(byte[] jpeg, int width, int height, long sequence, long capturedAt) {
    }

    public UUID uuid() {
        return this.uuid;
    }

    public String id() {
        return this.id;
    }

    public boolean hasPlaceholderName() {
        return this.placeholderName;
    }

    public int entityId() {
        return this.entityId;
    }

    public double x() {
        return this.x;
    }

    public double y() {
        return this.y;
    }

    public double z() {
        return this.z;
    }

    public float yaw() {
        return this.yaw;
    }

    public Frame latest() {
        return this.frame;
    }

    public long lastCaptureStart() {
        return this.lastCaptureStart;
    }

    public void markCaptureStarted(long now) {
        this.lastCaptureStart = now;
    }

    /** Mirrors the live entity so the HTTP threads never touch level state. */
    public void track(DroneEntity drone) {
        this.x = drone.getX();
        this.y = drone.getY();
        this.z = drone.getZ();
        this.yaw = drone.getYRot();
    }

    public void publish(byte[] jpeg, int width, int height) {
        synchronized (this.frameLock) {
            this.sequence++;
            this.frame = new Frame(jpeg, width, height, this.sequence, System.currentTimeMillis());
            this.frameLock.notifyAll();
        }
    }

    /**
     * Blocks until a frame newer than {@code seenSequence} arrives.
     *
     * @return the new frame, or null if none arrived before the timeout
     */
    public Frame awaitFrame(long seenSequence, long timeoutMillis) throws InterruptedException {
        synchronized (this.frameLock) {
            if (this.sequence <= seenSequence) {
                this.frameLock.wait(timeoutMillis);
            }
            return this.sequence > seenSequence ? this.frame : null;
        }
    }

    public void addSubscriber() {
        synchronized (this.frameLock) {
            this.subscribers++;
        }
    }

    public void removeSubscriber() {
        synchronized (this.frameLock) {
            this.subscribers = Math.max(0, this.subscribers - 1);
        }
    }

    public int subscribers() {
        return this.subscribers;
    }

    public void requestSnapshot() {
        this.lastSnapshotRequest = System.currentTimeMillis();
    }

    /** Nobody is looking, so nothing needs rendering: a drone costs nothing until it is on screen. */
    public boolean isWatched(long now) {
        return this.subscribers > 0 || now - this.lastSnapshotRequest < VIEWER_GRACE_MILLIS;
    }

    /** Wakes any stream waiting on this feed so it can notice the drone is gone. */
    public void close() {
        synchronized (this.frameLock) {
            this.frameLock.notifyAll();
        }
    }
}
